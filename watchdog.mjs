// Unabhängiger Pipeline-Wächter: prüft Queue-Gesundheit, Workflow-Erfolge und Datenfrische
// und meldet Probleme nach Slack. Läuft in Minuten — kann selbst nie ins Timeout laufen.
// Lehre aus 08/2026: der Alarm-Step IM Backfill-Workflow starb mit dessen Timeout,
// die Pipeline war eine Woche verstopft und niemand hat es gemerkt.
// ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY, SLACK_WEBHOOK_URL, GITHUB_TOKEN, GITHUB_REPOSITORY
const U = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const SLACK = process.env.SLACK_WEBHOOK_URL, GH = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY || 'adsmasters/sqp-ingest';
if (!U || !KEY) { console.error('FEHLER: SUPABASE-ENV fehlt.'); process.exit(1); }
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const hours = ms => Math.round(ms / 3600e3);
const issues = [];

// 1) Job-Queue: hängende und verhungernde Jobs (paused = absichtlich, zählt nicht)
try {
  const jr = await fetch(`${U}/rest/v1/sqp_backfill_jobs?status=in.(queued,running)&select=id,spid,status,note,requested_at,started_at`, { headers: H });
  const jobs = jr.ok ? await jr.json() : [];
  const cr = await fetch(`${U}/rest/v1/sqp_clients?select=spid,name`, { headers: H });
  const names = new Map((cr.ok ? await cr.json() : []).map(c => [c.spid, c.name]));
  const now = Date.now();
  for (const j of jobs) {
    const name = names.get(j.spid) || j.spid;
    const sinceStart = j.started_at ? now - Date.parse(j.started_at) : null;
    if (j.status === 'running' && sinceStart > 12 * 3600e3)
      issues.push(`Job ${j.id} (${name}) hängt seit ${hours(sinceStart)}h auf »running« — Lauf vermutlich abgebrochen`);
    if (j.status === 'queued') {
      const sinceTouch = sinceStart ?? (now - Date.parse(j.requested_at));
      if (sinceTouch > 30 * 3600e3)
        issues.push(`Job ${j.id} (${name}) seit ${hours(sinceTouch)}h nicht angefasst — Import kommt nicht voran`);
    }
  }
} catch (e) { issues.push(`Watchdog: Job-Queue nicht prüfbar (${e.message})`); }

// 2) Geplante Workflows: gab es innerhalb der Frist einen erfolgreichen Lauf?
//    (vorher nur backfill+daily-data — ads/vendor/refresh/bid-rules konnten wochenlang
//    still sterben, weil deren Skripte Fehler schlucken; Deep-Dive 12.08.)
const WF_FRIST = { 'backfill.yml': 30, 'daily-data.yml': 30, 'ads.yml': 30, 'vendor.yml': 30, 'bid-rules.yml': 30, 'refresh.yml': 8 * 24 };
for (const [wf, fristH] of Object.entries(WF_FRIST)) {
  try {
    const gh = (url) => fetch(url, { headers: { Authorization: 'Bearer ' + GH, Accept: 'application/vnd.github+json' } });
    const ok = await (await gh(`https://api.github.com/repos/${REPO}/actions/workflows/${wf}/runs?status=success&per_page=1`)).json();
    const last = ok.workflow_runs && ok.workflow_runs[0];
    if (last && Date.now() - Date.parse(last.updated_at) <= fristH * 3600e3) continue;
    // kein frischer Erfolg: nur melden, wenn nicht gerade ein Lauf unterwegs ist (frisch eingerichteter Workflow)
    const any = await (await gh(`https://api.github.com/repos/${REPO}/actions/workflows/${wf}/runs?per_page=1`)).json();
    const newest = any.workflow_runs && any.workflow_runs[0];
    if (newest && ['in_progress', 'queued'].includes(newest.status)) continue;
    issues.push(`${wf}: kein erfolgreicher Lauf in den letzten ${fristH}h${last ? ` (letzter Erfolg: ${last.updated_at.slice(0, 16)}Z)` : ''}`);
  } catch (e) { issues.push(`Watchdog: ${wf}-Läufe nicht prüfbar (${e.message})`); }
}

