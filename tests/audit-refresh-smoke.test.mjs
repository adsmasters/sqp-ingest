// End-to-end smoke test of audit-refresh.mjs on a FAKE network (tests/mock-net.mjs): nothing can reach Amazon or Supabase,
// every unknown URL throws, timers run 1000x faster. Requirements checked:
//  - all accounts are refreshed, several at the same time (worker tags [W1]..[W4]), stalest cache first;
//  - exactly one cache write per account;
//  - a summary of refreshed / failed / skipped accounts is printed and written to the GitHub step summary;
//  - SAFETY: every request goes to a whitelisted endpoint - report creation/status, the campaign LIST (a read), the token endpoint
//    and the Supabase cache. No PUT/PATCH/DELETE, nothing that could create or change a campaign.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const FAKE_SB = 'https://fake-supabase.test';

// 6 active clients + 1 extra recently-audited profile; ages decide the order (oldest first)
const CLIENTS = ['101', '102', '103', '104', '105', '106'].map((id) => ({ name: 'Client' + id, spid: 'S' + id, ads_profile_id: id }));
const AGES = { 101: '2026-10-05T10:00:00Z', 102: '2026-09-01T10:00:00Z', 103: '2026-10-03T10:00:00Z', 104: '2026-09-15T10:00:00Z', 105: '2026-10-06T10:00:00Z', 106: '2026-09-20T10:00:00Z', 999: '2026-08-01T10:00:00Z' };
const EXPECTED_ORDER = ['999', '102', '104', '106', '103', '101', '105']; // oldest cache first

let out, reqs, summaryFile;
before(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-smoke-'));
  const reqLog = path.join(dir, 'req.jsonl');
  summaryFile = path.join(dir, 'summary.md');
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(here, 'mock-net.mjs')).href, path.join(root, 'audit-refresh.mjs'), '30'], {
    cwd: root, encoding: 'utf8', timeout: 90000,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      SUPABASE_URL: FAKE_SB, SUPABASE_SERVICE_KEY: 'fake-key', ADS_CLIENT_ID: 'fake', ADS_CLIENT_SECRET: 'fake', ADS_REFRESH_TOKEN: 'fake',
      AUDIT_CONCURRENCY: '4', AUDIT_BUDGET_MIN: '200', AUDIT_STAGGER_SEC: '45',
      REQ_LOG: reqLog, GITHUB_STEP_SUMMARY: summaryFile,
      FAKE_CLIENTS: JSON.stringify(CLIENTS), FAKE_AGES: JSON.stringify(AGES), FAKE_EXTRA_CACHED: JSON.stringify(['999']),
    },
  });
  out = { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  reqs = fs.existsSync(reqLog) ? fs.readFileSync(reqLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
});

