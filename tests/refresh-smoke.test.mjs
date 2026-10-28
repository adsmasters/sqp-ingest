// End-to-end smoke test of refresh.mjs (weekly SQP refresh) on a FAKE network (mock-net-refresh.mjs) with a VIRTUAL clock:
// nothing can reach Amazon, Supabase or Slack, every unknown URL throws, and a 5-hour run takes well under a second of real time.
// Expectations come from the requirements (see refresh-resilience.test.mjs), NOT from reading the code:
//  - healthy run: every client gets its 15 reports, rows are written, no Slack message, exit 0, "ALLES FERTIG.";
//  - Amazon stalls on every report: each client is abandoned after 6 timeouts in a row (not 15), the run stops starting clients
//    (outage), ONE Slack message lists affected + not-started clients, the job still exits 0;
//  - a single dead client is cut and reported while all others complete;
//  - a used-up time budget stops NEW clients and the not-started ones are named in Slack;
//  - clients skipped early (no token / listings report fails / > 300 ASINs without brand filter) are reported with a readable reason
//    and do not count as an outage;
//  - clients run stalest-first (newest sqp_asin_rows.ingested_at per spid+marketplace, never-ingested first); SQP_ONLY = no ingest query;
//  - a create call that never succeeds is bounded (8 min) and counts like a timeout; hung requests are always aborted;
//  - a failing Slack POST never changes the exit code.
// Second block (R1..R12): the insert-before-delete write path of sqp_asin_rows (stateful table in the mock). Run: node --test <this file> (env SQP_ROOT = sqp-ingest dir when not placed in sqp-ingest/tests).
// SAFETY: refresh.mjs only talks to the fake; no live campaign / ad endpoint exists in this script or in the mock.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// root = the sqp-ingest dir: the parent of tests/ (when this file lives in sqp-ingest/tests/); elsewhere set env SQP_ROOT
const root = fs.existsSync(path.join(here, '..', 'refresh.mjs')) ? path.join(here, '..') : process.env.SQP_ROOT;
if (!root || !fs.existsSync(path.join(root, 'refresh.mjs'))) throw new Error('refresh.mjs not found: run from sqp-ingest/tests or set SQP_ROOT to the sqp-ingest dir');
const MOCK = 'mock-net-refresh.mjs'; // sibling of this file
const MK = { DE: 'A1PA6795UKMFR9', FR: 'A13V1IB3VIYZZH', UK: 'A1F83G8C2ARO7P' };
const pad = (n) => String(n).padStart(2, '0');
const clientsOf = (n, mkt = {}) => Array.from({ length: n }, (_, i) => ({ name: 'Shop' + pad(i + 1), spid: 'SP' + pad(i + 1), marketplace: mkt[i + 1] || 'DE' }));
const names = (n) => clientsOf(n).map((c) => c.name);
const sp = (name) => 'SP' + name.slice(4);
const FULL_ROWS = 45 * 3 * 5; // 45 active ASINs x 3 queries x (2 MONTH + 3 WEEK periods)
const OUTAGE = /Amazon liefert gerade keine SQP-Reports/;
const RAW_JS = /Cannot read|TypeError|ReferenceError|undefined|\[object|NaN|at \S+ \(|\.mjs/;

function runScenario(scen, env = {}, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqp-refresh-smoke-'));
  const summary = path.join(dir, 'summary.json');
  const scenJson = JSON.stringify(scen); const scenEnv = {};
  if (scenJson.length > 6000) { const f = path.join(dir, 'scenario.json'); fs.writeFileSync(f, scenJson); scenEnv.FAKE_SCEN_FILE = f; } else scenEnv.FAKE_SCEN = scenJson; // Windows caps one env value at ~32 KB
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(here, MOCK)).href, path.join(root, 'refresh.mjs'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SPAPI_CLIENT_ID: 'fake-id', SPAPI_CLIENT_SECRET: 'fake-secret',
      SUPABASE_URL: 'https://fake-supabase.test', SUPABASE_SERVICE_KEY: 'fake-key', SLACK_WEBHOOK_URL: 'https://fake-slack.test/hook',
      ...scenEnv, FAKE_SUMMARY: summary, ...env },
  });
  let S = null; try { S = JSON.parse(fs.readFileSync(summary, 'utf8')); } catch {}
  const lines = (r.stdout || '').split('\n').filter((l) => l.trim()).map((l) => { const m = l.match(/^\[T\+\s*([\d.]+)m\] (.*)$/); return m ? { t: +m[1], s: m[2] } : { t: NaN, s: l }; });
  const text = lines.map((l) => l.s);
  const slack = (S?.slack || []).map((x) => JSON.parse(x.body).text);
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', S, lines, text, wall: (Date.now() - t0) / 1000, slack,
    started: text.map((s) => s.match(/^Kunde: (\S+) \(/)).filter(Boolean).map((m) => m[1]),
    abandoned: [...new Set(text.map((s) => s.match(/^\s*(Shop\d+): ABGEBROCHEN/)).filter(Boolean).map((m) => m[1]))],
    bullet: (name) => (slack[0] || '').split('\n').find((l) => l.startsWith('• ' + name + ':')) || '' };
}
function commonInvariants(R, exit = 0) {
  assert.ok(R.S, 'mock wrote no summary - process crashed?\n' + R.stderr);
  assert.equal(R.status, exit, R.stderr + '\n' + R.stdout.slice(-1500));
  assert.deepEqual(R.S.unmocked, [], 'a request reached an unmocked URL');
  assert.ok(!/MOCK_CAP/.test(R.stderr), 'virtual time cap hit');
  if (exit === 0) assert.equal(R.text[R.text.length - 1], 'ALLES FERTIG.');
}
const complete = (R, spids) => { for (const s of spids) { assert.equal(R.S.created[s], 15, s + ' created'); assert.equal(R.S.rowsPosted[s], FULL_ROWS, s + ' rows'); } };

