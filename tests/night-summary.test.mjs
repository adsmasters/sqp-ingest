// night-summary.mjs: the LAST step ("night/chain") of the server night chain. systemd shows the whole chain as "success" even when a step failed
// (the steps run with ExecStart=- so one failure does not stop the next), so this step looks at what the real steps reported tonight and
// makes the chain's own result tell the truth. Intended behaviour (written before the code, 2026-11-22):
//  - it judges the 7 real night steps (vendor/sales, vendor/ads, daily-data/sales-traffic, ads/refresh, audit-terms, daily-data/audit, ads/periodic)
//    by their LATEST row (kind 'run') within the last 14 hours (the chain starts 18:00 UTC and ends ~01:30 UTC; older rows belong to an earlier night);
//  - all 7 'success' -> exit code 0 and a one-line summary "7 von 7 Schritten erfolgreich";
//  - any step with result failed / killed / timeout / skipped, or with NO row in the window -> exit code 1 and ONE line that names every
//    problem step with its result (and exit code) — names jobs only, never log details or client names;
//  - the marker itself, unknown jobs and 'alert' rows are ignored; a later success of a step clears an earlier failure of the same step;
//  - if the rows cannot be read (database down, missing environment), the step must NOT claim success: exit code 1 and a clear message;
//  - reads are retried (network error / 5xx / 429 only), never throw;
//  - the list of steps it judges is exactly the list of real steps in sqp-night.service (a guard against forgetting one after a change).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NIGHT_STEPS, summarizeNight, runSummary } from '../night-summary.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse('2026-11-23T01:30:00Z');
const H = 3600e3;
const ago = (h) => new Date(NOW - h * H).toISOString();
const row = (job, result, hoursAgo, extra = {}) => ({ job, kind: 'run', result, exit_status: result === 'success' ? '0' : '1', finished_at: ago(hoursAgo), detail: 'SECRET-CLIENT-NAME', ...extra });
const allOk = () => NIGHT_STEPS.map((j, i) => row(j, 'success', 7 - i));

describe('summarizeNight', () => {
  test('all 7 steps succeeded: ok, one line "7 von 7"', () => {
    const r = summarizeNight(allOk(), { now: NOW });
    assert.equal(r.ok, true);
    assert.match(r.text, /7 von 7/);
    assert.deepEqual(r.problems, []);
  });
  test('a failed step: not ok, the line names the step, the result and the exit code, and only that step', () => {
    const rows = allOk().map((x) => (x.job === 'ads/refresh' ? { ...x, result: 'failed', exit_status: '134' } : x));
    const r = summarizeNight(rows, { now: NOW });
    assert.equal(r.ok, false);
    assert.match(r.text, /ads\/refresh/);
    assert.match(r.text, /failed/);
    assert.match(r.text, /134/);
    assert.match(r.text, /6 von 7/);
    assert.ok(!/vendor\/sales/.test(r.text), 'healthy steps are not listed');
  });
  test('killed, timeout and skipped steps count as problems with their result in the text', () => {
    const swap = (job, result, exit) => allOk().map((x) => (x.job === job ? { ...x, result, exit_status: exit } : x));
    assert.match(summarizeNight(swap('audit-terms', 'killed', '137'), { now: NOW }).text, /audit-terms.*killed/);
    assert.match(summarizeNight(swap('daily-data/audit', 'timeout', '124'), { now: NOW }).text, /daily-data\/audit.*timeout/);
    const sk = summarizeNight(swap('ads/periodic', 'skipped', '99'), { now: NOW });
    assert.equal(sk.ok, false);
    assert.match(sk.text, /ads\/periodic.*skipped/);
  });
  test('a step with NO row in the window is a problem ("kein Lauf gemeldet")', () => {
    const rows = allOk().filter((x) => x.job !== 'vendor/ads');
    const r = summarizeNight(rows, { now: NOW });
    assert.equal(r.ok, false);
    assert.match(r.text, /vendor\/ads.*kein Lauf gemeldet/);
  });
  test('a success from an EARLIER night (older than 14 h) does not count for tonight', () => {
    const rows = allOk().map((x) => (x.job === 'vendor/sales' ? { ...x, finished_at: ago(24) } : x));
    const r = summarizeNight(rows, { now: NOW });
    assert.equal(r.ok, false);
    assert.match(r.text, /vendor\/sales.*kein Lauf gemeldet/);
  });
  test('the LATEST row of a step decides: failure then a newer success is fine, success then a newer failure is not', () => {
    const fixed = [...allOk(), row('ads/refresh', 'failed', 9)]; // older failure, success is newer (ads/refresh success is 4 h ago)
    assert.equal(summarizeNight(fixed, { now: NOW }).ok, true);
    const broken = [...allOk(), row('ads/refresh', 'failed', 0.5)];
    assert.equal(summarizeNight(broken, { now: NOW }).ok, false);
  });
  test('several problems are listed in ONE line, in the order of the chain', () => {
    const rows = allOk().filter((x) => x.job !== 'ads/refresh').map((x) => (x.job === 'vendor/ads' ? { ...x, result: 'failed' } : x));
    const r = summarizeNight(rows, { now: NOW });
    assert.equal(r.text.split('\n').length, 1, 'one line');
    assert.ok(r.text.indexOf('vendor/ads') < r.text.indexOf('ads/refresh'));
    assert.match(r.text, /5 von 7/);
  });
  test('the marker itself, unknown jobs and alert rows are ignored', () => {
    const extra = [row('night/chain', 'failed', 0.1), row('something/else', 'failed', 1), { job: 'ads/refresh', kind: 'alert', result: null, finished_at: ago(0.2), detail: 'x' }];
    assert.equal(summarizeNight([...allOk(), ...extra], { now: NOW }).ok, true);
  });
  test('never prints log details or client names', () => {
    const rows = allOk().map((x) => (x.job === 'ads/refresh' ? { ...x, result: 'failed' } : x));
    assert.ok(!summarizeNight(rows, { now: NOW }).text.includes('SECRET-CLIENT-NAME'));
  });
});