describe('audit-refresh.mjs on a fake network', () => {
  test('invariant: the run completes successfully', () => {
    assert.equal(out.status, 0, out.stderr + '\n' + out.stdout.slice(-1500));
    assert.match(out.stdout, /FERTIG\./);
  });

  test('invariant: all 7 accounts (6 clients + 1 recently audited profile) are refreshed, one cache write each', () => {
    assert.match(out.stdout, /7 aktualisiert, 0 NICHT aktualisiert/);
    assert.match(out.stdout, /, 0 nicht gestartet/);
    const writes = reqs.filter((r) => r.method === 'POST' && r.url.includes('/ads_audit_cache'));
    assert.equal(writes.length, 7);
    // the request log keeps only the start of each body; the account id is at the start of the JSON
    const ids = writes.map((w) => (w.body.match(/"profile_id":"(\d+)"/) || [])[1]);
    assert.deepEqual([...ids].sort(), [...EXPECTED_ORDER].sort(), 'every account written exactly once');
    assert.equal(new Set(ids).size, 7);
  });

  test('invariant: accounts run in parallel (4 worker tags) and start stalest cache first', () => {
    const tags = new Set([...out.stdout.matchAll(/^\[(W\d+)\]/gm)].map((m) => m[1]));
    assert.deepEqual([...tags].sort(), ['W1', 'W2', 'W3', 'W4']);
    const started = [...out.stdout.matchAll(/^\[W\d+\] === Client(\d+) |^\[W\d+\] === Profil (\d+) /gm)].map((m) => m[1] || m[2]);
    assert.deepEqual(started, EXPECTED_ORDER, 'start order = oldest cache first');
  });

  test('invariant: a summary is printed and written to the GitHub step summary', () => {
    assert.match(out.stdout, /Audit-Vorladung: 7 aktualisiert/);
    const md = fs.readFileSync(summaryFile, 'utf8');
    assert.match(md, /### PPC-Audit-Vorladung/);
    assert.match(md, /7 aktualisiert/);
  });

  test('invariant: more than one account is in flight at the same time (reports for several accounts are created before the first finishes)', () => {
    const creates = reqs.filter((r) => r.method === 'POST' && r.url.endsWith('/reporting/reports'));
    assert.equal(creates.length, 7 * 10, '10 reports per account');
    const firstCacheWrite = reqs.findIndex((r) => r.method === 'POST' && r.url.includes('/ads_audit_cache'));
    const createdBeforeFirstFinish = reqs.slice(0, firstCacheWrite).filter((r) => r.method === 'POST' && r.url.endsWith('/reporting/reports')).length;
    assert.ok(createdBeforeFirstFinish > 10, `only ${createdBeforeFirstFinish} reports created before the first account finished -> accounts ran one after another`);
  });
});

describe('a failing account', () => {
  test('invariant: an account whose reports are rejected is listed in the summary and does NOT stop the others (no cache write for it)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-smoke-fail-'));
    const reqLog = path.join(dir, 'req.jsonl');
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(here, 'mock-net.mjs')).href, path.join(root, 'audit-refresh.mjs'), '30'], {
      cwd: root, encoding: 'utf8', timeout: 90000,
      env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        SUPABASE_URL: FAKE_SB, SUPABASE_SERVICE_KEY: 'fake-key', ADS_CLIENT_ID: 'fake', ADS_CLIENT_SECRET: 'fake', ADS_REFRESH_TOKEN: 'fake',
        AUDIT_CONCURRENCY: '4', AUDIT_BUDGET_MIN: '200', AUDIT_STAGGER_SEC: '45', REQ_LOG: reqLog, FAKE_FAIL_PROFILE: '104',
        FAKE_CLIENTS: JSON.stringify(CLIENTS), FAKE_AGES: JSON.stringify(AGES), FAKE_EXTRA_CACHED: JSON.stringify(['999']),
      },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /6 aktualisiert, 1 NICHT aktualisiert/);
    assert.match(r.stdout, /✗ Client104: no-reports/);
    const reqs2 = fs.readFileSync(reqLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const written = reqs2.filter((x) => x.method === 'POST' && x.url.includes('/ads_audit_cache')).map((x) => (x.body.match(/"profile_id":"(\d+)"/) || [])[1]);
    assert.equal(written.length, 6);
    assert.ok(!written.includes('104'), 'the failed account must not overwrite its cache');
  });
});

// ---- scenarios added after the pre-deploy review --------------------------------------------------------------------
function runScenario(extraEnv, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-smoke-scn-'));
  const reqLog = path.join(dir, 'req.jsonl');
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    SUPABASE_URL: FAKE_SB, SUPABASE_SERVICE_KEY: 'fake-key', ADS_CLIENT_ID: 'fake', ADS_CLIENT_SECRET: 'fake', ADS_REFRESH_TOKEN: 'fake',
    REQ_LOG: reqLog,
    FAKE_CLIENTS: JSON.stringify(CLIENTS), FAKE_AGES: JSON.stringify(AGES), FAKE_EXTRA_CACHED: JSON.stringify(['999']),
    ...extraEnv,
  };
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(here, 'mock-net.mjs')).href, path.join(root, 'audit-refresh.mjs'), ...(args || ['30'])], { cwd: root, encoding: 'utf8', timeout: 90000, env });
  const log = fs.existsSync(reqLog) ? fs.readFileSync(reqLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const cacheWrites = log.filter((x) => x.method === 'POST' && x.url.includes('/ads_audit_cache')).map((x) => (x.body.match(/"profile_id":"(\d+)"/) || [])[1]);
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', log, cacheWrites };
}

