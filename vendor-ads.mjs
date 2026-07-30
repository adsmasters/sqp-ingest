// Vendor-Ads-Import für das Vendor-Reporting (TACoS pro ASIN): SP-Werbekosten
// je Monat & beworbener ASIN -> vra_ads. Über alle vra_clients mit ads_profile_id.
// Quelle: spAdvertisedProduct (exakte Kosten pro ASIN, keine Suchbegriff-Verteilung).
// Nicht zugeordnete Kunden: verfügbare Ads-Profile werden im Log aufgelistet.
// ENV: ADS_CLIENT_ID/SECRET/REFRESH_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY
// Optional: SINCE (YYYY-MM, rückwirkend bis inkl. Monat) oder MONTHS (Anzahl, Default 4).
import zlib from 'node:zlib';
const CID = process.env.ADS_CLIENT_ID, SEC = process.env.ADS_CLIENT_SECRET, RT = process.env.ADS_REFRESH_TOKEN;
const U = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY, ADS = 'https://advertising-api-eu.amazon.com';
if (!CID || !SEC || !RT) { console.log('Ads-Secrets fehlen — Vendor-Ads übersprungen.'); process.exit(0); }
const sbHead = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso = d => d.toISOString().slice(0, 10);

let AT;
async function auth() { const t = await fetch('https://api.amazon.co.uk/auth/o2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: RT, client_id: CID, client_secret: SEC }) }); AT = (await t.json()).access_token; }
const H = profile => ({ 'Amazon-Advertising-API-ClientId': CID, ...(profile ? { 'Amazon-Advertising-API-Scope': String(profile) } : {}), Authorization: 'Bearer ' + AT, 'Content-Type': 'application/json' });

function months() {
  const since = (process.env.SINCE || '').trim();          // YYYY-MM, hat Vorrang
  const nm = +(process.env.MONTHS || 4);
  const now = new Date(); const out = [];
  const first = since ? new Date(Date.UTC(+since.slice(0, 4), +since.slice(5, 7) - 1, 1))
                      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - nm, 1));
  for (let d = first; ; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const e = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    if (e >= new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))) break; // nur komplette Monate
    out.push({ start: iso(d), end: iso(e) });
  }
  return out;
}

async function pull(profile, startDate, endDate) {
  const columns = ['campaignId', 'adGroupId', 'advertisedAsin', 'impressions', 'clicks', 'cost', 'purchases7d', 'sales7d', 'unitsSoldClicks7d'];
  let cj;
  for (let a = 0; a < 6; a++) {
    const body = { name: `vendorAds ${startDate} ${a}`, startDate, endDate, configuration: { adProduct: 'SPONSORED_PRODUCTS', groupBy: ['advertiser'], columns, reportTypeId: 'spAdvertisedProduct', timeUnit: 'SUMMARY', format: 'GZIP_JSON' } };
    const c = await fetch(`${ADS}/reporting/reports`, { method: 'POST', headers: H(profile), body: JSON.stringify(body) });
    if (c.status === 429) { await sleep(30000); continue; }
    const j = await c.json();
    if (c.status === 425) { const id = String(j.detail || '').split(':').pop().trim(); if (id) { cj = { reportId: id }; break; } await sleep(25000); continue; }
    if (c.status === 400) { const m = String(j.detail || '').match(/data retention start date \((\d{4}-\d{2}-\d{2})\)/); if (m && m[1] > startDate) { if (m[1] > endDate) return null; startDate = m[1]; continue; } }
    cj = j; if (!cj.reportId) throw new Error('create ' + c.status + ': ' + JSON.stringify(cj).slice(0, 160)); break;
  }
  if (!cj || !cj.reportId) throw new Error('create fehlgeschlagen');
  let url = null;
  for (let i = 0; i < 120; i++) { await sleep(8000); const g = await fetch(`${ADS}/reporting/reports/${cj.reportId}`, { headers: H(profile) }); const gj = await g.json(); if (gj.status === 'COMPLETED') { url = gj.url; break; } if (gj.status === 'FAILURE') throw new Error('report FAILURE'); }
  if (!url) throw new Error('report timeout');
  const raw = await fetch(url); let buf = Buffer.from(await raw.arrayBuffer()); buf = zlib.gunzipSync(buf); return JSON.parse(buf.toString('utf8'));
}

// Monat überspringen nur, wenn er schon mit DEMSELBEN Profil importiert wurde —
// bei Profilwechsel (z. B. Seller- statt Vendor-Werbekonto erwischt) wird neu importiert.
async function monthState(clientId, m, profile) {
  const r = await fetch(`${U}/rest/v1/vra_ads?client_id=eq.${clientId}&period_start=eq.${m}&select=profile_id&limit=1`, { headers: sbHead });
  const rows = await r.json();
  if (!Array.isArray(rows) || !rows.length) return 'fehlt';
  return rows[0].profile_id === String(profile) ? 'aktuell' : 'profilwechsel';
}

