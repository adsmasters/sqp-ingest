#!/usr/bin/env bash
# Fuehrt EINEN Job-Schritt auf dem Hetzner-Server aus:
#   deploy/server-job.sh <job-name> <timeout-minuten> <skript.mjs> [argumente...]
# - nimmt die gemeinsame Sperre /run/sqp-heavy.lock (schwere Schritte laufen nacheinander auf dem 1-CPU-Server),
# - Nachtfenster-Schutz (nur mit NIGHT_GUARD=1, so im Nachtlauf sqp-night): ein Schritt, der erst NACH dem Stichzeitpunkt
#   (NIGHT_CUTOFF, Standard 04:00 UTC, bis 17:00) beginnen wuerde, wird uebersprungen und als "skipped" (Code 99) gemeldet —
#   er wuerde sonst in die Arbeitszeit des Teams (ab ~07:00 UTC) hineinlaufen. Geprueft wird NACH dem Erhalt der Sperre.
# - erzwingt ein hartes Zeitlimit (timeout -> Exit 124),
# - schreibt das Log wie gewohnt ins Journal (stdout),
# - meldet danach EINE Zeile nach server_job_runs (report-job-run.mjs; ein Fehler dort aendert das Ergebnis nie),
# - gibt den Exit-Code des Jobs zurueck (uebersprungen: 0).
# Aufruf aus den systemd-Diensten (deploy/systemd/*.service); Umgebung kommt aus /opt/sqp-ingest/.env (EnvironmentFile).
set -u
JOB="$1"; MIN="$2"; shift 2
cd /opt/sqp-ingest || exit 1
exec 9>/run/sqp-heavy.lock
flock 9            # wartet, bis der vorige schwere Schritt fertig ist (der Lock bleibt bis zum Ende dieses Prozesses)
LOG="$(mktemp)"
NOW_HM="$(date -u +%H%M)"
if [ "${NIGHT_GUARD:-0}" = "1" ] && [ "$((10#$NOW_HM))" -ge "$((10#${NIGHT_CUTOFF:-0400}))" ] && [ "$((10#$NOW_HM))" -lt 1700 ]; then
  echo "NACHTFENSTER VORBEI: $JOB wird nicht mehr gestartet (jetzt $NOW_HM UTC, Stichzeit ${NIGHT_CUTOFF:-0400}) — uebersprungen."
  echo "$JOB uebersprungen: Nachtfenster vorbei ($NOW_HM UTC)" > "$LOG.tail"
  /usr/bin/node /opt/sqp-ingest/report-job-run.mjs "$JOB" 99 "$LOG.tail" || true
  rm -f "$LOG" "$LOG.tail"
  exit 0
fi
timeout --signal=TERM --kill-after=60 "${MIN}m" /usr/bin/node "$@" 2>&1 | tee "$LOG"
code=${PIPESTATUS[0]}
tail -n 15 "$LOG" > "$LOG.tail" 2>/dev/null
/usr/bin/node /opt/sqp-ingest/report-job-run.mjs "$JOB" "$code" "$LOG.tail" || true
rm -f "$LOG" "$LOG.tail"
exit "$code"
