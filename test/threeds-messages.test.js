'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { waitForMessage } = require('../shared/threeds-messages');

function windowFake() {
  const listeners = new Set();
  return {
    addEventListener: (_name, fn) => listeners.add(fn),
    removeEventListener: (_name, fn) => listeners.delete(fn),
    send: (event) => [...listeners].forEach((fn) => fn(event)),
    size: () => listeners.size
  };
}

test('message exige origem, iframe e correlação antes de aceitar', async () => {
  const target = windowFake();
  const frame = {};
  const good = { origin: 'https://checkout.example', source: frame, data: { type: '3DS_CHALLENGE_COMPLETE', state: 'session-a' } };
  const pending = waitForMessage({ target, timeoutMs: 100, expectedOrigin: good.origin, expectedSource: frame,
    predicate: (d) => d.type === '3DS_CHALLENGE_COMPLETE' && d.state === 'session-a' });
  target.send({ ...good, origin: 'https://attacker.example' });
  target.send({ ...good, source: {} });
  target.send({ ...good, data: { ...good.data, state: 'session-b' } });
  target.send({ ...good, data: 'invalid json' });
  assert.equal(target.size(), 1);
  target.send({ ...good, data: JSON.stringify(good.data) });
  assert.deepEqual(await pending, { data: good.data, timedOut: false });
  assert.equal(target.size(), 0);
});

test('timeout remove listener e não aceita origem ausente ou curinga', async () => {
  const target = windowFake();
  for (const expectedOrigin of ['', '*', 'null']) {
    assert.throws(() => waitForMessage({ target, expectedOrigin, expectedSource: {}, predicate: () => true, timeoutMs: 1 }));
  }
  const result = await waitForMessage({ target, expectedOrigin: 'https://checkout.example', expectedSource: {}, predicate: () => true, timeoutMs: 1 });
  assert.deepEqual(result, { data: null, timedOut: true });
  assert.equal(target.size(), 0);
});
