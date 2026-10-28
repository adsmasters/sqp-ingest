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
// SAFETY: refresh.mjs only talks to the fake; no live campaign / ad endpoint exists in this script or in the mock.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const MOCK = 'mock-net-refresh.mjs'; // sibling of this file (rename here when it is copied under another name)
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
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(here, MOCK)).href, path.join(root, 'refresh.mjs'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SPAPI_CLIENT_ID: 'fake-id', SPAPI_CLIENT_SECRET: 'fake-secret',
      SUPABASE_URL: 'https://fake-supabase.test', SUPABASE_SERVICE_KEY: 'fake-key', SLACK_WEBHOOK_URL: 'https://fake-slack.test/hook',
      FAKE_SCEN: JSON.stringify(scen), FAKE_SUMMARY: summary, ...env },
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
