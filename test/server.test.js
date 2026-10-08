'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Credenciais falsas só para o módulo carregar; nenhum teste chama o core.
process.env.AUTRA_CLIENT_ID = 'test-client';
process.env.AUTRA_CLIENT_SECRET = 'test-secret';
process.env.AUTRA_BASE_URL = 'http://127.0.0.1:9'; // porta fechada: qualquer chamada falha rápido
const { returnPage, formatAmount, clientIp } = require('../server/index');

test('returnPage emite postMessage 3DS_CHALLENGE_COMPLETE com jwt/md/allFields', () => {
  const html = returnPage({ Response: 'jwt-abc', MD: 'auth-1', TransactionId: 'tx-1' });
  assert.match(html, /window\.parent\.postMessage/);
  const json = html.match(/postMessage\((\{.*\}),'\*'\)/)[1];
  const msg = JSON.parse(json);
  assert.equal(msg.type, '3DS_CHALLENGE_COMPLETE');
  assert.equal(msg.jwt, 'jwt-abc');
  assert.equal(msg.md, 'auth-1');
  assert.equal(msg.allFields.TransactionId, 'tx-1');
});

test('returnPage aceita o campo JWT no lugar de Response e escapa "<"', () => {
  const html = returnPage({ JWT: 'j', MD: '<script>' });
  assert.match(html, /"jwt":"j"/);
  assert.equal(html.includes('<script>"'), false);
  assert.match(html, /\\u003cscript>/);
});

test('formatAmount normaliza para string com 2 casas', () => {
  assert.equal(formatAmount('12'), '12.00');
  assert.equal(formatAmount(12.53), '12.53');
  assert.equal(formatAmount('abc'), '12.00');
});

test('clientIp normaliza loopback IPv6', () => {
  assert.equal(clientIp({ ip: '::1' }), '127.0.0.1');
  assert.equal(clientIp({ ip: '::ffff:10.0.0.5' }), '10.0.0.5');
  assert.equal(clientIp({ ip: '200.1.2.3' }), '200.1.2.3');
});
