// Taeglicher Ads-Refresh: beworbene Suchbegriffe JE ASIN (fuer PPC-Luecken).
// Ueber alle Kunden aus sqp_clients mit ads_profile_id. Zieht spAdvertisedProduct
// (adGroup->ASIN) + spSearchTerm (mit adGroupId), joint, schreibt ads_asin_terms.
// Zwei-Phasen (11.09.): ALLE Reports werden zuerst angefordert, Amazon generiert sie
// parallel im Hintergrund; wir holen sie danach in EINEM gemeinsamen Poll-Sweep ab,
// statt Kunde-fuer-Kunde sequenziell auf jeden einzeln zu warten. Grund: Diagnose vom
// 11.09. zeigte 0 von 90 Polls je Kunde waren HTTP 429 — die Reports waren schlicht
// langsamer als das alte 12-Min-Fenster, keine Drosselung. Sequenziell brauchte GENAU
// DESHALB jeder Kunde selbst im Erfolgsfall ~10-12 Min, 22 Kunde x 2 Reports sprengte
// die 355-Min-Job-Grenze. Zwei-Phasen-Muster aus vendor-ads.mjs uebernommen.
// ENV: ADS_CLIENT_ID, ADS_CLIENT_SECRET, ADS_REFRESH_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY
// Optional: ADS_ONLY_PROFILE (nur ein Profil, Diagnose/Einzeltest),
//           ADS_REFRESH_BUDGET_MIN (Wall-Clock-Budget fuer Phase 2, Default 150)
import zlib from 'node:zlib';
const CID = process.env.ADS_CLIENT_ID, SEC = process.env.ADS_CLIENT_SECRET, RT = process.env.ADS_REFRESH_TOKEN;
const U = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const ADS = 'https://advertising-api-eu.amazon.com';
const sbHead = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso = d => d.toISOString().slice(0, 10);
// fetch mit Retry + hartem 90s-Timeout gegen haengende Sockets (siehe audit-refresh.mjs, 10.-12.08.)
async function rfetch(url, opts = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { return await fetch(url, { ...opts, signal: AbortSignal.timeout(90000) }); }
    catch (e) { if (i === tries - 1) throw e; await sleep(8000 * (i + 1)); }
  }
}
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

const REPORT_TYPES = [
  { key: 'spAdvertisedProduct', groupBy: ['advertiser'], columns: ['campaignId', 'adGroupId', 'advertisedAsin', 'impressions', 'clicks', 'cost'] },
  { key: 'spSearchTerm', groupBy: ['searchTerm'], columns: ['searchTerm', 'adGroupId', 'clicks', 'cost', 'purchases7d', 'sales7d'] },
];

// Phase 1: Report nur ANFORDERN (Amazon generiert dann im Hintergrund, parallel fuer
// alle Kunden gleichzeitig). 425 = Amazon nennt die ID eines schon laufenden Reports
// mit identischem Namen — die uebernehmen wir, statt einen neuen anzustossen.
async function createReport(profile, rt) {
  const body = { name: `${rt.key} ${Date.now()}`, startDate: iso(start), endDate: iso(end), configuration: { adProduct: 'SPONSORED_PRODUCTS', groupBy: rt.groupBy, columns: rt.columns, reportTypeId: rt.key, timeUnit: 'SUMMARY', format: 'GZIP_JSON' } };
  for (let a = 0; a < 6; a++) {
    await freshAuth();
    const c = await rfetch(`${ADS}/reporting/reports`, { method: 'POST', headers: H(profile), body: JSON.stringify(body) });
    if (c.status === 429) { await sleep(30000); continue; }
    const j = await c.json();
    if (c.status === 425) { const id = String(j.detail || '').split(':').pop().trim(); if (id) return id; await sleep(25000); continue; }
    if (!j.reportId) throw new Error(`${rt.key} create ${c.status}: ${JSON.stringify(j).slice(0, 160)}`);
    return j.reportId;
  }
  throw new Error(`${rt.key} create: zu viele Versuche`);
}

