// Produkt-Metadaten (Titel + SKU je ASIN) aus dem Merchant-Listings-Report -> sqp_asin_meta.
// Multi-Client über sqp_clients. ENV: SPAPI_CLIENT_ID/SECRET, SUPABASE_URL/SERVICE_KEY.
import zlib from 'node:zlib';
const CID = process.env.SPAPI_CLIENT_ID, SEC = process.env.SPAPI_CLIENT_SECRET;
const U = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
if (!U || !KEY || !CID || !SEC) { console.error('FEHLER: ENV fehlt.'); process.exit(1); }
const SPAPI = 'https://sellingpartnerapi-eu.amazon.com';
const sbHead = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MKT_MAP = { DE: 'A1PA6795UKMFR9', FR: 'A13V1IB3VIYZZH', IT: 'APJ6JRA9NG5V4', ES: 'A1RKKUPIHCS9HS', UK: 'A1F83G8C2ARO7P', US: 'ATVPDKIKX0DER', NL: 'A1805IZSGTT6HS' };

async function authFor(spid) {
  const r = await fetch(`${U}/rest/v1/spapi_accounts?selling_partner_id=eq.${spid}&select=refresh_token`, { headers: sbHead });
  const rows = await r.json(); if (!rows.length) return null;
  const t = await fetch('https://api.amazon.co.uk/auth/o2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rows[0].refresh_token, client_id: CID, client_secret: SEC }) });
  const tj = await t.json(); return tj.access_token ? { 'x-amz-access-token': tj.access_token, 'Content-Type': 'application/json' } : null;
}
async function api(H, path, opts = {}, retries = 8) {
  for (let i = 0; i < retries; i++) {
    let r; try { r = await fetch(`${SPAPI}${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); } catch (e) { await sleep(8000); continue; }
    if (r.status === 429) { await sleep(30000); continue; }
    return r;
  } return null;
}
async function pullListings(H, mkt) {
  const c = await api(H, '/reports/2021-06-30/reports', { method: 'POST', body: JSON.stringify({ reportType: 'GET_MERCHANT_LISTINGS_ALL_DATA', marketplaceIds: [mkt] }) });
  if (!c) return null; const cj = await c.json(); if (!cj.reportId) return null;
  let docId = null;
  for (let i = 0; i < 60; i++) { await sleep(5000); const g = await api(H, `/reports/2021-06-30/reports/${cj.reportId}`); if (!g) return null; const gj = await g.json(); if (gj.processingStatus === 'DONE') { docId = gj.reportDocumentId; break; } if (['FATAL', 'CANCELLED'].includes(gj.processingStatus)) return null; }
  if (!docId) return null;
  const dr = await api(H, `/reports/2021-06-30/documents/${docId}`); if (!dr) return null; const drj = await dr.json();
  const raw = await fetch(drj.url); let buf = Buffer.from(await raw.arrayBuffer());
  if (drj.compressionAlgorithm === 'GZIP') buf = zlib.gunzipSync(buf);
  return buf.toString('utf8'); // Titel korrekt dekodieren (Report ist UTF-8)
}
async function main() {
  const cr = await fetch(`${U}/rest/v1/sqp_clients?active=eq.true&select=name,spid,marketplace`, { headers: sbHead });
  const clients = await cr.json();
  console.log(`ASIN-Meta: ${clients.length} Kunde(n)`);
  for (const cl of clients) {
    const mkt = MKT_MAP[(cl.marketplace || 'DE').toUpperCase()] || 'A1PA6795UKMFR9';
    const H = await authFor(cl.spid);
    if (!H) { console.log(`  ${cl.name}: kein Token — übersprungen`); continue; }
    const txt = await pullListings(H, mkt);
    if (!txt) { console.log(`  ${cl.name}: Report fehlgeschlagen`); continue; }
    const lines = txt.replace(/^﻿/, '').split('\n').filter(Boolean);
    const hdr = lines[0].split('\t');
    const iA = hdr.findIndex(h => /asin[\s_]*1/i.test(h));
    const iT = hdr.findIndex(h => /item-?name|artikelbezeichnung/i.test(h));
    const iK = hdr.findIndex(h => /seller-?sku|ndler-?sku/i.test(h));
    const map = new Map(); // asin -> {sku,title} (erste Nennung gewinnt)
    for (const l of lines.slice(1)) {
      const r = l.split('\t');
      const asin = (iA >= 0 ? r[iA] : (r.find(x => /^B0[A-Z0-9]{8}$/.test((x || '').trim())) || '')).trim();
      if (!/^B0[A-Z0-9]{8}$/.test(asin) || map.has(asin)) continue;
      map.set(asin, { sku: iK >= 0 ? (r[iK] || '').trim() : null, title: iT >= 0 ? (r[iT] || '').trim().slice(0, 300) : null });
    }
    const rows = [...map.entries()].map(([asin, m]) => ({ spid: cl.spid, asin, sku: m.sku || null, title: m.title || null }));
    let ok = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const up = await fetch(`${U}/rest/v1/sqp_asin_meta?on_conflict=spid,asin`, { method: 'POST', headers: { ...sbHead, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows.slice(i, i + 500)) });
      if (up.ok) ok += Math.min(500, rows.length - i); else console.log('  UPSERT', up.status, (await up.text()).slice(0, 120));
    }
    console.log(`  ${cl.name}: ${ok} ASINs mit Titel/SKU gespeichert`);
  }
  console.log('FERTIG.');
}
main().catch(e => { console.error('FEHLER', e.message); process.exit(1); });