describe('refresh.mjs on a fake network', () => {
  test('healthy run: all clients complete (15 reports, full rows), no Slack, exit 0', () => {
    const R = runScenario({ clients: clientsOf(6) });
    commonInvariants(R);
    assert.equal(R.started.length, 6);
    complete(R, names(6).map(sp));
    assert.equal(R.slack.length, 0, 'nothing to report => no Slack message');
    assert.deepEqual(R.abandoned, []);
  });

  test('global stall: every client abandoned after 6..9 timeouts, outage stops the run, ONE Slack message, exit 0', () => {
    const R = runScenario({ clients: clientsOf(8), pattern: 'T' });
    commonInvariants(R);
    const notStarted = names(8).filter((n) => !R.started.includes(n));
    assert.ok(R.started.length >= 3 && R.started.length <= 5, 'started=' + R.started);
    assert.deepEqual([...R.abandoned].sort(), [...R.started].sort(), 'every started client abandoned');
    assert.ok(notStarted.length >= 3, 'outage must leave clients unstarted');
    for (const n of R.started) assert.ok(R.S.created[sp(n)] >= 6 && R.S.created[sp(n)] <= 9, `${n} creates=${R.S.created[sp(n)]} (breaker, not 15)`);
    assert.equal(R.slack.length, 1);
    assert.match(R.slack[0], /SQP Weekly Refresh/);
    assert.match(R.slack[0], OUTAGE);
    for (const n of notStarted) assert.match(R.slack[0], new RegExp(n + '\\b'));
    assert.match(R.slack[0], /only_client/);
    assert.ok(R.S.fakeMin < 130, 'virtual minutes ' + R.S.fakeMin);
  });

  test('one dead client is cut and reported; all others complete; no outage message', () => {
    const R = runScenario({ clients: clientsOf(8), perClient: { SP03: 'T' } });
    commonInvariants(R);
    assert.deepEqual(R.abandoned, ['Shop03']);
    assert.ok(R.S.created.SP03 >= 6 && R.S.created.SP03 <= 9 && !(R.S.rowsPosted.SP03 > 0));
    complete(R, names(8).filter((n) => n !== 'Shop03').map(sp));
    assert.equal(R.slack.length, 1);
    assert.match(R.slack[0], /Shop03\b/);
    assert.doesNotMatch(R.slack[0], OUTAGE);
    assert.doesNotMatch(R.slack[0], /Nicht gestartet/);
  });

  test('budget exhausted: no NEW client after the budget, not-started clients are named in Slack (neutral header, no outage)', () => {
    const R = runScenario({ clients: clientsOf(20) }, { SQP_BUDGET_MIN: '12', SQP_HARD_MIN: '100' });
    commonInvariants(R);
    const notStarted = names(20).filter((n) => !R.started.includes(n));
    assert.ok(notStarted.length > 0 && R.started.length >= 3, 'started=' + R.started.length);
    assert.ok(R.lines.filter((l) => /^Kunde:/.test(l.s)).every((l) => l.t <= 12.5), 'a client started after the budget');
    assert.equal(R.slack.length, 1);
    assert.match(R.slack[0], /SQP Weekly Refresh/);
    for (const n of notStarted) assert.match(R.slack[0], new RegExp(n + '\\b'));
    assert.match(R.slack[0], /only_client/);
    assert.doesNotMatch(R.slack[0].split('\n')[0], /Amazon-Timeouts/, 'budget-only run must not blame Amazon timeouts');
    assert.doesNotMatch(R.slack[0], OUTAGE);
    assert.deepEqual(R.abandoned, []);
    for (const n of R.started) assert.equal(R.S.created[sp(n)], 15);
  });

  test('early-skipped clients (no token / listings report fails / 350 ASINs without brand filter) are reported readably and are NOT an outage', () => {
    const R = runScenario({ clients: clientsOf(8), noToken: ['SP01'], listMode: { SP02: 'http500' }, bigList: { SP03: 350 } });
    commonInvariants(R);
    assert.equal(R.started.length, 8, 'the three skips must not stop the run');
    complete(R, ['Shop04', 'Shop05', 'Shop06', 'Shop07', 'Shop08'].map(sp));
    for (const n of ['Shop01', 'Shop02', 'Shop03']) assert.ok(!(R.S.created[sp(n)] > 0), n + ' must create no SQP report');
    assert.equal(R.slack.length, 1);
    assert.match(R.slack[0], /SQP Weekly Refresh/);
    assert.match(R.slack[0], /only_client/);
    assert.doesNotMatch(R.slack[0], OUTAGE);
    assert.doesNotMatch(R.slack[0], /Nicht gestartet/);
    assert.match(R.bullet('Shop01'), /Token/i);
    assert.match(R.bullet('Shop02'), /Listings/i);
    assert.match(R.bullet('Shop03'), /350.*Marken-Filter/);
    assert.doesNotMatch(R.slack[0], RAW_JS, 'raw JS error text leaked into the Slack message');
  });

  test('order: stalest data first per (spid, marketplace), never-ingested first, ties by name; SQP_ONLY asks no ingest query', () => {
    // Shop02 is FR but only has an ingest row for DE => never ingested (the key includes the marketplace); Shop08 is UK
    const ingest = { [`SP01|${MK.DE}`]: '2026-10-27T10:00:00Z', [`SP02|${MK.DE}`]: '2026-10-05T10:00:00Z', [`SP03|${MK.DE}`]: '2026-10-01T10:00:00Z',
      [`SP04|${MK.DE}`]: '2026-10-15T10:00:00Z', [`SP05|${MK.DE}`]: '2026-10-15T10:00:00Z', [`SP07|${MK.DE}`]: '2026-10-20T10:00:00Z', [`SP08|${MK.UK}`]: '2026-10-10T10:00:00Z' };
    const cl = clientsOf(8, { 2: 'FR', 8: 'UK' });
    const R = runScenario({ clients: cl, ingest });
    commonInvariants(R);
    assert.deepEqual(R.started, ['Shop02', 'Shop06', 'Shop03', 'Shop08', 'Shop04', 'Shop05', 'Shop07', 'Shop01']);
    assert.match(R.S.clientsUrl, /(^|&)order=name\.asc(&|$)/);
    assert.equal(R.S.ingestQ.length, 8);
    for (const c of cl) assert.ok(R.S.ingestQ.some((q) => q.url === `sqp_asin_rows?selling_partner_id=eq.${c.spid}&marketplace_id=eq.${MK[c.marketplace]}&select=ingested_at&order=ingested_at.desc&limit=1`), 'ingest query of ' + c.name);
    complete(R, names(8).map(sp));
    const O = runScenario({ clients: cl, ingest }, { SQP_ONLY: 'Shop05' });
    commonInvariants(O);
    assert.deepEqual(O.started, ['Shop05']);
    assert.equal(O.S.ingestQ.length, 0, 'SQP_ONLY must not query ingest times');
  });

  test('hung requests: a create call that never succeeds is capped at ~8 min, counts like a timeout (client abandoned), every hung request is aborted', () => {
    const R = runScenario({ clients: clientsOf(6), createMode: { SP03: 'hang' } });
    commonInvariants(R);
    assert.deepEqual(R.abandoned, ['Shop03']);
    const fails = R.lines.filter((l) => /^\s+Shop03 \[\d+\/15\].*create fail/.test(l.s));
    assert.ok(fails.length >= 6 && fails.length <= 9, 'failed creates in a row=' + fails.length + ' (breaker, not 15)');
    const gaps = fails.slice(1).map((l, i) => l.t - fails[i].t);
    assert.ok(Math.max(...gaps) <= 8.75, 'a single create call took ' + Math.max(...gaps).toFixed(2) + ' virtual min (cap 8)');
    assert.ok(!(R.S.created.SP03 > 0) && !(R.S.rowsPosted.SP03 > 0));
    assert.ok(R.S.aborted.SP03 >= 6, 'hung creates must be aborted by a timeout');
    assert.ok(!(R.S.hungNoSignal.SP03 > 0), 'a request without AbortSignal would hang the real job forever');
    complete(R, ['SP01', 'SP02', 'SP04', 'SP05', 'SP06']);
  });

  test('Slack failure never fails the job: webhook answering HTTP 500 => exit 0, message was attempted once', () => {
    const R = runScenario({ clients: clientsOf(4), perClient: { SP02: 'T' }, slackStatus: 500 });
    commonInvariants(R);
    assert.equal(R.S.slack.length, 1);
    assert.match(R.stdout, /Slack-POST fehlgeschlagen: HTTP 500/);
  });

  test('listings access errors of single clients (HTTP 401 / 403: blocked or revoked accounts) are NOT an Amazon outage', () => {
    // never-ingested clients sit at the front under stalest-first, so blocked accounts are typically processed first (ShinyChiefs / YUKATrack case)
    const R = runScenario({ clients: clientsOf(8), listMode: { SP01: 'http401', SP02: 'http401', SP03: 'http403' } });
    commonInvariants(R);
    assert.equal(R.started.length, 8, 'blocked accounts must not stop the run');
    complete(R, ['SP04', 'SP05', 'SP06', 'SP07', 'SP08']);
    assert.equal(R.slack.length, 1);
    assert.doesNotMatch(R.slack[0], OUTAGE, 'three blocked accounts in a row are not an Amazon outage');
    assert.doesNotMatch(R.slack[0], /Nicht gestartet/);
    for (const n of ['Shop01', 'Shop02', 'Shop03']) assert.match(R.bullet(n), /übersprungen/);
    assert.doesNotMatch(R.slack[0], RAW_JS);
  });

  // Three clients failing the same way finish together, so the "last 3 finished clients" window really holds three dead ones (failures of
  // different kinds finish at different times and healthy clients in between would rightly break the series).
  for (const [kind, label] of [['http500', 'HTTP 500'], ['html503', 'HTTP 503 with a non-JSON gateway page'], ['stuck', 'report never finishes'], ['hang', 'endpoint hangs']]) {
    test(`Amazon-wide listings failures (${label}) 3 times in a row ARE an outage: the run stops starting clients`, () => {
      const R = runScenario({ clients: clientsOf(8), listMode: { SP01: kind, SP02: kind, SP03: kind } });
      commonInvariants(R);
      assert.ok(R.started.length >= 3 && R.started.length <= 5, 'started=' + R.started.length);
      assert.equal(R.slack.length, 1);
      assert.match(R.slack[0], OUTAGE);
      assert.match(R.slack[0], /Nicht gestartet/);
      for (const n of names(8).slice(R.started.length)) assert.match(R.slack[0], new RegExp(n), n + ' must be listed as not started');
    });
  }

  test('listings report ends FATAL (e.g. a seller without listings in that marketplace): Amazon ANSWERED, so 3 in a row are NOT an outage', () => {
    const R = runScenario({ clients: clientsOf(8), listMode: { SP01: 'fatal', SP02: 'fatal', SP03: 'fatal' } });
    commonInvariants(R);
    assert.equal(R.started.length, 8);
    complete(R, ['SP04', 'SP05', 'SP06', 'SP07', 'SP08']);
    assert.equal(R.slack.length, 1);
    assert.doesNotMatch(R.slack[0], OUTAGE);
    assert.doesNotMatch(R.slack[0], /Nicht gestartet/);
    for (const n of ['Shop01', 'Shop02', 'Shop03']) assert.match(R.bullet(n), /übersprungen/);
  });

  test('creating SQP reports is refused with HTTP 403 (seller without Brand Analytics access): a per-client problem, NOT an outage, never abandoned as a stall', () => {
    const R = runScenario({ clients: clientsOf(8), createMode: { SP01: '403', SP02: '403', SP03: '403' } });
    commonInvariants(R);
    assert.equal(R.started.length, 8, 'access problems of single clients must not stop the run');
    complete(R, ['SP04', 'SP05', 'SP06', 'SP07', 'SP08']);
    assert.equal(R.slack.length, 1);
    assert.doesNotMatch(R.slack[0], OUTAGE);
    assert.doesNotMatch(R.slack[0], /Nicht gestartet/);
    assert.deepEqual(R.abandoned, [], 'an access refusal is not a stall: no ABGEBROCHEN');
    for (const n of ['Shop01', 'Shop02', 'Shop03']) assert.match(R.bullet(n), /15 von 15 Reports fehlgeschlagen/);
  });
});

