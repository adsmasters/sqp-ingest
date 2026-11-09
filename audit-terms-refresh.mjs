// PPC-Audit: nur die SP-SUCHBEGRIFFE vorladen (1 Report je Konto statt ~10) und in das gespeicherte Audit schreiben.
// Zweck: Das gespeicherte Audit enthaelt je Suchbegriff-Zeile Kampagnen-/Anzeigengruppen-/Keyword-IDs (siehe audit-refresh.mjs). Damit gehen
// "Nur aktiver Wasted Spend" (voller Status) und "Ausgewaehlte negieren" aus GESPEICHERTEN Daten, ohne dass das Team auf ein neues Audit warten muss.
// Ein Konto braucht hier nur EINEN Report (statt ~10) -> alle Konten schaffen es pro Nacht.
//
// Was dieses Skript schreibt: NUR payload.spTerms (+ spTermsAsOf, spTermsWindow) der gespeicherten Zeile in ads_audit_cache. Alles andere im gespeicherten
// Audit bleibt unveraendert, und updated_at wird NICHT angefasst (der Rest des Audits ist nicht frischer geworden -> der "Stand"-Hinweis bleibt ehrlich).
// Geschrieben wird per PATCH nur, wenn sich die Zeile seit dem Lesen nicht geaendert hat (updated_at=eq.<gelesener Wert>) -> kein Ueberschreiben eines
// parallel laufenden vollen Audits. Es wird NIE eine Zeile angelegt (kein gespeichertes Audit = nichts zu tun).
// Dieses Skript legt/aendert KEINE Kampagnen, Gebote, Budgets oder Negatives: nur Report anfordern/lesen + Supabase-Cache.
//
// ENV: ADS_CLIENT_ID/SECRET/REFRESH_TOKEN, SUPABASE_URL/SERVICE_KEY
// optional: TERMS_CONCURRENCY (6), TERMS_BUDGET_MIN (90), TERMS_ACCOUNT_MAX_MIN (30), TERMS_STAGGER_SEC (20), TERMS_SKIP_HOURS (20),
//           ONLY_PROFILE (nur dieses Ads-Profil), TERMS_DRY_RUN=1 (Report anfordern, aber nichts schreiben)
import zlib from 'node:zlib';
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { runPool, makeTokenManager } from './audit-pool.mjs';

const U = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const CID = process.env.ADS_CLIENT_ID, SEC = process.env.ADS_CLIENT_SECRET, RT = process.env.ADS_REFRESH_TOKEN;
if (!U || !KEY || !CID || !SEC || !RT) { console.error('FEHLER: ENV fehlt.'); process.exit(1); }
const ADS = 'https://advertising-api-eu.amazon.com';
const sbHead = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DAYS = +(process.argv[2] || 30);
const DRY_RUN = process.env.TERMS_DRY_RUN === '1';
const ONLY = (process.env.ONLY_PROFILE || '').trim();
const als = new AsyncLocalStorage(); const _log = console.log.bind(console);
console.log = (...a) => { const w = als.getStore(); _log(...(w ? [`[${w}]`, ...a] : a)); };

// IDENTISCH zur Definition in audit-refresh.mjs (sp_search_terms) — ein Test vergleicht die Spaltenliste
const DEFS = {
  sp_search_terms: { adProduct: 'SPONSORED_PRODUCTS', reportTypeId: 'spSearchTerm', groupBy: ['searchTerm'], columns: ['searchTerm', 'keyword', 'matchType', 'campaignName', 'campaignId', 'adGroupId', 'keywordId', 'impressions', 'clicks', 'cost', 'purchases7d', 'sales7d'] },
};
const dayAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

let AT = null;
const ensureToken = makeTokenManager({
  fetchToken: async () => {
    const t = await rfetch('https://api.amazon.co.uk/auth/o2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: RT, client_id: CID, client_secret: SEC }) });
    return (await t.json()).access_token;
  },
});
async function token(force) { AT = await ensureToken(force); }
const hdr = (profileId, ct) => ({ 'Amazon-Advertising-API-ClientId': CID, 'Amazon-Advertising-API-Scope': String(profileId), Authorization: 'Bearer ' + AT, ...(ct ? { 'Content-Type': ct } : {}) });
// fetch mit Retry gegen transiente Netzfehler + hartes 90-s-Timeout je Request (wie audit-refresh.mjs)
async function rfetch(url, opts = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { return await fetch(url, { ...opts, signal: AbortSignal.timeout(90000) }); }
    catch (e) { if (i === tries - 1) throw e; await sleep(8000 * (i + 1)); }
  }
}

