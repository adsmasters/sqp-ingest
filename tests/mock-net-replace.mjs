// Test-only preload (node --import) for ads-refresh.mjs and vendor-ads.mjs ("replace" jobs: they replace a client's rows in
// ads_asin_terms / vra_ads). It is an in-memory FAKE of the Amazon Ads report API, the token endpoint and the Supabase tables.
// NOTHING here can reach Amazon or Supabase: every request is answered locally and any unknown URL THROWS.
// Every request is appended to the file in env REQ_LOG as one JSON line {method,url,body?}. At exit the tables are dumped to FAKE_DB_OUT.
// Timers run 1000x faster.
//
// How the fake database behaves (kept faithful to PostgREST so the tests mean something):
//  - POST with ?on_conflict=a,b,c and Prefer resolution=merge-duplicates = upsert on that key; a merge-update only changes the columns that are
//    sent (a column that is NOT sent keeps its old value, e.g. ingested_at); a new row gets ingested_at = now unless sent.
//  - POST without on_conflict = plain insert (vra_ads rows get a serial id).
//  - GET / DELETE understand col=eq.X, col=lt.X and col=in.(a,b); a DELETE WITHOUT any filter THROWS (never wipe a whole table by accident).
// Scenario switches (env):
//  FAKE_DB            JSON {table: [rows]} seeded before the run
//  FAKE_TERMS         number of distinct search terms in the spSearchTerm report (default 3; 0 = empty report), all in ad group AG1
//  FAKE_FAIL_TYPES    comma list of reportTypeIds whose report ends in FAILURE (e.g. "sdAdvertisedProduct,spAdvertisedProduct")
//  FAKE_INSERT_FAIL_NTH  the Nth POST (1-based) to a data table answers HTTP 500 (only that one)
//  FAKE_INSERT_FAIL_MATCH  every POST to a data table whose body contains this text answers HTTP 500 (e.g. one month: '"period_start":"2026-10-01"')
//  FAKE_INSERT_FAIL_AFTER  with FAKE_INSERT_FAIL_MATCH: the first k matching POSTs succeed, later ones fail (a write that breaks half-way)
//  FAKE_SP_ASINS      number of distinct ASINs in the SP advertised-product report (default 2)
//  FAKE_INSERT_THROW_MATCH  a POST whose body contains this text THROWS a network error (fetch rejects) instead of answering HTTP 500
//  FAKE_RETENTION_START  YYYY-MM-DD: report requests starting earlier are rejected with Amazon's "data retention start date (...)" error
//  FAKE_MAX_ROWS      POSTs with more rows than this answer HTTP 500 / 57014 (big batches hit the 8 s database timeout)
//  FAKE_DELETE_FAIL_NOASIN  1 = a DELETE without an asin filter (a whole-client delete) answers HTTP 500 / 57014
//  FAKE_CREATE_FAIL_TYPES  comma list of reportTypeIds whose report CREATION is answered with HTTP 403 (account has no such ad product)
//  FAKE_RETENTION_TYPES    with FAKE_RETENTION_START: only these reportTypeIds have the retention limit (default: all; real SB/SD windows are shorter than SP)
//  (the fake also rejects a bulk upsert that holds the same key twice, and an on_conflict that does not match the unique index, like Postgres)
//  FAKE_DELETE_FAIL   1 = every DELETE answers HTTP 500 and deletes nothing
import fs from 'node:fs';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';

const LOG = process.env.REQ_LOG;
const SB = process.env.SUPABASE_URL;
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.ceil((+ms || 0) / 1000), ...a);

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
const db = JSON.parse(process.env.FAKE_DB || '{}');
for (const t of ['ads_asin_terms', 'vra_ads']) db[t] = db[t] || [];
for (const r of db.vra_ads) if (r.id == null) r.id = randomUUID(); // the real vra_ads.id is a uuid (gen_random_uuid())
// real unique indexes (read from the live database on 2026-11-16): ads_asin_terms (profile_id, asin, search_term), vra_ads (client_id, asin, period_start)
const KEYS = { ads_asin_terms: ['profile_id', 'asin', 'search_term'], vra_ads: ['client_id', 'asin', 'period_start'] };
const DATA_TABLES = new Set(['ads_asin_terms', 'vra_ads']);
const failTypes = new Set((process.env.FAKE_FAIL_TYPES || '').split(',').filter(Boolean));
const nTerms = process.env.FAKE_TERMS === undefined ? 3 : +process.env.FAKE_TERMS;
const reports = {}; let reportN = 0, postN = 0, matchN = 0;

if (process.env.FAKE_DB_OUT) process.on('exit', () => fs.writeFileSync(process.env.FAKE_DB_OUT, JSON.stringify(db)));

