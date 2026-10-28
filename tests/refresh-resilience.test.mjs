// Expectations for the resilience of the weekly SQP refresh (refresh.mjs), written from the requirements and NOT fitted to the code.
// Background (26.10.2026): Amazon's Brand Analytics reports stalled, EVERY report of a client waited the full 20 min and timed out,
// 15 reports per client => ~80 min per client, 26 clients => the job was killed by its 5h45m limit after 3 clients, and the
// watchdog saw "no successful run". Required behaviour:
//  - circuit breaker per client: N consecutive timeouts (default 6) with no Amazon answer in between => the client is abandoned.
//    Any answer (rows OR "keine Daten"/FATAL) resets the count. Once tripped it stays tripped.
//  - outage detector: the LAST 3 finished clients were all abandoned AND produced 0 rows => Amazon is down, stop starting clients.
//  - time budget: no NEW client is started once the budget is used up (or on an outage); the reason is reported.
//  - rotation: the client list is rotated left by a deterministic offset (changes weekly) so the same tail clients are not starved.
//  - an abandoned client is ALWAYS a problem in the Slack summary, even if less than half of its reports failed so far.
//  - the Slack summary names failed clients AND clients that were not started, always with the single-client re-run hint, and
//    says so when Amazon looks down; nothing to report => no message.
// Pure functions, deterministic: no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rotateClients, weekIndex, makeBreaker, outageDetected, budgetDecision, buildSlackText, assessClient, staleFirst, ingestKey, numEnv, breakerLimit, finishedEntry, dedupeBySearchQuery, staleIds } from '../refresh.mjs';

const WEEK = 7 * 24 * 3600e3;

// ---- rotation
test('rotateClients: offset 0 keeps the order, a positive offset rotates left, offsets wrap around', () => {
  const a = ['a', 'b', 'c', 'd'];
  assert.deepEqual(rotateClients(a, 0), ['a', 'b', 'c', 'd']);
  assert.deepEqual(rotateClients(a, 1), ['b', 'c', 'd', 'a']);
  assert.deepEqual(rotateClients(a, 3), ['d', 'a', 'b', 'c']);
  assert.deepEqual(rotateClients(a, 4), ['a', 'b', 'c', 'd']);
  assert.deepEqual(rotateClients(a, 5), ['b', 'c', 'd', 'a']);
});
test('rotateClients: never loses, duplicates or mutates anything; empty and single lists are fine', () => {
  const a = Array.from({ length: 26 }, (_, i) => 'c' + i);
  const copy = [...a];
  for (const off of [0, 1, 7, 25, 26, 27, 1000]) {
    const r = rotateClients(a, off);
    assert.equal(r.length, 26);
    assert.deepEqual([...r].sort(), [...a].sort());
  }
  assert.deepEqual(a, copy, 'input must not be mutated');
  assert.deepEqual(rotateClients([], 5), []);
  assert.deepEqual(rotateClients(['x'], 9), ['x']);
});
test('rotateClients: a different week gives a different first client (nobody is permanently last)', () => {
  const a = Array.from({ length: 26 }, (_, i) => 'c' + i);
  const t = Date.parse('2026-10-26T03:00:00Z');
  const first = new Set();
  for (let w = 0; w < 26; w++) first.add(rotateClients(a, weekIndex(t + w * WEEK) * 3)[0]);
  assert.ok(first.size > 4, 'over 26 weeks many different clients must be first, got ' + first.size);
});
test('weekIndex: stable within a week, +1 a week later', () => {
  const t = Date.parse('2026-10-26T03:00:00Z'); // a Monday, mid epoch-week
  assert.equal(weekIndex(t), weekIndex(t + 3600e3));
  assert.equal(weekIndex(t + WEEK), weekIndex(t) + 1);
});

