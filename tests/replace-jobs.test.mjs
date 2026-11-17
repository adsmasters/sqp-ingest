// Tests for the two jobs that REPLACE a client's rows: ads-refresh.mjs (table ads_asin_terms) and vendor-ads.mjs (table vra_ads).
// Written from the intended behaviour (CLAUDE.md rule 4 "insert before delete"), NOT from the code:
//  1. New data is written FIRST, old data is deleted AFTER, and only the OLD rows are deleted (never another client's, never fresh rows).
//  2. If anything goes wrong while writing (a chunk fails, the report is empty or incomplete), the old data stays untouched.
//  3. If only the final clean-up fails, the new data is in place (stale rows may linger until the next run) and the job still finishes.
//  4. A month is only stored/replaced when it is COMPLETE (SP report done, no other report failed, not clipped by Amazon's data-retention limit).
// The fake database enforces the REAL unique keys (ads_asin_terms: profile_id+asin+search_term, vra_ads: client_id+asin+period_start; read from the live DB 2026-11-16).
// Everything runs on a FAKE network (tests/mock-net-replace.mjs): nothing can reach Amazon or Supabase, every unknown URL throws.
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
const OLD = '2026-01-01T00:00:00.000Z';

function run(script, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replace-'));
  const reqLog = path.join(dir, 'req.jsonl'), dbOut = path.join(dir, 'db.json');
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(here, 'mock-net-replace.mjs')).href, path.join(root, script)], {
    cwd: root, encoding: 'utf8', timeout: 90000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SUPABASE_URL: FAKE_SB, SUPABASE_SERVICE_KEY: 'fake-key', ADS_CLIENT_ID: 'fake', ADS_CLIENT_SECRET: 'fake', ADS_REFRESH_TOKEN: 'fake', REQ_LOG: reqLog, FAKE_DB_OUT: dbOut, ...env },
  });
  const reqs = fs.existsSync(reqLog) ? fs.readFileSync(reqLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const db = fs.existsSync(dbOut) ? JSON.parse(fs.readFileSync(dbOut, 'utf8')) : null;
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', reqs, db };
}
// safety: the only writes that may happen are Supabase table writes, the token call and report creation (a read-only request for a report)
function assertSafeRequests(reqs) {
  for (const q of reqs) {
    if (q.method === 'GET') continue;
    const ok = q.url === 'https://api.amazon.co.uk/auth/o2/token' || q.url === 'https://advertising-api-eu.amazon.com/reporting/reports' || q.url.startsWith(FAKE_SB + '/rest/v1/');
    assert.ok(ok, 'unexpected write request: ' + q.method + ' ' + q.url);
  }
}
// "insert first, delete second": every DELETE on a table must be preceded by at least one POST to the same table
function assertInsertBeforeDelete(reqs, table) {
  reqs.forEach((q, i) => {
    if (q.method === 'DELETE' && q.url.includes('/rest/v1/' + table)) assert.ok(reqs.slice(0, i).some((p) => p.method === 'POST' && p.url.includes('/rest/v1/' + table)), `DELETE on ${table} before any insert (request #${i})`);
  });
}
const deletes = (reqs, table) => reqs.filter((q) => q.method === 'DELETE' && q.url.includes('/rest/v1/' + table));

