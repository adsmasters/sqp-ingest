// Amazon-Business-(B2B)-Auswertung fuer das PPC-Audit. REINE Funktionen ohne Imports/Netzwerk.
// Diese Datei existiert bewusst identisch als sqp-ingest/audit-b2b.mjs (naechtlicher Audit-Job) --
// ein Test vergleicht beide Dateien byteweise, damit die Logik nicht auseinanderlaeuft.
//
// Datenbasis (Amazon Ads API v3, reportTypeId spCampaigns, groupBy ["campaignPlacement"]):
//   cur  = Report mit Filter campaignSite=AmazonBusiness, aktuelles 30-Tage-Fenster
//   all  = gleicher Report OHNE Filter, gleiches Fenster (B2B ist eine TEILMENGE von "all")
//   prev = gefilterter Report fuer die 30 Tage davor (Trend)
// "rest" = all minus B2B (nie negativ). Alle Summen: Impressionen, Klicks, Spend (cost),
// Sales (sales7d), Orders (purchases7d).

export const B2B_PLACEMENT = "SITE_AMAZON_BUSINESS";
export const PLACEMENT_KEYS = [
  "PLACEMENT_TOP",
  "PLACEMENT_PRODUCT_PAGE",
  "PLACEMENT_REST_OF_SEARCH",
  "SITE_AMAZON_BUSINESS",
];
export const B2B_RULES = {
  minClicks: 10, // B2B-Klicks, darunter "wenig Daten"
  minCampaignSpend: 20, // Gesamt-Spend der Kampagne im Fenster (wie D+)
  chanceRatio: 1.2, // B2B-ROAS >= 1,2 x Rest-ROAS und Gebot <= 0 -> Chance
  problemRatio: 0.8, // Gebot > 0 und B2B-ROAS < 0,8 x Rest-ROAS -> Problem
  maxCampaigns: 1000,
  maxBidAdj: 40,
  maxBids: 2000,
};

const num = (v) => {
  const n = +v;
  return Number.isFinite(n) ? n : 0;
};
const rowsOf = (a) =>
  Array.isArray(a) ? a.filter((r) => r && typeof r === "object") : [];
const zero = () => ({ impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0 });
const pos = (v) => Math.max(0, num(v)); // negative Werte (Korrekturzeilen) zaehlen nicht als negative Summen
function add(m, r) {
  m.impressions += pos(r.impressions);
  m.clicks += pos(r.clicks);
  m.spend += pos(r.cost);
  m.sales += pos(r.sales7d);
  m.orders += pos(r.purchases7d);
}
const EPS = 1e-9; // Gleitkomma-Toleranz an den Schwellen (z.B. ROAS genau 1,2 x Rest)
const c2 = (x) => Math.round(x * 100) / 100;
const hasId = (r) => r.campaignId != null && String(r.campaignId) !== "";
function sumRows(rows) {
  const m = zero();
  for (const r of rows) add(m, r);
  return m;
}
const sub = (a, b) => ({
  impressions: Math.max(0, a.impressions - b.impressions),
  clicks: Math.max(0, a.clicks - b.clicks),
  spend: Math.max(0, c2(a.spend - b.spend)), // auf Cent runden: keine Gleitkomma-Reste (1e-15) als "Rest-Spend"
  sales: Math.max(0, c2(a.sales - b.sales)),
  orders: Math.max(0, a.orders - b.orders),
});
const fin = (m) => ({
  impressions: Math.round(m.impressions),
  clicks: Math.round(m.clicks),
  spend: +m.spend.toFixed(2),
  sales: +m.sales.toFixed(2),
  orders: Math.round(m.orders),
});
const roasOf = (m) => (m.spend > 0 ? m.sales / m.spend : 0);
const ratio = (a, b) => (b > 0 ? a / b : 0);
const labelOf = (r) => String(r.placementClassification || "(none)");
const idOf = (r) => String(r.campaignId);

export function isExclusive(c) {
  return !!c && Array.isArray(c.siteRestrictions) && c.siteRestrictions.includes("AMAZON_BUSINESS");
}

// Aktuelle Gebote einer Kampagne (Prozent je Platzierung, fehlend = 0).
export function bidsOf(c) {
  const pb = (c && c.dynamicBidding && c.dynamicBidding.placementBidding) || [];
  const out = {};
  for (const k of PLACEMENT_KEYS) {
    const hit = Array.isArray(pb) ? pb.find((x) => x && x.placement === k) : null;
    out[k] = hit ? num(hit.percentage) : 0;
  }
  return out;
}

