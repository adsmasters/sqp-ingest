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
