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

let AT, AT_TIME = 0;
async function auth() { const t = await fetch('https://api.amazon.co.uk/auth/o2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: RT, client_id: CID, client_secret: SEC }) }); AT = (await t.json()).access_token; AT_TIME = Date.now(); }
// LwA-Token hält nur 60 Min — bei langen Läufen rechtzeitig erneuern
async function ensureAuth() { if (Date.now() - AT_TIME > 45 * 60 * 1000) await auth(); }
const H = profile => ({ 'Amazon-Advertising-API-ClientId': CID, ...(profile ? { 'Amazon-Advertising-API-Scope': String(profile) } : {}), Authorization: 'Bearer ' + AT, 'Content-Type': 'application/json' });

function months() {
  const since = (process.env.SINCE || '').trim();          // YYYY-MM, hat Vorrang
  const nm = +(process.env.MONTHS || 4);
  const now = new Date(); const out = [];
  const first = since ? new Date(Date.UTC(+since.slice(0, 4), +since.slice(5, 7) - 1, 1))
                      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - nm, 1));
  for (let d = first; ; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const e = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    if (e >= new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))) break; // komplette Monate
    out.push({ start: iso(d), end: iso(e) });
  }
  // Laufender Monat als Teilmonat (bis gestern) — wird als letzter Eintrag bei
  // jedem Lauf ersetzt, damit TACoS auch für den aktuellen Monat Daten hat.
  const curStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const yest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  if (yest >= curStart) out.push({ start: iso(curStart), end: iso(yest) });
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
  await ensureAuth();
  const wantedStart = startDate; // merkt, ob die Aufbewahrungsgrenze den Zeitraum verkuerzt hat ("clipped")
  for (const columns of rt.tries) {
    let badColumns = false;
    for (let a = 0; a < 8; a++) {
      const body = { name: `vendorAds ${rt.key} ${startDate}`, startDate, endDate, configuration: { adProduct: rt.adProduct, groupBy: rt.groupBy, columns, reportTypeId: rt.reportTypeId, timeUnit: 'SUMMARY', format: 'GZIP_JSON' } };
      const c = await fetch(`${ADS}/reporting/reports`, { method: 'POST', headers: H(profile), body: JSON.stringify(body) });
      if (c.status === 429) { await sleep(15000); continue; }
      const j = await c.json();
      if (c.status === 425) { const id = String(j.detail || '').split(':').pop().trim(); if (id) return { reportId: id, clipped: startDate > wantedStart }; await sleep(15000); continue; }
      if (c.status === 400) {
        const m = String(j.detail || '').match(/data retention start date \((\d{4}-\d{2}-\d{2})\)/);
        if (m && m[1] > startDate) { if (m[1] > endDate) return null; startDate = m[1]; continue; }
        if (/column|invalid|unknown|not supported/i.test(JSON.stringify(j))) { badColumns = true; break; }
      }
      if (!j.reportId) { const err = new Error(`${rt.key} create ${c.status}: ${JSON.stringify(j).slice(0, 160)}`); err.permanent = c.status >= 400 && c.status < 500; throw err; } // 4xx = dauerhaft (z. B. 403 "kein SB/SD fuer dieses Konto"), 5xx = vorubergehend
      return { reportId: j.reportId, clipped: startDate > wantedStart };
    }
    if (!badColumns) throw new Error(`${rt.key} create: zu viele Versuche`);
  }
  const noCols = new Error(`${rt.key}: keine gültige Spalten-Variante`); noCols.permanent = true; throw noCols;
}

async function downloadReport(url) {
  const raw = await fetch(url);
  const buf = zlib.gunzipSync(Buffer.from(await raw.arrayBuffer()));
  return JSON.parse(buf.toString('utf8'));
}

// Monat überspringen nur, wenn er schon mit DEMSELBEN Profil und VOLLSTÄNDIG
// importiert wurde — bei Profilwechsel oder wenn nur ein Teilmonat gespeichert
// ist (z. B. Juli während des Monats importiert), wird neu importiert.
// Beurteilt den GANZEN Monat, nicht eine beliebige Zeile: die Zeile mit dem aeltesten period_end entscheidet ueber
// "Teilmonat", und jede Zeile mit anderem Profil macht es zum Profilwechsel. Sonst koennte ein uebrig gebliebener
// alter Teil (z. B. nach abgebrochenem Schreiben/Loeschen) hinter einer neuen Zeile verborgen bleiben und der
// Monat fuer immer als "aktuell" gelten (Doppel-/Altdaten).
async function monthState(clientId, m, profile, monthEnd) {
  const q = `${U}/rest/v1/vra_ads?client_id=eq.${clientId}&period_start=eq.${m}&select=profile_id,period_end`;
  const rows = await (await fetch(`${q}&order=period_end.asc&limit=1`, { headers: sbHead })).json();
  if (!Array.isArray(rows) || !rows.length) return 'fehlt';
  if (rows[0].profile_id !== String(profile)) return 'profilwechsel';
  const other = await (await fetch(`${q}&profile_id=neq.${profile}&limit=1`, { headers: sbHead })).json();
  if (Array.isArray(other) && other.length) return 'profilwechsel';
  return rows[0].period_end < monthEnd ? 'teilmonat' : 'aktuell';
}

