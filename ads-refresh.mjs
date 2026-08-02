// Wöchentlicher Ads-Refresh: beworbene Suchbegriffe JE ASIN (für PPC-Lücken).
// Über alle Kunden aus sqp_clients mit ads_profile_id. Zieht spAdvertisedProduct
// (adGroup->ASIN) + spSearchTerm (mit adGroupId), joint, schreibt ads_asin_terms.
// ENV: ADS_CLIENT_ID, ADS_CLIENT_SECRET, ADS_REFRESH_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY
import zlib from 'node:zlib';
const CID = process.env.ADS_CLIENT_ID, SEC = process.env.ADS_CLIENT_SECRET, RT = process.env.ADS_REFRESH_TOKEN;
const U = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const ADS = 'https://advertising-api-eu.amazon.com';
const sbHead = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso = d => d.toISOString().slice(0, 10);
const DAYS = 30; // Ads-Report max 31 Tage
const end = new Date(Date.now() - 864e5), start = new Date(Date.now() - DAYS * 864e5);

let ACCESS;
let ACCESS_T = 0;
async function auth() {
  const t = await fetch('https://api.amazon.co.uk/auth/o2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: RT, client_id: CID, client_secret: SEC }) });
  ACCESS = (await t.json()).access_token; ACCESS_T = Date.now();
}
const freshAuth = async () => { if (Date.now() - ACCESS_T > 50 * 60000) await auth(); }; // Token laeuft nach 60min ab
function H(profile) { return { 'Amazon-Advertising-API-ClientId': CID, 'Amazon-Advertising-API-Scope': String(profile), Authorization: 'Bearer ' + ACCESS, 'Content-Type': 'application/json' }; }
async function pull(profile, reportTypeId, columns) {
  const body = { name: `${reportTypeId} ${Date.now()}`, startDate: iso(start), endDate: iso(end), configuration: { adProduct: 'SPONSORED_PRODUCTS', groupBy: reportTypeId === 'spAdvertisedProduct' ? ['advertiser'] : ['searchTerm'], columns, reportTypeId, timeUnit: 'SUMMARY', format: 'GZIP_JSON' } };
  let cj;
  for (let a = 0; a < 6; a++) { await freshAuth(); const c = await fetch(`${ADS}/reporting/reports`, { method: 'POST', headers: H(profile), body: JSON.stringify(body) }); if (c.status === 429) { await sleep(30000); continue; } cj = await c.json(); if (!cj.reportId) throw new Error(reportTypeId + ' create: ' + JSON.stringify(cj).slice(0, 200)); break; }
  let url = null; for (let i = 0; i < 90; i++) { await sleep(8000); await freshAuth(); const g = await fetch(`${ADS}/reporting/reports/${cj.reportId}`, { headers: H(profile) }); const gj = await g.json(); if (gj.status === 'COMPLETED') { url = gj.url; break; } if (gj.status === 'FAILURE') throw new Error(reportTypeId + ' FAILURE'); }
  if (!url) throw new Error(reportTypeId + ' timeout');
  const raw = await fetch(url); let buf = Buffer.from(await raw.arrayBuffer()); buf = zlib.gunzipSync(buf); return JSON.parse(buf.toString('utf8'));
}
const norm = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
async function refreshProfile(profile) {
  const adv = await pull(profile, 'spAdvertisedProduct', ['campaignId', 'adGroupId', 'advertisedAsin', 'impressions', 'clicks', 'cost']);
  const agToAsins = new Map();
  for (const r of adv) { const k = String(r.adGroupId); if (!agToAsins.has(k)) agToAsins.set(k, new Set()); agToAsins.get(k).add(r.advertisedAsin); }
  const st = await pull(profile, 'spSearchTerm', ['searchTerm', 'adGroupId', 'clicks', 'cost', 'purchases7d', 'sales7d']);
  const agg = new Map();
  for (const r of st) {
    const asins = agToAsins.get(String(r.adGroupId)); if (!asins) continue;
    const term = norm(r.searchTerm); if (!term) continue;
    for (const asin of asins) {
      const k = asin + '||' + term; let e = agg.get(k);
      if (!e) { e = { profile_id: String(profile), asin, search_term: term, clicks: 0, cost: 0, purchases7d: 0, sales7d: 0 }; agg.set(k, e); }
      e.clicks += +r.clicks || 0; e.cost += +r.cost || 0; e.purchases7d += +r.purchases7d || 0; e.sales7d += +r.sales7d || 0;
    }
  }
  const rows = [...agg.values()];
  await fetch(`${U}/rest/v1/ads_asin_terms?profile_id=eq.${profile}`, { method: 'DELETE', headers: sbHead });
  let ins = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    const r = await fetch(`${U}/rest/v1/ads_asin_terms`, { method: 'POST', headers: { ...sbHead, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(chunk) });
    if (r.ok) ins += chunk.length; else { console.log('  INSERT', r.status, (await r.text()).slice(0, 150)); break; }
  }
  console.log(`  ${adv.length} adv / ${st.length} terms / ${agToAsins.size} adGroups -> ${ins} (ASIN×Begriff) geschrieben.`);
}
async function main() {
  if (!CID || !SEC || !RT) { console.log('Ads-Secrets fehlen (ADS_CLIENT_ID/SECRET/REFRESH_TOKEN) — Ads-Refresh übersprungen.'); return; }
  await auth();
  const r = await fetch(`${U}/rest/v1/sqp_clients?active=eq.true&ads_profile_id=not.is.null&select=name,ads_profile_id`, { headers: sbHead });
  const clients = await r.json();
  console.log(`Ads-Refresh: ${clients.length} Kunde(n), Zeitraum ${iso(start)}..${iso(end)}`);
  for (const c of clients) { console.log(`Kunde: ${c.name} (Profil ${c.ads_profile_id})`); try { await refreshProfile(c.ads_profile_id); } catch (e) { console.log('  FEHLER', e.message); } }
  console.log('ADS-REFRESH FERTIG.');
}
main().catch(e => { console.error('FEHLER', e.message); process.exit(1); });
