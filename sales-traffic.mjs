// Gesamt-Umsaetze je ASIN (SP-API Sales & Traffic Business Report) -> asin_sales_traffic.
// Grundlage fuer ECHTEN TACoS (Ad-Spend / Gesamtumsatz) statt SQP-Naeherung. Nur Seller mit SP-API-Token.
// ENV: SPAPI_CLIENT_ID/SECRET, SUPABASE_URL/SERVICE_KEY
import zlib from 'node:zlib';
const U = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const CID = process.env.SPAPI_CLIENT_ID, SEC = process.env.SPAPI_CLIENT_SECRET;
if (!U || !KEY || !CID || !SEC) { console.error('FEHLER: ENV fehlt.'); process.exit(1); }
const SPAPI = 'https://sellingpartnerapi-eu.amazon.com';
const sbHead = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DAYS = +(process.argv[2] || 30);
const MKT_MAP = { DE: 'A1PA6795UKMFR9', FR: 'A13V1IB3VIYZZH', IT: 'APJ6JRA9NG5V4', ES: 'A1RKKUPIHCS9HS', UK: 'A1F83G8C2ARO7P', US: 'ATVPDKIKX0DER', NL: 'A1805IZSGTT6HS', SE: 'A2NODRKZP88ZB9', PL: 'A1C3SOZRARQ6R3', TR: 'A33AVAJ2PDY3EV', BE: 'AMEN7PMS3EDWL', SA: 'A17E79C6D8DWNP', AE: 'A2VIGQ35RCS4UG' };