async function downloadReport(url) {
  const raw = await rfetch(url); let buf = Buffer.from(await raw.arrayBuffer());
  if (buf.length > 200 * 1024 * 1024) throw new Error(`Report zu gross (${Math.round(buf.length / 1048576)} MB komprimiert)`); // OOM-Schutz (Pixxprint)
  buf = zlib.gunzipSync(buf);
  if (buf.length > 800 * 1024 * 1024) throw new Error(`Report zu gross (${Math.round(buf.length / 1048576)} MB)`);
  return JSON.parse(buf.toString('utf8'));
}

const norm = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
// Baut aus den zwei fertigen Rohberichten eines Kunden die (ASIN x Suchbegriff)-Zeilen
// und schreibt sie. Wird NUR aufgerufen, wenn beide Reports wirklich vollstaendig da
// sind (siehe writeIfReady) — DELETE passiert nie ohne vollstaendige neue Daten.
async function writeClient(cl, advRows, stRows) {
  // Gewicht je ASIN in der Anzeigengruppe (Klicks, dahinter Impressionen): der Suchbegriffs-
  // bericht kennt keine ASIN — Vollkopie auf jede ASIN überzählte Spend um Faktor N (12.08.).
  // Gewichtete Aufteilung hält die Summen exakt; die Abdeckung (Zeile existiert) bleibt.
  const agToAsins = new Map(); // adGroupId -> Map(asin -> Gewicht)
  for (const r of advRows) { const k = String(r.adGroupId); if (!agToAsins.has(k)) agToAsins.set(k, new Map()); const m = agToAsins.get(k); m.set(r.advertisedAsin, (m.get(r.advertisedAsin) || 0) + 1000 * (+r.clicks || 0) + (+r.impressions || 0) + 1); }
  const agg = new Map();
  for (const r of stRows) {
    const wmap = agToAsins.get(String(r.adGroupId)); if (!wmap) continue;
    const term = norm(r.searchTerm); if (!term) continue;
    const wtot = [...wmap.values()].reduce((s, x) => s + x, 0) || 1;
    for (const [asin, w] of wmap) {
      const sh = w / wtot;
      const k = asin + '||' + term; let e = agg.get(k);
      if (!e) { e = { profile_id: String(cl.ads_profile_id), asin, search_term: term, clicks: 0, cost: 0, purchases7d: 0, sales7d: 0 }; agg.set(k, e); }
      e.clicks += (+r.clicks || 0) * sh; e.cost += (+r.cost || 0) * sh; e.purchases7d += (+r.purchases7d || 0) * sh; e.sales7d += (+r.sales7d || 0) * sh;
    }
  }
  const rows = [...agg.values()].map(e => ({ ...e, clicks: Math.round(e.clicks), cost: +e.cost.toFixed(2), purchases7d: Math.round(e.purchases7d), sales7d: +e.sales7d.toFixed(2) }));
  await fetch(`${U}/rest/v1/ads_asin_terms?profile_id=eq.${cl.ads_profile_id}`, { method: 'DELETE', headers: sbHead });
  let ins = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    const r = await fetch(`${U}/rest/v1/ads_asin_terms`, { method: 'POST', headers: { ...sbHead, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(chunk) });
    if (r.ok) ins += chunk.length; else { console.log('  INSERT', r.status, (await r.text()).slice(0, 150)); break; }
  }
  console.log(`${cl.name}: ${advRows.length} adv / ${stRows.length} terms / ${agToAsins.size} adGroups -> ${ins} (ASIN×Begriff) geschrieben.`);
}

