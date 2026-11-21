# Server-Jobs (Hetzner) — Installation und Umzug

Diese Dateien gehören zum Umzug der täglichen Jobs von GitHub Actions auf den Hetzner-Server (kein Slack-Secret dort; Meldungen laufen über die
Tabelle `server_job_runs`, der GitHub-Wächter leitet sie nach Slack weiter).

| Datei | Zweck |
|---|---|
| `sql/001_server_job_runs.sql` | Neue Tabelle für Meldungen (einmalig in Supabase ausführen, **vor** dem Push). |
| `server-job.sh` | Führt einen Schritt aus: Sperre, Nachtfenster-Schutz, hartes Zeitlimit, meldet eine Zeile. Wird über `/usr/bin/bash` gestartet (unabhängig vom Ausführungsrecht). |
| `systemd/sqp-night.service` + `.timer` | **Nachtlauf**: alle täglichen Jobs hintereinander, Start 18:00 UTC (19:00 CET, 23:30 IST). |
| `systemd/sqp-vendor.service`, `sqp-ads.service`, `sqp-daily-data.service` | Einzel-Dienste NUR für manuelle Läufe/Tests (kein Timer, Schutz aus). |
| `systemd/sqp-audit-terms.service` + `.timer` | Läuft schon (00:30 UTC); wird beim Umzug durch den Nachtlauf ersetzt (Timer abschalten). |

## Reihenfolge und Zeit
Nachtlauf (ein Lauf, keine Leerlaufzeiten): vendor/sales → vendor/ads → ads/refresh → ads/periodic → audit-terms → daily-data/audit → daily-data/sales-traffic.
Gemessene Höchstdauern auf GitHub: Vendor 52, Ads 238, audit-terms 73, Audit 155 + Sales & Traffic 16 Min = rund 9 h ab 18:00 UTC, also fertig ca. 03:00 UTC.
Schutz: ein Schritt, der erst **nach 04:00 UTC** beginnen würde, wird übersprungen und gemeldet (`skipped`), statt in die Arbeitszeit hineinzulaufen.
Speicher: die Ads-Schritte halten beim größten Konto Millionen Zeilen im RAM; `MemoryMax=1500M`, `NODE_OPTIONS=--max-old-space-size=1300`, `MemorySwapMax=0`,
`OOMPolicy=continue` (ein getöteter Schritt wird als `killed` gemeldet, die nächsten laufen weiter). Der erste manuelle Ads-Lauf ist der Messlauf (Spitzenwert: `journalctl -u sqp-ads | grep "memory peak"`).
Die eigenen Zeitbudgets der Ads-Skripte (`ADS_REFRESH_BUDGET_MIN=110`, `ADS_PERIODIC_BUDGET_MIN=150`) enden 40/30 Min VOR dem harten Limit (150/180), damit sie sauber enden statt getötet zu werden.

## Einrichten (genau in dieser Reihenfolge)
1. **Tabelle zuerst** anlegen (Supabase SQL-Editor, Datei `sql/001_server_job_runs.sql`). Läuft der Wächter vor der Tabelle, meldet er einmal "Server-Job-Meldungen nicht lesbar (HTTP 404)".
2. **Commit mit Ausführungsrecht** und Push: `git add --chmod=+x deploy/server-job.sh`; vor dem Push prüfen: `git ls-files -s deploy/server-job.sh` muss `100755` zeigen.
3. Der Daemon holt den Code per `git pull`. Prüfen: `git -C /opt/sqp-ingest log --oneline -1` und `ls -l /opt/sqp-ingest/deploy/server-job.sh` (`x` gesetzt?); sonst einmal `chmod +x`.
4. Auf dem Server prüfen: `command -v node` muss `/usr/bin/node` sein; `/opt/sqp-ingest/.env` darf KEINE der Variablen `AUDIT_*`, `TERMS_*`, `NIGHT_GUARD`, `NODE_OPTIONS`, `ADS_*_BUDGET_MIN` setzen (`EnvironmentFile=` würde die Werte der Dienste überschreiben).
5. **Selbsttest des Meldewegs** (harmlos, Wegwerf-Job `selftest`; die .env wird über systemd geladen — direkt in der Login-Shell fehlen die Datenbank-Variablen):
   `systemd-run --wait --collect --pipe -p EnvironmentFile=/opt/sqp-ingest/.env /opt/sqp-ingest/deploy/server-job.sh selftest 1 -e "console.log('ok')"`
   `systemd-run --wait --collect --pipe -p EnvironmentFile=/opt/sqp-ingest/.env /opt/sqp-ingest/deploy/server-job.sh selftest 1 -e "process.exit(3)"`
   Dann in Supabase: `select job,result,exit_status from server_job_runs order by id desc limit 3;` (erwartet: `selftest failed 3` und `selftest success 0`).
