// PPC-Audit-Vorladung: generiert fuer alle aktiven Kunden (mit Ads-Profil) die Audit-Reports
// (SP/SB/SD, 30 Tage) und schreibt das aggregierte Ergebnis nach ads_audit_cache.
// Die Audit-Seite laedt daraus SOFORT — kein Warten auf Amazon beim Oeffnen.
// ENV: ADS_CLIENT_ID/SECRET/REFRESH_TOKEN, SUPABASE_URL/SERVICE_KEY
import zlib from 'node:zlib';
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
// Konten laufen PARALLEL (Wartezeit auf Amazon dominiert): Pool + gemeinsames Token, getestet in tests/audit-pool.test.mjs
import { runPool, makeTokenManager } from './audit-pool.mjs';
// Amazon-Business-Auswertung: identische Datei wie ppc-callback/api/_lib/audit-b2b.js (Test vergleicht byteweise)
import { aggregateB2b, b2bBidAdjRows, buildCampaignBids } from './audit-b2b.mjs';
const U = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const CID = process.env.ADS_CLIENT_ID, SEC = process.env.ADS_CLIENT_SECRET, RT = process.env.ADS_REFRESH_TOKEN;
if (!U || !KEY || !CID || !SEC || !RT) { console.error('FEHLER: ENV fehlt.'); process.exit(1); }
const ADS = 'https://advertising-api-eu.amazon.com';
const sbHead = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DAYS = +(process.argv[2] || 30);
// Mehrere Konten gleichzeitig: jede Logzeile bekommt das Kuerzel ihres Workers ([W1]..), damit die Ausgabe lesbar bleibt
const als = new AsyncLocalStorage(); const _log = console.log.bind(console);
console.log = (...a) => { const w = als.getStore(); _log(...(w ? [`[${w}]`, ...a] : a)); };

const DEFS = {
  sp_campaigns: { adProduct: 'SPONSORED_PRODUCTS', reportTypeId: 'spCampaigns', groupBy: ['campaign'], columns: ['campaignId', 'campaignName', 'campaignStatus', 'campaignBudgetAmount', 'impressions', 'clicks', 'cost', 'purchases7d', 'sales7d', 'topOfSearchImpressionShare'] },
  sp_placements: { adProduct: 'SPONSORED_PRODUCTS', reportTypeId: 'spCampaigns', groupBy: ['campaign', 'campaignPlacement'], columns: ['campaignId', 'campaignName', 'placementClassification', 'impressions', 'clicks', 'cost', 'purchases7d', 'sales7d'] },
  sp_targeting: { adProduct: 'SPONSORED_PRODUCTS', reportTypeId: 'spTargeting', groupBy: ['targeting'], columns: ['campaignId', 'campaignName', 'adGroupName', 'targeting', 'keywordType', 'matchType', 'impressions', 'clicks', 'cost', 'purchases7d', 'sales7d'] },
  sp_search_terms: { adProduct: 'SPONSORED_PRODUCTS', reportTypeId: 'spSearchTerm', groupBy: ['searchTerm'], columns: ['searchTerm', 'keyword', 'matchType', 'campaignName', 'impressions', 'clicks', 'cost', 'purchases7d', 'sales7d'] },
  sb_campaigns: { adProduct: 'SPONSORED_BRANDS', reportTypeId: 'sbCampaigns', groupBy: ['campaign'], columns: ['campaignId', 'campaignName', 'campaignStatus', 'impressions', 'clicks', 'cost', 'purchases', 'sales'] },
  sb_search_terms: { adProduct: 'SPONSORED_BRANDS', reportTypeId: 'sbSearchTerm', groupBy: ['searchTerm'], columns: ['searchTerm', 'keywordText', 'matchType', 'campaignName', 'impressions', 'clicks', 'cost', 'purchases', 'sales'] },
  sd_campaigns: { adProduct: 'SPONSORED_DISPLAY', reportTypeId: 'sdCampaigns', groupBy: ['campaign'], columns: ['campaignId', 'campaignName', 'impressions', 'clicks', 'cost', 'purchases', 'sales'] },
};

