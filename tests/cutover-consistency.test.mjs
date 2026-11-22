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

for (const [wf, steps] of Object.entries(GROUPS)) {
  test(`${wf}: watched in exactly one place (WF_FRIST on GitHub OR all its steps in SERVER_JOBS), never both, never neither`, () => {
    const onGithub = WF.includes(wf);
    const inServer = steps.filter((s) => s in SERVER_JOBS);
    if (onGithub) assert.equal(inServer.length, 0, `${wf} is still in WF_FRIST but ${inServer.join(', ')} are already in SERVER_JOBS`);
    else assert.deepEqual(inServer.sort(), [...steps].sort(), `${wf} left WF_FRIST but not every step is in SERVER_JOBS`);
  });
}
