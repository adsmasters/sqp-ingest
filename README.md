# sqp-ingest
Wöchentlicher Cloud-Import (GitHub Actions) für die SQPR-Plattform.
`refresh.mjs` zieht je Kunde aus `sqp_clients` die neuesten SQP-Daten
(aktueller + vorheriger Monat, letzte Wochen) und schreibt sie nach Supabase (`sqp_asin_rows`).
Läuft montags 03:00 UTC, zusätzlich manuell via "Run workflow".
Secrets (Repo → Settings → Secrets → Actions): SPAPI_CLIENT_ID, SPAPI_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY.

## Vendor-Sales-Import (`vendor-sales.mjs`)
Täglicher Import (04:30 UTC) für das Vendor-Reporting-Tool: zieht je Kunde aus
`vra_clients` (Spalte `spid` = autorisiertes Vendor-Konto) den
GET_VENDOR_SALES_REPORT und schreibt Monats-Reports nach `vra_reports`/`vra_data`.
Fehlende komplette Monate (MONTH) + laufender Monat (DAY, aggregiert, wird ersetzt).
Manuell: Actions → "Vendor Sales Import" → Run workflow (optional client/months).