async function tokenFor(spid) {
  const r = await fetch(`${U}/rest/v1/spapi_accounts?selling_partner_id=eq.${spid}&select=refresh_token`, { headers: sbHead });
  const rows = await r.json(); if (!rows.length) return null;
  const t = await fetch('https://api.amazon.co.uk/auth/o2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rows[0].refresh_token, client_id: CID, client_secret: SEC }) });
  return (await t.json()).access_token || null;
}
async function api(at, path, opts = {}, tries = 8) {
  for (let i = 0; i < tries; i++) {
    let r; try { r = await fetch(`${SPAPI}${path}`, { ...opts, headers: { 'x-amz-access-token': at, 'Content-Type': 'application/json', ...(opts.headers || {}) } }); } catch (e) { await sleep(8000); continue; }
    if (r.status === 429) { await sleep(45000); continue; } // Sales&Traffic-Quota ist knapp
    return r;
  } return null;
}

async function runClient(cl) {
  const at = await tokenFor(cl.spid);
  if (!at) { console.log(`  ${cl.name}: kein SP-API-Token — übersprungen`); return; }
  const mkt = MKT_MAP[(cl.marketplace || 'DE').toUpperCase()] || MKT_MAP.DE;
  const end = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const start = new Date(Date.now() - (DAYS + 1) * 864e5).toISOString().slice(0, 10);
  const c = await api(at, '/reports/2021-06-30/reports', { method: 'POST', body: JSON.stringify({ reportType: 'GET_SALES_AND_TRAFFIC_REPORT', marketplaceIds: [mkt], dataStartTime: start, dataEndTime: end, reportOptions: { asinGranularity: 'CHILD', dateGranularity: 'DAY' } }) });
  if (!c) { console.log(`  ${cl.name}: Create fehlgeschlagen`); return; }
  const cj = await c.json(); if (!cj.reportId) { console.log(`  ${cl.name}: ${JSON.stringify(cj).slice(0, 120)}`); return; }
  let docId = null;
  for (let i = 0; i < 60; i++) {
    await sleep(15000);
    const g = await api(at, `/reports/2021-06-30/reports/${cj.reportId}`); if (!g) return;
    const gj = await g.json();
    if (gj.processingStatus === 'DONE') { docId = gj.reportDocumentId; break; }
    if (['FATAL', 'CANCELLED'].includes(gj.processingStatus)) { console.log(`  ${cl.name}: ${gj.processingStatus}`); return; }
  }
  if (!docId) { console.log(`  ${cl.name}: Timeout`); return; }
  const dr = await api(at, `/reports/2021-06-30/documents/${docId}`); const drj = await dr.json();
  let buf = Buffer.from(await (await fetch(drj.url)).arrayBuffer());
  if (drj.compressionAlgorithm === 'GZIP') buf = zlib.gunzipSync(buf);
  const j = JSON.parse(buf.toString());
  const agg = {};
  for (const r of (j.salesAndTrafficByAsin || [])) {
    const a = r.childAsin || r.parentAsin; if (!a) continue;
    if (!agg[a]) agg[a] = { sales: 0, units: 0, sessions: 0 };
    agg[a].sales += (r.salesByAsin && r.salesByAsin.orderedProductSales && r.salesByAsin.orderedProductSales.amount) || 0;
    agg[a].units += (r.salesByAsin && r.salesByAsin.unitsOrdered) || 0;
    agg[a].sessions += (r.trafficByAsin && r.trafficByAsin.sessions) || 0;
  }
  const mktCC = (cl.marketplace || 'DE').toUpperCase();
  const rows = Object.entries(agg).map(([asin, v]) => ({ spid: cl.spid, asin, days: DAYS, marketplace: mktCC, sales: +v.sales.toFixed(2), units: v.units, sessions: v.sessions, updated_at: new Date().toISOString() }));
  for (let i = 0; i < rows.length; i += 500) {
    const up = await fetch(`${U}/rest/v1/asin_sales_traffic?on_conflict=spid,asin,days,marketplace`, { method: 'POST', headers: { ...sbHead, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows.slice(i, i + 500)) });
    if (!up.ok) { console.log(`  ${cl.name}: UPSERT ${up.status} ${(await up.text()).slice(0, 120)}`); return; }
  }
  console.log(`  ${cl.name} (${mktCC}): ${rows.length} ASINs, Gesamt ${rows.reduce((s, r) => s + r.sales, 0).toFixed(0)} (Landeswährung)`);
}

async function main() {
  const cr = await fetch(`${U}/rest/v1/sqp_clients?active=eq.true&spid=not.is.null&select=name,spid,marketplace`, { headers: sbHead });
  const clients = await cr.json();
  // Jeder (Seller × Marktplatz) einzeln (PK spid,asin,days,marketplace). Die Create-Quota
  // gilt JE Seller-Konto — verschiedene Seller laufen deshalb parallel (max 3), innerhalb
  // eines Sellers sequenziell mit Abstand. Rein sequenziell dauerte der Rundlauf länger
  // als das Workflow-Fenster (Lauf 10.08. im Timeout gestorben).
  const seen = new Set(); const bySeller = new Map();
  for (const cl of clients) {
    const key = cl.spid + '|' + (cl.marketplace || 'DE').toUpperCase();
    if (seen.has(key)) continue; seen.add(key);
    if (!bySeller.has(cl.spid)) bySeller.set(cl.spid, []);
    bySeller.get(cl.spid).push(cl);
  }
  const lanes = [...bySeller.values()];
  console.log(`Sales&Traffic: ${seen.size} Lauf/Läufe bei ${lanes.length} Seller(n), ${DAYS} Tage, max 3 parallel`);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(3, lanes.length) }, async () => {
    while (idx < lanes.length) {
      const lane = lanes[idx++];
      for (const cl of lane) {
        console.log(`=== ${cl.name} (${cl.spid} · ${(cl.marketplace || 'DE').toUpperCase()}) startet ===`);
        try { await runClient(cl); } catch (e) { console.log(`  ${cl.name}: FEHLER ${e.message}`); }
        await sleep(60000); // Create-Quota je Seller-Konto
      }
    }
  }));
  console.log('\nFERTIG.');
}
main().catch(e => { console.error('FEHLER', e.message); process.exit(1); });
