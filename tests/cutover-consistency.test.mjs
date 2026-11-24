// Cutover consistency (validator finding 2026-11-21): when a group of GitHub workflows moves to the server, the SAME commit must
// (a) list EVERY step of that group in SERVER_JOBS (server-job-alerts.mjs) and (b) remove the workflow from WF_FRIST (watchdog.mjs).
// Otherwise the watchdog raises a false "no successful run in 30 h" about 30 h after the workflow stops, or nothing watches the server step.
// Intended behaviour (written before the cutover): at every moment each group is watched in exactly ONE place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_JOBS } from '../server-job-alerts.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const wd = fs.readFileSync(path.join(root, 'watchdog.mjs'), 'utf8');
const frist = wd.match(/const WF_FRIST = \{([^}]*)\}/)[1];
const WF = [...frist.matchAll(/'([\w-]+\.yml)'/g)].map((m) => m[1]);
const GROUPS = { 'vendor.yml': ['vendor/sales', 'vendor/ads'], 'ads.yml': ['ads/refresh', 'ads/periodic'], 'daily-data.yml': ['daily-data/audit', 'daily-data/sales-traffic'] };

// All-or-nothing (review 2026-11-21): the night chain is ONE systemd run, so the three workflows leave GitHub together, never one by one.
// audit-terms (its GitHub workflow is already disabled in the UI, it has no WF_FRIST entry) and the chain marker night/chain belong to the same cutover.
const NIGHT_JOBS = [...Object.values(GROUPS).flat(), 'audit-terms', 'night/chain'];
test('the night chain moves as a whole: either ALL three workflows are still in WF_FRIST and NO night job is in SERVER_JOBS, or none is in WF_FRIST and ALL eight night jobs (incl. audit-terms and night/chain) are', () => {
  const onGithub = Object.keys(GROUPS).filter((w) => WF.includes(w));
  const inServer = NIGHT_JOBS.filter((j) => j in SERVER_JOBS);
  if (onGithub.length === Object.keys(GROUPS).length) assert.deepEqual(inServer, [], 'GitHub still owns the workflows but SERVER_JOBS already has: ' + inServer.join(', '));
  else {
    assert.equal(onGithub.length, 0, 'only part of the chain left GitHub: still on GitHub = ' + onGithub.join(', '));
    assert.deepEqual(inServer.sort(), [...NIGHT_JOBS].sort(), 'every night job (incl. audit-terms, night/chain) must be in SERVER_JOBS');
  }
});

// The weekly SQP refresh moves on its own (a separate, later cutover, 2026-11-24 plan): refresh.yml leaves WF_FRIST in the SAME commit that adds both of its
// steps to SERVER_JOBS. Never both, never neither.
const WEEKLY = { 'refresh.yml': ['refresh/refresh', 'refresh/asin-meta'] };
for (const [wf, steps] of Object.entries(WEEKLY)) {
  test(`${wf} (weekly): watched in exactly one place (WF_FRIST on GitHub OR both steps in SERVER_JOBS), never both, never neither`, () => {
    const onGithub = WF.includes(wf);
    const inServer = steps.filter((s) => s in SERVER_JOBS);
    if (onGithub) assert.equal(inServer.length, 0, `${wf} is still in WF_FRIST but ${inServer.join(', ')} are already in SERVER_JOBS`);
    else assert.deepEqual(inServer.sort(), [...steps].sort(), `${wf} left WF_FRIST but not every step is in SERVER_JOBS`);
  });
}

// Once the weekly jobs are watched on the server, their activation date must be sane (reviewer, 2026-11-24): `seit` = the first scheduled start, i.e. a MONDAY
// 03:00:00 UTC (a past date or another time would raise a false "noch kein Lauf" alert after seit + graceH; a far-future date would silence the watchdog), and the
// deadline must cover a weekly cadence (168 h) plus the run itself (<= ~6 h) with a margin, but not be so long that a missed week goes unnoticed for more than ~9 days.
for (const job of WEEKLY['refresh.yml']) {
  test(`${job}: if watched on the server, seit is a Monday 03:00:00 UTC and fristH is between 176 and 216 hours`, (t) => {
    const c = SERVER_JOBS[job];
    if (!c) return t.skip('not on the server yet');
    const d = new Date(c.seit);
    // Not in the past relative to the plan: the first Monday after the plan date (24 Nov 2026) is 30 Nov 03:00 UTC. A `seit` before that (e.g. 23 Nov) would raise a
    // false "noch kein Lauf auf dem Server gemeldet" alert after seit + graceH although the first server run has not happened yet. If the cutover slips, `seit` only
    // moves LATER, so this floor stays valid. Upper bound: at most two weeks after the date the test runs (i.e. the commit date): a far-future seit (a typo like 2027)
    // would silence the watchdog for the weekly refresh, but a legitimate slip of the cutover by weeks must not turn a correct commit red (reviewer, round 4). It only
    // loosens as time passes, so it cannot become a time bomb.
    const FLOOR = Date.parse('2026-11-30T03:00:00Z');
    assert.ok(d.getTime() >= FLOOR, `${job}: seit ${c.seit} is before the first planned server run (2026-11-30T03:00:00Z)`);
    assert.ok(d.getTime() <= Date.now() + 14 * 86400e3, `${job}: seit ${c.seit} is more than 14 days after today — the watchdog would stay silent too long (typo?)`);
    assert.equal(d.getUTCDay(), 1, `${job}: seit ${c.seit} is not a Monday`);
    assert.equal(d.toISOString().slice(11), '03:00:00.000Z', `${job}: seit ${c.seit} is not 03:00:00 UTC`);
    assert.ok(c.fristH >= 176 && c.fristH <= 216, `${job}: fristH ${c.fristH} outside 176-216`);
  });
}

for (const [wf, steps] of Object.entries(GROUPS)) {
  test(`${wf}: watched in exactly one place (WF_FRIST on GitHub OR all its steps in SERVER_JOBS), never both, never neither`, () => {
    const onGithub = WF.includes(wf);
    const inServer = steps.filter((s) => s in SERVER_JOBS);
    if (onGithub) assert.equal(inServer.length, 0, `${wf} is still in WF_FRIST but ${inServer.join(', ')} are already in SERVER_JOBS`);
    else assert.deepEqual(inServer.sort(), [...steps].sort(), `${wf} left WF_FRIST but not every step is in SERVER_JOBS`);
  });
}