// 3) Dauer-Worker-Herzschlag (Hetzner sqpr-worker) — meldet sich der Daemon >20 Min nicht,
//    ist Server oder Dienst down. Kein Alarm, solange es (noch) keinen Herzschlag gibt.
try {
  const r = await fetch(`${U}/rest/v1/worker_heartbeat?id=eq.1&select=ts,host`, { headers: H });
  const rows = r.ok ? await r.json() : [];
  if (rows[0]) {
    const age = Date.now() - Date.parse(rows[0].ts);
    if (age > 20 * 60000) issues.push(`Dauer-Worker (${rows[0].host}): letzter Herzschlag vor ${Math.round(age / 60000)} Min — Server/Dienst prüfen`);
  }
} catch (e) { /* Heartbeat optional */ }

// 3b) Zyklus-Signal (worker_heartbeat id=2): Daemon-Herzschlag (id=1) läuft auch, wenn
//     jeder Worker-Zyklus crasht — id=2 wird nur am ENDE eines Zyklus geschrieben
try {
  const r = await fetch(`${U}/rest/v1/worker_heartbeat?id=eq.2&select=ts`, { headers: H });
  const rows = r.ok ? await r.json() : [];
  if (rows[0]) {
    const age = Date.now() - Date.parse(rows[0].ts);
    if (age > 4 * 3600e3) issues.push(`Dauer-Worker: seit ${hours(age)}h kein abgeschlossener Zyklus — Worker crasht vermutlich jede Runde (Herzschlag allein täuscht Gesundheit vor)`);
  }
} catch (e) { /* optional */ }

// 4) Datenfrische JE KUNDE (vorher global: EIN gesunder Kunde maskierte 13 tote; Deep-Dive 12.08.)
//    a) Sales&Traffic <48h  b) SQP-Zeilen <9 Tage (Woechentlicher Refresh)  c) Ads-Terms <3 Tage
try {
  const cr = await fetch(`${U}/rest/v1/sqp_clients?active=eq.true&select=name,spid,marketplace,ads_profile_id`, { headers: H });
  const clients = cr.ok ? await cr.json() : [];
  const MKT_MAP = { DE: 'A1PA6795UKMFR9', FR: 'A13V1IB3VIYZZH', IT: 'APJ6JRA9NG5V4', ES: 'A1RKKUPIHCS9HS', UK: 'A1F83G8C2ARO7P', US: 'ATVPDKIKX0DER', NL: 'A1805IZSGTT6HS', SE: 'A2NODRKZP88ZB9', PL: 'A1C3SOZRARQ6R3' };
  const stale = { st: [], sqp: [], ads: [] };
  for (const c of clients) {
    const cc = (c.marketplace || 'DE').toUpperCase();
    // a) Sales&Traffic
    try {
      const r = await fetch(`${U}/rest/v1/asin_sales_traffic?spid=eq.${c.spid}&marketplace=eq.${cc}&select=updated_at&order=updated_at.desc&limit=1`, { headers: H });
      const rows = r.ok ? await r.json() : [];
      if (rows[0] && Date.now() - Date.parse(rows[0].updated_at) > 48 * 3600e3) stale.st.push(c.name);
    } catch (e) {}
    // b) SQP-Zeilen (nur Kunden, die schon Daten haben — Onboarding meldet Check 1)
    try {
      const mkt = MKT_MAP[cc] || cc;
      const r = await fetch(`${U}/rest/v1/sqp_asin_rows?selling_partner_id=eq.${c.spid}&marketplace_id=eq.${mkt}&select=ingested_at&order=ingested_at.desc&limit=1`, { headers: H });
      const rows = r.ok ? await r.json() : [];
      if (rows[0] && Date.now() - Date.parse(rows[0].ingested_at) > 9 * 24 * 3600e3) stale.sqp.push(c.name);
    } catch (e) {}
    // c) Ads-Terms (nur Profile, die schon Daten haben)
    if (c.ads_profile_id) try {
      const r = await fetch(`${U}/rest/v1/ads_asin_terms?profile_id=eq.${c.ads_profile_id}&select=ingested_at&order=ingested_at.desc&limit=1`, { headers: H });
      const rows = r.ok ? await r.json() : [];
      if (rows[0] && Date.now() - Date.parse(rows[0].ingested_at) > 3 * 24 * 3600e3) stale.ads.push(c.name);
    } catch (e) {}
  }
  if (stale.st.length) issues.push(`Sales&Traffic >48h alt bei: ${stale.st.join(', ')} (TACoS veraltet)`);
  if (stale.sqp.length) issues.push(`SQP-Daten >9 Tage alt bei: ${stale.sqp.join(', ')} (Wochen-Refresh prüfen)`);
  if (stale.ads.length) issues.push(`Ads-Daten >3 Tage alt bei: ${stale.ads.join(', ')} (Ads-Refresh prüfen)`);
} catch (e) { issues.push(`Watchdog: Datenfrische nicht prüfbar (${e.message})`); }

