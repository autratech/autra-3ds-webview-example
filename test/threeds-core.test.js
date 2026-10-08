'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../shared/threeds-core');

// ---- interpretMessage: parse das mensagens que o app nativo recebe --------

test('interpretMessage aceita string JSON (Android/React Native)', () => {
  const r = core.interpretMessage(JSON.stringify({ event: '3DS_SETUP_DONE', data: { requestId: 'req-1' } }));
  assert.equal(r.ok, true);
  assert.equal(r.event, '3DS_SETUP_DONE');
  assert.equal(r.data.requestId, 'req-1');
  assert.equal(r.terminal, false);
  assert.equal(r.success, null);
});

test('interpretMessage aceita objeto (iOS WKScriptMessage.body)', () => {
  const r = core.interpretMessage({ event: '3DS_CHALLENGE_STARTED', data: { authenticationId: 'a1' } });
  assert.equal(r.ok, true);
  assert.equal(r.terminal, false);
});

test('PAYMENT_RESULT ACCEPTED é terminal e sucesso', () => {
  const r = core.interpretMessage({ event: 'PAYMENT_RESULT', data: { paymentID: 'p1', status: 'ACCEPTED' } });
  assert.equal(r.terminal, true);
  assert.equal(r.success, true);
  assert.match(r.summary, /p1/);
});

test('PAYMENT_RESULT com outro status é terminal e falha', () => {
  const r = core.interpretMessage({ event: 'PAYMENT_RESULT', data: { paymentID: 'p2', status: 'DENIED' } });
  assert.equal(r.terminal, true);
  assert.equal(r.success, false);
});

test('ERROR é terminal, falha e preserva code/msg/requestId no resumo', () => {
  const r = core.interpretMessage({ event: 'ERROR', data: { code: 'CARD_DECLINED', msg: 'recusado', requestId: 'rq-9' } });
  assert.equal(r.terminal, true);
  assert.equal(r.success, false);
  assert.match(r.summary, /CARD_DECLINED/);
  assert.match(r.summary, /rq-9/);
});

test('3DS_CHALLENGE_TIMEOUT é terminal e falha', () => {
  const r = core.interpretMessage({ event: '3DS_CHALLENGE_TIMEOUT', data: {} });
  assert.equal(r.terminal, true);
  assert.equal(r.success, false);
});

test('3DS_DDC_DONE com timedOut descreve a ausência de resposta', () => {
  const r = core.interpretMessage({ event: '3DS_DDC_DONE', data: { timedOut: true } });
  assert.match(r.summary, /5 s/);
});

test('3DS_RESULT inclui interpretação dos indicadores', () => {
  const r = core.interpretMessage({ event: '3DS_RESULT', data: { eciRaw: '05', vres_enrolled: 'Y' } });
  assert.match(r.summary, /totalmente autenticada/);
  assert.match(r.summary, /participante/);
});

test('interpretMessage nunca lança com entrada inválida', () => {
  assert.equal(core.interpretMessage('não é json').ok, false);
  assert.equal(core.interpretMessage(null).ok, false);
  assert.equal(core.interpretMessage({ foo: 1 }).ok, false);
  const r = core.interpretMessage({ event: 'ALGO_NOVO', data: {} });
  assert.equal(r.ok, false);
  assert.equal(r.event, 'UNKNOWN');
});

// ---- buildThreeDsData: montagem a partir das respostas do core -----------

const frictionless = {
  code: 'ACCEPTED',
  status: 'AUTHENTICATED',
  authenticationId: 'auth-1',
  cavv: 'AAABBJg0VhI0VniQEjRWAAAAAAA=',
  cavvResultCode: '2',
  eci: '05',
  eciRaw: '05',
  vres_enrolled: 'Y',
  secureVersion: '2.2.0',
  specificationVersion: '2.2.0',
  directoryServerTransactionId: 'ds-1',
  threeDsServerTransactionId: '3ds-1'
};

test('buildThreeDsData a partir do frictionless', () => {
  const d = core.buildThreeDsData(frictionless);
  assert.deepEqual(d, {
    cavv: 'AAABBJg0VhI0VniQEjRWAAAAAAA=',
    cavvResultCode: '2',
    secureVersion: '2.2.0',
    directoryServerTransactionId: 'ds-1',
    threeDsServerTransactionId: '3ds-1',
    authenticationId: 'auth-1',
    eci: '05',
    status: 'AUTHENTICATED'
  });
  // Não vazam campos que a venda não aceita.
  assert.equal('eciRaw' in d, false);
  assert.equal('vres_enrolled' in d, false);
});

test('buildThreeDsData a partir do challenge-result (mesmo formato, sem secureVersion)', () => {
  const challengeResult = { ...frictionless, authenticationId: 'auth-2', secureVersion: undefined, specificationVersion: '2.1.0' };
  const d = core.buildThreeDsData(challengeResult);
  assert.equal(d.authenticationId, 'auth-2');
  assert.equal(d.secureVersion, '2.1.0'); // cai para specificationVersion
  assert.equal(d.status, 'AUTHENTICATED');
});

test('buildThreeDsData rejeita resposta de desafio ou sem cavv', () => {
  assert.throws(() => core.buildThreeDsData({ code: 'WAITING_3DS_AUTHENTICATION', stepUpUrl: 'x' }), /WAITING_3DS_AUTHENTICATION/);
  assert.throws(() => core.buildThreeDsData({ code: 'ACCEPTED', eci: '07' }), /cavv/);
  assert.throws(() => core.buildThreeDsData(null));
});

test('isChallenge detecta WAITING_3DS_AUTHENTICATION com stepUpUrl', () => {
  assert.equal(core.isChallenge({ code: 'WAITING_3DS_AUTHENTICATION', stepUpUrl: 'https://x', accessToken: 'jwt', authenticationId: 'a' }), true);
  assert.equal(core.isChallenge(frictionless), false);
  assert.equal(core.isChallenge({ code: 'WAITING_3DS_AUTHENTICATION' }), false);
});

// ---- describeIndicators: tabela do PDT --------------------------------------

test('describeIndicators classifica ECI e vres_enrolled', () => {
  assert.equal(core.describeIndicators({ eciRaw: '05', vres_enrolled: 'Y' }).fullyAuthenticated, true);
  assert.equal(core.describeIndicators({ eciRaw: '02', vres_enrolled: 'Y' }).fullyAuthenticated, true);
  const attempt = core.describeIndicators({ eciRaw: '06', vres_enrolled: 'U' });
  assert.equal(attempt.fullyAuthenticated, false);
  assert.equal(attempt.attempt, true);
  assert.match(attempt.summary, /indisponível/);
  const none = core.describeIndicators({ eciRaw: '07', vres_enrolled: 'N' });
  assert.equal(none.liabilityShift, false);
  assert.match(none.summary, /não autenticada/);
  assert.match(core.describeIndicators({ eciRaw: '00', vres_enrolled: 'B' }).summary, /regra do estabelecimento/);
  assert.match(core.describeIndicators({}).summary, /desconhecido/);
});
