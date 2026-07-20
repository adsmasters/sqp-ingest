// Arbeitet die Backfill-Warteschlange (sqp_backfill_jobs) ab — läuft in GitHub Actions.
// Je Job: 12 Monate + 13 Wochen SQP für den Kunden. Teilläufe werden erneut eingereiht.
// Fairness: kleine Kunden zuerst, festes Zeit-Budget je Job — so kommt jede Nacht JEDER Kunde voran,
// statt dass ein Riesen-Katalog (Tausende ASINs = Tausende Amazon-Reports) alle anderen blockiert.
import { spawnSync } from 'node:child_process';
const U = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
if (!U || !KEY) { console.error('FEHLER: SUPABASE_URL/SERVICE_KEY fehlen.'); process.exit(1); }
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
const iso = d => d.toISOString().slice(0, 10);

// Gesamt-Budget in Minuten (Workflow-Timeout 350 abzügl. Audit-/Sales-Traffic-Steps danach)
const BUDGET_MIN = +(process.env.WORKER_BUDGET_MIN || 230);
const t0 = Date.now();
const leftMin = () => BUDGET_MIN - (Date.now() - t0) / 60000;

async function queuedJobs() {
  // queued + verwaiste running-Jobs (>6h ohne Abschluss = abgebrochener Lauf)
  const stale = new Date(Date.now() - 6 * 3600e3).toISOString();
  const r = await fetch(`${U}/rest/v1/sqp_backfill_jobs?or=(status.eq.queued,and(status.eq.running,started_at.lt.${stale}))&order=requested_at.asc`, { headers: H });
  return r.ok ? await r.json() : [];
}
async function patch(id, body) {
  await fetch(`${U}/rest/v1/sqp_backfill_jobs?id=eq.${id}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) });
}
async function asinCount(spid) {
  const r = await fetch(`${U}/rest/v1/sqp_asin_meta?selling_partner_id=eq.${spid}&select=asin`, { headers: { ...H, Prefer: 'count=exact', Range: '0-0' } });
  const cr = r.headers.get('content-range') || '';
  const n = +(cr.split('/')[1] || 0);
  return n || 999999; // unbekannt (Meta fehlt noch) = vermutlich groß -> ans Ende
}

const list = await queuedJobs();
if (!list.length) { console.log('Queue leer — nichts zu tun.'); process.exit(0); }

// Meta EINMAL fuer alle (Titel/SKU/Status/Marke) — der Marken-Filter braucht die Brand-Zuordnung vor dem SQP-Import
console.log('--- Produkt-Meta (Titel/SKU/Marke), einmal fuer alle Kunden ---');
spawnSync('node', ['asin-meta.mjs'], { stdio: 'inherit', env: process.env });

// Kleine Kataloge zuerst — die werden schnell FERTIG, die grossen kriegen den Rest der Nacht
for (const j of list) j._n = await asinCount(j.spid);
list.sort((a, b) => a._n - b._n);
console.log('Reihenfolge:', list.map(j => `${j.spid}(${j._n === 999999 ? '?' : j._n} ASINs)`).join(' → '));

const now = new Date();
const start = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1)));
const end = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));

for (let i = 0; i < list.length; i++) {
  const j = list[i];
  if (leftMin() < 20) { console.log(`Budget aufgebraucht (${leftMin().toFixed(0)} Min übrig) — Rest bleibt eingereiht.`); break; }
  // Zeit-Scheibe: Rest-Budget fair auf verbleibende Jobs verteilen (Kleine brauchen ihre Scheibe nicht auf)
  const sliceMin = Math.max(20, Math.floor(leftMin() / (list.length - i)));
  console.log(`\n=== Job ${j.id}: ${j.spid} (${j.marketplace_id}) — Zeit-Budget ${sliceMin} Min, ${j._n === 999999 ? '?' : j._n} ASINs ===`);
  await patch(j.id, { status: 'running', started_at: new Date().toISOString() });
  const env = { ...process.env, SQP_SPID: j.spid, SQP_MKT: j.marketplace_id, SQP_CREATE_GAP: '15000' };
  const jobT0 = Date.now();
  const msLeft = () => Math.max(60000, sliceMin * 60000 - (Date.now() - jobT0));
  // Kind-Prozesse werden am Ende der Zeit-Scheibe beendet; Fortschritt ist je (ASIN, Zeitraum) gespeichert
  const m = spawnSync('node', ['sqp-backfill.mjs', start, end, '3'], { stdio: 'inherit', env, timeout: msLeft(), killSignal: 'SIGTERM' });
  const w = spawnSync('node', ['sqp-backfill-week.mjs', '13', '3'], { stdio: 'inherit', env, timeout: msLeft(), killSignal: 'SIGTERM' });
  if (m.status === 0 && w.status === 0) {
    await patch(j.id, { status: 'done', finished_at: new Date().toISOString(), note: null });
    console.log(`Job ${j.id}: FERTIG`);
  } else {
    await patch(j.id, { status: 'queued', note: 'Teillauf, wird beim nächsten Lauf fortgesetzt' });
    console.log(`Job ${j.id}: Teillauf (Zeit-Scheibe erschöpft oder Fehler), erneut eingereiht`);
  }
}

// PPC-Daten EINMAL am Ende (Ads-API, eigene Quota) — nicht mehr je Job
if (leftMin() > 10) {
  console.log('\n--- PPC-Daten (Ads), einmal fuer alle Kunden ---');
  spawnSync('node', ['ads-refresh.mjs'], { stdio: 'inherit', env: process.env, timeout: Math.max(60000, leftMin() * 60000), killSignal: 'SIGTERM' });
  spawnSync('node', ['ads-periodic.mjs', '4'], { stdio: 'inherit', env: process.env, timeout: Math.max(60000, leftMin() * 60000), killSignal: 'SIGTERM' });
}
console.log('\nWorker fertig.');
