// FBA-Versandbericht-Test (29.09.2026): prueft READ-ONLY, ob GET_AMAZON_FULFILLED_SHIPMENTS_DATA_GENERAL
// per SP-API abrufbar ist und ob die Spalte buyer-email (Amazon-Alias) gefuellt ist.
// ACHTUNG: Repo ist oeffentlich -> dieses Skript gibt KEINE Kundendaten aus, nur Zaehlwerte.
// Aufruf: node fba-shipments-test.mjs <spid> <MKT> <YYYY-MM-DD start> <YYYY-MM-DD ende>
const U = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const CID = process.env.SPAPI_CLIENT_ID, SEC = process.env.SPAPI_CLIENT_SECRET;
if (!U || !KEY || !CID || !SEC) { console.error('FEHLER: ENV fehlt.'); process.exit(1); }
import { gunzipSync } from 'node:zlib';
const SPAPI = 'https://sellingpartnerapi-eu.amazon.com';
const MKT_MAP = { DE: 'A1PA6795UKMFR9', FR: 'A13V1IB3VIYZZH', IT: 'APJ6JRA9NG5V4', ES: 'A1RKKUPIHCS9HS', UK: 'A1F83G8C2ARO7P', NL: 'A1805IZSGTT6HS' };
const [spid, mktKey = 'DE', start = '2026-01-01', end = '2026-01-31'] = process.argv.slice(2);
const mkt = MKT_MAP[mktKey.toUpperCase()] || MKT_MAP.DE;
if (!spid) { console.error('spid fehlt'); process.exit(1); }

const r0 = await fetch(`${U}/rest/v1/spapi_accounts?selling_partner_id=eq.${spid}&select=refresh_token,account_name`, { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
const rows = await r0.json(); if (!rows.length) { console.error('kein Token fuer', spid); process.exit(1); }
const t = await fetch('https://api.amazon.co.uk/auth/o2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rows[0].refresh_token, client_id: CID, client_secret: SEC }) });
const at = (await t.json()).access_token; if (!at) { console.error('LWA-Token fehlgeschlagen'); process.exit(1); }
const H = { 'x-amz-access-token': at, 'Content-Type': 'application/json' };
console.log(`Konto: ${rows[0].account_name || spid}, Marketplace ${mktKey}, Zeitraum ${start} bis ${end}`);

// Kontingent wird mit Sellerboard & Seller Central geteilt: bei 429 alle 10 Min erneut versuchen (max. ~5 Std).
let cj = {};
for (let k = 0; k < 30; k++) {
  const c = await fetch(`${SPAPI}/reports/2021-06-30/reports`, { method: 'POST', headers: H, body: JSON.stringify({ reportType: 'GET_AMAZON_FULFILLED_SHIPMENTS_DATA_GENERAL', marketplaceIds: [mkt], dataStartTime: `${start}T00:00:00Z`, dataEndTime: `${end}T23:59:59Z` }) });
  cj = await c.json(); console.log(new Date().toISOString(), 'Anlegen:', c.status, JSON.stringify(cj.errors || '').slice(0, 200));
  if (c.status !== 429) break;
  await new Promise(r => setTimeout(r, 600000));
}
if (!cj.reportId) process.exit(1);

let rep; for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 30000));
  const g = await fetch(`${SPAPI}/reports/2021-06-30/reports/${cj.reportId}`, { headers: H }); rep = await g.json();
  console.log(`Status nach ${(i + 1) * 30}s: ${rep.processingStatus || g.status}`);
  if (['DONE', 'CANCELLED', 'FATAL'].includes(rep.processingStatus)) break;
}
if (rep.processingStatus !== 'DONE') { console.log('Kein Ergebnis (CANCELLED = keine Daten im Zeitraum, FATAL = Fehler).'); process.exit(0); }

const d = await (await fetch(`${SPAPI}/reports/2021-06-30/documents/${rep.reportDocumentId}`, { headers: H })).json();
let buf = Buffer.from(await (await fetch(d.url)).arrayBuffer()); if (d.compressionAlgorithm === 'GZIP') buf = gunzipSync(buf);
const lines = buf.toString('utf8').split(/\r?\n/).filter(Boolean);
const head = lines[0].split('\t'); const data = lines.slice(1).map(l => l.split('\t'));
const col = n => head.indexOf(n);
const filled = n => { const i = col(n); return i < 0 ? 'Spalte fehlt' : data.filter(r => (r[i] || '').trim()).length; };
const ie = col('buyer-email');
const emails = ie < 0 ? [] : data.map(r => (r[ie] || '').trim()).filter(Boolean);
const doms = {}; emails.forEach(e => { const dm = e.split('@')[1] || '?'; doms[dm] = (doms[dm] || 0) + 1; });
const is = col('sku'); const skus = {}; if (is >= 0) data.forEach(r => { skus[r[is]] = (skus[r[is]] || 0) + 1; });
console.log('\nSpalten:', head.join(', '));
console.log('Zeilen:', data.length);
console.log('buyer-email gefuellt:', filled('buyer-email'), '| verschiedene Aliase:', new Set(emails).size);
console.log('Mail-Domains (nur Domain, keine Adressen):', JSON.stringify(doms));
console.log('buyer-name gefuellt:', filled('buyer-name'), '| ship-postal-code gefuellt:', filled('ship-postal-code'));
console.log('SKUs (Zeilen je SKU):', JSON.stringify(skus));
