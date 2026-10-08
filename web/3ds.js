/*
 * Lógica da página que roda DENTRO da WebView. Sem framework.
 *
 * Fluxo:
 *   (a) POST /api/3ds/setup           → requestId, referenceId, JWT da Cardinal, deviceDataCollectionUrl
 *   (b) coleta de dispositivo         → form POST {JWT} em iframe OCULTO; espera até 5 s por message {Status}
 *   (c) POST /api/3ds/authenticate    → frictionless (ACCEPTED) ou desafio (WAITING_3DS_AUTHENTICATION)
 *   (d) desafio                       → form POST {JWT, MD} em iframe VISÍVEL; espera até 5 min por
 *                                       message {type:'3DS_CHALLENGE_COMPLETE'} vindo do returnUrl;
 *                                       depois POST /api/3ds/challenge-result
 *   (e) POST /api/pay                 → venda com threeDsData
 *   (f) cada etapa publica um evento para o app nativo via notifyNative()
 *
 * Estados visuais (atributo data-stage no <body>, ver 3ds.html):
 *   form → processing ("Verificando seu dispositivo…") → challenge ("Autenticação adicional")
 *   → processing → result (aprovado / falha). O log técnico fica em <details> (#status).
 */
(function () {
  'use strict';
  var core = window.AutraThreeDS;
  var EV = core.EVENTS;
  var DDC_TIMEOUT_MS = 5000;
  var CHALLENGE_TIMEOUT_MS = 5 * 60 * 1000;

  var $ = function (id) { return document.getElementById(id); };
  var statusEl = $('status');

  function log(line) {
    statusEl.textContent += line + '\n';
  }

  // ---- UI: estados, status acessível e resultado -------------------------------
  function announce(text) {
    $('status-live').textContent = text;
  }

  function setStage(stage) {
    document.body.setAttribute('data-stage', stage);
    window.scrollTo(0, 0);
  }

  function setProcessing(title, text) {
    $('processing-title').textContent = title;
    $('processing-text').textContent = text || 'Isso leva só alguns segundos. Não feche esta tela.';
    announce(title);
    setStage('processing');
  }

  function formatBRL(v) {
    var n = Number(String(v).replace(',', '.'));
    if (!isFinite(n)) n = 0;
    return 'R$ ' + n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  function syncAmount() {
    var txt = formatBRL($('amount').value);
    $('summary-amount').textContent = txt;
    $('pay-label').textContent = 'Pagar ' + txt;
  }

  /** Mostra o card de resultado. fields: [[rótulo, valor], ...] */
  function showResult(ok, title, msg, amount, fields) {
    var box = $('result');
    box.className = 'result ' + (ok ? 'ok' : 'fail');
    $('result-icon-ok').style.display = ok ? '' : 'none';
    $('result-icon-fail').style.display = ok ? 'none' : '';
    $('result-title').textContent = title;
    $('result-msg').textContent = msg || '';
    $('result-amount').textContent = amount ? formatBRL(amount) : '';
    $('result-amount').style.display = amount ? '' : 'none';
    var dl = $('result-fields');
    dl.textContent = '';
    (fields || []).forEach(function (pair) {
      if (pair[1] === undefined || pair[1] === null || pair[1] === '') return;
      var dt = document.createElement('dt');
      dt.textContent = pair[0];
      var dd = document.createElement('dd');
      dd.textContent = String(pair[1]);
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
    dl.style.display = dl.childNodes.length ? '' : 'none';
    announce(title + (msg ? '. ' + msg : ''));
    setStage('result');
  }

  // ---- (f) ponte com o app nativo -------------------------------------------
  // Uma única função tenta, nesta ordem, os canais conhecidos. O app só precisa
  // implementar o seu. O último (window.parent) cobre o teste no navegador.
  function notifyNative(event, data) {
    var msg = { event: event, data: data || {} };
    var json = JSON.stringify(msg);
    try {
      if (window.AutraBridge && typeof window.AutraBridge.postMessage === 'function') {
        window.AutraBridge.postMessage(json); // Android: addJavascriptInterface(obj, "AutraBridge")
        return;
      }
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.AutraBridge) {
        window.webkit.messageHandlers.AutraBridge.postMessage(msg); // iOS: WKScriptMessageHandler "AutraBridge"
        return;
      }
      if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
        window.ReactNativeWebView.postMessage(json); // React Native WebView
        return;
      }
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(msg, '*'); // página embutida em outra página
      }
    } catch (e) {
      /* ponte indisponível: ignora */
    }
    log('[nativo] ' + event + ' ' + json);
  }

  // ---- helpers HTTP ---------------------------------------------------------
  async function post(path, body) {
    var res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    });
    var json = null;
    try { json = await res.json(); } catch (e) { /* corpo vazio */ }
    if (!res.ok) {
      var first = json && json.errors && json.errors[0] ? json.errors[0] : { code: 'HTTP_' + res.status, msg: res.statusText, requestId: '' };
      var err = new Error(first.msg || first.code);
      err.autra = first;
      err.status = res.status;
      throw err;
    }
    return json;
  }

  /** Cria e auto-submete um <form method=POST> para o iframe indicado. */
  function postForm(action, target, fields) {
    var form = document.createElement('form');
    form.method = 'POST';
    form.action = action;
    form.target = target;
    form.style.display = 'none';
    Object.keys(fields).forEach(function (k) {
      var input = document.createElement('input');
      input.type = 'hidden';
      input.name = k;
      input.value = fields[k];
      form.appendChild(input);
    });
    document.body.appendChild(form);
    form.submit();
    form.remove();
  }

  /**
   * Espera um `message` cujo `data` satisfaça `predicate`, com timeout.
   * Resolve { data, timedOut }.
   */
  function waitForMessage(predicate, timeoutMs) {
    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        window.removeEventListener('message', onMessage);
        resolve({ data: null, timedOut: true });
      }, timeoutMs);
      function onMessage(ev) {
        var data = ev.data;
        if (typeof data === 'string') {
          try { data = JSON.parse(data); } catch (e) { return; }
        }
        if (!data || typeof data !== 'object' || !predicate(data)) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve({ data: data, timedOut: false });
      }
      window.addEventListener('message', onMessage);
    });
  }

  function deviceInformation() {
    return {
      httpBrowserLanguage: navigator.language || 'pt-BR',
      httpBrowserJavaEnabled: typeof navigator.javaEnabled === 'function' ? navigator.javaEnabled() : false,
      httpBrowserColorDepth: screen.colorDepth,
      httpBrowserScreenHeight: screen.height,
      httpBrowserScreenWidth: screen.width,
      httpBrowserTimeDifference: new Date().getTimezoneOffset(),
      userAgentBrowserValue: navigator.userAgent,
      httpAcceptContent: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    };
  }

  // ---- fluxo principal --------------------------------------------------------
  async function run(card, amount) {
    // (a) setup
    setProcessing('Verificando seu dispositivo…');
    var setup = await post('/api/3ds/setup', {
      cardNumber: card.number,
      cardExpirationDate: card.expirationDate,
      cardHolderName: card.holderName
    });
    notifyNative(EV.SETUP_DONE, { requestId: setup.requestId, referenceId: setup.referenceId });

    // (b) coleta de dispositivo: iframe oculto, só o JWT da Cardinal.
    var ddcWait = waitForMessage(function (d) { return Object.prototype.hasOwnProperty.call(d, 'Status'); }, DDC_TIMEOUT_MS);
    postForm(setup.deviceDataCollectionUrl, 'ddc-iframe', { JWT: setup.accessToken });
    var ddc = await ddcWait; // Cardinal: { MessageType: "profile.completed", SessionId, Status: true }
    notifyNative(EV.DDC_DONE, { timedOut: ddc.timedOut, sessionId: ddc.data ? ddc.data.SessionId : null });
    // Sem resposta em 5 s seguimos mesmo assim: a Cardinal usa o que tiver coletado.

    // (c) authenticate
    setProcessing('Autenticando com o emissor…', 'Estamos consultando o banco do seu cartão.');
    var auth = await post('/api/3ds/authenticate', {
      transactionalToken: setup.transactionalToken,
      requestId: setup.requestId,
      referenceId: setup.referenceId,
      cardNumber: card.number,
      cardExpirationDate: card.expirationDate,
      cardHolderName: card.holderName,
      amount: amount,
      billTo: { firstName: card.holderName.split(' ')[0], lastName: card.holderName.split(' ').slice(1).join(' ') || 'Teste' },
      deviceInformation: deviceInformation()
    });

    var final;
    if (core.isChallenge(auth)) {
      // (d) desafio: iframe visível com JWT + MD (MD = authenticationId, volta no returnUrl).
      notifyNative(EV.CHALLENGE_STARTED, { authenticationId: auth.authenticationId, stepUpUrl: auth.stepUpUrl });
      announce('Autenticação adicional. Confirme no seu banco para concluir o pagamento.');
      setStage('challenge');
      var challengeWait = waitForMessage(function (d) { return d.type === '3DS_CHALLENGE_COMPLETE'; }, CHALLENGE_TIMEOUT_MS);
      postForm(auth.stepUpUrl, 'challenge-iframe', { JWT: auth.accessToken, MD: auth.authenticationId });
      var ch = await challengeWait;
      setProcessing('Confirmando autenticação…');
      if (ch.timedOut) {
        notifyNative(EV.CHALLENGE_TIMEOUT, { authenticationId: auth.authenticationId });
        throw Object.assign(new Error('desafio expirou'), { autra: { code: 'CHALLENGE_TIMEOUT', msg: 'desafio expirou sem resposta', requestId: '' } });
      }
      var allFields = ch.data.allFields || {};
      notifyNative(EV.CHALLENGE_COMPLETE, { md: ch.data.md, hasJwt: !!ch.data.jwt });
      final = await post('/api/3ds/challenge-result', {
        transactionalToken: setup.transactionalToken,
        requestId: setup.requestId,
        authenticationTransactionId: allFields.TransactionId || ch.data.md || auth.authenticationId
      });
    } else {
      notifyNative(EV.AUTH_FRICTIONLESS, { authenticationId: auth.authenticationId, eci: auth.eci });
      final = auth;
    }

    // (e) venda com threeDsData
    var threeDsData = core.buildThreeDsData(final);
    var indicators = core.describeIndicators(final);
    notifyNative(EV.RESULT, {
      threeDsData: threeDsData,
      eci: final.eci,
      eciRaw: final.eciRaw,
      vres_enrolled: final.vres_enrolled,
      interpretation: indicators.summary
    });

    setProcessing('Processando pagamento…', 'Autenticação concluída. Enviando a cobrança.');
    var pay = await post('/api/pay', {
      transactionalToken: setup.transactionalToken,
      amount: amount,
      card: { number: card.number, expirationDate: card.expirationDate, securityCode: card.securityCode, holderName: card.holderName },
      payerName: card.holderName,
      threeDsData: threeDsData
    });
    notifyNative(EV.PAYMENT_RESULT, {
      paymentID: pay.paymentID,
      status: pay.status,
      authorizationCode: pay.authorizationCode,
      nsu: pay.nsu,
      rrn: pay.rrn,
      trackingNumber: pay.trackingNumber
    });

    var approved = pay.status === 'ACCEPTED';
    showResult(
      approved,
      approved ? 'Pagamento aprovado' : 'Pagamento não aprovado',
      approved ? 'Autenticação 3-D Secure concluída.' : 'A venda voltou com status ' + (pay.status || 'desconhecido') + '.',
      amount,
      [
        ['Autorização', pay.authorizationCode],
        ['NSU', pay.nsu],
        ['ID do pagamento', pay.paymentID],
        ['3DS', indicators.summary]
      ]
    );
  }

  function friendlyError(e, httpStatus) {
    switch (e.code) {
      case 'CHALLENGE_TIMEOUT': return 'A confirmação no banco não chegou a tempo. Tente novamente.';
      case 'MISSING_FIELDS': return 'Preencha todos os campos do cartão.';
      default:
        if (httpStatus === 402) return 'O emissor recusou a transação. Verifique os dados ou use outro cartão.';
        if (httpStatus >= 500) return 'Não foi possível concluir agora. Tente novamente em instantes.';
        return e.msg || 'Não foi possível concluir o pagamento.';
    }
  }

  $('card-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    statusEl.textContent = '';
    $('pay').disabled = true;
    var card = {
      number: $('number').value.replace(/\s/g, ''),
      expirationDate: $('exp').value.replace(/\D/g, ''),
      securityCode: $('cvv').value,
      holderName: $('holder').value.trim()
    };
    var amount = $('amount').value.replace(',', '.');
    run(card, amount)
      .catch(function (err) {
        var e = err.autra || { code: 'UNEXPECTED', msg: err.message, requestId: '' };
        notifyNative(EV.ERROR, { code: e.code, msg: e.msg, requestId: e.requestId, httpStatus: err.status });
        showResult(false, 'Não foi possível concluir', friendlyError(e, err.status), null, [
          ['Código', e.code],
          ['Mensagem', e.msg],
          ['requestId', e.requestId],
          ['HTTP', err.status]
        ]);
      })
      .finally(function () { $('pay').disabled = false; });
  });

  $('again').addEventListener('click', function () {
    announce('');
    setStage('form');
    $('number').focus();
  });

  $('amount').addEventListener('input', syncAmount);
  syncAmount();
})();
