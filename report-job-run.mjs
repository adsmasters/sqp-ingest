// Schreibt EINE Zeile in server_job_runs, wenn ein Job-Schritt auf dem Server fertig ist.
// Aufruf: node report-job-run.mjs <job> <exit-code> [log-tail-datei]   (von deploy/server-job.sh; Umgebung aus /opt/sqp-ingest/.env)
// Exit 0 = success, 124 (timeout-Werkzeug) = timeout, 137/143 (SIGKILL/SIGTERM, z. B. Speicher voll) = killed, sonst failed.
// Das Melden darf den Job nie kaputt machen: Fehler werden nur geloggt, das Programm endet immer normal.
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

export function runResult(code) {
  if (code === undefined || code === null || code === '') return 'failed';
  const n = Number(code);
  if (Number.isNaN(n)) return 'failed';
  if (n === 0) return 'success';
  if (n === 124) return 'timeout';
  if (n === 137 || n === 143) return 'killed';
  if (n === 99) return 'skipped'; // von deploy/server-job.sh gesetzt: Schritt wegen vorbeigegangenem Nachtfenster nicht gestartet
  return 'failed';
}

export function buildRunRow({ job, exitCode, host, detail, now = new Date() }) {
  const d = String(detail ?? '').trim();
  return { job, kind: 'run', result: runResult(exitCode), exit_status: String(exitCode), host, detail: d ? d.slice(-1500) : null, finished_at: now.toISOString() };
}

export async function reportRun({ job, exitCode, detail, env = process.env, fetchImpl = fetch, host = os.hostname(), log = console.log }) {
  const U = env.SUPABASE_URL, K = env.SUPABASE_SERVICE_KEY;
  if (!U || !K) { log('report-job-run: SUPABASE_URL/SUPABASE_SERVICE_KEY fehlen — nichts gemeldet.'); return false; }
  try {
    const r = await fetchImpl(`${U}/rest/v1/server_job_runs`, {
      method: 'POST',
      headers: { apikey: K, Authorization: 'Bearer ' + K, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(buildRunRow({ job, exitCode, host, detail })),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) { log(`report-job-run: HTTP ${r.status} — Lauf von ${job} nicht gemeldet.`); return false; }
    return true;
  } catch (e) { log(`report-job-run: ${e.message} — Lauf von ${job} nicht gemeldet.`); return false; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [job, exitCode, tailFile] = process.argv.slice(2);
  let detail = '';
  try { if (tailFile) detail = fs.readFileSync(tailFile, 'utf8'); } catch (e) { /* kein Log-Tail */ }
  const ok = await reportRun({ job, exitCode, detail });
  console.log(ok ? `report-job-run: ${job} -> ${runResult(exitCode)} gemeldet.` : `report-job-run: ${job} NICHT gemeldet (siehe oben).`);
}