// =====================================================================================================================================
// Write path of sqp_asin_rows: INSERT BEFORE DELETE (upsert first, stale rows deleted afterwards). Expectations R1..R12 come from the spec, not from the code.
// The mock keeps a STATEFUL sqp_asin_rows table that behaves like PostgREST on Postgres (unique key, 409 on a plain POST of an existing key, on_conflict +
// merge-duplicates upsert, 'cannot affect row a second time' for a duplicate key inside one request, server cap per GET, DELETE needs a filter) and logs
// every request with virtual time and row counts. Slice = selling_partner_id + marketplace_id + asin + report_period + start_date.
// =====================================================================================================================================
const OLD_ISO = '2026-09-01T00:00:00.000Z';
const START_MS = Date.parse('2026-10-28T03:00:00Z');
const asinOf = (ci, i) => 'B0' + String(ci).padStart(3, '0') + String(i).padStart(5, '0'); // client #ci (1-based), ASIN #i
let PERIODS = null;
function periods() { // the (period,start,end) triples a run asks Amazon for (read from the mock's create log, independent of the table)
  if (!PERIODS) { const R = runScenario({ clients: clientsOf(1), bigList: { SP01: 1 } }); commonInvariants(R); PERIODS = Object.values(R.S.sqpPeriods); assert.equal(PERIODS.length, 5, '2 MONTH + 3 WEEK periods'); }
  return PERIODS;
}
const NEW_VALS = (q) => ({ search_query_score: q, search_query_volume: 100 + q, total_query_impression_count: 1000, asin_impression_count: 100, asin_impression_share: 0.1, total_click_count: 100, asin_click_count: 10,
  asin_click_share: 0.1, total_cart_add_count: 10, asin_cart_add_count: 2, asin_cart_add_share: 0.2, total_purchase_count: 5, asin_purchase_count: 1, asin_purchase_share: 0.2, asin_median_purchase_price: 9.99 });
