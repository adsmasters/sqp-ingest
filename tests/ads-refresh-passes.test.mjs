// ads-refresh.mjs memory fix (2026-11-21). The first manual run on the 2 GB Hetzner server aborted with "heap out of memory" (exit 134) at the biggest
// account (~4.8 million ASIN x search-term rows held in memory at once, plus a copy). Intended behaviour (written BEFORE the fix):
//  - a large account is processed in SEVERAL PASSES, each pass holding only a share of the (ASIN, term) pairs in memory; the passes are split by SEARCH TERM,
//    so the same (ASIN, term) coming from two ad groups still lands in one pass and is summed into ONE row;
//  - the RESULT is identical to the single-pass result: same rows, same numbers, nothing lost, nothing written twice;
//  - a persistent write failure in any pass stops the run for that client: old data stays, nothing is deleted, exit code 1 (as before);
//  - the opt-in clean-up (ADS_REFRESH_CLEANUP=1) still removes stale rows, also for ASINs that only occur in later passes;
//  - the number of passes follows the size: small accounts stay a single pass.
// Everything runs on the FAKE network of tests/mock-net-replace.mjs (nothing can reach Amazon or Supabase).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
function run(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pass-'));
  const reqLog = path.join(dir, 'req.jsonl'), dbOut = path.join(dir, 'db.json');
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(here, 'mock-net-replace.mjs')).href, path.join(root, 'ads-refresh.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 120000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SUPABASE_URL: 'https://fake-supabase.test', SUPABASE_SERVICE_KEY: 'fake-key', ADS_CLIENT_ID: 'fake', ADS_CLIENT_SECRET: 'fake', ADS_REFRESH_TOKEN: 'fake', REQ_LOG: reqLog, FAKE_DB_OUT: dbOut, ...env },
  });
  const reqs = fs.existsSync(reqLog) ? fs.readFileSync(reqLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', reqs, db: fs.existsSync(dbOut) ? JSON.parse(fs.readFileSync(dbOut, 'utf8')) : null };
}
const OLD = '2026-01-01T00:00:00.000Z';
const SEED = [
  { profile_id: '555', asin: 'B0OLD00001', search_term: 'old term', clicks: 5, cost: 1, purchases7d: 0, sales7d: 0, ingested_at: OLD },
  { profile_id: '999', asin: 'B0OTHER001', search_term: 'keep me', clicks: 7, cost: 1, purchases7d: 0, sales7d: 0, ingested_at: OLD },
];
const base = { FAKE_CLIENTS: JSON.stringify([{ name: 'C1', ads_profile_id: '555' }]), FAKE_DB: JSON.stringify({ ads_asin_terms: SEED }), FAKE_TERMS: '300', FAKE_TERM_GROUPS: '2' };
// rows of the client without bookkeeping columns, sorted, numbers rounded — comparable between runs
const canon = (db, profile = '555') => db.ads_asin_terms.filter((r) => r.profile_id === profile && !r.asin.startsWith('B0OLD')).map((r) => [r.asin, r.search_term, r.clicks, +r.cost.toFixed(2), r.purchases7d, +r.sales7d.toFixed(2)].join('|')).sort();
const posted = (reqs) => reqs.filter((q) => q.method === 'POST' && q.url.includes('/rest/v1/ads_asin_terms'));

describe('ads-refresh.mjs: large accounts in several passes', () => {
  const single = run({ ...base, ADS_REFRESH_PASS_ROWS: '100000000' }); // threshold far above the size: one pass
  const multi = run({ ...base, ADS_REFRESH_PASS_ROWS: '250' });          // tiny threshold: forces many passes

  test('baseline: a small account is processed in one pass', () => {
    assert.equal(single.status, 0, single.stderr + single.stdout.slice(-600));
    assert.ok(!/Durchg(ae|ä)ng/i.test(single.stdout), 'no pass message for a single pass');
    assert.ok(canon(single.db).length > 300, 'rows were written');
  });

  test('the same (ASIN, term) from TWO ad groups is summed into ONE row, in both modes (no duplicate keys, no lost numbers)', () => {
    for (const o of [single, multi]) {
      const keys = canon(o.db).map((x) => x.split('|').slice(0, 2).join('|'));
      assert.equal(new Set(keys).size, keys.length, 'duplicate (asin, term) keys');
    }
  });

  test('the result with several passes is IDENTICAL to the single-pass result (same rows, same numbers)', () => {
    assert.equal(multi.status, 0, multi.stderr + multi.stdout.slice(-600));
    assert.deepEqual(canon(multi.db), canon(single.db));
  });

  test('several passes are announced in the log and every row is written exactly once overall', () => {
    assert.match(multi.stdout, /Durchg(ae|ä)ng/i);
    const rowsPosted = posted(multi.reqs).reduce((a, q) => a + (q.rows || 0), 0);
    assert.equal(rowsPosted, canon(multi.db).length, 'rows sent = rows stored (nothing written twice)');
  });

  test('a persistent write failure in a LATER pass: the run for that client stops, nothing is deleted, old rows stay, exit code 1', () => {
    const o = run({ ...base, ADS_REFRESH_PASS_ROWS: '250', FAKE_INSERT_FAIL_MATCH: '"search_term":"term 250"' });
    assert.equal(o.status, 1, o.stderr + o.stdout.slice(-400));
    assert.equal(o.reqs.filter((q) => q.method === 'DELETE').length, 0, 'no DELETE after a failed write');
    assert.ok(o.db.ads_asin_terms.some((r) => r.asin === 'B0OLD00001'), 'old row must survive');
  });

  test('the opt-in clean-up still removes stale rows after a multi-pass run', () => {
    const o = run({ ...base, ADS_REFRESH_PASS_ROWS: '250', ADS_REFRESH_CLEANUP: '1' });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-400));
    assert.ok(!o.db.ads_asin_terms.some((r) => r.asin === 'B0OLD00001'), 'stale row removed');
    assert.deepEqual(canon(o.db), canon(single.db));
    assert.ok(o.db.ads_asin_terms.some((r) => r.profile_id === '999'), 'other client untouched');
  });

  test('an empty search-term report still keeps the old data (no passes, no wipe)', () => {
    const o = run({ ...base, FAKE_TERMS: '0', ADS_REFRESH_PASS_ROWS: '250' });
    assert.equal(o.status, 0, o.stderr);
    assert.ok(o.db.ads_asin_terms.some((r) => r.asin === 'B0OLD00001'));
  });
});