// EIN Report (SP-Suchbegriffe, SUMMARY, gleicher Zeitraum wie das volle Audit: DAYS+1 Tage bis gestern). Wirft bei Misserfolg.
async function createReport(profileId, deadline) {
  const end = dayAgo(1), start = dayAgo(DAYS + 1);
  const def = DEFS.sp_search_terms;
  for (let a = 0; a < 8; a++) {
    await token();
    const r = await rfetch(`${ADS}/reporting/reports`, { method: 'POST', headers: hdr(profileId, 'application/vnd.createasyncreportrequest.v3+json'), body: JSON.stringify({ name: 'audit-terms sp_search_terms', startDate: start, endDate: end, configuration: { ...def, timeUnit: 'SUMMARY', format: 'GZIP_JSON' } }) });
    if (r.status === 429) { if (Date.now() > deadline) break; await sleep(20000); continue; } // Amazon drosselt das Anlegen
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.reportId) return { id: j.reportId, start, end };
    if (r.status === 425) { // Duplikat: Amazon nennt die vorhandene Report-ID (z. B. vom vollen Audit), die nehmen wir
      const m = JSON.stringify(j).match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
      if (m) { console.log('  bereits vorhandenen Report wiederverwendet (425)'); return { id: m[0], start, end }; }
    }
    throw new Error(`Report nicht angelegt: HTTP ${r.status} ${JSON.stringify(j).slice(0, 120)}`);
  }
  throw new Error('Report nicht angelegt: Drosselung (429) bzw. Zeitlimit');
}
async function waitAndDownload(profileId, id, deadline) {
  for (let i = 0; i < 1000; i++) {
    if (Date.now() > deadline) throw new Error('Zeitlimit je Konto erreicht — Warten auf Amazon abgebrochen');
    await token();
    let r, j;
    try { r = await rfetch(`${ADS}/reporting/reports/${id}`, { headers: hdr(profileId) }); j = (r.ok && await r.json().catch(() => null)) || {}; }
    catch (e) { await sleep(1000); continue; } // Netzfehler: der Report gilt als "noch offen", naechste Runde erneut
    if (j.status === 'COMPLETED' && j.url) {
      const rows = JSON.parse(zlib.gunzipSync(Buffer.from(await (await rfetch(j.url)).arrayBuffer())).toString());
      if (!Array.isArray(rows)) throw new Error('Download unlesbar (kein Array)');
      return rows;
    }
    if (j.status === 'FAILURE') throw new Error(`Report fehlgeschlagen${j.failureReason ? ` (${String(j.failureReason).slice(0, 100)})` : ''}`);
    await sleep(20000);
  }
  throw new Error('Report nicht fertig geworden');
}

// Zeilenformat IDENTISCH zu audit-fetch.js / audit-refresh.mjs (pack + SP_TERM_EXTRA): 8 Standardzellen + campaignId, adGroupId, keywordId, keyword
const r2 = x => +(+x || 0).toFixed(2);
const SP_TERM_EXTRA = [['campaignId', 'campaignId'], ['adGroupId', 'adGroupId'], ['keywordId', 'keywordId'], ['keyword', 'keyword']];
function packTerms(rows, cap = 8000) {
  return {
    cols: ['term', 'campaign', 'match', 'impressions', 'clicks', 'spend', 'sales', 'orders', ...SP_TERM_EXTRA.map(e => e[0])],
    rows: rows.filter(r => (+r.clicks || 0) > 0).sort((a, b) => (+b.sales7d || 0) - (+a.sales7d || 0) || (+b.cost || 0) - (+a.cost || 0)).slice(0, cap)
      .map(r => [r.searchTerm, r.campaignName || '', r.matchType || r.keywordType || '', +r.impressions || 0, +r.clicks || 0, r2(r.cost), r2(r.sales7d), +r.purchases7d || 0, ...SP_TERM_EXTRA.map(e => (r[e[1]] == null ? '' : String(r[e[1]])))]),
  };
}