const OLD_VALS = { search_query_score: 99, search_query_volume: 7777, total_query_impression_count: 1, asin_impression_count: 1, asin_impression_share: 0.9, total_click_count: 1, asin_click_count: 1,
  asin_click_share: 0.9, total_cart_add_count: 1, asin_cart_add_count: 1, asin_cart_add_share: 0.9, total_purchase_count: 1, asin_purchase_count: 1, asin_purchase_share: 0.9, asin_median_purchase_price: 1.11 };
const oldRow = (spid, asin, p, sq, over = {}, mkt = MK.DE) => ({ selling_partner_id: spid, marketplace_id: mkt, asin, report_period: p.period, start_date: p.start, end_date: p.end, search_query: sq, ...OLD_VALS, ingested_at: OLD_ISO, ...over });
const expRow = (spid, asin, p, q, over = {}) => ({ selling_partner_id: spid, marketplace_id: MK.DE, asin, report_period: p.period, start_date: p.start, end_date: p.end, search_query: 'query ' + q, ...NEW_VALS(q), ...over });
const sliceKey = (spid, asin, p, mkt = MK.DE) => [spid, mkt, asin, p.period, p.start].join('|');
const rowsOf = (S, spid, asin, p) => S.table.rows.filter((r) => r.selling_partner_id === spid && r.asin === asin && r.report_period === p.period && r.start_date === p.start);
const qsOf = (rows) => rows.map((r) => r.search_query).sort();
const Q123 = ['query 1', 'query 2', 'query 3'];
const tab = (R, spid) => R.S.table.rows.filter((r) => r.selling_partner_id === spid);
const carry = (R) => ({ seed: R.S.table.rows, nextId: R.S.table.nextId });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function expectRow(row, exp, msg) { assert.ok(row, msg + ': row missing'); for (const [k, v] of Object.entries(exp)) assert.deepEqual(row[k], v, `${msg}: column ${k}`); }
const excLines = (R, name) => R.text.filter((s) => new RegExp('^\\s*' + name + ' \\[\\d+/\\d+\\] EXC').test(s));

// Checks of R2 / R3 / R11 on the request log of one run. Returns violation strings (empty = fine).
function analyse(S, { cap = 1000, allowDeleteNoPost = () => false, strictGets = false } = {}) {
  const V = []; const by = new Map(); const ok = (e) => e.status >= 200 && e.status < 300;
  for (const e of S.tlog) {
    if (e.status >= 400 && !e.injected) V.push(`unexpected HTTP ${e.status} on ${e.method} ${e.slice || ''}: ${e.msg}`);
    if (!e.slice) { V.push(`request without a single slice: ${e.method} ${e.kind} #${e.n} ${e.msg || ''}`); continue; }
    if (!by.has(e.slice)) by.set(e.slice, { gets: [], posts: [], dels: [] });
    by.get(e.slice)[e.kind === 'get' ? 'gets' : e.kind === 'post' ? 'posts' : 'dels'].push(e);
  }
  const info = new Map();
  for (const [sl, g] of by) {
    const firstPost = g.posts.length ? g.posts[0].n : Infinity; const newQ = new Set(g.posts.flatMap((p) => p.queries || []));
    const readIds = (before) => new Set(g.gets.filter((x) => x.n < before && ok(x)).flatMap((x) => x.ids || []));
    const oldQ = new Set(g.gets.filter((x) => x.n < firstPost && ok(x)).flatMap((x) => x.queries || []));
    if (g.posts.length && !g.gets.some((x) => x.n < firstPost && ok(x))) V.push(`${sl}: POST without a successful read of the slice before it`);
    for (const d of g.dels) {
      if (g.posts.length) {
        if (!g.posts.some((p) => ok(p) && p.n < d.n && (p.answerT ?? p.t) <= d.t)) V.push(`${sl}: DELETE #${d.n} before the upsert POST had succeeded`);
        if (d.delKind !== 'ids') V.push(`${sl}: DELETE #${d.n} is not an id-list delete (${d.delKind}) although the slice was written`);
      } else {
        if (!allowDeleteNoPost(sl)) V.push(`${sl}: DELETE #${d.n} without any POST for the slice`);
        if (!['ids', 'slice'].includes(d.delKind)) V.push(`${sl}: DELETE #${d.n} has a broad filter (${d.delKind})`);
      }
      if (d.delKind === 'ids') { const rd = readIds(d.n); for (const id of d.reqIds) if (!rd.has(id)) V.push(`${sl}: DELETE #${d.n} targets id ${id} that was not read from the slice before`); }
      if (d.reqIds && d.reqIds.length > 50) V.push(`${sl}: DELETE #${d.n} has ${d.reqIds.length} ids (> 50)`);
      for (const x of d.deleted || []) { if (x.w) V.push(`${sl}: DELETE removed id ${x.id} written by this run`); if (newQ.has(x.sq)) V.push(`${sl}: DELETE removed '${x.sq}' that is part of the new data`); }
    }
    // R11 + R3 bounds
    const total = g.gets.length ? g.gets[0].total : 0; const stale = [...oldQ].filter((q) => !newQ.has(q)).length;
    const maxGets = total === 0 ? 1 : Math.ceil(total / Math.min(cap, 1000)) + 1; // pages + 1 terminating (empty) read; no old rows => 1 read
    if (strictGets && g.gets.length > maxGets) V.push(`${sl}: ${g.gets.length} GETs (max ${maxGets})`);
    if (g.posts.length > 1) V.push(`${sl}: ${g.posts.length} POSTs`);
    if (g.dels.length > Math.ceil(stale / 50)) V.push(`${sl}: ${g.dels.length} DELETEs for ${stale} stale rows (max ${Math.ceil(stale / 50)})`);
    const peak = Math.max(0, ...[...g.gets, ...g.posts, ...g.dels].map((e) => e.sliceAfter || 0)); const union = new Set([...oldQ, ...newQ]).size;
    if (g.posts.some(ok) && peak > union) V.push(`${sl}: slice peak ${peak} > |old u new| ${union}`);
    info.set(sl, { g, peak, union, stale, oldQ, newQ });
  }
  return { V, by, info };
}
const viol = (S, o) => analyse(S, o).V;
const reqsOf = (S, spid, kind) => S.tlog.filter((e) => e.spid === spid && e.kind === kind);

