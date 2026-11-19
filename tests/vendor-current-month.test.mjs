// vendor-ads.mjs, CURRENT (still running) month. Intended behaviour, written before the change (2026-11-19):
// The first night with the strict "store a month only if every report finished" rule showed Amazon throttling the Sponsored-Brands report request for
// 3 of 8 clients ("SB create: zu viele Versuche"), so their current month was not refreshed. The current month is re-imported EVERY day anyway, so a
// failed SB or SD report heals itself the next day. Therefore, for the current partial month only:
//  - SP finished, SB and/or SD failed  -> the month IS stored (from what finished); a stored SB total is kept (not deleted as stale).
//  - SP failed                          -> NOT stored, old rows stay (SP is the only per-ASIN cost source).
// Complete past months stay strict (covered in replace-jobs.test.mjs): once stored they are never re-fetched, so they must be complete.
// Everything runs on the FAKE network of tests/mock-net-replace.mjs: nothing can reach Amazon or Supabase.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcur-'));
  const dbOut = path.join(dir, 'db.json');
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(here, 'mock-net-replace.mjs')).href, path.join(root, 'vendor-ads.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 90000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SUPABASE_URL: 'https://fake-supabase.test', SUPABASE_SERVICE_KEY: 'fake-key', ADS_CLIENT_ID: 'fake', ADS_CLIENT_SECRET: 'fake', ADS_REFRESH_TOKEN: 'fake', FAKE_DB_OUT: dbOut, ...env },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', db: fs.existsSync(dbOut) ? JSON.parse(fs.readFileSync(dbOut, 'utf8')) : null };
}

const n = new Date();
const cur = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1)).toISOString().slice(0, 10);
const noPartialMonthToday = n.getUTCDate() === 1; // on the 1st there is no running month yet
const row = (asin, over = {}) => ({ client_id: 1, profile_id: '555', asin, period_start: cur, period_end: cur, impressions: 1, clicks: 1, cost: 1, ad_orders: 0, ad_sales: 0, ad_units: 0, ...over });
const base = { MONTHS: '1', FAKE_VRA_CLIENTS: JSON.stringify([{ id: 1, name: 'V1', ads_profile_id: '555' }]), FAKE_DB: JSON.stringify({ vra_ads: [row('B0OLDSP001'), row('_SB_TOTAL_', { cost: 77 })] }) };
const rowsOf = (db, start) => db.vra_ads.filter((r) => r.client_id === 1 && r.period_start === start);
const keys = (db, start) => rowsOf(db, start).map((r) => r.asin).sort();
const opt = { skip: noPartialMonthToday ? 'the 1st of a month has no running month' : false };

describe('vendor-ads.mjs: the current (running) month', () => {
  test('SB report FAILS but SP finished: the month is stored from SP (+SD), the stored SB total is kept, the stale ASIN is removed', opt, () => {
    const o = run({ ...base, FAKE_FAIL_TYPES: 'sbCampaigns' });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-600));
    assert.deepEqual(keys(o.db, cur), ['B0NEW00001', 'B0NEW00002', '_SB_TOTAL_']);
    assert.equal(rowsOf(o.db, cur).find((r) => r.asin === '_SB_TOTAL_').cost, 77, 'the old SB total must be untouched');
    assert.match(o.stdout, /fehlgeschlagen/, 'the failure must still be logged');
  });

  test('SD report FAILS but SP finished: the month is stored from SP + SB', opt, () => {
    const o = run({ ...base, FAKE_FAIL_TYPES: 'sdAdvertisedProduct' });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-600));
    assert.deepEqual(keys(o.db, cur), ['B0NEW00001', 'B0NEW00002', '_SB_TOTAL_']);
    assert.notEqual(rowsOf(o.db, cur).find((r) => r.asin === '_SB_TOTAL_').cost, 77, 'SB finished, so its total is refreshed');
  });

  test('SP report FAILS: nothing is stored, the old rows stay (SP is the only source of per-ASIN cost)', opt, () => {
    const o = run({ ...base, FAKE_FAIL_TYPES: 'spAdvertisedProduct' });
    assert.equal(o.status, 0, o.stderr);
    assert.deepEqual(keys(o.db, cur), ['B0OLDSP001', '_SB_TOTAL_']);
  });

  test('a COMPLETE past month with a failed SB report is still NOT stored (it would never be fetched again)', opt, () => {
    const o = run({ ...base, FAKE_FAIL_TYPES: 'sbCampaigns' });
    const prev = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
    assert.equal(o.status, 0, o.stderr);
    assert.deepEqual(keys(o.db, prev), [], 'the past month must stay missing so the next run retries it');
  });
});