// Amazon Business (B2B) = FILTER campaignSite=AmazonBusiness auf spCampaigns, groupBy ["campaignPlacement"], max. 31 Tage je Report.
// Gleiche Definitionen wie ppc-callback/api/ads/audit-start.js; optional (Fehlschlag blockiert das Audit nicht).
const B2B_COLS = ['campaignId', 'campaignName', 'placementClassification', 'impressions', 'clicks', 'cost', 'purchases7d', 'sales7d'];
const b2bDef = (win, filtered) => ({ win, adProduct: 'SPONSORED_PRODUCTS', reportTypeId: 'spCampaigns', groupBy: ['campaignPlacement'], columns: B2B_COLS, ...(filtered ? { filters: [{ field: 'campaignSite', values: ['AmazonBusiness'] }] } : {}) });
const B2B_DEFS = { b2b_cur: b2bDef('cur', true), all_cur: b2bDef('cur', false), b2b_prev: b2bDef('prev', true) };
const dayAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

let AT = null;
// EIN gemeinsames Access-Token fuer alle parallelen Worker: wird erst nach 30 Min erneuert (haelt ~60 Min), parallele Aufrufer teilen sich einen Refresh
const ensureToken = makeTokenManager({
  fetchToken: async () => {
    const t = await rfetch('https://api.amazon.co.uk/auth/o2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: RT, client_id: CID, client_secret: SEC }) });
    return (await t.json()).access_token;
  },
});
async function token(force) { AT = await ensureToken(force); }
const hdr = (profileId, ct) => ({ 'Amazon-Advertising-API-ClientId': CID, 'Amazon-Advertising-API-Scope': String(profileId), Authorization: 'Bearer ' + AT, ...(ct ? { 'Content-Type': ct } : {}) });
// fetch mit Retry gegen transiente Netzfehler (der Lauf dauert lange — Verbindungen flappen).
// HARTES 90s-Timeout je Request: ein haengender Socket liess den Lauf 3 Naechte in Folge
// 2h lang ohne jede Ausgabe stehen, bis GitHub ihn abbrach (10.-12.08.).
async function rfetch(url, opts = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { return await fetch(url, { ...opts, signal: AbortSignal.timeout(90000) }); }
    catch (e) { if (i === tries - 1) throw e; await sleep(8000 * (i + 1)); }
  }
}
const sum = (rows, f) => rows.reduce((s, r) => s + (+r[f] || 0), 0);
const agg = (rows, sales, purch) => ({ impressions: sum(rows, 'impressions'), clicks: sum(rows, 'clicks'), spend: sum(rows, 'cost'), sales: sum(rows, sales), orders: sum(rows, purch) });

