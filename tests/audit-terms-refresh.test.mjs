// End-to-end test of audit-terms-refresh.mjs on a FAKE network (tests/mock-net-terms.mjs): nothing can reach Amazon or Supabase, every unknown URL throws.
// Intended behaviour (written from the requirements, not from the code):
//  - ONE search-term report per account (not ~10); the saved audit row gets ONLY its spTerms replaced (12 cells per row, with IDs) plus spTermsAsOf/spTermsWindow;
//    every other part of the saved audit stays exactly as it was and updated_at is NOT bumped (the rest of the audit is not fresher than before);
//  - accounts whose saved audit already has IDs and is fresh are skipped; accounts without IDs are processed, oldest first, several at once;
//  - the write only happens if the row did not change in the meantime (compare-and-swap on updated_at) - a lost race is not a failure;
//  - a failing account leaves its saved audit untouched; too many failures fail the run (so the workflow alerts);
//  - SAFETY: only report creation/status, the Supabase cache (GET/PATCH) and the client list - no campaign endpoints, no PUT/DELETE, no cache upsert.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const FAKE_SB = 'https://fake-supabase.test';
const NOW = Date.now();
const iso = (hoursAgo) => new Date(NOW - hoursAgo * 3600e3).toISOString().replace('Z', '+00:00');

const OLD_COLS = ['term', 'campaign', 'match', 'impressions', 'clicks', 'spend', 'sales', 'orders'];
const NEW_COLS = [...OLD_COLS, 'campaignId', 'adGroupId', 'keywordId', 'keyword'];
const savedPayload = (extra = {}) => ({ ready: true, days: 30, totals: { spend: 1000, sales: 3000 }, bidAdj: [{ id: 'keep-me' }], formats: { SP: { spend: 900 } }, spTerms: { cols: OLD_COLS, rows: [['old', 'C', 'BROAD', 1, 1, 1, 1, 1]] }, ...extra });

// what Amazon's spSearchTerm report returns: IDs as NUMBERS, one zero-click row (must be dropped), unsorted
const REPORT = [
  { searchTerm: 'low sales', keyword: 'kw1', matchType: 'BROAD', campaignName: 'Camp A', campaignId: 111, adGroupId: 222, keywordId: 333, impressions: 50, clicks: 4, cost: 3.456, purchases7d: 1, sales7d: 10 },
  { searchTerm: 'no clicks', keyword: 'kw2', matchType: 'BROAD', campaignName: 'Camp A', campaignId: 111, adGroupId: 222, keywordId: 334, impressions: 500, clicks: 0, cost: 0, purchases7d: 0, sales7d: 0 },
  { searchTerm: 'top seller', keyword: 'top seller', matchType: 'EXACT', campaignName: 'Camp B', campaignId: 112, adGroupId: 223, keywordId: 335, impressions: 900, clicks: 40, cost: 20.006, purchases7d: 6, sales7d: 120.5 },
  { searchTerm: 'b083xr4h78', keyword: 'asin="B0"', keywordType: 'TARGETING_EXPRESSION', campaignName: 'Camp B', campaignId: 112, adGroupId: 223, keywordId: null, impressions: 70, clicks: 5, cost: 9, purchases7d: 0, sales7d: 0 },
];
const EXPECTED_ROWS = [
  ['top seller', 'Camp B', 'EXACT', 900, 40, 20.01, 120.5, 6, '112', '223', '335', 'top seller'],
  ['low sales', 'Camp A', 'BROAD', 50, 4, 3.46, 10, 1, '111', '222', '333', 'kw1'],
  ['b083xr4h78', 'Camp B', 'TARGETING_EXPRESSION', 70, 5, 9, 0, 0, '112', '223', '', 'asin="B0"'],
];

function run({ clients, cache, env = {}, args = ['30'] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terms-'));
  const reqLog = path.join(dir, 'req.jsonl'); const summaryFile = path.join(dir, 'summary.md');
  const store = JSON.parse(JSON.stringify(cache));
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(here, 'mock-net-terms.mjs')).href, path.join(root, 'audit-terms-refresh.mjs'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 90000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SUPABASE_URL: FAKE_SB, SUPABASE_SERVICE_KEY: 'fake-key', ADS_CLIENT_ID: 'fake', ADS_CLIENT_SECRET: 'fake', ADS_REFRESH_TOKEN: 'fake',
      REQ_LOG: reqLog, GITHUB_STEP_SUMMARY: summaryFile, FAKE_CLIENTS: JSON.stringify(clients), FAKE_CACHE: JSON.stringify(store), FAKE_REPORT_ROWS: JSON.stringify(REPORT), ...env },
  });
  const reqs = fs.existsSync(reqLog) ? fs.readFileSync(reqLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', reqs, summary: fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8') : '' };
}
const patches = (o) => o.reqs.filter((r) => r.method === 'PATCH');
const reportPosts = (o) => o.reqs.filter((r) => r.method === 'POST' && r.url.endsWith('/reporting/reports'));
const pidOfPatch = (r) => (r.url.match(/profile_id=eq\.(\d+)/) || [])[1];
const clientsOf = (...ids) => ids.map((id) => ({ name: 'Client' + id, spid: 'S' + id, ads_profile_id: id }));

