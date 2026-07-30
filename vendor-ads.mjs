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

// Report-Konfigurationen je Werbetyp. SB kennt keine Kosten pro ASIN (ein Banner
// bewirbt mehrere Produkte) und wird deshalb als Konto-Summe importiert (_SB_TOTAL_).
const REPORT_TYPES = [
  { key: 'SP', adProduct: 'SPONSORED_PRODUCTS', reportTypeId: 'spAdvertisedProduct', groupBy: ['advertiser'],
    tries: [['campaignId', 'adGroupId', 'advertisedAsin', 'impressions', 'clicks', 'cost', 'purchases7d', 'sales7d', 'unitsSoldClicks7d']],
    asin: r => r.advertisedAsin, m: r => ({ purchases: r.purchases7d, sales: r.sales7d, units: r.unitsSoldClicks7d }) },
  { key: 'SD', adProduct: 'SPONSORED_DISPLAY', reportTypeId: 'sdAdvertisedProduct', groupBy: ['advertiser'],
    tries: [['campaignId', 'adGroupId', 'promotedAsin', 'impressions', 'clicks', 'cost', 'purchases', 'sales', 'unitsSold'],
            ['campaignId', 'adGroupId', 'promotedAsin', 'impressions', 'clicks', 'cost', 'purchasesClicks', 'salesClicks', 'unitsSoldClicks']],
    asin: r => r.promotedAsin, m: r => ({ purchases: r.purchases ?? r.purchasesClicks, sales: r.sales ?? r.salesClicks, units: r.unitsSold ?? r.unitsSoldClicks }) },
  { key: 'SB', adProduct: 'SPONSORED_BRANDS', reportTypeId: 'sbCampaigns', groupBy: ['campaign'],
    tries: [['campaignId', 'impressions', 'clicks', 'cost', 'purchases', 'sales'],
            ['campaignId', 'impressions', 'clicks', 'cost', 'purchasesClicks', 'salesClicks']],
    asin: () => '_SB_TOTAL_', m: r => ({ purchases: r.purchases ?? r.purchasesClicks, sales: r.sales ?? r.salesClicks, units: 0 }) },
];

// Phase 1: Report nur ANFORDERN (Amazon generiert dann parallel). Liefert
// {reportId} oder null (Monat außerhalb der Datenaufbewahrung); probiert die
// Spalten-Varianten des Report-Typs durch.
async function createReport(profile, rt, startDate, endDate) {
  for (const columns of rt.tries) {
    let badColumns = false;
    for (let a = 0; a < 8; a++) {
      const body = { name: `vendorAds ${rt.key} ${startDate}`, startDate, endDate, configuration: { adProduct: rt.adProduct, groupBy: rt.groupBy, columns, reportTypeId: rt.reportTypeId, timeUnit: 'SUMMARY', format: 'GZIP_JSON' } };
      const c = await fetch(`${ADS}/reporting/reports`, { method: 'POST', headers: H(profile), body: JSON.stringify(body) });
      if (c.status === 429) { await sleep(15000); continue; }
      const j = await c.json();
      if (c.status === 425) { const id = String(j.detail || '').split(':').pop().trim(); if (id) return { reportId: id }; await sleep(15000); continue; }
      if (c.status === 400) {
        const m = String(j.detail || '').match(/data retention start date \((\d{4}-\d{2}-\d{2})\)/);
        if (m && m[1] > startDate) { if (m[1] > endDate) return null; startDate = m[1]; continue; }
        if (/column|invalid|unknown|not supported/i.test(JSON.stringify(j))) { badColumns = true; break; }
      }
      if (!j.reportId) throw new Error(`${rt.key} create ${c.status}: ${JSON.stringify(j).slice(0, 160)}`);
      return { reportId: j.reportId };
    }
    if (!badColumns) throw new Error(`${rt.key} create: zu viele Versuche`);
  }
  throw new Error(`${rt.key}: keine gültige Spalten-Variante`);
}

