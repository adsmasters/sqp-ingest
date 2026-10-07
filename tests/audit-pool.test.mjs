// Expectations for the nightly PPC-Audit refresh (audit-refresh.mjs), written from the requirements and NOT fitted to the code:
//
//  - Only ~5 of 35 accounts were refreshed per night (one account at a time, 100-min budget, ~25 min per account, almost all of it
//    idle waiting for Amazon). Accounts must be refreshed in parallel, stalest first, within a larger budget.
//  - Parallel workers must never exceed the configured concurrency, must start new accounts only while the budget lasts,
//    must let accounts that are already running finish, and one failing account must never stop the others.
//  - The shared Amazon access token must be refreshed once for all workers (not once per worker), when it gets old.
//  - SAFETY: this job only ever requests reports and READS the campaign list. It must never contain a call that creates,
//    changes or deletes a campaign (a live campaign spends real client money).
//
// Everything here is deterministic: a fake clock and fake sleep replace real time, no network, no Amazon.
// Run: node --test tests/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPool, makeTokenManager } from '../audit-pool.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---- fake time ------------------------------------------------------------------------------------------------
// sleep(ms) advances the clock only when EVERY lane is blocked on a timer or a job, like real time would.
function fakeTime() {
  let t = 0;
  const timers = [];
  const clock = {
    now: () => t,
    sleep: (ms) => new Promise((resolve) => { timers.push({ at: t + ms, resolve }); }),
    // run until nothing is pending; each step jumps to the earliest timer
    async settle() {
      for (let guard = 0; guard < 100000; guard++) {
        await new Promise((r) => setImmediate(r));
        if (!timers.length) return;
        timers.sort((a, b) => a.at - b.at);
        const next = timers.shift();
        t = Math.max(t, next.at);
        next.resolve();
      }
      throw new Error('fake clock: runaway');
    },
  };
  return clock;
}

// a worker that "takes" `dur` ms of fake time and records what happened
function recorder(clock, dur) {
  const log = { started: [], finished: [], inFlight: 0, maxInFlight: 0, startAt: {} };
  const worker = async (item, idx, lane) => {
    log.started.push(item);
    log.startAt[item] = clock.now();
    log.inFlight++; log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
    try { await clock.sleep(typeof dur === 'function' ? dur(item) : dur); }
    finally { log.inFlight--; }
    log.finished.push(item);
    return { item, lane };
  };
  return { log, worker };
}
const accounts = (n) => Array.from({ length: n }, (_, i) => 'acc' + (i + 1));
const MIN = 60000;

async function run(clock, items, opts, worker) {
  const p = runPool(items, { now: clock.now, sleep: clock.sleep, worker, ...opts });
  await clock.settle();
  return p;
}

// =====================================================================================================
describe('runPool: parallel accounts', () => {
  test('invariant: never more accounts in flight than the configured concurrency', async () => {
    for (const c of [1, 2, 4, 7]) {
      const clock = fakeTime();
      const { log, worker } = recorder(clock, 25 * MIN);
      await run(clock, accounts(20), { concurrency: c, budgetMs: 1e12 }, worker);
      assert.equal(log.maxInFlight, Math.min(c, 20), `concurrency ${c}`);
    }
  });

  test('invariant: every account is processed exactly once when the budget is not reached', async () => {
    const clock = fakeTime();
    const { log, worker } = recorder(clock, 25 * MIN);
    const items = accounts(35);
    const r = await run(clock, items, { concurrency: 4, budgetMs: 1e12 }, worker);
    assert.deepEqual([...log.finished].sort(), [...items].sort());
    assert.equal(new Set(log.started).size, 35, 'no account started twice');
    assert.equal(r.started, 35);
    assert.deepEqual(r.skipped, []);
    assert.equal(r.budgetHit, false);
  });

  test('invariant: accounts are STARTED in queue order (stalest first)', async () => {
    const clock = fakeTime();
    const { log, worker } = recorder(clock, 10 * MIN);
    const items = accounts(12);
    await run(clock, items, { concurrency: 3, budgetMs: 1e12 }, worker);
    assert.deepEqual(log.started, items);
  });

  test('the real-world case: 35 accounts of 25 min with 4 workers and a 200-min budget -> about 32 of 35 refreshed per night (was 5)', async () => {
    const clock = fakeTime();
    const { log, worker } = recorder(clock, 25 * MIN);
    const r = await run(clock, accounts(35), { concurrency: 4, budgetMs: 200 * MIN, staggerMs: 45000 }, worker);
    assert.ok(r.started >= 28, `started ${r.started}`);
    assert.ok(r.started < 35, 'the remainder is left for the next night');
    assert.equal(r.skipped.length, 35 - r.started);
    assert.equal(r.budgetHit, true);
    // the skipped ones are exactly the LAST in the queue (so the next night, being the stalest, they come first)
    assert.deepEqual(r.skipped, accounts(35).slice(r.started));
    assert.equal(log.finished.length, r.started, 'every started account was allowed to finish');
  });
});

