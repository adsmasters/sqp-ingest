// PPC-Audit-Vorladung: generiert fuer alle aktiven Kunden (mit Ads-Profil) die Audit-Reports
// (SP/SB/SD, 30 Tage) und schreibt das aggregierte Ergebnis nach ads_audit_cache.
// Die Audit-Seite laedt daraus SOFORT — kein Warten auf Amazon beim Oeffnen.
// ENV: ADS_CLIENT_ID/SECRET/REFRESH_TOKEN, SUPABASE_URL/SERVICE_KEY
import zlib from 'node:zlib';
const U = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const CID = process.env.ADS_CLIENT_ID, SEC = process.env.ADS_CLIENT_SECRET, RT = process.env.ADS_REFRESH_TOKEN;
if (!U || !KEY || !CID || !SEC || !RT) { console.error('FEHLER: ENV fehlt.'); process.exit(1); }
const ADS = 'https://advertising-api-eu.amazon.com';
const sbHead = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DAYS = +(process.argv[2] || 30);

const DEFS = {
  sp_campaigns: { adProduct: 'SPONSORED_PRODUCTS', reportTypeId: 'spCampaigns', groupBy: ['campaign'], columns: ['campaignId', 'campaignName', 'campaignStatus', 'campaignBudgetAmount', 'impressions', 'clicks', 'cost', 'purchases7d', 'sales7d'] },
  sp_placements: { adProduct: 'SPONSORED_PRODUCTS', reportTypeId: 'spCampaigns', groupBy: ['campaign', 'campaignPlacement'], columns: ['campaignId', 'campaignName', 'placementClassification', 'impressions', 'clicks', 'cost', 'purchases7d', 'sales7d'] },
  sp_targeting: { adProduct: 'SPONSORED_PRODUCTS', reportTypeId: 'spTargeting', groupBy: ['targeting'], columns: ['campaignId', 'campaignName', 'adGroupName', 'targeting', 'keywordType', 'matchType', 'impressions', 'clicks', 'cost', 'purchases7d', 'sales7d'] },
  sp_search_terms: { adProduct: 'SPONSORED_PRODUCTS', reportTypeId: 'spSearchTerm', groupBy: ['searchTerm'], columns: ['searchTerm', 'keyword', 'matchType', 'campaignName', 'impressions', 'clicks', 'cost', 'purchases7d', 'sales7d'] },
  sb_campaigns: { adProduct: 'SPONSORED_BRANDS', reportTypeId: 'sbCampaigns', groupBy: ['campaign'], columns: ['campaignId', 'campaignName', 'campaignStatus', 'impressions', 'clicks', 'cost', 'purchases', 'sales'] },
  sb_search_terms: { adProduct: 'SPONSORED_BRANDS', reportTypeId: 'sbSearchTerm', groupBy: ['searchTerm'], columns: ['searchTerm', 'keywordText', 'matchType', 'campaignName', 'impressions', 'clicks', 'cost', 'purchases', 'sales'] },
  sd_campaigns: { adProduct: 'SPONSORED_DISPLAY', reportTypeId: 'sdCampaigns', groupBy: ['campaign'], columns: ['campaignId', 'campaignName', 'impressions', 'clicks', 'cost', 'purchases', 'sales'] },
};

let AT = null;
async function token() {
  const t = await fetch('https://api.amazon.co.uk/auth/o2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: RT, client_id: CID, client_secret: SEC }) });
  AT = (await t.json()).access_token;
}
const hdr = (profileId, ct) => ({ 'Amazon-Advertising-API-ClientId': CID, 'Amazon-Advertising-API-Scope': String(profileId), Authorization: 'Bearer ' + AT, ...(ct ? { 'Content-Type': ct } : {}) });
// fetch mit Retry gegen transiente Netzfehler (der Lauf dauert lange — Verbindungen flappen)
async function rfetch(url, opts, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { return await fetch(url, opts); }
    catch (e) { if (i === tries - 1) throw e; await sleep(8000 * (i + 1)); }
  }
}
const sum = (rows, f) => rows.reduce((s, r) => s + (+r[f] || 0), 0);
const agg = (rows, sales, purch) => ({ impressions: sum(rows, 'impressions'), clicks: sum(rows, 'clicks'), spend: sum(rows, 'cost'), sales: sum(rows, sales), orders: sum(rows, purch) });