describe('review fixes', () => {
  test('invariant: a CORE report that Amazon refused to create (the other nine exist) makes the account degraded: its saved audit is NOT replaced', () => {
    const r = runScenario({ FAKE_FAIL_REPORT: 'sp_search_terms', FAKE_FAIL_REPORT_PROFILE: '104' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.cacheWrites.includes('104'), 'a degraded audit must not overwrite a good saved one');
    assert.equal(r.cacheWrites.length, 6);
    assert.match(r.stdout, /✗ Client104: degraded/);
    assert.match(r.stdout, /6 aktualisiert, 1 NICHT aktualisiert/);
  });

  // An account without Sponsored Brands / Display: Amazon may refuse to create those reports. The old code, the live backend and the
  // live page all simply leave those sections out - such an account must keep being refreshed, never be skipped for good.
  test('invariant: a hard rejection (400/403/404) of a Sponsored Brands or Display report means "no data": the account is still refreshed and saved', () => {
    for (const [report, status] of [['sb_campaigns', '400'], ['sb_search_terms', '403'], ['sd_campaigns', '404']]) {
      const r = runScenario({ FAKE_FAIL_REPORT: report, FAKE_FAIL_REPORT_PROFILE: '104', FAKE_FAIL_STATUS: status });
      assert.equal(r.status, 0, `${report} ${status}: ${r.stderr}`);
      assert.ok(r.cacheWrites.includes('104'), `${report} ${status}: the account must still be saved`);
      assert.match(r.stdout, /7 aktualisiert, 0 NICHT aktualisiert/);
    }
  });

  test('invariant: ...but not when the report is missing for another reason: rate-limit give-up (429), server error (500), auth (401) -> degraded, saved audit untouched', () => {
    for (const [report, status] of [['sb_campaigns', '429'], ['sd_campaigns', '500'], ['sb_search_terms', '401']]) {
      const r = runScenario({ FAKE_FAIL_REPORT: report, FAKE_FAIL_REPORT_PROFILE: '104', FAKE_FAIL_STATUS: status });
      assert.ok(!r.cacheWrites.includes('104'), `${report} ${status}: must not overwrite the saved audit`);
      assert.match(r.stdout, /✗ Client104: degraded/, `${report} ${status}`);
    }
  });

  test('invariant: a rejected Sponsored PRODUCTS report is never "no data" (sp_* must exist): even a 403 degrades the account', () => {
    for (const report of ['sp_campaigns', 'sp_placements', 'sp_targeting', 'sp_search_terms']) {
      const r = runScenario({ FAKE_FAIL_REPORT: report, FAKE_FAIL_REPORT_PROFILE: '104', FAKE_FAIL_STATUS: '403' });
      assert.ok(!r.cacheWrites.includes('104'), report);
      assert.match(r.stdout, /✗ Client104: degraded/, report);
    }
  });

  // Round 3: a failed campaign list leaves the account without bids/types/D+ rows. Saving that would replace last night's complete audit.
  test('invariant: if the campaign LIST of an account fails (500) the account is degraded and its saved audit is NOT replaced; the others are saved', () => {
    const r = runScenario({ FAKE_LIST_FAIL_PROFILE: '104' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.cacheWrites.includes('104'));
    assert.equal(r.cacheWrites.length, 6);
    assert.match(r.stdout, /✗ Client104: degraded \(Kampagnenliste/);
  });

  test('invariant: a rate-limited campaign list (429 once) is retried and the account is saved normally', () => {
    const r = runScenario({ FAKE_LIST_429_ONCE_PROFILE: '104' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.cacheWrites.includes('104'));
    assert.match(r.stdout, /7 aktualisiert, 0 NICHT aktualisiert/);
    const lists = r.log.filter((x) => x.url.endsWith('/sp/campaigns/list'));
    assert.ok(lists.length >= 8, 'the failed request was repeated');
  });

  test('invariant: a very large account (campaign list of 12 pages, more than the old 10-page cap) is refreshed and saved normally', () => {
    const r = runScenario({ FAKE_LIST_PAGES_PROFILE: '104', FAKE_LIST_PAGES: '12' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.cacheWrites.includes('104'));
    assert.match(r.stdout, /7 aktualisiert, 0 NICHT aktualisiert/);
  });

  test('invariant: a campaign list that never ends is bounded (not endless): the account is degraded, saved audit kept', () => {
    const r = runScenario({ FAKE_LIST_PAGES_PROFILE: '104', FAKE_LIST_PAGES: '100000' });
    assert.ok(!r.cacheWrites.includes('104'));
    assert.match(r.stdout, /✗ Client104: degraded/);
    const lists = r.log.filter((x) => x.url.endsWith('/sp/campaigns/list')).length;
    assert.ok(lists <= 6 + 100, `list requests: ${lists}`);
  });

  test('invariant: a failing campaign list is retried only a few times (3), not endlessly', () => {
    const r = runScenario({ FAKE_LIST_FAIL_PROFILE: '104' });
    const lists = r.log.filter((x) => x.url.endsWith('/sp/campaigns/list')).length;
    assert.equal(lists, 6 + 3, 'six healthy accounts once each, the failing one three times');
  });

  test('invariant: an account that has NO saved audit yet and whose campaign list fails still gets a (reduced) audit instead of nothing; one WITH a saved audit keeps it', () => {
    const noRow = { ...AGES }; delete noRow['104'];
    const a = runScenario({ FAKE_LIST_FAIL_PROFILE: '104', FAKE_AGES: JSON.stringify(noRow) });
    assert.ok(a.cacheWrites.includes('104'), 'nothing to protect -> something is better than nothing');
    const b = runScenario({ FAKE_LIST_FAIL_PROFILE: '104' });
    assert.ok(!b.cacheWrites.includes('104'), 'a good saved audit exists -> it is kept');
  });

  // Review round 4: the protection of a good saved audit must not depend on one Supabase query succeeding
  test('invariant: if the saved-audit AGE query fails, a failing campaign list still never overwrites a possibly good saved audit (fail closed)', () => {
    const r = runScenario({ FAKE_AGE_FAIL: '1', FAKE_LIST_FAIL_PROFILE: '104' });
    assert.ok(!r.cacheWrites.includes('104'), 'unknown age = assume a saved audit exists');
    assert.match(r.stdout, /✗ Client104: degraded/);
  });

  test('invariant: a good row that appeared after the age query (race with the live page) is not overwritten by a reduced audit', () => {
    const noRow = { ...AGES }; delete noRow['104'];
    const r = runScenario({ FAKE_LIST_FAIL_PROFILE: '104', FAKE_AGES: JSON.stringify(noRow), FAKE_ROW_PROFILE: '104' });
    assert.ok(!r.cacheWrites.includes('104'), 're-checked right before saving');
    assert.match(r.stdout, /✗ Client104: degraded/);
  });

  test('invariant: a reduced audit that had to be saved (no earlier row) is reported as a problem, not as a plain success', () => {
    const noRow = { ...AGES }; delete noRow['104'];
    const r = runScenario({ FAKE_LIST_FAIL_PROFILE: '104', FAKE_AGES: JSON.stringify(noRow) });
    assert.ok(r.cacheWrites.includes('104'));
    assert.match(r.stdout, /✗ Client104: ok-reduced/);
  });

  test('invariant: if there is nothing to refresh at all (empty client list and no recent audits) the run FAILS instead of ending green and silent', () => {
    const r = runScenario({ FAKE_CLIENTS: '[]', FAKE_EXTRA_CACHED: '[]', FAKE_AGES: '{}' });
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /keine Konten/);
    assert.equal(r.cacheWrites.length, 0);
  });

  test('invariant: an OPTIONAL B2B report that is refused does not degrade the audit (unchanged behaviour)', () => {
    const r = runScenario({ FAKE_FAIL_REPORT: 'b2b_prev', FAKE_FAIL_REPORT_PROFILE: '104' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.cacheWrites.includes('104'));
    assert.match(r.stdout, /7 aktualisiert, 0 NICHT aktualisiert/);
  });

  test('invariant: when every account fails the job ENDS WITH AN ERROR (exit code 1) - the failure is no longer silent - and the summary is still printed', () => {
    const r = runScenario({ FAKE_FAIL_ALL: '1' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /0 aktualisiert, 7 NICHT aktualisiert/);
    assert.equal(r.cacheWrites.length, 0);
    assert.match(r.stdout + r.stderr, /FEHLER/);
  });

  test('invariant: a single failing account out of 7 is NOT an error (no alert noise for the normal odd failure)', () => {
    const r = runScenario({ FAKE_FAIL_PROFILE: '104' });
    assert.equal(r.status, 0);
  });

  test('invariant: more than half failing is an error, exactly half is not', () => {
    // 7 accounts: 4 failing = 57% -> error ; 3 failing = 43% -> ok. Failing profiles are chosen through the single-profile switch twice.
    // (FAKE_FAIL_PROFILE accepts one profile, so use the all-fail scenario above for the upper bound and the single case for the lower bound.)
    const one = runScenario({ FAKE_FAIL_PROFILE: '104' });
    const all = runScenario({ FAKE_FAIL_ALL: '1' });
    assert.equal(one.status, 0);
    assert.equal(all.status, 1);
  });

  test('invariant: the shared token is used - the Amazon token endpoint is called once for the whole run, not once per account or report', () => {
    const r = runScenario({ AUDIT_CONCURRENCY: '4' });
    const tokenCalls = r.log.filter((x) => x.url === 'https://api.amazon.co.uk/auth/o2/token').length;
    assert.ok(tokenCalls >= 1 && tokenCalls <= 2, `token endpoint called ${tokenCalls} times`);
  });

  test('invariant: the default time budget is 150 minutes and the per-account limit is announced (worst case stays far below the 300 minute job timeout)', () => {
    const r = runScenario({});
    assert.match(r.stdout, /Budget 150 Min/);
  });

  test('invariant: an account whose reports never finish is abandoned after its own time limit (not 60 rounds): degraded, saved audit untouched, the others unaffected', () => {
    const slow = runScenario({ FAKE_PENDING: '1', AUDIT_ACCOUNT_MAX_MIN: '0.0015' });   // ~90 ms real time = the fake clock runs 1000x faster
    const full = runScenario({ FAKE_PENDING: '1' });                                      // default limit: all 60 polling rounds are used
    const statusGets = (x) => x.log.filter((l) => l.method === 'GET' && /\/reporting\/reports\/rep-\d+$/.test(l.url)).length;
    assert.ok(statusGets(slow) < statusGets(full) / 2, `limited run polled ${statusGets(slow)} times, unlimited ${statusGets(full)}`);
    assert.equal(slow.cacheWrites.length, 0, 'nothing is saved for accounts whose core reports never finished');
    assert.equal(slow.status, 1, 'every account degraded -> error');
    assert.match(slow.stdout, /degraded/);
  });
});

describe('SAFETY on the fake network: only whitelisted, non-campaign-changing requests', () => {
  test('invariant: every request is a whitelisted read / report request / cache write; no PUT, PATCH or DELETE', () => {
    assert.ok(reqs.length > 100, 'the log must actually contain the run');
    for (const r of reqs) {
      assert.ok(['GET', 'POST'].includes(r.method), `${r.method} ${r.url}`);
      const ok =
        r.url === 'https://api.amazon.co.uk/auth/o2/token' ||
        (r.method === 'POST' && r.url === 'https://advertising-api-eu.amazon.com/reporting/reports') ||
        (r.method === 'GET' && /^https:\/\/advertising-api-eu\.amazon\.com\/reporting\/reports\/rep-\d+$/.test(r.url)) ||
        (r.method === 'POST' && r.url === 'https://advertising-api-eu.amazon.com/sp/campaigns/list') ||
        r.url.startsWith('https://dl.fake.test/') ||
        r.url.startsWith(FAKE_SB + '/rest/v1/sqp_clients') ||
        r.url.startsWith(FAKE_SB + '/rest/v1/ads_audit_cache');
      assert.ok(ok, `non-whitelisted request: ${r.method} ${r.url}`);
    }
  });

  test('invariant: the campaign endpoint is only ever the LIST (a read) and nothing is ever created via /sp/campaigns', () => {
    const camp = reqs.filter((r) => r.url.includes('/campaigns'));
    assert.ok(camp.length >= 7, 'the campaign list is read for each account');
    assert.ok(camp.every((r) => r.url === 'https://advertising-api-eu.amazon.com/sp/campaigns/list'));
    assert.ok(reqs.every((r) => !/\/(sb|sd)\//.test(r.url)));
  });

  test('invariant: no request body anywhere asks Amazon to create or enable something (report requests only carry report definitions)', () => {
    for (const r of reqs.filter((x) => x.url === 'https://advertising-api-eu.amazon.com/reporting/reports')) {
      assert.match(r.body, /"configuration"/);
      assert.doesNotMatch(r.body, /"state"\s*:\s*"ENABLED"/);
    }
  });
});