async function createReports(profileId, deadline = Infinity) {
  const end = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const start = new Date(Date.now() - (DAYS + 1) * 864e5).toISOString().slice(0, 10);
  const ids = {};
  // Reports, die Amazon HART ablehnt (400/403/404): bei einem Konto ohne Sponsored Brands/Display ist das "keine Daten", kein Fehler.
  // Nicht aufzaehlbar (nur ids.__rejected), damit Object.keys(ids) weiterhin nur angelegte Reports enthaelt.
  const rejected = {}; Object.defineProperty(ids, '__rejected', { value: rejected, enumerable: false });
  const WINDOWS = { cur: { start: dayAgo(30), end: dayAgo(1) }, prev: { start: dayAgo(60), end: dayAgo(31) } };
  for (const [k, def] of Object.entries({ ...DEFS, ...B2B_DEFS })) {
    // Zeitlimit je Konto (AUDIT_ACCOUNT_MAX_MIN): bei dauerhaftem 429 koennte das Anlegen allein ~27 Min dauern -- danach wird abgebrochen
    if (Date.now() > deadline) { console.log(`    Zeitlimit je Konto erreicht — ${k} und die übrigen Reports werden nicht mehr angefordert`); break; }
    const { win, ...d } = def; const w = win ? WINDOWS[win] : { start, end };
    for (let a = 0; a < 8; a++) {
      await token(); // billig (Token wird nur bei Alter >20 Min erneuert); bei langen 429-Wartezeiten darf der Token nicht ablaufen
      const r = await rfetch(`${ADS}/reporting/reports`, { method: 'POST', headers: hdr(profileId, 'application/vnd.createasyncreportrequest.v3+json'), body: JSON.stringify({ name: `audit ${k}`, startDate: w.start, endDate: w.end, configuration: { ...d, timeUnit: 'SUMMARY', format: 'GZIP_JSON' } }) });
      if (r.status === 429) { if (Date.now() > deadline) break; await sleep(20000); continue; }
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.reportId) ids[k] = j.reportId;
      else if (r.status === 425) { // Duplicate — Amazon nennt die existierende Report-ID, die nehmen wir
        const m = JSON.stringify(j).match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
        if (m) ids[k] = m[0]; else console.log(`    ${k}: 425 ohne Report-ID`);
      }
      else { console.log(`    ${k}: HTTP ${r.status} ${JSON.stringify(j).slice(0, 120)}`); if ([400, 403, 404].includes(r.status)) rejected[k] = r.status; }
      break;
    }
    await sleep(3000);
  }
  return ids;
}
async function waitAndDownload(profileId, ids, deadline = Infinity) {
  const data = {}; const failed = new Set();
  for (let i = 0; i < 60; i++) {
    // Zeitlimit je Konto: nicht fertige Reports gelten danach als fehlgeschlagen (Konto "degraded", gespeichertes Audit bleibt)
    if (Date.now() > deadline) { console.log('  Zeitlimit je Konto erreicht — Warten auf Amazon abgebrochen'); break; }
    await token(); // billig (Token wird nur bei Alter >20 Min erneuert) -- ein Konto kann lange laufen, AT ist global und wird von allen Workern geteilt
    let allDone = true;
    for (const [k, id] of Object.entries(ids)) {
      if (data[k]) continue;
      if (Date.now() > deadline) { allDone = false; break; } // auch INNERHALB einer Runde (jeder Aufruf kann bei schlechter Verbindung Minuten dauern)
      const r = await rfetch(`${ADS}/reporting/reports/${id}`, { headers: hdr(profileId) });
      const j = r.ok ? await r.json() : {};
      if (j.status === 'COMPLETED' && j.url) {
        try { data[k] = JSON.parse(zlib.gunzipSync(Buffer.from(await (await rfetch(j.url)).arrayBuffer())).toString()); if (!Array.isArray(data[k])) { data[k] = []; failed.add(k); } }
        catch (e) { data[k] = []; failed.add(k); }
      } else if (j.status === 'FAILURE') { data[k] = []; failed.add(k); }
      else allDone = false;
      await sleep(1000);
    }
    if (allDone) break;
    await sleep(20000);
  }
  for (const k of Object.keys(ids)) if (!data[k]) { data[k] = []; failed.add(k); }
  data.__failed = [...failed]; // unlesbar/fehlgeschlagen/nie fertig -- die B2B-Sektion wird dann "nicht verfuegbar"
  return data;
}
// Kampagnenliste (nur LESEN: POST /sp/campaigns/list). map.failed = Liste fehlt oder ist unvollstaendig -> das Konto gilt als "degraded"
// (ein Audit ohne Gebote/Typen/D+-Zeilen wuerde das gute gespeicherte ersetzen). 429/5xx werden vorher ein paar Mal wiederholt.
async function spEntities(profileId, deadline = Infinity) {
  const map = new Map(); const vnd = 'application/vnd.spCampaign.v3+json'; let nt = null;
  // bis zu 100 Seiten (= 50.000 Kampagnen; sehr grosse Konten sind sonst nie vollstaendig), begrenzt durch das Zeitlimit des Kontos
  for (let i = 0; i < 100; i++) {
    if (Date.now() > deadline) { map.failed = true; break; }
    if (i) await sleep(250); // keine Anfrage-Salve gegen die Drosselung
    try { await token(); } catch (e) { map.failed = true; break; } // frisches Token je Seite (lange Listen laufen sonst in ein abgelaufenes)
    const body = { maxResults: 500, stateFilter: { include: ['ENABLED', 'PAUSED'] } }; if (nt) body.nextToken = nt;
    let r = null;
    for (let t = 0; t < 3; t++) {
      try { r = await rfetch(`${ADS}/sp/campaigns/list`, { method: 'POST', headers: { ...hdr(profileId, vnd), Accept: vnd }, body: JSON.stringify(body) }); } catch (e) { r = null; break; }
      if (r.ok || ![429, 500, 502, 503, 504].includes(r.status)) break;
      if (t === 2 || Date.now() > deadline) break; // nach dem letzten Versuch / am Zeitlimit nicht mehr warten
      await sleep(15000 * (t + 1));
    }
    if (!r || !r.ok) { map.failed = true; break; }
    const j = await r.json();
    for (const c of (j.campaigns || [])) map.set(String(c.campaignId), c);
    nt = j.nextToken; if (!nt) break;
  }
  if (nt) map.failed = true; // nach 100 Seiten noch nicht fertig: unvollstaendig
  return map;
}
// identische Aggregation wie ppc-callback /api/ads/audit-fetch
function aggregate(data, entities) {
  const spC = data.sp_campaigns || [], sbC = data.sb_campaigns || [], sdC = data.sd_campaigns || [];
  const formats = {};
  if (spC.length) formats.SP = agg(spC, 'sales7d', 'purchases7d');
  if (sbC.length) formats.SB = agg(sbC, 'sales', 'purchases');
  if (sdC.length) formats.SD = agg(sdC, 'sales', 'purchases');
  const totals = { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0 };
  for (const f of Object.values(formats)) for (const k of Object.keys(totals)) totals[k] += f[k];
  const spAuto = [], spMan = [], spUnknown = [];
  for (const r of spC) { const e = entities.get(String(r.campaignId)); (e ? (e.targetingType === 'AUTO' ? spAuto : spMan) : spUnknown).push(r); }
  const spTypes = {};
  if (spAuto.length) spTypes.auto = { ...agg(spAuto, 'sales7d', 'purchases7d'), campaigns: spAuto.length };
  if (spMan.length) spTypes.manual = { ...agg(spMan, 'sales7d', 'purchases7d'), campaigns: spMan.length };
  if (spUnknown.length) spTypes.unknown = { ...agg(spUnknown, 'sales7d', 'purchases7d'), campaigns: spUnknown.length };
  const plMap = {};
  for (const r of (data.sp_placements || [])) {
    const p = r.placementClassification || '–';
    if (!plMap[p]) plMap[p] = { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0 };
    plMap[p].impressions += +r.impressions || 0; plMap[p].clicks += +r.clicks || 0; plMap[p].spend += +r.cost || 0; plMap[p].sales += +r.sales7d || 0; plMap[p].orders += +r.purchases7d || 0;
  }
  const placements = Object.entries(plMap).map(([placement, v]) => ({ placement, ...v })).sort((a, b) => b.spend - a.spend);
  const PLKEY = { 'Top of Search on-Amazon': 'PLACEMENT_TOP', 'Detail Page on-Amazon': 'PLACEMENT_PRODUCT_PAGE', 'Other on-Amazon': 'PLACEMENT_REST_OF_SEARCH', 'Site Amazon Business': 'SITE_AMAZON_BUSINESS' };
  const byCamp = {};
  for (const r of (data.sp_placements || [])) { (byCamp[String(r.campaignId)] = byCamp[String(r.campaignId)] || []).push(r); }
  const bidAdj = [];
  for (const [cid, rows] of Object.entries(byCamp)) {
    const e = entities.get(cid); if (!e || e.state !== 'ENABLED') continue;
    const cSpend = sum(rows, 'cost'), cSales = sum(rows, 'sales7d');
    if (cSpend < 20) continue;
    const cRoas = cSpend > 0 ? cSales / cSpend : 0;
    const adjOf = p => { const pb = e.dynamicBidding && e.dynamicBidding.placementBidding || []; const hit = pb.find(x => x.placement === p); return hit ? +hit.percentage || 0 : 0; };
    for (const r of rows) {
      const clicks = +r.clicks || 0, spend = +r.cost || 0, sales = +r.sales7d || 0;
      if (clicks < 10) continue;
      const roas = spend > 0 ? sales / spend : 0;
      const plKey = PLKEY[r.placementClassification]; if (!plKey) continue;
      const adj = adjOf(plKey);
      let verdict = null;
      if (roas >= cRoas * 1.2 && adj <= 0 && sales > 0) verdict = 'chance';
      else if (adj > 0 && roas < cRoas * 0.8) verdict = 'problem';
      if (verdict) bidAdj.push({ campaignId: cid, plKey, campaign: r.campaignName, placement: r.placementClassification, adjustment: adj, campRoas: +cRoas.toFixed(2), placRoas: +roas.toFixed(2), clicks, spend: +spend.toFixed(2), sales: +sales.toFixed(2), verdict });
    }
  }
  bidAdj.sort((a, b) => (a.verdict > b.verdict ? 1 : a.verdict < b.verdict ? -1 : b.spend - a.spend));
  // kompakte Zeilenlisten — UI aggregiert selbst (Account-/Kampagnenebene, Wasted-Schwellwerte)
  const r2 = x => +(+x || 0).toFixed(2);
  const pack = (rows, term, sales, purch, cap) => ({
    cols: ['term', 'campaign', 'match', 'impressions', 'clicks', 'spend', 'sales', 'orders'],
    rows: rows.sort((a, b) => (+b[sales] || 0) - (+a[sales] || 0) || (+b.cost || 0) - (+a.cost || 0)).slice(0, cap)
      .map(r => [r[term], r.campaignName || '', r.matchType || r.keywordType || '', +r.impressions || 0, +r.clicks || 0, r2(r.cost), r2(r[sales]), +r[purch] || 0]),
  });
  const active = r => (+r.clicks || 0) > 0 || (+r.sales7d || 0) > 0 || (+r.sales || 0) > 0;
  const spTargets = pack((data.sp_targeting || []).filter(active), 'targeting', 'sales7d', 'purchases7d', 8000);
  const spTerms = pack((data.sp_search_terms || []).filter(r => (+r.clicks || 0) > 0), 'searchTerm', 'sales7d', 'purchases7d', 8000);
  const sbTermRows = pack((data.sb_search_terms || []).filter(r => (+r.clicks || 0) > 0), 'searchTerm', 'sales', 'purchases', 8000);
  const sdCamps = sdC.sort((a, b) => (+b.cost || 0) - (+a.cost || 0)).slice(0, 25)
    .map(r => ({ campaign: r.campaignName, impressions: +r.impressions || 0, clicks: +r.clicks || 0, spend: +(+r.cost || 0).toFixed(2), sales: +(+r.sales || 0).toFixed(2), orders: +r.purchases || 0 }));
  // H: Top-of-Search Impression Share je SP-Kampagne
  // Amazon liefert topOfSearchImpressionShare bereits in PROZENT (0-100, bis 2 Nachkommastellen; Rohdaten-Messung 01.10.2026).
  // Die frueher angenommene Umrechnung "Werte <= 1 mal 100" machte aus 0,62 % faelschlich 62 % -- identisch zu audit-fetch.js.
  const isNorm = v => +(+v).toFixed(2);
  const tosIs = spC.filter(r => r.topOfSearchImpressionShare != null && Number.isFinite(+r.topOfSearchImpressionShare) && (+r.cost || 0) > 0)
    .map(r => ({ campaign: r.campaignName, campaignId: String(r.campaignId), is: isNorm(r.topOfSearchImpressionShare), spend: +(+r.cost || 0).toFixed(2), sales: +(+r.sales7d || 0).toFixed(2), clicks: +r.clicks || 0 }))
    .sort((a, b) => b.spend - a.spend).slice(0, 200);
  return { ready: true, days: DAYS, failed: [], totals, formats, spTypes, placements, bidAdj: bidAdj.slice(0, 40), tosIs, spTargets, spTerms, sbTerms: sbTermRows, sdCampaigns: sdCamps, entities: entities.size, spCampaignCount: spC.length };
}

