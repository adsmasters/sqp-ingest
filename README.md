# sqp-ingest
Wöchentlicher Cloud-Import (GitHub Actions) für die SQPR-Plattform.
`refresh.mjs` zieht je Kunde aus `sqp_clients` die neuesten SQP-Daten
(aktueller + vorheriger Monat, letzte Wochen) und schreibt sie nach Supabase (`sqp_asin_rows`).
Läuft montags 03:00 UTC, zusätzlich manuell via "Run workflow".
Secrets (Repo → Settings → Secrets → Actions): SPAPI_CLIENT_ID, SPAPI_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY.
