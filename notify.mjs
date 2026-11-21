// Gemeinsamer Meldeweg fuer Skripte (ads-periodic Fail-Open-Liste, refresh Sammelmeldung).
// Mit SLACK_WEBHOOK_URL (GitHub): wie bisher direkt nach Slack. Ohne Webhook (Hetzner-Server, dort bewusst kein Slack-Secret):
// Text als Zeile kind='alert' in server_job_runs vormerken — der GitHub-Waechter leitet sie an Slack weiter und markiert sie als gesendet.
// Ohne beides nur ins Log. Wirft nie, verschweigt nie (liefert immer, was passiert ist):
// 'slack' | 'slack-failed' | 'queued' | 'queue-failed' | 'log-only' | 'nothing-to-send'
export async function notify({ text, job, env = process.env, fetchImpl = fetch, log = console.log }) {
  if (!text) return 'nothing-to-send';
  const hook = env.SLACK_WEBHOOK_URL;
  if (hook) {
    try {
      const r = await fetchImpl(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(30000) });
      if (r.ok) return 'slack';
      log('Slack-POST fehlgeschlagen: HTTP ' + r.status);
      return 'slack-failed';
    } catch (e) { log('Slack-POST fehlgeschlagen: ' + e.message); return 'slack-failed'; }
  }
  const U = env.SUPABASE_URL, K = env.SUPABASE_SERVICE_KEY;
  if (!U || !K) { log('(Kein SLACK_WEBHOOK_URL und kein Datenbankzugang — nur im Log gemeldet.)'); return 'log-only'; }
  try {
    const r = await fetchImpl(`${U}/rest/v1/server_job_runs`, {
      method: 'POST',
      headers: { apikey: K, Authorization: 'Bearer ' + K, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ job, kind: 'alert', detail: String(text).slice(0, 8000) }),
      signal: AbortSignal.timeout(30000),
    });
    if (r.ok) { log('(Kein SLACK_WEBHOOK_URL — Meldung in server_job_runs vorgemerkt, der Waechter leitet sie an Slack weiter.)'); return 'queued'; }
    log('Vormerken der Meldung in server_job_runs fehlgeschlagen: HTTP ' + r.status);
    return 'queue-failed';
  } catch (e) { log('Vormerken der Meldung in server_job_runs fehlgeschlagen: ' + e.message); return 'queue-failed'; }
}