// ---- circuit breaker
test('breaker: not tripped at the start; trips exactly at the limit-th consecutive timeout', () => {
  const b = makeBreaker(4);
  assert.equal(b.tripped, false);
  for (let i = 0; i < 3; i++) b.timeout();
  assert.equal(b.tripped, false);
  b.timeout();
  assert.equal(b.tripped, true);
});
test('breaker: the default limit is 6', () => {
  const b = makeBreaker();
  for (let i = 0; i < 5; i++) b.timeout();
  assert.equal(b.tripped, false);
  b.timeout();
  assert.equal(b.tripped, true);
});
test('breaker: an Amazon answer (rows or "no data") in between resets the count', () => {
  const b = makeBreaker(4);
  b.timeout(); b.timeout(); b.timeout();
  b.answered();
  b.timeout(); b.timeout(); b.timeout();
  assert.equal(b.tripped, false, '3 + 3 timeouts separated by an answer must not trip a limit of 4');
  b.timeout();
  assert.equal(b.tripped, true);
});
test('breaker: once tripped it stays tripped, even if an answer arrives later', () => {
  const b = makeBreaker(2);
  b.timeout(); b.timeout();
  assert.equal(b.tripped, true);
  b.answered();
  assert.equal(b.tripped, true);
});

// ---- outage detector
const ab = (rows = 0) => ({ aborted: true, rows });
const ok = (rows = 100) => ({ aborted: false, rows });
test('outageDetected: needs 3 finished clients', () => {
  assert.equal(outageDetected([]), false);
  assert.equal(outageDetected([ab(), ab()]), false);
});
test('outageDetected: true when the last 3 finished clients were all abandoned with 0 rows', () => {
  assert.equal(outageDetected([ab(), ab(), ab()]), true);
  assert.equal(outageDetected([ok(), ab(), ab(), ab()]), true, 'an earlier success does not hide a later outage');
});
test('outageDetected: false when any of the last 3 produced data or was not abandoned', () => {
  assert.equal(outageDetected([ab(), ab(), ok()]), false);
  assert.equal(outageDetected([ab(), ok(), ab()]), false);
  assert.equal(outageDetected([ab(), ab(), ab(5)]), false, 'abandoned but with rows written is not an outage');
  assert.equal(outageDetected([ab(), ab(), ab(), ok()]), false, 'the last 3 contain a success');
});

// ---- time budget
test('budgetDecision: runs while time is left and Amazon is fine', () => {
  assert.equal(budgetDecision({ elapsedMs: 0, budgetMs: 280 * 60e3, outage: false }), 'run');
  assert.equal(budgetDecision({ elapsedMs: 279 * 60e3, budgetMs: 280 * 60e3, outage: false }), 'run');
});
test('budgetDecision: stops starting clients once the budget is used up', () => {
  assert.equal(budgetDecision({ elapsedMs: 280 * 60e3, budgetMs: 280 * 60e3, outage: false }), 'budget');
  assert.equal(budgetDecision({ elapsedMs: 300 * 60e3, budgetMs: 280 * 60e3, outage: false }), 'budget');
});
test('budgetDecision: an outage stops it at once, even with plenty of time left', () => {
  assert.equal(budgetDecision({ elapsedMs: 10 * 60e3, budgetMs: 280 * 60e3, outage: true }), 'outage');
});

// ---- Slack summary
test('buildSlackText: nothing to report => no message', () => {
  assert.equal(buildSlackText({ problems: [], notStarted: [], outage: false }), null);
});
test('buildSlackText: failed clients are named with their message, plus the single-client re-run hint', () => {
  const t = buildSlackText({ problems: [{ name: 'Gravurtastisch', msg: '9 von 15 Reports fehlgeschlagen' }], notStarted: [], outage: false });
  assert.match(t, /SQP Weekly Refresh/);
  assert.match(t, /Gravurtastisch/);
  assert.match(t, /9 von 15 Reports fehlgeschlagen/);
  assert.match(t, /only_client/);
});
test('buildSlackText: clients that were never started are listed by name', () => {
  const t = buildSlackText({ problems: [], notStarted: ['Alpha GmbH', 'Beta GmbH'], outage: false });
  assert.match(t, /Alpha GmbH/);
  assert.match(t, /Beta GmbH/);
  assert.match(t, /only_client/);
});
test('buildSlackText: an outage is called out as an Amazon problem', () => {
  const t = buildSlackText({ problems: [{ name: 'A', msg: 'x' }], notStarted: ['Z GmbH'], outage: true });
  assert.match(t, /Amazon/);
  assert.match(t, /Z GmbH/);
});

