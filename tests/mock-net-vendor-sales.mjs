// Test-only preload (node --import) for vendor-sales.mjs. An in-memory FAKE of the Selling Partner Reports API, the token endpoint and the Supabase
// tables vra_reports / vra_data. NOTHING here can reach Amazon or Supabase: every request is answered locally and any unknown URL THROWS.
// Every request is appended to the file in env REQ_LOG as one JSON line {method,url,body?}. At exit the tables are dumped to FAKE_DB_OUT.
// Timers run 1000x faster. FAKE_NOW (ISO date) pins "today" for new Date() / Date.now() so the tests do not depend on the real date.
// Scenario switches (env):
//  FAKE_VCLIENTS  JSON list of vra_clients rows {id,name,marketplace,spid}
//  FAKE_DB        JSON {vra_reports:[..], vra_data:[..]} seeded before the run
//  FAKE_SLOW      JSON {spid: {report: N, polls: P}} (or a list of such rules per spid): the Nth DAY report of that client needs P status polls before it
//                 is DONE (P > 120 = not ready within the script's 10-minute wait; a value above 180 (120 + 60 polls) = never ready, also not after the end-of-run re-check)
//  FAKE_FATAL     JSON {spid: N}: the Nth DAY report of that client ends FATAL (Amazon marks it failed)
//  FAKE_DONE_NO_DOC  JSON {spid: N}: the Nth DAY report of that client is DONE but has no reportDocumentId
//  FAKE_FAIL_INSERT_BODY  a POST to vra_data whose body contains this text answers HTTP 500 / 57014 (a database write that breaks)
import fs from 'node:fs';
import zlib from 'node:zlib';

const LOG = process.env.REQ_LOG;
const SB = process.env.SUPABASE_URL;
// VIRTUAL CLOCK: timers really run 1000x faster, but every timer that fires advances a virtual clock by the delay the script ASKED for. With FAKE_NOW set,
// new Date() / Date.now() return FAKE_NOW + that virtual time, so "the script has run for 25 minutes" is exact and deterministic (the script is one
// sequential flow of awaits, so the sum of its requested delays is its run time). This lets the tests check the time limits precisely.
const realSetTimeout = globalThis.setTimeout;
let virtualMs = 0;
globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(() => { virtualMs += (+ms || 0); fn(...a); }, Math.ceil((+ms || 0) / 1000));
if (process.env.FAKE_NOW) {
  const RealDate = Date, base = RealDate.parse(process.env.FAKE_NOW);
  globalThis.Date = class extends RealDate {
    constructor(...a) { if (a.length === 0) super(base + virtualMs); else super(...a); }
    static now() { return base + virtualMs; }
  };
}

const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const db = JSON.parse(process.env.FAKE_DB || '{}');
for (const t of ['vra_reports', 'vra_data']) db[t] = db[t] || [];
let serial = 1000; for (const t of ['vra_reports', 'vra_data']) for (const r of db[t]) if (r.id == null) r.id = ++serial;
const slow = JSON.parse(process.env.FAKE_SLOW || '{}'), fatal = JSON.parse(process.env.FAKE_FATAL || '{}'), noDoc = JSON.parse(process.env.FAKE_DONE_NO_DOC || '{}');
const reports = {}; const dayCount = {}; let reportN = 0;
if (process.env.FAKE_DB_OUT) process.on('exit', () => fs.writeFileSync(process.env.FAKE_DB_OUT, JSON.stringify(db)));

function filters(url) {
  const f = [];
  for (const [k, v] of new URL(url).searchParams) {
    if (['select', 'limit', 'order', 'offset'].includes(k)) continue;
    let m;
    if ((m = v.match(/^eq\.(.*)$/))) f.push(r => String(r[k]) === m[1]);
    else if ((m = v.match(/^in\.\((.*)\)$/))) { const set = new Set(m[1].split(',')); f.push(r => set.has(String(r[k]))); }
    else if (v === 'not.is.null') f.push(r => r[k] != null);
    else throw new Error(`mock-net-vendor-sales: unsupported filter ${k}=${v}`);
  }
  return r => f.every(fn => fn(r));
}
const project = (rows, url) => { const sel = new URL(url).searchParams.get('select'); if (!sel || sel === '*') return rows.map(r => ({ ...r })); const cols = sel.split(','); return rows.map(r => Object.fromEntries(cols.map(c => [c, r[c]]))); };
const page = (rows, url) => { const sp = new URL(url).searchParams; let out = rows; if (sp.get('offset')) out = out.slice(+sp.get('offset')); if (sp.get('limit')) out = out.slice(0, +sp.get('limit')); return out; };
const sorted = (rows, url) => { const ord = new URL(url).searchParams.get('order'); if (!ord) return rows; const [c, d] = ord.split(',')[0].split('.'); return [...rows].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (d === 'desc' ? -1 : 1)); };

function dayRows(start, end, spid) {
  // one ASIN per report chunk, so the tests can see which chunks made it into the stored month
  return [{ asin: `B0${spid}D${start.slice(8, 10)}`, orderedRevenue: { amount: 10, currencyCode: 'EUR' }, orderedUnits: 1, shippedRevenue: { amount: 8, currencyCode: 'EUR' }, shippedCogs: { amount: 5, currencyCode: 'EUR' }, shippedUnits: 1, customerReturns: 0, startDate: start, endDate: end }];
}

globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  if (LOG) fs.appendFileSync(LOG, JSON.stringify({ method, url, body: method !== 'GET' && typeof opts.body === 'string' ? opts.body.slice(0, 300) : undefined }) + '\n');

  if (url === 'https://api.amazon.co.uk/auth/o2/token') return json({ access_token: 'AT-' + new URLSearchParams(opts.body).get('refresh_token').replace(/^rt-/, ''), expires_in: 3600 });

  if (url.startsWith(SB + '/rest/v1/vra_clients')) return json(JSON.parse(process.env.FAKE_VCLIENTS || '[]'));
  if (url.startsWith(SB + '/rest/v1/spapi_accounts')) return json([{ refresh_token: 'rt-' + decodeURIComponent(new URL(url).searchParams.get('selling_partner_id').replace(/^eq\./, '')) }]);

  const tm = url.startsWith(SB + '/rest/v1/') && url.slice((SB + '/rest/v1/').length).split('?')[0];
  if (tm === 'vra_reports' || tm === 'vra_data') {
    const rows = db[tm];
    const prefer = String((opts.headers || {}).Prefer || '');
    if (method === 'GET') {
      const out = sorted(rows.filter(filters(url)), url);
      if (/count=exact/.test(prefer)) return json(project(page(out, url), url), 200, { 'content-range': `0-0/${out.length}` });
      return json(project(page(out, url), url));
    }
    if (method === 'POST') {
      if (tm === 'vra_data' && process.env.FAKE_FAIL_INSERT_BODY && String(opts.body).includes(process.env.FAKE_FAIL_INSERT_BODY)) return json({ message: 'canceling statement due to statement timeout', code: '57014' }, 500);
      const body = JSON.parse(opts.body); const list = Array.isArray(body) ? body : [body]; const created = [];
      for (const r of list) { const row = { ...r, id: ++serial }; if (tm === 'vra_reports') row.uploaded_at = row.uploaded_at || new Date().toISOString(); rows.push(row); created.push(row); }
      if (prefer.includes('return=representation')) return json(project(created, url), 201);
      return new Response(null, { status: 201 });
    }
    if (method === 'PATCH') {
      const match = filters(url); const hit = rows.filter(match); for (const r of hit) Object.assign(r, JSON.parse(opts.body));
      return prefer.includes('return=representation') ? json(project(hit, url)) : new Response(null, { status: 204 });
    }
    if (method === 'DELETE') {
      if (!new URL(url).search.replace(/^\?/, '')) throw new Error('mock-net-vendor-sales: DELETE without any filter on ' + tm);
      const match = filters(url); db[tm] = rows.filter(r => !match(r));
      return new Response(null, { status: 204 });
    }
  }

  if (url.startsWith('https://sellingpartnerapi-eu.amazon.com')) {
    const p = url.replace('https://sellingpartnerapi-eu.amazon.com', '');
    const spid = String((opts.headers || {})['x-amz-access-token'] || '').replace(/^AT-/, '');
    if (p === '/reports/2021-06-30/reports' && method === 'POST') {
      const body = JSON.parse(opts.body); const id = 'rep-' + (++reportN);
      const period = body.reportOptions.reportPeriod;
      const start = body.dataStartTime.slice(0, 10), end = body.dataEndTime.slice(0, 10);
      let n = 0; if (period === 'DAY') n = dayCount[spid] = (dayCount[spid] || 0) + 1;
      const rule = period === 'DAY' ? [].concat(slow[spid] || []).find(x => x.report === n) : null; // FAKE_SLOW may hold one rule or a list of rules per client
      const need = rule ? rule.polls : 1;
      reports[id] = { spid, start, end, polls: 0, need, fatal: period === 'DAY' && fatal[spid] === n, noDoc: period === 'DAY' && noDoc[spid] === n };
      return json({ reportId: id }, 202);
    }
    let m;
    if ((m = p.match(/^\/reports\/2021-06-30\/reports\/(rep-\d+)$/)) && method === 'GET') {
      const r = reports[m[1]]; r.polls++;
      if (r.fatal) return json({ processingStatus: 'FATAL' });
      if (r.noDoc) return json({ processingStatus: 'DONE' }); // DONE without a reportDocumentId
      return json(r.polls >= r.need ? { processingStatus: 'DONE', reportDocumentId: 'doc-' + m[1] } : { processingStatus: 'IN_PROGRESS' });
    }
    if ((m = p.match(/^\/reports\/2021-06-30\/documents\/doc-(rep-\d+)$/)) && method === 'GET') return json({ url: 'https://dl.fake.test/' + m[1], compressionAlgorithm: 'GZIP' });
    if (p.startsWith('/catalog/2022-04-01/items')) return json({ items: [] });
  }
  if (url.startsWith('https://dl.fake.test/')) {
    const r = reports[url.split('/').pop()];
    return new Response(zlib.gzipSync(Buffer.from(JSON.stringify({ salesByAsin: dayRows(r.start, r.end, r.spid) }))));
  }

  throw new Error(`mock-net-vendor-sales: unmocked request ${method} ${url}`);
};
