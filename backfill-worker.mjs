// Arbeitet die Backfill-Warteschlange (sqp_backfill_jobs) ab — läuft in GitHub Actions.
// Je Job: 12 Monate + 13 Wochen SQP für den Kunden. Teilläufe werden erneut eingereiht.
// PARALLEL je Seller: Amazons SQP-Report-Drossel gilt pro Verkäuferkonto (eigener Token je Kunde),
// darum laufen bis zu 4 Kunden gleichzeitig — statt dass ein Riesen-Katalog alle anderen blockiert.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
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
    // Node-setTimeout ist 32-bit-begrenzt (~24,8 Tage): Überlauf setzt den Timer auf 1ms
    // und killte jeden Import SOFORT (Daemon-Budget 100000 Min, 12.08.) — deshalb deckeln.
    const t = setTimeout(() => { killed = true; p.kill('SIGTERM'); }, Math.min(Math.max(60000, deadlineMs), 0x7FFFFFFF));
    const pipe = s => { let buf = ''; s.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { console.log(`[${label}] ${buf.slice(0, i)}`); buf = buf.slice(i + 1); } }); };
    pipe(p.stdout); pipe(p.stderr);
    p.on('close', code => { clearTimeout(t); resolve(killed ? 'timeout' : code); });
    p.on('error', () => { clearTimeout(t); resolve('error'); });
  });
}

const list = await queuedJobs();
if (!list.length) { console.log('Queue leer — nichts zu tun.'); process.exit(0); }

// Daemon-Modus (SIDE_MIN_GAP_H gesetzt): Meta/Ads nur, wenn der letzte Lauf laenger her ist —
// sie fraßen sonst jeden 60-Min-Zyklus ~25+ Min (14 Kunden), waehrend SQP-Jobs warteten.
const SIDE_GAP_MS = +(process.env.SIDE_MIN_GAP_H || 0) * 3600e3;
const sideDue = mark => { if (!SIDE_GAP_MS) return true; try { return Date.now() - fs.statSync(mark).mtimeMs > SIDE_GAP_MS; } catch (e) { return true; } };
const sideDone = mark => { try { fs.writeFileSync(mark, String(Date.now())); } catch (e) {} };

// Meta EINMAL fuer alle (Titel/SKU/Status/Marke) — der Marken-Filter braucht die Brand-Zuordnung vor dem SQP-Import
if (sideDue('/tmp/sqpr-meta-last')) {
  console.log('--- Produkt-Meta (Titel/SKU/Marke), einmal fuer alle Kunden ---');
  spawnSync('node', ['asin-meta.mjs'], { stdio: 'inherit', env: process.env });
  sideDone('/tmp/sqpr-meta-last');
} else console.log('Produkt-Meta: zuletzt vor <' + process.env.SIDE_MIN_GAP_H + 'h — übersprungen.');

const now = new Date();
// Publikations-Lag: Amazon stellt den Vormonat erst ~Tag 3-5 bereit. Ein Import am 1.-4.
// bekam FATAL und vermerkte jede ASIN dauerhaft als "leer" (Deep-Dive 12.08.) — die
// Wochen hatten diesen Schutz (LAG_DAYS), die Monate nicht.
const end = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (now.getUTCDate() >= 5 ? 1 : 2), 1)));
// Schnell-Modus (Standard): 3 Monate + 6 Wochen — Onboarding ist in Stunden statt Naechten fertig.
// Volle Historie (12 Monate + 13 Wochen) nur, wenn der Job explizit angefordert wurde (note enthaelt "voll").
const rangeFor = j => /voll|full/i.test(j.note || '')
  ? { start: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1))), weeks: '13', label: 'VOLL (12M+13W)' }
  : { start: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1))), weeks: '6', label: 'schnell (3M+6W)' };

// SQP-Fenster: alles bis auf eine Reserve fuer den Ads-Block am Ende —
// wird der Ads-Block ohnehin uebersprungen (6h-Gate), gehoert die Zeit dem SQP
const adsDue = sideDue('/tmp/sqpr-ads-last');
const sqpDeadlineMs = Math.max(20, leftMin() - (adsDue ? 25 : 2)) * 60000;
console.log(`SQP-Fenster: ${Math.round(sqpDeadlineMs / 60000)} Min, bis zu ${MAX_PAR} Kunden parallel.`);

