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
// Upsert marketplace-aware; Fallback aufs alte Schema (spid,asin), solange die
// Migration migration_asin_meta_marketplace.sql noch nicht gelaufen ist.
async function upsertMeta(rows) {
  let ok = 0, legacy = false;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    let up = legacy ? null : await fetch(`${U}/rest/v1/sqp_asin_meta?on_conflict=spid,asin,marketplace`, { method: 'POST', headers: { ...sbHead, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(chunk) });
    if (!up || !up.ok) {
      legacy = true; // Spalte/Constraint fehlt noch -> altes Verhalten
      up = await fetch(`${U}/rest/v1/sqp_asin_meta?on_conflict=spid,asin`, { method: 'POST', headers: { ...sbHead, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(chunk.map(({ marketplace, ...r }) => r)) });
    }
    if (up.ok) ok += chunk.length; else console.log('  UPSERT', up.status, (await up.text()).slice(0, 120));
  }
  if (legacy) console.log('  HINWEIS: sqp_asin_meta noch ohne marketplace-Spalte — Migration ausführen!');
  return ok;
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
    const iS = hdr.findIndex(h => /^status$|angebotsstatus|listing-?status/i.test((h || '').trim()));
    const ACT = new Set(['active', 'aktiv', 'actif', 'activo', 'attivo']);
    const map = new Map(); // asin -> {sku,title,status} (aktivste Nennung gewinnt)
    for (const l of lines.slice(1)) {
      const r = l.split('\t');
      const asin = (iA >= 0 ? r[iA] : (r.find(x => /^B0[A-Z0-9]{8}$/.test((x || '').trim())) || '')).trim();
      if (!/^B0[A-Z0-9]{8}$/.test(asin)) continue;
      const raw = iS >= 0 ? (r[iS] || '').trim().toLowerCase() : '';
      const status = !raw ? null : (ACT.has(raw) ? 'active' : 'inactive');
      const prev = map.get(asin);
      if (prev && prev.status === 'active') continue; // aktive Nennung nicht überschreiben
      if (prev && !prev.status && status !== 'active') continue;
      map.set(asin, { sku: iK >= 0 ? (r[iK] || '').trim() : null, title: iT >= 0 ? (r[iT] || '').trim().slice(0, 300) : null, status });
    }
    const mktCode = (cl.marketplace || 'DE').toUpperCase();
    const rows = [...map.entries()].map(([asin, m]) => ({ spid: cl.spid, marketplace: mktCode, asin, sku: m.sku || null, title: m.title || null, status: m.status }));
    const ok = await upsertMeta(rows);
    console.log(`  ${cl.name}: ${ok} ASINs mit Titel/SKU gespeichert`);
    // Marke je ASIN via Listings-Items-API ergaenzen (attributes.brand; Catalog-API-Rolle fehlt im Consent)
    const br = await fetch(`${U}/rest/v1/sqp_asin_meta?spid=eq.${cl.spid}&brand=is.null&select=asin&limit=10000`, { headers: { ...sbHead, Range: '0-9999' } });
    const missing = new Set(br.ok ? (await br.json()).map(x => x.asin) : []);
    if (missing.size) {
      const brandByAsin = {}; let pageToken = null;
      for (let p = 0; p < 100; p++) {
        const u = `/listings/2021-08-01/items/${cl.spid}?marketplaceIds=${mkt}&pageSize=20&includedData=summaries,attributes` + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
        const r = await api(H, u); if (!r || !r.ok) break;
        const j = await r.json();
        for (const it of (j.items || [])) {
          const s = (it.summaries || [])[0] || {};
          const b = it.attributes && it.attributes.brand && it.attributes.brand[0] && it.attributes.brand[0].value;
          if (s.asin && b && missing.has(s.asin)) brandByAsin[s.asin] = b;
        }
        pageToken = j.pagination && j.pagination.nextToken; if (!pageToken) break;
        await sleep(250);
      }
      const bu = Object.entries(brandByAsin).map(([asin, brand]) => ({ spid: cl.spid, marketplace: mktCode, asin, brand }));
      await upsertMeta(bu);
      console.log(`  ${cl.name}: Marken ergänzt für ${bu.length}/${missing.size} ASINs`);
    }
  }
  console.log('FERTIG.');
}
main().catch(e => { console.error('FEHLER', e.message); process.exit(1); });