6. Erst jetzt Dienste kopieren: `cp /opt/sqp-ingest/deploy/systemd/sqp-*.service /opt/sqp-ingest/deploy/systemd/sqp-*.timer /etc/systemd/system/ && systemctl daemon-reload`
   (überschreibt die alte `sqp-audit-terms.service`; sie meldet danach nach `server_job_runs`).

## Umzug (an EINEM Abend, vor 18:00 UTC = 23:30 IST)
Der Nachtlauf ist ein einziger Lauf; ein Umzug Job für Job ist deshalb nicht möglich (nach dem Abschalten eines GitHub-Workflows hätte der Job sonst keinen Zeitplan, und der Wächter meldet nach 30 h "kein Lauf").
1. Manuell testen, nacheinander (nie zwei zugleich): `systemctl start sqp-vendor.service`, dann `sqp-ads.service` (Messlauf, 3-4 h), dann `sqp-daily-data.service`. Log: `journalctl -u sqp-vendor -f`. Ergebnis prüfen (Zeilen in `server_job_runs`, `Result=success`).
2. **Ein Commit**: alle sechs Schritte in `SERVER_JOBS` (server-job-alerts.mjs: `vendor/sales`, `vendor/ads`, `ads/refresh`, `ads/periodic`, `daily-data/audit`, `daily-data/sales-traffic`; `audit-terms` ist schon dort bzw. kommt dazu) eintragen UND `vendor.yml`, `ads.yml`, `daily-data.yml` aus `WF_FRIST` (watchdog.mjs) streichen (`tests/cutover-consistency.test.mjs` erzwingt das).
3. In den drei Workflows **nur den `schedule:`-Block entfernen** (NICHT "Disable workflow"): `workflow_dispatch` bleibt, denn der Vendor-Import-Knopf der Plattform (`vercel/output/src/api/spapi/vendor-import.js`) startet `vendor.yml` mit Einstellungen (Kunde/Monate), und `only_profile`/`only_spid` werden manuell für Diagnosen genutzt. Ein deaktivierter Workflow lässt sich nicht starten.
4. `systemctl disable --now sqp-audit-terms.timer`, dann `systemctl enable --now sqp-night.timer`; `systemctl list-timers sqp-night.timer` zeigt den nächsten Start.
5. Nächster Morgen: Wächter-Meldung und `select job,result,finished_at from server_job_runs order by id desc limit 12;` prüfen.
Rollback: `systemctl disable --now sqp-night.timer`, `schedule:`-Blöcke in den drei Workflows zurücksetzen, Jobs aus `SERVER_JOBS` streichen und wieder in `WF_FRIST` eintragen.
Der GitHub-Workflow `audit-terms.yml` ist seit dem 15.11.2026 deaktiviert (Actions-Oberfläche); nicht wieder einschalten, solange der Server ihn übernimmt.

## Nicht auf den Server (bewusst)
`watchdog`, `bid-rules`, `budget-watch`, `backfill` bleiben auf GitHub (der Wächter muss von außen beobachten; die beiden anderen ändern Gebote/Budgets).