// ---- per-client health (assessClient)
const stats = (over = {}) => ({ total: 15, timeouts: 0, createFails: 0, exc: 0, rows: 500, ...over });
test('assessClient: an ABANDONED client is always a problem, even if under half of its reports timed out', () => {
  const msg = assessClient(stats({ timeouts: 6, rows: 0, aborted: true, skipped: 9 }));
  assert.ok(msg, 'must report the abandoned client');
  assert.match(msg, /abgebrochen/i);
});
test('assessClient: unchanged behaviour for clients that were not abandoned', () => {
  assert.equal(assessClient(stats({ timeouts: 2 })), null, 'under half failed => fine');
  assert.ok(assessClient(stats({ timeouts: 8, rows: 0 })), 'half or more failed => problem');
  assert.equal(assessClient(null), null);
  assert.equal(assessClient({ total: 0, timeouts: 0, createFails: 0, exc: 0, rows: 0 }), null);
});

// ---- review round 1 additions (28.10.): written from the requirements before the code was changed
//  - clients are ordered STALEST-FIRST (oldest newest-ingest first; never-ingested first of all; ties keep their order) so a bad week
//    cannot starve the same clients again and again (the watchdog flags a client after 9 days without new SQP rows);
//  - the rotation remains the fallback and must also cope with negative offsets;
//  - the outage window is a parameter; budget vs outage precedence; the 'deadline' wording of an abandoned client.
const C = (spid, mp = 'DE', name = spid) => ({ spid, marketplace: mp, name });
test('ingestKey: one key per seller + marketplace, marketplace case-insensitive, default DE', () => {
  assert.equal(ingestKey(C('A1', 'de')), ingestKey(C('A1', 'DE')));
  assert.equal(ingestKey(C('A1', undefined)), ingestKey(C('A1', 'DE')));
  assert.notEqual(ingestKey(C('A1', 'DE')), ingestKey(C('A1', 'FR')));
  assert.notEqual(ingestKey(C('A1', 'DE')), ingestKey(C('A2', 'DE')));
});
test('staleFirst: oldest newest-ingest first, never-ingested clients before all others', () => {
  const [a, b, c, d] = [C('A'), C('B'), C('C'), C('D')];
  const last = { [ingestKey(a)]: 3000, [ingestKey(b)]: 1000, [ingestKey(c)]: 2000 }; // d never ingested
  assert.deepEqual(staleFirst([a, b, c, d], last).map(x => x.spid), ['D', 'B', 'C', 'A']);
});
test('staleFirst: ties keep the original order; nothing lost, duplicated or mutated', () => {
  const cl = Array.from({ length: 10 }, (_, i) => C('S' + i));
  const copy = cl.map(x => x.spid);
  const out = staleFirst(cl, {});
  assert.deepEqual(out.map(x => x.spid), copy, 'no data at all => original order');
  assert.deepEqual(cl.map(x => x.spid), copy, 'input not mutated');
  const same = Object.fromEntries(cl.map(x => [ingestKey(x), 5000]));
  assert.deepEqual(staleFirst(cl, same).map(x => x.spid), copy, 'equal timestamps => original order');
  assert.equal(new Set(staleFirst(cl, same).map(x => x.spid)).size, 10);
});
test('staleFirst: the same seller in two marketplaces is ordered by its own marketplace data', () => {
  const de = C('A', 'DE', 'A-DE'), fr = C('A', 'FR', 'A-FR');
  const last = { [ingestKey(de)]: 9000, [ingestKey(fr)]: 1000 };
  assert.deepEqual(staleFirst([de, fr], last).map(x => x.name), ['A-FR', 'A-DE']);
});
test('rotateClients: negative offsets rotate right and still keep every client once', () => {
  assert.deepEqual(rotateClients(['a', 'b', 'c', 'd'], -1), ['d', 'a', 'b', 'c']);
  assert.deepEqual(rotateClients(['a', 'b', 'c', 'd'], -4), ['a', 'b', 'c', 'd']);
});
test('outageDetected: the window size is a parameter', () => {
  assert.equal(outageDetected([ab(), ab()], 2), true);
  assert.equal(outageDetected([ab(), ab()], 3), false);
  assert.equal(outageDetected([ok(), ab(), ab(), ab(), ab()], 4), true);
});
test('budgetDecision: when both apply, the more specific reason (outage) wins', () => {
  assert.equal(budgetDecision({ elapsedMs: 999 * 60e3, budgetMs: 250 * 60e3, outage: true }), 'outage');
});
test('assessClient: a client cut off by the run deadline is described as such (not as consecutive timeouts)', () => {
  const msg = assessClient(stats({ timeouts: 1, rows: 120, aborted: true, reason: 'deadline', skipped: 7 }));
  assert.match(msg, /abgebrochen/i);
  assert.match(msg, /Zeitlimit/i);
  assert.ok(!/in Folge/i.test(msg), 'must not claim consecutive timeouts when the cause was the deadline');
});
test('assessClient: a breaker-abandoned client does not claim a wrong number of consecutive timeouts', () => {
  const msg = assessClient(stats({ timeouts: 8, rows: 0, aborted: true, reason: 'breaker', skipped: 7 }));
  assert.match(msg, /abgebrochen/i);
  assert.ok(!/nach 8 Timeouts in Folge/i.test(msg), 'timeouts is a total, not a consecutive count');
});
test('assessClient: a client that ran ALL its reports is not "abandoned" even if the breaker tripped on the last ones', () => {
  // skipped = 0 and aborted = false: the normal 50% rule applies
  assert.equal(assessClient(stats({ timeouts: 3, aborted: false, skipped: 0 })), null);
});
test('buildSlackText: clients that were skipped early (no token, listing failed) show up as problems', () => {
  const t = buildSlackText({ problems: [{ name: 'Kunde X', msg: 'übersprungen: kein SP-API-Token' }], notStarted: [], outage: false });
  assert.match(t, /Kunde X/);
  assert.match(t, /kein SP-API-Token/);
});

