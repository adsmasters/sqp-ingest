// Alerts for jobs that run on the Hetzner server (no Slack secret there): every finished job writes one row to server_job_runs
// ({job, kind:'run', result, exit_status, finished_at}); the GitHub watchdog turns those rows into Slack messages.
// Intended behaviour, written BEFORE the code (2026-11-21):
//  - a healthy job (recent success) raises nothing;
//  - the LATEST run decides: a failure/timeout/kill raises one message naming the job and result; a later success clears it;
//  - a job that should have reported but never did (no rows after its grace period, or no success within its deadline) raises a message;
//  - rows of jobs that are not configured are ignored; 'alert' rows are never mistaken for runs;
//  - the messages are generic (job, result, time) — never the log detail or client names;
//  - unsent script-own alert rows (kind 'alert') are handed over in order so the watchdog can forward and mark them.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serverJobIssues, unsentAlerts, SERVER_JOBS } from '../server-job-alerts.mjs';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const H = 3600e3;
const ago = (h) => new Date(NOW - h * H).toISOString();
const run = (job, result, hoursAgo, extra = {}) => ({ id: Math.round(Math.random() * 1e9), job, kind: 'run', result, exit_status: result === 'success' ? '0' : '1', finished_at: ago(hoursAgo), detail: 'SECRET-CLIENT-NAME crashed', sent_at: null, ...extra });
const CONFIG = { 'vendor/sales': { fristH: 30, seit: '2026-11-20T00:00:00Z' } };

describe('serverJobIssues', () => {
  test('a recent success raises nothing', () => {
    assert.deepEqual(serverJobIssues([run('vendor/sales', 'success', 10)], NOW, CONFIG), []);
  });
  test('the latest run failed: one message naming the job, the result and the exit code', () => {
    const out = serverJobIssues([run('vendor/sales', 'failed', 2), run('vendor/sales', 'success', 26)], NOW, CONFIG);
    assert.equal(out.length, 1);
    assert.match(out[0], /vendor\/sales/);
    assert.match(out[0], /failed/);
    assert.match(out[0], /exit 1/);
  });
  test('a failure followed by a newer success is cleared', () => {
    assert.deepEqual(serverJobIssues([run('vendor/sales', 'success', 1), run('vendor/sales', 'failed', 25)], NOW, CONFIG), []);
  });
  test('a timeout and a kill are reported as such', () => {
    assert.match(serverJobIssues([run('vendor/sales', 'timeout', 2)], NOW, CONFIG)[0], /timeout/);
    assert.match(serverJobIssues([run('vendor/sales', 'killed', 2)], NOW, CONFIG)[0], /killed/);
  });
  test('a step skipped by the night guard is reported in plain words (night window was over)', () => {
    const out = serverJobIssues([run('vendor/sales', 'skipped', 2, { exit_status: '99' })], NOW, CONFIG);
    assert.equal(out.length, 1);
    assert.match(out[0], /vendor\/sales/);
    assert.match(out[0], /Nachtfenster/);
  });
  test('no rows yet, still inside the grace period after activation: nothing', () => {
    const cfg = { 'vendor/sales': { fristH: 30, seit: new Date(NOW - 10 * H).toISOString() } };
    assert.deepEqual(serverJobIssues([], NOW, cfg), []);
  });
  test('no rows at all after the grace period: one message that names the job and the activation date', () => {
    const out = serverJobIssues([], NOW, CONFIG);
    assert.equal(out.length, 1);
    assert.match(out[0], /vendor\/sales/);
    assert.match(out[0], /2026-11-20/);
  });
  test('only a success older than the deadline: "no successful run" message', () => {
    const out = serverJobIssues([run('vendor/sales', 'success', 40)], NOW, CONFIG);
    assert.equal(out.length, 1);
    assert.match(out[0], /kein erfolgreicher Lauf/);
  });
  test('a weekly job (8 day deadline) with a success 5 days ago is fine', () => {
    const cfg = { 'refresh/refresh': { fristH: 192, seit: '2026-11-01T00:00:00Z' } };
    assert.deepEqual(serverJobIssues([run('refresh/refresh', 'success', 5 * 24)], NOW, cfg), []);
  });
  test('rows of jobs that are not configured are ignored', () => {
    assert.deepEqual(serverJobIssues([run('something/else', 'failed', 1)], NOW, CONFIG).filter((x) => /something/.test(x)), []);
  });
  test("an 'alert' row is never treated as a run (a newer alert row must not hide or fake a run)", () => {
    const alertRow = { id: 5, job: 'vendor/sales', kind: 'alert', result: null, finished_at: ago(1), detail: 'text', sent_at: null };
    assert.deepEqual(serverJobIssues([run('vendor/sales', 'success', 10), alertRow], NOW, CONFIG), []);
  });
  test('the messages are generic: the log detail (client names etc.) never appears', () => {
    const out = serverJobIssues([run('vendor/sales', 'failed', 2)], NOW, CONFIG);
    assert.ok(!out.join('').includes('SECRET-CLIENT-NAME'));
  });
  test('several configured jobs are judged independently', () => {
    const cfg = { a: { fristH: 30, seit: '2026-11-01T00:00:00Z' }, b: { fristH: 30, seit: '2026-11-01T00:00:00Z' } };
    const out = serverJobIssues([run('a', 'success', 3), run('b', 'failed', 3)], NOW, cfg);
    assert.equal(out.length, 1);
    assert.match(out[0], /^b|\bb\b/);
  });
});

