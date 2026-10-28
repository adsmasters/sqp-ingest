// Test-only preload (node --import) for refresh.mjs: replaces the network with an in-memory fake and runs on a VIRTUAL clock.
// NOTHING here can reach Amazon, Supabase or Slack: every request is answered locally and any unknown URL THROWS (and is counted).
// Clock: Date / Date.now / performance.now / setTimeout / AbortSignal.timeout jump straight to the next pending timer as soon as the
// process is idle, so a 5-hour refresh run takes well under a second of real time and is fully deterministic.
// Scenario (env FAKE_SCEN, JSON):
//   clients[]            [{name,spid,marketplace}]  answer of sqp_clients (reversed unless the request says order=name.asc)
//   start                ISO start of the virtual clock
//   pattern / perClient  report outcome per SQP report, cycled: R=rows, T=never finishes (TIMEOUT), F=FATAL ("keine Daten"); per spid override
//   noToken[]            spids without a refresh token (spapi_accounts -> [])
//   listMode{spid}       'http500' | 'html503' | 'fatal' | 'stuck' | 'hang' | 'http401' | 'http403'  - the listings report of that client fails
//   bigList{spid}        number of ACTIVE ASINs in the listings report (default 45; > 300 and no brand filter => client is skipped)
//   createMode{spid}     'hang' | '429' | '403' - creating an SQP report never succeeds
//   ingest{spid|mkt}     newest sqp_asin_rows.ingested_at per (selling_partner_id, marketplace_id); missing = never ingested
//   slackStatus          HTTP status of the Slack webhook
// At exit the mock writes env FAKE_SUMMARY (JSON): created / rowsPosted per spid, createAttemptT (virtual seconds), slack[], unmocked[],
// ingestQ[], clientsUrl, aborted / hungNoSignal (hung requests that were aborted by a timeout / that had NO abort signal), fakeMin.
import fs from 'node:fs';
import zlib from 'node:zlib';
import util from 'node:util';

const SC = JSON.parse(process.env.FAKE_SCEN || '{}');
const SB = process.env.SUPABASE_URL;
const SLACK = process.env.SLACK_WEBHOOK_URL;
const START = Date.parse(SC.start || '2026-10-28T03:00:00Z');
const CAP_MIN = 400; // runaway guard
let vnow = START;

// ---------------------------------------------------------------- virtual clock
const RealDate = Date;
globalThis.Date = new Proxy(RealDate, {
  construct(t, a, nt) { return Reflect.construct(t, a.length ? a : [vnow], nt); },
  apply() { return new RealDate(vnow).toString(); },
  get(t, p) { return p === 'now' ? () => vnow : Reflect.get(t, p, t); },
});
performance.now = () => vnow - START + 1;
const timers = []; let seq = 0, pumping = false;
const handle = (t) => ({ unref() { return this; }, ref() { return this; }, hasRef() { return true; }, refresh() { return this; }, [Symbol.toPrimitive]() { return t.seq; }, _t: t });
globalThis.setTimeout = (fn, ms, ...a) => { const t = { at: vnow + Math.max(0, +ms || 0), seq: seq++, fn, a, off: false }; timers.push(t); kick(); return handle(t); };
globalThis.clearTimeout = (h) => { if (h && h._t) h._t.off = true; };
function kick() { if (!pumping) { pumping = true; setImmediate(pump); } }
function pump() {
  pumping = false;
  timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
  while (timers.length && timers[0].off) timers.shift();
  if (!timers.length) return;
  const t = timers.shift();
  if (t.at > vnow) vnow = t.at;
  if ((vnow - START) / 60000 > CAP_MIN) { process.stderr.write('MOCK_CAP: virtual time exceeded ' + CAP_MIN + ' min\n'); process.exit(99); }
  try { t.fn(...t.a); } catch (e) { process.nextTick(() => { throw e; }); }
  kick();
}
AbortSignal.timeout = (ms) => { const c = new AbortController(); globalThis.setTimeout(() => c.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms); return c.signal; };
for (const m of ['log', 'error', 'warn']) { const o = console[m].bind(console); console[m] = (...a) => o('[T+' + ((vnow - START) / 60000).toFixed(1).padStart(6) + 'm] ' + util.format(...a)); }