describe('runPool: budget', () => {
  test('invariant: no new account is started after the budget is spent, but running accounts finish', async () => {
    const clock = fakeTime();
    const { log, worker } = recorder(clock, 30 * MIN);
    const r = await run(clock, accounts(10), { concurrency: 2, budgetMs: 70 * MIN }, worker);
    // lane0 starts at 0,30,60 (60 < 70 ok) -> 90 > 70 stop; same for lane1 -> 6 accounts
    assert.equal(r.started, 6);
    assert.equal(log.finished.length, 6, 'the accounts started before the budget ended all finished (even past 70 min)');
    assert.ok(Math.max(...Object.values(log.startAt)) <= 70 * MIN, 'nothing started after the budget');
    assert.deepEqual(r.skipped, accounts(10).slice(6));
  });

  test('invariant: budget 0 starts nothing; everything is reported as skipped', async () => {
    const clock = fakeTime();
    const { log, worker } = recorder(clock, MIN);
    // every reading of the clock is later than the one before, so any elapsed time exceeds a zero budget
    const r = await runPool(accounts(5), { concurrency: 3, budgetMs: 0, now: (() => { let n = 0; return () => n++ * 10; })(), sleep: clock.sleep, worker });
    assert.equal(r.started, 0);
    assert.equal(log.started.length, 0);
    assert.equal(r.skipped.length, 5);
    assert.equal(r.budgetHit, true);
  });

  test('invariant: the budget is measured from the start of the pool (staggered lanes do not get extra time)', async () => {
    const clock = fakeTime();
    const { log, worker } = recorder(clock, 20 * MIN);
    await run(clock, accounts(30), { concurrency: 3, budgetMs: 50 * MIN, staggerMs: 10 * MIN }, worker);
    assert.ok(Math.max(...Object.values(log.startAt)) <= 50 * MIN);
  });
});

describe('runPool: stagger (avoid a burst of report creations at the start)', () => {
  test('invariant: lane k waits k * staggerMs before its first account', async () => {
    const clock = fakeTime();
    const { log, worker } = recorder(clock, 25 * MIN);
    await run(clock, accounts(4), { concurrency: 4, budgetMs: 1e12, staggerMs: 45000 }, worker);
    assert.deepEqual([log.startAt.acc1, log.startAt.acc2, log.startAt.acc3, log.startAt.acc4], [0, 45000, 90000, 135000]);
  });

  test('invariant: no stagger configured -> all lanes start immediately', async () => {
    const clock = fakeTime();
    const { log, worker } = recorder(clock, MIN);
    await run(clock, accounts(3), { concurrency: 3, budgetMs: 1e12 }, worker);
    assert.deepEqual([log.startAt.acc1, log.startAt.acc2, log.startAt.acc3], [0, 0, 0]);
  });
});

