// Test-only preload (node --import) for audit-terms-refresh.mjs: an in-memory FAKE of Amazon's report API, the token endpoint and the Supabase
// table ads_audit_cache. NOTHING here can reach Amazon or Supabase: every request is answered locally and any unknown URL THROWS.
// Every request is appended to the file in env REQ_LOG as one JSON line {method,url,body?}. Timers run 1000x faster.
import fs from 'node:fs';
import zlib from 'node:zlib';

const LOG = process.env.REQ_LOG;
const SB = process.env.SUPABASE_URL;
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.ceil((+ms || 0) / 1000), ...a);

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
const clients = JSON.parse(process.env.FAKE_CLIENTS || '[]');
const store = JSON.parse(process.env.FAKE_CACHE || '{}');      // profile_id -> { updated_at, payload }
const reportRows = JSON.parse(process.env.FAKE_REPORT_ROWS || '[]'); // what Amazon's spSearchTerm report returns for every account
const reportOwner = {}; let reportN = 0, pollN = {};

globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  if (LOG) fs.appendFileSync(LOG, JSON.stringify({ method, url, body: method !== 'GET' && typeof opts.body === 'string' ? opts.body.slice(0, method === 'PATCH' ? 1e8 : 600) : undefined }) + '\n');

  if (url === 'https://api.amazon.co.uk/auth/o2/token') return json({ access_token: 'FAKE-TOKEN', expires_in: 3600 });

  if (url.startsWith(SB + '/rest/v1/sqp_clients')) return json(clients);

  if (url.startsWith(SB + '/rest/v1/ads_audit_cache')) {
    const q = new URL(url).searchParams;
    const pid = (q.get('profile_id') || '').replace(/^eq\./, '');
    if (method === 'GET') {
      const sel = q.get('select') || '';
      if (sel.includes('asof:')) { // the rich listing (profile, updated_at, spTermsAsOf, spTerms.cols)
        if (process.env.FAKE_RICH_SELECT_FAIL === '1') return json({ message: 'unsupported select' }, 400);
        return json(Object.entries(store).map(([profile_id, r]) => ({ profile_id, updated_at: r.updated_at, asof: (r.payload && r.payload.spTermsAsOf) || null, cols: (r.payload && r.payload.spTerms && r.payload.spTerms.cols) || null })));
      }
      if (sel === 'profile_id,updated_at') return json(Object.entries(store).map(([profile_id, r]) => ({ profile_id, updated_at: r.updated_at })));
      if (sel.includes('payload')) { // the fresh read of ONE account right before writing
        if (process.env.FAKE_VANISH_PROFILE === pid) return json([]);
        const r = store[pid]; return json(r ? [{ payload: JSON.parse(JSON.stringify(r.payload)), updated_at: r.updated_at }] : []);
      }
    }
    if (method === 'PATCH') {
      const expect = (q.get('updated_at') || '').replace(/^eq\./, '');
      if (process.env.FAKE_PATCH_FAIL_PROFILE === pid) return json({ message: 'down' }, 500);
      if (process.env.FAKE_CAS_CONFLICT_PROFILE === pid || process.env.FAKE_CAS_CONFLICT_ALL === '1') return json([]); // somebody wrote the row after we read it
      const r = store[pid];
      if (!r || r.updated_at !== expect) return json([]);
      r.payload = JSON.parse(opts.body).payload; // updated_at is NOT touched by a PATCH of the payload alone ...
      if (process.env.FAKE_TRIGGER_BUMP === '1') r.updated_at = new Date().toISOString().replace('Z', '+00:00'); // ... unless a DB trigger (moddatetime) does it
      return json([{ profile_id: pid, updated_at: r.updated_at }]);
    }
  }

  if (url.startsWith('https://advertising-api-eu.amazon.com')) {
    const p = url.replace('https://advertising-api-eu.amazon.com', '');
    const scope = String((opts.headers || {})['Amazon-Advertising-API-Scope']);
    if (p === '/reporting/reports' && method === 'POST') {
      if (process.env.FAKE_FAIL_ALL === '1' || process.env.FAKE_FAIL_PROFILE === scope) return json({ code: 'INVALID', details: 'rejected' }, 400);
      if (process.env.FAKE_429_FIRST === scope) { pollN['429:' + scope] = (pollN['429:' + scope] || 0) + 1; if (pollN['429:' + scope] === 1) return json({ message: 'slow down' }, 429); }
      const id = 'rep-' + (++reportN); reportOwner[id] = scope; return json({ reportId: id });
    }
    if (/^\/reporting\/reports\/rep-\d+$/.test(p) && method === 'GET') {
      const id = p.split('/').pop();
      if (process.env.FAKE_FAILURE_PROFILE === reportOwner[id]) return json({ status: 'FAILURE', failureReason: 'INTERNAL' });
      pollN[id] = (pollN[id] || 0) + 1;
      if (pollN[id] <= (+process.env.FAKE_PENDING_ROUNDS || 0)) return json({ status: 'PENDING' });
      return json({ status: 'COMPLETED', url: 'https://dl.fake.test/' + id });
    }
  }
  if (url.startsWith('https://dl.fake.test/')) return new Response(zlib.gzipSync(Buffer.from(JSON.stringify(reportRows))));

  throw new Error(`mock-net-terms: unmocked request ${method} ${url}`);
};
