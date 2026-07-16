// Geplante Gebots-Regeln (bid_rules) ausfuehren — API-Pendant zum Bulksheet-Bid-Optimizer.
// Zeitplan: daily = jede Nacht; weekly = nur montags. Engine identisch zu ppc-callback bid-run.js.
// ENV: ADS_CLIENT_ID/SECRET/REFRESH_TOKEN, SUPABASE_URL/SERVICE_KEY
import zlib from 'node:zlib';
const U = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const CID = process.env.ADS_CLIENT_ID, SEC = process.env.ADS_CLIENT_SECRET, RT = process.env.ADS_REFRESH_TOKEN;
if (!U || !KEY || !CID || !SEC || !RT) { console.error('FEHLER: ENV fehlt.'); process.exit(1); }
const ADS = 'https://advertising-api-eu.amazon.com';
const sbHead = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let AT = null;
async function token() {
  const t = await fetch('https://api.amazon.co.uk/auth/o2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: RT, client_id: CID, client_secret: SEC }) });
  AT = (await t.json()).access_token;
}
const hdr = (profileId, vnd) => ({ 'Amazon-Advertising-API-ClientId': CID, 'Amazon-Advertising-API-Scope': String(profileId), Authorization: 'Bearer ' + AT, ...(vnd ? { 'Content-Type': vnd, Accept: vnd } : {}) });
async function rfetch(url, opts, tries = 4) {
  for (let i = 0; i < tries; i++) { try { return await fetch(url, opts); } catch (e) { if (i === tries - 1) throw e; await sleep(8000 * (i + 1)); } }
}

// ===== identische Regel-Engine wie ppc-callback /api/ads/bid-run.js =====
function computeBids(rows, cfg) {
  const corridors = (cfg.corridors || []).map(c => ({ from: +c.from || 0, to: c.to === '' || c.to == null ? '' : +c.to, pct: +c.pct || 0, minBid: c.minBid === '' || c.minBid == null ? '' : +c.minBid, maxBid: c.maxBid === '' || c.maxBid == null ? '' : +c.maxBid, pause: !!c.pause, minClicks: c.minClicks === '' || c.minClicks == null ? '' : +c.minClicks, minOrders: c.minOrders === '' || c.minOrders == null ? '' : +c.minOrders }));
  const useMinBid = !!cfg.useMinBid, useMaxBid = !!cfg.useMaxBid;
  const minBid = +cfg.minBid || 0.02, maxBid = +cfg.maxBid || 999;
  const minClicks = +cfg.minClicks || 0;
  const noClicksAction = cfg.noClicksAction || 'keep';
  const exKw = String(cfg.excludeKeywords || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const exCamp = String(cfg.excludeCampaigns || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const out = [];
  for (const item of rows) {
    const kwL = String(item.keyword || '').toLowerCase(), campL = String(item.campaign || '').toLowerCase();
    const isExcluded = exKw.some(e => kwL.includes(e)) || exCamp.some(e => campL.includes(e));
    let newBid = item.currentBid, reason = '', paused = false;
    if (isExcluded) { reason = 'Ausgeschlossen'; }
    else if (item.clicks === 0) {
      switch (noClicksAction) {
        case 'reduce20': newBid = item.currentBid * 0.8; reason = 'Keine Klicks (−20%)'; break;
        case 'reduce30': newBid = item.currentBid * 0.7; reason = 'Keine Klicks (−30%)'; break;
        case 'reduce50': newBid = item.currentBid * 0.5; reason = 'Keine Klicks (−50%)'; break;
        case 'min': newBid = minBid; reason = 'Keine Klicks (Min.)'; break;
        default: reason = 'Keine Klicks (beibehalten)';
      }
    } else if (item.clicks < minClicks) { reason = `Nur ${item.clicks} Klicks (< ${minClicks})`; }
    else {
      const roas = item.spend > 0 ? item.sales / item.spend : 0;
      let mc = null;
      for (const c of corridors) { if (roas >= c.from && (c.to === '' ? true : roas < c.to)) { mc = c; break; } }
      if (!mc && corridors.length) mc = corridors[corridors.length - 1];
      if (mc) {
        const cMinClicks = mc.minClicks === '' ? 0 : mc.minClicks, cMinOrders = mc.minOrders === '' ? 0 : mc.minOrders;
        if ((cMinClicks > 0 && item.clicks < cMinClicks) || (cMinOrders > 0 && item.orders < cMinOrders)) { reason = `ROAS ${roas.toFixed(2)} → Schwelle nicht erreicht`; }
        else if (mc.pause) { paused = true; reason = `ROAS ${roas.toFixed(2)} → Pausieren`; }
        else {
          newBid = item.currentBid * (1 + mc.pct / 100);
          const cMin = mc.minBid === '' ? (useMinBid ? minBid : 0.02) : mc.minBid;
          const cMax = mc.maxBid === '' ? (useMaxBid ? maxBid : 999) : mc.maxBid;
          newBid = Math.max(cMin, Math.min(cMax, newBid));
          reason = `ROAS ${roas.toFixed(2)} → ${mc.pct > 0 ? '+' : ''}${mc.pct}%`;
        }
      }
    }
    newBid = Math.round(newBid * 100) / 100;
    if (useMaxBid && maxBid > 0 && newBid > maxBid) newBid = Math.min(newBid, Math.max(maxBid, item.currentBid > maxBid ? item.currentBid : maxBid));
    if (useMinBid && minBid > 0 && newBid < minBid) newBid = Math.min(minBid, item.currentBid);
    newBid = Math.max(0.02, Math.round(newBid * 100) / 100);
    const change = +(newBid - item.currentBid).toFixed(2);
    out.push({ ...item, newBid, change, paused, reason });
  }
  return out;
}

async function runRule(rule) {
  const profileId = rule.profile_id, cfg = rule.config || {};
  const days = Math.min(Math.max(+cfg.days || 30, 7), 60);
  const end = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const start = new Date(Date.now() - (days + 1) * 864e5).toISOString().slice(0, 10);
  // Report anlegen (425-Duplikat wiederverwenden)
  let reportId = null;
  for (let a = 0; a < 6 && !reportId; a++) {
    const r = await rfetch(`${ADS}/reporting/reports`, { method: 'POST', headers: hdr(profileId, 'application/vnd.createasyncreportrequest.v3+json'), body: JSON.stringify({ name: `bidrule ${rule.id}`, startDate: start, endDate: end, configuration: { adProduct: 'SPONSORED_PRODUCTS', reportTypeId: 'spTargeting', groupBy: ['targeting'], columns: ['campaignId', 'campaignName', 'adGroupId', 'adGroupName', 'keywordId', 'keyword', 'keywordType', 'matchType', 'keywordBid', 'adKeywordStatus', 'targeting', 'impressions', 'clicks', 'cost', 'purchases7d', 'sales7d'], timeUnit: 'SUMMARY', format: 'GZIP_JSON' } }) });
    if (r.status === 429) { await sleep(20000); continue; }
    const j = await r.json().catch(() => ({}));
    if (j.reportId) reportId = j.reportId;
    else if (r.status === 425) { const m = JSON.stringify(j).match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i); if (m) reportId = m[0]; }
    else { console.log('  Report-Fehler', r.status, JSON.stringify(j).slice(0, 120)); return; }
  }
  if (!reportId) { console.log('  kein Report (Drossel)'); return; }
  // warten + laden
  let rows = null;
  for (let i = 0; i < 60; i++) {
    const s = await rfetch(`${ADS}/reporting/reports/${reportId}`, { headers: hdr(profileId) });
    const sj = s.ok ? await s.json() : {};
    if (sj.status === 'COMPLETED' && sj.url) { rows = JSON.parse(zlib.gunzipSync(Buffer.from(await (await rfetch(sj.url)).arrayBuffer())).toString()); break; }
    if (sj.status === 'FAILURE') { console.log('  Report FAILURE'); return; }
    await sleep(20000);
  }
  if (!rows) { console.log('  Report-Timeout'); return; }
  const items = rows.filter(r => r.keywordBid != null && String(r.adKeywordStatus || '').toUpperCase() !== 'ARCHIVED')
    .map(r => ({ keywordId: String(r.keywordId), isTarget: String(r.keywordType || '').includes('TARGETING'), keyword: r.targeting || r.keyword, matchType: r.matchType || r.keywordType, campaign: r.campaignName, campaignId: String(r.campaignId), adGroup: r.adGroupName, currentBid: +r.keywordBid, clicks: +r.clicks || 0, orders: +r.purchases7d || 0, spend: +(+r.cost || 0).toFixed(2), sales: +(+r.sales7d || 0).toFixed(2) }));
  const changes = computeBids(items, cfg).filter(c => c.paused || Math.abs(c.change) >= 0.01);
  const summary = { items: items.length, changes: changes.length, up: changes.filter(c => c.change > 0 && !c.paused).length, down: changes.filter(c => c.change < 0 && !c.paused).length, paused: changes.filter(c => c.paused).length };
  // anwenden
  let ok = 0, fail = 0;
  const groups = { kw: changes.filter(c => !c.isTarget), tg: changes.filter(c => c.isTarget) };
  for (const [kind, list] of Object.entries(groups)) {
    const path = kind === 'kw' ? '/sp/keywords' : '/sp/targets';
    const vnd = kind === 'kw' ? 'application/vnd.spKeyword.v3+json' : 'application/vnd.spTargetingClause.v3+json';
    const key = kind === 'kw' ? 'keywords' : 'targetingClauses';
    const idKey = kind === 'kw' ? 'keywordId' : 'targetId';
    for (let i = 0; i < list.length; i += 100) {
      const body = {}; body[key] = list.slice(i, i + 100).map(c => ({ [idKey]: c.keywordId, ...(c.paused ? { state: 'PAUSED' } : { bid: c.newBid }) }));
      const r = await rfetch(`${ADS}${path}`, { method: 'PUT', headers: hdr(profileId, vnd), body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      const s = j[key] || {};
      ok += (s.success || []).length; fail += (s.error || []).length;
      await sleep(400);
    }
  }
  await rfetch(`${U}/rest/v1/bid_rule_runs`, { method: 'POST', headers: { ...sbHead, Prefer: 'return=minimal' }, body: JSON.stringify({ rule_id: rule.id, profile_id: profileId, dry_run: false, finished_at: new Date().toISOString(), summary: { ...summary, applied: ok, failed: fail, scheduled: true }, changes: changes.slice(0, 500).map(c => ({ k: c.keyword, c: c.campaign, o: c.currentBid, n: c.paused ? 'PAUSE' : c.newBid, r: c.reason })) }) });
  await rfetch(`${U}/rest/v1/bid_rules?id=eq.${rule.id}`, { method: 'PATCH', headers: sbHead, body: JSON.stringify({ last_run: new Date().toISOString() }) });
  console.log(`  ${summary.changes} Änderungen (↑${summary.up} ↓${summary.down} ⏸${summary.paused}) — ${ok} geschrieben, ${fail} Fehler`);
}

async function main() {
  await token();
  const rr = await rfetch(`${U}/rest/v1/bid_rules?active=eq.true&schedule=in.(daily,weekly)`, { headers: sbHead });
  const rules = await rr.json();
  const isMonday = new Date().getUTCDay() === 1;
  const due = rules.filter(r => r.schedule === 'daily' || (r.schedule === 'weekly' && isMonday));
  console.log(`Gebots-Regeln: ${rules.length} aktiv, ${due.length} fällig (${isMonday ? 'Montag' : 'kein Montag'})`);
  for (const rule of due) {
    console.log(`\n=== ${rule.name} (Profil ${rule.profile_id}, ${rule.schedule}) ===`);
    try { await runRule(rule); await token(); } catch (e) { console.log('  FEHLER:', e.message); }
  }
  console.log('\nFERTIG.');
}
main().catch(e => { console.error('FEHLER', e.message); process.exit(1); });
