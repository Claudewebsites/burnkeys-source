import { test } from 'node:test';
import { takeKeyFromClipboard } from '../src/clipboard.js';
import { fake } from './helpers.js';

function fakeClipboard(values) {
  let current = values.shift() ?? '';
  let cleared = 0;
  return {
    clipboard: {
      read: () => { if (values.length) current = values.shift(); return current; },
      clear: () => { current = ''; cleared++; },
    },
    get cleared() { return cleared; },
  };
}

test('clipboard: takes a key and clears it; ignores non-keys', async (t) => {
  const key = fake.anthropic();
  const c = fakeClipboard([key]);
  t.assert.equal(await takeKeyFromClipboard({ clipboard: c.clipboard }), key);
  t.assert.equal(c.cleared, 1);
  const n = fakeClipboard(['just some text you copied']);
  t.assert.equal(await takeKeyFromClipboard({ clipboard: n.clipboard }), '');
  t.assert.equal(n.cleared, 0, 'unrelated clipboard content is left alone');
});

test('clipboard wait: ignores the key already there, takes the newly copied one', async (t) => {
  const old = fake.anthropic(), fresh = fake.anthropic();
  const c = fakeClipboard([old, old, 'hello', old, fresh]);
  t.assert.equal(await takeKeyFromClipboard({ wait: true, pollMs: 1, clipboard: c.clipboard }), fresh);
  t.assert.equal(c.cleared, 1);
});

test('clipboard wait: times out quietly', async (t) => {
  const c = fakeClipboard(['nothing']);
  t.assert.equal(await takeKeyFromClipboard({ wait: true, pollMs: 1, timeoutMs: 20, clipboard: c.clipboard }), '');
});
