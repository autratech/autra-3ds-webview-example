/*
 * Funções puras compartilhadas entre a página da WebView (navegador), o
 * backend de exemplo e os testes (Node). Sem dependências.
 *
 * Carregamento:
 *   - navegador: <script src="/shared/threeds-core.js"></script> → window.AutraThreeDS
 *   - Node:      const core = require('../shared/threeds-core.js')
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AutraThreeDS = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Eventos que a página publica para o app nativo via notifyNative().
  var EVENTS = {
    SETUP_DONE: '3DS_SETUP_DONE',
    DDC_DONE: '3DS_DDC_DONE',
    AUTH_FRICTIONLESS: '3DS_AUTH_FRICTIONLESS',
    CHALLENGE_STARTED: '3DS_CHALLENGE_STARTED',
    CHALLENGE_COMPLETE: '3DS_CHALLENGE_COMPLETE',
    CHALLENGE_TIMEOUT: '3DS_CHALLENGE_TIMEOUT',
    RESULT: '3DS_RESULT',
    PAYMENT_RESULT: 'PAYMENT_RESULT',
    ERROR: 'ERROR'
  };

  // Eventos que encerram o fluxo: o app nativo pode fechar a WebView ao recebê-los.
  var TERMINAL_EVENTS = [EVENTS.PAYMENT_RESULT, EVENTS.ERROR, EVENTS.CHALLENGE_TIMEOUT];

  /**
   * Interpreta uma mensagem recebida do bridge da WebView (Android
   * `AutraBridge.postMessage(json)`, iOS `WKScriptMessage.body`, React Native
   * `onMessage(event.nativeEvent.data)` ou `window.postMessage`).
   *
   * Aceita string JSON ou objeto já parseado. Nunca lança: entrada inválida
   * vira `{ ok: false, event: 'UNKNOWN', ... }`.
   *
   * @param {string|object} raw
   * @returns {{ ok: boolean, event: string, data: object, terminal: boolean, success: boolean|null, summary: string }}
   */
  function interpretMessage(raw) {
    var msg = raw;
    if (typeof raw === 'string') {
      try {
        msg = JSON.parse(raw);
      } catch (e) {
        return unknown('mensagem não é JSON válido');
      }
    }
    if (!msg || typeof msg !== 'object' || typeof msg.event !== 'string') {
      return unknown('mensagem sem campo "event"');
    }
    var data = msg.data && typeof msg.data === 'object' ? msg.data : {};
    var event = msg.event;
    var terminal = TERMINAL_EVENTS.indexOf(event) !== -1;
    var success = null;
    var summary;

    switch (event) {
      case EVENTS.SETUP_DONE:
        summary = 'setup concluído (requestId ' + (data.requestId || '?') + ')';
        break;
      case EVENTS.DDC_DONE:
        summary = data.timedOut
          ? 'coleta de dispositivo sem resposta em 5 s (seguindo mesmo assim)'
          : 'coleta de dispositivo concluída';
        break;
      case EVENTS.AUTH_FRICTIONLESS:
        summary = 'autenticada sem desafio (frictionless)';
        break;
      case EVENTS.CHALLENGE_STARTED:
        summary = 'desafio iniciado: o portador precisa interagir com o iframe';
        break;
      case EVENTS.CHALLENGE_COMPLETE:
        summary = 'desafio respondido pelo ACS; consultando resultado';
        break;
      case EVENTS.CHALLENGE_TIMEOUT:
        success = false;
        summary = 'desafio expirou (5 min) sem resposta do portador';
        break;
      case EVENTS.RESULT:
        summary = 'resultado 3DS: ' + describeIndicators(data).summary;
        break;
      case EVENTS.PAYMENT_RESULT:
        success = data.status === 'ACCEPTED';
        summary = success
          ? 'venda aprovada (paymentID ' + (data.paymentID || '?') + ')'
          : 'venda não aprovada (status ' + (data.status || '?') + ')';
        break;
      case EVENTS.ERROR:
        success = false;
        summary = 'erro ' + (data.code || '?') + ': ' + (data.msg || '') +
          (data.requestId ? ' [requestId ' + data.requestId + ']' : '');
        break;
      default:
        return unknown('evento desconhecido: ' + event, msg);
    }
    return { ok: true, event: event, data: data, terminal: terminal, success: success, summary: summary };

    function unknown(why, original) {
      return { ok: false, event: 'UNKNOWN', data: original || {}, terminal: false, success: null, summary: why };
    }
  }

  /**
   * Monta o objeto `threeDsData` que vai no POST /v1/acquiring/payments a
   * partir da resposta de `3ds/authenticate` (frictionless) ou de
   * `3ds/challenge-result`. Os dois retornam o mesmo formato.
   *
   * Lança se faltarem campos essenciais (cavv/eci) — não dá pra vender sem eles.
   */
  function buildThreeDsData(resp) {
    if (!resp || typeof resp !== 'object') throw new Error('resposta 3DS vazia');
    if (resp.code !== 'ACCEPTED') throw new Error('resposta 3DS com code ' + resp.code + ' (esperado ACCEPTED)');
    if (!resp.cavv || !resp.eci) throw new Error('resposta 3DS sem cavv/eci: não autenticada');
    return {
      cavv: resp.cavv,
      cavvResultCode: resp.cavvResultCode || '',
      // A Dock devolve ora `secureVersion`, ora `specificationVersion`; a venda usa `secureVersion`.
      secureVersion: resp.secureVersion || resp.specificationVersion || '',
      directoryServerTransactionId: resp.directoryServerTransactionId || '',
      threeDsServerTransactionId: resp.threeDsServerTransactionId || '',
      authenticationId: resp.authenticationId || '',
      eci: resp.eci,
      status: resp.status || 'AUTHENTICATED'
    };
  }

  /** true quando o authenticate pediu desafio (step-up). */
  function isChallenge(resp) {
    return !!resp && resp.code === 'WAITING_3DS_AUTHENTICATION' && !!resp.stepUpUrl;
  }

  /**
   * Traduz os indicadores do PDT (resposta da Cardinal/Dock) em texto.
   *   vres_enrolled: Y participante | N não participante | U DS/ACS indisponível | B ignorado por regra do EC
   *   eciRaw: 02/05 autenticada | 01/06 tentativa | 00/07 não 3DS
   */
  function describeIndicators(d) {
    d = d || {};
    var eci = d.eciRaw || d.eci || '';
    var enrolled = d.vres_enrolled || '';
    var eciText = ({
      '02': 'totalmente autenticada (Mastercard)',
      '05': 'totalmente autenticada (Visa/Elo/outras)',
      '01': 'tentativa de autenticação (Mastercard)',
      '06': 'tentativa de autenticação (Visa/Elo/outras)',
      '00': 'não autenticada por 3DS (Mastercard)',
      '07': 'não autenticada por 3DS (Visa/Elo/outras)'
    })[eci] || 'ECI desconhecido (' + (eci || 'vazio') + ')';
    var enrolledText = ({
      Y: 'cartão participante do 3DS',
      N: 'cartão não participante',
      U: 'DS/ACS indisponível',
      B: 'autenticação ignorada por regra do estabelecimento'
    })[enrolled] || 'vres_enrolled não informado';
    var fullyAuthenticated = eci === '02' || eci === '05';
    var attempt = eci === '01' || eci === '06';
    return {
      eci: eci,
      enrolled: enrolled,
      fullyAuthenticated: fullyAuthenticated,
      attempt: attempt,
      // Com ECI 02/05 (ou 01/06, conforme regra da bandeira) a responsabilidade
      // por fraude ("liability shift") tende a ser do emissor. Confirme com a Autra.
      liabilityShift: fullyAuthenticated || attempt,
      summary: eciText + '; ' + enrolledText
    };
  }

  return {
    EVENTS: EVENTS,
    TERMINAL_EVENTS: TERMINAL_EVENTS,
    interpretMessage: interpretMessage,
    buildThreeDsData: buildThreeDsData,
    isChallenge: isChallenge,
    describeIndicators: describeIndicators
  };
});