describe('runPool: failures and odd input', () => {
  test('invariant: one failing account does not stop the others and is reported', async () => {
    const clock = fakeTime();
    const seen = [];
    const worker = async (item) => { seen.push(item); await clock.sleep(MIN); if (item === 'acc2') throw new Error('boom'); return item; };
    const r = await run(clock, accounts(6), { concurrency: 2, budgetMs: 1e12 }, worker);
    assert.deepEqual([...seen].sort(), accounts(6).sort(), 'all accounts were attempted');
    assert.equal(r.results[1].ok, false);
    assert.equal(r.results[1].error.message, 'boom');
    assert.equal(r.results.filter((x) => x.ok).length, 5);
  });

  test('invariant: results are indexed like the input, with the worker value', async () => {
    const clock = fakeTime();
    const { worker } = recorder(clock, MIN);
    const r = await run(clock, accounts(3), { concurrency: 2, budgetMs: 1e12 }, worker);
    assert.deepEqual(r.results.map((x) => x.value.item), accounts(3));
  });

  test('invariant: an empty queue returns immediately; concurrency below 1 or not a number still works (as 1)', async () => {
    const clock = fakeTime();
    const { log, worker } = recorder(clock, MIN);
    const r0 = await run(clock, [], { concurrency: 4, budgetMs: 1e12 }, worker);
    assert.equal(r0.started, 0); assert.deepEqual(r0.skipped, []);
    for (const c of [0, -3, NaN, undefined, 'x']) {
      const clk = fakeTime(); const rec = recorder(clk, MIN);
      const r = await run(clk, accounts(3), { concurrency: c, budgetMs: 1e12 }, rec.worker);
      assert.equal(r.started, 3, `concurrency ${String(c)}`);
      assert.equal(rec.log.maxInFlight, 1);
    }
    assert.equal(log.started.length, 0);
  });

  test('invariant: more workers than accounts does not start phantom workers', async () => {
    const clock = fakeTime();
    const { log, worker } = recorder(clock, MIN);
    const r = await run(clock, accounts(2), { concurrency: 10, budgetMs: 1e12 }, worker);
    assert.equal(r.started, 2);
    assert.equal(log.maxInFlight, 2);
  });
});

// =====================================================================================================
describe('makeTokenManager: one shared access token', () => {
  test('invariant: concurrent callers share ONE refresh (no stampede on the token endpoint)', async () => {
    let calls = 0; let release;
    const gate = new Promise((r) => { release = r; });
    const ensure = makeTokenManager({ fetchToken: async () => { calls++; await gate; return 'T1'; }, now: () => 0 });
    const ps = [ensure(), ensure(), ensure(), ensure()];
    release();
    assert.deepEqual(await Promise.all(ps), ['T1', 'T1', 'T1', 'T1']);
    assert.equal(calls, 1);
  });

  test('invariant: a young token is reused; an old one (past maxAge) is refreshed once', async () => {
    let t = 0; let n = 0;
    const ensure = makeTokenManager({ fetchToken: async () => 'T' + (++n), now: () => t, maxAgeMs: 30 * MIN });
    assert.equal(await ensure(), 'T1');
    t = 29 * MIN; assert.equal(await ensure(), 'T1', 'still young');
    t = 31 * MIN; assert.equal(await ensure(), 'T2', 'refreshed after maxAge');
    assert.equal(await ensure(), 'T2');
    assert.equal(n, 2);
  });

  test('invariant: force=true refreshes even a young token', async () => {
    let n = 0;
    const ensure = makeTokenManager({ fetchToken: async () => 'T' + (++n), now: () => 0 });
    assert.equal(await ensure(), 'T1');
    assert.equal(await ensure(true), 'T2');
  });

  test('invariant: a failed refresh throws, is not cached, and the next call tries again', async () => {
    let n = 0;
    const ensure = makeTokenManager({ fetchToken: async () => { n++; if (n === 1) return undefined; return 'OK'; }, now: () => 0 });
    await assert.rejects(() => ensure(), /access_token/);
    assert.equal(await ensure(), 'OK');
  });

  test('review: the default maximum age is 20 minutes (a token lives ~60 min; creating the reports of one account can take a long time)', async () => {
    let t = 0; let n = 0;
    const ensure = makeTokenManager({ fetchToken: async () => 'T' + (++n), now: () => t });
    assert.equal(await ensure(), 'T1');
    t = 19 * MIN; assert.equal(await ensure(), 'T1');
    t = 21 * MIN; assert.equal(await ensure(), 'T2');
  });

  test('review: a refresh that FAILS while the old token is still valid keeps using the old token (a transient error must not fail the account)', async () => {
    let t = 0; let n = 0;
    const ensure = makeTokenManager({ fetchToken: async () => { n++; if (n === 1) return 'T1'; throw new Error('net'); }, now: () => t, maxAgeMs: 20 * MIN });
    assert.equal(await ensure(), 'T1');
    t = 25 * MIN;
    assert.equal(await ensure(), 'T1', 'old token reused although a refresh was due');
    t = 54 * MIN;
    assert.equal(await ensure(), 'T1', 'still inside its ~60 minute life');
  });

  test('review: while the token endpoint is failing it is not hammered: after a failed refresh the old token is used for a minute without asking again', async () => {
    let t = 0; let n = 0;
    const ensure = makeTokenManager({ fetchToken: async () => { n++; if (n === 1) return 'T1'; throw new Error('net'); }, now: () => t, maxAgeMs: 20 * MIN });
    await ensure();
    t = 25 * MIN; await ensure();                    // refresh due -> fails -> falls back (fetch call #2)
    for (let i = 0; i < 10; i++) { t += 3000; assert.equal(await ensure(), 'T1'); }
    assert.equal(n, 2, 'no new refresh attempt within the retry pause');
    t += 61000; await ensure();
    assert.equal(n, 3, 'tries again after the pause');
  });

  test('review: ... but once the old token is nearly expired (55 min) a failing refresh throws instead of handing out a dead token', async () => {
    let t = 0; let n = 0;
    const ensure = makeTokenManager({ fetchToken: async () => { n++; if (n === 1) return 'T1'; throw new Error('net'); }, now: () => t, maxAgeMs: 20 * MIN });
    await ensure();
    t = 56 * MIN;
    await assert.rejects(() => ensure(), /net/);
  });

  test('invariant: callers waiting on a refresh that fails all get the failure, and the manager recovers afterwards', async () => {
    let n = 0;
    const ensure = makeTokenManager({ fetchToken: async () => { n++; if (n === 1) throw new Error('net'); return 'OK'; }, now: () => 0 });
    const results = await Promise.allSettled([ensure(), ensure(), ensure()]);
    assert.ok(results.every((x) => x.status === 'rejected'));
    assert.equal(await ensure(), 'OK');
  });
});

