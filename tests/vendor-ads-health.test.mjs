// Watchdog helper: which vendor clients have STALE vendor-ads data (vra_ads)?
// Intended behaviour (written before the code): vendor-ads.mjs runs daily and always keeps the newest month's period_end at
// "yesterday". If the newest period_end of a client is more than 3 days old, the import has silently stopped for that client
// (expired token, failing report, skipped month) and the team must be told. Clients without any data yet are not reported
// (onboarding is covered elsewhere), and a value we cannot read is not guessed at.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { vendorAdsStaleClients } from '../vendor-ads-health.mjs';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const C = (id, name) => ({ id, name });

describe('vendorAdsStaleClients', () => {
  test('data up to yesterday is fresh', () => {
    assert.deepEqual(vendorAdsStaleClients([C(1, 'A')], { 1: '2026-11-15' }, NOW), []);
  });
  test('exactly 3 days old is still fine, 4 days old is stale', () => {
    assert.deepEqual(vendorAdsStaleClients([C(1, 'A')], { 1: '2026-11-13' }, NOW), []);
    assert.deepEqual(vendorAdsStaleClients([C(1, 'A')], { 1: '2026-11-12' }, NOW), ['A']);
  });
  test('a client without any data yet is not reported', () => {
    assert.deepEqual(vendorAdsStaleClients([C(1, 'A'), C(2, 'B')], { 1: null }, NOW), []);
  });
  test('an unreadable value is not guessed at (not reported)', () => {
    assert.deepEqual(vendorAdsStaleClients([C(1, 'A')], { 1: 'garbage' }, NOW), []);
  });
  test('reports only the stale clients, in the given order', () => {
    const clients = [C(1, 'Fresh'), C(2, 'Old1'), C(3, 'Old2')];
    assert.deepEqual(vendorAdsStaleClients(clients, { 1: '2026-11-15', 2: '2026-10-01', 3: '2026-11-01' }, NOW), ['Old1', 'Old2']);
  });
  test('works with a Map too', () => {
    assert.deepEqual(vendorAdsStaleClients([C(1, 'A')], new Map([[1, '2026-11-01']]), NOW), ['A']);
  });
  test('a client that is older than 7 days but has NEVER got any vendor-ads rows is reported (a permanently broken new client must not stay silent)', () => {
    const old = { id: 1, name: 'A', created_at: '2026-11-01T10:00:00Z' };
    assert.deepEqual(vendorAdsStaleClients([old], { 1: null }, NOW), ['A (noch keine Daten)']);
  });
  test('a brand-new client without data is still in its onboarding grace period (not reported)', () => {
    const fresh = { id: 1, name: 'A', created_at: '2026-11-14T10:00:00Z' };
    assert.deepEqual(vendorAdsStaleClients([fresh], { 1: null }, NOW), []);
  });
  test('no data and no readable created_at: cannot judge, not reported', () => {
    assert.deepEqual(vendorAdsStaleClients([{ id: 1, name: 'A', created_at: 'garbage' }], { 1: null }, NOW), []);
  });
  test('a client whose newest value could not be READ (undefined) is not guessed at', () => {
    const old = { id: 1, name: 'A', created_at: '2026-11-01T10:00:00Z' };
    assert.deepEqual(vendorAdsStaleClients([old], {}, NOW), []);
  });
  test('a custom limit is respected', () => {
    assert.deepEqual(vendorAdsStaleClients([C(1, 'A')], { 1: '2026-11-13' }, NOW, 1), ['A']);
  });
});
