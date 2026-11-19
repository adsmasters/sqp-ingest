// Night-window schedule (decided 2026-11-18 after the shared Supabase database — 1 GB memory, 26 GB data — became "Unhealthy" while the
// agency team worked). Intended behaviour, written BEFORE the change:
//  - The heavy DAILY data jobs run one after another in the night, OUTSIDE the team's working hours (about 07:00-17:00 UTC = 08:00-18:00 German
//    time), never overlap each other, and are finished before 05:00 UTC.
//  - The watchdog does not run during the team's working hours.
//  - The server's worker (daemon) does not start the ads job on its own by default: GitHub's single nightly run is the one owner
//    (two runs at once were the likely extra load, and the ads tables are what the small database cannot carry).
//  - The weekly SQP refresh stays on Monday 03:00 UTC: it only touches small tables and waits mostly for Amazon, and moving it earlier
//    could make it run before Amazon has published the week.
// Typical worst-case durations (minutes) come from recent GitHub runs: vendor <= 90, ads <= 240 (normal 2-4 h), daily-data <= 180,
// audit-terms (server timer) <= 55.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonAdsAllowed } from '../daemon-policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const wf = (name) => fs.readFileSync(path.join(here, '..', '.github', 'workflows', name), 'utf8');
// first cron of a workflow: { min, hours: [..], dow }
function cron(name) {
  const m = wf(name).match(/^\s*-\s*cron:\s*'([^']+)'/m);
  assert.ok(m, 'no cron found in ' + name);
  const [min, hour, , , dow] = m[1].trim().split(/\s+/);
  return { min: +min, hours: hour.split(',').map(Number), dow };
}
const TEAM_START = 7 * 60, TEAM_END = 17 * 60;  // minutes of the UTC day
const NIGHT_LEN = 11 * 60;                       // the night axis runs 18:00 -> 05:00 UTC = 660 minutes
const axis = (hour, min) => ((hour * 60 + min) - 18 * 60 + 1440) % 1440; // minutes after 18:00 UTC
const DAILY = [
  { name: 'vendor', start: () => { const c = cron('vendor.yml'); return axis(c.hours[0], c.min); }, minutes: 90 },
  { name: 'ads', start: () => { const c = cron('ads.yml'); return axis(c.hours[0], c.min); }, minutes: 240 },
  { name: 'audit-terms (server timer 00:30 UTC)', start: () => axis(0, 30), minutes: 75 }, // first nights: 52 min, then 73 min
  { name: 'daily-data', start: () => { const c = cron('daily-data.yml'); return axis(c.hours[0], c.min); }, minutes: 180 },
];

describe('night-window schedule', () => {
  test('every daily heavy job starts after the team has finished (>= 18:00 UTC) and is done by 05:00 UTC even in the worst case', () => {
    for (const j of DAILY) {
      const s = j.start();
      assert.ok(s < NIGHT_LEN, `${j.name} starts outside the night window (${s} min after 18:00 UTC)`);
      assert.ok(s + j.minutes <= NIGHT_LEN, `${j.name} could still be running after 05:00 UTC (ends ${s + j.minutes} min after 18:00 UTC, limit ${NIGHT_LEN})`);
    }
  });

  test('the heavy daily jobs never overlap each other (they run one after another)', () => {
    const jobs = DAILY.map((j) => ({ name: j.name, s: j.start(), e: j.start() + j.minutes })).sort((a, b) => a.s - b.s);
    for (let i = 1; i < jobs.length; i++) assert.ok(jobs[i].s >= jobs[i - 1].e, `${jobs[i - 1].name} (ends ${jobs[i - 1].e}) overlaps ${jobs[i].name} (starts ${jobs[i].s})`);
  });

  test("the watchdog does not run during the team's working hours (07:00-17:00 UTC)", () => {
    const c = cron('watchdog.yml');
    for (const h of c.hours) {
      const t = h * 60 + c.min;
      assert.ok(t < TEAM_START || t >= TEAM_END, `watchdog runs at ${h}:${c.min} UTC, inside working hours`);
    }
  });

  test('the weekly SQP refresh stays on Monday 03:00 UTC (small tables, depends on when Amazon publishes the week)', () => {
    const c = cron('refresh.yml');
    assert.equal(c.dow, '1');
    assert.deepEqual(c.hours, [3]);
    assert.equal(c.min, 0);
  });

  test('the server worker does NOT start the ads job on its own by default (GitHub nightly run is the single owner)', () => {
    assert.equal(daemonAdsAllowed({}), false);
    assert.equal(daemonAdsAllowed({ DAEMON_ADS: '0' }), false);
    assert.equal(daemonAdsAllowed({ DAEMON_ADS: '' }), false);
  });

  test('the nightly ads run loads at least 4 months and 3 weeks, like the server worker did, so a newly onboarded client still gets its full ads history', () => {
    const m = wf('ads.yml').match(/run:\s*node ads-periodic\.mjs\s+(\d+)\s+(\d+)/);
    assert.ok(m, 'ads-periodic call not found in ads.yml');
    assert.ok(+m[1] >= 4, `months argument is ${m[1]}, must be >= 4`);
    assert.ok(+m[2] >= 3, `weeks argument is ${m[2]}, must be >= 3`);
  });

  test('the server worker can be allowed to run ads again with an explicit switch (DAEMON_ADS=1)', () => {
    assert.equal(daemonAdsAllowed({ DAEMON_ADS: '1' }), true);
  });
});
