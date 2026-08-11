// LABOR-TEST (einmalig): Prüft das Antwortformat des SQP-Reports bei MEHREREN ASINs
// (reportOptions.asin = leerzeichengetrennte Liste). Gesprächig: loggt jeden Statuswechsel
// und HTTP-Fehler, damit "hängt" von "gedrosselt" von "FATAL" unterscheidbar ist. Read-only.
import zlib from 'node:zlib';
const CID = process.env.SPAPI_CLIENT_ID, SEC = process.env.SPAPI_CLIENT_SECRET;
const U = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const SPID = 'AB0SPXUYQ1F1W', MKT = 'A1PA6795UKMFR9'; // Recoactiv DE
const ASINS = 'B004EDMYG2 B004EDSTZW B0DMT8HD4N';
const OLD_REPORT = '747420020676'; // Versuch von 08:xx — einmal nachschauen, was daraus wurde
const sleep = ms => new Promise(r => setTimeout(r, ms));

const tr = await fetch(`${U}/rest/v1/spapi_accounts?selling_partner_id=eq.${SPID}&select=refresh_token`, { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
const [{ refresh_token }] = await tr.json();
const t = await fetch('https://api.amazon.co.uk/auth/o2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token, client_id: CID, client_secret: SEC }) });
const AT = (await t.json()).access_token;
const H = { 'x-amz-access-token': AT, 'Content-Type': 'application/json' };
const SPAPI = 'https://sellingpartnerapi-eu.amazon.com';

async function api(path, opts = {}) {
  for (let i = 0; i < 10; i++) {
    let r; try { r = await fetch(`${SPAPI}${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); } catch (e) { console.log('  NETZFEHLER', e.message); await sleep(8000); continue; }
    if (r.status === 429) { console.log('  429 gedrosselt — warte 30s'); await sleep(30000); continue; }
    return r;
  }
  return null;
}

// 1) Was wurde aus dem alten Report?
const og = await api(`/reports/2021-06-30/reports/${OLD_REPORT}`);
if (og) console.log(`ALTER REPORT ${OLD_REPORT}: HTTP ${og.status} → ${JSON.stringify(await og.json()).slice(0, 250)}`);

// 2) Frischen Multi-ASIN-Report erstellen und mit Status-Logging pollen
const c = await api(`/reports/2021-06-30/reports`, { method: 'POST', body: JSON.stringify({ reportType: 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT', marketplaceIds: [MKT], dataStartTime: '2026-06-01T00:00:00Z', dataEndTime: '2026-06-30T00:00:00Z', reportOptions: { reportPeriod: 'MONTH', asin: ASINS } }) });
const cj = c ? await c.json() : {};
console.log('CREATE:', c && c.status, JSON.stringify(cj).slice(0, 200));
if (!cj.reportId) process.exit(1);

let docId = null, lastStatus = '';
for (let i = 0; i < 240; i++) {
  await sleep(5000);
  const g = await api(`/reports/2021-06-30/reports/${cj.reportId}`);
  if (!g) { console.log(`[${i}] Abfrage fehlgeschlagen`); continue; }
  const gj = await g.json();
  const st = gj.processingStatus || ('HTTP ' + g.status);
  if (st !== lastStatus || i % 24 === 0) { console.log(`[${i * 5}s] Status: ${st}`); lastStatus = st; }
  if (st === 'DONE') { docId = gj.reportDocumentId; break; }
  if (['FATAL', 'CANCELLED'].includes(st)) { console.log('ENDSTATUS:', st, JSON.stringify(gj).slice(0, 300)); process.exit(1); }
}
if (!docId) { console.log('TIMEOUT nach 20 Min Poll'); process.exit(1); }

const dr = await api(`/reports/2021-06-30/documents/${docId}`);
const drj = await dr.json();
let buf = Buffer.from(await (await fetch(drj.url)).arrayBuffer());
if (drj.compressionAlgorithm === 'GZIP') buf = zlib.gunzipSync(buf);
const j = JSON.parse(buf.toString('utf8'));
const rows = j.dataByAsin || [];
console.log('ZEILEN:', rows.length);
console.log('TOP-LEVEL-KEYS:', Object.keys(j).join(', '));
if (rows.length) {
  console.log('ZEILEN-KEYS:', Object.keys(rows[0]).join(', '));
  const dist = [...new Set(rows.map(r => r.asin || r.childAsin))];
  console.log('ASIN-FELD:', rows[0].asin !== undefined ? 'asin' : (rows[0].childAsin !== undefined ? 'childAsin' : 'FEHLT'));
  console.log('DISTINCT ASINs in Zeilen:', dist.join(', '));
  console.log('BEISPIELZEILE:', JSON.stringify(rows[0]).slice(0, 400));
}
