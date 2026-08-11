#!/usr/bin/env bash
# Dauer-Worker (Hetzner sqpr-worker): prüft die Import-Queue alle 30 Sekunden und arbeitet
# neue Jobs SOFORT ab — exakt dieselbe Logik wie die GitHub Actions (backfill-worker.mjs),
# nur ohne Zeitfenster/Timeouts. Aktualisiert sich selbst per git pull.
# Läuft als systemd-Dienst sqpr-worker.service; Logs: journalctl -u sqpr-worker
cd /opt/sqp-ingest
while true; do
  git pull -q --ff-only 2>/dev/null || true
  # Herzschlag für den Pipeline-Wächter (Alarm, wenn er >20 Min ausbleibt)
  curl -s -X POST "$SUPABASE_URL/rest/v1/worker_heartbeat?on_conflict=id" \
    -H "apikey: $SUPABASE_SERVICE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
    -H "Content-Type: application/json" -H "Prefer: resolution=merge-duplicates,return=minimal" \
    -d "{\"id\":1,\"host\":\"$(hostname)\",\"ts\":\"$(date -u +%FT%TZ)\"}" >/dev/null 2>&1 || true
  # Budget quasi unbegrenzt: Jobs laufen am Stück durch statt in Nacht-Scheiben
  WORKER_BUDGET_MIN=100000 node backfill-worker.mjs
  sleep 30
done
