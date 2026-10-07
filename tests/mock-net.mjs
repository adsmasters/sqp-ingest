// Test-only preload (node --import): replaces the network of audit-refresh.mjs with an in-memory fake and speeds timers up 1000x.
// NOTHING here can reach Amazon or Supabase: every request is answered locally and any unknown URL THROWS.
// Every request is appended to the file in env REQ_LOG as one JSON line {method,url,t}.
import fs from 'node:fs';
import zlib from 'node:zlib';

const LOG = process.env.REQ_LOG;
const SB = process.env.SUPABASE_URL;
const T0 = Date.now();

// sleeps of 3 s / 20 s / 45 s become 3 / 20 / 45 ms
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.ceil((+ms || 0) / 1000), ...a);

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
let reportN = 0;
const listHits = {}, pageHits = {};
const clients = JSON.parse(process.env.FAKE_CLIENTS || '[]');
const ages = JSON.parse(process.env.FAKE_AGES || '{}'); // profile_id -> updated_at
const extraCached = JSON.parse(process.env.FAKE_EXTRA_CACHED || '[]');

globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  if (LOG) fs.appendFileSync(LOG, JSON.stringify({ method, url, t: Date.now() - T0, body: method !== 'GET' && typeof opts.body === 'string' ? opts.body.slice(0, 400) : undefined }) + '\n');

  if (url === 'https://api.amazon.co.uk/auth/o2/token') return json({ access_token: 'FAKE-TOKEN', expires_in: 3600 });

  if (url.startsWith(SB + '/rest/v1/sqp_clients')) return json(clients);
  if (url.startsWith(SB + '/rest/v1/ads_audit_cache')) {
    if (method === 'POST') return new Response(null, { status: 201 });
    if (url.includes('select=profile_id,updated_at') && process.env.FAKE_AGE_FAIL === '1') return json({ message: 'down' }, 500); // scenario: the age query fails
    if (url.includes('select=profile_id,updated_at')) return json(Object.entries(ages).map(([profile_id, updated_at]) => ({ profile_id, updated_at })));
    if (url.includes('select=profile_id') && url.includes('updated_at=gte')) return json(extraCached.map((profile_id) => ({ profile_id })));
    // scenario: a good row for this profile appeared AFTER the age query (race with the live page)
    if (url.includes('select=payload') && process.env.FAKE_ROW_PROFILE && url.includes('profile_id=eq.' + process.env.FAKE_ROW_PROFILE + '&')) return json([{ payload: { b2b: { available: true, rows: [] } } }]);
    if (url.includes('select=payload')) return json([]);
  }

  if (url.startsWith('https://advertising-api-eu.amazon.com')) {
    const p = url.replace('https://advertising-api-eu.amazon.com', '');
    if (p === '/reporting/reports' && method === 'POST') {
      const scope = String((opts.headers || {})['Amazon-Advertising-API-Scope']);
      // scenario: Amazon rejects every report request of one profile / of ALL profiles
      if (process.env.FAKE_FAIL_ALL === '1') return json({ code: 'INVALID', details: 'rejected' }, 400);
      if (process.env.FAKE_FAIL_PROFILE && scope === process.env.FAKE_FAIL_PROFILE) return json({ code: 'INVALID', details: 'rejected' }, 400);
      // scenario: ONE report type of one profile is rejected (the other nine are created)
      if (process.env.FAKE_FAIL_REPORT && scope === process.env.FAKE_FAIL_REPORT_PROFILE && String(opts.body || '').includes('"name":"audit ' + process.env.FAKE_FAIL_REPORT + '"')) return json({ code: 'INVALID', details: 'rejected' }, +process.env.FAKE_FAIL_STATUS || 400);
      return json({ reportId: 'rep-' + (++reportN) });
    }
    // scenario: Amazon never finishes the reports
    if (/^\/reporting\/reports\/rep-\d+$/.test(p) && method === 'GET' && process.env.FAKE_PENDING === '1') return json({ status: 'PENDING' });
    if (/^\/reporting\/reports\/rep-\d+$/.test(p) && method === 'GET') return json({ status: 'COMPLETED', url: 'https://dl.fake.test/' + p.split('/').pop() });
    if (p === '/sp/campaigns/list' && method === 'POST') {
      const scope = String((opts.headers || {})['Amazon-Advertising-API-Scope']);
      // scenario: the campaign list of one profile fails (every time / only the first time)
      if (process.env.FAKE_LIST_FAIL_PROFILE && scope === process.env.FAKE_LIST_FAIL_PROFILE) return json({ message: 'down' }, +process.env.FAKE_LIST_STATUS || 500);
      if (process.env.FAKE_LIST_429_ONCE_PROFILE && scope === process.env.FAKE_LIST_429_ONCE_PROFILE) { listHits[scope] = (listHits[scope] || 0) + 1; if (listHits[scope] === 1) return json({ message: 'slow down' }, 429); }
      // scenario: a very large account whose campaign list has FAKE_LIST_PAGES pages (500 campaigns each in real life)
      if (process.env.FAKE_LIST_PAGES_PROFILE && scope === process.env.FAKE_LIST_PAGES_PROFILE) { pageHits[scope] = (pageHits[scope] || 0) + 1; return json(pageHits[scope] < +process.env.FAKE_LIST_PAGES ? { campaigns: [], nextToken: 'T' + pageHits[scope] } : { campaigns: [] }); }
      return json({ campaigns: [] });
    }
  }
  if (url.startsWith('https://dl.fake.test/')) return new Response(zlib.gzipSync(Buffer.from('[]')));

  throw new Error(`mock-net: unmocked request ${method} ${url}`);
};
