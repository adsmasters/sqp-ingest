// The two scripts that raise their OWN alerts must go through the shared notify() (notify.mjs), so that on the server (no Slack secret) the alert
// is stored as an 'alert' row and forwarded by the watchdog instead of being lost. Intended behaviour (written before the change, 2026-11-21).
// Static guard: the behaviour of notify() itself is tested in notify.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => fs.readFileSync(path.join(root, f), 'utf8');

for (const [file, job] of [['ads-periodic.mjs', 'ads/periodic'], ['refresh.mjs', 'refresh/refresh']]) {
  test(`${file} raises its own alert through notify() with job "${job}"`, () => {
    const s = src(file);
    assert.match(s, /import \{ notify \} from '\.\/notify\.mjs'/);
    assert.match(s, new RegExp(`notify\\(\\{[^}]*job:\\s*'${job.replace('/', '\\/')}'`));
  });
  test(`${file} no longer posts to the Slack webhook by itself`, () => {
    assert.ok(!/fetch\(\s*(webhook|hook)\b/.test(src(file)), 'direct fetch(webhook) must be gone');
  });
}
