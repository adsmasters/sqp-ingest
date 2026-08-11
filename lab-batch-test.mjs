// LABOR-TEST (einmalig): Prüft das Antwortformat des SQP-Reports bei MEHREREN ASINs
// (reportOptions.asin = leerzeichengetrennte Liste, max 200 Zeichen laut Amazon-Changelog).
// Entscheidend: Tragen die Zeilen ihre ASIN selbst (dataByAsin[].asin)? Read-only.
import zlib from 'node:zlib';
const CID = process.env.SPAPI_CLIENT_ID, SEC = process.env.SPAPI_CLIENT_SECRET;
const U = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const SPID = 'AB0SPXUYQ1F1W', MKT = 'A1PA6795UKMFR9'; // Recoactiv DE
const ASINS = 'B004EDMYG2 B004EDSTZW B0DMT8HD4N';      // 3 bekannte Recoactiv-ASINs
const sleep = ms => new Promise(r => setTimeout(r, ms));

const tr = await fetch(`${U}/rest/v1/spapi_accounts?selling_partner_id=eq.${SPID}&select=refresh_token`, { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
const [{ refresh_token }] = await tr.json();
const t = await fetch('https://api.amazon.co.uk/auth/o2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token, client_id: CID, client_secret: SEC }) });
const AT = (await t.json()).access_token;
const H = { 'x-amz-access-token': AT, 'Content-Type': 'application/json' };
const SPAPI = 'https://sellingpartnerapi-eu.amazon.com';

// Report vom letzten Versuch weiterverwenden (Multi-ASIN-Generierung dauert >5 Min)
let reportId = '747420020676';
if (!reportId) {
  const c = await fetch(`${SPAPI}/reports/2021-06-30/reports`, { method: 'POST', headers: H, body: JSON.stringify({ reportType: 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT', marketplaceIds: [MKT], dataStartTime: '2026-06-01T00:00:00Z', dataEndTime: '2026-06-30T00:00:00Z', reportOptions: { reportPeriod: 'MONTH', asin: ASINS } }) });
  const cj = await c.json();
  console.log('CREATE:', c.status, JSON.stringify(cj).slice(0, 200));
  if (!cj.reportId) process.exit(1);
  reportId = cj.reportId;
}
const cj = { reportId };

let docId = null;
for (let i = 0; i < 240; i++) {
  await sleep(5000);
  const g = await fetch(`${SPAPI}/reports/2021-06-30/reports/${cj.reportId}`, { headers: H });
  const gj = await g.json();
  if (gj.processingStatus === 'DONE') { docId = gj.reportDocumentId; break; }
  if (['FATAL', 'CANCELLED'].includes(gj.processingStatus)) { console.log('STATUS:', gj.processingStatus, JSON.stringify(gj).slice(0, 300)); process.exit(1); }
}
if (!docId) { console.log('TIMEOUT'); process.exit(1); }
const dr = await fetch(`${SPAPI}/reports/2021-06-30/documents/${docId}`, { headers: H });
const drj = await dr.json();
let buf = Buffer.from(await (await fetch(drj.url)).arrayBuffer());
if (drj.compressionAlgorithm === 'GZIP') buf = zlib.gunzipSync(buf);
const j = JSON.parse(buf.toString('utf8'));
const rows = j.dataByAsin || [];
console.log('ZEILEN:', rows.length);
console.log('TOP-LEVEL-KEYS:', Object.keys(j).join(', '));
if (rows.length) {
  console.log('ZEILEN-KEYS:', Object.keys(rows[0]).join(', '));
  const asinField = rows[0].asin !== undefined ? 'asin' : (rows[0].childAsin !== undefined ? 'childAsin' : 'FEHLT');
  console.log('ASIN-FELD:', asinField);
  const dist = [...new Set(rows.map(r => r.asin || r.childAsin))];
  console.log('DISTINCT ASINs in Zeilen:', dist.join(', '));
  console.log('BEISPIELZEILE:', JSON.stringify(rows[0]).slice(0, 400));
}
