// Ads-Dashboard-Gesundheit für den Pipeline-Wächter (watchdog.mjs, Check 5).
// Das Ads Dashboard (eigenes Projekt, Backend ppc-callback) prüft täglich um 07:30 UTC selbst seine Daten
// (fehlende Tage, veraltete Daten, hängende Syncs) und legt je Kunde ein Ergebnis in adsdash_health_check ab
// (status ok | warn | alert). Der Wächter meldet nur ALARME dieser Prüfung — Warnungen (z. B. Amazon-Rate-Limits)
// sind Routine — und den Fall, dass die Prüfung selbst nicht mehr läuft. Reine Funktion, kein Netzwerk.
const MAX_CHECK_AGE_H = 30; // Prüfung läuft 1x täglich

export function dashboardHealthIssues(clients, checks, now = Date.now()) {
  // Neuestes Ergebnis je Kunde
  const latest = new Map();
  for (const c of checks) {
    const prev = latest.get(c.client_id);
    if (!prev || Date.parse(c.checked_at) > Date.parse(prev.checked_at)) latest.set(c.client_id, c);
  }
  const issues = [];
  for (const client of clients) {
    if (!client.active) continue;
    const row = latest.get(client.id);
    if (!row) continue; // noch nie geprüft (neuer Kunde / Prüfung gerade erst eingerichtet)
    const ageH = Math.round((now - Date.parse(row.checked_at)) / 3600e3);
    if (ageH > MAX_CHECK_AGE_H) {
      issues.push(`Ads-Dashboard (${client.name}): Datenprüfung seit ${ageH}h nicht gelaufen — Cron /api/cron/health prüfen`);
      continue;
    }
    if (row.status === 'alert') {
      const msgs = (row.issues || []).filter(i => i.severity === 'alert').map(i => i.message);
      issues.push(`Ads-Dashboard (${client.name}): ${msgs.join('; ') || 'Alarm der Datenprüfung'}`);
    }
  }
  return issues;
}