// Review finding 2026-11-22: rows written BEFORE a job's activation date (`seit`) are manual tests / retests from the days before the cutover.
// They must not count at all: an old test success must not trigger "no successful run in 27h" before the first real night, and an old test failure
// must not raise an alert. With this the cutover commit can be pushed at ANY time of day (no race against the 17:30 UTC watchdog run).
describe('rows older than the activation date (seit) are ignored', () => {
  const SEIT = new Date(NOW + 6 * H).toISOString(); // activation tonight, 6 hours from NOW
  const cfg = { 'vendor/sales': { fristH: 27, seit: SEIT } };
  test('an old test success (31 h old, before seit) does NOT raise "no successful run" before the first night', () => {
    assert.deepEqual(serverJobIssues([run('vendor/sales', 'success', 31)], NOW, cfg), []);
  });
  test('an old test failure before seit is ignored (no alert for a retest that happened before the cutover)', () => {
    assert.deepEqual(serverJobIssues([run('vendor/sales', 'failed', 20)], NOW, cfg), []);
  });
  test('when the grace period after seit is over and only pre-seit rows exist, the job counts as "never reported"', () => {
    const late = Date.parse(SEIT) + 28 * H;
    const out = serverJobIssues([run('vendor/sales', 'success', 31)], late, cfg);
    assert.equal(out.length, 1);
    assert.match(out[0], /noch kein Lauf/);
  });
  test('a row AFTER seit counts normally (a failure raises, a later success clears it)', () => {
    const after = Date.parse(SEIT) + 10 * H, finished = (h) => new Date(after - h * H).toISOString();
    const f = { id: 1, job: 'vendor/sales', kind: 'run', result: 'failed', exit_status: '1', finished_at: finished(2) };
    const s = { id: 2, job: 'vendor/sales', kind: 'run', result: 'success', exit_status: '0', finished_at: finished(1) };
    assert.equal(serverJobIssues([f], after, cfg).length, 1);
    assert.deepEqual(serverJobIssues([f, s], after, cfg), []);
  });
  test('a row exactly at seit counts (the boundary belongs to the new period)', () => {
    const r = { id: 3, job: 'vendor/sales', kind: 'run', result: 'success', exit_status: '0', finished_at: SEIT };
    assert.deepEqual(serverJobIssues([r], Date.parse(SEIT) + 3 * H, cfg), []);
  });
});

