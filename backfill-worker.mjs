// Arbeitet die Backfill-Warteschlange (sqp_backfill_jobs) ab — läuft in GitHub Actions.
// Je Job: 12 Monate + 12 Wochen SQP für den Kunden. Teilläufe werden erneut eingereiht.
import { spawnSync } from 'node:child_process';
const U = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
if (!U || !KEY) { console.error('FEHLER: SUPABASE_URL/SERVICE_KEY fehlen.'); process.exit(1); }
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
const iso = d => d.toISOString().slice(0, 10);

async function queuedJobs() {
  // queued + verwaiste running-Jobs (>6h ohne Abschluss = abgebrochener Lauf)
  const stale = new Date(Date.now() - 6 * 3600e3).toISOString();
  const r = await fetch(`${U}/rest/v1/sqp_backfill_jobs?or=(status.eq.queued,and(status.eq.running,started_at.lt.${stale}))&order=requested_at.asc`, { headers: H });
  return r.ok ? await r.json() : [];
}
async function patch(id, body) {
  await fetch(`${U}/rest/v1/sqp_backfill_jobs?id=eq.${id}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) });
}

const list = await queuedJobs();
if (!list.length) { console.log('Queue leer — nichts zu tun.'); process.exit(0); }

const now = new Date();
const start = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1)));
const end = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));

for (const j of list) {
  console.log(`\n=== Job ${j.id}: ${j.spid} (${j.marketplace_id}) ===`);
  await patch(j.id, { status: 'running', started_at: new Date().toISOString() });
  const env = { ...process.env, SQP_SPID: j.spid, SQP_MKT: j.marketplace_id, SQP_CREATE_GAP: '15000' };
  const m = spawnSync('node', ['sqp-backfill.mjs', start, end, '3'], { stdio: 'inherit', env });
  const w = spawnSync('node', ['sqp-backfill-week.mjs', '13', '3'], { stdio: 'inherit', env });
  // PPC-Daten im selben Rutsch (Ads-API, eigene Quota): 30T-Snapshot + Monats-Historie
  console.log('--- PPC-Daten (Ads) ---');
  spawnSync('node', ['ads-refresh.mjs'], { stdio: 'inherit', env: process.env });
  spawnSync('node', ['ads-periodic.mjs', '4'], { stdio: 'inherit', env: process.env });
  // Produkt-Titel + SKUs (für Anzeige & Kampagnen-Anlage)
  spawnSync('node', ['asin-meta.mjs'], { stdio: 'inherit', env: process.env });
  if (m.status === 0 && w.status === 0) {
    await patch(j.id, { status: 'done', finished_at: new Date().toISOString(), note: null });
    console.log(`Job ${j.id}: FERTIG`);
  } else {
    await patch(j.id, { status: 'queued', note: 'Teillauf, wird beim nächsten Lauf fortgesetzt' });
    console.log(`Job ${j.id}: Teillauf, erneut eingereiht`);
  }
}