describe('sqp_asin_rows write path: insert before delete (upsert first, then delete only stale rows)', () => {
  test('R1 replace: query 1,2 updated in place with new values and fresh ingested_at, query 3 inserted, stale rows gone, other slices untouched, no unique violation', () => {
    const P = periods(); const A1 = asinOf(1, 1), A2 = asinOf(1, 2); const seed = [];
    for (const p of P) for (const sq of ['query 1', 'query 2', 'stale 1', 'stale 2']) seed.push(oldRow('SP01', A1, p, sq));
    const untouched = [oldRow('SP01', asinOf(1, 99), P[0], 'query 1'), oldRow('SP99', A1, P[0], 'query 1'), oldRow('SP01', A1, { period: 'WEEK', start: '2020-01-05', end: '2020-01-11' }, 'stale 9')];
    seed.push(...untouched);
    const R = runScenario({ clients: clientsOf(1), bigList: { SP01: 2 }, table: { seed } }); commonInvariants(R);
    const idOf = (sq, p) => seed.findIndex((r) => r.asin === A1 && r.report_period === p.period && r.start_date === p.start && r.search_query === sq && r.selling_partner_id === 'SP01') + 1;
    for (const p of P) {
      const rows = rowsOf(R.S, 'SP01', A1, p); assert.deepEqual(qsOf(rows), Q123, 'slice ' + p.start);
      for (let q = 1; q <= 3; q++) { const r = rows.find((x) => x.search_query === 'query ' + q); expectRow(r, expRow('SP01', A1, p, q), `A1 ${p.period} ${p.start} q${q}`); assert.ok(Date.parse(r.ingested_at) >= START_MS, 'fresh ingested_at ' + r.ingested_at); }
      for (const q of [1, 2]) assert.equal(rows.find((x) => x.search_query === 'query ' + q).id, idOf('query ' + q, p), 'updated IN PLACE (same id)');
      assert.ok(rows.find((x) => x.search_query === 'query 3').id > seed.length, 'query 3 newly inserted');
      const r2 = rowsOf(R.S, 'SP01', A2, p); assert.deepEqual(qsOf(r2), Q123);
      const dels = R.S.tlog.filter((e) => e.kind === 'delete' && e.slice === sliceKey('SP01', A1, p));
      assert.equal(dels.length, 1); assert.deepEqual(dels[0].deleted.map((d) => d.sq).sort(), ['stale 1', 'stale 2']);
    }
    for (const u of untouched) { const r = R.S.table.rows.find((x) => same({ ...x, id: 0, _w: undefined }, { ...u, id: 0 })); assert.ok(r, 'unrelated row still there unchanged: ' + u.search_query + ' ' + u.selling_partner_id); assert.ok(!r._w); }
    assert.equal(R.S.table.rows.length, 2 * 5 * 3 + 3);
    assert.deepEqual(viol(R.S), []);
  });

  test('R2 order/targets with slow table requests: no DELETE before that slice\'s POST has been ANSWERED OK; deletes target only ids read before; new queries never deleted', () => {
    const P = periods(); const seed = [];
    for (const p of P) { for (const sq of ['query 1', 'stale 1', 'stale 2', 'stale 3']) seed.push(oldRow('SP01', asinOf(1, 1), p, sq)); for (const sq of ['query 2', 'query 3']) seed.push(oldRow('SP01', asinOf(1, 2), p, sq)); }
    const R = runScenario({ clients: clientsOf(1), bigList: { SP01: 3 }, table: { seed, latencyMs: 5000 } }); commonInvariants(R);
    const A = analyse(R.S); assert.deepEqual(A.V, []);
    assert.ok(R.S.tlog.some((e) => e.kind === 'delete' && e.status === 204), 'scenario must contain deletes');
    for (const p of P) assert.deepEqual(qsOf(rowsOf(R.S, 'SP01', asinOf(1, 1), p)), Q123);
  });

  test('R3 no growth: first full run of 8 clients leaves exactly 675 rows per client; a 2nd run with identical data issues NO delete and the table never changes size', () => {
    const cl = clientsOf(8); const R1 = runScenario({ clients: cl }); commonInvariants(R1); complete(R1, names(8).map(sp));
    for (let i = 1; i <= 8; i++) { const rows = tab(R1, 'SP0' + i); assert.equal(rows.length, FULL_ROWS, 'SP0' + i); }
    assert.equal(R1.S.table.rows.length, 8 * FULL_ROWS); assert.equal(new Set(R1.S.table.rows.map((r) => r.id)).size, 8 * FULL_ROWS);
    assert.deepEqual(viol(R1.S), []); assert.equal(R1.S.tlog.filter((e) => e.kind === 'delete').length, 0, 'nothing to delete on an empty table');
    const R2 = runScenario({ clients: cl, start: '2026-10-28T09:00:00Z', table: carry(R1) }); commonInvariants(R2); complete(R2, names(8).map(sp));
    assert.equal(R2.S.tlog.filter((e) => e.kind === 'delete').length, 0, 'same data => no DELETE at all');
    assert.ok(R2.S.tlog.every((e) => e.rowsAfter === 8 * FULL_ROWS), 'row count constant during the whole run'); assert.equal(R2.S.tpeak, 8 * FULL_ROWS);
    assert.deepEqual(R2.S.table.rows.map((r) => r.id), R1.S.table.rows.map((r) => r.id), 'all rows updated in place');
    assert.deepEqual(viol(R2.S), []);
    assert.equal(R2.S.tlog.filter((e) => e.kind === 'post').length, 8 * 225, 'one POST per slice');
  });

  test('R4 failure safety: every upsert POST of one client fails (HTTP 500) => its old rows are untouched, no DELETE, one EXC per report, run continues, Slack lists the client', () => {
    const P = periods(); const seed = [];
    for (let i = 1; i <= 45; i++) for (const p of P) for (const sq of ['query 1', 'stale 1']) seed.push(oldRow('SP02', asinOf(2, i), p, sq));
    const R = runScenario({ clients: clientsOf(3), table: { seed, faults: [{ method: 'POST', spid: 'SP02' }] } }); commonInvariants(R);
    assert.equal(reqsOf(R.S, 'SP02', 'delete').length, 0, 'no DELETE may be issued when the upsert failed');
    assert.deepEqual(tab(R, 'SP02').map((r) => ({ ...r, _w: undefined })), seed.map((r, i) => ({ ...r, id: i + 1, _w: undefined })), 'old rows byte-identical');
    assert.equal(excLines(R, 'Shop02').length, 15, 'one EXC per failed report');
    assert.ok(!(R.S.rowsPosted.SP02 > 0));
    complete(R, ['SP01', 'SP03']);
    assert.equal(R.slack.length, 1); assert.match(R.bullet('Shop02'), /15 von 15 Reports fehlgeschlagen.*Ausnahmen/);
    assert.deepEqual(viol(R.S).filter((v) => !/unexpected HTTP 500/.test(v)), []);
  });

  test('R5a initial GET of the slice fails => NOTHING is written for the job (no POST, no DELETE), counted as exception', () => {
    const P = periods(); const seed = [];
    for (let i = 1; i <= 3; i++) for (const p of P) for (const sq of ['query 1', 'stale 1']) seed.push(oldRow('SP02', asinOf(2, i), p, sq));
    const R = runScenario({ clients: clientsOf(2), bigList: { SP01: 3, SP02: 3 }, table: { seed, faults: [{ method: 'GET', spid: 'SP02' }] } }); commonInvariants(R);
    assert.equal(reqsOf(R.S, 'SP02', 'post').length, 0); assert.equal(reqsOf(R.S, 'SP02', 'delete').length, 0);
    assert.deepEqual(tab(R, 'SP02').map((r) => ({ ...r, _w: undefined })), seed.map((r, i) => ({ ...r, id: i + 1, _w: undefined })));
    assert.equal(excLines(R, 'Shop02').length, 5); assert.equal(tab(R, 'SP01').length, 3 * 5 * 3);
    assert.equal(R.slack.length, 1); assert.match(R.bullet('Shop02'), /5 von 5 Reports fehlgeschlagen.*Ausnahmen/);
  });

  test('R5b only the stale-row DELETE fails (HTTP 500): new rows in place, job counted as exception; a 2nd run (fault removed) removes the leftovers and ends with exactly the new data', () => {
    const P = periods(); const seed = [];
    for (let i = 1; i <= 3; i++) for (const p of P) for (const sq of ['query 1', 'stale 1', 'stale 2']) seed.push(oldRow('SP02', asinOf(2, i), p, sq));
    const sc = { clients: clientsOf(2), bigList: { SP01: 3, SP02: 3 } };
    const R1 = runScenario({ ...sc, table: { seed, faults: [{ method: 'DELETE', spid: 'SP02' }] } }); commonInvariants(R1);
    assert.ok(reqsOf(R1.S, 'SP02', 'delete').length >= 1, 'DELETE was attempted');
    for (const e of R1.S.tlog.filter((x) => x.kind === 'delete')) { assert.ok(e.injected); const rows = rowsOf(R1.S, 'SP02', e.slice.split('|')[2], { period: e.slice.split('|')[3], start: e.slice.split('|')[4] });
      for (let q = 1; q <= 3; q++) assert.ok(rows.some((r) => r.search_query === 'query ' + q && r.search_query_volume === 100 + q), 'new rows in place for ' + e.slice); assert.ok(rows.some((r) => r.search_query === 'stale 1'), 'stale rows remain (delete failed)'); }
    assert.ok(excLines(R1, 'Shop02').length >= 1); assert.equal(R1.slack.length, 1); assert.match(R1.bullet('Shop02'), /5 von 5 Reports fehlgeschlagen.*Ausnahmen/);
    assert.deepEqual(viol(R1.S).filter((v) => !/unexpected HTTP 500/.test(v)), []);
    const R2 = runScenario({ ...sc, start: '2026-10-28T06:00:00Z', table: carry(R1) }); commonInvariants(R2);
    assert.equal(excLines(R2, 'Shop02').length, 0); assert.equal(R2.slack.length, 0);
    for (const sp_ of ['SP01', 'SP02']) for (let i = 1; i <= 3; i++) for (const p of P) { const ci = +sp_.slice(2); assert.deepEqual(qsOf(rowsOf(R2.S, sp_, asinOf(ci, i), p)), Q123, `${sp_} ${i} ${p.start} after the 2nd run`); }
    assert.equal(R2.S.table.rows.length, 2 * 3 * 5 * 3); assert.deepEqual(viol(R2.S), []);
  });

  test('R6 empty new data (all rows below the volume filter): old rows are deleted without any POST; no old rows => no write at all', () => {
    const P = periods(); const A1 = asinOf(1, 1), A2 = asinOf(1, 2), A3 = asinOf(1, 3); const seed = [];
    for (const p of P) for (const sq of ['query 1', 'stale 1', 'stale 2']) seed.push(oldRow('SP01', A1, p, sq));
    const R = runScenario({ clients: clientsOf(1), bigList: { SP01: 3 }, sqp: { lowVolume: { SP01: [A1, A2] } }, table: { seed } }); commonInvariants(R);
    assert.deepEqual(viol(R.S, { allowDeleteNoPost: (sl) => sl.split('|')[2] === A1 }), []);
    for (const p of P) {
      assert.equal(rowsOf(R.S, 'SP01', A1, p).length, 0, 'A1 slice emptied'); assert.equal(rowsOf(R.S, 'SP01', A2, p).length, 0);
      for (const a of [A1, A2]) assert.equal(R.S.tlog.filter((e) => e.kind === 'post' && e.slice === sliceKey('SP01', a, p)).length, 0, 'no POST for empty data');
      assert.equal(R.S.tlog.filter((e) => e.kind === 'delete' && e.slice === sliceKey('SP01', A2, p)).length, 0, 'no old rows => no DELETE');
      assert.deepEqual(qsOf(rowsOf(R.S, 'SP01', A3, p)), Q123);
      const d = R.S.tlog.filter((e) => e.kind === 'delete' && e.slice === sliceKey('SP01', A1, p)); assert.ok(d.length >= 1); assert.deepEqual(d.flatMap((e) => e.deleted.map((x) => x.sq)).sort(), ['query 1', 'stale 1', 'stale 2']);
    }
    assert.equal(excLines(R, 'Shop01').length, 0);
    // nothing but empty data and an empty table: no write at all
    const E = runScenario({ clients: clientsOf(1), bigList: { SP01: 2 }, sqp: { lowVolume: { SP01: true } } }); commonInvariants(E);
    assert.equal(E.S.tlog.filter((e) => e.kind !== 'get').length, 0, 'no POST/DELETE'); assert.equal(E.S.table.rows.length, 0); assert.equal(excLines(E, 'Shop01').length, 0);
  });

  test('R7 duplicate search_query inside one report batch must not fail: one row per query, the LAST occurrence wins', () => {
    const P = periods(); const A1 = asinOf(1, 1), A2 = asinOf(1, 2); const seed = [];
    for (const p of P) for (const sq of ['query 1', 'stale 1']) seed.push(oldRow('SP01', A1, p, sq));
    const R = runScenario({ clients: clientsOf(1), bigList: { SP01: 2 }, sqp: { dupQuery: true }, table: { seed } }); commonInvariants(R);
    assert.deepEqual(viol(R.S), []); assert.equal(excLines(R, 'Shop01').length, 0); assert.equal(R.slack.length, 0);
    for (const p of P) for (const a of [A1, A2]) { const rows = rowsOf(R.S, 'SP01', a, p); assert.deepEqual(qsOf(rows), Q123, a + ' ' + p.start);
      expectRow(rows.find((r) => r.search_query === 'query 1'), expRow('SP01', a, p, 1, { search_query_score: 9, search_query_volume: 999 }), 'last occurrence of query 1');
      expectRow(rows.find((r) => r.search_query === 'query 2'), expRow('SP01', a, p, 2), 'query 2'); }
    assert.equal(R.S.table.rows.length, 2 * 5 * 3);
  });

  test('R8 ingested_at: updated-in-place rows get a fresh ingested_at (>= run start), untouched rows keep theirs, and the NEXT run orders stalest-first by it', () => {
    const P = periods(); const seed = [];
    for (const p of P) for (const a of [asinOf(1, 1), asinOf(1, 2)]) for (const q of [1, 2, 3]) seed.push(oldRow('SP01', a, p, 'query ' + q));
    const strayOld = oldRow('SP01', asinOf(1, 77), { period: 'WEEK', start: '2020-01-05', end: '2020-01-11' }, 'query 1');
    const stray2 = oldRow('SP02', asinOf(2, 77), { period: 'WEEK', start: '2020-01-05', end: '2020-01-11' }, 'query 1', { ingested_at: '2026-10-10T00:00:00.000Z' });
    seed.push(strayOld, stray2);
    const sc = { clients: clientsOf(2), bigList: { SP01: 2, SP02: 2 } };
    const A = runScenario({ ...sc, table: { seed } }, { SQP_ONLY: 'Shop01' }); commonInvariants(A);
    assert.equal(A.S.tlog.filter((e) => e.kind === 'delete').length, 0, 'pure in-place update, nothing stale');
    for (const r of tab(A, 'SP01')) if (r.asin !== asinOf(1, 77)) { assert.ok(Date.parse(r.ingested_at) >= START_MS, `row ${r.id} ${r.search_query} ingested_at ${r.ingested_at} not refreshed`); assert.ok(r.id <= seed.length, 'updated in place'); }
    assert.equal(tab(A, 'SP01').find((r) => r.asin === asinOf(1, 77)).ingested_at, OLD_ISO, 'untouched row keeps its old ingested_at');
    assert.equal(tab(A, 'SP02')[0].ingested_at, '2026-10-10T00:00:00.000Z');
    const newest = (R, spid) => Math.max(...tab(R, spid).map((r) => Date.parse(r.ingested_at))); assert.ok(newest(A, 'SP01') >= START_MS, 'watchdog: newest ingested_at of SP01 is fresh');
    const B = runScenario({ ...sc, start: '2026-10-28T12:00:00Z', table: carry(A) }); commonInvariants(B);
    assert.deepEqual(B.started, ['Shop02', 'Shop01'], 'Shop01 was just refreshed (fresh ingested_at), Shop02 is older => Shop02 first');
  });

  test('R9 server cap: 1200 old rows in one slice, cap 500 per GET => all ids read page by page, stale ones deleted in batches of <= 50', () => {
    const P = periods(); const A1 = asinOf(1, 1); const seed = [oldRow('SP01', A1, P[0], 'query 1')];
    for (let i = 1; i <= 1199; i++) seed.push(oldRow('SP01', A1, P[0], 'old ' + String(i).padStart(4, '0')));
    const R = runScenario({ clients: clientsOf(1), bigList: { SP01: 1 }, table: { seed, cap: 500 } }); commonInvariants(R);
    const sl = sliceKey('SP01', A1, P[0]); const gets = R.S.tlog.filter((e) => e.kind === 'get' && e.slice === sl);
    assert.deepEqual([...new Set(gets.flatMap((e) => e.ids))].sort((a, b) => a - b), seed.map((_, i) => i + 1), 'all 1200 old ids were read');
    assert.ok(gets.length >= 3 && gets.length <= 4, 'GET pages=' + gets.length); assert.ok(gets[gets.length - 1].returned < 500, 'paged until a short/empty page');
    const dels = R.S.tlog.filter((e) => e.kind === 'delete' && e.slice === sl); assert.ok(dels.every((d) => d.reqIds.length <= 50 && d.status === 204));
    assert.equal(dels.length, 24, 'ceil(1199/50) batches'); assert.deepEqual(dels.flatMap((d) => d.reqIds).sort((a, b) => a - b), seed.map((_, i) => i + 1).slice(1), 'exactly the 1199 stale ids');
    assert.deepEqual(qsOf(rowsOf(R.S, 'SP01', A1, P[0])), Q123); assert.deepEqual(viol(R.S, { cap: 500 }), []);
    assert.ok(R.S.tpeak <= 1200 + 2, 'peak ' + R.S.tpeak);
  });

  test('R10 hard stop (SQP_EXIT_MIN) with slow table requests: never exits between the upsert POST and its stale-row DELETE; no new slice starts after the stop; exit 0', () => {
    const P = periods(); const seed = [];
    for (let i = 1; i <= 3; i++) for (const p of P) for (const sq of ['query 1', 'stale 1', 'stale 2']) seed.push(oldRow('SP01', asinOf(1, i), p, sq));
    let inflight = 0, runs = 0, partial = 0;
    for (const lat of [7000, 13000, 20000, 27000]) for (const exitMin of [0.6, 1, 1.4, 2, 2.6, 3.2, 4, 5, 6.5]) {
      const R = runScenario({ clients: clientsOf(1), bigList: { SP01: 3 }, table: { seed, latencyMs: lat } }, { SQP_EXIT_MIN: String(exitMin), SQP_HARD_MIN: '100', SQP_BUDGET_MIN: '100' });
      const tag = `lat=${lat} exit=${exitMin}`; assert.ok(R.S, tag); assert.equal(R.status, 0, tag + R.stderr); assert.deepEqual(R.S.unmocked, [], tag);
      const stopT = exitMin * 60000; runs++;
      const A = analyse(R.S); assert.deepEqual(A.V, [], tag);
      for (const [sl, g] of A.by) { const first = Math.min(...[...g.gets, ...g.posts, ...g.dels].map((e) => e.t)); const last = Math.max(...[...g.gets, ...g.posts, ...g.dels].map((e) => e.t));
        assert.ok(g.gets[0].t <= stopT, `${tag}: NEW slice sequence ${sl} began at ${g.gets[0].t} after the stop at ${stopT}`);
        if (first <= stopT && last > stopT) inflight++;
        if (g.posts.some((p) => p.status === 201)) { const left = rowsOf(R.S, 'SP01', sl.split('|')[2], { period: sl.split('|')[3], start: sl.split('|')[4] }).filter((r) => /^stale/.test(r.search_query));
          assert.equal(left.length, 0, `${tag}: exited between upsert POST and DELETE of ${sl} (stale rows left)`); partial++; } }
    }
    assert.ok(runs === 36 && inflight > 0 && partial > 0, `sweep must actually hit slices that are in flight at the stop (inflight=${inflight}, written=${partial})`);
  });

  for (const strictGets of [false, true]) test(`R11${strictGets ? '-GET' : ''} requests per ASIN job are bounded: ${strictGets ? '<= pages+1 GETs (1 read per page of old rows + 1 terminating empty read; 1 when there are no old rows)' : '<=1 POST, <=ceil(stale/50) DELETEs'} (130 stale / exact match / no old rows / 1 stale)`, () => {
    const P = periods(); const A = [1, 2, 3, 4].map((i) => asinOf(1, i)); const seed = [];
    for (const p of P) { seed.push(oldRow('SP01', A[0], p, 'query 1')); for (let i = 1; i <= 130; i++) seed.push(oldRow('SP01', A[0], p, 'stale ' + i));
      for (const q of [1, 2, 3]) seed.push(oldRow('SP01', A[1], p, 'query ' + q)); seed.push(oldRow('SP01', A[3], p, 'query 3'), oldRow('SP01', A[3], p, 'stale x')); }
    const R = runScenario({ clients: clientsOf(1), bigList: { SP01: 4 }, table: { seed } }); commonInvariants(R);
    const X = analyse(R.S, { strictGets }); assert.deepEqual(X.V, []);
    for (const p of P) { const n = (a) => { const g = X.by.get(sliceKey('SP01', a, p)); return [strictGets ? g.gets.length : 1, g.posts.length, g.dels.length]; };
      const g2 = strictGets ? 2 : 1; // slices WITH old rows: one page + the terminating empty read (strict mode counts the real reads)
      assert.deepEqual(n(A[0]), [g2, 1, 3]); assert.deepEqual(n(A[1]), [g2, 1, 0]); assert.deepEqual(n(A[2]), [1, 1, 0]); assert.deepEqual(n(A[3]), [g2, 1, 1]);
      for (const a of A) assert.deepEqual(qsOf(rowsOf(R.S, 'SP01', a, p)), Q123); }
  });

  for (const which of [1, 2, 3]) test(`R12 one ASIN's upsert POST fails (ASIN #${which} of the batch, one call): the other ASINs are still written, the failed one keeps its old rows, exactly ONE EXC for that report, run continues`, () => {
    const P = periods(); const A = [1, 2, 3].map((i) => asinOf(1, i)); const bad = A[which - 1]; const seed = [];
    for (const p of P) for (const a of A) for (const sq of ['query 1', 'stale 1']) seed.push(oldRow('SP01', a, p, sq));
    const R = runScenario({ clients: clientsOf(1), bigList: { SP01: 3 }, table: { seed, faults: [{ method: 'POST', spid: 'SP01', asin: bad, nth: 1 }] } }); commonInvariants(R);
    const failed = R.S.tlog.filter((e) => e.kind === 'post' && e.injected); assert.equal(failed.length, 1); const fp = P.find((p) => p.period === failed[0].slice.split('|')[3] && p.start === failed[0].slice.split('|')[4]);
    assert.equal(excLines(R, 'Shop01').length, 1, 'exactly one EXC (one report), not one per ASIN');
    assert.equal(R.S.tlog.filter((e) => e.kind === 'delete' && e.slice === failed[0].slice).length, 0, 'no DELETE for the failed slice');
    assert.deepEqual(qsOf(rowsOf(R.S, 'SP01', bad, fp)), ['query 1', 'stale 1'], 'failed slice keeps its old rows'); assert.ok(rowsOf(R.S, 'SP01', bad, fp).every((r) => same({ ...r, id: 0 }, { ...oldRow('SP01', bad, fp, r.search_query), id: 0 })), 'old rows untouched');
    for (const p of P) for (const a of A) { if (a === bad && p.start === fp.start && p.period === fp.period) continue; assert.deepEqual(qsOf(rowsOf(R.S, 'SP01', a, p)), Q123, `${a} ${p.start} written`); }
    assert.equal(R.S.rowsPosted.SP01, 3 * 5 * 3 - 3, 'rows of the other ASINs of the same report were written');
    assert.deepEqual(viol(R.S).filter((v) => !/unexpected HTTP 500/.test(v)), []);
  });

  test('R12b every report loses one ASIN (POST of the 2nd ASIN always fails): the OTHER ASINs\' rows count in the client\'s row total (Slack: 30 Zeilen), 5 exceptions', () => {
    const P = periods(); const A = [1, 2, 3].map((i) => asinOf(1, i));
    // which ASIN is the 2nd of a batch is not fixed by the spec: fail A2 of the listing (all periods) and expect A1 + A3 rows
    const R = runScenario({ clients: clientsOf(1), bigList: { SP01: 3 }, table: { faults: [{ method: 'POST', spid: 'SP01', asin: A[1] }] } }); commonInvariants(R);
    assert.equal(excLines(R, 'Shop01').length, 5, 'one EXC per report'); assert.equal(R.S.rowsPosted.SP01, 2 * 5 * 3);
    for (const p of P) { assert.deepEqual(qsOf(rowsOf(R.S, 'SP01', A[0], p)), Q123); assert.deepEqual(qsOf(rowsOf(R.S, 'SP01', A[2], p)), Q123); assert.equal(rowsOf(R.S, 'SP01', A[1], p).length, 0); }
    assert.equal(R.slack.length, 1); assert.match(R.bullet('Shop01'), /5 von 5 Reports fehlgeschlagen.*5 Ausnahmen.*30 Zeilen geschrieben/);
  });
});
