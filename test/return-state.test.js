'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ReturnStates } = require('../server/return-state');

test('return state exige sessão, MD e prazo; sucesso só pode ser consumido uma vez', () => {
  let now = 100;
  const states = new ReturnStates({ now: () => now, ttlMs: 10 });
  const a = states.create('request-a');
  const b = states.create('request-b');
  assert.notEqual(a, b);
  assert.equal(states.consume(a, 'auth-a'), null); // ainda não autenticada
  states.bind(a, 'auth-a');
  assert.equal(states.consume(a, 'auth-b'), null);
  assert.deepEqual(states.consume(a, 'auth-a'), { state: a, requestId: 'request-a', authenticationId: 'auth-a' });
  assert.equal(states.consume(a, 'auth-a'), null);
  states.bind(b, 'auth-b');
  now = 110;
  assert.equal(states.consume(b, 'auth-b'), null);
  assert.equal(states.consume('unknown', 'auth-a'), null);
});

test('state limita memória e pode ser descartado após falha ou frictionless', () => {
  const states = new ReturnStates({ maxEntries: 1 });
  const a = states.create('a');
  assert.throws(() => states.create('b'), /capacity/);
  states.discard(a);
  assert.ok(states.create('b'));
});
