// Test-only preload (node --import) for watchdog.mjs: an in-memory FAKE of GitHub's API, Supabase and Slack. NOTHING here can reach the network;
// every request is answered locally. Every request is appended to the file in env REQ_LOG as one JSON line {method,url,body?}.
// Switches: FAKE_SERVER_ROWS (JSON array returned for server_job_runs), FAKE_SERVER_FAIL=1 (that read answers HTTP 500), FAKE_SLACK_FAIL=1 (Slack answers HTTP 500).
import fs from 'node:fs';

const LOG = process.env.REQ_LOG;
const SB = process.env.SUPABASE_URL;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
const nowIso = new Date().toISOString();

globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  if (LOG) fs.appendFileSync(LOG, JSON.stringify({ method, url, body: typeof opts.body === 'string' ? opts.body.slice(0, 4000) : undefined }) + '\n');

  if (url.startsWith('https://api.github.com/repos/')) return json({ workflow_runs: [{ conclusion: 'success', status: 'completed', updated_at: nowIso }] }); // every workflow healthy
  if (url.startsWith('https://hooks.slack.test/')) return process.env.FAKE_SLACK_FAIL === '1' ? new Response('no', { status: 500 }) : new Response('ok', { status: 200 });

  if (url.startsWith(SB + '/rest/v1/server_job_runs')) {
    if (method === 'GET') return process.env.FAKE_SERVER_FAIL === '1' ? json({ message: 'down' }, 500) : json(JSON.parse(process.env.FAKE_SERVER_ROWS || '[]'));
    if (method === 'PATCH') return new Response(null, { status: 204 });
  }
  if (url.startsWith(SB + '/rest/v1/worker_heartbeat')) return json([{ ts: nowIso, host: 'fake-host' }]); // worker alive, cycle fresh
  if (url.startsWith(SB + '/rest/v1/watchdog_state')) return method === 'GET' ? json([]) : new Response(null, { status: 204 });
  if (url.startsWith(SB + '/rest/v1/') && method === 'GET') return json([]); // clients, queue, freshness, dashboard ...: empty = nothing to report
  throw new Error(`mock-net-watchdog: unmocked request ${method} ${url}`);
};