async function listProfiles() {
  try {
    const r = await fetch(`${ADS}/v2/profiles`, { headers: H(null) });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch {}
    if (!Array.isArray(j)) { console.log(`Profil-Liste: HTTP ${r.status} — ${txt.slice(0, 200)}`); return []; }
    if (!j.length) console.log('Profil-Liste: HTTP 200, aber leer.');
    return j;
  } catch (e) { console.log('Profil-Liste: FEHLER ' + e.message); return []; }
}

async function syncProfiles() {
  // Profil-Liste nach vra_ads_profiles spiegeln — fürs Dropdown im Kunden-Modal
  const profs = await listProfiles();
  if (!profs.length) return profs;
  const rows = profs.map(p => ({ profile_id: String(p.profileId), name: (p.accountInfo || {}).name || null, country: p.countryCode || null, currency: p.currencyCode || null, updated_at: new Date().toISOString() }));
  const r = await fetch(`${U}/rest/v1/vra_ads_profiles?on_conflict=profile_id`, { method: 'POST', headers: { ...sbHead, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
  console.log(r.ok ? `${rows.length} Ads-Profile nach vra_ads_profiles gespiegelt.` : `vra_ads_profiles: ${r.status} ${(await r.text()).slice(0, 120)}`);
  return profs;
}

async function main() {
  await auth();
  const cr = await fetch(`${U}/rest/v1/vra_clients?select=id,name,ads_profile_id`, { headers: sbHead });
  const all = await cr.json();
  const clients = all.filter(c => c.ads_profile_id);
  const unmapped = all.filter(c => !c.ads_profile_id);
  const profs = await syncProfiles();
  if (unmapped.length) {
    console.log(`Ohne Ads-Profil: ${unmapped.map(c => c.name).join(', ')}`);
    if (profs.length) { console.log('Verfügbare Ads-Profile (ID — Name — Land):'); for (const p of profs) console.log(`  ${p.profileId} — ${(p.accountInfo || {}).name || '?'} — ${p.countryCode}`); }
  }
  const ms = months();
  console.log(`Vendor-Ads: ${clients.length} Kunde(n), ${ms.length} Monat(e) [${ms.length ? ms[0].start + ' … ' + ms[ms.length - 1].end : '-'}]`);
  for (const cl of clients) {
    console.log(`Kunde: ${cl.name} (Profil ${cl.ads_profile_id})`);
    const last = ms[ms.length - 1];
    for (const m of ms) {
      try {
        // Vergangene Monate überspringen, wenn schon mit diesem Profil importiert (letzter Monat wird aktualisiert)
        const st = await monthState(cl.id, m.start, cl.ads_profile_id);
        if (m !== last && st === 'aktuell') { console.log(`  ${m.start}: schon da`); continue; }
        if (st === 'profilwechsel') console.log(`  ${m.start}: Profil geändert -> wird neu importiert`);
        const rows = await pull(cl.ads_profile_id, m.start, m.end);
        if (rows === null) { console.log(`  ${m.start}: außerhalb der Ads-Datenaufbewahrung`); continue; }
        const agg = new Map();
        for (const r of rows) {
          const asin = (r.advertisedAsin || '').toUpperCase(); if (!asin) continue;
          let e = agg.get(asin);
          if (!e) { e = { client_id: cl.id, profile_id: String(cl.ads_profile_id), asin, period_start: m.start, period_end: m.end, impressions: 0, clicks: 0, cost: 0, ad_orders: 0, ad_sales: 0, ad_units: 0 }; agg.set(asin, e); }
          e.impressions += +r.impressions || 0; e.clicks += +r.clicks || 0; e.cost += +r.cost || 0;
          e.ad_orders += +r.purchases7d || 0; e.ad_sales += +r.sales7d || 0; e.ad_units += +r.unitsSoldClicks7d || 0;
        }
        await fetch(`${U}/rest/v1/vra_ads?client_id=eq.${cl.id}&period_start=eq.${m.start}`, { method: 'DELETE', headers: sbHead });
        const vals = [...agg.values()];
        let ins = 0;
        for (let i = 0; i < vals.length; i += 500) {
          const chunk = vals.slice(i, i + 500);
          const w = await fetch(`${U}/rest/v1/vra_ads`, { method: 'POST', headers: { ...sbHead, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(chunk) });
          if (w.ok) ins += chunk.length; else { console.log('  INSERT', w.status, (await w.text()).slice(0, 150)); break; }
        }
        console.log(`  ${m.start}: ${rows.length} Report-Zeilen -> ${ins} ASINs`);
      } catch (e) { console.log(`  ${m.start}: FEHLER ${e.message} -> weiter`); }
    }
  }
  console.log('FERTIG.');
}
main().catch(e => { console.error('FEHLER', e.message); process.exit(1); });