// ---- review round 2 additions (28.10.): written from the requirements before the code was changed
//  - a client cut off by the run DEADLINE is not evidence of an Amazon outage (only breaker-abandoned clients are);
//  - the outage message must be specific (not just any text containing "Amazon");
//  - a run that only ran out of time has its own (budget) wording;
//  - timestamps that are not finite numbers (NaN) count as "unknown" and must not break the ordering.
test('outageDetected: clients cut off by the run deadline are NOT an Amazon outage', () => {
  const dl = () => ({ aborted: true, rows: 0, reason: 'deadline' });
  const br = () => ({ aborted: true, rows: 0, reason: 'breaker' });
  assert.equal(outageDetected([dl(), dl(), dl()]), false);
  assert.equal(outageDetected([br(), dl(), br()]), false, 'one deadline cut inside the window means no proven outage');
  assert.equal(outageDetected([br(), br(), br()]), true);
});
test('buildSlackText: the outage text says Amazon delivers no SQP reports; a normal problem text does not claim that', () => {
  const out = buildSlackText({ problems: [{ name: 'A', msg: 'x' }], notStarted: [], outage: true });
  assert.match(out, /keine SQP-Reports/);
  const normal = buildSlackText({ problems: [{ name: 'A', msg: 'x' }], notStarted: [], outage: false });
  assert.ok(!/keine SQP-Reports/.test(normal), 'must not claim an outage when there was none');
});
test('buildSlackText: a run that only ran out of time says so', () => {
  const t = buildSlackText({ problems: [], notStarted: ['X GmbH'], outage: false });
  assert.match(t, /Zeitbudget/);
  assert.ok(!/keine SQP-Reports/.test(t));
});
test('staleFirst: non-finite timestamps (NaN, Infinity) count as unknown: they come first, in the original order, before real timestamps', () => {
  const a = C('A'), b = C('B'), c = C('C');
  const last = { [ingestKey(a)]: NaN, [ingestKey(b)]: 5000, [ingestKey(c)]: Infinity };
  assert.deepEqual(staleFirst([b, c, a], last).map(x => x.spid), ['C', 'A', 'B']);
  assert.deepEqual(staleFirst([a, b, c], last).map(x => x.spid), ['A', 'C', 'B']);
});