describe('audit-terms-refresh.mjs on a fake network', () => {
  const cache = {
    101: { updated_at: iso(30), payload: savedPayload() },                                            // saved audit without IDs, 30 h old   -> process
    102: { updated_at: iso(80), payload: savedPayload() },                                            // without IDs, 80 h old (stalest)     -> process, FIRST
    103: { updated_at: iso(2), payload: savedPayload({ spTerms: { cols: NEW_COLS, rows: [] } }) },    // has IDs and is 2 h old (full audit)  -> skip
    104: { updated_at: iso(60), payload: savedPayload({ spTerms: { cols: NEW_COLS, rows: [] }, spTermsAsOf: iso(3) }) }, // IDs, terms refreshed 3 h ago -> skip
    105: { updated_at: iso(50), payload: savedPayload({ spTerms: { cols: NEW_COLS, rows: [] }, spTermsAsOf: iso(40) }) }, // IDs but terms 40 h old -> process
  };
  const base = { clients: clientsOf('101', '102', '103', '104', '105'), cache };
  const out = run(base);

  test('invariant: the run completes successfully and prints a summary', () => {
    assert.equal(out.status, 0, out.stderr + out.stdout.slice(-1500));
    assert.match(out.stdout, /FERTIG\./);
    assert.match(out.stdout, /3 aktualisiert/);
    assert.match(out.summary, /Suchbegriffe/);
  });

  test('pin: exactly ONE report per processed account (not ten), none for skipped accounts', () => {
    const posts = reportPosts(out);
    assert.equal(posts.length, 3);
    const scopes = out.reqs.filter((r) => r.method === 'POST' && r.url.endsWith('/reporting/reports')).map((r) => JSON.parse(r.body).configuration.reportTypeId);
    assert.deepEqual([...new Set(scopes)], ['spSearchTerm']);
  });

  test('invariant: the report asks for the ID columns and groups by searchTerm', () => {
    const cfg = JSON.parse(reportPosts(out)[0].body).configuration;
    assert.deepEqual(cfg.groupBy, ['searchTerm']);
    for (const c of ['campaignId', 'adGroupId', 'keywordId', 'keyword', 'matchType', 'campaignName', 'cost', 'sales7d']) assert.ok(cfg.columns.includes(c), c);
    assert.equal(cfg.adProduct, 'SPONSORED_PRODUCTS');
  });

  test('invariant: accounts with fresh IDs are skipped (103, 104); the others are processed, stalest first (102, 105, 101)', () => {
    assert.deepEqual(patches(out).map(pidOfPatch).sort(), ['101', '102', '105']);
    const started = [...out.stdout.matchAll(/=== Client(\d+) /g)].map((m) => m[1]);
    assert.deepEqual(started, ['102', '105', '101']); // 105's newest stamp is its terms refresh 40 h ago, staler than 101's 30 h
  });

  test('pin: the saved audit gets a new spTerms (12 cells, IDs as strings, zero-click rows dropped, sorted by sales) + spTermsAsOf/spTermsWindow; everything else is unchanged', () => {
    const p = patches(out).find((r) => pidOfPatch(r) === '102');
    const payload = JSON.parse(p.body).payload;
    assert.deepEqual(payload.spTerms.cols, NEW_COLS);
    assert.deepEqual(payload.spTerms.rows, EXPECTED_ROWS);
    assert.ok(payload.spTermsAsOf && Math.abs(Date.parse(payload.spTermsAsOf) - Date.now()) < 5 * 60e3);
    assert.match(payload.spTermsWindow.start, /^\d{4}-\d\d-\d\d$/); assert.match(payload.spTermsWindow.end, /^\d{4}-\d\d-\d\d$/);
    const { spTerms, spTermsAsOf, spTermsWindow, ...rest } = payload;
    const { spTerms: _s, ...origRest } = savedPayload();
    assert.deepEqual(rest, origRest, 'totals, bidAdj, formats ... untouched');
  });

  test('pin: updated_at is NOT part of the write (the rest of the audit is not fresher), and the write is conditional on the row not having changed (updated_at=eq.<value read>)', () => {
    for (const p of patches(out)) {
      assert.ok(!('updated_at' in JSON.parse(p.body)), 'body carries only the payload');
      assert.match(decodeURIComponent(p.url), /updated_at=eq\.\d{4}-\d\d-\d\dT[\d:.]+\+00:00/);
    }
  });

  test('SAFETY: only report creation/status, downloads, the token, the client list and the cache (GET/PATCH): no campaign endpoint, no PUT/DELETE, no cache upsert', () => {
    for (const r of out.reqs) {
      assert.ok(['GET', 'POST', 'PATCH'].includes(r.method), r.method + ' ' + r.url);
      if (r.method === 'POST') assert.ok(r.url.endsWith('/reporting/reports') || r.url.endsWith('/auth/o2/token'), 'POST ' + r.url);
      if (r.method === 'PATCH') assert.ok(r.url.includes('/rest/v1/ads_audit_cache?'), 'PATCH ' + r.url);
      assert.ok(!r.url.includes('/sp/') && !r.url.includes('/sb/') && !r.url.includes('/sd/'), 'no campaign API: ' + r.url);
    }
    assert.ok(!out.reqs.some((r) => r.url.includes('on_conflict')), 'no upsert');
  });
});

