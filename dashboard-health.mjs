// Ads-Dashboard-Gesundheit für den Pipeline-Wächter (watchdog.mjs, Check 5).
// Das Ads Dashboard (eigenes Projekt, Backend ppc-callback) prüft täglich um 07:30 UTC selbst seine Daten
// (fehlende Tage, veraltete Daten, hängende Syncs) und legt je Kunde ein Ergebnis in adsdash_health_check ab
// (status ok | warn | alert). Der Wächter meldet nur ALARME dieser Prüfung — Warnungen (z. B. Amazon-Rate-Limits)
// sind Routine — und den Fall, dass die Prüfung selbst nicht mehr läuft. Ein Alarm wird erst gemeldet, wenn er in zwei
// aufeinanderfolgenden Tagesprüfungen auftrat (Schonfrist: bis dahin hatte der Sync >= 4 Läufe, ihn zu heilen).
// Reine Funktion, kein Netzwerk.
const MAX_CHECK_AGE_H = 30; // Prüfung läuft 1x täglich

export function dashboardHealthIssues(clients, checks, now = Date.now()) {
  // Die zwei neuesten Ergebnisse je Kunde (neuestes zuerst)
  const byClient = new Map();
  for (const c of checks) {
    if (!byClient.has(c.client_id)) byClient.set(c.client_id, []);
    byClient.get(c.client_id).push(c);
  }
  const latest = new Map();
  const previous = new Map();
  for (const [id, list] of byClient) {
    list.sort((a, b) => Date.parse(b.checked_at) - Date.parse(a.checked_at));
    latest.set(id, list[0]);
    if (list[1]) previous.set(id, list[1]);
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
    // Nur melden, wenn schon die Prüfung davor (24h früher) Alarm hatte: ein einmaliger Alarm heilt meist beim
    // nächsten Sync von selbst (der Sync zieht die letzten 21 Tage neu) — Slack soll nicht grundlos pingen.
    if (row.status === 'alert' && previous.get(client.id)?.status === 'alert') {
      const msgs = (row.issues || []).filter(i => i.severity === 'alert').map(i => i.message);
      issues.push(`Ads-Dashboard (${client.name}): ${msgs.join('; ') || 'Alarm der Datenprüfung'}`);
    }
  }
  return issues;
}
