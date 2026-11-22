// Letzter Schritt der Server-Nachtkette ("night/chain", deploy/systemd/sqp-night.service).
// Warum: die Schritte laufen mit ExecStart=- (ein Fehler stoppt die naechsten nicht), deshalb zeigt systemd die ganze Kette auch dann als
// "success", wenn ein Schritt gescheitert ist. Dieser Schritt liest, was die 7 echten Schritte heute Nacht gemeldet haben (Tabelle server_job_runs),
// schreibt EINE Zeile ins Log und beendet sich mit Exit 1, wenn irgendein Schritt nicht erfolgreich war oder gar nichts gemeldet hat.
// Dann zeigt auch die Zeile "night/chain" (durch deploy/server-job.sh) und `systemctl status sqp-night` die Wahrheit.
// Aufruf: ueber den Wrapper (deploy/server-job.sh night/chain 5 night-summary.mjs); Umgebung aus /opt/sqp-ingest/.env.
// Nennt nur Job-Namen, nie Log-Details oder Kundennamen. Kann die Tabelle nicht gelesen werden, wird NIE "Erfolg" behauptet.
import { pathToFileURL } from 'node:url';

// Genau die echten Schritte aus sqp-ingest/deploy/systemd/sqp-night.service (ohne den Marker selbst), in derselben Reihenfolge
// (tests/night-summary.test.mjs vergleicht die Liste mit der Unit-Datei).
export const NIGHT_STEPS = ['vendor/sales', 'vendor/ads', 'daily-data/sales-traffic', 'ads/refresh', 'audit-terms', 'daily-data/audit', 'ads/periodic'];
const WINDOW_H = 14; // Kette startet 18:00 UTC, endet ~01:30 UTC (schlechte Nacht ~04:00); aeltere Zeilen gehoeren zu einer frueheren Nacht

export function summarizeNight(rows, { now = Date.now(), steps = NIGHT_STEPS, windowH = WINDOW_H } = {}) {
  const since = now - windowH * 3600e3;
  const problems = [];
  for (const job of steps) {
    const latest = (rows || [])
      .filter((r) => r.job === job && (r.kind || 'run') === 'run' && Date.parse(r.finished_at) >= since)
      .sort((a, b) => Date.parse(b.finished_at) - Date.parse(a.finished_at))[0];
    if (!latest) { problems.push({ job, text: `${job} (kein Lauf gemeldet)` }); continue; }
    if (latest.result === 'success') continue;
    const exit = latest.exit_status != null && latest.exit_status !== '' ? `, exit ${latest.exit_status}` : '';
    problems.push({ job, text: `${job} (${latest.result}${exit})` });
  }
  const okCount = steps.length - problems.length;
  const text = problems.length
    ? `Nacht-Zusammenfassung: ${okCount} von ${steps.length} Schritten erfolgreich, NICHT erfolgreich: ${problems.map((p) => p.text).join(', ')}`
    : `Nacht-Zusammenfassung: ${steps.length} von ${steps.length} Schritten erfolgreich.`;
  return { ok: problems.length === 0, text, problems };
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const RETRYABLE = (status) => status >= 500 || status === 429;

// Liest die Zeilen der letzten WINDOW_H Stunden (bis zu 3 Versuche; nur bei Netzfehler/5xx/429). Wirft nie: Rueckgabe { rows } oder { error }.
async function readRows({ env, fetchImpl, now, sleepImpl, log, steps }) {
  const U = env.SUPABASE_URL, K = env.SUPABASE_SERVICE_KEY;
  if (!U || !K) return { error: 'SUPABASE_URL/SUPABASE_SERVICE_KEY fehlen' };
  const q = new URLSearchParams({
    select: 'job,kind,result,exit_status,finished_at',
    kind: 'eq.run',
    job: `in.(${steps.join(',')})`,
    finished_at: 'gte.' + new Date(now - WINDOW_H * 3600e3).toISOString(),
    order: 'finished_at.desc',
    limit: '200',
  });
  const ATTEMPTS = 3, PAUSE = [5000, 20000];
  let last = 'unbekannter Fehler';
  for (let a = 1; a <= ATTEMPTS; a++) {
    let retry = false;
    try {
      const r = await fetchImpl(`${U}/rest/v1/server_job_runs?${q}`, { headers: { apikey: K, Authorization: 'Bearer ' + K }, signal: AbortSignal.timeout(30000) });
      if (r.ok) return { rows: await r.json() };
      last = `HTTP ${r.status}`; retry = RETRYABLE(r.status);
    } catch (e) { last = e.message; retry = true; }
    log(`night-summary: Lesen fehlgeschlagen (${last}), Versuch ${a}/${ATTEMPTS}.`);
    if (!retry || a === ATTEMPTS) break;
    await sleepImpl(PAUSE[a - 1]);
  }
  return { error: last };
}

export async function runSummary({ env = process.env, fetchImpl = fetch, now = Date.now(), sleepImpl = sleep, log = console.log, steps = NIGHT_STEPS } = {}) {
  try {
    const got = await readRows({ env, fetchImpl, now, sleepImpl, log, steps });
    if (got.error || !Array.isArray(got.rows)) return { code: 1, text: `Nacht-Zusammenfassung: Meldungen nicht lesbar (${got.error || 'unerwartete Antwort'}) — Erfolg kann nicht bestaetigt werden.` };
    const s = summarizeNight(got.rows, { now, steps });
    return { code: s.ok ? 0 : 1, text: s.text };
  } catch (e) {
    return { code: 1, text: `Nacht-Zusammenfassung: Meldungen nicht lesbar (${e.message}) — Erfolg kann nicht bestaetigt werden.` };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { code, text } = await runSummary();
  console.log(text);
  process.exitCode = code;
}
