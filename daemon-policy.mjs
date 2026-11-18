// Richtlinie fuer den Hetzner-Daemon (backfill-worker.mjs).
// Der Daemon startet den Ads-Block (ads-refresh + ads-periodic) NICHT mehr von selbst: seit 18.11.2026 ist der naechtliche GitHub-Lauf
// (ads.yml, 19:30 UTC) der alleinige Besitzer. Zwei Laeufe zugleich (GitHub + Daemon alle 6 h, zu Zeiten, die niemand kontrolliert) haben die
// kleine Supabase-Datenbank (1 GB RAM, 26 GB Daten, davon ~21 GB Ads-Tabellen) in Spitzenzeiten ueberlastet. Ausnahmsweise wieder einschalten
// (z. B. zum Nachholen): Umgebungsvariable DAEMON_ADS=1 setzen. Reine Funktion, kein Netzwerk.
export function daemonAdsAllowed(env = process.env) {
  return String(env.DAEMON_ADS || '') === '1';
}
