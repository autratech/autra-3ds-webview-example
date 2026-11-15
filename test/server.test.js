'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Credenciais falsas só para o módulo carregar; nenhum teste chama o core.
process.env.AUTRA_CLIENT_ID = 'test-client';
process.env.AUTRA_CLIENT_SECRET = 'test-secret';
process.env.AUTRA_BASE_URL = 'http://127.0.0.1:9'; // porta fechada: qualquer chamada falha rápido
const { app, returnPage, formatAmount, clientIp } = require('../server/index');
const { AutraClient } = require('../server/autra-client');

test('returnPage emite postMessage 3DS_CHALLENGE_COMPLETE com jwt/md/allFields', () => {
  const html = returnPage({ Response: 'jwt-abc', MD: 'auth-1', TransactionId: 'tx-1' }, 'https://checkout.example', 'state-a');
  assert.match(html, /window\.parent\.postMessage/);
  const json = html.match(/postMessage\((\{.*\}),"https:\/\/checkout.example"\)/)[1];
  const msg = JSON.parse(json);
  assert.equal(msg.type, '3DS_CHALLENGE_COMPLETE');
  assert.equal(msg.jwt, 'jwt-abc');
  assert.equal(msg.md, 'auth-1');
  assert.equal(msg.allFields.TransactionId, 'tx-1');
  assert.equal(msg.state, 'state-a');
});

test('returnPage aceita o campo JWT no lugar de Response e escapa "<"', () => {
  const html = returnPage({ JWT: 'j', MD: '<script>' }, 'https://checkout.example', 'state-a');
  assert.match(html, /"jwt":"j"/);
  assert.equal(html.includes('<script>"'), false);
  assert.match(html, /\\u003cscript>/);
});

test('callback público sem state válido rejeita sem emitir postMessage', async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/3ds/return`;
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'MD=auth-a&Response=fake' });
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /postMessage/);
    const get = await fetch(url);
    assert.equal(get.status, 405);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test('authenticate vincula callback à sessão, retorno valida MD e rejeita replay', async () => {
  const original = AutraClient.prototype.threeDsAuthenticate;
  let sent;
  AutraClient.prototype.threeDsAuthenticate = async function (payload) {
    sent = payload;
    return { code: 'WAITING_3DS_AUTHENTICATION', stepUpUrl: 'https://issuer.example/challenge', authenticationId: 'auth-test', accessToken: 'synthetic' };
  };
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const root = `http://127.0.0.1:${server.address().port}`;
    const authResponse = await fetch(root + '/api/3ds/authenticate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      transactionalToken: 'synthetic', requestId: 'request-test', referenceId: 'reference-test', cardNumber: 'test-card', cardExpirationDate: '122030', cardHolderName: 'TEST', amount: 12.53
    }) });
    assert.equal(authResponse.status, 200);
    const auth = await authResponse.json();
    const callback = new URL(sent.returnUrl);
    assert.equal(callback.searchParams.get('state'), auth.callbackState);
    assert.equal(auth.callbackOrigin, callback.origin);
    const url = root + callback.pathname + callback.search;
    const post = (md) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ MD: md, Response: 'synthetic' }) });
    assert.equal((await post('other-session')).status, 400);
    const good = await post('auth-test');
    assert.equal(good.status, 200);
    assert.equal(good.headers.get('cache-control'), 'no-store');
    assert.match(await good.text(), new RegExp(auth.callbackState));
    assert.equal((await post('auth-test')).status, 400);
  } finally {
    AutraClient.prototype.threeDsAuthenticate = original;
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
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

test('rotas 3DS limitam chamadas mesmo com X-Forwarded-For não confiável', async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    let limited = false;
    for (let i = 0; i < 65; i++) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/3ds/authenticate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `192.0.2.${i + 1}` }, body: '{}'
      });
      if (response.status === 429) { limited = true; break; }
    }
    assert.equal(limited, true);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
