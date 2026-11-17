// Vendor-Ads-Gesundheit fuer den Pipeline-Waechter (watchdog.mjs, Check 4d).
// vendor-ads.mjs laeuft taeglich und haelt das period_end des neuesten Monats in vra_ads auf "gestern". Ist das neueste
// period_end eines Kunden aelter als 3 Tage, ist der Import fuer ihn still stehengeblieben (abgelaufenes Token,
// dauerhaft fehlschlagender Bericht, uebersprungener Monat) — vendor-ads.mjs meldet das selbst nur im Log.
// Ein Kunde mit Ads-Profil, der aelter als 7 Tage ist und NIE eine Zeile bekommen hat, wird ebenfalls gemeldet
// ("noch keine Daten"): sonst bliebe ein dauerhaft kaputter neuer Kunde stumm. Juengere Kunden (Onboarding) und
// nicht lesbare/fehlende Werte (undefined = Lesefehler) werden NICHT gemeldet. Reine Funktion, kein Netzwerk.
export function vendorAdsStaleClients(clients, newestPeriodEnd, now = Date.now(), maxDays = 3, graceDays = 7) {
  const has = (id) => (newestPeriodEnd instanceof Map ? newestPeriodEnd.has(id) : Object.prototype.hasOwnProperty.call(newestPeriodEnd, id));
  const get = (id) => (newestPeriodEnd instanceof Map ? newestPeriodEnd.get(id) : newestPeriodEnd[id]);
  const today = Math.floor(now / 864e5); // Tage seit 1970 (UTC)
  const out = [];
  for (const c of clients) {
    if (!has(c.id)) continue; // nicht gelesen -> nicht raten
    const pe = get(c.id);
    if (pe == null) { // gelesen, aber keine Zeile
      const created = Date.parse(c.created_at || '');
      if (!Number.isNaN(created) && today - Math.floor(created / 864e5) > graceDays) out.push(`${c.name} (noch keine Daten)`);
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pe)) continue;
    const t = Date.parse(pe + 'T00:00:00Z');
    if (Number.isNaN(t)) continue;
    if (today - Math.floor(t / 864e5) > maxDays) out.push(c.name);
  }
  return out;
}