describe('NIGHT_STEPS stays in sync with sqp-night.service', () => {
  test('exactly the real steps of the unit (all ExecStart jobs except the marker night/chain), in the same order', () => {
    const unit = fs.readFileSync(path.join(here, '..', 'deploy', 'systemd', 'sqp-night.service'), 'utf8');
    const jobs = [...unit.matchAll(/^ExecStart=-\/usr\/bin\/bash\s+\S+\s+(\S+)\s+\d+\s+/gm)].map((m) => m[1]).filter((j) => j !== 'night/chain');
    assert.deepEqual(NIGHT_STEPS, jobs);
  });
});

describe('runSummary (reads the rows, never throws)', () => {
  const env = { SUPABASE_URL: 'https://fake-supabase.test', SUPABASE_SERVICE_KEY: 'fake-key' };
  const noWait = async () => {};
  const server = (rowsOrStatuses, calls = []) => async (url, opts) => {
    calls.push({ url: String(url), opts });
    const a = Array.isArray(rowsOrStatuses) && typeof rowsOrStatuses[0] === 'number' ? rowsOrStatuses[Math.min(calls.length - 1, rowsOrStatuses.length - 1)] : 200;
    if (a instanceof Error) throw a;
    if (a !== 200) return new Response('no', { status: a });
    return new Response(JSON.stringify(rowsOrStatuses), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  test('all steps fine: exit code 0, summary text', async () => {
    const r = await runSummary({ env, fetchImpl: server(allOk()), now: NOW, sleepImpl: noWait, log: () => {} });
    assert.equal(r.code, 0);
    assert.match(r.text, /7 von 7/);
  });
  test('a failed step: exit code 1 and the problem step in the text', async () => {
    const rows = allOk().map((x) => (x.job === 'audit-terms' ? { ...x, result: 'failed' } : x));
    const r = await runSummary({ env, fetchImpl: server(rows), now: NOW, sleepImpl: noWait, log: () => {} });
    assert.equal(r.code, 1);
    assert.match(r.text, /audit-terms/);
  });
  test('the request reads only run rows of the 7 steps since 14 h ago, with the service key', async () => {
    const calls = [];
    await runSummary({ env, fetchImpl: server(allOk(), calls), now: NOW, sleepImpl: noWait, log: () => {} });
    const u = new URL(calls[0].url);
    assert.equal(u.origin + u.pathname, 'https://fake-supabase.test/rest/v1/server_job_runs');
    assert.equal(u.searchParams.get('kind'), 'eq.run');
    assert.equal(u.searchParams.get('job'), 'in.(' + NIGHT_STEPS.join(',') + ')');
    assert.equal(u.searchParams.get('finished_at'), 'gte.' + new Date(NOW - 14 * H).toISOString());
    assert.equal(calls[0].opts.headers.apikey, 'fake-key');
  });
  test('a temporary database error is retried (5xx, 429, network error) and then succeeds', async () => {
    const calls = [];
    const f = async (url, opts) => { calls.push(1); if (calls.length === 1) return new Response('x', { status: 503 }); if (calls.length === 2) throw new Error('network down'); return new Response(JSON.stringify(allOk()), { status: 200 }); };
    const r = await runSummary({ env, fetchImpl: f, now: NOW, sleepImpl: noWait, log: () => {} });
    assert.equal(r.code, 0);
    assert.equal(calls.length, 3);
  });
  test('rows that cannot be read must NOT be reported as success: exit code 1 and a clear message', async () => {
    const r = await runSummary({ env, fetchImpl: server([500]), now: NOW, sleepImpl: noWait, log: () => {} });
    assert.equal(r.code, 1);
    assert.match(r.text, /nicht lesbar/);
  });
  test('a permanent client error (401) is not retried', async () => {
    const calls = [];
    const r = await runSummary({ env, fetchImpl: server([401], calls), now: NOW, sleepImpl: noWait, log: () => {} });
    assert.equal(r.code, 1);
    assert.equal(calls.length, 1);
  });
  test('missing environment: exit code 1, no request at all', async () => {
    const calls = [];
    const r = await runSummary({ env: {}, fetchImpl: server(allOk(), calls), now: NOW, sleepImpl: noWait, log: () => {} });
    assert.equal(r.code, 1);
    assert.equal(calls.length, 0);
  });
});