describe('audit-terms-refresh.mjs: failures and edge cases', () => {
  const cache2 = { 201: { updated_at: iso(70), payload: savedPayload() }, 202: { updated_at: iso(60), payload: savedPayload() }, 203: { updated_at: iso(50), payload: savedPayload() } };
  const base = { clients: clientsOf('201', '202', '203'), cache: cache2 };

  test('invariant: if Amazon fails one account, its saved audit is untouched, the others are written, the run still succeeds', () => {
    const o = run({ ...base, env: { FAKE_FAIL_PROFILE: '202' } });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-800));
    assert.deepEqual(patches(o).map(pidOfPatch).sort(), ['201', '203']);
    assert.match(o.stdout, /2 aktualisiert, 1 NICHT aktualisiert/);
  });

  test('invariant: a FAILURE report status leaves that account untouched too', () => {
    const o = run({ ...base, env: { FAKE_FAILURE_PROFILE: '203' } });
    assert.deepEqual(patches(o).map(pidOfPatch).sort(), ['201', '202']);
  });

  test('invariant: every account failing fails the run (exit 1) so the workflow alerts, and nothing is written', () => {
    const o = run({ ...base, env: { FAKE_FAIL_ALL: '1' } });
    assert.equal(o.status, 1);
    assert.equal(patches(o).length, 0);
    assert.match(o.stdout, /FEHLER/);
  });

  test('invariant: a lost race (row changed after we read it) is skipped, not a failure; nothing is overwritten', () => {
    const o = run({ ...base, env: { FAKE_CAS_CONFLICT_PROFILE: '202' } });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-800));
    assert.match(o.stdout, /geändert|geaendert/);
    assert.ok(!/NICHT aktualisiert, /.test(o.stdout) || /2 aktualisiert, 0 NICHT/.test(o.stdout));
  });

  test('safeguard (found by validation): if a DB trigger bumps updated_at on UPDATE the run says so loudly, fails (exit 1) and writes NO further account', () => {
    const o = run({ ...base, env: { FAKE_TRIGGER_BUMP: '1', TERMS_CONCURRENCY: '1' } });
    assert.equal(o.status, 1, o.stderr + o.stdout.slice(-800));
    assert.match(o.stdout, /WARNUNG/);
    assert.match(o.stdout, /updated_at/);
    assert.equal(patches(o).length, 1, 'after the first detection no other account is written');
  });

  test('safeguard: a normal write leaves updated_at alone and prints no warning', () => {
    const o = run({ ...base, env: { TERMS_CONCURRENCY: '1' } });
    assert.equal(o.status, 0);
    assert.doesNotMatch(o.stdout, /WARNUNG/);
    assert.equal(patches(o).length, 3);
  });

  test('safeguard (found by validation): when (nearly) every started account says "row changed" the run fails (exit 1) instead of staying green forever', () => {
    const o = run({ ...base, env: { FAKE_CAS_CONFLICT_ALL: '1' } });
    assert.equal(o.status, 1, o.stderr + o.stdout.slice(-800));
    assert.match(o.stdout, /FEHLER/);
    assert.match(o.stdout, /geändert/);
  });

  test('invariant: ONLY_PROFILE is a manual test run, so it ignores the "already fresh with IDs" skip', () => {
    const c = { 601: { updated_at: iso(1), payload: savedPayload({ spTerms: { cols: NEW_COLS, rows: [] } }) } };
    const o = run({ clients: clientsOf('601'), cache: c, env: { ONLY_PROFILE: '601' } });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-800));
    assert.equal(reportPosts(o).length, 1);
    assert.deepEqual(patches(o).map(pidOfPatch), ['601']);
  });

  test('invariant: a saved audit that disappears before the write is skipped (no row is created)', () => {
    const o = run({ ...base, env: { FAKE_VANISH_PROFILE: '201' } });
    assert.equal(o.status, 0);
    assert.deepEqual(patches(o).map(pidOfPatch).sort(), ['202', '203']);
  });

  test('invariant: a failing cache write counts as a failure of that account', () => {
    const o = run({ ...base, env: { FAKE_PATCH_FAIL_PROFILE: '201' } });
    assert.match(o.stdout, /2 aktualisiert, 1 NICHT aktualisiert/);
  });

  test('invariant: if the rich listing query is not supported the run falls back to "process everything" instead of failing', () => {
    const c = { 301: { updated_at: iso(1), payload: savedPayload({ spTerms: { cols: NEW_COLS, rows: [] } }) } }; // would be skipped if the listing worked
    const o = run({ clients: clientsOf('301'), cache: c, env: { FAKE_RICH_SELECT_FAIL: '1' } });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-800));
    assert.deepEqual(patches(o).map(pidOfPatch), ['301']);
  });

  test('invariant: everything already fresh = nothing to do, exit 0, no report requested', () => {
    const c = { 401: { updated_at: iso(1), payload: savedPayload({ spTerms: { cols: NEW_COLS, rows: [] } }) } };
    const o = run({ clients: clientsOf('401'), cache: c });
    assert.equal(o.status, 0);
    assert.equal(reportPosts(o).length, 0);
    assert.match(o.stdout, /FERTIG\./);
  });

  test('invariant: dry run (TERMS_DRY_RUN=1) requests the report but writes nothing', () => {
    const o = run({ ...base, env: { TERMS_DRY_RUN: '1' } });
    assert.equal(o.status, 0);
    assert.equal(patches(o).length, 0);
    assert.ok(reportPosts(o).length >= 1);
  });

  test('invariant: ONLY_PROFILE restricts the run to one account', () => {
    const o = run({ ...base, env: { ONLY_PROFILE: '203' } });
    assert.deepEqual(patches(o).map(pidOfPatch), ['203']);
    assert.equal(reportPosts(o).length, 1);
  });

  test('invariant: throttled report creation (429) is retried and succeeds', () => {
    const o = run({ clients: clientsOf('201'), cache: { 201: cache2[201] }, env: { FAKE_429_FIRST: '201' } });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-800));
    assert.deepEqual(patches(o).map(pidOfPatch), ['201']);
  });

  test('invariant: slow reports (PENDING for a few polls) are waited for', () => {
    const o = run({ clients: clientsOf('201'), cache: { 201: cache2[201] }, env: { FAKE_PENDING_ROUNDS: '3' } });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-800));
    assert.equal(patches(o).length, 1);
  });

  test('invariant: size guard - a saved audit that would exceed 3.5 MB gets spTerms rows halved and truncated:true (like the full audit)', () => {
    const big = { 501: { updated_at: iso(70), payload: savedPayload({ filler: 'x'.repeat(3499800) }) } };
    const o = run({ clients: clientsOf('501'), cache: big });
    const payload = JSON.parse(patches(o)[0].body).payload;
    assert.equal(payload.truncated, true);
    assert.ok(payload.spTerms.rows.length < EXPECTED_ROWS.length || payload.spTerms.rows.length === Math.ceil(EXPECTED_ROWS.length / 2));
  });

  test('invariant: the search-term report definition is the same as the full audit\'s (kept in sync on purpose)', () => {
    const cols = (file, re) => (fs.readFileSync(path.join(root, file), 'utf8').match(re) || [])[1];
    const full = cols('audit-refresh.mjs', /sp_search_terms:\s*\{[^}]*columns:\s*\[([^\]]*)\]/);
    const terms = cols('audit-terms-refresh.mjs', /sp_search_terms:\s*\{[^}]*columns:\s*\[([^\]]*)\]/);
    assert.ok(full && terms);
    assert.equal(terms.replace(/\s/g, ''), full.replace(/\s/g, ''));
  });
});
