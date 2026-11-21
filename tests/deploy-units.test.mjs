// The server's systemd units and the wrapper live in git (deploy/), so every change is reviewed and the server only needs `git pull` + copy.
// Intended behaviour (written before the files, 2026-11-21; reworked the same day after the owner pointed out that one small server runs jobs one
// after another and the night might not end before the team starts):
//  - ONE chained night run (sqp-night.service, timer 18:00 UTC) runs every step back to back, with no idle gaps: vendor, ads, audit-terms, daily-data;
//  - measured durations from real GitHub runs (vendor 52, ads 238, audit-terms 73, daily-data audit 155 + sales 16 min, worst observed) added up must
//    end well before the cut-off (04:00 UTC) and the team start (07:00 UTC);
//  - a step that would START after the cut-off is skipped and reported (NIGHT_GUARD=1 in the night unit), never run into working hours;
//  - every step runs through deploy/server-job.sh (lock so heavy steps take turns on the 1-CPU server, hard timeout, one report row per step);
//  - a failed step must not skip the next one (the workflows used `if: always()`): ExecStart lines start with "-";
//  - the same commands, arguments and environment the workflows used (ads-periodic 4 3, AUDIT_* and TERMS_* settings);
//  - single-job services (sqp-vendor, sqp-ads, sqp-daily-data) exist for MANUAL runs and tests: no timer (no double scheduling), guard off;
//  - no Slack secret anywhere on the server, a memory cap on every service.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const depPath = (p) => path.join(here, '..', 'deploy', p);
const dep = (p) => fs.readFileSync(depPath(p), 'utf8');
const unit = (name) => dep('systemd/' + name);
const steps = (svc) => [...svc.matchAll(/^ExecStart=(-?)\/usr\/bin\/bash\s+(\S+)\s+(\S+)\s+(\d+)\s+(.+)$/gm)].map((m) => ({ dash: m[1] === '-', wrapper: m[2], job: m[3], minutes: +m[4], cmd: m[5].trim() }));

const VENDOR = [['vendor/sales', 'vendor-sales.mjs'], ['vendor/ads', 'vendor-ads.mjs']];
const ADS = [['ads/refresh', 'ads-refresh.mjs'], ['ads/periodic', 'ads-periodic.mjs 4 3']];
const AUDIT = [['audit-terms', 'audit-terms-refresh.mjs 30']];
const DAILY = [['daily-data/audit', 'audit-refresh.mjs 30'], ['daily-data/sales-traffic', 'sales-traffic.mjs 30']];
const SERVICES = [
  { file: 'sqp-vendor', steps: VENDOR, manual: true },
  { file: 'sqp-ads', steps: ADS, manual: true },
  { file: 'sqp-daily-data', steps: DAILY, manual: true },
  { file: 'sqp-audit-terms', steps: AUDIT, timer: '00:30:00' }, // standalone until the night chain takes over (then its timer is disabled)
  { file: 'sqp-night', steps: [...VENDOR, ...ADS, ...AUDIT, ...DAILY], timer: '18:00:00', guard: true },
];