// ---- review round 3 additions (28.10.): written from the requirements before the code was changed
//  - a numeric setting (SQP_BREAKER, SQP_BUDGET_MIN, SQP_HARD_MIN, SQP_EXIT_MIN) that is missing, empty, not a number, zero or negative
//    must fall back to its default; a typo must never make the run stop at minute 0.
test('numEnv: valid positive numbers are used (also as text)', () => {
  assert.equal(numEnv('12', 6), 12);
  assert.equal(numEnv(12, 6), 12);
  assert.equal(numEnv('0.5', 6), 0.5);
});
test('numEnv: missing, empty, garbage, zero, negative or non-finite values fall back to the default', () => {
  for (const bad of [undefined, null, '', ' ', 'abc', '12abc', '0', 0, '-5', -1, 'NaN', 'Infinity', NaN, Infinity]) {
    assert.equal(numEnv(bad, 300), 300, 'bad value ' + String(bad));
  }
});
test('assessClient: an abandoned client whose breaker was fed by failed creates does not claim "0 reports without an Amazon answer"', () => {
  const msg = assessClient(stats({ timeouts: 0, createFails: 6, rows: 0, aborted: true, reason: 'breaker', skipped: 9 }));
  assert.match(msg, /abgebrochen/i);
  assert.ok(!/0 Reports ohne Amazon-Antwort/.test(msg), msg);
});

