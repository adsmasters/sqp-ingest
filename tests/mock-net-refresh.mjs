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
//   sqp{dupQuery,lowVolume}  dupQuery: true | [spid]  -> every ASIN's document repeats 'query 1' a 2nd time (volume 999, score 9);
//                        lowVolume: {spid: true | [asin]} -> searchQueryVolume 1 (mapRows filters every row => EMPTY new data)
//   table{...}           STATEFUL in-memory sqp_asin_rows (PostgREST-on-Postgres behaviour):
//                        seed[]        rows {selling_partner_id,marketplace_id,asin,report_period,start_date,end_date?,search_query,...values,ingested_at?,id?}
//                        nextId        first auto id (default max(seed id)+1 / 1);  cap  server cap per GET response (default 1000)
//                        latencyMs     virtual answer delay of every table request (state is applied on ARRIVAL, the answer comes later)
//                        faults[]      {method:'GET'|'POST'|'DELETE', spid, asin?, nth?, status?}: HTTP 500 (state untouched) for the matching call(s)
//                        Unique key (selling_partner_id,marketplace_id,asin,report_period,start_date,search_query): plain POST on an existing key => 409;
//                        POST ?on_conflict=<the 6 cols> + Prefer resolution=merge-duplicates => upsert of the payload columns in place, but the SAME key twice
//                        in ONE request => 500 'ON CONFLICT DO UPDATE command cannot affect row a second time'; id auto increasing; ingested_at default = virtual now
//                        on INSERT (an upsert only touches the payload columns); GET filters eq / id=in.(..), select, order, limit, offset (+Range header);
//                        DELETE without a non-empty filter => 400.
//   FAKE_SCEN_FILE (env) path of a JSON scenario file (used instead of FAKE_SCEN; Windows env values are capped at ~32 KB)
//   sqp{dupQuery,lowVolume}  dupQuery: true | [spid]  -> every ASIN's document repeats 'query 1' a 2nd time (volume 999, score 9);
//                        lowVolume: {spid: true | [asin]} -> searchQueryVolume 1 (mapRows filters every row => EMPTY new data)
//   table{...}           STATEFUL in-memory sqp_asin_rows (PostgREST-on-Postgres behaviour):
//                        seed[]        rows {selling_partner_id,marketplace_id,asin,report_period,start_date,end_date?,search_query,...values,ingested_at?,id?}
//                        nextId        first auto id (default max(seed id)+1 / 1);  cap  server cap per GET response (default 1000)
//                        latencyMs     virtual answer delay of every table request (state is applied on ARRIVAL, the answer comes later)
//                        faults[]      {method:'GET'|'POST'|'DELETE', spid, asin?, nth?, status?}: HTTP 500 (state untouched) for the matching call(s)
//                        Unique key (selling_partner_id,marketplace_id,asin,report_period,start_date,search_query): plain POST on an existing key => 409;
//                        POST ?on_conflict=<the 6 cols> + Prefer resolution=merge-duplicates => upsert of the payload columns in place, but the SAME key twice
//                        in ONE request => 500 'ON CONFLICT DO UPDATE command cannot affect row a second time'; id auto increasing; ingested_at default = virtual now
//                        on INSERT (an upsert only touches the payload columns); GET filters eq / id=in.(..), select, order, limit, offset (+Range header);
//                        DELETE without a non-empty filter => 400.
//   FAKE_SCEN_FILE (env) path of a JSON scenario file (used instead of FAKE_SCEN; Windows env values are capped at ~32 KB)
// At exit the mock writes env FAKE_SUMMARY (JSON): created / rowsPosted per spid, createAttemptT (virtual seconds), slack[], unmocked[],
// ingestQ[], clientsUrl, aborted / hungNoSignal (hung requests that were aborted by a timeout / that had NO abort signal), fakeMin,
// table {rows[],nextId} (final sqp_asin_rows, rows written by POST in this run carry _w:true), tlog[] (every sqp_asin_rows request in order: virtual ms since start,
// method, kind, slice, status, rowsAfter = table size after the request, sliceAfter, ids / deleted / queries ...), tpeak (max table size), tstart (ISO of virtual start).
import fs from 'node:fs';
import zlib from 'node:zlib';
import util from 'node:util';