// Melden: Probleme sofort; sonst montags 05-Uhr-Lauf als Lebenszeichen (Stille ≠ gesund)
const sendSlack = async text => {
  if (!SLACK) { console.log('Kein SLACK_WEBHOOK_URL — Meldung nur im Log:\n' + text); return; }
  const r = await fetch(SLACK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  if (!r.ok) { console.error('Slack-POST fehlgeschlagen: ' + r.status); process.exit(1); }
};
const d = new Date();
if (issues.length) {
  console.log('PROBLEME:\n- ' + issues.join('\n- '));
  // Anti-Spam: dieselbe Problemlage wird höchstens 1x pro 24h gemeldet — der Wächter
  // läuft 4x täglich und wiederholte sonst jede ungelöste Meldung (Feedback 11.08.).
  // NEUE oder veränderte Probleme melden sofort.
  const fp = issues.map(x => x.replace(/\d+/g, '#')).sort().join('|'); // Zahlen raus: 'vor 170 Min' und 'vor 519 Min' sind DIESELBE Problemlage
  let suppress = false;
  try {
    const sr = await fetch(`${U}/rest/v1/watchdog_state?id=eq.1&select=fingerprint,alerted_at`, { headers: H });
    const st = sr.ok ? (await sr.json())[0] : null;
    if (st && st.fingerprint === fp && Date.now() - Date.parse(st.alerted_at) < 24 * 3600e3) suppress = true;
  } catch (e) { /* im Zweifel melden */ }
  if (suppress) { console.log('Gleiche Problemlage wie zuletzt — Slack-Meldung unterdrückt (max 1x/24h).'); }
  else {
    await sendSlack(`🚨 *SQPR-Pipeline-Wächter* — ${issues.length} Problem(e):\n• ${issues.join('\n• ')}\n<https://github.com/${REPO}/actions|Zu den Läufen →>`);
    try { await fetch(`${U}/rest/v1/watchdog_state?on_conflict=id`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ id: 1, fingerprint: fp, alerted_at: new Date().toISOString() }) }); } catch (e) {}
  }
} else {
  console.log('Alles gesund.');
  // Gelöste Probleme: Fingerprint löschen, damit ein Rückfall wieder sofort meldet
  try { await fetch(`${U}/rest/v1/watchdog_state?id=eq.1`, { method: 'DELETE', headers: H }); } catch (e) {}
  if (d.getUTCDay() === 1 && d.getUTCHours() === 5) await sendSlack('✅ *SQPR-Pipeline-Wächter*: Wochen-Check — Queue, Nachtläufe und Datenfrische in Ordnung.');
}
