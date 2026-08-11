// Arbeitet die Backfill-Warteschlange (sqp_backfill_jobs) ab — läuft in GitHub Actions.
// Je Job: 12 Monate + 13 Wochen SQP für den Kunden. Teilläufe werden erneut eingereiht.
// PARALLEL je Seller: Amazons SQP-Report-Drossel gilt pro Verkäuferkonto (eigener Token je Kunde),
// darum laufen bis zu 4 Kunden gleichzeitig — statt dass ein Riesen-Katalog alle anderen blockiert.
import { spawn, spawnSync } from 'node:child_process';
const U = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
if (!U || !KEY) { console.error('FEHLER: SUPABASE_URL/SERVICE_KEY fehlen.'); process.exit(1); }
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
const iso = d => d.toISOString().slice(0, 10);

// Gesamt-Budget in Minuten (Workflow-Timeout 350 abzügl. Audit-/Sales-Traffic-Steps danach)
const BUDGET_MIN = +(process.env.WORKER_BUDGET_MIN || 230);
const MAX_PAR = +(process.env.WORKER_MAX_PARALLEL || 4);
const t0 = Date.now();
const leftMin = () => BUDGET_MIN - (Date.now() - t0) / 60000;

async function queuedJobs() {
  // queued + verwaiste running-Jobs (>6h ohne Abschluss = abgebrochener Lauf)
  const stale = new Date(Date.now() - 6 * 3600e3).toISOString();
  const r = await fetch(`${U}/rest/v1/sqp_backfill_jobs?or=(status.eq.queued,and(status.eq.running,started_at.lt.${stale}))&order=requested_at.asc`, { headers: H });
  return r.ok ? await r.json() : [];
}
async function patch(id, body) {
  // Nie werfen: ein transienter Netzfehler (EPIPE) hat am 01.08. den ganzen Worker gekillt
  for (let a = 0; a < 5; a++) {
    try { const r = await fetch(`${U}/rest/v1/sqp_backfill_jobs?id=eq.${id}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) }); if (r.ok) return; } catch (e) {}
    await new Promise(r => setTimeout(r, 3000 * (a + 1)));
  }
  console.log(`  WARNUNG: Status-Update für Job ${id} fehlgeschlagen — weiter.`);
}

// Kind-Prozess mit Deadline; stdout-Zeilen bekommen ein Kunden-Präfix (parallele Logs lesbar halten)
function run(args, env, label, deadlineMs) {
  return new Promise(resolve => {
    const p = spawn('node', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let killed = false;
    const t = setTimeout(() => { killed = true; p.kill('SIGTERM'); }, Math.max(60000, deadlineMs));
    const pipe = s => { let buf = ''; s.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { console.log(`[${label}] ${buf.slice(0, i)}`); buf = buf.slice(i + 1); } }); };
    pipe(p.stdout); pipe(p.stderr);
    p.on('close', code => { clearTimeout(t); resolve(killed ? 'timeout' : code); });
    p.on('error', () => { clearTimeout(t); resolve('error'); });
  });
}

const list = await queuedJobs();
if (!list.length) { console.log('Queue leer — nichts zu tun.'); process.exit(0); }

// Meta EINMAL fuer alle (Titel/SKU/Status/Marke) — der Marken-Filter braucht die Brand-Zuordnung vor dem SQP-Import
console.log('--- Produkt-Meta (Titel/SKU/Marke), einmal fuer alle Kunden ---');
spawnSync('node', ['asin-meta.mjs'], { stdio: 'inherit', env: process.env });

const now = new Date();
const end = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
// Schnell-Modus (Standard): 3 Monate + 6 Wochen — Onboarding ist in Stunden statt Naechten fertig.
// Volle Historie (12 Monate + 13 Wochen) nur, wenn der Job explizit angefordert wurde (note enthaelt "voll").
const rangeFor = j => /voll|full/i.test(j.note || '')
  ? { start: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1))), weeks: '13', label: 'VOLL (12M+13W)' }
  : { start: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1))), weeks: '6', label: 'schnell (3M+6W)' };

// SQP-Fenster: alles bis auf eine Reserve fuer den Ads-Block am Ende
const sqpDeadlineMs = Math.max(20, leftMin() - 25) * 60000;
console.log(`SQP-Fenster: ${Math.round(sqpDeadlineMs / 60000)} Min, bis zu ${MAX_PAR} Kunden parallel.`);

// Nur ein Job je Seller-Konto gleichzeitig (gleicher Token = gleiche Quota), z.B. Recoactiv DE+IT
const bySeller = new Map();
for (const j of list) { if (!bySeller.has(j.spid)) bySeller.set(j.spid, []); bySeller.get(j.spid).push(j); }
const lanes = [...bySeller.values()]; // jede "Lane" = ein Seller, Jobs darin sequenziell
const isPartial = j => /Teillauf/i.test(j.note || '');
// Innerhalb der Lane: frisches Onboarding VOR alten Teillauf-Riesen (Recoactiv FR
// verhungerte sonst hinter dem 12-Monats-VOLL-Job desselben Sellers).
for (const l of lanes) l.sort((a, b) => (isPartial(a) - isPartial(b)) || (a.requested_at < b.requested_at ? -1 : 1));
// Lanes mit frischen Jobs zuerst (bestimmt nur die Reihenfolge der Zeitscheiben)
lanes.sort((a, b) => (a.every(isPartial) - b.every(isPartial)) || (a[0].requested_at < b[0].requested_at ? -1 : 1));

async function runJob(j, budgetMs) {
  if (budgetMs < 5 * 60000) { console.log(`[${j.spid}] Fenster zu — Job ${j.id} bleibt eingereiht.`); return 'skipped'; }
  try {
    const range = rangeFor(j);
    console.log(`[${j.spid}] Job ${j.id} startet (${j.marketplace_id}) — ${range.label}, Zeitscheibe ${Math.round(budgetMs / 60000)} Min`);
    await patch(j.id, { status: 'running', started_at: new Date().toISOString() });
    const jt0 = Date.now();
    const env = { ...process.env, SQP_SPID: j.spid, SQP_MKT: j.marketplace_id, SQP_CREATE_GAP: '15000', SQP_JOB_NOTE: j.note || '' };
    // Concurrency 8: Multi-ASIN-Reports stehen ~10 Min in Amazons Queue — mehr gleichzeitig
    // wartende Reports überlappen die Latenz (die Create-RATE drosselt weiter das Gate)
    const m = await run(['sqp-backfill.mjs', range.start, end, '8'], env, j.spid, budgetMs);
    const w = m === 0 ? await run(['sqp-backfill-week.mjs', range.weeks, '8'], env, j.spid, budgetMs - (Date.now() - jt0)) : 'skipped';
    if (m === 0 && w === 0) {
      await patch(j.id, { status: 'done', finished_at: new Date().toISOString(), note: /voll|full/i.test(j.note || '') ? 'volle Historie geladen' : null });
      console.log(`[${j.spid}] Job ${j.id}: FERTIG (${range.label})`);
      return 'done';
    }
    // Teillauf: "voll"-Marker im note erhalten, sonst wuerde die Fortsetzung im Schnell-Modus laufen
    const keepFull = /voll|full/i.test(j.note || '') ? ' [voll]' : '';
    await patch(j.id, { status: 'queued', note: 'Teillauf, wird beim nächsten Lauf fortgesetzt' + keepFull });
    console.log(`[${j.spid}] Job ${j.id}: Teillauf (${m}/${w}), erneut eingereiht${keepFull}`);
    return 'partial';
  } catch (e) { // ein Job darf nicht den Worker abreissen
    console.log(`[${j.spid}] Job ${j.id}: FEHLER ${e.message} — erneut eingereiht.`);
    await patch(j.id, { status: 'queued', note: 'Fehler im Lauf, wird erneut versucht' });
    return 'partial';
  }
}

// Zeitscheiben-Rotation: jede Lane bekommt pro Runde höchstens EINE Scheibe, statt dass
// die 4 ältesten Teillauf-Riesen das ganze Fenster monopolisieren — Jobs ab Ende Juli
// bekamen dadurch NÄCHTELANG "Fenster zu" und neue Kunden sahen tagelang keinen Import.
const SLICE_MS = Math.max(20 * 60000, Math.floor(sqpDeadlineMs / Math.max(1, lanes.length)));
console.log(`Zeitscheibe je Seller und Runde: ${Math.round(SLICE_MS / 60000)} Min (${lanes.length} Seller).`);
const queues = lanes.map(l => [...l]);
const windowLeft = () => sqpDeadlineMs - (Date.now() - t0);
while (windowLeft() > 5 * 60000 && queues.some(q => q.length)) {
  const active = queues.filter(q => q.length);
  for (let i = 0; i < active.length && windowLeft() > 5 * 60000; i += MAX_PAR) {
    await Promise.all(active.slice(i, i + MAX_PAR).map(async q => {
      const j = q.shift(); if (!j) return;
      const res = await runJob(j, Math.min(SLICE_MS, windowLeft()));
      if (res === 'partial') q.push(j); // ans Lane-Ende — nächste Runde wieder dran
    }));
  }
}

// PPC-Daten EINMAL am Ende (Ads-API, EINE Agentur-Quota — deshalb nicht parallel und nicht je Job)
if (leftMin() > 10) {
  console.log('\n--- PPC-Daten (Ads), einmal fuer alle Kunden ---');
  // Math.round: spawnSync verlangt Integer-Timeout — Float crashte den Ads-Block (01.08.)
  spawnSync('node', ['ads-refresh.mjs'], { stdio: 'inherit', env: process.env, timeout: Math.round(Math.max(60000, leftMin() * 60000)), killSignal: 'SIGTERM' });
  spawnSync('node', ['ads-periodic.mjs', '4'], { stdio: 'inherit', env: process.env, timeout: Math.round(Math.max(60000, leftMin() * 60000)), killSignal: 'SIGTERM' });
}
console.log('\nWorker fertig.');