async function downloadReport(url) {
  const raw = await fetch(url);
  const buf = zlib.gunzipSync(Buffer.from(await raw.arrayBuffer()));
  return JSON.parse(buf.toString('utf8'));
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

  // Phase 1: Arbeitsliste bauen und ALLE Reports anfordern — Amazon generiert parallel.
  const last = ms[ms.length - 1];
  const jobs = []; // je (Kunde × Monat × Report-Typ)
  for (const cl of clients) {
    for (const m of ms) {
      const st = await monthState(cl.id, m.start, cl.ads_profile_id);
      if (m !== last && st === 'aktuell') { console.log(`${cl.name} ${m.start}: schon da`); continue; }
      if (st === 'profilwechsel') console.log(`${cl.name} ${m.start}: Profil geändert -> wird neu importiert`);
      for (const rt of REPORT_TYPES) jobs.push({ cl, m, rt, state: 'neu' });
    }
  }
  console.log(`${jobs.length} Report(s) werden angefordert…`);
  for (const job of jobs) {
    try {
      const r = await createReport(job.cl.ads_profile_id, job.rt, job.m.start, job.m.end);
      if (!r) { job.state = 'retention'; } else { job.reportId = r.reportId; job.state = 'wartet'; }
    } catch (e) { job.state = 'fehler'; console.log(`${job.cl.name} ${job.m.start} ${job.rt.key}: ${e.message}`); }
    await sleep(400); // Amazon-Rate-Limit schonen
  }

  // Ein Monat wird geschrieben, sobald alle seine Report-Typen abgeschlossen sind.
  const written = new Set();
  async function writeMonthIfReady(cl, m) {
    const mk = cl.id + '|' + m.start;
    if (written.has(mk)) return;
    const mine = jobs.filter(j => j.cl === cl && j.m === m);
    if (mine.some(j => j.state === 'neu' || j.state === 'wartet')) return;
    written.add(mk);
    const done = mine.filter(j => j.state === 'fertig');
    if (!done.length) {
      console.log(`${cl.name} ${m.start}: ${mine.every(j => j.state === 'retention') ? 'außerhalb der Ads-Datenaufbewahrung' : 'keine Daten (alle Reports fehlgeschlagen)'}`);
      return;
    }
    const agg = new Map();
    for (const job of done) {
      for (const r of job.rows) {
        const asin = (job.rt.asin(r) || '').toUpperCase(); if (!asin) continue;
        let e = agg.get(asin);
        if (!e) { e = { client_id: cl.id, profile_id: String(cl.ads_profile_id), asin, period_start: m.start, period_end: m.end, impressions: 0, clicks: 0, cost: 0, ad_orders: 0, ad_sales: 0, ad_units: 0 }; agg.set(asin, e); }
        const mm = job.rt.m(r);
        e.impressions += +r.impressions || 0; e.clicks += +r.clicks || 0; e.cost += +r.cost || 0;
        e.ad_orders += +mm.purchases || 0; e.ad_sales += +mm.sales || 0; e.ad_units += +mm.units || 0;
      }
      job.rows = null; // Speicher freigeben
    }
    await fetch(`${U}/rest/v1/vra_ads?client_id=eq.${cl.id}&period_start=eq.${m.start}`, { method: 'DELETE', headers: sbHead });
    const vals = [...agg.values()];
    let ins = 0;
    for (let i = 0; i < vals.length; i += 500) {
      const chunk = vals.slice(i, i + 500);
      const w = await fetch(`${U}/rest/v1/vra_ads`, { method: 'POST', headers: { ...sbHead, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(chunk) });
      if (w.ok) ins += chunk.length; else { console.log('  INSERT', w.status, (await w.text()).slice(0, 150)); break; }
    }
    console.log(`${cl.name} ${m.start}: ${ins} Zeilen (${done.map(j => j.rt.key).join('+')})`);
  }

  // Phase 2: Alle angeforderten Reports gesammelt abholen (Laufzeit = langsamster Report).
  const deadline = Date.now() + 150 * 60 * 1000;
  while (jobs.some(j => j.state === 'wartet') && Date.now() < deadline) {
    for (const job of jobs.filter(j => j.state === 'wartet')) {
      try {
        const g = await fetch(`${ADS}/reporting/reports/${job.reportId}`, { headers: H(job.cl.ads_profile_id) });
        if (g.status === 429) { await sleep(10000); continue; }
        const gj = await g.json();
        if (gj.status === 'COMPLETED') { job.rows = await downloadReport(gj.url); job.state = 'fertig'; await writeMonthIfReady(job.cl, job.m); }
        else if (gj.status === 'FAILURE') { job.state = 'fehler'; console.log(`${job.cl.name} ${job.m.start} ${job.rt.key}: Report FAILURE`); await writeMonthIfReady(job.cl, job.m); }
      } catch (e) { console.log(`${job.cl.name} ${job.m.start} ${job.rt.key}: ${e.message}`); }
      await sleep(700);
    }
    if (jobs.some(j => j.state === 'wartet')) await sleep(15000);
  }
  // Zeitüberschreitung: übrig gebliebene Reports abschreiben, Monate mit Teildaten trotzdem schreiben
  for (const job of jobs.filter(j => j.state === 'wartet')) { job.state = 'fehler'; console.log(`${job.cl.name} ${job.m.start} ${job.rt.key}: Timeout`); }
  for (const job of jobs) await writeMonthIfReady(job.cl, job.m);
  console.log('FERTIG.');
}
main().catch(e => { console.error('FEHLER', e.message); process.exit(1); });