// ---------------------------------------------------------------- ads-refresh.mjs
describe('ads-refresh.mjs replaces ads_asin_terms safely', () => {
  const SEED = [
    { profile_id: '555', asin: 'B0NEW00001', search_term: 'term 1', clicks: 999, cost: 99, purchases7d: 9, sales7d: 99, ingested_at: OLD }, // same key as a new row
    { profile_id: '555', asin: 'B0OLD00001', search_term: 'old term', clicks: 5, cost: 1, purchases7d: 0, sales7d: 0, ingested_at: OLD },     // no longer in the report
    { profile_id: '999', asin: 'B0OTHER001', search_term: 'keep me', clicks: 7, cost: 1, purchases7d: 0, sales7d: 0, ingested_at: OLD },     // another client
  ];
  const base = { FAKE_CLIENTS: JSON.stringify([{ name: 'C1', ads_profile_id: '555' }]), FAKE_DB: JSON.stringify({ ads_asin_terms: SEED }) };
  const keys = (db, profile) => db.ads_asin_terms.filter((r) => r.profile_id === profile).map((r) => r.asin + '|' + r.search_term).sort();
  const NEW_KEYS = ['B0NEW00001', 'B0NEW00002'].flatMap((a) => ['term 1', 'term 2', 'term 3'].map((t) => a + '|' + t)).sort();
  const writes = (reqs) => reqs.filter((q) => q.method === 'POST' && q.url.includes('/rest/v1/ads_asin_terms'));

  test('success: the client ends with exactly the new rows (old stale rows gone), other clients untouched, insert came before delete', () => {
    const o = run('ads-refresh.mjs', base);
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-800));
    assert.deepEqual(keys(o.db, '555'), NEW_KEYS);
    assert.notEqual(o.db.ads_asin_terms.find((r) => r.asin === 'B0NEW00001' && r.search_term === 'term 1').clicks, 999, 'a row that existed before must be refreshed with the new numbers, not left at its old value');
    assert.deepEqual(keys(o.db, '999'), ['B0OTHER001|keep me']);
    assertInsertBeforeDelete(o.reqs, 'ads_asin_terms');
    assertSafeRequests(o.reqs);
  });

  test('writes go out in bounded chunks (<= 500 rows) — every row is an update of an existing row now', () => {
    const o = run('ads-refresh.mjs', { ...base, FAKE_TERMS: '1500' });
    assert.equal(o.status, 0, o.stderr);
    const w = writes(o.reqs);
    assert.ok(w.length >= 6, 'expected several chunks for 3000 rows, got ' + w.length);
    assert.ok(Math.max(...w.map((q) => q.rows)) <= 500, 'chunk too big: ' + Math.max(...w.map((q) => q.rows)));
    assert.equal(keys(o.db, '555').length, 3000);
  });

  test('big batches time out in the database (8 s, 57014): the job falls back to SMALL pieces and still writes everything, then cleans up', () => {
    const o = run('ads-refresh.mjs', { ...base, FAKE_TERMS: '1500', FAKE_MAX_ROWS: '250' });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-500));
    assert.equal(keys(o.db, '555').length, 3000);
    assert.ok(!keys(o.db, '555').includes('B0OLD00001|old term'), 'stale row must be gone after a complete run');
    assert.ok(Math.max(...writes(o.reqs).filter((q) => q.rows <= 250).map((q) => q.rows)) <= 100, 'fallback pieces must be small');
  });

  test('a ONE-OFF write failure (timeout on one chunk) is retried: everything is written and the stale rows are cleaned up', () => {
    const o = run('ads-refresh.mjs', { ...base, FAKE_TERMS: '1500', FAKE_INSERT_FAIL_NTH: '1' });
    assert.equal(o.status, 0, o.stderr);
    assert.equal(keys(o.db, '555').length, 3000);
    assert.ok(!keys(o.db, '555').includes('B0OLD00001|old term'), 'stale row must be gone after a complete run');
  });

  test('a PERSISTENT write failure in the first chunk: ALL old rows are still there, nothing is deleted, and the run is reported as FAILED (exit code 1, so the Slack alert fires)', () => {
    const o = run('ads-refresh.mjs', { ...base, FAKE_TERMS: '1500', FAKE_INSERT_FAIL_MATCH: '"search_term":"term 5"' });
    assert.equal(o.status, 1, o.stderr);
    assert.ok(keys(o.db, '555').includes('B0OLD00001|old term'), 'old stale row must survive a failed write');
    assert.equal(deletes(o.reqs, 'ads_asin_terms').length, 0, 'no DELETE at all after a failed write');
    assert.deepEqual(keys(o.db, '999'), ['B0OTHER001|keep me']);
  });

  test('a PERSISTENT write failure in a later chunk: old rows are still there, nothing is deleted, the run is reported as FAILED', () => {
    const o = run('ads-refresh.mjs', { ...base, FAKE_TERMS: '1500', FAKE_INSERT_FAIL_MATCH: '"search_term":"term 700"' });
    assert.equal(o.status, 1, o.stderr);
    assert.ok(keys(o.db, '555').includes('B0OLD00001|old term'));
    assert.equal(deletes(o.reqs, 'ads_asin_terms').length, 0);
  });

  test('an EMPTY search-term report never wipes the client (old rows stay, no DELETE)', () => {
    const o = run('ads-refresh.mjs', { ...base, FAKE_TERMS: '0' });
    assert.equal(o.status, 0, o.stderr);
    assert.deepEqual(keys(o.db, '555'), ['B0NEW00001|term 1', 'B0OLD00001|old term']);
    assert.equal(deletes(o.reqs, 'ads_asin_terms').length, 0);
  });

  test('a failed report (search terms) leaves the old rows alone', () => {
    const o = run('ads-refresh.mjs', { ...base, FAKE_FAIL_TYPES: 'spSearchTerm' });
    assert.equal(o.status, 0, o.stderr);
    assert.deepEqual(keys(o.db, '555'), ['B0NEW00001|term 1', 'B0OLD00001|old term']);
    assert.equal(deletes(o.reqs, 'ads_asin_terms').length, 0);
  });

  test('only the final clean-up fails completely: new rows are all in place, the job finishes, and the failure is VISIBLE (exit code 1) instead of silent', () => {
    const o = run('ads-refresh.mjs', { ...base, FAKE_DELETE_FAIL: '1' });
    assert.equal(o.status, 1, o.stderr);
    for (const k of NEW_KEYS) assert.ok(keys(o.db, '555').includes(k), 'missing new row ' + k);
    assert.match(o.stdout, /ADS-REFRESH FERTIG/);
  });

  test('a whole-client DELETE is too big for the 8 s limit (huge accounts have millions of rows): the clean-up still removes stale rows ASIN by ASIN', () => {
    const seed = [...SEED, { profile_id: '555', asin: 'B0NEW00001', search_term: 'gone term', clicks: 3, cost: 1, purchases7d: 0, sales7d: 0, ingested_at: OLD }]; // same ASIN as the report, term no longer there
    const o = run('ads-refresh.mjs', { ...base, FAKE_DB: JSON.stringify({ ads_asin_terms: seed }), FAKE_DELETE_FAIL_NOASIN: '1' });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-500));
    assert.ok(!keys(o.db, '555').includes('B0NEW00001|gone term'), 'stale term of a known ASIN must be removed by the per-ASIN clean-up');
    for (const k of NEW_KEYS) assert.ok(keys(o.db, '555').includes(k), 'missing new row ' + k);
    assert.deepEqual(keys(o.db, '999'), ['B0OTHER001|keep me']);
  });
});