describe('deploy/systemd units', () => {
  for (const s of SERVICES) {
    test(`${s.file}: oneshot service, the agreed steps in order, each through the wrapper, a failed step does not skip the next`, () => {
      const v = unit(s.file + '.service');
      assert.match(v, /Type=oneshot/);
      assert.match(v, /EnvironmentFile=\/opt\/sqp-ingest\/\.env/);
      assert.match(v, /MemoryMax=\d+M/);
      assert.equal((v.match(/^ExecStart=/gm) || []).length, s.steps.length);
      assert.equal(steps(v).length, s.steps.length, 'every ExecStart must go through /usr/bin/bash + the wrapper (independent of the executable bit, which git on Windows loses)');
      const st = steps(v);
      assert.deepEqual(st.map((x) => [x.job, x.cmd]), s.steps);
      for (const x of st) {
        assert.equal(x.wrapper, '/opt/sqp-ingest/deploy/server-job.sh');
        assert.ok(x.dash, `${x.job}: ExecStart must start with "-" so the next step still runs`);
        assert.ok(x.minutes > 0 && x.minutes <= 300, `${x.job}: unreasonable timeout ${x.minutes}`);
      }
    });
    test(`${s.file}: no Slack secret on the server`, () => {
      assert.ok(!/SLACK/i.test(unit(s.file + '.service')));
    });
    if (s.timer) {
      test(`${s.file}: timer at ${s.timer} UTC`, () => {
        const t = unit(s.file + '.timer');
        assert.match(t, new RegExp('OnCalendar=\\*-\\*-\\* ' + s.timer + ' UTC'));
        assert.match(t, /Persistent=false/);
        assert.match(t, /\[Install\][\s\S]*WantedBy=timers\.target/);
      });
    }
    if (s.manual) {
      test(`${s.file}: manual service has NO timer (no double scheduling) and the night guard is off`, () => {
        assert.ok(!fs.existsSync(depPath('systemd/' + s.file + '.timer')), 'a timer would schedule the job twice');
        assert.match(unit(s.file + '.service'), /Environment=NIGHT_GUARD=0/);
      });
    }
    if (s.guard) {
      test(`${s.file}: the night guard is ON (steps that would start after the cut-off are skipped)`, () => {
        assert.match(unit(s.file + '.service'), /Environment=NIGHT_GUARD=1/);
      });
    }
  }
  test('settings the workflows used are kept (audit concurrency 4 / budget 150, terms concurrency 8 / budget 90)', () => {
    for (const f of ['sqp-night', 'sqp-daily-data']) {
      assert.match(unit(f + '.service'), /Environment=AUDIT_CONCURRENCY=4/);
      assert.match(unit(f + '.service'), /Environment=AUDIT_BUDGET_MIN=150/);
    }
    for (const f of ['sqp-night', 'sqp-audit-terms']) {
      assert.match(unit(f + '.service'), /Environment=TERMS_CONCURRENCY=8/);
      assert.match(unit(f + '.service'), /Environment=TERMS_BUDGET_MIN=90/);
    }
  });
  test('each step stays below its old workflow limit', () => {
    const lim = { 'vendor/sales': 180, 'vendor/ads': 180, 'ads/refresh': 355, 'ads/periodic': 355, 'daily-data/audit': 300, 'daily-data/sales-traffic': 330, 'audit-terms': 180 };
    for (const x of steps(unit('sqp-night.service'))) assert.ok(x.minutes <= lim[x.job], `${x.job} ${x.minutes} > ${lim[x.job]}`);
  });
  test('the OLD single timers are gone (vendor, ads, daily-data run only inside the night chain)', () => {
    for (const f of ['sqp-vendor.timer', 'sqp-ads.timer', 'sqp-daily-data.timer']) assert.ok(!fs.existsSync(depPath('systemd/' + f)), f + ' must not exist');
  });
});

describe('safety settings (validator findings 2026-11-21)', () => {
  const ALL = ['sqp-night', 'sqp-ads', 'sqp-vendor', 'sqp-daily-data', 'sqp-audit-terms'];
  test('a killed step (out of memory) must not stop the rest of the chain and must not thrash the swap: OOMPolicy=continue, MemorySwapMax=0', () => {
    for (const f of ALL) {
      assert.match(unit(f + '.service'), /OOMPolicy=continue/, f);
      assert.match(unit(f + '.service'), /MemorySwapMax=0/, f);
    }
  });
  test('node gets an explicit heap limit below the memory cap in the ads units (the default heap of a 2 GB machine may be smaller than the biggest account needs)', () => {
    for (const f of ['sqp-night', 'sqp-ads']) {
      const v = unit(f + '.service');
      const m = v.match(/Environment=NODE_OPTIONS=--max-old-space-size=(\d+)/);
      assert.ok(m, f + ': NODE_OPTIONS missing');
      assert.ok(+m[1] < +v.match(/MemoryMax=(\d+)M/)[1], f + ': heap limit must be below MemoryMax');
    }
  });
  test("the ads scripts' own time budgets end BEFORE the wrapper's hard timeout (>= 30 min earlier), so they finish cleanly instead of being killed", () => {
    for (const f of ['sqp-night', 'sqp-ads']) {
      const v = unit(f + '.service'); const st = steps(v);
      const refresh = +v.match(/Environment=ADS_REFRESH_BUDGET_MIN=(\d+)/)[1];
      const periodic = +v.match(/Environment=ADS_PERIODIC_BUDGET_MIN=(\d+)/)[1];
      assert.ok(refresh <= st.find((x) => x.job === 'ads/refresh').minutes - 30, f + ' ads-refresh budget ' + refresh);
      assert.ok(periodic <= st.find((x) => x.job === 'ads/periodic').minutes - 30, f + ' ads-periodic budget ' + periodic);
    }
  });
});

