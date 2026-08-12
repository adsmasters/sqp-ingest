#!/usr/bin/env bash
# Dauer-Worker (Hetzner sqpr-worker): prüft die Import-Queue alle 30 Sekunden und arbeitet
# neue Jobs SOFORT ab — exakt dieselbe Logik wie die GitHub Actions (backfill-worker.mjs),
# nur ohne Zeitfenster/Timeouts. Aktualisiert sich selbst per git pull.
# Läuft als systemd-Dienst sqpr-worker.service; Logs: journalctl -u sqpr-worker
cd /opt/sqp-ingest

# Herzschlag im HINTERGRUND alle 2 Min — unabhängig davon, wie lange ein Import läuft.
# (Vorher schlug er nur zwischen den Läufen: ein mehrstündiger Lauf löste Fehlalarme aus.)
(
  while true; do
    curl -s -X POST "$SUPABASE_URL/rest/v1/worker_heartbeat?on_conflict=id" \
      -H "apikey: $SUPABASE_SERVICE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
      -H "Content-Type: application/json" -H "Prefer: resolution=merge-duplicates,return=minimal" \
      -d "{\"id\":1,\"host\":\"$(hostname)\",\"ts\":\"$(date -u +%FT%TZ)\"}" >/dev/null 2>&1 || true
    sleep 120
  done
) &
HB=$!
trap 'kill $HB 2>/dev/null' EXIT

while true; do
  git pull -q --ff-only 2>/dev/null || true
  # Budget quasi unbegrenzt: Jobs laufen am Stück durch statt in Nacht-Scheiben
  # 60-Min-Zyklen: lange genug für echte Arbeit, kurz genug, dass NEUE Jobs
  # (die während eines Laufs eingereiht werden) spätestens nach einer Stunde dran sind
  # Ads/Meta nur alle 6h statt jeden Zyklus — sie fraßen sonst ~25+ Min von 60 (14 Kunden),
  # während SQP-Reparatur-Jobs warteten. Nachts läuft zusätzlich die GitHub Action.
  WORKER_BUDGET_MIN=60 SIDE_MIN_GAP_H=6 node backfill-worker.mjs
  sleep 30
done