// Alle Kampagnen mit ihren 4 Geboten (ersetzt placement-list.js fuer die Oberflaeche).
// spRows (optional): SP-Kampagnenreport-Zeilen des gewaehlten Zeitraums -> je Kampagne "perf" (Spend/Sales/...), damit die
// Gebote-Tabelle eine Entscheidungsgrundlage zeigt. Ohne spRows: kein perf-Feld (wie bisher).
export function buildCampaignBids(entities, spRows) {
  const out = [];
  let perf = null;
  if (Array.isArray(spRows)) {
    perf = new Map();
    for (const r of spRows) {
      if (!r || r.campaignId == null) continue;
      const k = String(r.campaignId);
      const m = perf.get(k) || { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0 };
      m.impressions += +r.impressions || 0;
      m.clicks += +r.clicks || 0;
      m.spend += +r.cost || 0;
      m.sales += +r.sales7d || 0;
      m.orders += +r.purchases7d || 0;
      perf.set(k, m);
    }
  }
  if (!entities || typeof entities.values !== "function") return out;
  for (const c of entities.values()) {
    if (!c || c.campaignId == null) continue;
    const row = {
      campaignId: String(c.campaignId),
      name: c.name || "",
      state: c.state || "",
      strategy: (c.dynamicBidding && c.dynamicBidding.strategy) || "",
      exclusive: isExclusive(c),
      bids: bidsOf(c),
    };
    if (perf) {
      const m = perf.get(String(c.campaignId));
      row.perf = m
        ? { impressions: m.impressions, clicks: m.clicks, spend: Math.round(m.spend * 100) / 100, sales: Math.round(m.sales * 100) / 100, orders: m.orders }
        : { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0 };
    }
    out.push(row);
    if (out.length >= B2B_RULES.maxBids) break;
  }
  return out;
}

function verdictOf(c) {
  if (c.state !== "ENABLED" || c.exclusive) return null;
  if (c.allMetrics.spend < B2B_RULES.minCampaignSpend) return null;
  if (c.b2b.clicks < B2B_RULES.minClicks) return null;
  const b2bRoas = roasOf(c.b2b);
  const restRoas = roasOf(c.rest);
  const bid = c.bids[B2B_PLACEMENT];
  // Chance nur mit echter Vergleichsbasis: ohne Nicht-B2B-Umsatz (restRoas 0) ist "B2B schlaegt den Rest"
  // bedeutungslos und die Vorschlagslogik der Oberflaeche wuerde auf 100 % ausschlagen.
  if (restRoas > 0 && b2bRoas >= restRoas * B2B_RULES.chanceRatio - EPS && bid <= 0 && c.b2b.sales > 0)
    return "chance";
  if (bid > 0 && b2bRoas < restRoas * B2B_RULES.problemRatio - EPS) return "problem";
  return null;
}

