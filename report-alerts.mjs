// Monatsbericht-Mails des Ads Dashboards für den Pipeline-Wächter (watchdog.mjs, Check 6).
// Das Dashboard schreibt Alarme (adsdash_report_alerts) und Lauf-Zeilen (adsdash_report_runs). Jeder UNGELÖSTE Alarm wird beim
// ersten Auftreten gemeldet (keine Schonfrist: eine falsche oder fehlende Kunden-Mail ist nie Routine); Alarme eines TEST-Laufs sind
// mit [TEST] gekennzeichnet. Außerdem: ein Lauf, der länger als 24 h auf "pending" steht. Reine Funktion, kein Netzwerk.
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const monthWord = period => (period ? `${MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}` : '');
const PENDING_MAX_H = 24;

export function reportAlertIssues(clients, alerts, runs, now = Date.now()) {
  const nameOf = new Map(clients.map(c => [c.id, c.name]));
  const issues = [];
  for (const a of alerts) {
    if (a.resolved_at) continue;
    const name = nameOf.get(a.client_id) ?? a.client_name ?? 'alle Kunden';
    const month = monthWord(a.period);
    issues.push(`${a.mode === 'test' ? '[TEST] ' : ''}Monatsbericht (${name})${month ? ` ${month}` : ''}: ${a.code}${a.message ? ` — ${String(a.message).slice(0, 160)}` : ''}`);
  }
  for (const r of runs) {
    if (r.status !== 'pending') continue;
    const ageH = Math.round((now - Date.parse(r.status_changed_at)) / 3600e3);
    if (ageH > PENDING_MAX_H) {
      issues.push(`${r.mode === 'test' ? '[TEST] ' : ''}Monatsbericht (${nameOf.get(r.client_id) ?? r.client_id}) ${monthWord(r.period)}: seit ${ageH}h "pending" — im Admin „Run now“ oder prüfen`);
    }
  }
  return issues;
}