const SC = JSON.parse(process.env.FAKE_SCEN_FILE ? fs.readFileSync(process.env.FAKE_SCEN_FILE, 'utf8') : (process.env.FAKE_SCEN || '{}'));
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
  const dup = (SC.sqp || {}).dupQuery; const dupOn = dup === true || (Array.isArray(dup) && dup.includes(rec.spid));
  const lv = ((SC.sqp || {}).lowVolume || {})[rec.spid];
  for (const asin of rec.asins) {
    const low = lv === true || (Array.isArray(lv) && lv.includes(asin));
    const mk = (q, score, vol) => ({ asin, startDate: rec.start, endDate: rec.end,
      searchQueryData: { searchQuery: 'query ' + q, searchQueryScore: score, searchQueryVolume: low ? 1 : vol },
      impressionData: { totalQueryImpressionCount: 1000, asinImpressionCount: 100, asinImpressionShare: 0.1 },
      clickData: { totalClickCount: 100, asinClickCount: 10, asinClickShare: 0.1 },
      cartAddData: { totalCartAddCount: 10, asinCartAddCount: 2, asinCartAddShare: 0.2 },
      purchaseData: { totalPurchaseCount: 5, asinPurchaseCount: 1, asinPurchaseShare: 0.2, asinMedianPurchasePrice: { amount: 9.99, currencyCode: 'EUR' } } });
    for (let q = 1; q <= 3; q++) dataByAsin.push(mk(q, q, 100 + q));
    if (dupOn) dataByAsin.push(mk(1, 9, 999)); // 'query 1' a 2nd time in the SAME document: the last occurrence must win
  }
  return Buffer.from(JSON.stringify({ reportSpecification: {}, dataByAsin }));
}
const outcome = (spid, idx) => { const pat = ((SC.perClient || {})[spid]) ?? SC.pattern ?? 'R'; return pat[idx % pat.length]; };

// ---------------------------------------------------------------- stateful sqp_asin_rows (PostgREST on Postgres)
const TB = SC.table || {};
const KEYCOLS = ['selling_partner_id', 'marketplace_id', 'asin', 'report_period', 'start_date', 'search_query'];
const SLICECOLS = KEYCOLS.slice(0, 5);
const COLS = new Set([...KEYCOLS, 'id', 'end_date', 'search_query_score', 'search_query_volume', 'total_query_impression_count', 'asin_impression_count', 'asin_impression_share',
  'total_click_count', 'asin_click_count', 'asin_click_share', 'total_cart_add_count', 'asin_cart_add_count', 'asin_cart_add_share', 'total_purchase_count', 'asin_purchase_count',
  'asin_purchase_share', 'asin_median_purchase_price', 'ingested_at']);