// ---------------------------------------------------------------- state + helpers
const S = { created: {}, rowsPosted: {}, createAttemptT: {}, createT: {}, aborted: {}, hungNoSignal: {}, slack: [], unmocked: [], ingestQ: [], clientsUrl: null, fakeMin: 0 };
const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
const clients = SC.clients || [];
const reports = new Map(); const tokenN = {};
const buf = (b) => { const u = new Uint8Array(b.length); u.set(b); return u.buffer; };
function resp(status, body, raw) {
  const text = raw === undefined ? (body === undefined ? '' : JSON.stringify(body)) : null;
  return { ok: status >= 200 && status < 300, status, statusText: String(status), headers: { get: () => null },
    async json() { if (raw !== undefined) throw new SyntaxError('binary'); if (text === '') throw new SyntaxError('empty'); return JSON.parse(text); },
    async text() { return raw !== undefined ? Buffer.from(raw).toString('latin1') : text; },
    async arrayBuffer() { return buf(raw !== undefined ? Buffer.from(raw) : Buffer.from(text)); } };
}
const hdr = (o, k) => { const h = o.headers || {}; const f = Object.keys(h).find((x) => x.toLowerCase() === k.toLowerCase()); return f ? h[f] : undefined; };
// a request that never answers: only an AbortSignal can end it; one WITHOUT a signal would hang the real process forever (recorded)
function hang(signal, key) {
  return new Promise((_, rej) => {
    if (!signal) { bump(S.hungNoSignal, key); return; }
    const onAbort = () => { bump(S.aborted, key); rej(signal.reason || new DOMException('This operation was aborted', 'AbortError')); };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
const asinOf = (ci, i) => 'B0' + String(ci).padStart(3, '0') + String(i).padStart(5, '0');
function listingTsv(spid) {
  const ci = clients.findIndex((c) => c.spid === spid) + 1; const n = (SC.bigList || {})[spid] || 45;
  const rows = ['seller-sku\tasin1\tprice\tstatus'];
  for (let i = 1; i <= n; i++) rows.push(`sku-${i}\t${asinOf(ci, i)}\t9.99\tActive`);
  for (let i = n + 1; i <= n + 3; i++) rows.push(`sku-${i}\t${asinOf(ci, i)}\t9.99\tInactive`);
  return Buffer.from(rows.join('\n') + '\n', 'latin1');
}
function sqpDoc(rec) {
  const dataByAsin = [];
  for (const asin of rec.asins) for (let q = 1; q <= 3; q++) dataByAsin.push({ asin, startDate: rec.start, endDate: rec.end,
    searchQueryData: { searchQuery: 'query ' + q, searchQueryScore: q, searchQueryVolume: 100 + q },
    impressionData: { totalQueryImpressionCount: 1000, asinImpressionCount: 100, asinImpressionShare: 0.1 },
    clickData: { totalClickCount: 100, asinClickCount: 10, asinClickShare: 0.1 },
    cartAddData: { totalCartAddCount: 10, asinCartAddCount: 2, asinCartAddShare: 0.2 },
    purchaseData: { totalPurchaseCount: 5, asinPurchaseCount: 1, asinPurchaseShare: 0.2, asinMedianPurchasePrice: { amount: 9.99, currencyCode: 'EUR' } } });
  return Buffer.from(JSON.stringify({ reportSpecification: {}, dataByAsin }));
}
const outcome = (spid, idx) => { const pat = ((SC.perClient || {})[spid]) ?? SC.pattern ?? 'R'; return pat[idx % pat.length]; };

// ---------------------------------------------------------------- fetch
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const method = String(opts.method || 'GET').toUpperCase(); const signal = opts.signal;
  if (signal && signal.aborted) throw signal.reason || new DOMException('aborted', 'AbortError');

  if (url === 'https://api.amazon.co.uk/auth/o2/token' && method === 'POST') { // LWA
    const spid = (new URLSearchParams(String(opts.body)).get('refresh_token') || '').replace(/^RT-/, '');
    bump(tokenN, spid); return resp(200, { access_token: `AT-${spid}-${tokenN[spid]}`, expires_in: 3600 });
  }
  if (url === SLACK && method === 'POST') { // Slack webhook
    S.slack.push({ t: (vnow - START) / 60000, body: String(opts.body) });
    return resp(SC.slackStatus || 200, 'ok');
  }
  if (url.startsWith('https://sellingpartnerapi-eu.amazon.com/')) { // SP-API (reports only)
    const p = url.slice('https://sellingpartnerapi-eu.amazon.com'.length);
    const spid = ((String(hdr(opts, 'x-amz-access-token') || '')).match(/^AT-(.+)-\d+$/) || [])[1];
    if (!spid) return resp(403, { errors: [{ code: 'Unauthorized' }] });
    if (method === 'POST' && p === '/reports/2021-06-30/reports') {
      const body = JSON.parse(String(opts.body)); const id = `rep-${spid}-${reports.size + 1}`;
      if (body.reportType === 'GET_MERCHANT_LISTINGS_ALL_DATA') {
        const lm = (SC.listMode || {})[spid];
        if (lm === 'http500') return resp(500, { errors: [{ code: 'InternalFailure' }] });
        if (lm === 'hang') return hang(signal, spid);
        if (lm === 'http401') return resp(401, { errors: [{ code: 'Unauthorized' }] });
        if (lm === 'http403') return resp(403, { errors: [{ code: 'Forbidden' }] });
        if (lm === 'html503') return resp(503, null, '<html><body>503 Service Unavailable</body></html>'); // gateway page, not JSON
        reports.set(id, { id, spid, type: 'LIST', at: vnow, ch: lm === 'fatal' ? 'F' : lm === 'stuck' ? 'T' : 'R' });
      } else if (body.reportType === 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT') {
        (S.createAttemptT[spid] ||= []).push((vnow - START) / 1000);
        const cm = (SC.createMode || {})[spid];
        if (cm === 'hang') return hang(signal, spid);
        if (cm === '429') return resp(429, { errors: [{ code: 'QuotaExceeded' }] });
        if (cm === '403') return resp(403, { errors: [{ code: 'Unauthorized' }] }); // no Brand Analytics access
        const idx = S.created[spid] || 0; bump(S.created, spid); (S.createT[spid] ||= []).push((vnow - START) / 60000);
        reports.set(id, { id, spid, type: 'SQP', at: vnow, ch: outcome(spid, idx), asins: String(body.reportOptions?.asin || '').split(' ').filter(Boolean), start: String(body.dataStartTime).slice(0, 10), end: String(body.dataEndTime).slice(0, 10) });
      } else { S.unmocked.push('create ' + body.reportType); throw new Error('mock: unmocked reportType ' + body.reportType); }
      return resp(202, { reportId: id });
    }
    if (method === 'GET' && /^\/reports\/2021-06-30\/reports\/[^/]+$/.test(p)) { // status: rows after 10 s, T = never
      const rec = reports.get(p.split('/').pop()); if (!rec) return resp(404, {});
      const age = (vnow - rec.at) / 1000;
      if (rec.ch === 'T' || age < 10) return resp(200, { reportId: rec.id, processingStatus: age < 2 ? 'IN_QUEUE' : 'IN_PROGRESS' });
      if (rec.ch === 'F') return resp(200, { reportId: rec.id, processingStatus: 'FATAL' });
      return resp(200, { reportId: rec.id, processingStatus: 'DONE', reportDocumentId: 'doc-' + rec.id });
    }
    if (method === 'GET' && /^\/reports\/2021-06-30\/documents\//.test(p)) {
      const id = p.split('/').pop().replace(/^doc-/, ''); const rec = reports.get(id); if (!rec) return resp(404, {});
      return resp(200, { reportDocumentId: 'doc-' + id, url: 'https://s3.fake.test/' + id, ...(rec.type === 'SQP' ? { compressionAlgorithm: 'GZIP' } : {}) });
    }
  }
  if (url.startsWith('https://s3.fake.test/') && method === 'GET') {
    const rec = reports.get(url.slice('https://s3.fake.test/'.length)); if (!rec) return resp(404, {});
    return rec.type === 'LIST' ? resp(200, null, listingTsv(rec.spid)) : resp(200, null, zlib.gzipSync(sqpDoc(rec)));
  }
  if (url.startsWith(SB + '/rest/v1/')) { // Supabase (PostgREST)
    const rest = url.slice((SB + '/rest/v1/').length); const table = rest.split('?')[0]; const q = new URLSearchParams(rest.split('?')[1] || '');
    const spidQ = (k) => (q.get(k) || '').replace(/^eq\./, '');
    if (table === 'sqp_clients' && method === 'GET') {
      if (!q.has('spid')) { S.clientsUrl = rest; const l = clients.map((c) => ({ ...c, ads_profile_id: null, active: true })); return resp(200, q.get('order') === 'name.asc' ? l : [...l].reverse()); }
      if (q.get('select') === 'brand_filter') return resp(200, [{ brand_filter: null }]);
      if (q.get('select') === 'asin_focus') return resp(200, [{ asin_focus: [] }]);
    }
    if (table === 'spapi_accounts' && method === 'GET') { const spid = spidQ('selling_partner_id'); return resp(200, (SC.noToken || []).includes(spid) ? [] : [{ refresh_token: 'RT-' + spid }]); }
    if (table === 'sqp_asin_rows' && method === 'GET' && q.get('select') === 'ingested_at') { // newest ingest per (selling_partner_id, marketplace_id)
      const spid = spidQ('selling_partner_id'), mk = spidQ('marketplace_id');
      S.ingestQ.push({ url: rest, spid, mk }); const iso = (SC.ingest || {})[spid + '|' + mk];
      return resp(200, iso ? [{ ingested_at: iso }] : []);
    }
    if ((table === 'sqp_asin_meta' || table === 'asin_sales_traffic') && method === 'GET') return resp(200, []);
    if (table === 'sqp_asin_rows' && method === 'DELETE') return resp(204);
    if (table === 'sqp_asin_rows' && method === 'POST') { const rows = JSON.parse(String(opts.body)); bump(S.rowsPosted, rows[0].selling_partner_id, rows.length); return resp(201); }
  }
  S.unmocked.push(method + ' ' + url);
  throw new Error(`mock-net-refresh: UNMOCKED request ${method} ${url}`);
};
process.on('exit', () => { S.fakeMin = (vnow - START) / 60000; try { fs.writeFileSync(process.env.FAKE_SUMMARY, JSON.stringify(S)); } catch {} });
