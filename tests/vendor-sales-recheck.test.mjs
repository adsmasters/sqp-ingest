// vendor-sales.mjs, CURRENT (running) month: re-check slow reports at the end of the run.
// Background (2026-11-22/23/24): on every night 2-3 clients showed "Laufender Monat: Report fehlgeschlagen". Reading the code: the script waits at most
// 10 minutes (120 polls, 5 s apart) for Amazon's report, then DROPS the report id and moves on, so a report that finishes a few minutes later is lost
// and the client's running month stays one day behind (this happened on the old GitHub runs as well, e.g. one client on 21 Nov).
// Intended behaviour (written BEFORE the change):
//  - the script still waits up to 10 minutes and then moves on to the next client, exactly as before;
//  - a report that was merely NOT READY (timeout) is remembered (its report id, the data collected so far, the chunk it was waiting for);
//    after ALL clients are done, that same report is checked again (up to 5 minutes per client) — NO new report is requested for it;
//  - if it is ready now: the remaining chunks of the month (if any) are fetched and the running month is stored (same write path as before);
//  - if it is still not ready: the stored data stays untouched (as before), "Laufender Monat: Report fehlgeschlagen" is logged, the exit code stays 0;
//  - a report that Amazon marked FATAL/CANCELLED can never finish, so it is NOT remembered and NOT checked again;
//  - when every report is ready in time, nothing changes (no re-check section in the log);
//  - the log says how many reports were picked up by the re-check.
// Everything runs on the FAKE network of tests/mock-net-vendor-sales.mjs (nothing can reach Amazon or Supabase) with "today" pinned to 28 Nov 2026,
// so the running month has TWO 14-day chunks per client: 01-14 and 15-24 (the newest 4 days are not available yet).
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsales-'));
  const reqLog = path.join(dir, 'req.jsonl'), dbOut = path.join(dir, 'db.json');
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(here, 'mock-net-vendor-sales.mjs')).href, path.join(root, 'vendor-sales.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 120000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SUPABASE_URL: 'https://fake-supabase.test', SUPABASE_SERVICE_KEY: 'fake-key', SPAPI_CLIENT_ID: 'fake', SPAPI_CLIENT_SECRET: 'fake', MONTHS: '1', FAKE_NOW: '2026-11-28T08:00:00Z', REQ_LOG: reqLog, FAKE_DB_OUT: dbOut, ...env },
  });
  const reqs = fs.existsSync(reqLog) ? fs.readFileSync(reqLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', reqs, db: fs.existsSync(dbOut) ? JSON.parse(fs.readFileSync(dbOut, 'utf8')) : null };
}

const CLIENTS = [{ id: 1, name: 'Alpha', marketplace: 'DE', spid: 'SA' }, { id: 2, name: 'Beta', marketplace: 'DE', spid: 'SB' }];
// the previous month is already stored and complete, so only the running month is requested
const DONE_OCT = CLIENTS.map((c) => ({ id: 100 + c.id, client_id: c.id, period_start: '2026-10-01', period_end: '2026-10-31', currency: 'EUR' }));
const base = { FAKE_VCLIENTS: JSON.stringify(CLIENTS), FAKE_DB: JSON.stringify({ vra_reports: DONE_OCT }) };
const created = (reqs) => reqs.filter((q) => q.method === 'POST' && q.url.endsWith('/reports/2021-06-30/reports'));
const polls = (reqs, id) => reqs.filter((q) => q.method === 'GET' && q.url.endsWith('/reports/2021-06-30/reports/' + id)).length;
const novReport = (db, clientId) => db.vra_reports.find((r) => r.client_id === clientId && r.period_start === '2026-11-01');
const asinsOf = (db, clientId) => { const rep = novReport(db, clientId); return rep ? db.vra_data.filter((d) => d.report_id === rep.id).map((d) => d.asin).sort() : []; };