// Alle vra_ads-Zeilen (id, asin) eines Kunden-Monats (seitenweise bis zur leeren Seite, unabhaengig vom Server-max-rows)
async function adsOldRows(clientId, periodStart) {
  const out = [];
  for (let from = 0; ;) {
    const r = await fetch(`${U}/rest/v1/vra_ads?client_id=eq.${clientId}&period_start=eq.${periodStart}&select=id,asin&order=id.asc&limit=1000&offset=${from}`, { headers: sbHead });
    if (!r.ok) throw new Error(`vra_ads lesen ${r.status}`);
    const rows = await r.json(); if (!Array.isArray(rows) || !rows.length) break;
    out.push(...rows); from += rows.length;
  }
  return out;
}
async function deleteAdsIds(ids) {
  for (let i = 0; i < ids.length; i += 50) {
    const d = await fetch(`${U}/rest/v1/vra_ads?id=in.(${ids.slice(i, i + 50).join(',')})`, { method: 'DELETE', headers: sbHead });
    if (!d.ok) throw new Error(`vra_ads loeschen ${d.status}`);
  }
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
      const st = await monthState(cl.id, m.start, cl.ads_profile_id, m.end);
      if (m !== last && st === 'aktuell') { console.log(`${cl.name} ${m.start}: schon da`); continue; }
      if (st === 'profilwechsel') console.log(`${cl.name} ${m.start}: Profil geändert -> wird neu importiert`);
      if (st === 'teilmonat') console.log(`${cl.name} ${m.start}: bisher Teilmonat -> wird vervollständigt`);
      for (const rt of REPORT_TYPES) jobs.push({ cl, m, rt, state: 'neu' });
    }
  }
  console.log(`${jobs.length} Report(s) werden angefordert…`);
  for (const job of jobs) {
    try {
      const r = await createReport(job.cl.ads_profile_id, job.rt, job.m.start, job.m.end);
      if (!r) { job.state = 'retention'; } else { job.reportId = r.reportId; job.clipped = !!r.clipped; job.state = 'wartet'; }
    } catch (e) {
      // Ein DAUERHAFTER Fehler (HTTP 4xx / keine gueltige Spaltenvariante) beim Anfordern von SD oder SB heisst: dieses Konto hat
      // das Werbeprodukt nicht bzw. keinen Zugriff darauf — kein Grund, den ganzen Monat (SP) zu blockieren. Nur SP ist unverzichtbar.
      if (e.permanent && job.rt.key !== 'SP') { job.state = 'unavailable'; console.log(`${job.cl.name} ${job.m.start} ${job.rt.key}: nicht verfuegbar fuer dieses Konto (${e.message.slice(0, 120)}) — Monat wird ohne ${job.rt.key} gespeichert.`); }
      else { job.state = 'fehler'; console.log(`${job.cl.name} ${job.m.start} ${job.rt.key}: ${e.message}`); }
    }
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
    // Ein Monat wird nur gespeichert/ersetzt, wenn er VOLLSTAENDIG ist. Ein einmal gespeicherter Monat gilt sonst als
    // "aktuell" und wird nie wieder geholt — unvollstaendige Daten (z. B. ohne SP, der einzigen Quelle der Kosten je ASIN)
    // blieben dauerhaft stehen und verfaelschten TACoS; ausserdem koennten sie vollstaendige Altdaten ersetzen.
    // Nicht gespeichert -> bleibt "fehlt"/"Teilmonat" und wird beim naechsten Lauf erneut versucht.
    const spJob = mine.find(j => j.rt.key === 'SP');
    const failedKeys = mine.filter(j => j.state === 'fehler').map(j => j.rt.key);
    if (!spJob || spJob.state !== 'fertig') { console.log(`${cl.name} ${m.start}: SP-Bericht fehlt — Monat nicht gespeichert, vorhandene Zeilen bleiben unveraendert (naechster Lauf versucht es erneut).`); return; }
    // Ausnahme (19.11.2026): der LAUFENDE Monat wird ohnehin JEDEN Tag neu geholt — faellt nur SB oder SD aus (z. B. Amazon drosselt die SB-Berichtsanfrage:
    // "SB create: zu viele Versuche", in der ersten Nacht bei 3 von 8 Kunden), heilt das am naechsten Tag von selbst. Dann wird mit SP (+was fertig ist)
    // gespeichert; eine gespeicherte SB-Kontosumme bleibt dank keepSb unten stehen. Abgeschlossene Vormonate bleiben streng (werden nie wieder geholt).
    const partialMonth = m.end < iso(new Date(Date.UTC(+m.start.slice(0, 4), +m.start.slice(5, 7), 0)));
    if (failedKeys.length && !partialMonth) { console.log(`${cl.name} ${m.start}: Bericht(e) ${failedKeys.join('+')} fehlgeschlagen — Monat nicht gespeichert, vorhandene Zeilen bleiben unveraendert (naechster Lauf versucht es erneut).`); return; }
    if (failedKeys.length) console.log(`${cl.name} ${m.start}: Bericht(e) ${failedKeys.join('+')} fehlgeschlagen — laufender Monat wird trotzdem aus SP gespeichert (wird taeglich neu geholt).`);
    // Aufbewahrungsgrenze: ist SP (die Kostenquelle) verkuerzt, wird der Monat nie als vollstaendig gespeichert. Sind nur SB/SD verkuerzt
    // (deren Fenster ist kuerzer als das von SP), gilt: vorhandene Daten werden nicht ersetzt (unten); ohne vorhandene Daten wird gespeichert —
    // aeltere Daten holt Amazon nie wieder heraus, ein spaeterer Versuch bringt nichts.
    if (spJob.clipped) { console.log(`${cl.name} ${m.start}: SP-Daten liegen teilweise ausserhalb der Ads-Datenaufbewahrung — Monat nicht als vollstaendiger Monat gespeichert, vorhandene Zeilen bleiben unveraendert.`); return; }
    const clippedOther = mine.some(j => j.clipped);
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
    // Ersetzen in der Reihenfolge "erst schreiben, dann aufraeumen" (CLAUDE.md-Regel 4). Frueher wurde der Monat VOR dem
    // Schreiben geloescht — schlug das Schreiben fehl, war der Monat leer. vra_ads hat einen UNIQUE-Index auf
    // (client_id, asin, period_start): ein reines Einfuegen neben den alten Zeilen waere mit HTTP 409 gescheitert, ein
    // Upsert auf diesen Schluessel aktualisiert die vorhandenen Zeilen und legt neue an — Doppelzeilen sind unmoeglich.
    //  1. alte Zeilen (id, asin) vorab lesen,  2. Upsert aller neuen Zeilen,  3. NUR alte Zeilen loeschen, deren ASIN
    //  im neuen Bericht nicht mehr vorkommt. Bricht das Schreiben ab, wird nichts geloescht; Zeilen, die noch das alte
    //  (Teil-)period_end tragen, lassen den Monat beim naechsten Lauf wieder als unvollstaendig erkennen (monthState).
    const vals = [...agg.values()];
    let oldRows;
    try { oldRows = await adsOldRows(cl.id, m.start); }
    catch (e) { console.log(`${cl.name} ${m.start}: alte Zeilen nicht lesbar (${e.message}) — Monat uebersprungen, nichts veraendert.`); return; }
    if (!vals.length) { console.log(`${cl.name} ${m.start}: Berichte ohne Daten — vorhandene Zeilen bleiben stehen.`); return; }
    if (clippedOther && oldRows.length) { console.log(`${cl.name} ${m.start}: SB/SD-Daten liegen teilweise ausserhalb der Ads-Datenaufbewahrung — vorhandener Monat (${oldRows.length} Zeilen) bleibt unveraendert.`); return; }
    let ins = 0;
    for (let i = 0; i < vals.length; i += 200) {
      const chunk = vals.slice(i, i + 200);
      let ok = false, why = '';
      for (let a = 0; a < 2 && !ok; a++) { // 1 Wiederholung (einmalige Timeouts); auch ein Netzwerkfehler (fetch wirft) zaehlt als Fehlschlag
        try {
          const w = await fetch(`${U}/rest/v1/vra_ads?on_conflict=client_id,asin,period_start`, { method: 'POST', headers: { ...sbHead, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(chunk) });
          if (w.ok) ok = true; else why = w.status + ' ' + (await w.text()).slice(0, 150);
        } catch (e) { why = e.message; }
        if (!ok && a === 0) await sleep(5000);
      }
      if (!ok) {
        console.log('  UPSERT', why);
        console.log(`${cl.name} ${m.start}: Schreiben abgebrochen nach ${ins}/${vals.length} Zeilen — nichts geloescht, alte Zeilen bleiben, naechster Lauf versucht es erneut.`);
        return;
      }
      ins += chunk.length;
    }
    // Eine gespeicherte SB-Kontosumme bleibt stehen, wenn SB diesmal nicht geliefert wurde (nicht verfuegbar/ausserhalb Aufbewahrung) —
    // sonst wuerde sie als "veraltet" geloescht.
    const sbJob = mine.find(j => j.rt.key === 'SB'); const keepSb = !sbJob || sbJob.state !== 'fertig';
    const stale = oldRows.filter(r => !agg.has(r.asin) && !(keepSb && r.asin === '_SB_TOTAL_')).map(r => r.id);
    try { await deleteAdsIds(stale); }
    catch (e) { console.log(`  ${cl.name} ${m.start}: veraltete Zeilen konnten nicht geloescht werden (${e.message}) — neue Daten sind geschrieben, Aufraeumen beim naechsten Lauf.`); }
    console.log(`${cl.name} ${m.start}: ${ins} Zeilen (${done.map(j => j.rt.key).join('+')})${stale.length ? `, ${stale.length} veraltete entfernt` : ''}`);
  }

  // Phase 2: Alle angeforderten Reports gesammelt abholen (Laufzeit = langsamster Report).
  const deadline = Date.now() + 150 * 60 * 1000;
  while (jobs.some(j => j.state === 'wartet') && Date.now() < deadline) {
    await ensureAuth();
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
  // Zeitüberschreitung: übrig gebliebene Reports abschreiben ('fehler') — betroffene Monate werden NICHT mit Teildaten gespeichert (siehe writeMonthIfReady), der nächste Lauf versucht sie erneut
  for (const job of jobs.filter(j => j.state === 'wartet')) { job.state = 'fehler'; console.log(`${job.cl.name} ${job.m.start} ${job.rt.key}: Timeout`); }
  for (const job of jobs) await writeMonthIfReady(job.cl, job.m);

  // Titel-Nachfüllung: SP-API-Catalog ist bei Vendor-Freigaben oft gesperrt (403) —
  // die Ads-API liefert Titel über den Product-Metadata-Endpoint mit unseren Rechten.
  for (const cl of clients) {
    try {
      await ensureAuth();
      const r = await fetch(`${U}/rest/v1/vra_data?client_id=eq.${cl.id}&title=is.null&select=asin`, { headers: sbHead });
      const asins = [...new Set((await r.json()).map(x => x.asin))];
      if (!asins.length) continue;
      let filled = 0;
      for (let i = 0; i < asins.length; i += 100) {
        const batch = asins.slice(i, i + 100);
        const res = await fetch(`${ADS}/product/metadata`, { method: 'POST', headers: { ...H(cl.ads_profile_id), 'Content-Type': 'application/vnd.productmetadatarequest.v1+json' }, body: JSON.stringify({ asins: batch, checkItemDetails: true, pageIndex: 0, pageSize: 100 }) });
        if (!res.ok) { console.log(`${cl.name} Titel: HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`); break; }
        const txt = await res.text();
        let j = {}; try { j = JSON.parse(txt); } catch {}
        const list = j.ProductMetadataList || j.products || (Array.isArray(j) ? j : null);
        if (!list || !list.length) { console.log(`${cl.name} Titel: keine Treffer — Antwort: ${txt.slice(0, 300)}`); break; }
        if (i === 0) console.log(`${cl.name} Titel-Beispiel: ${JSON.stringify(list[0]).slice(0, 300)}`);
        for (const it of list) {
          const title = it.title || it.itemName; if (!it.asin || !title) continue;
          const p = await fetch(`${U}/rest/v1/vra_data?client_id=eq.${cl.id}&asin=eq.${it.asin}&title=is.null`, { method: 'PATCH', headers: { ...sbHead, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ title, brand: it.brand || null }) });
          if (p.ok) filled++;
        }
        await sleep(1000);
      }
      console.log(`${cl.name} Titel: ${filled}/${asins.length} nachgefüllt (Ads-API).`);
    } catch (e) { console.log(`${cl.name} Titel: FEHLER ${e.message}`); }
  }
  console.log('FERTIG.');
}
main().catch(e => { console.error('FEHLER', e.message); process.exit(1); });
