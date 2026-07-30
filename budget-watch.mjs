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
  // v3-API (v2 liefert 404): POST /portfolios/list, paginiert über nextToken
  let out = [], nextToken = null;
  do {
    const r = await fetch(`${ADS}/portfolios/list`, { method: 'POST', headers: { ...H(profile), 'Content-Type': 'application/vnd.spPortfolio.v3+json', Accept: 'application/vnd.spPortfolio.v3+json' }, body: JSON.stringify(nextToken ? { nextToken } : {}) });
    if (!r.ok) { console.log(`Portfolios: HTTP ${r.status} — ${(await r.text()).slice(0, 200)}`); return out; }
    const j = await r.json();
    out = out.concat(j.portfolios || []);
    nextToken = j.nextToken || null;
  } while (nextToken);
  return out;
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

// Portfolio-Name -> Marken-Schlüssel (nach Christians Abgleich-Logik):
// Zusatz-Suffixe ("- NO BUDGET", "WKZ") entfernen, RK-Kürzel auflösen.
function brandKey(name) {
  let s = norm(name);
  s = s.replace(/\s*[-–—].*$/, '');           // "xyz - NO BUDGET" -> "xyz"
  s = s.replace(/\bwkz\b/g, '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^rk\s/, 'rotkäppchen ');
  return s;
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
  const ymd = d => { const s = String(d || '').replace(/-/g, ''); return /^\d{8}$/.test(s) ? s : null; };
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const jan1 = today.slice(0, 4) + '0101';
  const toDate = s => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));

  for (const profile of Object.keys(byProfile)) {
    const clientName = names[profile] || profile;
    console.log(`== ${clientName} (Profil ${profile})`);
    const all = (await portfolios(profile)).filter(p => (p.state || '').toLowerCase() !== 'archived');
    // Nur Portfolios, deren Budgetperiode ins laufende Jahr reicht (Alt-Portfolios raus)
    const withBudget = all.filter(p => {
      if (!p.budget || !(+p.budget.amount > 0)) return false;
      const end = ymd(p.budget.endDate);
      return !end || end >= jan1;
    });
    console.log(`${all.length} Portfolios, davon ${withBudget.length} mit aktueller Budgetperiode.`);
    const usage = await budgetUsage(profile, withBudget.map(p => p.portfolioId));

    const alerts = [], digestLines = [], planDiffs = [];
    const cats = { verbraucht: 0, kritisch: 0, zuschnell: 0, keineausgaben: 0, ok: 0 };
    let sumBudget = 0, sumSpend = 0;
    const brandPortfolioSum = {}; // Marken-Summe der Amazon-Portfolio-Budgets

    for (const p of withBudget) {
      const key = profile + '|' + p.portfolioId;
      const st = states[key] || { last_threshold: 0 };
      const amount = +p.budget.amount;
      sumBudget += amount;
      brandPortfolioSum[brandKey(p.name)] = (brandPortfolioSum[brandKey(p.name)] || 0) + amount;
      const pct = usage ? usage[String(p.portfolioId)] : null;
      if (pct == null) { digestLines.push(`❔ *${p.name}*: Verbrauch nicht abrufbar (Budget ${eur(amount)})`); continue; }
      const spend = amount * pct / 100;
      sumSpend += spend;

      // Laufzeit-Pace: Anteil der verstrichenen BUDGETPERIODE (nicht Kalenderjahr)
      const start = toDate(ymd(p.budget.startDate) || jan1);
      const end = toDate(ymd(p.budget.endDate) || (today.slice(0, 4) + '1231'));
      const frac = Math.min(1, Math.max(0.01, (Date.now() - start.getTime()) / Math.max(1, end.getTime() - start.getTime())));
      const pace = (pct / 100) / frac; // 1.0 = exakt im Plan
      const emptyAt = pct > 0 ? new Date(start.getTime() + (Date.now() - start.getTime()) / (pct / 100)) : null;
      const daysRunning = (Date.now() - start.getTime()) / 864e5;

      let icon = '✅', note = 'im Plan', cat = 'ok';
      if (pct >= 100) { icon = '🔴'; note = 'Budget aufgebraucht'; cat = 'verbraucht'; }
      else if (pct >= 80) { icon = '⚠️'; note = `${emptyAt ? 'bei aktuellem Tempo leer am ' + emptyAt.toLocaleDateString('de-DE') : 'kritisch'}`; cat = 'kritisch'; }
      else if (pace > 1.3) { icon = '⏩'; note = `zu schnell (Laufzeit ${Math.round(frac * 100)} %, Verbrauch ${Math.round(pct)} %)${emptyAt ? ' — leer am ' + emptyAt.toLocaleDateString('de-DE') : ''}`; cat = 'zuschnell'; }
      else if (pct === 0 && daysRunning > 14) { icon = '💤'; note = 'Budget vorhanden, aber 0 € Ausgaben — laufen Kampagnen?'; cat = 'keineausgaben'; }
      else if (pace < 0.7) { note = `deutlich unter Plan (Laufzeit ${Math.round(frac * 100)} %)`; }
      cats[cat]++;
      digestLines.push(`${icon} *${p.name}*: ${Math.round(pct)} % verbraucht (${eur(spend)} von ${eur(amount)}) — ${note}`);

      const crossed = [100, 90, 80].find(t => pct >= t) || 0;
      if (crossed > (st.last_threshold || 0)) {
        alerts.push(`${crossed >= 100 ? '🔴' : '⚠️'} *${p.name}*: ${crossed} %-Schwelle erreicht — ${Math.round(pct)} % verbraucht (${eur(spend)} von ${eur(amount)}), ${note}`);
      }
      st.newThreshold = Math.max(crossed, st.last_threshold || 0);
      states[key] = st; st._touched = true; st._profile = profile; st._pid = String(p.portfolioId);
    }

    // Marken-Abgleich: Budgetliste (je Marke) vs. Summe der Amazon-Portfolio-Budgets der Marke
    for (const brand of Object.keys(byProfile[profile])) {
      const planSum = byProfile[profile][brand];
      const portSum = brandPortfolioSum[brand];
      const key = profile + '|brand:' + brand;
      const st = states[key] || {};
      if (portSum == null) {
        if (planSum > 0) digestLines.push(`❔ *${brand}*: ${eur(planSum)} in der Budgetliste, aber kein aktives Portfolio mit Budget gefunden`);
        continue;
      }
      if (Math.abs(portSum - planSum) > 1) {
        const line = `↔️ *${brand}*: Budgetliste ${eur(planSum)} vs. Amazon-Portfolios ${eur(portSum)} — bitte angleichen.`;
        planDiffs.push(line);
        if (st.plan_diff == null || Math.abs((portSum - planSum) - st.plan_diff) > 1) alerts.push(line);
        st.newPlanDiff = portSum - planSum;
      } else { st.newPlanDiff = 0; }
      states[key] = st; st._touched = true; st._profile = profile; st._pid = 'brand:' + brand;
    }
    const planBrands = new Set(Object.keys(byProfile[profile]));
    const unmatchedPorts = Object.keys(brandPortfolioSum).filter(b => !planBrands.has(b));
    if (unmatchedPorts.length) digestLines.push(`❔ Portfolios ohne Marken-Zuordnung in der Budgetliste: ${unmatchedPorts.join(', ')}`);

    const kopf = `*Kennzahlen:* ${withBudget.length} aktive Portfolios · Budget ${eur(sumBudget)} · ausgegeben ${eur(sumSpend)} (${sumBudget ? Math.round(sumSpend / sumBudget * 100) : 0} %)\n` +
      `🔴 ${cats.verbraucht} verbraucht · ⚠️ ${cats.kritisch} kritisch (≥80 %) · ⏩ ${cats.zuschnell} zu schnell · 💤 ${cats.keineausgaben} ohne Ausgaben · ✅ ${cats.ok} im Rahmen`;

    if (alerts.length) await slack(`📊 *Budget-Tracking ${clientName}*\n${kopf}\n\n` + alerts.join('\n'));
    if (digest && digestLines.length) await slack(`📊 *Budget-Wochenübersicht ${clientName}*\n${kopf}\n\n` + digestLines.join('\n') + (planDiffs.length ? '\n\n*Abweichungen Budgetliste ↔ Amazon:*\n' + planDiffs.join('\n') : ''));
    if (!alerts.length) console.log('Keine neuen Schwellen-Alerts.');

    for (const key of Object.keys(states)) {
      const st = states[key]; if (!st._touched) continue;
      await fetch(`${U}/rest/v1/budget_watch_state?on_conflict=profile_id,portfolio_id`, { method: 'POST', headers: { ...sbHead, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ profile_id: st._profile, portfolio_id: st._pid, last_threshold: st.newThreshold ?? st.last_threshold ?? 0, plan_diff: st.newPlanDiff ?? st.plan_diff, updated_at: new Date().toISOString() }) });
      delete st._touched;
    }
  }
  console.log('FERTIG.');
}
main().catch(e => { console.error('FEHLER', e.message); process.exit(1); });