const rowsById = new Map(); const byKey = new Map(); const bySlice = new Map(); const written = new Set();
let nextId = TB.nextId || 1; const tlog = []; S.tpeak = 0;
const keyOf = (r) => KEYCOLS.map((c) => r[c]).join('\u0001');
const sliceOf = (r) => SLICECOLS.map((c) => r[c]).join('|');
function tAdd(r) { rowsById.set(r.id, r); byKey.set(keyOf(r), r); const sk = sliceOf(r); if (!bySlice.has(sk)) bySlice.set(sk, new Set()); bySlice.get(sk).add(r); if (rowsById.size > S.tpeak) S.tpeak = rowsById.size; }
function tDel(r) { rowsById.delete(r.id); byKey.delete(keyOf(r)); bySlice.get(sliceOf(r))?.delete(r); written.delete(r.id); }
for (const r0 of TB.seed || []) {
  const r = { ...r0 }; delete r._w; if (r.id == null) r.id = nextId++; else nextId = Math.max(nextId, r.id + 1);
  if (!r.ingested_at) r.ingested_at = '2026-01-01T00:00:00.000Z';
  if (byKey.has(keyOf(r))) throw new Error('mock: duplicate seed key ' + keyOf(r));
  tAdd(r);
}
const tFault = (SC.table || {}).faults || []; const tFaultN = tFault.map(() => 0);
const tjson = (status, message) => Object.assign(resp(status, { code: String(status), message }), { msg: message });
const delay = (ms, signal) => new Promise((res, rej) => {
  const h = globalThis.setTimeout(res, ms);
  if (signal) { const f = () => { globalThis.clearTimeout(h); rej(signal.reason || new DOMException('aborted', 'AbortError')); }; if (signal.aborted) f(); else signal.addEventListener('abort', f, { once: true }); }
});
function parsePreds(q, e) { // PostgREST filters: <col>=eq.<v> and id=in.(a,b,c); anything else => 400
  const preds = [];
  for (const [k, v] of q) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)) continue;
    if (k === 'id' && /^in\.\(.*\)$/.test(v)) { const list = v.slice(4, -1).split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter((x) => x !== ''); preds.push({ k, in: new Set(list.map(Number)), n: list.length }); }
    else if (COLS.has(k) && /^eq\./.test(v)) preds.push({ k, eq: v.slice(3) });
    else { e.err = `unsupported filter ${k}=${v}`; return null; }
  }
  return preds;
}
const matches = (r, preds) => preds.every((p) => p.in ? p.in.has(r.id) : String(r[p.k]) === p.eq);
async function tableRequest(method, q, opts, signal) {
  const e = { n: tlog.length, t: vnow - START, method, kind: '', status: 0 }; tlog.push(e);
  let out;
  try { out = tableApply(method, q, opts, e); }
  catch (err) { e.status = 599; e.err = String(err && err.message); out = tjson(500, 'mock crash: ' + e.err); }
  e.status = out.status; if (out.status >= 400) e.msg = out.msg; e.rowsAfter = rowsById.size; if (e.slice) e.sliceAfter = (bySlice.get(e.slice) || new Set()).size;
  if (TB.latencyMs) { e.answerT = vnow - START + TB.latencyMs; await delay(TB.latencyMs, signal); }
  return out;
}
function tableApply(method, q, opts, e) {
  const preds = parsePreds(q, e); const spidP = (preds || []).find((p) => p.k === 'selling_partner_id'); const asinP = (preds || []).find((p) => p.k === 'asin');
  const sliceFromPreds = () => { const g = (c) => (preds.find((p) => p.k === c) || {}).eq; return SLICECOLS.every((c) => g(c) !== undefined) ? SLICECOLS.map(g).join('|') : null; };
  let body = null;
  if (method === 'POST') { try { body = JSON.parse(String(opts.body)); } catch { e.kind = 'post'; return tjson(400, 'invalid JSON body'); } if (!Array.isArray(body)) body = [body]; }
  // fault injection (state untouched)
  let fSpid = spidP && spidP.eq, fAsin = asinP && asinP.eq;
  if (method === 'POST' && body.length) { fSpid = body[0].selling_partner_id; fAsin = body[0].asin; }
  let fRow = null;
  if (method === 'DELETE' && preds) { const ip = preds.find((p) => p.in); if (ip) { const r = [...ip.in].map((i) => rowsById.get(i)).find(Boolean); if (r) { fRow = r; fSpid = r.selling_partner_id; fAsin = r.asin; } } }
  for (let i = 0; i < tFault.length; i++) { const f = tFault[i];
    if (f.method !== method || (f.spid && f.spid !== fSpid) || (f.asin && f.asin !== fAsin)) continue;
    tFaultN[i]++; if (f.nth && tFaultN[i] !== f.nth) continue;
    e.injected = true; e.kind = method === 'GET' ? 'get' : method === 'POST' ? 'post' : 'delete'; e.spid = fSpid; e.asin = fAsin;
    if (method === 'GET' && preds) e.slice = sliceFromPreds() || undefined;
    if (method === 'POST') { e.nrows = body.length; e.slice = sliceOf(body[0]); e.queries = body.map((r) => r.search_query); }
    if (method === 'DELETE' && preds) { const ip = preds.find((p) => p.in); e.delKind = ip && preds.length === 1 ? 'ids' : 'slice'; e.reqIds = ip ? [...ip.in] : undefined; e.slice = sliceFromPreds() || (fRow ? sliceOf(fRow) : undefined); }
    return tjson(f.status || 500, 'injected fault');
  }
  if (preds === null) { e.kind = method.toLowerCase(); return tjson(400, e.err); }
  if (method === 'GET') {
    e.kind = 'get'; e.slice = sliceFromPreds() || undefined; e.spid = fSpid; e.asin = fAsin;
    let list = [...rowsById.values()].filter((r) => matches(r, preds));
    const ord = q.get('order') || 'id.asc'; const [oc, od] = ord.split('.'); list.sort((a, b) => (a[oc] < b[oc] ? -1 : a[oc] > b[oc] ? 1 : a.id - b.id) * (od === 'desc' ? -1 : 1));
    let offset = q.has('offset') ? +q.get('offset') : 0; let limit = q.has('limit') ? +q.get('limit') : Infinity;
    const rg = hdr(opts, 'range'); const m = rg && String(rg).match(/^(\d+)-(\d+)$/);
    if (m) { offset = q.has('offset') ? offset : +m[1]; if (!q.has('limit')) limit = +m[2] - +m[1] + 1; }
    const cap = TB.cap || 1000; limit = Math.min(limit, cap);
    const page = list.slice(offset, offset + limit); const sel = (q.get('select') || '*').split(',').map((x) => x.trim());
    const outRows = page.map((r) => sel.includes('*') ? { ...r } : Object.fromEntries(sel.filter((c) => c in r).map((c) => [c, r[c]])));
    e.offset = offset; e.limit = q.has('limit') ? +q.get('limit') : null; e.range = rg || null; e.returned = page.length; e.total = list.length; e.select = q.get('select') || '*';
    e.ids = page.map((r) => r.id); e.queries = page.map((r) => r.search_query);
    return resp(200, outRows);
  }
  if (method === 'DELETE') {
    e.kind = 'delete';
    if (!preds.length) return tjson(400, 'DELETE requires a WHERE clause (no filter given)');
    const ip = preds.find((p) => p.in); if (ip && ip.n === 0) return tjson(400, 'DELETE with an empty id list');
    const hit = [...rowsById.values()].filter((r) => matches(r, preds));
    e.delKind = ip && preds.length === 1 ? 'ids' : (!ip && sliceFromPreds() && preds.length === 5 ? 'slice' : 'other');
    e.nids = ip ? ip.n : 0; e.reqIds = ip ? [...ip.in] : undefined; e.slice = sliceFromPreds() || undefined;
    e.deleted = hit.map((r) => ({ id: r.id, slice: sliceOf(r), sq: r.search_query, w: written.has(r.id) }));
    const sl = new Set(hit.map(sliceOf)); e.slices = [...sl]; if (sl.size === 1) e.slice = e.slice || [...sl][0];
    e.spid = e.deleted[0] ? e.deleted[0].slice.split('|')[0] : undefined; e.asin = e.deleted[0] ? e.deleted[0].slice.split('|')[2] : undefined;
    for (const r of hit) tDel(r);
    return resp(204);
  }
  if (method === 'POST') {
    e.kind = 'post'; e.nrows = body.length; e.spid = body[0] && body[0].selling_partner_id; e.asin = body[0] && body[0].asin;
    const prefer = String(hdr(opts, 'prefer') || ''); const merge = /resolution=merge-duplicates/.test(prefer); const ignore = /resolution=ignore-duplicates/.test(prefer);
    const oc = q.get('on_conflict'); e.upsert = merge && !!oc; e.prefer = prefer; e.onConflict = oc || null;
    e.queries = body.map((r) => r.search_query); e.slices = [...new Set(body.map((r) => sliceOf(r)))]; e.slice = e.slices.length === 1 ? e.slices[0] : undefined;
    if (!body.length) return resp(201);
    const cols = new Set(); for (const r of body) for (const c of Object.keys(r)) cols.add(c);
    for (const c of cols) if (!COLS.has(c) || c === 'id') return tjson(400, `Could not find the '${c}' column of 'sqp_asin_rows' in the schema cache`);
    e.cols = [...cols]; e.hasIngestedAt = cols.has('ingested_at');
    for (const r of body) for (const c of KEYCOLS) if (r[c] === undefined || r[c] === null || r[c] === '') return tjson(400, `null value in column "${c}" violates not-null constraint`);
    if (oc && merge && [...new Set(oc.split(',').map((x) => x.trim()))].sort().join() !== [...KEYCOLS].sort().join()) return tjson(400, 'there is no unique or exclusion constraint matching the ON CONFLICT specification');
    const seen = new Set(); let dupInReq = false; for (const r of body) { const k = keyOf(r); if (seen.has(k)) dupInReq = true; seen.add(k); }
    const upsert = merge && !!oc && !ignore;
    if (upsert && dupInReq) return tjson(500, 'ON CONFLICT DO UPDATE command cannot affect row a second time');
    if (!upsert && !ignore) { // plain insert: any key that already exists (table or same request) => unique violation, nothing is written
      if (dupInReq || body.some((r) => byKey.has(keyOf(r)))) return tjson(409, 'duplicate key value violates unique constraint "sqp_asin_rows_key"');
    }
    const nowIso = new Date(vnow).toISOString(); const outRows = []; e.inserted = 0; e.updated = 0; const done = new Set();
    for (const r of body) {
      const k = keyOf(r); if (done.has(k)) continue; done.add(k); const ex = byKey.get(k);
      if (ex) { if (!upsert) continue; for (const c of cols) ex[c] = r[c] === undefined ? null : r[c]; written.add(ex.id); e.updated++; outRows.push(ex); }
      else { const nr = {}; for (const c of cols) nr[c] = r[c] === undefined ? null : r[c]; if (nr.ingested_at == null && !cols.has('ingested_at')) nr.ingested_at = nowIso; nr.id = nextId++; tAdd(nr); written.add(nr.id); e.inserted++; outRows.push(nr); }
    }
    bump(S.rowsPosted, body[0].selling_partner_id, body.length);
    return /return=representation/.test(prefer) ? resp(201, outRows) : resp(201);
  }
  return tjson(405, 'method not supported by the mock');
}

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
        if (body.reportOptions?.reportPeriod) ((S.sqpPeriods ||= {})[body.reportOptions.reportPeriod + '|' + String(body.dataStartTime).slice(0, 10)] = { period: body.reportOptions.reportPeriod, start: String(body.dataStartTime).slice(0, 10), end: String(body.dataEndTime).slice(0, 10) });
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
      S.ingestQ.push({ url: rest, spid, mk }); let iso = (SC.ingest || {})[spid + '|' + mk];
      if (!iso) for (const r of rowsById.values()) if (r.selling_partner_id === spid && r.marketplace_id === mk && r.ingested_at && (!iso || r.ingested_at > iso)) iso = r.ingested_at;
      return resp(200, iso ? [{ ingested_at: iso }] : []);
    }
    if (table === 'sqp_asin_rows') return tableRequest(method, q, opts, signal);
    if ((table === 'sqp_asin_meta' || table === 'asin_sales_traffic') && method === 'GET') return resp(200, []);
  }
  S.unmocked.push(method + ' ' + url);
  throw new Error(`mock-net-refresh: UNMOCKED request ${method} ${url}`);
};
process.on('exit', () => { S.fakeMin = (vnow - START) / 60000; S.tstart = new RealDate(START).toISOString(); S.tlog = tlog; S.table = { nextId, rows: [...rowsById.values()].sort((a, b) => a.id - b.id).map((r) => written.has(r.id) ? { ...r, _w: true } : r) }; try { fs.writeFileSync(process.env.FAKE_SUMMARY, JSON.stringify(S)); } catch {} });
