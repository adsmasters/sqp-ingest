// notify(): how a script raises its own alert (ads-periodic fail-open list, refresh summary).
// Intended behaviour (written before the code, 2026-11-21): where a Slack address exists (GitHub) it posts to Slack exactly as before; where none exists
// (the Hetzner server, by design no Slack secret) it stores the text as an 'alert' row in server_job_runs so the GitHub watchdog can forward it;
// with neither it only logs. It never throws and never hides a failure.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { notify } from '../notify.mjs';

const mkFetch = (impl) => { const calls = []; const f = async (url, opts = {}) => { calls.push({ url: String(url), opts }); return impl(String(url), opts); }; f.calls = calls; return f; };
const ok = () => new Response(null, { status: 201 });
const silent = () => {};
const ENV_SERVER = { SUPABASE_URL: 'https://fake-supabase.test', SUPABASE_SERVICE_KEY: 'fake-key' };

describe('notify', () => {
  test('with a Slack webhook it posts the text to Slack and nothing else', async () => {
    const f = mkFetch(ok);
    const r = await notify({ text: 'Hallo', job: 'ads/periodic', env: { ...ENV_SERVER, SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' }, fetchImpl: f, log: silent });
    assert.equal(r, 'slack');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, 'https://hooks.slack.test/x');
    assert.deepEqual(JSON.parse(f.calls[0].opts.body), { text: 'Hallo' });
  });
  test('without a webhook (server) it stores an alert row in server_job_runs', async () => {
    const f = mkFetch(ok);
    const r = await notify({ text: 'Fail-Open: Kunde X', job: 'ads/periodic', env: ENV_SERVER, fetchImpl: f, log: silent });
    assert.equal(r, 'queued');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, 'https://fake-supabase.test/rest/v1/server_job_runs');
    assert.equal(f.calls[0].opts.method, 'POST');
    const body = JSON.parse(f.calls[0].opts.body);
    assert.equal(body.job, 'ads/periodic');
    assert.equal(body.kind, 'alert');
    assert.equal(body.detail, 'Fail-Open: Kunde X');
    assert.equal(f.calls[0].opts.headers.apikey, 'fake-key');
  });
  test('with neither webhook nor database access it only logs', async () => {
    const f = mkFetch(ok);
    const r = await notify({ text: 'x', job: 'j', env: {}, fetchImpl: f, log: silent });
    assert.equal(r, 'log-only');
    assert.equal(f.calls.length, 0);
  });
  test('Slack answers an error: it is logged and reported, nothing is thrown', async () => {
    const logs = [];
    const f = mkFetch(() => new Response('no', { status: 500 }));
    const r = await notify({ text: 'x', job: 'j', env: { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' }, fetchImpl: f, log: (m) => logs.push(m) });
    assert.equal(r, 'slack-failed');
    assert.ok(logs.join(' ').includes('500'));
  });
  test('the database insert fails (HTTP error or network error): logged, nothing thrown', async () => {
    const f1 = mkFetch(() => new Response('bad', { status: 400 }));
    assert.equal(await notify({ text: 'x', job: 'j', env: ENV_SERVER, fetchImpl: f1, log: silent }), 'queue-failed');
    const f2 = mkFetch(() => { throw new Error('network down'); });
    assert.equal(await notify({ text: 'x', job: 'j', env: ENV_SERVER, fetchImpl: f2, log: silent }), 'queue-failed');
  });
  test('an empty text sends nothing', async () => {
    const f = mkFetch(ok);
    assert.equal(await notify({ text: '', job: 'j', env: ENV_SERVER, fetchImpl: f, log: silent }), 'nothing-to-send');
    assert.equal(f.calls.length, 0);
  });
  test('a very long text is shortened before it is stored', async () => {
    const f = mkFetch(ok);
    await notify({ text: 'x'.repeat(50000), job: 'j', env: ENV_SERVER, fetchImpl: f, log: silent });
    assert.ok(JSON.parse(f.calls[0].opts.body).detail.length <= 8000);
  });
});