// cur/all/prev: Report-Zeilen (Array) oder null. entities: Map campaignId -> Kampagnenobjekt.
// windows: {cur:{start,end}, prev:{start,end}} (nur zur Anzeige).
export function aggregateB2b({ cur, all, prev, entities, windows } = {}) {
  if (!Array.isArray(cur) || !Array.isArray(all)) {
    return { available: false, reason: "B2B-Reports nicht verfuegbar" };
  }
  const curRows = rowsOf(cur);
  const allRows = rowsOf(all);
  const hasPrev = Array.isArray(prev);
  const prevRows = rowsOf(prev);

  const b2bTotal = sumRows(curRows);
  const allTotal = sumRows(allRows);
  const restTotal = sub(allTotal, b2bTotal);
  const prevTotal = hasPrev ? sumRows(prevRows) : null;

  const labels = [];
  for (const r of [...curRows, ...allRows]) {
    const l = labelOf(r);
    if (!labels.includes(l)) labels.push(l);
  }
  const byPlacement = labels
    .map((label) => {
      const b = sumRows(curRows.filter((r) => labelOf(r) === label));
      const a = sumRows(allRows.filter((r) => labelOf(r) === label));
      return { label, b2b: fin(b), all: fin(a), rest: fin(sub(a, b)) };
    })
    .sort((x, y) => y.all.spend - x.all.spend);

  const ents = entities && typeof entities.get === "function" ? entities : new Map();
  // Kampagnenliste: nur Kampagnen mit B2B-Aktivitaet (aktuelles oder voriges Fenster), mit B2B-Gebot > 0 oder
  // reine Amazon-Business-Kampagnen -- Kampagnen ganz ohne B2B-Bezug gehoeren nicht in diese Tabelle.
  const ids = new Set();
  for (const r of curRows) if (hasId(r)) ids.add(idOf(r));
  if (hasPrev) for (const r of prevRows) if (hasId(r)) ids.add(idOf(r));
  for (const [id, c] of ents.entries ? ents.entries() : []) {
    if (bidsOf(c)[B2B_PLACEMENT] > 0 || isExclusive(c)) ids.add(String(id));
  }
  const cBy = new Map();
  for (const id of ids) cBy.set(id, { name: "", b2b: zero(), all: zero(), prev: zero(), pl: Object.create(null) });
  const group = (rows, key) => {
    for (const r of rows) {
      if (!hasId(r)) continue; // Zeilen ohne campaignId zaehlen nur in den Konto-Summen
      const o = cBy.get(idOf(r));
      if (!o) continue;
      if (!o.name && r.campaignName) o.name = String(r.campaignName);
      add(o[key], r);
      if (key === "b2b") {
        const l = labelOf(r);
        o.pl[l] = o.pl[l] || zero();
        add(o.pl[l], r);
      }
    }
  };
  group(curRows, "b2b");
  group(allRows, "all");
  if (hasPrev) group(prevRows, "prev");

  const campaigns = [];
  for (const id of ids) {
    const o = cBy.get(id) || { name: "", b2b: zero(), all: zero(), prev: zero(), pl: Object.create(null) };
    const e = ents.get(id) || ents.get(Number(id)) || null;
    const rest = sub(o.all, o.b2b);
    const c = {
      campaignId: id,
      name: (e && e.name) || o.name || "",
      state: (e && e.state) || "",
      exclusive: isExclusive(e),
      strategy: (e && e.dynamicBidding && e.dynamicBidding.strategy) || "",
      bids: bidsOf(e),
      b2b: o.b2b,
      rest,
      allMetrics: o.all,
    };
    const verdict = verdictOf(c);
    campaigns.push({
      campaignId: c.campaignId,
      name: c.name,
      state: c.state,
      exclusive: c.exclusive,
      strategy: c.strategy,
      bids: c.bids,
      b2b: fin(o.b2b),
      rest: fin(rest),
      prev: hasPrev ? fin(o.prev) : null,
      byPlacement: Object.fromEntries(Object.entries(o.pl).map(([l, m]) => [l, fin(m)])),
      share: { spend: ratio(o.b2b.spend, o.all.spend), sales: ratio(o.b2b.sales, o.all.sales) },
      lowData: o.b2b.clicks < B2B_RULES.minClicks,
      verdict,
    });
  }
  campaigns.sort(
    (x, y) => y.b2b.spend - x.b2b.spend || y.bids[B2B_PLACEMENT] - x.bids[B2B_PLACEMENT],
  );
  const truncated = campaigns.length > B2B_RULES.maxCampaigns;
  if (truncated) campaigns.length = B2B_RULES.maxCampaigns;

  const traffic = (c) => c.b2b.impressions > 0 || c.b2b.clicks > 0 || c.b2b.spend > 0;
  const counts = {
    withTraffic: campaigns.filter(traffic).length,
    withBid: campaigns.filter((c) => c.bids[B2B_PLACEMENT] > 0).length,
    bidNoTraffic: campaigns.filter((c) => c.bids[B2B_PLACEMENT] > 0 && !traffic(c)).length,
    trafficNoBid: campaigns.filter((c) => traffic(c) && c.bids[B2B_PLACEMENT] <= 0).length,
    exclusive: campaigns.filter((c) => c.exclusive).length,
    chance: campaigns.filter((c) => c.verdict === "chance").length,
    problem: campaigns.filter((c) => c.verdict === "problem").length,
  };

  return {
    available: true,
    windows: windows || null,
    rules: { ...B2B_RULES },
    account: {
      // B2B ist eine Teilmenge von "all": ist es groesser, sind die Daten inkonsistent (z.B. Berichtsverzug)
      inconsistent: b2bTotal.spend > allTotal.spend + 0.01 || b2bTotal.impressions > allTotal.impressions,
      b2b: fin(b2bTotal),
      all: fin(allTotal),
      rest: fin(restTotal),
      prev: prevTotal ? fin(prevTotal) : null,
      share: {
        spend: ratio(b2bTotal.spend, allTotal.spend),
        sales: ratio(b2bTotal.sales, allTotal.sales),
        impressions: ratio(b2bTotal.impressions, allTotal.impressions),
      },
      roasFactor: ratio(roasOf(b2bTotal), roasOf(restTotal)),
    },
    byPlacement,
    campaigns,
    truncated,
    counts,
  };
}

// D+-kompatible Zeilen (gleiche Felder wie die Platzierungs-Zeilen; Typ 'b2b').
// campRoas = Rest-ROAS (ohne B2B), placRoas = B2B-ROAS -> bestehende Vorschlags-/Anzeigelogik passt.
export function b2bBidAdjRows(block) {
  if (!block || !block.available) return [];
  const rows = [];
  for (const c of block.campaigns) {
    if (!c.verdict) continue;
    rows.push({
      campaignId: c.campaignId,
      plKey: B2B_PLACEMENT,
      campaign: c.name,
      placement: "Amazon Business",
      adjustment: c.bids[B2B_PLACEMENT],
      campRoas: +roasOf(c.rest).toFixed(2),
      placRoas: +roasOf(c.b2b).toFixed(2),
      clicks: c.b2b.clicks,
      spend: c.b2b.spend,
      sales: c.b2b.sales,
      verdict: c.verdict,
      kind: "b2b",
    });
  }
  rows.sort((a, b) =>
    a.verdict > b.verdict ? 1 : a.verdict < b.verdict ? -1 : b.spend - a.spend,
  );
  return rows.slice(0, B2B_RULES.maxBidAdj);
}
