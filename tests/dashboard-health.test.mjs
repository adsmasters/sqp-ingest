// Expectations for how the Pipeline-Wächter reports on the Ads Dashboard, written from the requirements and NOT fitted to the code:
//
//  The Ads Dashboard (separate project) runs its own daily data check and stores one result per client in
//  adsdash_health_check (status ok | warn | alert). The watchdog must surface that in Slack with its existing alert flow:
//   - a client whose NEWEST check is an ALERT is a problem, named with its messages;
//   - warnings alone are NOT a problem (the dashboard check warns about routine Amazon rate limits);
//   - if no check was stored for a client in the last 30 hours (the check runs once a day), the check itself is not
//     running: that is a problem too;
//   - an inactive client, or one that has never had a check yet, is never a problem;
//   - only the newest row per client counts (an old alert that has since been resolved must not be reported).
// Pure function, deterministic: no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardHealthIssues } from '../dashboard-health.mjs';

const NOW = Date.parse('2026-10-08T11:00:00Z');
const hAgo = h => new Date(NOW - h * 3600e3).toISOString();
const clients = [{ id: 'c1', name: 'Rotkäppchen', active: true }];
const check = (over = {}) => ({ client_id: 'c1', checked_at: hAgo(3), status: 'ok', issues: [], ...over });

test('a recent ok check is not a problem', () => {
  assert.deepEqual(dashboardHealthIssues(clients, [check()], NOW), []);
});

test('warnings alone are not a problem', () => {
  const rows = [check({ status: 'warn', issues: [{ severity: 'warn', code: 'recent_errors', message: '4 sync error(s)' }] })];
  assert.deepEqual(dashboardHealthIssues(clients, rows, NOW), []);
});

test('an alert names the client and carries the alert messages only', () => {
  const rows = [
    check({
      status: 'alert',
      issues: [
        { severity: 'alert', code: 'missing_days', message: '1 day(s) have no Sponsored Products data: 2026-10-01' },
        { severity: 'warn', code: 'recent_errors', message: 'noisy warning' },
      ],
    }),
  ];
  const out = dashboardHealthIssues(clients, rows, NOW);
  assert.equal(out.length, 1);
  assert.match(out[0], /Rotkäppchen/);
  assert.match(out[0], /2026-10-01/);
  assert.doesNotMatch(out[0], /noisy warning/);
});

test('no check in the last 30 hours means the dashboard check is not running', () => {
  const out = dashboardHealthIssues(clients, [check({ checked_at: hAgo(31) })], NOW);
  assert.equal(out.length, 1);
  assert.match(out[0], /Rotkäppchen/);
  assert.match(out[0], /31h|31 h|31/);
});

test('29 hours old is still fine', () => {
  assert.deepEqual(dashboardHealthIssues(clients, [check({ checked_at: hAgo(29) })], NOW), []);
});

test('a client that has never had a check is not a problem', () => {
  assert.deepEqual(dashboardHealthIssues(clients, [], NOW), []);
});

test('inactive clients are ignored', () => {
  const rows = [check({ status: 'alert', issues: [{ severity: 'alert', code: 'x', message: 'boom' }] })];
  assert.deepEqual(dashboardHealthIssues([{ id: 'c1', name: 'Old', active: false }], rows, NOW), []);
});

test('only the newest check per client counts', () => {
  const rows = [
    check({ checked_at: hAgo(2), status: 'ok' }),
    check({ checked_at: hAgo(26), status: 'alert', issues: [{ severity: 'alert', code: 'x', message: 'old resolved alert' }] }),
  ];
  assert.deepEqual(dashboardHealthIssues(clients, rows, NOW), []);
});

test('each client is judged separately', () => {
  const two = [
    { id: 'c1', name: 'A', active: true },
    { id: 'c2', name: 'B', active: true },
  ];
  const rows = [
    check({ client_id: 'c1' }),
    check({ client_id: 'c2', status: 'alert', issues: [{ severity: 'alert', code: 'x', message: 'B is broken' }] }),
  ];
  const out = dashboardHealthIssues(two, rows, NOW);
  assert.equal(out.length, 1);
  assert.match(out[0], /B/);
});