async function main() {
  if (!CID || !SEC || !RT) { console.log('Ads-Secrets fehlen (ADS_CLIENT_ID/SECRET/REFRESH_TOKEN) — Ads-Refresh übersprungen.'); return; }
  await auth();
  const r = await fetch(`${U}/rest/v1/sqp_clients?active=eq.true&ads_profile_id=not.is.null&select=name,ads_profile_id`, { headers: sbHead });
  let clients = await r.json();
  // Gezielter Einzellauf zum Diagnostizieren, ohne alle Kunden abzuwarten — gleiches
  // Muster wie ads-periodic.mjs.
  if (process.env.ADS_ONLY_PROFILE) clients = clients.filter(c => String(c.ads_profile_id) === String(process.env.ADS_ONLY_PROFILE));
  console.log(`Ads-Refresh: ${clients.length} Kunde(n), Zeitraum ${iso(start)}..${iso(end)}`);

  // Phase 1: ALLE Reports anfordern (je Kunde x Report-Typ) — Amazon generiert sie
  // parallel im Hintergrund, statt dass wir Kunde-fuer-Kunde sequenziell warten.
  const jobs = [];
  for (const cl of clients) for (const rt of REPORT_TYPES) jobs.push({ cl, rt, state: 'neu' });
  console.log(`${jobs.length} Report(s) werden angefordert…`);
  for (const job of jobs) {
    try { job.reportId = await createReport(job.cl.ads_profile_id, job.rt); job.state = 'wartet'; }
    catch (e) { job.state = 'fehler'; console.log(`${job.cl.name} ${job.rt.key}: ${e.message}`); }
    await sleep(400); // Amazon-Create-Kontingent schonen (Muster: vendor-ads.mjs)
  }

  // Ein Kunde wird geschrieben, sobald BEIDE seiner Reports fertig sind (oder
  // endgueltig gescheitert) — nie mit nur einem von beiden (siehe writeClient).
  const written = new Set();
  async function writeIfReady(cl) {
    if (written.has(cl.ads_profile_id)) return;
    const mine = jobs.filter(j => j.cl === cl);
    if (mine.some(j => j.state === 'neu' || j.state === 'wartet')) return;
    written.add(cl.ads_profile_id);
    const adv = mine.find(j => j.rt.key === 'spAdvertisedProduct');
    const st = mine.find(j => j.rt.key === 'spSearchTerm');
    if (adv.state !== 'fertig' || st.state !== 'fertig') { console.log(`${cl.name}: übersprungen (${mine.filter(j => j.state !== 'fertig').map(j => j.rt.key + ':' + j.state).join(', ')}) — alte Daten bleiben stehen.`); return; }
    try { await writeClient(cl, adv.rows, st.rows); } catch (e) { console.log(`${cl.name}: SCHREIB-FEHLER ${e.message}`); }
  }

  // Phase 2: gesammelt abholen. Kein fester Poll-Deckel je Report mehr, sondern ein
  // Wall-Clock-Budget fuer den GANZEN Lauf, damit ads-periodic.mjs danach noch genug
  // Zeit im 355-Min-Job bekommt. 150 Min = derselbe Wert, den vendor-ads.mjs fuer ein
  // vergleichbares Multi-Kunde-Multi-Report-Harvesting bereits nutzt.
  const BUDGET_MIN = +(process.env.ADS_REFRESH_BUDGET_MIN || 150);
  const deadline = Date.now() + BUDGET_MIN * 60000;
  let rateLimited = 0;
  while (jobs.some(j => j.state === 'wartet') && Date.now() < deadline) {
    await freshAuth();
    for (const job of jobs.filter(j => j.state === 'wartet')) {
      try {
        const g = await rfetch(`${ADS}/reporting/reports/${job.reportId}`, { headers: H(job.cl.ads_profile_id) });
        if (g.status === 429) { rateLimited++; await sleep(10000); continue; }
        const gj = await g.json();
        if (gj.status === 'COMPLETED') { job.rows = await downloadReport(gj.url); job.state = 'fertig'; await writeIfReady(job.cl); }
        else if (gj.status === 'FAILURE') { job.state = 'fehler'; console.log(`${job.cl.name} ${job.rt.key}: Report FAILURE`); await writeIfReady(job.cl); }
      } catch (e) { console.log(`${job.cl.name} ${job.rt.key}: ${e.message} (wird erneut versucht)`); } // job bleibt 'wartet' -> naechster Sweep probiert erneut
      await sleep(700);
    }
    if (jobs.some(j => j.state === 'wartet')) await sleep(15000);
  }
  // Budget erreicht: uebrige Reports als gescheitert verbuchen, betroffene Kunden
  // behalten ihre alten Daten (schreiben nie mit nur einem fertigen Report).
  for (const job of jobs.filter(j => j.state === 'wartet')) { job.state = 'fehler'; console.log(`${job.cl.name} ${job.rt.key}: Budget erreicht (${BUDGET_MIN} Min) — noch nicht fertig`); }
  for (const cl of clients) await writeIfReady(cl);

  console.log(`ADS-REFRESH FERTIG. (${rateLimited} Polls ueber den ganzen Lauf waren HTTP 429)`);
}
main().catch(e => { console.error('FEHLER', e.message); process.exit(1); });