// =====================================================================================================
describe('SAFETY: audit-refresh.mjs only requests reports and reads - it can never create or change a campaign', () => {
  const src = fs.readFileSync(path.join(here, '..', 'audit-refresh.mjs'), 'utf8');

  test('invariant: the only Amazon Ads endpoints used are report creation/status and the campaign LIST', () => {
    const paths = [...src.matchAll(/\$\{ADS\}(\/[^`'"?\s]*)/g)].map((m) => m[1].replace(/\$\{[^}]+\}/g, '{id}'));
    const allowed = new Set(['/reporting/reports', '/reporting/reports/{id}', '/sp/campaigns/list']);
    assert.ok(paths.length >= 3, 'test must actually find the Ads calls');
    for (const p of paths) assert.ok(allowed.has(p), `unexpected Amazon Ads endpoint: ${p}`);
  });

  test('invariant: no PUT / PATCH / DELETE request anywhere in the script, and no campaign state strings', () => {
    assert.doesNotMatch(src, /method:\s*['"](PUT|PATCH|DELETE)['"]/i);
    assert.doesNotMatch(src, /\/sp\/campaigns['"`](?!\/list)/, 'only /sp/campaigns/list');
    assert.doesNotMatch(src, /\/(sb|sd)\/campaigns/);
    assert.doesNotMatch(src, /state\s*:\s*['"]ENABLED['"]/, 'nothing may set a campaign state');
  });

  test('invariant: the only POST targets are report creation, the campaign list (a read), the token endpoint and the Supabase cache', () => {
    const posts = [...src.matchAll(/method:\s*'POST'/g)].length;
    assert.ok(posts >= 3 && posts <= 5, `unexpected number of POST requests: ${posts}`);
  });

  test('invariant: audit-pool.mjs itself makes no network calls at all', () => {
    const pool = fs.readFileSync(path.join(here, '..', 'audit-pool.mjs'), 'utf8');
    assert.doesNotMatch(pool, /\bfetch\s*\(/);
    assert.doesNotMatch(pool, /\bimport\s+.*['"]node:(http|https|net)['"]/);
  });
});
