// Budget-Watch: überwacht Portfolio-Budgets (Jahresbudgets) gegen den Verbrauch
// laut Amazon Budget-Usage-API und gleicht sie mit der Kunden-Budgetliste ab
// (Tabelle budget_plan, Summe je Portfolio). Meldungen nach Slack.
// Kunden = alle distinct profile_id in budget_plan. Schwellen: 80/90/100 %.
// Jede Schwelle wird nur einmal gemeldet (budget_watch_state); montags Wochen-Digest.
// ENV: ADS_CLIENT_ID/SECRET/REFRESH_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY,
//      SLACK_WEBHOOK_BUDGET; optional DIGEST=1 erzwingt den Digest.
const CID = process.env.ADS_CLIENT_ID, SEC = process.env.ADS_CLIENT_SECRET, RT = process.env.ADS_REFRESH_TOKEN;
const U = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY, ADS = 'https://advertising-api-eu.amazon.com';
if (!CID || !SEC || !RT) { console.log('Ads-Secrets fehlen — Budget-Watch übersprungen.'); process.exit(0); }
const sbHead = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const eur = n => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n || 0);

let AT;
async function auth() { const t = await fetch('https://api.amazon.co.uk/auth/o2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: RT, client_id: CID, client_secret: SEC }) }); AT = (await t.json()).access_token; }
const H = profile => ({ 'Amazon-Advertising-API-ClientId': CID, 'Amazon-Advertising-API-Scope': String(profile), Authorization: 'Bearer ' + AT });

async function slack(text) {
  if (!process.env.SLACK_WEBHOOK_BUDGET) { console.log('Kein SLACK_WEBHOOK_BUDGET-Secret — Meldung nur im Log:\n' + text); return; }
  const r = await fetch(process.env.SLACK_WEBHOOK_BUDGET, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  if (!r.ok) console.log('Slack-Fehler:', r.status, (await r.text()).slice(0, 120));
}

const norm = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

async function portfolios(profile) {
  const r = await fetch(`${ADS}/v2/portfolios`, { headers: H(profile) });
  if (!r.ok) { console.log(`Portfolios: HTTP ${r.status} — ${(await r.text()).slice(0, 200)}`); return []; }
  const j = await r.json();
  return Array.isArray(j) ? j : [];
}

async function budgetUsage(profile, ids) {
  // Amazon liefert den offiziellen Verbrauch in % des Portfolio-Budgets
  const out = {};
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const r = await fetch(`${ADS}/portfolios/budget/usage`, { method: 'POST', headers: { ...H(profile), 'Content-Type': 'application/vnd.portfoliobudgetusage.v1+json' }, body: JSON.stringify({ portfolioIds: batch.map(String) }) });
    if (!r.ok) { console.log(`Budget-Usage: HTTP ${r.status} — ${(await r.text()).slice(0, 300)}`); return null; }
    const j = await r.json();
    for (const s of (j.success || [])) out[String(s.portfolioId)] = +s.budgetUsagePercent;
    for (const e of (j.error || [])) console.log(`Budget-Usage ${e.portfolioId}: ${e.errorMessage || e.code || JSON.stringify(e).slice(0, 100)}`);
    await sleep(500);
  }
  return out;
}

async function main() {
  await auth();
  const pr = await fetch(`${U}/rest/v1/budget_plan?select=profile_id,portfolio,yearly_budget`, { headers: sbHead });
  const plan = await pr.json();
  if (!Array.isArray(plan) || !plan.length) { console.log('budget_plan ist leer — nichts zu tun.'); return; }
  const byProfile = {};
  for (const p of plan) {
    const prof = (byProfile[p.profile_id] = byProfile[p.profile_id] || {});
    prof[norm(p.portfolio)] = (prof[norm(p.portfolio)] || 0) + (+p.yearly_budget || 0);
  }
  const nr = await fetch(`${U}/rest/v1/vra_clients?select=name,ads_profile_id&ads_profile_id=not.is.null`, { headers: sbHead });
  const names = {}; for (const c of await nr.json()) names[c.ads_profile_id] = c.name;
  const sr = await fetch(`${U}/rest/v1/budget_watch_state`, { headers: sbHead });
  const states = {}; for (const s of (await sr.json() || [])) states[s.profile_id + '|' + s.portfolio_id] = s;

  const digest = process.env.DIGEST === '1' || new Date().getUTCDay() === 1;

  for (const profile of Object.keys(byProfile)) {
    const clientName = names[profile] || profile;
    console.log(`== ${clientName} (Profil ${profile})`);
    const ports = (await portfolios(profile)).filter(p => p.state !== 'archived');
    const withBudget = ports.filter(p => p.budget && +p.budget.amount > 0);
    console.log(`${ports.length} Portfolios, davon ${withBudget.length} mit Budget.`);
    const usage = await budgetUsage(profile, withBudget.map(p => p.portfolioId));
    const alerts = [], planDiffs = [], digestLines = [];
    const yearStart = Date.UTC(new Date().getUTCFullYear(), 0, 1);
    const yearFrac = (Date.now() - yearStart) / (Date.UTC(new Date().getUTCFullYear() + 1, 0, 1) - yearStart);

    for (const p of withBudget) {
      const key = profile + '|' + p.portfolioId;
      const st = states[key] || { last_threshold: 0, plan_diff: null };
      const amount = +p.budget.amount;
      const pct = usage ? usage[String(p.portfolioId)] : null;
      const planSum = byProfile[profile][norm(p.name)];

      if (pct != null) {
        const spend = amount * pct / 100;
        const crossed = [100, 90, 80].find(t => pct >= t) || 0;
        const pace = pct / 100 / yearFrac; // 1.0 = exakt im Plan
        const emptyAt = pace > 0 ? new Date(yearStart + (Date.now() - yearStart) / (pct / 100)) : null;
        const forecast = pct >= 100 ? 'Budget aufgebraucht'
          : pace > 1.05 && emptyAt ? `bei aktuellem Tempo leer am ${emptyAt.toLocaleDateString('de-DE')}`
          : pace < 0.7 ? `deutlich unter Plan (Jahresfortschritt ${Math.round(yearFrac * 100)} %)` : 'im Plan';
        digestLines.push(`${pct >= 90 ? '🔴' : pct >= 80 ? '⚠️' : '✅'} *${p.name}*: ${Math.round(pct)} % verbraucht (${eur(spend)} von ${eur(amount)}) — ${forecast}`);
        if (crossed > (st.last_threshold || 0)) {
          alerts.push(`${crossed >= 100 ? '🔴' : '⚠️'} *${p.name}*: ${crossed} %-Schwelle erreicht — ${Math.round(pct)} % verbraucht (${eur(spend)} von ${eur(amount)}), ${forecast}`);
        }
        st.newThreshold = Math.max(crossed, st.last_threshold || 0);
      } else {
        digestLines.push(`❔ *${p.name}*: Verbrauch nicht abrufbar (Budget ${eur(amount)})`);
      }

      if (planSum != null && Math.abs(planSum - amount) > 1) {
        const line = `↔️ *${p.name}*: Budgetliste sagt ${eur(planSum)}, Portfolio in Amazon hat ${eur(amount)} — bitte angleichen.`;
        if (st.plan_diff == null || Math.abs((amount - planSum) - st.plan_diff) > 1) alerts.push(line);
        planDiffs.push(line);
        st.newPlanDiff = amount - planSum;
      } else { st.newPlanDiff = 0; }
      states[key] = st; st._touched = true; st._profile = profile; st._pid = String(p.portfolioId);
    }

    // Portfolios ohne Plan-Eintrag / Plan-Einträge ohne Portfolio (nur im Digest)
    const portNames = new Set(withBudget.map(p => norm(p.name)));
    const unmatchedPlan = Object.keys(byProfile[profile]).filter(n => !portNames.has(n));
    if (unmatchedPlan.length) digestLines.push(`❔ In der Budgetliste, aber kein (budgetiertes) Portfolio gefunden: ${unmatchedPlan.join(', ')}`);

    if (alerts.length) await slack(`📊 *Budget-Tracking ${clientName}*\n` + alerts.join('\n'));
    if (digest && digestLines.length) await slack(`📊 *Budget-Wochenübersicht ${clientName}*\n` + digestLines.join('\n') + (planDiffs.length ? '\n\n*Abweichungen Liste ↔ Portfolio:*\n' + planDiffs.join('\n') : ''));
    if (!alerts.length) console.log('Keine neuen Schwellen-Alerts.');

    // Status sichern
    for (const key of Object.keys(states)) {
      const st = states[key]; if (!st._touched) continue;
      await fetch(`${U}/rest/v1/budget_watch_state?on_conflict=profile_id,portfolio_id`, { method: 'POST', headers: { ...sbHead, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ profile_id: st._profile, portfolio_id: st._pid, last_threshold: st.newThreshold ?? st.last_threshold ?? 0, plan_diff: st.newPlanDiff ?? st.plan_diff, updated_at: new Date().toISOString() }) });
      delete st._touched;
    }
  }
  console.log('FERTIG.');
}
main().catch(e => { console.error('FEHLER', e.message); process.exit(1); });
