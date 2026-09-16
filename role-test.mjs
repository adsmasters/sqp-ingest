// Rollen-Test (16.09.2026): prueft READ-ONLY, welche SP-API-Bereiche mit den bestehenden
// Kunden-Autorisierungen erreichbar sind (403 = Rolle fehlt bzw. Kunde muss neu autorisieren).
// Grundlage fuer das automatische Account-Check-Briefing. Schreibt NICHTS, legt nur Berichte an.
// Aufruf: node role-test.mjs <spid> [MKT]   ENV: SPAPI_CLIENT_ID/SECRET, SUPABASE_URL/SERVICE_KEY
const U = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const CID = process.env.SPAPI_CLIENT_ID, SEC = process.env.SPAPI_CLIENT_SECRET;
if (!U || !KEY || !CID || !SEC) { console.error('FEHLER: ENV fehlt.'); process.exit(1); }
const SPAPI = 'https://sellingpartnerapi-eu.amazon.com';
const MKT_MAP = { DE: 'A1PA6795UKMFR9', FR: 'A13V1IB3VIYZZH', IT: 'APJ6JRA9NG5V4', ES: 'A1RKKUPIHCS9HS', UK: 'A1F83G8C2ARO7P', NL: 'A1805IZSGTT6HS' };
const spid = process.argv[2]; const mkt = MKT_MAP[(process.argv[3] || 'DE').toUpperCase()] || MKT_MAP.DE;
if (!spid) { console.error('spid fehlt'); process.exit(1); }

const r0 = await fetch(`${U}/rest/v1/spapi_accounts?selling_partner_id=eq.${spid}&select=refresh_token,account_name`, { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
const rows = await r0.json(); if (!rows.length) { console.error('kein Token fuer', spid); process.exit(1); }
const t = await fetch('https://api.amazon.co.uk/auth/o2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rows[0].refresh_token, client_id: CID, client_secret: SEC }) });
const at = (await t.json()).access_token; if (!at) { console.error('LWA-Token fehlgeschlagen'); process.exit(1); }
console.log(`Konto: ${rows[0].account_name || spid} (${spid}), Marketplace ${mkt}\n`);

const results = [];
async function probe(label, role, path, opts = {}) {
  let r; try { r = await fetch(`${SPAPI}${path}`, { ...opts, headers: { 'x-amz-access-token': at, 'Content-Type': 'application/json' } }); } catch (e) { results.push([label, role, 'NETZ', e.message]); return null; }
  const txt = await r.text(); let j = {}; try { j = JSON.parse(txt); } catch (e) {}
  const err = (j.errors && j.errors[0] && (j.errors[0].code + ': ' + (j.errors[0].message || '')).slice(0, 90)) || '';
  const ok = r.status < 300 ? 'OK' : (r.status === 403 ? 'ROLLE FEHLT' : (r.status === 429 ? 'QUOTA' : 'FEHLER'));
  results.push([label, role, `${r.status} ${ok}`, err]);
  return j;
}
const createReport = (label, role, reportType, extra = {}) => probe(label, role, '/reports/2021-06-30/reports', { method: 'POST', body: JSON.stringify({ reportType, marketplaceIds: [mkt], ...extra }) });
const end = new Date(Date.now() - 864e5).toISOString().slice(0, 10), start = new Date(Date.now() - 8 * 864e5).toISOString().slice(0, 10);

await probe('Marketplaces (Basis)', '-', '/sellers/v1/marketplaceParticipations');
await probe('FBA-Bestand (Inventory API)', 'Fulfillment / Inventory&Order', `/fba/inventory/v1/summaries?granularityType=Marketplace&granularityId=${mkt}&marketplaceIds=${mkt}&details=true`);
await createReport('FBA Inventory Planning (Days of Supply)', 'Fulfillment / Inventory&Order', 'GET_FBA_INVENTORY_PLANNING_DATA');
await createReport('Stranded Inventory', 'Fulfillment / Inventory&Order', 'GET_STRANDED_INVENTORY_UI_DATA');
await createReport('FBA-Retouren', 'Fulfillment / Inventory&Order', 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA', { dataStartTime: start, dataEndTime: end });
await createReport('Alle Listings (Merchant Listings)', 'Inventory&Order / Product Listing', 'GET_MERCHANT_LISTINGS_ALL_DATA');
await createReport('Seller Performance v2 (ODR, Late Shipment…)', 'Selling Partner Insights', 'GET_V2_SELLER_PERFORMANCE_REPORT');
await createReport('Seller Performance v1', 'Selling Partner Insights', 'GET_V1_SELLER_PERFORMANCE_REPORT');
await createReport('Sales & Traffic (Buybox, CVR)', 'Brand Analytics', 'GET_SALES_AND_TRAFFIC_REPORT', { dataStartTime: start, dataEndTime: end, reportOptions: { dateGranularity: 'DAY', asinGranularity: 'CHILD' } });
const li = await probe('Listings durchsuchen (Suppressions/Issues)', 'Product Listing', `/listings/2021-08-01/items/${spid}?marketplaceIds=${mkt}&pageSize=5&includedData=summaries,issues`);
const asin = (li && li.items && li.items[0] && li.items[0].summaries && li.items[0].summaries[0] && li.items[0].summaries[0].asin) || null;
if (asin) {
  await probe(`Catalog Item ${asin}`, 'Product Listing', `/catalog/2022-04-01/items/${asin}?marketplaceIds=${mkt}&includedData=summaries`);
  await probe(`Buybox/Angebote ${asin} (Pricing)`, 'Pricing', `/products/pricing/v0/items/${asin}/offers?MarketplaceId=${mkt}&ItemCondition=New`);
} else { results.push(['Catalog/Pricing', 'Product Listing / Pricing', 'ÜBERSPRUNGEN', 'keine ASIN aus Listings']); }
await probe('Order Metrics (Sales API)', 'Brand Analytics / Insights', `/sales/v1/orderMetrics?marketplaceIds=${mkt}&interval=${start}T00:00:00Z--${end}T00:00:00Z&granularity=Day`);
await probe('Notifications-Destinations', 'Notifications', '/notifications/v1/destinations');

console.log('Bereich'.padEnd(46) + 'Rolle'.padEnd(34) + 'Ergebnis'.padEnd(18) + 'Detail');
for (const [a, b, c, d] of results) console.log(a.padEnd(46) + b.padEnd(34) + c.padEnd(18) + d);