// ---- review round 4 additions (28.10.): written from the requirements before the code was changed
//  - the breaker limit is a whole number >= 1; fractions are floored; anything below 1 or garbage => default 6 (a typo must not abandon
//    every client after a single timeout);
//  - what the outage detector sees for a finished client (finishedEntry): an abandoned client keeps its reason; a SMALL client (fewer
//    reports than the breaker limit, so the breaker can never trip) that timed out completely and never got ANY answer from Amazon
//    (rows or "keine Daten") counts as dead; one that got at least one answer, or wrote rows, does not.
test('breakerLimit: whole numbers >= 1 are used, fractions floored, everything else => 6', () => {
  assert.equal(breakerLimit('2'), 2);
  assert.equal(breakerLimit('8'), 8);
  assert.equal(breakerLimit('1.5'), 1);
  assert.equal(breakerLimit('0.5'), 6);
  for (const bad of [undefined, '', 'abc', '0', '-3', 'NaN']) assert.equal(breakerLimit(bad), 6, 'bad value ' + String(bad));
});
const S = (o = {}) => ({ total: 5, timeouts: 0, createFails: 0, exc: 0, rows: 0, answered: 0, aborted: false, skipped: 0, reason: null, ...o });
test('finishedEntry: an abandoned client keeps its reason and rows', () => {
  const e = finishedEntry(S({ aborted: true, reason: 'deadline', rows: 0, total: 15, timeouts: 3 }), 6);
  assert.equal(e.aborted, true); assert.equal(e.reason, 'deadline'); assert.equal(e.rows, 0);
  const b = finishedEntry(S({ aborted: true, reason: 'breaker', rows: 0, total: 15, timeouts: 8 }), 6);
  assert.equal(b.aborted, true); assert.equal(b.reason, 'breaker');
});
test('finishedEntry: a small client that timed out completely without any Amazon answer counts as dead (breaker could never trip)', () => {
  const e = finishedEntry(S({ total: 5, timeouts: 5, answered: 0, rows: 0 }), 6);
  assert.equal(e.aborted, true); assert.equal(e.reason, 'breaker'); assert.equal(e.rows, 0);
});
test('finishedEntry: a small client that got any answer or wrote rows is NOT dead', () => {
  assert.equal(finishedEntry(S({ total: 5, timeouts: 3, answered: 2, rows: 0 }), 6).aborted, false, 'FATAL ("keine Daten") answers prove Amazon is alive');
  assert.equal(finishedEntry(S({ total: 5, timeouts: 5, answered: 1, rows: 40 }), 6).aborted, false);
});
test('finishedEntry: a healthy client is not dead', () => {
  const e = finishedEntry(S({ total: 15, timeouts: 2, answered: 13, rows: 900 }), 6);
  assert.equal(e.aborted, false); assert.equal(e.rows, 900);
});
test('finishedEntry + outageDetected: three small fully-timed-out clients are an outage; with one answered client in between they are not', () => {
  const dead = () => finishedEntry(S({ total: 5, timeouts: 5 }), 6);
  const alive = () => finishedEntry(S({ total: 5, timeouts: 4, answered: 1 }), 6);
  assert.equal(outageDetected([dead(), dead(), dead()]), true);
  assert.equal(outageDetected([dead(), alive(), dead()]), false);
});

// ---- insert-before-delete for sqp_asin_rows (28.10.2026; project rule: replace operations insert FIRST, delete SECOND) ----
// sqp_asin_rows has UNIQUE(selling_partner_id, marketplace_id, asin, report_period, start_date, search_query), so new rows cannot be inserted
// next to old ones; the replace is: read the old rows of the slice (id + search_query) FIRST, upsert the new rows (same search_query is
// updated in place), and only afterwards delete the OLD rows whose search_query no longer exists in the new data (by their previously read id).
// A batch must not contain the same search_query twice (an upsert cannot touch one row twice).
test('dedupeBySearchQuery: one row per search_query, the LAST occurrence wins, first-appearance order kept, input untouched', () => {
  const rows = [{ search_query: 'a', v: 1 }, { search_query: 'b', v: 2 }, { search_query: 'a', v: 3 }];
  const copy = JSON.parse(JSON.stringify(rows));
  assert.deepEqual(dedupeBySearchQuery(rows), [{ search_query: 'a', v: 3 }, { search_query: 'b', v: 2 }]);
  assert.deepEqual(rows, copy, 'input must not be mutated');
  assert.deepEqual(dedupeBySearchQuery([]), []);
});
test('staleIds: the ids of OLD rows whose search_query is not in the new data, and nothing else', () => {
  const old = [{ id: 1, search_query: 'a' }, { id: 2, search_query: 'b' }, { id: 3, search_query: 'c' }];
  assert.deepEqual(staleIds(old, [{ search_query: 'a' }, { search_query: 'c' }, { search_query: 'd' }]), [2]);
  assert.deepEqual(staleIds(old, [{ search_query: 'a' }, { search_query: 'b' }, { search_query: 'c' }]), [], 'identical sets: nothing to delete');
  assert.deepEqual(staleIds([], [{ search_query: 'a' }]), [], 'nothing old: nothing to delete');
});
test('staleIds: empty new data replaces the slice with nothing (same as before): every old id is stale', () => {
  const old = [{ id: 7, search_query: 'x' }, { id: 8, search_query: 'y' }];
  assert.deepEqual(staleIds(old, []), [7, 8]);
});