describe('vendor-sales.mjs: running month, slow reports are re-checked at the end', () => {
  test('baseline: every report ready in time -> both clients stored with both chunks, no re-check section, exit 0', () => {
    const o = run(base);
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-600));
    assert.ok(!/Nachprüfung/.test(o.stdout), 'no re-check when nothing was slow');
    for (const [id, sp] of [[1, 'SA'], [2, 'SB']]) {
      assert.deepEqual(asinsOf(o.db, id), [`B0${sp}D01`, `B0${sp}D15`]);
      assert.equal(novReport(o.db, id).period_end, '2026-11-24');
    }
    assert.equal(created(o.reqs).length, 4, '2 chunks x 2 clients');
  });

  test('a report not ready after 10 minutes: the script moves on to the next client first, then re-checks the SAME report and stores the month (no new report for it)', () => {
    const o = run({ ...base, FAKE_SLOW: JSON.stringify({ SA: { report: 1, polls: 130 } }) });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-800));
    assert.match(o.stdout, /noch nicht fertig/);
    assert.ok(o.stdout.indexOf('== Beta') < o.stdout.indexOf('Nachprüfung'), 'the next client is processed BEFORE the re-check');
    assert.match(o.stdout, /Nachprüfung: 1 von 1/);
    assert.deepEqual(asinsOf(o.db, 1), ['B0SAD01', 'B0SAD15'], 'the slow client is stored with BOTH chunks (the first from the re-checked report, the second requested after it)');
    assert.deepEqual(asinsOf(o.db, 2), ['B0SBD01', 'B0SBD15']);
    assert.equal(created(o.reqs).length, 4, 'no extra report was requested for the slow one');
    assert.ok(polls(o.reqs, 'rep-1') >= 130, 'the same report id (rep-1) was polled again');
  });

  test('the slow report is the SECOND chunk: the first chunk collected before is kept and the month still ends up complete', () => {
    const o = run({ ...base, FAKE_SLOW: JSON.stringify({ SA: { report: 2, polls: 130 } }) });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-800));
    assert.match(o.stdout, /Nachprüfung: 1 von 1/);
    assert.deepEqual(asinsOf(o.db, 1), ['B0SAD01', 'B0SAD15']);
    assert.equal(novReport(o.db, 1).period_end, '2026-11-24');
    assert.equal(created(o.reqs).length, 4, 'the first chunk was NOT requested again');
  });

  test('two slow clients: both are re-checked after everyone else, both stored', () => {
    const o = run({ ...base, FAKE_SLOW: JSON.stringify({ SA: { report: 1, polls: 130 }, SB: { report: 1, polls: 125 } }) });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-800));
    assert.match(o.stdout, /Nachprüfung: 2 von 2/);
    assert.deepEqual(asinsOf(o.db, 1), ['B0SAD01', 'B0SAD15']);
    assert.deepEqual(asinsOf(o.db, 2), ['B0SBD01', 'B0SBD15']);
  });

  test('a report that never gets ready: old stored rows stay untouched, "Report fehlgeschlagen" is logged, exit 0, the re-check is bounded (about 60 more polls) and the others are unaffected', () => {
    const seed = { vra_reports: [...DONE_OCT, { id: 500, client_id: 1, period_start: '2026-11-01', period_end: '2026-11-10', currency: 'EUR' }], vra_data: [{ id: 900, report_id: 500, client_id: 1, asin: 'B0OLDAAA', period_start: '2026-11-01', period_end: '2026-11-10' }] };
    const o = run({ ...base, FAKE_DB: JSON.stringify(seed), FAKE_SLOW: JSON.stringify({ SA: { report: 1, polls: 99999 } }) });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-800));
    assert.match(o.stdout, /Nachprüfung: 0 von 1/);
    assert.match(o.stdout, /Laufender Monat: Report fehlgeschlagen/);
    assert.deepEqual(asinsOf(o.db, 1), ['B0OLDAAA'], 'the old running-month data must survive');
    assert.equal(novReport(o.db, 1).period_end, '2026-11-10');
    const p = polls(o.reqs, 'rep-1');
    assert.ok(p >= 170 && p <= 185, `first wait (120) + re-check (60) polls, got ${p}`);
    assert.deepEqual(asinsOf(o.db, 2), ['B0SBD01', 'B0SBD15']);
  });

  test('the re-check has a time budget (VENDOR_RECHECK_BUDGET_MIN, default 30): when it is used up the remaining clients are skipped, logged, and keep their old data', () => {
    const o = run({ ...base, VENDOR_RECHECK_BUDGET_MIN: '0', FAKE_SLOW: JSON.stringify({ SA: { report: 1, polls: 130 }, SB: { report: 1, polls: 125 } }) });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-800));
    assert.match(o.stdout, /Zeitbudget/);
    assert.match(o.stdout, /Nachprüfung: 0 von 2/);
    assert.deepEqual(asinsOf(o.db, 1), []);
    assert.deepEqual(asinsOf(o.db, 2), []);
  });

  // Review findings 2026-11-24 (test reviewer): cases that were missing.
  test('the re-check succeeds for the FIRST chunk but the SECOND chunk stays slow: nothing is stored (old data stays), the second chunk waits at most 5 minutes (60 polls) in the re-check, exit 0', () => {
    const seed = { vra_reports: [...DONE_OCT, { id: 500, client_id: 1, period_start: '2026-11-01', period_end: '2026-11-10', currency: 'EUR' }], vra_data: [{ id: 900, report_id: 500, client_id: 1, asin: 'B0OLDAAA', period_start: '2026-11-01', period_end: '2026-11-10' }] };
    const o = run({ ...base, FAKE_DB: JSON.stringify(seed), FAKE_SLOW: JSON.stringify({ SA: [{ report: 1, polls: 130 }, { report: 2, polls: 99999 }] }) });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-800));
    assert.match(o.stdout, /Nachprüfung: 0 von 1/);
    assert.match(o.stdout, /auch nach Nachprüfung/);
    assert.deepEqual(asinsOf(o.db, 1), ['B0OLDAAA'], 'half a month must never replace the old data');
    assert.equal(novReport(o.db, 1).period_end, '2026-11-10');
    // report numbering: rep-1 = Alpha chunk 1 (deferred), rep-2/rep-3 = Beta chunks 1/2, rep-4 = Alpha chunk 2 (requested during the re-check)
    assert.equal(created(o.reqs).length, 4);
    const p4 = polls(o.reqs, 'rep-4');
    assert.ok(p4 >= 55 && p4 <= 62, `the re-check waits about 60 polls (5 min) for a remaining chunk, got ${p4}`);
  });

  test('an EXISTING running-month row is updated in place after a successful re-check: new rows inserted FIRST, old rows deleted afterwards, no duplicates, no stale ASIN', () => {
    const seed = { vra_reports: [...DONE_OCT, { id: 500, client_id: 1, period_start: '2026-11-01', period_end: '2026-11-10', currency: 'EUR' }], vra_data: [{ id: 900, report_id: 500, client_id: 1, asin: 'B0OLDAAA', period_start: '2026-11-01', period_end: '2026-11-10' }] };
    const o = run({ ...base, FAKE_DB: JSON.stringify(seed), FAKE_SLOW: JSON.stringify({ SA: { report: 1, polls: 130 } }) });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-800));
    assert.equal(o.db.vra_reports.filter((r) => r.client_id === 1 && r.period_start === '2026-11-01').length, 1, 'one running-month row, no duplicate report');
    assert.equal(novReport(o.db, 1).id, 500, 'the existing report row is reused');
    assert.equal(novReport(o.db, 1).period_end, '2026-11-24');
    assert.deepEqual(asinsOf(o.db, 1), ['B0SAD01', 'B0SAD15'], 'old ASIN gone, both new chunks present');
    const insertAt = o.reqs.findIndex((q) => q.method === 'POST' && q.url.includes('/rest/v1/vra_data') && (q.body || '').includes('B0SAD01'));
    const deleteAt = o.reqs.findIndex((q) => q.method === 'DELETE' && q.url.includes('/rest/v1/vra_data'));
    assert.ok(insertAt > -1 && deleteAt > -1 && insertAt < deleteAt, `insert (${insertAt}) must come before delete (${deleteAt})`);
  });

  // Review finding 2026-11-24 (round 3): nothing reached the error path of the re-check. A REAL failure there (database write, token) must still end the run
  // with exit code 1 (-> step row 'failed' -> Slack alert), must not stop the other clients, and must not leave a half-stored month.
  test('a REAL error while the re-check writes a client (database error): exit code 1, "FEHLER ... (Nachprüfung)" logged, the next client is still re-checked, nothing half-stored', () => {
    const o = run({ ...base, FAKE_FAIL_INSERT_BODY: 'B0SAD', FAKE_SLOW: JSON.stringify({ SA: { report: 1, polls: 130 }, SB: { report: 1, polls: 125 } }) });
    assert.equal(o.status, 1, o.stderr + o.stdout.slice(-800));
    assert.match(o.stdout, /FEHLER bei Alpha \(Nachprüfung\)/);
    assert.match(o.stdout, /Nachprüfung: 1 von 2/, 'Beta was still re-checked and stored');
    assert.deepEqual(asinsOf(o.db, 2), ['B0SBD01', 'B0SBD15']);
    assert.deepEqual(asinsOf(o.db, 1), [], 'a failed write must not leave a half-stored month');
    assert.equal(novReport(o.db, 1), undefined, 'the new report row is rolled back too');
    assert.match(o.stdout, /Fertig\./);
  });

  // The fake has a VIRTUAL CLOCK (the script's requested waits add up exactly). Timeline with two clients that both time out in the first pass: the first pass
  // ends at about 20 virtual minutes (2 x 10); re-checking a STUCK report (60 polls x 5 s) takes 5 more minutes, so the second client's turn comes at about 25.
  test('generous time settings (100 minutes) do not get in the way: both slow clients are re-checked', () => {
    const o = run({ ...base, VENDOR_RECHECK_BUDGET_MIN: '100', VENDOR_DEADLINE_MIN: '100', FAKE_SLOW: JSON.stringify({ SA: { report: 1, polls: 130 }, SB: { report: 1, polls: 125 } }) });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-800));
    assert.match(o.stdout, /Nachprüfung: 2 von 2/);
  });

  test('the deadline counts from the START OF THE SCRIPT (not from the start of the re-check): with 23 minutes the first client (turn at ~20 min) is re-checked, the second (turn at ~25 min) is skipped', () => {
    const o = run({ ...base, VENDOR_DEADLINE_MIN: '23', FAKE_SLOW: JSON.stringify({ SA: { report: 1, polls: 99999 }, SB: { report: 1, polls: 125 } }) });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-800));
    assert.match(o.stdout, /== Alpha ==/, 'Alpha is re-checked');
    assert.match(o.stdout, /Beta: Zeitgrenze für Nachprüfungen erreicht/, 'Beta is skipped because the script has already run ~25 minutes');
    assert.match(o.stdout, /Nachprüfung: 0 von 2/);
    assert.deepEqual(asinsOf(o.db, 2), [], 'Beta keeps its old state');
  });

  test('the re-check budget counts from the start of the re-check and is in MINUTES: with 4 minutes the first stuck client (5 min) is re-checked, the second is skipped', () => {
    const o = run({ ...base, VENDOR_RECHECK_BUDGET_MIN: '4', FAKE_SLOW: JSON.stringify({ SA: { report: 1, polls: 99999 }, SB: { report: 1, polls: 125 } }) });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-800));
    assert.match(o.stdout, /== Alpha ==/);
    assert.match(o.stdout, /Beta: Zeitbudget/);
    assert.ok(!/Alpha: Zeitbudget/.test(o.stdout), 'the first client must not be skipped (the budget starts counting at the re-check, not at the script start)');
  });

  // Review finding 2026-11-24 (two reviewers): the step has a hard 90-minute limit (`timeout`). With 6+ slow clients the first pass (10 min each) plus the
  // re-check would run into it, and a kill during a database write leaves partial rows. So the re-check must not START once the whole script has run
  // for VENDOR_DEADLINE_MIN (default 70 min), which leaves room for one client's re-check (at most about 12 minutes: 5 for the remembered report + 5 for a remaining chunk + titles/write).
  test('no re-check starts once the script has used its overall time (VENDOR_DEADLINE_MIN, default 70 min): remaining clients are skipped, logged, keep their old data, exit 0', () => {
    const o = run({ ...base, VENDOR_DEADLINE_MIN: '0', FAKE_SLOW: JSON.stringify({ SA: { report: 1, polls: 130 }, SB: { report: 1, polls: 125 } }) });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-800));
    assert.match(o.stdout, /Zeitgrenze für Nachprüfungen erreicht/);
    assert.match(o.stdout, /Nachprüfung: 0 von 2/);
    assert.match(o.stdout, /Laufender Monat: nicht nachgeprüft/, 'a client that was never re-checked must not be reported as a failed report');
    assert.ok(!/Laufender Monat: Report fehlgeschlagen/.test(o.stdout));
    assert.deepEqual(asinsOf(o.db, 1), []);
    assert.deepEqual(asinsOf(o.db, 2), []);
  });

  test('with the default deadline a normal slow night still gets its re-check (the deadline does not switch the feature off)', () => {
    const o = run({ ...base, FAKE_SLOW: JSON.stringify({ SA: { report: 1, polls: 130 } }) });
    assert.match(o.stdout, /Nachprüfung: 1 von 1/);
    assert.ok(!/Zeitgrenze für Nachprüfungen/.test(o.stdout));
  });

  // Round 4 (regression sweep): the old pollDoc returned null for "DONE without a document id" (-> report failed, no further request); the new code must too.
  test('a report that is DONE but has no document id fails at once (no request for a document "undefined", not deferred, exit 0)', () => {
    const o = run({ ...base, FAKE_DONE_NO_DOC: JSON.stringify({ SA: 1 }) });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-800));
    assert.match(o.stdout, /Laufender Monat: Report fehlgeschlagen/);
    assert.ok(!/Nachprüfung/.test(o.stdout));
    assert.ok(!o.reqs.some((q) => /\/documents\/undefined/.test(q.url)), 'no request for a document without an id');
    assert.deepEqual(asinsOf(o.db, 1), []);
    assert.deepEqual(asinsOf(o.db, 2), ['B0SBD01', 'B0SBD15']);
  });

  test('a report that Amazon marks FATAL is NOT remembered and NOT checked again (it can never finish)', () => {
    const o = run({ ...base, FAKE_FATAL: JSON.stringify({ SA: 1 }) });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-800));
    assert.match(o.stdout, /Laufender Monat: Report fehlgeschlagen/);
    assert.ok(!/Nachprüfung/.test(o.stdout), 'no re-check section for a FATAL report');
    assert.equal(polls(o.reqs, 'rep-1'), 1);
    assert.deepEqual(asinsOf(o.db, 1), []);
    assert.deepEqual(asinsOf(o.db, 2), ['B0SBD01', 'B0SBD15']);
  });
});