// Nur ein Job je Seller-Konto gleichzeitig (gleicher Token = gleiche Quota), z.B. Recoactiv DE+IT
const bySeller = new Map();
for (const j of list) { if (!bySeller.has(j.spid)) bySeller.set(j.spid, []); bySeller.get(j.spid).push(j); }
const lanes = [...bySeller.values()]; // jede "Lane" = ein Seller, Jobs darin sequenziell
const isPartial = j => /Teillauf/i.test(j.note || '');
// [prio] in der Job-Notiz = dieser Kunde bekommt JEDE Runde zuerst eine Scheibe
// (ABACUS wartete 1,5 Wochen, weil alte Teillauf-Riesen per requested_at vorne lagen)
const isPrio = j => /\[prio\]/i.test(j.note || '');
// Innerhalb der Lane: frisches Onboarding VOR alten Teillauf-Riesen (Recoactiv FR
// verhungerte sonst hinter dem 12-Monats-VOLL-Job desselben Sellers).
for (const l of lanes) l.sort((a, b) => (isPrio(b) - isPrio(a)) || (isPartial(a) - isPartial(b)) || (a.requested_at < b.requested_at ? -1 : 1));
// Lanes mit frischen Jobs zuerst (bestimmt nur die Reihenfolge der Zeitscheiben)
lanes.sort((a, b) => (b.some(isPrio) - a.some(isPrio)) || (a.every(isPartial) - b.every(isPartial)) || (a[0].requested_at < b[0].requested_at ? -1 : 1));

