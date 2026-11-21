// Meldungen fuer Jobs, die auf dem Hetzner-Server laufen (dort gibt es bewusst KEIN Slack-Secret).
// Jeder beendete Job-Schritt schreibt eine Zeile {job, kind:'run', result, exit_status, finished_at} in server_job_runs
// (deploy/server-job.sh -> report-job-run.mjs); der GitHub-Waechter (watchdog.mjs) liest sie und meldet nach Slack.
// Reine Funktionen, kein Netzwerk.

// Jobs, die bereits auf dem Server laufen UND melden. Beim Umzug eines Jobs wird er hier eingetragen
// (fristH = wie lange ohne erfolgreichen Lauf erlaubt ist, seit = ab wann ein fehlender Lauf zaehlt) und im selben Zug aus
// WF_FRIST in watchdog.mjs entfernt. Leer = nichts wird erwartet (kein Fehlalarm, bevor der Melder installiert ist).
export const SERVER_JOBS = {
  // 'vendor/sales': { fristH: 30, seit: '2026-11-21T00:00:00Z' },
};

const stamp = x => String(x).slice(0, 16) + 'Z';

// Meldungen (deutsch, ohne Log-Details und ohne Kundennamen). Der LETZTE Lauf entscheidet: ein spaeterer Erfolg loescht einen Fehler.
export function serverJobIssues(rows, now = Date.now(), config = SERVER_JOBS) {
  const out = [];
  for (const [job, c] of Object.entries(config)) {
    const runs = rows
      .filter(r => r.job === job && (r.kind || 'run') === 'run')
      .sort((a, b) => Date.parse(b.finished_at) - Date.parse(a.finished_at));
    const latest = runs[0];
    const lastOk = runs.find(r => r.result === 'success');
    const fristMs = c.fristH * 3600e3;
    if (!latest) {
      if (now > Date.parse(c.seit) + fristMs) out.push(`${job}: seit ${String(c.seit).slice(0, 10)} noch kein Lauf auf dem Server gemeldet`);
      continue;
    }
    if (latest.result === 'skipped') { // vom Nachtfenster-Schutz uebersprungen (deploy/server-job.sh)
      out.push(`${job}: uebersprungen — Nachtfenster war schon vorbei (${stamp(latest.finished_at)})${lastOk ? `, letzter Erfolg ${stamp(lastOk.finished_at)}` : ''}`);
      continue;
    }
    if (latest.result !== 'success') {
      const exit = latest.exit_status != null && latest.exit_status !== '' ? `, exit ${latest.exit_status}` : '';
      out.push(`${job}: letzter Lauf ${latest.result}${exit} (${stamp(latest.finished_at)})${lastOk ? `, letzter Erfolg ${stamp(lastOk.finished_at)}` : ''}`);
      continue;
    }
    if (now - Date.parse(lastOk.finished_at) > fristMs) out.push(`${job}: kein erfolgreicher Lauf in den letzten ${c.fristH}h (letzter Erfolg: ${stamp(lastOk.finished_at)})`);
  }
  return out;
}

// Eigene Meldungen der Skripte (kind 'alert', z. B. ads-periodic Fail-Open, refresh Sammelmeldung), die noch nicht nach Slack weitergeleitet wurden.
export function unsentAlerts(rows) {
  return rows
    .filter(r => r.kind === 'alert' && !r.sent_at && r.detail)
    .sort((a, b) => Date.parse(a.finished_at) - Date.parse(b.finished_at))
    .map(r => ({ id: r.id, text: r.detail }));
}