const ts = v => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : 0; };

async function main() {
  await token();
  const cr = await fetch(`${U}/rest/v1/sqp_clients?active=eq.true&ads_profile_id=not.is.null&select=name,spid,ads_profile_id`, { headers: sbHead });
  const clients = cr.ok ? await cr.json() : [];
  const nameOf = new Map(clients.map(c => [String(c.ads_profile_id), c]));
  // Gespeicherte Audits (days=DAYS) mit Alter, Stand der Suchbegriffe und Spaltenliste von spTerms (hat sie IDs?).
  // Die reiche Abfrage (JSON-Pfade) ist ein Komfort: schlaegt sie fehl, wird auf die einfache zurueckgefallen und im Zweifel ALLES verarbeitet.
  let rows = null, rich = true;
  const rr = await rfetch(`${U}/rest/v1/ads_audit_cache?days=eq.${DAYS}&select=profile_id,updated_at,asof:payload->>spTermsAsOf,cols:payload->spTerms->cols`, { headers: sbHead });
  if (rr.ok) rows = await rr.json();
  else {
    rich = false;
    console.log(`Hinweis: reiche Cache-Abfrage nicht moeglich (HTTP ${rr.status}) — es werden alle Konten verarbeitet.`);
    const r2q = await rfetch(`${U}/rest/v1/ads_audit_cache?days=eq.${DAYS}&select=profile_id,updated_at`, { headers: sbHead });
    if (r2q.ok) rows = await r2q.json();
  }
  if (!Array.isArray(rows)) { console.log('FEHLER: gespeicherte Audits nicht lesbar (Supabase).'); process.exitCode = 1; return; }
  const SKIP_H = +(process.env.TERMS_SKIP_HOURS || 20);
  const recent = Date.now() - 14 * 864e5;
  const skippedFresh = [], queue = [];
  for (const row of rows) {
    const pid = String(row.profile_id);
    if (ONLY && pid !== ONLY) continue;
    // nur aktive Kunden und zuletzt (14 Tage) genutzte Konten — keine Altlasten
    if (!nameOf.has(pid) && ts(row.updated_at) < recent) continue;
    const last = Math.max(ts(row.updated_at), ts(row.asof));
    const hasIds = rich && Array.isArray(row.cols) && row.cols.includes('adGroupId');
    const cl = nameOf.get(pid);
    const item = { pid, last, name: cl ? cl.name : `Profil ${pid} (zuletzt auditiert)`, spid: cl ? cl.spid : null };
    // ONLY_PROFILE = manueller Testlauf fuer genau dieses Konto: nie "schon aktuell" ueberspringen (sonst tut ein zweiter Test innerhalb von 20 h nichts)
    if (!ONLY && hasIds && Date.now() - last < SKIP_H * 3600e3) skippedFresh.push(item); else queue.push(item);
  }
  queue.sort((a, b) => a.last - b.last); // abgestandenster Stand zuerst
  const BUDGET_MIN = +(process.env.TERMS_BUDGET_MIN || 90);
  const ACC_MIN = +(process.env.TERMS_ACCOUNT_MAX_MIN || 30);
  const CONC = Math.max(1, +(process.env.TERMS_CONCURRENCY || 6) || 6);
  const STAGGER_S = Math.max(0, +(process.env.TERMS_STAGGER_SEC || 20) || 0);
  console.log(`Audit-Suchbegriffe: ${queue.length} Konto/Konten zu aktualisieren (${skippedFresh.length} schon aktuell mit IDs), ${DAYS} Tage, Budget ${BUDGET_MIN} Min, ${CONC} parallel${DRY_RUN ? ', TROCKENLAUF (nichts wird geschrieben)' : ''}`);
  if (!queue.length) { console.log('Alle Konten sind aktuell — nichts zu tun.'); console.log('\nFERTIG.'); return; }

  // Wird beim ersten Schreiben festgestellt, dass sich updated_at DURCH das Schreiben aendert (DB-Trigger o. ae.), werden ALLE weiteren Konten nicht mehr
  // geschrieben und der Lauf schlaegt fehl: sonst wuerde der "Stand"-Hinweis jeden Nacht fuer jedes Konto "frisch" lügen und die Reihenfolge des vollen Audits stoeren.
  let BUMPED = false;
  const BUMP_MSG = 'updated_at hat sich durch das Schreiben veraendert (DB-Trigger?) — es wird nichts weiter geschrieben';
  const refreshOne = async (cl) => {
    console.log(`=== ${cl.name} (${cl.spid}) ===`);
    if (BUMPED) { console.log('  abgebrochen: ' + BUMP_MSG); return { status: 'error', detail: 'abgebrochen: ' + BUMP_MSG }; }
    try {
      const deadline = Date.now() + ACC_MIN * 60000;
      const rep = await createReport(cl.pid, deadline);
      const data = await waitAndDownload(cl.pid, rep.id, deadline);
      const spTerms = packTerms(data);
      // Frisch lesen und sofort bedingt schreiben: kein Ueberschreiben, falls das volle Audit / eine Platzierungsaenderung dazwischen schrieb
      const gr = await rfetch(`${U}/rest/v1/ads_audit_cache?profile_id=eq.${cl.pid}&days=eq.${DAYS}&select=payload,updated_at`, { headers: sbHead });
      if (!gr.ok) return { status: 'error', detail: `Cache lesen: HTTP ${gr.status}` };
      const cur = await gr.json();
      if (!cur.length || !cur[0].payload || typeof cur[0].payload !== 'object') { console.log('  kein gespeichertes Audit mehr — uebersprungen'); return { status: 'skipped', detail: 'kein gespeichertes Audit' }; }
      const payload = cur[0].payload, readAt = cur[0].updated_at;
      payload.spTerms = spTerms; payload.spTermsAsOf = new Date().toISOString(); payload.spTermsWindow = { start: rep.start, end: rep.end };
      // Groessen-Wache wie audit-fetch.js / audit-refresh.mjs: Zeilen der grossen Listen halbieren, wenn der Cache-Eintrag > 3,5 MB wuerde
      for (let g = 0; g < 4 && JSON.stringify(payload).length > 3500000; g++) {
        for (const k of ['spTerms', 'spTargets', 'sbTerms']) if (payload[k] && Array.isArray(payload[k].rows) && payload[k].rows.length > 1) payload[k].rows = payload[k].rows.slice(0, Math.ceil(payload[k].rows.length / 2));
        payload.truncated = true;
      }
      if (DRY_RUN) { console.log(`  TROCKENLAUF: ${spTerms.rows.length} Suchbegriff-Zeilen, nichts geschrieben`); return { status: 'ok', detail: 'Trockenlauf' }; }
      if (BUMPED) { console.log('  abgebrochen: ' + BUMP_MSG); return { status: 'error', detail: 'abgebrochen: ' + BUMP_MSG }; } // ein anderes Konto hat es waehrenddessen festgestellt
      const up = await rfetch(`${U}/rest/v1/ads_audit_cache?profile_id=eq.${cl.pid}&days=eq.${DAYS}&updated_at=eq.${encodeURIComponent(readAt)}&select=profile_id,updated_at`, { method: 'PATCH', headers: { ...sbHead, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ payload }) });
      if (!up.ok) return { status: 'cache-error', detail: `HTTP ${up.status}` };
      const done = await up.json().catch(() => []);
      if (!Array.isArray(done) || !done.length) { console.log('  Zeile wurde zwischenzeitlich geändert — nichts überschrieben, übersprungen'); return { status: 'changed', detail: 'Zeile zwischenzeitlich geändert' }; }
      // Kontrolle: das Schreiben darf updated_at nicht veraendert haben (sonst Trigger -> siehe BUMPED). Fehlt der Wert in der Antwort, wird nichts behauptet.
      if (done[0].updated_at != null && ts(done[0].updated_at) !== ts(readAt)) {
        BUMPED = true;
        console.log(`  WARNUNG: updated_at hat sich durch das Schreiben geändert (${readAt} -> ${done[0].updated_at}). Vermutlich ein DB-Trigger auf ads_audit_cache: der "Stand"-Hinweis im PPC-Audit wuerde "frisch" zeigen. Weitere Konten werden NICHT geschrieben.`);
        return { status: 'error', detail: 'updated_at durch das Schreiben veraendert (DB-Trigger?)' };
      }
      console.log(`  Cache aktualisiert: ${spTerms.rows.length} Suchbegriff-Zeilen mit IDs`);
      return { status: 'ok', detail: '' };
    } catch (e) { console.log('  FEHLER:', e.message); return { status: 'error', detail: e.message }; }
  };

  const res = await runPool(queue, {
    concurrency: CONC, budgetMs: BUDGET_MIN * 60000, staggerMs: STAGGER_S * 1000,
    worker: (cl, i, w) => als.run(`W${w + 1}`, async () => {
      const t1 = Date.now(); const r = await refreshOne(cl);
      console.log(`  -> ${r.status} nach ${((Date.now() - t1) / 60000).toFixed(1)} Min`);
      return r;
    }),
  });
  const okN = [], skipN = [], changedN = [], bad = [];
  res.results.forEach((r, i) => {
    if (!r) return;
    const st = r.ok ? r.value : { status: 'error', detail: r.error && r.error.message };
    const line = `${queue[i].name}: ${st.status}${st.detail ? ' (' + st.detail + ')' : ''}`;
    (st.status === 'ok' ? okN : st.status === 'skipped' ? skipN : st.status === 'changed' ? changedN : bad).push(line);
  });
  const lines = [
    `Audit-Suchbegriffe: ${okN.length} aktualisiert, ${bad.length} NICHT aktualisiert (Fehler), ${skipN.length} übersprungen (Zeile fehlt), ${changedN.length} übersprungen (Zeile zwischenzeitlich geändert), ${res.skipped.length} nicht gestartet (Zeitbudget ${BUDGET_MIN} Min) von ${queue.length} Konten.`,
    ...bad.map(b => `  ✗ ${b}`),
    ...skipN.map(b => `  – ${b}`),
    ...changedN.map(b => `  – ${b}`),
    ...(res.skipped.length ? [`  Zeitbudget erreicht — nicht gestartet (nächste Nacht zuerst): ${res.skipped.map(c => c.name).slice(0, 40).join(', ')}${res.skipped.length > 40 ? ' …' : ''}`] : []),
  ];
  console.log('\n' + lines.join('\n'));
  try { if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### PPC-Audit Suchbegriffe (IDs)\n\n' + lines.map(l => l.replace(/^ {2}/, '- ')).join('\n') + '\n'); } catch (e) { /* Zusammenfassung ist optional */ }
  // Fehlgeschlagen (-> Slack-Alarm des Workflows), wenn kein gestartetes Konto aktualisiert/uebersprungen wurde oder mehr als die Haelfte Fehler hatten
  if (res.started > 0 && (okN.length + skipN.length + changedN.length === 0 || bad.length / res.started > 0.5)) {
    process.exitCode = 1;
    console.log(`\nFEHLER: ${bad.length} von ${res.started} gestarteten Konten wurden nicht aktualisiert — Lauf wird als fehlgeschlagen markiert.`);
  }
  // "Zeile zwischenzeitlich geändert" ist im Normalfall selten. Meldet (fast) jedes Konto das, greift die Bedingung updated_at=eq.<gelesen> vermutlich nie
  // (Format/Praezision) -> es wuerden jede Nacht keine IDs gespeichert, ohne dass jemand es merkt. Deshalb als Fehler melden (Slack-Alarm).
  if (res.started > 0 && changedN.length >= 3 && changedN.length / res.started > 0.5) {
    process.exitCode = 1;
    console.log(`\nFEHLER: bei ${changedN.length} von ${res.started} gestarteten Konten war die Zeile "zwischenzeitlich geändert" — ungewöhnlich viele. Greift die Bedingung updated_at=eq.<gelesener Wert> nicht? Es wurden keine IDs gespeichert.`);
  }
  if (BUMPED) { process.exitCode = 1; console.log('\nFEHLER: ' + BUMP_MSG + '.'); }
  console.log('\nFERTIG.');
}
main().catch(e => { console.error('FEHLER', e.message); process.exit(1); });