async function runJob(j, budgetMs) {
  if (budgetMs < 5 * 60000) { console.log(`[${j.spid}] Fenster zu — Job ${j.id} bleibt eingereiht.`); return 'skipped'; }
  try {
    const range = rangeFor(j);
    // Atomarer Claim (Compare-and-Swap): nur übernehmen, wenn der Job noch queued oder
    // verwaist ist — GitHub-Actions-Lauf und Server-Daemon konnten denselben Job sonst
    // GLEICHZEITIG bearbeiten (doppeltes Report-Kontingent + Zeilen-Duplikate)
    const stale = new Date(Date.now() - 6 * 3600e3).toISOString();
    let claimed = false;
    try {
      const cr = await fetch(`${U}/rest/v1/sqp_backfill_jobs?id=eq.${j.id}&or=(status.eq.queued,started_at.lt.${stale})`,
        { method: 'PATCH', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify({ status: 'running', started_at: new Date().toISOString() }) });
      claimed = cr.ok && (await cr.json()).length > 0;
    } catch (e) {}
    if (!claimed) { console.log(`[${j.spid}] Job ${j.id}: schon von anderem Worker übernommen — übersprungen.`); return 'skipped'; }
    console.log(`[${j.spid}] Job ${j.id} startet (${j.marketplace_id}) — ${range.label}, Zeitscheibe ${Math.round(budgetMs / 60000)} Min`);
    const jt0 = Date.now();
    const env = { ...process.env, SQP_SPID: j.spid, SQP_MKT: j.marketplace_id, SQP_CREATE_GAP: '15000', SQP_JOB_NOTE: j.note || '' };
    // Hat der Kunde noch GAR KEINE Wochen, laufen die Wochen ZUERST — bei VOLL-Jobs
    // verhungerten sie sonst hinter 12 Monaten Backlog (ABACUS: 0 Wochen, 12.08.)
    let weeksFirst = false;
    try {
      const r = await fetch(`${U}/rest/v1/sqp_asin_rows?selling_partner_id=eq.${j.spid}&marketplace_id=eq.${j.marketplace_id}&report_period=eq.WEEK&select=id`, { headers: { ...H, Prefer: 'count=exact', Range: '0-0' } });
      weeksFirst = +((r.headers.get('content-range') || '0/0').split('/')[1]) === 0;
    } catch (e) {}
    // Concurrency 8: Multi-ASIN-Reports stehen ~10 Min in Amazons Queue — mehr gleichzeitig
    // wartende Reports überlappen die Latenz (die Create-RATE drosselt weiter das Gate)
    let m, w;
    if (weeksFirst) {
      console.log(`[${j.spid}] Noch keine Wochendaten — Wochen laufen zuerst.`);
      w = await run(['sqp-backfill-week.mjs', range.weeks, '8'], env, j.spid, budgetMs);
      m = w === 0 ? await run(['sqp-backfill.mjs', range.start, end, '8'], env, j.spid, budgetMs - (Date.now() - jt0)) : 'skipped';
    } else {
      m = await run(['sqp-backfill.mjs', range.start, end, '8'], env, j.spid, budgetMs);
      w = m === 0 ? await run(['sqp-backfill-week.mjs', range.weeks, '8'], env, j.spid, budgetMs - (Date.now() - jt0)) : 'skipped';
    }
    if (m === 0 && w === 0) {
      await patch(j.id, { status: 'done', finished_at: new Date().toISOString(), note: /voll|full/i.test(j.note || '') ? 'volle Historie geladen' : null });
      console.log(`[${j.spid}] Job ${j.id}: FERTIG (${range.label})`);
      return 'done';
    }
    // Teillauf: "voll"/"prio"-Marker im note erhalten, sonst wuerde die Fortsetzung
    // im Schnell-Modus bzw. ohne Vorrang laufen
    const keepFull = (/voll|full/i.test(j.note || '') ? ' [voll]' : '') + (/\[prio\]/i.test(j.note || '') ? ' [prio]' : '');
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
// Mindest-Scheibe per Env erhoehbar: Multi-ASIN-Reports brauchen 10-30 Min in Amazons
// Queue — 20-Min-Scheiben warfen die Ergebnisse jede Runde weg (12.08.)
const SLICE_MS = Math.max((+process.env.WORKER_SLICE_MIN || 20) * 60000, Math.floor(sqpDeadlineMs / Math.max(1, lanes.length)));
console.log(`Zeitscheibe je Seller und Runde: ${Math.round(SLICE_MS / 60000)} Min (${lanes.length} Seller).`);
const queues = lanes.map(l => [...l]);
const windowLeft = () => sqpDeadlineMs - (Date.now() - t0);
// Keine neue Lane starten, wenn die Restzeit keinen kompletten Report-Durchlauf mehr
// hergibt (Create + 10-30 Min Amazon-Queue) — halbe Scheiben verbrennen nur Kontingent
const MIN_START_MS = (+process.env.WORKER_MIN_START_MIN || 5) * 60000;
while (windowLeft() > MIN_START_MS && queues.some(q => q.length)) {
  const active = queues.filter(q => q.length);
  for (let i = 0; i < active.length && windowLeft() > MIN_START_MS; i += MAX_PAR) {
    await Promise.all(active.slice(i, i + MAX_PAR).map(async q => {
      const j = q.shift(); if (!j) return;
      const res = await runJob(j, Math.min(SLICE_MS, windowLeft()));
      if (res === 'partial') q.push(j); // ans Lane-Ende — nächste Runde wieder dran
    }));
  }
}

// PPC-Daten EINMAL am Ende (Ads-API, EINE Agentur-Quota — deshalb nicht parallel und nicht je Job)
if (leftMin() > 10 && sideDue('/tmp/sqpr-ads-last')) {
  console.log('\n--- PPC-Daten (Ads), einmal fuer alle Kunden ---');
  // Math.round: spawnSync verlangt Integer-Timeout — Float crashte den Ads-Block (01.08.)
  spawnSync('node', ['ads-refresh.mjs'], { stdio: 'inherit', env: process.env, timeout: Math.round(Math.max(60000, leftMin() * 60000)), killSignal: 'SIGTERM' });
  spawnSync('node', ['ads-periodic.mjs', '4'], { stdio: 'inherit', env: process.env, timeout: Math.round(Math.max(60000, leftMin() * 60000)), killSignal: 'SIGTERM' });
  sideDone('/tmp/sqpr-ads-last');
} else if (SIDE_GAP_MS) console.log('Ads-Block: zuletzt vor <' + process.env.SIDE_MIN_GAP_H + 'h — übersprungen.');
// Zyklus-Signal für den Wächter: der Daemon-Heartbeat (id=1) läuft auch, wenn jeder
// Zyklus crasht — id=2 beweist, dass Zyklen wirklich zu Ende laufen
try {
  await fetch(`${U}/rest/v1/worker_heartbeat?on_conflict=id`, { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ id: 2, host: 'zyklus-fertig', ts: new Date().toISOString() }) });
} catch (e) {}
console.log('\nWorker fertig.');