function reportRows(type) {
  if (type === 'spAdvertisedProduct' && process.env.FAKE_SP_ASINS) return Array.from({ length: +process.env.FAKE_SP_ASINS }, (_, i) => ({ campaignId: 'C1', adGroupId: 'AG1', advertisedAsin: 'B0BIG' + String(i).padStart(5, '0'), impressions: 10, clicks: 1, cost: 1, purchases7d: 0, sales7d: 0, unitsSoldClicks7d: 0 }));
  if (type === 'spAdvertisedProduct') return [
    { campaignId: 'C1', adGroupId: 'AG1', advertisedAsin: 'B0NEW00001', impressions: 100, clicks: 10, cost: 5, purchases7d: 1, sales7d: 20, unitsSoldClicks7d: 1 },
    { campaignId: 'C1', adGroupId: 'AG1', advertisedAsin: 'B0NEW00002', impressions: 50, clicks: 5, cost: 2.5, purchases7d: 0, sales7d: 0, unitsSoldClicks7d: 0 }];
  if (type === 'spSearchTerm') return Array.from({ length: nTerms }, (_, i) => ({ searchTerm: 'term ' + (i + 1), adGroupId: 'AG1', clicks: 2, cost: 1, purchases7d: 0, sales7d: 0 }));
  if (type === 'sbCampaigns') return [{ campaignId: 'SB1', impressions: 50, clicks: 5, cost: 3, purchases: 0, sales: 0 }];
  return []; // sdAdvertisedProduct
}

// minimal PostgREST filter parser for GET/DELETE urls
function filters(url) {
  const f = [];
  for (const [k, v] of new URL(url).searchParams) {
    if (['select', 'limit', 'order', 'on_conflict', 'offset'].includes(k)) continue;
    let m;
    if ((m = v.match(/^eq\.(.*)$/))) f.push(r => String(r[k]) === m[1]);
    else if ((m = v.match(/^neq\.(.*)$/))) f.push(r => String(r[k]) !== m[1]);
    else if ((m = v.match(/^lt\.(.*)$/))) f.push(r => r[k] != null && String(r[k]) < m[1]);
    else if ((m = v.match(/^in\.\((.*)\)$/))) { const set = new Set(m[1].split(',').map(s => s.replace(/^"|"$/g, ''))); f.push(r => set.has(String(r[k]))); }
    else if ((m = v.match(/^is\.null$/))) f.push(r => r[k] == null);
    else throw new Error(`mock-net-replace: unsupported filter ${k}=${v}`);
  }
  return r => f.every(fn => fn(r));
}
const project = (rows, url) => { const sel = new URL(url).searchParams.get('select'); if (!sel || sel === '*') return rows.map(r => ({ ...r })); const cols = sel.split(','); return rows.map(r => Object.fromEntries(cols.map(c => [c, r[c]]))); };

globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  if (LOG) fs.appendFileSync(LOG, JSON.stringify({ method, url, body: method !== 'GET' && typeof opts.body === 'string' ? opts.body.slice(0, 300) : undefined, rows: method === 'POST' && typeof opts.body === 'string' && opts.body[0] === '[' ? JSON.parse(opts.body).length : undefined }) + '\n');

  if (url === 'https://api.amazon.co.uk/auth/o2/token') return json({ access_token: 'FAKE-TOKEN', expires_in: 3600 });

  if (url.startsWith(SB + '/rest/v1/sqp_clients')) return json(JSON.parse(process.env.FAKE_CLIENTS || '[]'));
  if (url.startsWith(SB + '/rest/v1/vra_clients')) return json(JSON.parse(process.env.FAKE_VRA_CLIENTS || '[]'));
  if (url.startsWith(SB + '/rest/v1/vra_ads_profiles')) return new Response(null, { status: 201 });
  if (url.startsWith(SB + '/rest/v1/vra_data')) return json([]); // title back-fill: nothing to fill

  const tm = url.startsWith(SB + '/rest/v1/') && url.slice((SB + '/rest/v1/').length).split('?')[0];
  if (tm && DATA_TABLES.has(tm)) {
    const rows = db[tm];
    if (method === 'GET') {
      let out = rows.filter(filters(url));
      const ord = new URL(url).searchParams.get('order');
      if (ord) { const [c, d] = ord.split(',')[0].split('.'); out = [...out].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (d === 'desc' ? -1 : 1)); }
      const sp = new URL(url).searchParams; if (sp.get('offset')) out = out.slice(+sp.get('offset')); if (sp.get('limit')) out = out.slice(0, +sp.get('limit'));
      return json(project(out, url));
    }
    if (method === 'POST') {
      postN++;
      if (process.env.FAKE_INSERT_THROW_MATCH && String(opts.body).includes(process.env.FAKE_INSERT_THROW_MATCH)) throw new Error('fetch failed'); // a network error (fetch rejects), not an HTTP answer
      if ((process.env.FAKE_INSERT_FAIL_NTH && postN === +process.env.FAKE_INSERT_FAIL_NTH) || (process.env.FAKE_INSERT_FAIL_MATCH && String(opts.body).includes(process.env.FAKE_INSERT_FAIL_MATCH) && ++matchN > (+process.env.FAKE_INSERT_FAIL_AFTER || 0))) return json({ message: 'canceling statement due to statement timeout', code: '57014' }, 500);
      const body = JSON.parse(opts.body); const list = Array.isArray(body) ? body : [body];
      const key = new URL(url).searchParams.get('on_conflict'); const created = [];
      // behaviours of the real database that a forgiving fake would hide:
      if (process.env.FAKE_MAX_ROWS && list.length > +process.env.FAKE_MAX_ROWS) return json({ message: 'canceling statement due to statement timeout', code: '57014' }, 500); // big batches time out
      if (key && KEYS[tm] && key !== KEYS[tm].join(',')) return json({ code: '42P10', message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification' }, 400);
      if (key && KEYS[tm]) { const seen = new Set(); for (const r of list) { const k = KEYS[tm].map(c => r[c]).join('|'); if (seen.has(k)) return json({ code: '21000', message: 'ON CONFLICT DO UPDATE command cannot affect row a second time' }, 500); seen.add(k); } }
      for (const r of list) {
        const ucols = KEYS[tm]; const ex = ucols && rows.find(x => ucols.every(c => String(x[c]) === String(r[c])));
        if (ex && key) { Object.assign(ex, r); continue; } // upsert: merge, only the columns that are sent change
        if (ex) return json({ code: '23505', message: 'duplicate key value violates unique constraint' }, 409); // plain insert onto an existing key
        const row = { ...r }; if (tm === 'ads_asin_terms' && row.ingested_at === undefined) row.ingested_at = new Date().toISOString();
        if (tm === 'vra_ads') row.id = randomUUID();
        rows.push(row); created.push(row);
      }
      if (String((opts.headers || {}).Prefer || '').includes('return=representation')) return json(project(created, url), 201);
      return new Response(null, { status: 201 });
    }
    if (method === 'DELETE') {
      if (!new URL(url).search.replace(/^\?/, '')) throw new Error('mock-net-replace: DELETE without any filter on ' + tm);
      if (process.env.FAKE_DELETE_FAIL_NOASIN === '1' && !new URL(url).searchParams.has('asin')) return json({ message: 'canceling statement due to statement timeout', code: '57014' }, 500); // a whole-client delete is too big for the 8 s limit
      if (process.env.FAKE_DELETE_FAIL === '1') return json({ message: 'canceling statement due to statement timeout', code: '57014' }, 500);
      const match = filters(url); db[tm] = rows.filter(r => !match(r));
      return new Response(null, { status: 204 });
    }
  }

  if (url.startsWith('https://advertising-api-eu.amazon.com')) {
    const p = url.replace('https://advertising-api-eu.amazon.com', '');
    if (p === '/reporting/reports' && method === 'POST') {
      const body = JSON.parse(opts.body);
      const R = process.env.FAKE_RETENTION_START; // Amazon only keeps data from this date: an earlier start date is rejected with the real error text
      const typ = body.configuration.reportTypeId;
      if (process.env.FAKE_CREATE_FAIL_TYPES && process.env.FAKE_CREATE_FAIL_TYPES.split(',').includes(typ)) return json({ code: '403', message: 'Advertiser is not authorized for this ad product' }, 403); // permanent: this account has no such ad product
      if (R && (!process.env.FAKE_RETENTION_TYPES || process.env.FAKE_RETENTION_TYPES.split(',').includes(typ)) && body.startDate < R) return json({ code: '400', detail: `The start date is before the data retention start date (${R}) for this report type` }, 400);
      const id = 'rep-' + (++reportN); reports[id] = body.configuration.reportTypeId; return json({ reportId: id });
    }
    if (/^\/reporting\/reports\/rep-\d+$/.test(p) && method === 'GET') {
      const id = p.split('/').pop();
      return failTypes.has(reports[id]) ? json({ status: 'FAILURE', failureReason: 'INTERNAL' }) : json({ status: 'COMPLETED', url: 'https://dl.fake.test/' + id });
    }
    if (p === '/v2/profiles' && method === 'GET') return json([]);
  }
  if (url.startsWith('https://dl.fake.test/')) return new Response(zlib.gzipSync(Buffer.from(JSON.stringify(reportRows(reports[url.split('/').pop()])))));

  throw new Error(`mock-net-replace: unmocked request ${method} ${url}`);
};