async function createReports(profileId) {
  const end = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const start = new Date(Date.now() - (DAYS + 1) * 864e5).toISOString().slice(0, 10);
  const ids = {};
  for (const [k, d] of Object.entries(DEFS)) {
    for (let a = 0; a < 8; a++) {
      const r = await rfetch(`${ADS}/reporting/reports`, { method: 'POST', headers: hdr(profileId, 'application/vnd.createasyncreportrequest.v3+json'), body: JSON.stringify({ name: `audit ${k}`, startDate: start, endDate: end, configuration: { ...d, timeUnit: 'SUMMARY', format: 'GZIP_JSON' } }) });
      if (r.status === 429) { await sleep(20000); continue; }
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.reportId) ids[k] = j.reportId;
      else if (r.status === 425) { // Duplicate — Amazon nennt die existierende Report-ID, die nehmen wir
        const m = JSON.stringify(j).match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
        if (m) ids[k] = m[0]; else console.log(`    ${k}: 425 ohne Report-ID`);
      }
      else console.log(`    ${k}: HTTP ${r.status} ${JSON.stringify(j).slice(0, 120)}`);
      break;
    }
    await sleep(3000);
  }
  return ids;
}
async function waitAndDownload(profileId, ids) {
  const data = {};
  for (let i = 0; i < 60; i++) {
    let allDone = true;
    for (const [k, id] of Object.entries(ids)) {
      if (data[k]) continue;
      const r = await rfetch(`${ADS}/reporting/reports/${id}`, { headers: hdr(profileId) });
      const j = r.ok ? await r.json() : {};
      if (j.status === 'COMPLETED' && j.url) {
        try { data[k] = JSON.parse(zlib.gunzipSync(Buffer.from(await (await rfetch(j.url)).arrayBuffer())).toString()); }
        catch (e) { data[k] = []; }
      } else if (j.status === 'FAILURE') data[k] = [];
      else allDone = false;
      await sleep(1000);
    }
    if (allDone) break;
    await sleep(20000);
  }
  for (const k of Object.keys(ids)) if (!data[k]) data[k] = [];
  return data;
}
async function spEntities(profileId) {
  const map = new Map(); const vnd = 'application/vnd.spCampaign.v3+json'; let nt = null;
  for (let i = 0; i < 10; i++) {
    const body = { maxResults: 500, stateFilter: { include: ['ENABLED', 'PAUSED'] } }; if (nt) body.nextToken = nt;
    const r = await rfetch(`${ADS}/sp/campaigns/list`, { method: 'POST', headers: { ...hdr(profileId, vnd), Accept: vnd }, body: JSON.stringify(body) });
    if (!r.ok) break; const j = await r.json();
    for (const c of (j.campaigns || [])) map.set(String(c.campaignId), c);
    nt = j.nextToken; if (!nt) break;
  }
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
  const PLKEY = { 'Top of Search on-Amazon': 'PLACEMENT_TOP', 'Detail Page on-Amazon': 'PLACEMENT_PRODUCT_PAGE', 'Other on-Amazon': 'PLACEMENT_REST_OF_SEARCH', 'Site Amazon Business': 'PLACEMENT_SITE_AMAZON_BUSINESS' };
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
  return { ready: true, days: DAYS, failed: [], totals, formats, spTypes, placements, bidAdj: bidAdj.slice(0, 40), spTargets, spTerms, sbTerms: sbTermRows, sdCampaigns: sdCamps, entities: entities.size, spCampaignCount: spC.length };
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
  // ein Job je Ads-Profil (Kunden koennen sich ein Seller-Konto teilen, Profile sind eindeutig)
  const seen = new Set();
  console.log(`Audit-Vorladung: ${clients.length} Konto/Konten (inkl. zuletzt auditierte), ${DAYS} Tage`);
  for (const cl of clients) {
    if (seen.has(cl.ads_profile_id)) continue; seen.add(cl.ads_profile_id);
    console.log(`\n=== ${cl.name} (${cl.spid}) ===`);
    try {
      await token(); // frisches Token je Kunde (Laeufe dauern lange, Access-Token ~60 Min)
      const ids = await createReports(cl.ads_profile_id);
      if (!Object.keys(ids).length) { console.log('  keine Reports erstellt — uebersprungen'); continue; }
      console.log(`  ${Object.keys(ids).length}/${Object.keys(DEFS).length} Reports angefordert, warte auf Amazon…`);
      const data = await waitAndDownload(cl.ads_profile_id, ids);
      const entities = await spEntities(cl.ads_profile_id);
      const payload = aggregate(data, entities);
      payload.failed = Object.keys(DEFS).filter(k => !ids[k]);
      const up = await rfetch(`${U}/rest/v1/ads_audit_cache?on_conflict=profile_id,days`, { method: 'POST', headers: { ...sbHead, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ profile_id: String(cl.ads_profile_id), days: DAYS, payload, updated_at: new Date().toISOString() }) });
      console.log(`  Cache: ${up.status} · Spend €${payload.totals.spend.toFixed(0)} · Sales €${payload.totals.sales.toFixed(0)} · Befunde ${payload.bidAdj.length}`);
      await token(); // Token-Frische fuer den naechsten Kunden
    } catch (e) { console.log('  FEHLER:', e.message); }
  }
  console.log('\nFERTIG.');
}
main().catch(e => { console.error('FEHLER', e.message); process.exit(1); });
