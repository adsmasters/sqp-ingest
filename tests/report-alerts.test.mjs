// Expectations for how the Pipeline-Wächter reports on the Ads Dashboard's monthly client report emails, written from the
// requirements and NOT fitted to the code:
//  The dashboard writes alerts (adsdash_report_alerts) and run rows (adsdash_report_runs). The watchdog must surface them in Slack:
//   - every UNRESOLVED alert is a problem on its FIRST occurrence (no grace period: a wrong or missing client email is never
//     "just routine"); resolved alerts never are;
//   - the text names the client, the alert code and the month as a WORD (e.g. "September 2026");
//   - alerts raised by a TEST-mode run are labelled [TEST] so nobody mistakes them for a live problem;
//   - a deleted client (client_id null) is still named, from the stored name snapshot; an account-wide alert (no client) works too;
//   - a run that has been `pending` for more than 24 hours is a problem; a younger one is not;
//   - nothing to report => no issues.
// Pure function, deterministic: no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportAlertIssues } from '../report-alerts.mjs';

const NOW = Date.parse('2026-10-16T11:00:00Z');
const hAgo = h => new Date(NOW - h * 3600e3).toISOString();
const clients = [{ id: 'c1', name: 'Rotkäppchen' }, { id: 'c2', name: 'Zweitkunde' }];
const alert = (over = {}) => ({ id: 1, client_id: 'c1', client_name: 'Rotkäppchen', period: '2026-09-01', code: 'blocked', mode: 'live', message: 'x', resolved_at: null, ...over });

test('an unresolved alert is reported at once, naming client, code and month word', () => {
  const out = reportAlertIssues(clients, [alert()], [], NOW);
  assert.equal(out.length, 1);
  assert.match(out[0], /Rotkäppchen/);
  assert.match(out[0], /blocked/);
  assert.match(out[0], /September 2026/);
});
test('resolved alerts are never reported', () => {
  assert.deepEqual(reportAlertIssues(clients, [alert({ resolved_at: hAgo(1) })], [], NOW), []);
});
test('test-mode alerts are labelled [TEST]; live ones are not', () => {
  assert.match(reportAlertIssues(clients, [alert({ mode: 'test' })], [], NOW)[0], /\[TEST\]/);
  assert.ok(!/\[TEST\]/.test(reportAlertIssues(clients, [alert({ mode: 'live' })], [], NOW)[0]));
});
test('deleted client (null id) uses the stored name; an account-wide alert (no client, no period) still works', () => {
  assert.match(reportAlertIssues(clients, [alert({ client_id: null, client_name: 'Gelöscht GmbH' })], [], NOW)[0], /Gelöscht GmbH/);
  const out = reportAlertIssues(clients, [alert({ client_id: null, client_name: null, period: null, code: 'late' })], [], NOW);
  assert.equal(out.length, 1);
});
test('two alerts for different clients give two lines', () => {
  const out = reportAlertIssues(clients, [alert(), alert({ id: 2, client_id: 'c2', client_name: 'Zweitkunde', code: 'unknown' })], [], NOW);
  assert.equal(out.length, 2);
  assert.ok(out.some(x => /Zweitkunde/.test(x) && /unknown/.test(x)));
});
test('a run pending for more than 24 hours is a problem; a younger one is not', () => {
  const run = (h, over = {}) => ({ client_id: 'c1', period: '2026-09-01', mode: 'live', status: 'pending', status_changed_at: hAgo(h), ...over });
  const old = reportAlertIssues(clients, [], [run(30)], NOW);
  assert.equal(old.length, 1);
  assert.match(old[0], /Rotkäppchen/);
  assert.match(old[0], /September 2026/);
  assert.deepEqual(reportAlertIssues(clients, [], [run(5)], NOW), []);
  assert.deepEqual(reportAlertIssues(clients, [], [run(30, { status: 'sent' })], NOW), []);
});
test('nothing to report => no issues', () => {
  assert.deepEqual(reportAlertIssues(clients, [], [], NOW), []);
});