// Review finding 2026-11-22: a night chain that never starts (timer forgotten / enabled too late) was noticed only ~29 h after its planned start,
// because the "never reported" wait was seit + fristH (26-29 h). Optional per-job `graceH` = how long to wait after `seit` for the FIRST row;
// the night jobs use 12 h so the 06:30 UTC watchdog run of the next morning catches it. Without graceH the old rule (fristH) applies.
describe('graceH: how long to wait for the first row after seit', () => {
  const SEIT = Date.parse('2026-11-22T18:00:00Z');
  const cfg = { 'vendor/sales': { fristH: 27, graceH: 12, seit: '2026-11-22T18:00:00Z' } };
  test('no row, 11 h after seit: still waiting (the chain may be running), nothing', () => {
    assert.deepEqual(serverJobIssues([], SEIT + 11 * H, cfg), []);
  });
  test('no row, 12.5 h after seit (the 06:30 UTC run): one message naming the job, although fristH is 27 h', () => {
    const out = serverJobIssues([], SEIT + 12.5 * H, cfg);
    assert.equal(out.length, 1);
    assert.match(out[0], /vendor\/sales/);
    assert.match(out[0], /noch kein Lauf/);
  });
  test('without graceH the wait is still fristH (old behaviour)', () => {
    const c = { 'vendor/sales': { fristH: 27, seit: '2026-11-22T18:00:00Z' } };
    assert.deepEqual(serverJobIssues([], SEIT + 20 * H, c), []);
    assert.equal(serverJobIssues([], SEIT + 28 * H, c).length, 1);
  });
  test('graceH only matters while there is NO row: a row after seit is judged by fristH as before', () => {
    const r = { id: 1, job: 'vendor/sales', kind: 'run', result: 'success', exit_status: '0', finished_at: new Date(SEIT + 1 * H).toISOString() };
    assert.deepEqual(serverJobIssues([r], SEIT + 20 * H, cfg), []); // 19 h old < 27 h
    assert.equal(serverJobIssues([r], SEIT + 30 * H, cfg).length, 1); // 29 h old > 27 h
  });
  test('a healthy first night raises nothing at the three watchdog runs (23:30 UTC, 06:30 UTC) when all rows are there', () => {
    const night = { 'vendor/sales': { fristH: 27, graceH: 12, seit: '2026-11-22T18:00:00Z' }, 'ads/periodic': { fristH: 26, graceH: 12, seit: '2026-11-22T18:00:00Z' } };
    const rows = [
      { id: 1, job: 'vendor/sales', kind: 'run', result: 'success', exit_status: '0', finished_at: '2026-11-22T18:16:00Z' },
      { id: 2, job: 'ads/periodic', kind: 'run', result: 'success', exit_status: '0', finished_at: '2026-11-23T01:24:00Z' },
    ];
    assert.deepEqual(serverJobIssues(rows.slice(0, 1), Date.parse('2026-11-22T23:30:00Z'), night), []); // ads/periodic not yet due at 23:30
    assert.deepEqual(serverJobIssues(rows, Date.parse('2026-11-23T06:30:00Z'), night), []);
  });
  test('the planned night values are accepted: graceH is a positive number when present', () => {
    for (const [name, c] of Object.entries(SERVER_JOBS)) if ('graceH' in c) assert.ok(c.graceH > 0, name + ' graceH');
  });
});

describe('unsentAlerts', () => {
  const alert = (id, hoursAgo, sent = null) => ({ id, job: 'ads/periodic', kind: 'alert', result: null, finished_at: ago(hoursAgo), detail: 'Alert text ' + id, sent_at: sent });
  test('returns only unsent alert rows, oldest first, as {id, text}', () => {
    const out = unsentAlerts([alert(2, 1), alert(1, 5), alert(3, 2, ago(1)), run('ads/refresh', 'failed', 1)]);
    assert.deepEqual(out, [{ id: 1, text: 'Alert text 1' }, { id: 2, text: 'Alert text 2' }]);
  });
  test('an alert without text is skipped', () => {
    assert.deepEqual(unsentAlerts([{ id: 9, kind: 'alert', detail: '', finished_at: ago(1), sent_at: null }]), []);
  });
});

describe('SERVER_JOBS configuration', () => {
  test('every configured job has a positive deadline and a valid activation date', () => {
    for (const [name, c] of Object.entries(SERVER_JOBS)) {
      assert.ok(c.fristH > 0, name + ' fristH');
      assert.ok(!Number.isNaN(Date.parse(c.seit)), name + ' seit');
    }
  });
});
