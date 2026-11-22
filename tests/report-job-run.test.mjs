// report-job-run.mjs: the small program the server wrapper calls after every job step, to write ONE row into server_job_runs.
// Intended behaviour (written before the code, 2026-11-21): exit 0 = success, 124 (the `timeout` tool) = timeout, 137/143 (SIGKILL/SIGTERM, e.g. out of memory)
// = killed, anything else (or an unreadable code) = failed; the row carries job, kind 'run', result, exit status, host, a shortened log tail and a time.
// Reporting must never break the job: a failed POST is logged, the program still ends normally.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runResult, buildRunRow, reportRun } from '../report-job-run.mjs';

describe('runResult', () => {
  test('maps exit codes to results', () => {
    assert.equal(runResult(0), 'success');
    assert.equal(runResult('0'), 'success');
    assert.equal(runResult(124), 'timeout');
    assert.equal(runResult(137), 'killed');
    assert.equal(runResult(143), 'killed');
    assert.equal(runResult(99), 'skipped'); // step skipped by the night guard (would have started after the cut-off)
    assert.equal(runResult(1), 'failed');
    assert.equal(runResult(2), 'failed');
    assert.equal(runResult('abc'), 'failed');
    assert.equal(runResult(undefined), 'failed');
  });
});

describe('buildRunRow', () => {
  test('builds the row with job, kind, result, exit status, host and time', () => {
    const now = new Date('2026-11-21T10:00:00Z');
    const row = buildRunRow({ job: 'vendor/ads', exitCode: 124, host: 'srv', detail: 'last lines', now });
    assert.deepEqual(row, { job: 'vendor/ads', kind: 'run', result: 'timeout', exit_status: '124', host: 'srv', detail: 'last lines', finished_at: '2026-11-21T10:00:00.000Z' });
  });
  test('shortens a long log tail', () => {
    const row = buildRunRow({ job: 'j', exitCode: 1, host: 'h', detail: 'y'.repeat(9000), now: new Date() });
    assert.ok(row.detail.length <= 1500);
  });
  test('an empty detail is stored as null, not as an empty string', () => {
    assert.equal(buildRunRow({ job: 'j', exitCode: 0, host: 'h', detail: '', now: new Date() }).detail, null);
  });
});

describe('reportRun', () => {
  const env = { SUPABASE_URL: 'https://fake-supabase.test', SUPABASE_SERVICE_KEY: 'fake-key' };
  test('POSTs the row to server_job_runs with the service key', async () => {
    const calls = [];
    const f = async (url, opts) => { calls.push({ url: String(url), opts }); return new Response(null, { status: 201 }); };
    const r = await reportRun({ job: 'ads/refresh', exitCode: 0, detail: 'ok', env, fetchImpl: f, host: 'srv', log: () => {} });
    assert.equal(r, true);
    assert.equal(calls[0].url, 'https://fake-supabase.test/rest/v1/server_job_runs');
    assert.equal(JSON.parse(calls[0].opts.body).result, 'success');
    assert.equal(calls[0].opts.headers.apikey, 'fake-key');
  });
  const noWait = async () => {}; // tests must not really sleep between attempts
  test('a failed POST or missing env is logged and returns false, it never throws', async () => {
    const f = async () => new Response('no', { status: 500 });
    assert.equal(await reportRun({ job: 'j', exitCode: 1, detail: '', env, fetchImpl: f, host: 'h', log: () => {}, sleepImpl: noWait }), false);
    assert.equal(await reportRun({ job: 'j', exitCode: 1, detail: '', env: {}, fetchImpl: f, host: 'h', log: () => {}, sleepImpl: noWait }), false);
    const g = async () => { throw new Error('down'); };
    assert.equal(await reportRun({ job: 'j', exitCode: 1, detail: '', env, fetchImpl: g, host: 'h', log: () => {}, sleepImpl: noWait }), false);
  });
  // Review finding 2026-11-21: a step ends exactly when the shared database is most likely overloaded; one failed POST must not lose the result.
  const seq = (...answers) => { const calls = []; const f = async (u, o) => { calls.push(u); const a = answers[Math.min(calls.length - 1, answers.length - 1)]; if (a instanceof Error) throw a; return new Response(null, { status: a }); }; f.calls = calls; return f; };
  test('a temporary database error (HTTP 500) is retried and the row is finally written', async () => {
    const f = seq(500, 500, 201);
    assert.equal(await reportRun({ job: 'j', exitCode: 0, detail: '', env, fetchImpl: f, host: 'h', log: () => {}, sleepImpl: noWait }), true);
    assert.equal(f.calls.length, 3);
  });
  test('a network error and a rate limit (429) are retried too', async () => {
    const f1 = seq(new Error('network down'), 201);
    assert.equal(await reportRun({ job: 'j', exitCode: 0, detail: '', env, fetchImpl: f1, host: 'h', log: () => {}, sleepImpl: noWait }), true);
    const f2 = seq(429, 201);
    assert.equal(await reportRun({ job: 'j', exitCode: 0, detail: '', env, fetchImpl: f2, host: 'h', log: () => {}, sleepImpl: noWait }), true);
    assert.equal(f1.calls.length + f2.calls.length, 4);
  });
  test('it gives up after 3 attempts when the error stays', async () => {
    const f = seq(500);
    assert.equal(await reportRun({ job: 'j', exitCode: 1, detail: '', env, fetchImpl: f, host: 'h', log: () => {}, sleepImpl: noWait }), false);
    assert.equal(f.calls.length, 3);
  });
  test('a permanent client error (HTTP 400/401/403/404) is NOT retried (it would never succeed)', async () => {
    for (const status of [400, 401, 403, 404]) {
      const f = seq(status);
      assert.equal(await reportRun({ job: 'j', exitCode: 1, detail: '', env, fetchImpl: f, host: 'h', log: () => {}, sleepImpl: noWait }), false, 'status ' + status);
      assert.equal(f.calls.length, 1, 'status ' + status + ' must not be retried');
    }
  });
});
