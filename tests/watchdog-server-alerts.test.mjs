// watchdog.mjs wiring for server jobs (the pure logic is tested in server-job-alerts.test.mjs). Runs the REAL script on a fake network.
// Intended behaviour (written before the change, 2026-11-21):
//  - an unsent script alert row (kind 'alert') is posted to Slack verbatim, then marked as sent (PATCH sent_at) — and not before the post succeeded;
//  - an already sent alert is never posted again; when Slack fails the alert stays unsent (retried at the next run) and the run ends with exit 1;
//  - failing to READ the server_job_runs table is itself reported (never mistaken for "healthy");
//  - with nothing to report the run says "Alles gesund" and posts nothing.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SERVER_JOBS } from '../server-job-alerts.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
// These tests run the REAL watchdog with the REAL SERVER_JOBS list. Since the cutover (22 Nov 2026) that list holds the 8 night jobs, and a job
// without any row is reported once its grace period after `seit` is over — so, as time passes, a fake database with NO rows would (correctly) make the
// watchdog complain and these tests would fail only because of the date (a time bomb found on 24 Nov). The tests are about the wiring, not about the
// night jobs: every configured job gets a healthy recent success row, unless the test supplies its own run row for that job.
function withHealthyJobs(rowsJson) {
  const rows = JSON.parse(rowsJson || '[]');
  const own = new Set(rows.filter((r) => (r.kind || 'run') === 'run').map((r) => r.job));
  const healthy = Object.keys(SERVER_JOBS).filter((j) => !own.has(j)).map((job, i) => ({ id: 9000 + i, job, kind: 'run', result: 'success', exit_status: '0', host: 'srv', finished_at: new Date(Date.now() - 3600e3).toISOString(), detail: null, sent_at: null }));
  return JSON.stringify([...rows, ...healthy]);
}
function run(env = {}) {
  if (env.FAKE_SERVER_FAIL !== '1') env = { ...env, FAKE_SERVER_ROWS: withHealthyJobs(env.FAKE_SERVER_ROWS) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-'));
  const reqLog = path.join(dir, 'req.jsonl');
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(here, 'mock-net-watchdog.mjs')).href, path.join(root, 'watchdog.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 90000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SUPABASE_URL: 'https://fake-supabase.test', SUPABASE_SERVICE_KEY: 'fake-key', SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x', GITHUB_TOKEN: 'fake', GITHUB_REPOSITORY: 'adsmasters/sqp-ingest', REQ_LOG: reqLog, ...env },
  });
  const reqs = fs.existsSync(reqLog) ? fs.readFileSync(reqLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', reqs };
}
// The weekly "Wochen-Check" (alive message) is posted on Mondays 06:00-06:59 UTC (watchdog.mjs); it is not what these tests count, so it is ignored here —
// otherwise they would fail every Monday morning only because of the clock (found by a reviewer, 24 Nov 2026).
const slackPosts = (reqs) => reqs.filter((q) => q.method === 'POST' && q.url.startsWith('https://hooks.slack.test/') && !/Wochen-Check/.test(q.body || ''));
const patches = (reqs) => reqs.filter((q) => q.method === 'PATCH' && q.url.includes('server_job_runs'));
const alertRow = (id, over = {}) => ({ id, job: 'ads/periodic', kind: 'alert', result: null, exit_status: null, host: 'srv', finished_at: new Date(Date.now() - 3600e3).toISOString(), detail: 'ALERT-TEXT ' + id, sent_at: null, ...over });

describe('watchdog.mjs: server job alerts', () => {
  test('an unsent alert row is posted to Slack verbatim and then marked as sent', () => {
    const o = run({ FAKE_SERVER_ROWS: JSON.stringify([alertRow(7)]) });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-400));
    const posts = slackPosts(o.reqs);
    assert.equal(posts.length, 1);
    assert.equal(JSON.parse(posts[0].body).text, 'ALERT-TEXT 7');
    const p = patches(o.reqs);
    assert.equal(p.length, 1);
    assert.ok(p[0].url.includes('id=eq.7'));
    assert.ok(JSON.parse(p[0].body).sent_at, 'sent_at must be set');
    assert.ok(o.reqs.indexOf(posts[0]) < o.reqs.indexOf(p[0]), 'the Slack post comes BEFORE the mark');
  });

  test('an already sent alert is not posted again', () => {
    const o = run({ FAKE_SERVER_ROWS: JSON.stringify([alertRow(8, { sent_at: new Date().toISOString() })]) });
    assert.equal(o.status, 0, o.stderr);
    assert.equal(slackPosts(o.reqs).length, 0);
    assert.equal(patches(o.reqs).length, 0);
  });

  test('several unsent alerts are posted one by one, oldest first', () => {
    const rows = [alertRow(2, { finished_at: new Date(Date.now() - 1800e3).toISOString() }), alertRow(1, { finished_at: new Date(Date.now() - 7200e3).toISOString() })];
    const o = run({ FAKE_SERVER_ROWS: JSON.stringify(rows) });
    assert.equal(o.status, 0, o.stderr);
    assert.deepEqual(slackPosts(o.reqs).map((q) => JSON.parse(q.body).text), ['ALERT-TEXT 1', 'ALERT-TEXT 2']);
    assert.equal(patches(o.reqs).length, 2);
  });

  test('Slack fails: the alert is NOT marked as sent (retried next run) and the run ends with exit 1', () => {
    const o = run({ FAKE_SERVER_ROWS: JSON.stringify([alertRow(9)]), FAKE_SLACK_FAIL: '1' });
    assert.equal(o.status, 1);
    assert.equal(patches(o.reqs).length, 0);
  });

  test('without a Slack webhook the alert stays queued (logged, not marked)', () => {
    const o = run({ FAKE_SERVER_ROWS: JSON.stringify([alertRow(10)]), SLACK_WEBHOOK_URL: '' });
    assert.equal(o.status, 0, o.stderr);
    assert.equal(patches(o.reqs).length, 0);
    assert.match(o.stdout, /ALERT-TEXT 10/);
  });

  test('failing to read server_job_runs is reported as a problem, not mistaken for healthy', () => {
    const o = run({ FAKE_SERVER_FAIL: '1' });
    assert.equal(o.status, 0, o.stderr);
    const posts = slackPosts(o.reqs);
    assert.equal(posts.length, 1);
    assert.match(JSON.parse(posts[0].body).text, /Server-Job-Meldungen nicht lesbar/);
    assert.ok(!/Alles gesund/.test(o.stdout));
  });

  test('a failed run of a watched server job reaches Slack (job name and result), and the run is not "Alles gesund"', () => {
    const failedRun = { id: 5000, job: 'ads/refresh', kind: 'run', result: 'failed', exit_status: '134', host: 'srv', finished_at: new Date(Date.now() - 600e3).toISOString(), detail: null, sent_at: null };
    const o = run({ FAKE_SERVER_ROWS: JSON.stringify([failedRun]) });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-300));
    const posts = slackPosts(o.reqs);
    assert.equal(posts.length, 1);
    assert.match(JSON.parse(posts[0].body).text, /ads\/refresh.*failed|failed.*ads\/refresh/s);
    assert.ok(!/Alles gesund/.test(o.stdout));
  });

  test('nothing to report: "Alles gesund" and no Slack post', () => {
    const o = run({ FAKE_SERVER_ROWS: '[]' });
    assert.equal(o.status, 0, o.stderr + o.stdout.slice(-300));
    assert.match(o.stdout, /Alles gesund/);
    assert.equal(slackPosts(o.reqs).length, 0);
  });
});
