// Echte Ad-Historie je Monat & ASIN×Suchbegriff -> ads_asin_terms_periodic.
// Multi-Client: alle sqp_clients mit ads_profile_id. ENV: ADS_CLIENT_ID/SECRET/REFRESH_TOKEN, SUPABASE_*.
import zlib from 'node:zlib';
const CID = process.env.ADS_CLIENT_ID, SEC = process.env.ADS_CLIENT_SECRET, RT = process.env.ADS_REFRESH_TOKEN;
const U = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY, ADS = 'https://advertising-api-eu.amazon.com';
if (!CID || !SEC || !RT) { console.log('Ads-Secrets fehlen — übersprungen.'); process.exit(0); }
const sbHead = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso = d => d.toISOString().slice(0, 10);
const NM = +(process.argv[2] || 4);
const NW = +(process.argv[3] || 3); // letzte N abgeschlossene Wochen (So-Sa, wie SQP-Refresh)
const norm = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
function months(n) { const out = []; const now = new Date(); for (let i = 1; i <= n; i++) { const s = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); const e = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 0)); out.push({ start: iso(s), end: iso(e) }); } return out.reverse(); }
function weeksList(n) { const now = new Date(); const day = now.getUTCDay();
  const curSun = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day)); const out = [];
  for (let i = 1; i <= n; i++) { const s = new Date(curSun); s.setUTCDate(curSun.getUTCDate() - 7 * i); const e = new Date(s); e.setUTCDate(s.getUTCDate() + 6); out.push({ start: iso(s), end: iso(e) }); } return out.reverse(); }