// ---------------------------------------------------------------- vendor-ads.mjs
describe('vendor-ads.mjs replaces vra_ads months safely', () => {
  const n = new Date();
  const prev = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);  // last full month: its stored state decides whether it is re-imported
  const prevEnd = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 0)).toISOString().slice(0, 10);   // last day of that month
  const row = (client, asin, over = {}) => ({ client_id: client, profile_id: '555', asin, period_start: prev, period_end: prev, impressions: 1, clicks: 1, cost: 1, ad_orders: 0, ad_sales: 0, ad_units: 0, ...over });
  // client 1: the month is stored as a PARTIAL month (period_end = first day), so the job re-imports it
  const SEED = [row(1, 'B0OLDSP001'), row(1, '_SB_TOTAL_'), row(2, 'B0OTHERCL1', { profile_id: '777' })];
  const base = { MONTHS: '1', FAKE_VRA_CLIENTS: JSON.stringify([{ id: 1, name: 'V1', ads_profile_id: '555' }]), FAKE_DB: JSON.stringify({ vra_ads: SEED }) };
  const month = (db, client) => db.vra_ads.filter((r) => r.client_id === client && r.period_start === prev);
  const keys = (db, client) => month(db, client).map((r) => r.asin).sort();
  const noDuplicates = (db) => { const k = db.vra_ads.map((r) => [r.client_id, r.asin, r.period_start].join('|')); assert.equal(new Set(k).size, k.length, 'duplicate rows for one client+asin+month'); };
  const NEW = ['B0NEW00001', 'B0NEW00002', '_SB_TOTAL_'];
  const matchPrev = '"period_start":"' + prev + '"';

  test('success: the month ends with exactly the new rows (old stale ASIN gone, no duplicates, complete period_end), other clients untouched, write came before delete', () => {
    const o = run('vendor-ads.mjs', base);
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-800));
    assert.deepEqual(keys(o.db, 1), NEW);
    assert.ok(month(o.db, 1).every((r) => r.period_end === prevEnd), 'every row of the month carries the full-month period_end');
    assert.deepEqual(keys(o.db, 2), ['B0OTHERCL1']);
    noDuplicates(o.db);
    assertInsertBeforeDelete(o.reqs, 'vra_ads');
    assertSafeRequests(o.reqs);
  });

  test('the write for the month fails (HTTP 500): the old rows of that month are all still there, unchanged', () => {
    const o = run('vendor-ads.mjs', { ...base, FAKE_INSERT_FAIL_MATCH: matchPrev });
    assert.equal(o.status, 0, o.stderr);
    assert.deepEqual(keys(o.db, 1), ['B0OLDSP001', '_SB_TOTAL_']);
    assert.ok(month(o.db, 1).every((r) => r.period_end === prev));
    assert.deepEqual(keys(o.db, 2), ['B0OTHERCL1']);
  });

  test('a NETWORK error (fetch throws) while writing: the job survives, the old rows stay, nothing is duplicated', () => {
    const o = run('vendor-ads.mjs', { ...base, FAKE_INSERT_THROW_MATCH: matchPrev });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-500));
    assert.deepEqual(keys(o.db, 1), ['B0OLDSP001', '_SB_TOTAL_']);
    noDuplicates(o.db);
  });

  test('the write breaks HALF-WAY (3 chunks, 2nd fails): no row is lost, nothing is duplicated, and the month still looks INCOMPLETE so the next run retries it', () => {
    const o = run('vendor-ads.mjs', { ...base, FAKE_SP_ASINS: '1200', FAKE_INSERT_FAIL_MATCH: matchPrev, FAKE_INSERT_FAIL_AFTER: '1' });
    assert.equal(o.status, 0, o.stderr);
    assert.ok(keys(o.db, 1).includes('B0OLDSP001') && keys(o.db, 1).includes('_SB_TOTAL_'), 'old rows must not be lost');
    noDuplicates(o.db);
    assert.ok(month(o.db, 1).some((r) => r.period_end < prevEnd), 'at least one row still carries the old partial period_end, so the next run re-imports the month');
  });

  test('a LEFTOVER old partial row between complete rows still makes the month count as incomplete (the state check looks at the whole month, not at one arbitrary row)', () => {
    const seed = [row(1, 'B0AAA00001', { period_end: prevEnd }), row(1, 'B0BBB00002', { period_end: prev })];
    const o = run('vendor-ads.mjs', { ...base, FAKE_DB: JSON.stringify({ vra_ads: seed }) });
    assert.equal(o.status, 0, o.stderr);
    assert.deepEqual(keys(o.db, 1), NEW);
    assert.ok(month(o.db, 1).every((r) => r.period_end === prevEnd));
  });

  test('a PROFILE CHANGE is detected even when other rows of the month already carry the new profile', () => {
    const seed = [row(1, 'B0AAA00001', { period_end: prevEnd, profile_id: '555' }), row(1, 'B0BBB00002', { period_end: prevEnd, profile_id: '444' })];
    const o = run('vendor-ads.mjs', { ...base, FAKE_DB: JSON.stringify({ vra_ads: seed }) });
    assert.equal(o.status, 0, o.stderr);
    assert.deepEqual(keys(o.db, 1), NEW);
    assert.ok(month(o.db, 1).every((r) => r.profile_id === '555'));
  });

  test('the SP report (the only source of per-ASIN cost) fails but SB finishes: an existing month is NOT replaced by the incomplete data', () => {
    const o = run('vendor-ads.mjs', { ...base, FAKE_FAIL_TYPES: 'spAdvertisedProduct' });
    assert.equal(o.status, 0, o.stderr);
    assert.deepEqual(keys(o.db, 1), ['B0OLDSP001', '_SB_TOTAL_']);
    assert.ok(month(o.db, 1).every((r) => r.period_end === prev), 'old rows untouched');
  });

  test('a month with NO stored data is NOT written from incomplete data either (SP failed, SB ok): it stays missing so the next run retries it', () => {
    const o = run('vendor-ads.mjs', { ...base, FAKE_DB: JSON.stringify({ vra_ads: [] }), FAKE_FAIL_TYPES: 'spAdvertisedProduct' });
    assert.equal(o.status, 0, o.stderr);
    assert.deepEqual(keys(o.db, 1), []);
  });

  test('SB (or SD) fails while SP is fine: an existing month is not replaced by data without the SB/SD part', () => {
    const o = run('vendor-ads.mjs', { ...base, FAKE_FAIL_TYPES: 'sbCampaigns' });
    assert.equal(o.status, 0, o.stderr);
    assert.deepEqual(keys(o.db, 1), ['B0OLDSP001', '_SB_TOTAL_']);
    assert.ok(month(o.db, 1).every((r) => r.period_end === prev));
  });

  test("a month CLIPPED by Amazon's data-retention limit never replaces stored data", () => {
    const cut = new Date(Date.parse(prev + 'T00:00:00Z') + 5 * 864e5).toISOString().slice(0, 10); // retention starts 5 days into the month
    const o = run('vendor-ads.mjs', { ...base, FAKE_RETENTION_START: cut });
    assert.equal(o.status, 0, o.stderr);
    assert.deepEqual(keys(o.db, 1), ['B0OLDSP001', '_SB_TOTAL_']);
    assert.ok(month(o.db, 1).every((r) => r.period_end === prev));
  });

  test('a month CLIPPED by the retention limit is not stored as if it were a complete month (no stored data yet)', () => {
    const cut = new Date(Date.parse(prev + 'T00:00:00Z') + 5 * 864e5).toISOString().slice(0, 10);
    const o = run('vendor-ads.mjs', { ...base, FAKE_DB: JSON.stringify({ vra_ads: [] }), FAKE_RETENTION_START: cut });
    assert.equal(o.status, 0, o.stderr);
    assert.deepEqual(keys(o.db, 1), []);
  });

  test('SD report CREATION is refused for this account (HTTP 403, no such ad product): that is NOT a failure — the month is stored from the other reports', () => {
    const o = run('vendor-ads.mjs', { ...base, FAKE_CREATE_FAIL_TYPES: 'sdAdvertisedProduct' });
    assert.equal(o.status, 0, o.stderr);
    assert.deepEqual(keys(o.db, 1), NEW);
    assert.ok(month(o.db, 1).every((r) => r.period_end === prevEnd));
  });

  test('SB report creation is refused (no such ad product): the month is stored, and an already stored SB total is kept (not deleted as "stale")', () => {
    const o = run('vendor-ads.mjs', { ...base, FAKE_CREATE_FAIL_TYPES: 'sbCampaigns' });
    assert.equal(o.status, 0, o.stderr);
    assert.deepEqual(keys(o.db, 1), ['B0NEW00001', 'B0NEW00002', '_SB_TOTAL_']);
    assert.equal(month(o.db, 1).find((r) => r.asin === '_SB_TOTAL_').period_end, prev, 'the old SB total row is untouched');
  });

  test('SP is complete but only SB/SD are clipped by their (shorter) retention window: a month with NO stored data is stored (nothing better can ever be fetched)', () => {
    const cut = new Date(Date.parse(prev + 'T00:00:00Z') + 5 * 864e5).toISOString().slice(0, 10);
    const o = run('vendor-ads.mjs', { ...base, FAKE_DB: JSON.stringify({ vra_ads: [] }), FAKE_RETENTION_START: cut, FAKE_RETENTION_TYPES: 'sbCampaigns,sdAdvertisedProduct' });
    assert.equal(o.status, 0, o.stderr);
    assert.ok(keys(o.db, 1).includes('B0NEW00001') && keys(o.db, 1).includes('B0NEW00002'), 'SP data must be stored');
  });

  test('SP is complete but SB/SD are clipped, and the month already has stored data: the stored data is NOT replaced by the shorter data', () => {
    const cut = new Date(Date.parse(prev + 'T00:00:00Z') + 5 * 864e5).toISOString().slice(0, 10);
    const o = run('vendor-ads.mjs', { ...base, FAKE_RETENTION_START: cut, FAKE_RETENTION_TYPES: 'sbCampaigns,sdAdvertisedProduct' });
    assert.equal(o.status, 0, o.stderr);
    assert.deepEqual(keys(o.db, 1), ['B0OLDSP001', '_SB_TOTAL_']);
    assert.ok(month(o.db, 1).every((r) => r.period_end === prev));
  });

  test('only the final clean-up fails: the new rows are all in place, nothing is duplicated, and the job still finishes', () => {
    const o = run('vendor-ads.mjs', { ...base, FAKE_DELETE_FAIL: '1' });
    assert.equal(o.status, 0, o.stderr);
    for (const a of NEW) assert.ok(keys(o.db, 1).includes(a), 'missing new row ' + a);
    noDuplicates(o.db);
    assert.match(o.stdout, /FERTIG\./);
  });
});