async function main() {
  await token();
  const cr = await fetch(`${U}/rest/v1/sqp_clients?active=eq.true&ads_profile_id=not.is.null&select=name,spid,ads_profile_id`, { headers: sbHead });
  const clients = await cr.json();
  // Zusaetzlich: Konten frisch halten, die in den letzten 14 Tagen auditiert wurden
  // (einmal warten, danach oeffnet das Audit fuer dieses Konto immer sofort)
  const since = new Date(Date.now() - 14 * 864e5).toISOString();
  const ar = await rfetch(`${U}/rest/v1/ads_audit_cache?days=eq.${DAYS}&updated_at=gte.${encodeURIComponent(since)}&select=profile_id`, { headers: sbHead });
  const cachedIds = ar.ok ? (await ar.json()).map(x => x.profile_id) : [];
  const clientIds = new Set(clients.map(c => String(c.ads_profile_id)));
  for (const pid of cachedIds) if (!clientIds.has(String(pid))) clients.push({ name: `Profil ${pid} (zuletzt auditiert)`, spid: null, ads_profile_id: pid });
  // Reihenfolge: abgestandenster Cache zuerst + hartes Zeitbudget mit sauberem Ende.
  // Der Lauf schaffte nie alle 21 Konten (2h-Abbruch 10.-12.08.) und begann jede Nacht
  // wieder VORNE — dieselben Konten frisch, die hinteren nie. Jetzt rotiert es durch.
  const ageR = await rfetch(`${U}/rest/v1/ads_audit_cache?days=eq.${DAYS}&select=profile_id,updated_at`, { headers: sbHead });
  // Schlaegt die Alters-Abfrage fehl, ist UNBEKANNT, ob ein gespeichertes Audit existiert -> wie 'ja' behandeln (schuetzt gute Eintraege, fail closed)
  const ageKnown = ageR.ok;
  const hasSaved = pid => !ageKnown || !!age.get(String(pid));
  const age = new Map(ageR.ok ? (await ageR.json()).map(x => [String(x.profile_id), x.updated_at]) : []);
  clients.sort((a, b) => String(age.get(String(a.ads_profile_id)) || '').localeCompare(String(age.get(String(b.ads_profile_id)) || '')));
  // Zeitbudget: neue Konten starten nur, solange es reicht; laufende Konten duerfen fertig werden, aber jedes Konto hat sein eigenes Zeitlimit
  // (AUDIT_ACCOUNT_MAX_MIN, 60). Worst Case also ~Budget 150 + ~105 (60 + Nachfristen/Timeouts) + Start/Stagger/Setup < Job-Timeout 300 Min.
  // Vorher: 100 Min und ein Konto nach dem anderen (~25 Min je Konto, fast nur Warten auf Amazon) = nur ~5 von 35 Konten pro Nacht.
  const BUDGET_MIN = +(process.env.AUDIT_BUDGET_MIN || 150);
  const ACC_MIN = +(process.env.AUDIT_ACCOUNT_MAX_MIN || 60);
  const CONC = Math.max(1, +(process.env.AUDIT_CONCURRENCY || 4) || 4);     // gleichzeitige Konten
  const STAGGER_S = Math.max(0, +(process.env.AUDIT_STAGGER_SEC || 45) || 0); // Worker k startet k*45 s spaeter (Amazon drosselt Report-Anlagen)
  // ein Job je Ads-Profil (Kunden koennen sich ein Seller-Konto teilen, Profile sind eindeutig)
  const seen = new Set(), queue = [];
  for (const cl of clients) { const k = String(cl.ads_profile_id); if (seen.has(k)) continue; seen.add(k); queue.push(cl); }
  console.log(`Audit-Vorladung: ${queue.length} Konto/Konten (inkl. zuletzt auditierte), ${DAYS} Tage, Budget ${BUDGET_MIN} Min, ${CONC} parallel`);
  // Nichts zu tun ist kein Erfolg, sondern fast sicher ein Fehler (sqp_clients leer, falscher Filter, fehlende Rechte): nicht gruen und still enden
  if (!queue.length) { console.log('FEHLER: keine Konten zum Aktualisieren gefunden (sqp_clients leer oder nicht lesbar?).'); process.exitCode = 1; return; }
  const refreshOne = async (cl) => {
    console.log(`=== ${cl.name} (${cl.spid}) ===`);
    try {
      await token();
      const deadline = Date.now() + ACC_MIN * 60000; // Zeitlimit dieses Kontos
      const ids = await createReports(cl.ads_profile_id, deadline);
      if (!Object.keys(ids).length) { console.log('  keine Reports erstellt — uebersprungen'); return { status: 'no-reports' }; }
      console.log(`  ${Object.keys(ids).length}/${Object.keys(DEFS).length + Object.keys(B2B_DEFS).length} Reports angefordert, warte auf Amazon…`);
      const data = await waitAndDownload(cl.ads_profile_id, ids, deadline);
      // Die Liste bekommt mindestens 5 Min Nachfrist, auch wenn die Reports das Zeitlimit des Kontos aufgebraucht haben (sonst "scheitert" sie sofort)
      const entities = await spEntities(cl.ads_profile_id, Math.max(deadline, Date.now() + 5 * 60000));
      // Kampagnenliste fehlt/unvollstaendig: NICHT speichern (Konto "degraded"), das gespeicherte vollstaendige Audit bleibt.
      // AUSNAHME: gibt es noch gar kein gespeichertes Audit fuer das Konto, wird das reduzierte (entitiesFailed:true, Hinweis "Audit erneut starten")
      // gespeichert -- besser als nichts, und es ersetzt nichts Gutes.
      if (entities.failed && hasSaved(cl.ads_profile_id)) { console.log('  Kampagnenliste nicht (vollstaendig) geladen — Cache bleibt unveraendert'); return { status: 'degraded', detail: 'Kampagnenliste nicht geladen' }; }
      if (entities.failed) console.log('  Kampagnenliste nicht (vollstaendig) geladen, aber noch kein gespeichertes Audit — reduziertes Audit wird gespeichert');
      const payload = aggregate(data, entities);
      // Kern-Report fehlgeschlagen/unlesbar/nie fertig ODER nie angelegt (429 erschoepft, 5xx, 401, 425 ohne id, Zeitlimit): in beiden Faellen
      // fehlt dem Audit ein Kernbereich -> degradiert, das gespeicherte (gute) Audit bleibt unveraendert.
      // AUSNAHME: ein von Amazon HART abgelehnter (400/403/404) Sponsored-Brands-/Display-Report heisst "keine Daten" (Konto ohne dieses Produkt):
      // der Audit wird ohne diese Sektion gespeichert -- wie beim alten Code, beim Live-Backend und auf der Seite. Sponsored Products muss immer existieren.
      const noData = k => /^(sb|sd)_/.test(k) && ids.__rejected && ids.__rejected[k];
      const coreBad = [...new Set([...(data.__failed || []), ...Object.keys(DEFS).filter(k => !ids[k] && !noData(k))])].filter(k => DEFS[k]);
      payload.failed = [...new Set([...Object.keys(DEFS).filter(k => !ids[k]), ...coreBad])];
      // Amazon Business (optional): gleiche Logik wie audit-fetch.js
      const bad = new Set(data.__failed || []);
      const okB2b = ids.b2b_cur && ids.all_cur && !bad.has('b2b_cur') && !bad.has('all_cur');
      const entitiesFailed = !!entities.failed; /* Kampagnenliste nicht geladen -> Gebote unbekannt (wie audit-fetch.js) */ payload.entitiesFailed = entitiesFailed;
      payload.b2b = entitiesFailed ? { available: false, reason: 'Kampagnenliste (Gebote) konnte nicht geladen werden' } : ids.b2b_cur && ids.all_cur
        ? aggregateB2b({ cur: okB2b ? data.b2b_cur : null, all: okB2b ? data.all_cur : null, prev: ids.b2b_prev && !bad.has('b2b_prev') ? data.b2b_prev : null, entities, windows: { cur: { start: dayAgo(30), end: dayAgo(1) }, prev: { start: dayAgo(60), end: dayAgo(31) } } })
        : { available: false, reason: 'nicht angefordert' };
      // B2B-Ausfall in diesem Lauf: den zuletzt guten Block nicht ueberschreiben, sondern als veraltet markiert behalten
      let savedRow = null; // null = unbekannt (Abfrage fehlgeschlagen), sonst Liste der gespeicherten Zeilen
      if (!payload.b2b.available) {
        try {
          const oc = await rfetch(`${U}/rest/v1/ads_audit_cache?profile_id=eq.${cl.ads_profile_id}&days=eq.${DAYS}&select=payload`, { headers: sbHead });
          const orows = oc.ok ? await oc.json() : [];
          if (oc.ok) savedRow = orows;
          const old = orows[0] && orows[0].payload && orows[0].payload.b2b;
          if (old && old.available) payload.b2b = { ...old, stale: true, staleReason: payload.b2b.reason || '' };
        } catch (e) { /* Carry-over optional */ }
      }
      payload.campaignBids = entitiesFailed ? [] : buildCampaignBids(entities);
      payload.bidAdj = [...payload.bidAdj, ...b2bBidAdjRows(payload.b2b.stale ? { available: false } : payload.b2b)];
      // Groessen-Wache wie audit-fetch.js: Zeilen der grossen Listen halbieren, wenn der Cache-Eintrag > 3,5 MB wuerde
      if (JSON.stringify(payload).length > 3500000) {
        for (const k of ['spTerms', 'spTargets', 'sbTerms']) if (payload[k] && Array.isArray(payload[k].rows)) payload[k].rows = payload[k].rows.slice(0, Math.ceil(payload[k].rows.length / 2));
        payload.truncated = true;
      }
      // Reduziertes Audit (Kampagnenliste fehlt) nur, wenn JETZT sicher keine gespeicherte Zeile existiert (Rennen mit der Live-Seite / fehlgeschlagene Alters-Abfrage)
      if (entitiesFailed && (savedRow === null || savedRow.length)) { console.log('  Kampagnenliste nicht geladen und ein gespeichertes Audit existiert (oder ist nicht pruefbar) — Cache bleibt unveraendert'); return { status: 'degraded', detail: 'Kampagnenliste nicht geladen' }; }
      // Degradiertes Audit (Kern-Report fehlgeschlagen) nie cachen — wuerde ein gutes ueberschreiben (wie audit-fetch.js)
      if (coreBad.length) { console.log(`  Kern-Report(s) fehlgeschlagen (${coreBad.join(', ')}) — Cache bleibt unveraendert`); return { status: 'degraded', detail: coreBad.join(', ') }; }
      const up = await rfetch(`${U}/rest/v1/ads_audit_cache?on_conflict=profile_id,days`, { method: 'POST', headers: { ...sbHead, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ profile_id: String(cl.ads_profile_id), days: DAYS, payload, updated_at: new Date().toISOString() }) });
      console.log(`  Cache: ${up.status} · Spend €${payload.totals.spend.toFixed(0)} · Sales €${payload.totals.sales.toFixed(0)} · Befunde ${payload.bidAdj.length}`);
      // reduziertes Audit (entitiesFailed) ist kein normaler Erfolg: in der Zusammenfassung als Problem melden
      return { status: !up.ok ? 'cache-error' : entitiesFailed ? 'ok-reduced' : 'ok', detail: up.ok ? (entitiesFailed ? 'ohne Kampagnenliste gespeichert' : '') : `HTTP ${up.status}` };
    } catch (e) { console.log('  FEHLER:', e.message); return { status: 'error', detail: e.message }; }
  };
  const res = await runPool(queue, {
    concurrency: CONC, budgetMs: BUDGET_MIN * 60000, staggerMs: STAGGER_S * 1000,
    worker: (cl, i, w) => als.run(`W${w + 1}`, async () => {
      const t1 = Date.now(); const r = await refreshOne(cl);
      console.log(`  -> ${r.status} nach ${((Date.now() - t1) / 60000).toFixed(1)} Min`);
      return r;
    }),
  });
  // Zusammenfassung: bisher stand ein uebersprungener/fehlgeschlagener Konto nur irgendwo mitten im Log
  const okN = [], bad = [];
  res.results.forEach((r, i) => { if (!r) return; const st = r.ok ? r.value : { status: 'error', detail: r.error && r.error.message }; (st.status === 'ok' ? okN : bad).push(`${queue[i].name}: ${st.status}${st.detail ? ' (' + st.detail + ')' : ''}`); });
  const lines = [
    `Audit-Vorladung: ${okN.length} aktualisiert, ${bad.length} NICHT aktualisiert (Fehler/Kern-Report), ${res.skipped.length} nicht gestartet (Zeitbudget ${BUDGET_MIN} Min) von ${queue.length} Konten.`,
    ...bad.map(b => `  ✗ ${b}`),
    ...(res.skipped.length ? [`  Zeitbudget erreicht — nicht gestartet (nächste Nacht zuerst, ältester Cache zuerst): ${res.skipped.map(c => c.name).slice(0, 40).join(', ')}${res.skipped.length > 40 ? ' …' : ''}`] : []),
  ];
  console.log('\n' + lines.join('\n'));
  try { if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### PPC-Audit-Vorladung\n\n' + lines.map(l => l.replace(/^ {2}/, '- ')).join('\n') + '\n'); } catch (e) { /* Zusammenfassung ist optional */ }
  // Der Lauf gilt als FEHLGESCHLAGEN (-> Slack-Alarm des Workflows), wenn kein einziges gestartetes Konto aktualisiert wurde oder mehr als die Haelfte
  // nicht: sonst bleibt ein Totalausfall (Token widerrufen, Amazon-Drosselung, ...) gruen und unbemerkt. Einzelne Ausfaelle sind normal und loesen nichts aus.
  if (res.started > 0 && (okN.length === 0 || bad.length / res.started > 0.5)) {
    process.exitCode = 1;
    console.log(`\nFEHLER: ${bad.length} von ${res.started} gestarteten Konten wurden nicht aktualisiert — Lauf wird als fehlgeschlagen markiert.`);
  }
  console.log('\nFERTIG.');
}
main().catch(e => { console.error('FEHLER', e.message); process.exit(1); });