let AT;
let AT_T = 0;
async function auth() { const t = await fetch('https://api.amazon.co.uk/auth/o2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: RT, client_id: CID, client_secret: SEC }) }); AT = (await t.json()).access_token; AT_T = Date.now(); }
const freshAuth = async () => { if (Date.now() - AT_T > 50 * 60000) await auth(); }; // Token laeuft nach 60min ab
const H = profile => ({ 'Amazon-Advertising-API-ClientId': CID, 'Amazon-Advertising-API-Scope': profile, Authorization: 'Bearer ' + AT, 'Content-Type': 'application/json' });

// Wartezeit auf Amazons Report: 16 Min reichten bei grossen Konten nicht — der Lauf brach
// mit "timeout -> weiter" ab und der Nachimport kam bei 13 von 15 Kunden nie an (12.08.)
const POLL_MAX = +(process.env.ADS_POLL_MAX || 300); // 300 x 10s = 50 Min
async function pull(profile, reportTypeId, columns, startDate, endDate, versuch = 0) {
  let cj;
  for (let a = 0; a < 6; a++) {
    await freshAuth();
    // Report-Name OHNE Versuchszaehler: gleiche Anfrage -> Amazon antwortet 425 mit der
    // ID des bereits laufenden Reports, ein Wiederholungsversuch ADOPTIERT ihn also
    const body = { name: `${reportTypeId} ${startDate}`, startDate, endDate, configuration: { adProduct: 'SPONSORED_PRODUCTS', groupBy: reportTypeId === 'spAdvertisedProduct' ? ['advertiser'] : ['searchTerm'], columns, reportTypeId, timeUnit: 'SUMMARY', format: 'GZIP_JSON' } };
    const c = await fetch(`${ADS}/reporting/reports`, { method: 'POST', headers: H(profile), body: JSON.stringify(body) });
    if (c.status === 429) { await sleep(30000); continue; }
    const j = await c.json();
    if (c.status === 425) { const id = String(j.detail || '').split(':').pop().trim(); if (id) { cj = { reportId: id }; break; } await sleep(25000); continue; }
    if (c.status === 400) { const m = String(j.detail || '').match(/data retention start date \((\d{4}-\d{2}-\d{2})\)/); if (m && m[1] > startDate) { startDate = m[1]; if (startDate > endDate) return []; continue; } }
    cj = j; if (!cj.reportId) throw new Error(reportTypeId + ' create ' + c.status + ': ' + JSON.stringify(cj).slice(0, 160)); break;
  }
  if (!cj || !cj.reportId) throw new Error(reportTypeId + ' create fehlgeschlagen');
  let url = null;
  for (let i = 0; i < POLL_MAX; i++) { await sleep(10000); await freshAuth(); const g = await fetch(`${ADS}/reporting/reports/${cj.reportId}`, { headers: H(profile) }); const gj = await g.json(); if (gj.status === 'COMPLETED') { url = gj.url; break; } if (gj.status === 'FAILURE') throw new Error(reportTypeId + ' FAILURE'); }
  // Timeout: Amazon rechnet weiter — erneut anfordern uebernimmt denselben Report (425),
  // statt die Periode zu ueberspringen und beim naechsten Lauf ganz von vorn zu beginnen
  if (!url) {
    if (versuch < 1) { console.log(`    ${reportTypeId} ${startDate}: dauert laenger, uebernehme den laufenden Report…`); return pull(profile, reportTypeId, columns, startDate, endDate, versuch + 1); }
    throw new Error(reportTypeId + ' timeout');
  }
  const raw = await fetch(url); let buf = Buffer.from(await raw.arrayBuffer());
  if (buf.length > 200 * 1024 * 1024) throw new Error(`${reportTypeId} Report zu gross (${Math.round(buf.length / 1048576)} MB komprimiert)`); // OOM-Schutz (Pixxprint)
  buf = zlib.gunzipSync(buf);
  if (buf.length > 800 * 1024 * 1024) throw new Error(`${reportTypeId} Report zu gross (${Math.round(buf.length / 1048576)} MB)`);
  return JSON.parse(buf.toString('utf8'));
}
// Echter Upsert statt Plain-INSERT (11.09.): der Hetzner-Daemon stoesst ads-periodic.mjs
// unabhaengig alle 6h nochmal an — kollidiert der mit einem GitHub-Actions-Lauf auf
// derselben (profile_id, asin, period_type, period_start, search_term), gab es bisher
// 409 und die betroffene Periode blieb bei 0 Zeilen (Warnick's/BIOZOYG, wiederholt
// beobachtet). on_conflict macht die Kollision zu einem harmlosen Merge.
async function upsert(rows) { let ins = 0; for (let i = 0; i < rows.length; i += 1000) { const chunk = rows.slice(i, i + 1000); const r = await fetch(`${U}/rest/v1/ads_asin_terms_periodic?on_conflict=profile_id,asin,period_type,period_start,search_term`, { method: 'POST', headers: { ...sbHead, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(chunk) }); if (r.ok) ins += chunk.length; else { console.log('  INSERT', r.status, (await r.text()).slice(0, 150)); break; } } return ins; }

async function hasPeriod(profile, type, start, table = 'ads_asin_terms_periodic') {
  const r = await fetch(`${U}/rest/v1/${table}?profile_id=eq.${profile}&period_type=eq.${type}&period_start=eq.${start}&select=${table.includes('totals') ? 'asin' : 'id'}`, { headers: { ...sbHead, Prefer: 'count=exact', Range: '0-0' } });
  return +((r.headers.get('content-range') || '0/0').split('/')[1]) > 0;
}
const hasMonth = (profile, m) => hasPeriod(profile, 'MONTH', m);
async function hasAnyTotals(profile) {
  const r = await fetch(`${U}/rest/v1/ads_asin_totals_periodic?profile_id=eq.${profile}&select=asin`, { headers: { ...sbHead, Prefer: 'count=exact', Range: '0-0' } });
  return +((r.headers.get('content-range') || '0/0').split('/')[1]) > 0;
}

// Exakte Ad-Werte je ASIN & Periode aus dem Advertised-Product-Bericht -> ads_asin_totals_periodic.
// Der Suchbegriffsbericht kennt keine ASIN: Anzeigengruppen mit mehreren ASINs bekamen ihren
// KOMPLETTEN Spend auf jede ASIN dupliziert (ABACUS 5L/20L identisch, Stichprobe 12.08.).
async function pullTotals(profile, type, p, topAsins = null) {
  const adv = await pull(profile, 'spAdvertisedProduct', ['advertisedAsin', 'impressions', 'clicks', 'cost', 'purchases7d', 'sales7d'], p.start, p.end);
  const agg = new Map();
  for (const r of adv) { const a = r.advertisedAsin; if (!a) continue; if (topAsins && !topAsins.has(normAsin(a))) continue; let e = agg.get(a); if (!e) { e = { profile_id: profile, asin: a, period_type: type, period_start: p.start, impressions: 0, clicks: 0, cost: 0, purchases7d: 0, sales7d: 0 }; agg.set(a, e); } e.impressions += +r.impressions || 0; e.clicks += +r.clicks || 0; e.cost += +r.cost || 0; e.purchases7d += +r.purchases7d || 0; e.sales7d += +r.sales7d || 0; }
  await fetch(`${U}/rest/v1/ads_asin_totals_periodic?profile_id=eq.${profile}&period_type=eq.${type}&period_start=eq.${p.start}`, { method: 'DELETE', headers: sbHead });
  const rows = [...agg.values()]; let ins = 0;
  for (let i = 0; i < rows.length; i += 1000) { const chunk = rows.slice(i, i + 1000); const r = await fetch(`${U}/rest/v1/ads_asin_totals_periodic`, { method: 'POST', headers: { ...sbHead, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(chunk) }); if (r.ok) ins += chunk.length; else { console.log('  TOTALS INSERT', r.status, (await r.text()).slice(0, 150)); break; } }
  return ins;
}

// ============================================================================
// Zwei-Phasen-Nachzug fuer den NORMALEN (nicht-TOTALS_ONLY) Lauf (13.09.).
// Der alte Kunde-fuer-Kunde-Ablauf brauchte bis zu 10 sequenzielle Amazon-
// Report-Wartezeiten PRO KUNDE (2 Monate + 3 Wochen x bis zu 2 Reports) und lief
// damit ~5h, obwohl ads-refresh.mjs (gleiches Zwei-Phasen-Muster, 11.09.) laengst
// auf ~15 Min runter war — naeherte sich erneut der 355-Min-Job-Grenze. Gleiches
// Prinzip wie dort: ALLE Reports zuerst anfordern, dann gesammelt abholen.
//
// Eigene create/download-Helfer statt pull()/pullTotals() oben, damit der
// TOTALS_ONLY-Nachzugmodus (eigener, bereits funktionierender CONC-Pool) davon
// unberuehrt bleibt — der ist nicht das Problem und wird nicht angefasst.
async function rfetch(url, opts = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { return await fetch(url, { ...opts, signal: AbortSignal.timeout(90000) }); }
    catch (e) { if (i === tries - 1) throw e; await sleep(8000 * (i + 1)); }
  }
}
async function createReport(profile, reportTypeId, columns, startDate, endDate) {
  for (let a = 0; a < 6; a++) {
    await freshAuth();
    const body = { name: `${reportTypeId} ${startDate}`, startDate, endDate, configuration: { adProduct: 'SPONSORED_PRODUCTS', groupBy: reportTypeId === 'spAdvertisedProduct' ? ['advertiser'] : ['searchTerm'], columns, reportTypeId, timeUnit: 'SUMMARY', format: 'GZIP_JSON' } };
    const c = await rfetch(`${ADS}/reporting/reports`, { method: 'POST', headers: H(profile), body: JSON.stringify(body) });
    if (c.status === 429) { await sleep(30000); continue; }
    const j = await c.json();
    if (c.status === 425) { const id = String(j.detail || '').split(':').pop().trim(); if (id) return { reportId: id }; await sleep(25000); continue; }
    if (c.status === 400) { const m = String(j.detail || '').match(/data retention start date \((\d{4}-\d{2}-\d{2})\)/); if (m && m[1] > startDate) { startDate = m[1]; if (startDate > endDate) return { empty: true }; continue; } }
    if (!j.reportId) throw new Error(`${reportTypeId} create ${c.status}: ${JSON.stringify(j).slice(0, 160)}`);
    return { reportId: j.reportId };
  }
  throw new Error(`${reportTypeId} create: zu viele Versuche`);
}
async function downloadReport(url) {
  const raw = await rfetch(url); let buf = Buffer.from(await raw.arrayBuffer());
  if (buf.length > 200 * 1024 * 1024) throw new Error(`Report zu gross (${Math.round(buf.length / 1048576)} MB komprimiert)`);
  buf = zlib.gunzipSync(buf);
  if (buf.length > 800 * 1024 * 1024) throw new Error(`Report zu gross (${Math.round(buf.length / 1048576)} MB)`);
  return JSON.parse(buf.toString('utf8'));
}
function jobLabel(job) {
  if (job.type === 'sharedAdv') return 'gemeinsamer Anzeigengruppen-Report';
  return job.periodType === 'WEEK' ? `Woche ${job.period.start}` : job.period.start;
}
function buildAgToAsins(rows) {
  const agToAsins = new Map();
  for (const r of rows) { const k = String(r.adGroupId); if (!agToAsins.has(k)) agToAsins.set(k, new Map()); const m = agToAsins.get(k); m.set(r.advertisedAsin, (m.get(r.advertisedAsin) || 0) + 1000 * (+r.clicks || 0) + (+r.impressions || 0) + 1); }
  return agToAsins;
}
async function finalizeTotals(job, topAsinsByClient) {
  const { cl, periodType, period } = job;
  const profile = String(cl.ads_profile_id);
  const topAsins = topAsinsByClient.get(cl);
  const agg = new Map();
  for (const r of job.rows) { const a = r.advertisedAsin; if (!a) continue; if (topAsins && !topAsins.has(normAsin(a))) continue; let e = agg.get(a); if (!e) { e = { profile_id: profile, asin: a, period_type: periodType, period_start: period.start, impressions: 0, clicks: 0, cost: 0, purchases7d: 0, sales7d: 0 }; agg.set(a, e); } e.impressions += +r.impressions || 0; e.clicks += +r.clicks || 0; e.cost += +r.cost || 0; e.purchases7d += +r.purchases7d || 0; e.sales7d += +r.sales7d || 0; }
  await fetch(`${U}/rest/v1/ads_asin_totals_periodic?profile_id=eq.${profile}&period_type=eq.${periodType}&period_start=eq.${period.start}`, { method: 'DELETE', headers: sbHead });
  const rows = [...agg.values()]; let ins = 0;
  for (let i = 0; i < rows.length; i += 1000) { const chunk = rows.slice(i, i + 1000); const r = await fetch(`${U}/rest/v1/ads_asin_totals_periodic`, { method: 'POST', headers: { ...sbHead, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(chunk) }); if (r.ok) ins += chunk.length; else { console.log('  TOTALS INSERT', r.status, (await r.text()).slice(0, 150)); break; } }
  console.log(`${cl.name} ${jobLabel(job)}: ${ins} ASIN-Totale`);
}

// ASIN-Deckel (13.09., Kundenwunsch): pro Kunde nur die Top-N ASINs nach ECHTEM
// Produktumsatz (asin_sales_traffic, NICHT ad-attribuierter Umsatz — vom Kunden
// explizit so gewuenscht) behalten. BIOZOYG allein (1500+ ASINs) macht ~77% der
// Tabellengroesse aus; ein Top-100-Deckel reduziert seine Zeilen um ~92.6%
// (validiert per SQL vor Implementierung). asin_sales_traffic ist ueber spid
// verknuepft, nicht ueber ads_profile_id — daher cl.spid statt cl.ads_profile_id.
//
// Zwei Korrekturen nach Selbstpruefung (14.09.), bevor das je live lief:
// 1) Paginierung: diese Supabase-Instanz deckelt unpaginierte Antworten auf 1000
//    Zeilen (siehe ads-history.js/ads-totals.js) — Warnick's (4070 Zeilen) und
//    BIOZOYG (1600 Zeilen) ueberschreiten das, waeren also still abgeschnitten
//    und mit einer FALSCHEN Top-100 gelandet, ohne dass es aufgefallen waere.
// 2) Markt-Filter: mehrere Kunden teilen sich EIN spid ueber mehrere Marktplatz-
//    Zeilen (z.B. MGF-DE/FR/ES/IT, je 195 Zeilen — ueber dem Deckel-Schwellwert).
//    Ohne marketplace-Filter bekaemen alle vier dieselbe, ueber alle vier Maerkte
//    gemischte Rangliste — ein ASIN, das nur in FR gut verkauft, koennte so aus
//    MGF-FRs Top-100 fallen, weil die anderen drei Maerkte es "verduennen".
const normAsin = s => String(s || '').trim().toUpperCase();

// Manuell gepinnte ASINs (15.09., Kundenwunsch: neue Produkteinfuehrungen sollen nicht
// vom Deckel erfasst werden, obwohl sie anfangs kaum/keinen Umsatz haben). Eigene, kleine
// Tabelle ads_asin_manual_keep(profile_id, asin) — muss per SQL im Supabase-Dashboard
// angelegt werden (siehe Migration). Fail-open: existiert die Tabelle noch nicht oder
// schlaegt die Abfrage fehl, einfach leere Menge -> Deckel-Logik unveraendert.
async function manualKeepFor(profile) {
  try {
    const r = await fetch(`${U}/rest/v1/ads_asin_manual_keep?profile_id=eq.${profile}&select=asin`, { headers: sbHead });
    if (!r.ok) return new Set();
    const rows = await r.json();
    return new Set(rows.map(x => normAsin(x.asin)));
  } catch (e) { return new Set(); }
}

// ASIN-Deckel (13.09., Kundenwunsch, erweitert 15.09.): pro Kunde ASINs behalten, die
// IRGENDEINES von drei Kriterien erfuellen (Union, nicht ersetzt):
//   1) Top-100 nach ECHTEM Produktumsatz (asin_sales_traffic, nicht ad-attribuiert) —
//      die urspruengliche Regel.
//   2) Kind-ASINs der Top-25 PARENT-ASINs nach summiertem Umsatz ueber alle Kinder
//      (neue Anforderung eines zweiten Tools) — ein Parent ohne eigene parent_asin-
//      Zeile (kein Varianten-Produkt) ist sein eigener Parent (Self-Parent-Fallback).
//   3) Manuell gepinnte ASINs (ads_asin_manual_keep) — z.B. neue Produkteinfuehrungen
//      ohne nennenswerten Umsatz, die trotzdem nicht geloescht/ausgefiltert werden sollen.
// asin_sales_traffic ist ueber spid verknuepft, nicht ueber ads_profile_id.
//
// Korrekturen nach Selbstpruefung (14./15.09.), bevor das je live lief:
// 1) Paginierung: diese Supabase-Instanz deckelt unpaginierte Antworten auf 1000
//    Zeilen (siehe ads-history.js/ads-totals.js) — Warnick's (4070 Zeilen) und
//    BIOZOYG (1600 Zeilen) ueberschreiten das, waeren also still abgeschnitten
//    und mit einer FALSCHEN Top-100 gelandet, ohne dass es aufgefallen waere.
// 2) Markt-Filter: mehrere Kunden teilen sich EIN spid ueber mehrere Marktplatz-
//    Zeilen (z.B. MGF-DE/FR/ES/IT, je 195 Zeilen — ueber dem Deckel-Schwellwert).
//    Ohne marketplace-Filter bekaemen alle vier dieselbe, ueber alle vier Maerkte
//    gemischte Rangliste — ein ASIN, das nur in FR gut verkauft, koennte so aus
//    MGF-FRs Top-100 fallen, weil die anderen drei Maerkte es "verduennen".
async function topAsinsFor(cl, n = 100, parentN = 25) {
  const spid = cl.spid, marketplace = cl.marketplace, profile = String(cl.ads_profile_id);
  try {
    const mkt = (marketplace || 'DE').toUpperCase();
    const url = `${U}/rest/v1/asin_sales_traffic?spid=eq.${spid}&marketplace=eq.${mkt}&select=asin,sales,parent_asin`;
    const first = await fetch(url, { headers: { ...sbHead, Prefer: 'count=exact', Range: '0-999' } });
    if (!first.ok) { console.log(`  ASIN-Deckel: asin_sales_traffic HTTP ${first.status} — kein Deckel fuer dieses spid/Markt (fail-open).`); return { top: null, excluded: [] }; }
    const total = +((first.headers.get('content-range') || '0/0').split('/')[1]) || 0;
    const rows = await first.json();
    for (let f = 1000; f < total; f += 1000) {
      const r = await fetch(url, { headers: { ...sbHead, Range: `${f}-${f + 999}` } });
      // Frueher: fehlgeschlagene Folgeseite wurde still uebersprungen -> unvollstaendige
      // Zeilen, dadurch faelschlich niedrig gerankte ASINs waeren geloescht worden, ohne
      // dass irgendwo ein Fehler aufgetaucht waere. Jetzt: jede Seite muss gelingen, sonst
      // kompletter Fail-Open (kein Deckel) statt einer auf falschen Daten basierenden Rangliste.
      if (!r.ok) { console.log(`  ASIN-Deckel: asin_sales_traffic Seite ${f}-${f + 999} HTTP ${r.status} — kein Deckel fuer dieses spid/Markt (fail-open, unvollstaendige Daten waeren sonst falsch gerankt).`); return { top: null, excluded: [] }; }
      rows.push(...(await r.json()));
    }
    const bySales = new Map(); // childAsin -> summierter Umsatz
    const parentOf = new Map(); // childAsin -> parent_asin (oder sich selbst, falls keins)
    for (const row of rows) {
      const a = normAsin(row.asin); if (!a) continue;
      bySales.set(a, (bySales.get(a) || 0) + (+row.sales || 0));
      const p = normAsin(row.parent_asin) || a;
      parentOf.set(a, p);
    }
    const manualKeep = await manualKeepFor(profile);
    if (bySales.size <= n) return { top: null, excluded: [] }; // schon <= n ASINs — Deckel waere ein No-Op (Top-25-Parent/manuell aendern daran nichts)
    const ranked = [...bySales.entries()].sort((a, b) => b[1] - a[1]);
    const top100 = new Set(ranked.slice(0, n).map(([asin]) => asin));

    const byParentSales = new Map();
    for (const [asin, sales] of bySales) { const p = parentOf.get(asin); byParentSales.set(p, (byParentSales.get(p) || 0) + sales); }
    const parentRanked = [...byParentSales.entries()].sort((a, b) => b[1] - a[1]);
    const top25Parents = new Set(parentRanked.slice(0, parentN).map(([p]) => p));
    const keepFromParents = new Set();
    for (const [asin, p] of parentOf) if (top25Parents.has(p)) keepFromParents.add(asin);

    const top = new Set([...top100, ...keepFromParents, ...manualKeep]);
    const excluded = ranked.filter(([asin]) => !top.has(asin)).map(([asin]) => asin);

    if (DECKEL_DRY_RUN) {
      const top15 = ranked.slice(0, 15).map(([a, s]) => `${a} (${s.toFixed(2)})`).join(', ');
      const boundary = ranked.slice(n - 3, n + 3).map(([a, s], idx) => `#${n - 3 + idx + 1} ${a} (${s.toFixed(2)})`).join(', ');
      console.log(`  [DRY RUN] spid=${spid} mkt=${mkt}: Top-15 nach Umsatz: ${top15}`);
      console.log(`  [DRY RUN] spid=${spid} mkt=${mkt}: Grenzbereich (#${n - 2}-#${n + 3}): ${boundary}`);
      console.log(`  [DRY RUN] spid=${spid} mkt=${mkt}: ${byParentSales.size} Parent-Gruppen, Top-${parentN} davon bringen ${keepFromParents.size} Kind-ASINs zusaetzlich zu Top-${n} (${[...keepFromParents].filter(a => !top100.has(a)).length} davon NEU ueber Top-${n} hinaus).`);
      console.log(`  [DRY RUN] spid=${spid} mkt=${mkt}: ${manualKeep.size} manuell gepinnte ASIN(s), davon ${[...manualKeep].filter(a => !top100.has(a) && !keepFromParents.has(a)).length} zusaetzlich ueber Top-${n}/Top-${parentN}-Parents hinaus.`);
    }
    return { top, excluded };
  } catch (e) { console.log(`  ASIN-Deckel: FEHLER ${e.message} — kein Deckel fuer dieses spid/Markt (fail-open).`); return { top: null, excluded: [] }; }
}

// Loescht bestehende Zeilen fuer ASINs ausserhalb der Top-100 — sowohl beim ersten
// Lauf nach diesem Deploy (rueckwirkende Bereinigung, vom Kunden gewuenscht) als
// auch laufend (ein ASIN, das aus den Top-100 faellt, wird beim naechsten Lauf
// entfernt). Batches per RPC-Aufruf purge_excluded_asins() statt eines rohen
// PostgREST-DELETE (siehe Begruendung bei DECKEL_BATCH unten) — profile_id bleibt
// der fuehrende, indexierte Filter innerhalb der Funktion.
//
// ASIN_DECKEL_DRY_RUN=1 (15.09., Test vor dem echten Deploy): fuehrt exakt dieselbe
// profile_id+asin-Abfrage aus wie das echte DELETE, zaehlt aber nur (Prefer count=exact,
// Range 0-0) statt zu loeschen — zeigt die echten Zeilenzahlen pro Tabelle und die
// betroffenen ASINs, ohne dass auch nur eine Zeile angefasst wird.
const DECKEL_DRY_RUN = /^(1|true|yes)$/i.test(process.env.ASIN_DECKEL_DRY_RUN || '');
// War fest 100: der erste scharfe Lauf zeigte 57014 (statement timeout) fuer JEDEN
// Batch auf ads_asin_terms_periodic — Ursache letztlich zweifach (18.09. final geklaert):
// 1) veraltete Tabellenstatistik liess PostgREST/den Planer ~574 Treffer je 100 ASINs
//    schaetzen, real sind es ~20.000 Zeilen PRO ASIN bei BIOZOYGs Schnitt.
// 2) Nach VACUUM ANALYZE (korrekte Statistik) waehlte der Planer fuer den PostgREST-
//    DELETE-Pfad einen Seq Scan ueber die GESAMTE Tabelle statt Index-Scans je ASIN —
//    kostet (rechnerisch) sogar mehr, aber auf dieser Instanz (AWS t4g.micro, burstable)
//    real langsamer als der Index-Pfad. purge_excluded_asins() (Postgres-Funktion, per
//    RPC aufgerufen statt eines rohen DELETE) erzwingt `enable_seqscan = off` plus einen
//    hoeheren statement_timeout innerhalb der Funktion — beides ueber PostgREST-Header
//    nicht moeglich. Batch-Groesse 1 ist die einzige empirisch bestaetigt zuverlaessige
//    Groesse auf dieser Instanz (auch 50 mit erzwungenem Index-Scan scheiterte noch nach
//    10 Minuten) — fuer die laufende Pflegeregel (typ. wenige neu herausfallende ASINs
//    pro Lauf) reicht das, groessere Werte nur nach eigenem Test erhoehen.
const DECKEL_BATCH = Math.max(1, +(process.env.ASIN_DECKEL_BATCH || 1));
async function purgeExcludedAsins(cl, excluded) {
  if (!excluded.length) return;
  const profile = String(cl.ads_profile_id);
  if (DECKEL_DRY_RUN) {
    for (let i = 0; i < excluded.length; i += DECKEL_BATCH) {
      const batch = excluded.slice(i, i + DECKEL_BATCH);
      const inList = batch.join(',');
      for (const table of ['ads_asin_terms_periodic', 'ads_asin_totals_periodic']) {
        try {
          // count=exact zwingt Postgres zu einem vollen Aggregat ueber alle Treffer und
          // lief auf ads_asin_terms_periodic in 57014 (statement timeout) — EXPLAIN (ohne
          // ANALYZE) auf denselben Filter zeigte dagegen einen guenstigen Index-Scan
          // (ads_asin_terms_periodic_profile_id_asin_period_type_period__key, cost ~1963).
          // count=planned liefert genau diese Planer-Schaetzung, ohne die Zeilen wirklich
          // zu zaehlen — bleibt also guenstig, unabhaengig von der Tabellengroesse.
          const t0 = Date.now();
          const r = await fetch(`${U}/rest/v1/${table}?profile_id=eq.${profile}&asin=in.(${inList})&select=asin`, { headers: { ...sbHead, Prefer: 'count=planned', Range: '0-0' } });
          const ms = Date.now() - t0;
          if (!r.ok) { console.log(`${cl.name}: [DRY RUN] ${table} — Zaehlung HTTP ${r.status} (Batch ${Math.floor(i / DECKEL_BATCH) + 1}, ${ms}ms) — ${(await r.text()).slice(0, 150)}`); continue; }
          const cr = r.headers.get('content-range');
          if (!cr) { console.log(`${cl.name}: [DRY RUN] ${table} — kein content-range-Header (Batch ${Math.floor(i / DECKEL_BATCH) + 1}) — Zahl unten ist NICHT verlaesslich.`); continue; }
          const n = +(cr.split('/')[1]) || 0;
          console.log(`${cl.name}: [DRY RUN] ${table} — wuerde ca. ${n} Zeilen loeschen (Planer-Schaetzung, Batch ${Math.floor(i / DECKEL_BATCH) + 1}, ${batch.length} ASINs, ${ms}ms).`);
        } catch (e) { console.log(`${cl.name}: [DRY RUN] Zaehl-FEHLER (${table}) ${e.message}`); }
      }
    }
    console.log(`${cl.name}: [DRY RUN] insgesamt ${excluded.length} ASINs ausserhalb Top-100 wuerden entfernt: ${excluded.slice(0, 15).join(', ')}${excluded.length > 15 ? ', ...' : ''}`);
    return;
  }
  let anyFailed = false;
  // Bei DECKEL_BATCH=1 (siehe oben) eine Log-Zeile PRO ASIN — bei tausenden ausgeschlossenen
  // ASINs (z.B. beim ersten scharfen Lauf nach einem Ruecksstand) sprengt das die Log-Groesse.
  // Sammel-Log statt Einzelzeile pro Erfolg (20.09.): einzelne auffaellig langsame Batches
  // (das genaue Lock-Contention-Signal vom 18.09. — ein Batch, der die ganze statement_timeout-
  // Zeit verbraucht) werden trotzdem SOFORT gemeldet statt in der Sammelzeile zu verschwinden;
  // Fehler bleiben ohnehin einzeln und sofort sichtbar (selten, immer relevant).
  let ok = 0, sumMs = 0, maxMs = 0;
  const LOG_EVERY = 100;
  const OUTLIER_MS = 3000;
  for (let i = 0; i < excluded.length; i += DECKEL_BATCH) {
    const batchNo = Math.floor(i / DECKEL_BATCH) + 1;
    const batch = excluded.slice(i, i + DECKEL_BATCH);
    try {
      // purge_excluded_asins() (Postgres-Funktion, siehe Migration) statt rohem DELETE
      // ueber PostgREST — setzt intern enable_seqscan=off + einen hoeheren
      // statement_timeout, was ueber normale PostgREST-Header nicht moeglich ist.
      // Ohne das waehlte der Planer nach VACUUM ANALYZE einen Seq Scan ueber die
      // gesamte Tabelle statt Index-Scans je ASIN — auf dieser Instanz (t4g.micro)
      // real langsamer, obwohl rechnerisch "billiger" (18.09., nach stundenlanger
      // Fehlersuche empirisch bestaetigt: nur Batch=1 mit erzwungenem Index-Scan
      // lief zuverlaessig).
      const t0 = Date.now();
      const r = await fetch(`${U}/rest/v1/rpc/purge_excluded_asins`, { method: 'POST', headers: { ...sbHead, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_profile_id: profile, p_asins: batch }) });
      const ms = Date.now() - t0;
      if (!r.ok) { anyFailed = true; console.log(`${cl.name}: ASIN-Deckel-RPC HTTP ${r.status} (Batch ${batchNo}, ${batch.length} ASINs, ${ms}ms) — ${(await r.text()).slice(0, 150)}`); continue; }
      ok++; sumMs += ms; if (ms > maxMs) maxMs = ms;
      if (ms > OUTLIER_MS) console.log(`${cl.name}: ASIN-Deckel-RPC OK, aber auffaellig langsam (Batch ${batchNo}, ${batch.length} ASINs, ${ms}ms).`);
      else if (ok % LOG_EVERY === 0) console.log(`${cl.name}: ASIN-Deckel-RPC ${ok}/${excluded.length} erledigt (Schnitt ${Math.round(sumMs / ok)}ms, max ${maxMs}ms).`);
    } catch (e) { anyFailed = true; console.log(`${cl.name}: ASIN-Deckel-RPC FEHLER (Batch ${batchNo}) ${e.message}`); }
  }
  console.log(`${cl.name}: bis zu ${excluded.length} ASINs ausserhalb Top-100 (nach Produktumsatz) ${anyFailed ? 'entfernt (mit Fehlern — siehe oben, alte Zeilen bleiben fuer fehlgeschlagene Batches stehen)' : 'entfernt'}${ok ? ` (Schnitt ${Math.round(sumMs / ok)}ms, max ${maxMs}ms je Batch)` : ''}.`);
}

// Baut die vollstaendige Aufgabenliste (Kunde x Periode x Report-Art), fordert
// alles an, holt gesammelt ab und schreibt jeden Job, sobald SEINE Abhaengig-
// keiten bereit sind — ein Terms-Job braucht zusaetzlich den gemeinsamen
// Anzeigengruppen-Report desselben Kunden (siehe finalizeSearchTerm).
async function runNormalPeriodicPass(clients, ms, allWeeks) {
  const newestMonthStart = ms.map(x => x.start).sort().slice(-1)[0];
  const finalCutoff = iso(new Date(Date.now() - 8 * 864e5));
  const jobs = [];
  const sharedByClient = new Map();
  const topAsinsByClient = new Map();

  for (const cl of clients) {
    const profile = String(cl.ads_profile_id);
    // ASIN-Deckel: Top-100-nach-Umsatz bestimmen und alles andere sofort entfernen,
    // bevor ueberhaupt geplant wird, was neu zu holen ist.
    const { top, excluded } = await topAsinsFor(cl);
    topAsinsByClient.set(cl, top);
    await purgeExcludedAsins(cl, excluded);
    const need = [];
    for (const m of ms) {
      const isNewest = m.start >= newestMonthStart;
      const needTerms = isNewest || !(await hasMonth(profile, m.start));
      const needTotals = isNewest || !(await hasPeriod(profile, 'MONTH', m.start, 'ads_asin_totals_periodic'));
      if (!needTerms && !needTotals) { console.log(`${cl.name} ${m.start}: schon da`); continue; }
      need.push({ periodType: 'MONTH', period: m, needTerms, needTotals });
    }
    for (const w of allWeeks) {
      const final = w.end < finalCutoff;
      const needTerms = !final || !(await hasPeriod(profile, 'WEEK', w.start));
      const needTotals = !final || !(await hasPeriod(profile, 'WEEK', w.start, 'ads_asin_totals_periodic'));
      if (!needTerms && !needTotals) { console.log(`${cl.name} Woche ${w.start}: schon da`); continue; }
      need.push({ periodType: 'WEEK', period: w, needTerms, needTotals });
    }
    if (!need.length) continue;

    let sharedJob = null;
    if (need.some(n => n.needTerms)) {
      sharedJob = { type: 'sharedAdv', cl, state: 'neu' };
      jobs.push(sharedJob);
      sharedByClient.set(cl, sharedJob);
    }
    for (const n of need) {
      if (n.needTotals) jobs.push({ type: 'totalsAdv', cl, periodType: n.periodType, period: n.period, state: 'neu' });
      if (n.needTerms) jobs.push({ type: 'searchTerm', cl, periodType: n.periodType, period: n.period, state: 'neu', written: false });
    }
  }

  if (!jobs.length) { console.log('Nichts zu tun — alle Perioden schon da.'); return; }
  console.log(`${jobs.length} Report(s) werden angefordert…`);

  async function finalizeSearchTerm(job) {
    if (job.written) return;
    const shared = sharedByClient.get(job.cl);
    if (!shared || shared.state !== 'fertig') return; // noch nicht bereit — wird von finalizeSharedAdv nachgeholt
    job.written = true;
    const { cl, periodType, period, rows: st } = job;
    const profile = String(cl.ads_profile_id);
    if (!st.length) { console.log(`${cl.name} ${jobLabel(job)}: keine Ads-Daten`); return; }
    const agToAsins = shared.agToAsins;
    const topAsins = topAsinsByClient.get(cl);
    const agg = new Map();
    for (const r of st) {
      const wmap = agToAsins.get(String(r.adGroupId)); if (!wmap) continue;
      const term = norm(r.searchTerm); if (!term) continue;
      const wtot = [...wmap.values()].reduce((s, x) => s + x, 0) || 1;
      for (const [asin, w] of wmap) {
        if (topAsins && !topAsins.has(normAsin(asin))) continue; // ASIN-Deckel
        const sh = w / wtot;
        const k = asin + '||' + term; let e = agg.get(k);
        if (!e) { e = { profile_id: profile, asin, period_type: periodType, period_start: period.start, search_term: term, clicks: 0, cost: 0, purchases7d: 0, sales7d: 0 }; agg.set(k, e); }
        e.clicks += (+r.clicks || 0) * sh; e.cost += (+r.cost || 0) * sh; e.purchases7d += (+r.purchases7d || 0) * sh; e.sales7d += (+r.sales7d || 0) * sh;
      }
    }
    await fetch(`${U}/rest/v1/ads_asin_terms_periodic?profile_id=eq.${profile}&period_type=eq.${periodType}&period_start=eq.${period.start}`, { method: 'DELETE', headers: sbHead });
    const n = await upsert([...agg.values()].map(e => ({ ...e, clicks: Math.round(e.clicks), cost: +e.cost.toFixed(2), purchases7d: Math.round(e.purchases7d), sales7d: +e.sales7d.toFixed(2) })));
    console.log(`${cl.name} ${jobLabel(job)}: ${st.length} Terms -> ${n} Zeilen`);
  }
  async function finalizeSharedAdv(job) {
    job.agToAsins = buildAgToAsins(job.rows);
    console.log(`${job.cl.name}: ${job.agToAsins.size} Anzeigengruppen`);
    // Terms-Jobs desselben Kunden, die schon auf ihre eigenen Daten gewartet
    // haben, koennen jetzt sofort geschrieben werden.
    for (const j of jobs) if (j.type === 'searchTerm' && j.cl === job.cl && j.state === 'fertig') await finalizeSearchTerm(j);
  }
  async function finalize(job) {
    if (job.type === 'totalsAdv') return finalizeTotals(job, topAsinsByClient);
    if (job.type === 'sharedAdv') return finalizeSharedAdv(job);
    return finalizeSearchTerm(job);
  }

  // Phase 1: ALLE Reports anfordern — Amazon generiert sie parallel im Hintergrund.
  for (const job of jobs) {
    try {
      let reportTypeId, columns, sd, ed;
      if (job.type === 'sharedAdv') { reportTypeId = 'spAdvertisedProduct'; columns = ['campaignId', 'adGroupId', 'advertisedAsin', 'impressions', 'clicks']; sd = iso(new Date(Date.now() - 30 * 864e5)); ed = iso(new Date(Date.now() - 864e5)); }
      else if (job.type === 'totalsAdv') { reportTypeId = 'spAdvertisedProduct'; columns = ['advertisedAsin', 'impressions', 'clicks', 'cost', 'purchases7d', 'sales7d']; sd = job.period.start; ed = job.period.end; }
      else { reportTypeId = 'spSearchTerm'; columns = ['searchTerm', 'adGroupId', 'clicks', 'cost', 'purchases7d', 'sales7d']; sd = job.period.start; ed = job.period.end; }
      const r = await createReport(job.cl.ads_profile_id, reportTypeId, columns, sd, ed);
      if (r.empty) { job.state = 'fertig'; job.rows = []; } // ausserhalb Amazons Datenaufbewahrung
      else { job.reportId = r.reportId; job.state = 'wartet'; }
    } catch (e) { job.state = 'fehler'; console.log(`${job.cl.name} ${jobLabel(job)}: ${e.message}`); }
    await sleep(400); // Amazon-Create-Kontingent schonen
  }
  for (const job of jobs) if (job.state === 'fertig') await finalize(job); // sofort-leer-Jobs verarbeiten

  // Phase 2: gesammelt abholen. Wall-Clock-Budget statt Poll-Deckel je Report,
  // damit der gesamte Job innerhalb der 355-Min-Grenze bleibt.
  const BUDGET_MIN = +(process.env.ADS_PERIODIC_BUDGET_MIN || 200);
  const deadline = Date.now() + BUDGET_MIN * 60000;
  let rateLimited = 0;
  while (jobs.some(j => j.state === 'wartet') && Date.now() < deadline) {
    await freshAuth();
    for (const job of jobs.filter(j => j.state === 'wartet')) {
      try {
        const g = await rfetch(`${ADS}/reporting/reports/${job.reportId}`, { headers: H(job.cl.ads_profile_id) });
        if (g.status === 429) { rateLimited++; await sleep(10000); continue; }
        const gj = await g.json();
        if (gj.status === 'COMPLETED') {
          try { job.rows = await downloadReport(gj.url); job.state = 'fertig'; }
          catch (e) { job.state = 'fehler'; console.log(`${job.cl.name} ${jobLabel(job)}: Download-FEHLER ${e.message}`); }
          if (job.state === 'fertig') await finalize(job);
        } else if (gj.status === 'FAILURE') { job.state = 'fehler'; console.log(`${job.cl.name} ${jobLabel(job)}: Report FAILURE`); }
      } catch (e) { console.log(`${job.cl.name} ${jobLabel(job)}: ${e.message} (wird erneut versucht)`); }
      await sleep(700);
    }
    if (jobs.some(j => j.state === 'wartet')) await sleep(15000);
  }
  for (const job of jobs.filter(j => j.state === 'wartet')) { job.state = 'fehler'; console.log(`${job.cl.name} ${jobLabel(job)}: Budget erreicht (${BUDGET_MIN} Min) — noch nicht fertig`); }

  for (const job of jobs) {
    if (job.type === 'totalsAdv' && job.state === 'fehler') console.log(`${job.cl.name} ${jobLabel(job)}: ASIN-Totale übersprungen — alte Werte bleiben stehen.`);
    if (job.type === 'searchTerm' && !job.written) {
      const shared = sharedByClient.get(job.cl);
      const reason = job.state === 'fehler' ? 'Report fehlgeschlagen' : (shared && shared.state === 'fehler' ? 'gemeinsamer Anzeigengruppen-Report fehlgeschlagen' : 'unbekannt');
      console.log(`${job.cl.name} ${jobLabel(job)}: Terms übersprungen (${reason}) — alte Zeilen bleiben stehen.`);
    }
  }
  console.log(`(${rateLimited} Polls ueber den ganzen Lauf waren HTTP 429)`);
}

async function main() {
  await auth();
  const cr = await fetch(`${U}/rest/v1/sqp_clients?active=eq.true&ads_profile_id=not.is.null&select=name,spid,ads_profile_id,marketplace`, { headers: sbHead });
  let clients = await cr.json();
  // Gezielter Einzellauf (z.B. Nachzug fuer einen Kunden): ADS_ONLY_PROFILE=<profile_id>
  if (process.env.ADS_ONLY_PROFILE) clients = clients.filter(c => String(c.ads_profile_id) === String(process.env.ADS_ONLY_PROFILE));
  // ADS_TOTALS_ONLY=1: nur die exakten ASIN-Totale nachziehen (Suchbegriff-Reports
  // ueberspringen) — halbiert die Laufzeit beim Nachimport nach dem Duplikations-Fix.
  // Kunden OHNE Totale kommen zuerst, damit die falschen Zahlen zuerst verschwinden.
  const TOTALS_ONLY = /^(1|true|yes)$/i.test(process.env.ADS_TOTALS_ONLY || '');
  if (TOTALS_ONLY) {
    const withTotals = new Set();
    for (const cl of clients) if (await hasAnyTotals(String(cl.ads_profile_id))) withTotals.add(String(cl.ads_profile_id));
    clients.sort((a, b) => withTotals.has(String(a.ads_profile_id)) - withTotals.has(String(b.ads_profile_id)));
    console.log(`TOTALS-ONLY-Modus: ${clients.length - withTotals.size} Kunde(n) ohne Totale zuerst.`);
  }
  console.log(`Ads-Periodic: ${clients.length} Kunde(n), letzte ${NM} Monate + ${NW} Wochen`);
  // Beim Nachimport neueste Perioden zuerst — die schaut das Team zuerst an
  const ms = TOTALS_ONLY ? [...months(NM)].reverse() : months(NM);

  // Nachzug-Modus: alle (Kunde x Periode) als Aufgabenliste PARALLEL abarbeiten.
  // Sequenziell dauerte der Durchlauf durch 15 Kunden x 7 Perioden Stunden — die
  // Wartezeit auf Amazons Reports laesst sich ueberlappen (12.08.).
  if (TOTALS_ONLY) {
    // Reihenfolge PERIODE-zuerst statt Kunde-zuerst: nach einer Runde haben ALLE Kunden
    // den aktuellen Monat korrekt — die Zahl, die das Team anschaut. Kunde-fuer-Kunde
    // haetten die letzten Kunden stundenlang weiter falsche Werte gezeigt (12.08.).
    const wl = weeksList(NW).reverse(); // neueste Woche zuerst
    const perioden = [...ms.map(m => ({ type: 'MONTH', p: m })), ...wl.map(w => ({ type: 'WEEK', p: w }))];
    // ASIN-Deckel gilt auch hier: einmal pro Kunde vorab bestimmen (nicht pro Task —
    // ein Kunde hat hier bis zu NM+NW Tasks, die sich alle dieselbe Top-100-Menge teilen),
    // sonst wuerde dieser Pfad Zeilen fuer ausgeschlossene ASINs zurueckschreiben, die
    // der normale Lauf gerade erst entfernt hat.
    const topAsinsByProfile = new Map();
    for (const cl of clients) { const { top } = await topAsinsFor(cl); topAsinsByProfile.set(String(cl.ads_profile_id), top); }
    const tasks = [];
    for (const per of perioden) {
      for (const cl of clients) tasks.push({ profile: String(cl.ads_profile_id), name: cl.name, type: per.type, p: per.p });
    }
    const CONC = +(process.env.ADS_CONC || 4);
    console.log(`Nachzug: ${tasks.length} Perioden, ${CONC} parallel.`);
    let i = 0, done = 0, ok = 0;
    await Promise.all(Array.from({ length: CONC }, async () => {
      while (i < tasks.length) {
        const t = tasks[i++];
        const label = `${t.name} ${t.type} ${t.p.start}`;
        try {
          if (await hasPeriod(t.profile, t.type, t.p.start, 'ads_asin_totals_periodic')) { done++; console.log(`[${done}/${tasks.length}] ${label}: schon da`); continue; }
          const n = await pullTotals(t.profile, t.type, t.p, topAsinsByProfile.get(t.profile));
          done++; ok++;
          console.log(`[${done}/${tasks.length}] ${label}: ${n} ASIN-Totale`);
        } catch (e) { done++; console.log(`[${done}/${tasks.length}] ${label}: FEHLER ${e.message}`); }
      }
    }));
    console.log(`\nTOTALS-NACHZUG FERTIG: ${ok} Perioden neu geladen.`);
    return;
  }
  await runNormalPeriodicPass(clients, ms, weeksList(NW));
  console.log('FERTIG.');
}
main().catch(e => { console.error('FEHLER', e.message); process.exit(1); });
