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

for (const [wf, steps] of Object.entries(GROUPS)) {
  test(`${wf}: watched in exactly one place (WF_FRIST on GitHub OR all its steps in SERVER_JOBS), never both, never neither`, () => {
    const onGithub = WF.includes(wf);
    const inServer = steps.filter((s) => s in SERVER_JOBS);
    if (onGithub) assert.equal(inServer.length, 0, `${wf} is still in WF_FRIST but ${inServer.join(', ')} are already in SERVER_JOBS`);
    else assert.deepEqual(inServer.sort(), [...steps].sort(), `${wf} left WF_FRIST but not every step is in SERVER_JOBS`);
  });
}
