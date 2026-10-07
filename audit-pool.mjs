// Hilfsfunktionen fuer audit-refresh.mjs (nur Logik, KEINE Netzwerkaufrufe -- siehe tests/audit-pool.test.mjs).

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Arbeitet `items` mit hoechstens `concurrency` gleichzeitigen Workern ab (Reihenfolge = Startreihenfolge der Queue).
// - Neue Konten werden nur gestartet, solange das Zeitbudget (ab Start des Pools) nicht verbraucht ist;
//   bereits laufende Konten duerfen fertig werden. Nicht gestartete Konten kommen in `skipped` (immer die LETZTEN der Queue).
// - Worker k wartet vor seinem ersten Konto k * staggerMs (verteilt die Report-Anlagen, Amazon drosselt Creates).
// - Ein fehlschlagender Worker-Aufruf stoppt die anderen nicht; er steht in results[i] = {ok:false,error}.
export async function runPool(items, { concurrency = 1, budgetMs = Infinity, staggerMs = 0, worker, now = Date.now, sleep = defaultSleep } = {}) {
  const n = Math.max(1, Math.floor(+concurrency) || 1);
  const t0 = now();
  const results = new Array(items.length);
  let next = 0, budgetHit = false;
  const lane = async (w) => {
    if (staggerMs > 0 && w > 0) await sleep(staggerMs * w);
    for (;;) {
      if (now() - t0 > budgetMs) { budgetHit = true; return; }
      const i = next++;
      if (i >= items.length) return;
      try { results[i] = { ok: true, value: await worker(items[i], i, w) }; }
      catch (error) { results[i] = { ok: false, error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, (_, w) => lane(w)));
  const started = Math.min(next, items.length);
  return { results, started, skipped: items.slice(started), budgetHit };
}

// Ein gemeinsames Amazon-Access-Token fuer alle Worker: wird erst nach maxAgeMs (20 Min; ein Token haelt ~60 Min, das Anlegen der Reports
// eines Kontos kann lange dauern) erneuert und parallele Aufrufer teilen sich EINEN Refresh. Schlaegt ein Refresh fehl, waehrend das alte
// Token noch gueltig ist (jünger als graceMs = 55 Min), wird das alte weiterverwendet (ein kurzer Netzfehler soll kein Konto kosten);
// ohne gueltiges altes Token wirft der Refresh. Ein fehlgeschlagener Refresh wird nie als neues Token gemerkt.
// Nach einem fehlgeschlagenen Refresh wird fuer retryFailedMs (60 s) nicht erneut gefragt (der Token-Endpunkt wird nicht bei jedem Aufruf bedraengt).
export function makeTokenManager({ fetchToken, now = Date.now, maxAgeMs = 20 * 60000, graceMs = 55 * 60000, retryFailedMs = 60000 }) {
  let tok = null, at = 0, inflight = null, failedAt = 0;
  return function ensureToken(force = false) {
    if (!force && tok && now() - at < maxAgeMs) return Promise.resolve(tok);
    if (!force && tok && failedAt && now() - failedAt < retryFailedMs && now() - at < graceMs) return Promise.resolve(tok);
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const t = await fetchToken();
        if (!t) throw new Error('Token-Refresh lieferte kein access_token');
        tok = t; at = now(); failedAt = 0;
        return t;
      } catch (e) {
        if (tok && now() - at < graceMs) { failedAt = now(); return tok; }
        throw e;
      } finally { inflight = null; }
    })();
    return inflight;
  };
}