describe('night chain timing (measured on real GitHub runs, minutes)', () => {
  // worst observed durations: vendor 52, ads 238 (3h58, rising), audit-terms 73, daily-data audit 155 + sales-traffic 16 (they ran in parallel on GitHub, here one after the other)
  const WORST = [['vendor', 52], ['ads', 238], ['audit-terms', 73], ['daily-data/audit', 155], ['daily-data/sales-traffic', 16]];
  test('back to back from 18:00 UTC the worst observed chain ends before the 04:00 cut-off with at least 60 minutes to spare, and long before the team (07:00)', () => {
    const total = WORST.reduce((a, [, m]) => a + m, 0);
    const endMinAfter18 = total; // no idle gaps in the chain
    assert.ok(endMinAfter18 <= 10 * 60 - 60, `chain of ${total} min ends ${endMinAfter18} min after 18:00 UTC — too close to the 04:00 cut-off`);
  });
  test('the old fixed timers (18:00, 19:30, 00:30, 02:00) would have left idle gaps and ended daily-data minutes before 05:00 — the reason for the chain', () => {
    const endOldPlan = (2 * 60 + 0 + 155 + 16) + 6 * 60; // daily-data starts 02:00 UTC = 480 min after 18:00; + 171 min
    assert.ok(endOldPlan > 10 * 60 + 30, 'sanity check of the old plan');
  });
});

describe('deploy/server-job.sh', () => {
  const sh = dep('server-job.sh');
  test('takes the shared lock, enforces a hard timeout, runs node, and reports the exit code', () => {
    assert.match(sh, /sqp-heavy\.lock/);
    assert.match(sh, /flock\s+9/);
    assert.match(sh, /timeout\s+--signal=TERM/);
    assert.match(sh, /report-job-run\.mjs/);
  });
  test('returns the job exit code (so systemd and the logs show the truth)', () => {
    assert.match(sh, /exit\s+"\$code"/);
  });
  test('node is called by absolute path (independent of the systemd PATH)', () => {
    const code = sh.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    assert.ok(!/(^|[\s;|&])node\s/.test(code), 'no bare node call');
    assert.match(sh, /\/usr\/bin\/node/);
  });
  test('a failing report must never change the job result', () => {
    assert.match(sh, /report-job-run\.mjs[^\n]*\|\|\s*true/);
  });
  test('the night guard: with NIGHT_GUARD=1 a step that would start after the cut-off (default 04:00 UTC, until 17:00) is skipped and reported (code 99)', () => {
    assert.match(sh, /NIGHT_GUARD/);
    assert.match(sh, /NIGHT_CUTOFF:-0400/);
    assert.match(sh, /\b99\b/);
  });
  test('the guard is checked AFTER the lock is obtained (a step that waited for the lock must not start in working hours)', () => {
    assert.ok(sh.indexOf('\nflock 9') > -1 && sh.indexOf('\nflock 9') < sh.indexOf('${NIGHT_CUTOFF'), 'guard must come after flock');
  });
});
