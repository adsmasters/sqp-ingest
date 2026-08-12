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

async function pull(profile, reportTypeId, columns, startDate, endDate) {
  let cj;
  for (let a = 0; a < 6; a++) {
    await freshAuth();
    const body = { name: `${reportTypeId} ${startDate} ${a}`, startDate, endDate, configuration: { adProduct: 'SPONSORED_PRODUCTS', groupBy: reportTypeId === 'spAdvertisedProduct' ? ['advertiser'] : ['searchTerm'], columns, reportTypeId, timeUnit: 'SUMMARY', format: 'GZIP_JSON' } };
    const c = await fetch(`${ADS}/reporting/reports`, { method: 'POST', headers: H(profile), body: JSON.stringify(body) });
    if (c.status === 429) { await sleep(30000); continue; }
    const j = await c.json();
    if (c.status === 425) { const id = String(j.detail || '').split(':').pop().trim(); if (id) { cj = { reportId: id }; break; } await sleep(25000); continue; }
    if (c.status === 400) { const m = String(j.detail || '').match(/data retention start date \((\d{4}-\d{2}-\d{2})\)/); if (m && m[1] > startDate) { startDate = m[1]; if (startDate > endDate) return []; continue; } }
    cj = j; if (!cj.reportId) throw new Error(reportTypeId + ' create ' + c.status + ': ' + JSON.stringify(cj).slice(0, 160)); break;
  }
  if (!cj || !cj.reportId) throw new Error(reportTypeId + ' create fehlgeschlagen');
  let url = null;
  for (let i = 0; i < 120; i++) { await sleep(8000); await freshAuth(); const g = await fetch(`${ADS}/reporting/reports/${cj.reportId}`, { headers: H(profile) }); const gj = await g.json(); if (gj.status === 'COMPLETED') { url = gj.url; break; } if (gj.status === 'FAILURE') throw new Error(reportTypeId + ' FAILURE'); }
  if (!url) throw new Error(reportTypeId + ' timeout');
  const raw = await fetch(url); let buf = Buffer.from(await raw.arrayBuffer());
  if (buf.length > 200 * 1024 * 1024) throw new Error(`${reportTypeId} Report zu gross (${Math.round(buf.length / 1048576)} MB komprimiert)`); // OOM-Schutz (Pixxprint)
  buf = zlib.gunzipSync(buf);
  if (buf.length > 800 * 1024 * 1024) throw new Error(`${reportTypeId} Report zu gross (${Math.round(buf.length / 1048576)} MB)`);
  return JSON.parse(buf.toString('utf8'));
}
async function upsert(rows) { let ins = 0; for (let i = 0; i < rows.length; i += 1000) { const chunk = rows.slice(i, i + 1000); const r = await fetch(`${U}/rest/v1/ads_asin_terms_periodic`, { method: 'POST', headers: { ...sbHead, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(chunk) }); if (r.ok) ins += chunk.length; else { console.log('  INSERT', r.status, (await r.text()).slice(0, 150)); break; } } return ins; }

async function hasPeriod(profile, type, start, table = 'ads_asin_terms_periodic') {
  const r = await fetch(`${U}/rest/v1/${table}?profile_id=eq.${profile}&period_type=eq.${type}&period_start=eq.${start}&select=${table.includes('totals') ? 'asin' : 'id'}`, { headers: { ...sbHead, Prefer: 'count=exact', Range: '0-0' } });
  return +((r.headers.get('content-range') || '0/0').split('/')[1]) > 0;
}
const hasMonth = (profile, m) => hasPeriod(profile, 'MONTH', m);

// Exakte Ad-Werte je ASIN & Periode aus dem Advertised-Product-Bericht -> ads_asin_totals_periodic.
// Der Suchbegriffsbericht kennt keine ASIN: Anzeigengruppen mit mehreren ASINs bekamen ihren
// KOMPLETTEN Spend auf jede ASIN dupliziert (ABACUS 5L/20L identisch, Stichprobe 12.08.).
async function pullTotals(profile, type, p) {
  const adv = await pull(profile, 'spAdvertisedProduct', ['advertisedAsin', 'impressions', 'clicks', 'cost', 'purchases7d', 'sales7d'], p.start, p.end);
  const agg = new Map();
  for (const r of adv) { const a = r.advertisedAsin; if (!a) continue; let e = agg.get(a); if (!e) { e = { profile_id: profile, asin: a, period_type: type, period_start: p.start, impressions: 0, clicks: 0, cost: 0, purchases7d: 0, sales7d: 0 }; agg.set(a, e); } e.impressions += +r.impressions || 0; e.clicks += +r.clicks || 0; e.cost += +r.cost || 0; e.purchases7d += +r.purchases7d || 0; e.sales7d += +r.sales7d || 0; }
  await fetch(`${U}/rest/v1/ads_asin_totals_periodic?profile_id=eq.${profile}&period_type=eq.${type}&period_start=eq.${p.start}`, { method: 'DELETE', headers: sbHead });
  const rows = [...agg.values()]; let ins = 0;
  for (let i = 0; i < rows.length; i += 1000) { const chunk = rows.slice(i, i + 1000); const r = await fetch(`${U}/rest/v1/ads_asin_totals_periodic`, { method: 'POST', headers: { ...sbHead, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(chunk) }); if (r.ok) ins += chunk.length; else { console.log('  TOTALS INSERT', r.status, (await r.text()).slice(0, 150)); break; } }
  return ins;
}

async function main() {
  await auth();
  const cr = await fetch(`${U}/rest/v1/sqp_clients?active=eq.true&ads_profile_id=not.is.null&select=name,ads_profile_id`, { headers: sbHead });
  const clients = await cr.json();
  console.log(`Ads-Periodic: ${clients.length} Kunde(n), letzte ${NM} Monate + ${NW} Wochen`);
  const ms = months(NM);
  for (const cl of clients) {
    const profile = String(cl.ads_profile_id);
    console.log(`Kunde: ${cl.name} (Profil ${profile})`);
    let agToAsins;
    for (const m of ms) {
      try {
        // Vergangene Monate überspringen, wenn schon vorhanden (aktueller/letzter Monat wird aktualisiert)
        const isNewest = m.start >= ms[ms.length - 1].start;
        const needTerms = isNewest || !(await hasMonth(profile, m.start));
        const needTotals = isNewest || !(await hasPeriod(profile, 'MONTH', m.start, 'ads_asin_totals_periodic'));
        if (!needTerms && !needTotals) { console.log(`  ${m.start}: schon da`); continue; }
        if (needTotals) { try { const n = await pullTotals(profile, 'MONTH', m); console.log(`  ${m.start}: ${n} ASIN-Totale`); } catch (e) { console.log(`  ${m.start}: TOTALS-FEHLER ${e.message} -> weiter`); } }
        if (!needTerms) continue;
        if (!agToAsins) {
          const adv = await pull(profile, 'spAdvertisedProduct', ['campaignId', 'adGroupId', 'advertisedAsin', 'impressions', 'clicks'], iso(new Date(Date.now() - 30 * 864e5)), iso(new Date(Date.now() - 864e5)));
          agToAsins = new Map(); for (const r of adv) { const k = String(r.adGroupId); if (!agToAsins.has(k)) agToAsins.set(k, new Set()); agToAsins.get(k).add(r.advertisedAsin); }
          console.log(`  ${agToAsins.size} Anzeigengruppen`);
        }
        const st = await pull(profile, 'spSearchTerm', ['searchTerm', 'adGroupId', 'clicks', 'cost', 'purchases7d', 'sales7d'], m.start, m.end);
        if (!st.length) { console.log(`  ${m.start}: keine Ads-Daten`); continue; }
        const agg = new Map();
        for (const r of st) { const asins = agToAsins.get(String(r.adGroupId)); if (!asins) continue; const term = norm(r.searchTerm); if (!term) continue; for (const asin of asins) { const k = asin + '||' + term; let e = agg.get(k); if (!e) { e = { profile_id: profile, asin, period_type: 'MONTH', period_start: m.start, search_term: term, clicks: 0, cost: 0, purchases7d: 0, sales7d: 0 }; agg.set(k, e); } e.clicks += +r.clicks || 0; e.cost += +r.cost || 0; e.purchases7d += +r.purchases7d || 0; e.sales7d += +r.sales7d || 0; } }
        await fetch(`${U}/rest/v1/ads_asin_terms_periodic?profile_id=eq.${profile}&period_type=eq.MONTH&period_start=eq.${m.start}`, { method: 'DELETE', headers: sbHead });
        const n = await upsert([...agg.values()]);
        console.log(`  ${m.start}: ${st.length} Terms -> ${n} Zeilen`);
      } catch (e) { console.log(`  ${m.start}: FEHLER ${e.message} -> weiter`); }
    }
    // Letzte N Wochen: echte Ad-Werte je Woche (statt 30-Tage-Näherung in der Wochenansicht).
    // Wochen, die vor >8 Tagen endeten, sind final (7-Tage-Attribution) -> überspringen wenn vorhanden.
    for (const w of weeksList(NW)) {
      try {
        const final = w.end < iso(new Date(Date.now() - 8 * 864e5));
        const needTerms = !final || !(await hasPeriod(profile, 'WEEK', w.start));
        const needTotals = !final || !(await hasPeriod(profile, 'WEEK', w.start, 'ads_asin_totals_periodic'));
        if (!needTerms && !needTotals) { console.log(`  Woche ${w.start}: schon da`); continue; }
        if (needTotals) { try { const n = await pullTotals(profile, 'WEEK', w); console.log(`  Woche ${w.start}: ${n} ASIN-Totale`); } catch (e) { console.log(`  Woche ${w.start}: TOTALS-FEHLER ${e.message} -> weiter`); } }
        if (!needTerms) continue;
        if (!agToAsins) {
          const adv = await pull(profile, 'spAdvertisedProduct', ['campaignId', 'adGroupId', 'advertisedAsin', 'impressions', 'clicks'], iso(new Date(Date.now() - 30 * 864e5)), iso(new Date(Date.now() - 864e5)));
          agToAsins = new Map(); for (const r of adv) { const k = String(r.adGroupId); if (!agToAsins.has(k)) agToAsins.set(k, new Set()); agToAsins.get(k).add(r.advertisedAsin); }
        }
        const st = await pull(profile, 'spSearchTerm', ['searchTerm', 'adGroupId', 'clicks', 'cost', 'purchases7d', 'sales7d'], w.start, w.end);
        if (!st.length) { console.log(`  Woche ${w.start}: keine Ads-Daten`); continue; }
        const agg = new Map();
        for (const r of st) { const asins = agToAsins.get(String(r.adGroupId)); if (!asins) continue; const term = norm(r.searchTerm); if (!term) continue; for (const asin of asins) { const k = asin + '||' + term; let e = agg.get(k); if (!e) { e = { profile_id: profile, asin, period_type: 'WEEK', period_start: w.start, search_term: term, clicks: 0, cost: 0, purchases7d: 0, sales7d: 0 }; agg.set(k, e); } e.clicks += +r.clicks || 0; e.cost += +r.cost || 0; e.purchases7d += +r.purchases7d || 0; e.sales7d += +r.sales7d || 0; } }
        await fetch(`${U}/rest/v1/ads_asin_terms_periodic?profile_id=eq.${profile}&period_type=eq.WEEK&period_start=eq.${w.start}`, { method: 'DELETE', headers: sbHead });
        const n = await upsert([...agg.values()]);
        console.log(`  Woche ${w.start}: ${st.length} Terms -> ${n} Zeilen`);
      } catch (e) { console.log(`  Woche ${w.start}: FEHLER ${e.message} -> weiter`); }
    }
  }
  console.log('FERTIG.');
}
main().catch(e => { console.error('FEHLER', e.message); process.exit(1); });
