# sqp-ingest
Wöchentlicher Cloud-Import (GitHub Actions) für die SQPR-Plattform.
`refresh.mjs` zieht je Kunde aus `sqp_clients` die neuesten SQP-Daten
(aktueller + vorheriger Monat, letzte Wochen) und schreibt sie nach Supabase (`sqp_asin_rows`).
Läuft montags 03:00 UTC, zusätzlich manuell via "Run workflow".
Ausfallschutz (28.10.2026): stehen bei einem Kunden `SQP_BREAKER` (6) Reports in Folge im Timeout, wird er abgebrochen; nach
`SQP_BUDGET_MIN` (270 Min) werden keine neuen Kunden mehr gestartet, ab `SQP_HARD_MIN` (285 Min) keine neuen Reports mehr (Job-Limit 345 Min;
im selben Job folgt `asin-meta.mjs` mit eigenem 35-Min-Limit; spätestens bei `SQP_EXIT_MIN` (300 Min) beendet sich der Refresh selbst mit Slack-Meldung). Stehen die letzten 3 Kunden komplett still, wird der Lauf als Amazon-Ausfall früh
beendet. Abgebrochene, übersprungene und nicht gestartete Kunden stehen in der Slack-Sammelmeldung; der Job bleibt grün. Die Kunden laufen
„ältester Datenstand zuerst“ (Fallback: wöchentliche Rotation), damit ein knappes Budget nicht jede Woche dieselben trifft.
Secrets (Repo → Settings → Secrets → Actions): SPAPI_CLIENT_ID, SPAPI_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY.

## Vendor-Sales-Import (`vendor-sales.mjs`)
Täglicher Import (04:30 UTC) für das Vendor-Reporting-Tool: zieht je Kunde aus
`vra_clients` (Spalte `spid` = autorisiertes Vendor-Konto) den
GET_VENDOR_SALES_REPORT und schreibt Monats-Reports nach `vra_reports`/`vra_data`.
Fehlende komplette Monate (MONTH) + laufender Monat (DAY, aggregiert, wird ersetzt).
Manuell: Actions → "Vendor Sales Import" → Run workflow (optional client/months).
