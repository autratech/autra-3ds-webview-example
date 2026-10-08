'use strict';
/*
 * Backend de exemplo: guarda as credenciais da Autra e expõe para a WebView
 * endpoints simples (/api/3ds/*, /api/pay). A WebView nunca vê client_secret
 * nem o accessToken OAuth; só recebe o JWT da Cardinal, que é específico da
 * sessão 3DS.
 *
 * ATENÇÃO (PCI): este exemplo recebe PAN/CVV no backend para simplificar. Em
 * produção prefira página hospedada ou `tokenData` (cartão tokenizado) e nunca
 * registre PAN/CVV em log.
 */
require('dotenv').config();
const path = require('path');
const express = require('express');
const { AutraClient, AutraError } = require('./autra-client');
const core = require('../shared/threeds-core');

const PORT = Number(process.env.PORT || 3000);
const DOCUMENT_ID = process.env.AUTRA_DOCUMENT_ID || '';
const PUBLIC_RETURN_URL = process.env.PUBLIC_RETURN_URL || `http://localhost:${PORT}/api/3ds/return`;

const autra = new AutraClient({
  baseUrl: process.env.AUTRA_BASE_URL || 'https://api.sandbox.autra.io',
  clientId: process.env.AUTRA_CLIENT_ID,
  clientSecret: process.env.AUTRA_CLIENT_SECRET
});

const app = express();
app.set('trust proxy', true); // para req.ip refletir X-Forwarded-For atrás de proxy/túnel
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false })); // a Cardinal faz form POST no returnUrl

// Página da WebView e módulo compartilhado.
app.use(express.static(path.join(__dirname, '..', 'web')));
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));

/**
 * POST /api/3ds/setup
 * body: { cardNumber, cardExpirationDate (MMAAAA), cardHolderName }
 * → { requestId, referenceId, accessToken (JWT Cardinal), deviceDataCollectionUrl, transactionalToken }
 */
app.post('/api/3ds/setup', wrap(async (req, res) => {
  const { cardNumber, cardExpirationDate, cardHolderName } = req.body || {};
  requireFields({ cardNumber, cardExpirationDate, cardHolderName });

  const init = await autra.initialize(DOCUMENT_ID);
  if (init.code !== 'ACCEPTED' || !init.transactionalToken) {
    throw new AutraError(502, { errors: [{ code: 'INIT_FAILED', msg: `initialize respondeu ${init.code}`, requestId: '' }] });
  }

  const setup = await autra.threeDsSetup({
    documentId: DOCUMENT_ID,
    transactionalToken: init.transactionalToken,
    cardNumber,
    cardExpirationDate,
    cardHolderName
  });

  res.json({
    requestId: setup.requestId,
    referenceId: setup.referenceId,
    accessToken: setup.accessToken, // JWT da Cardinal para a coleta de dispositivo (não é o OAuth)
    deviceDataCollectionUrl: setup.deviceDataCollectionUrl,
    transactionalToken: init.transactionalToken
  });
}));

/**
 * POST /api/3ds/authenticate
 * body: { transactionalToken, requestId, referenceId, card:{...}, amount, billTo, deviceInformation }
 * → resposta do core como veio (frictionless ou desafio)
 */
app.post('/api/3ds/authenticate', wrap(async (req, res) => {
  const b = req.body || {};
  requireFields({
    transactionalToken: b.transactionalToken,
    requestId: b.requestId,
    referenceId: b.referenceId,
    cardNumber: b.cardNumber,
    cardExpirationDate: b.cardExpirationDate,
    cardHolderName: b.cardHolderName
  });
  const billTo = b.billTo || {};
  const dev = b.deviceInformation || {};

  const payload = {
    documentId: DOCUMENT_ID,
    transactionalToken: b.transactionalToken,
    cardNumber: b.cardNumber,
    cardExpirationDate: b.cardExpirationDate,
    cardHolderName: b.cardHolderName,
    requestId: b.requestId,
    referenceId: b.referenceId,
    type: 'CREDIT',
    deviceChannel: 'Browser',
    transactionMode: 'S',   // S = e-commerce
    acsWindowSize: '05',    // 05 = 100% da janela (iframe de desafio em tela cheia)
    merchantUrl: b.merchantUrl || PUBLIC_RETURN_URL.replace(/\/api\/3ds\/return$/, ''),
    orderInformation: {
      amountDetails: { currency: 'BRL', totalAmount: formatAmount(b.amount) },
      billTo: {
        firstName: billTo.firstName || 'Cliente',
        lastName: billTo.lastName || 'Teste',
        email: billTo.email || 'cliente@example.com',
        country: 'BR',
        phoneNumber: billTo.phoneNumber || '11999999999',
        postalCode: billTo.postalCode || '01001000',
        address1: billTo.address1 || 'Praca da Se, 1',
        administrativeArea: billTo.administrativeArea || 'SP',
        locality: billTo.locality || 'Sao Paulo'
      }
    },
    buyerInformation: { mobilePhone: billTo.phoneNumber || '11999999999' },
    deviceInformation: {
      httpBrowserLanguage: dev.httpBrowserLanguage || 'pt-BR',
      httpBrowserJavaEnabled: String(dev.httpBrowserJavaEnabled ?? 'false'),
      httpBrowserColorDepth: String(dev.httpBrowserColorDepth || '24'),
      httpBrowserScreenHeight: String(dev.httpBrowserScreenHeight || '0'),
      httpBrowserScreenWidth: String(dev.httpBrowserScreenWidth || '0'),
      httpBrowserTimeDifference: String(dev.httpBrowserTimeDifference || '0'),
      userAgentBrowserValue: dev.userAgentBrowserValue || req.get('user-agent') || '',
      httpAcceptContent: dev.httpAcceptContent || req.get('accept') || '*/*',
      ipAddress: clientIp(req) // injetado pelo servidor; a WebView não sabe o próprio IP público
    },
    returnUrl: PUBLIC_RETURN_URL
  };

  const out = await autra.threeDsAuthenticate(payload);
  res.json(out);
}));

/**
 * POST /api/3ds/challenge-result
 * body: { transactionalToken, authenticationTransactionId, requestId }
 * → mesmos campos do frictionless
 */
app.post('/api/3ds/challenge-result', wrap(async (req, res) => {
  const { transactionalToken, authenticationTransactionId, requestId } = req.body || {};
  requireFields({ transactionalToken, authenticationTransactionId, requestId });
  const out = await autra.threeDsChallengeResult({
    documentId: DOCUMENT_ID,
    transactionalToken,
    authenticationTransactionId,
    requestId
  });
  res.json(out);
}));

/**
 * POST /api/pay
 * body: { transactionalToken, amount, orderId, card:{number, expirationDate, securityCode, holderName},
 *         payerName, payerDocument, payerEmail, threeDsData }
 * → { paymentID, status, authorizationCode, nsu, rrn, trackingNumber }
 */
app.post('/api/pay', wrap(async (req, res) => {
  const b = req.body || {};
  requireFields({ transactionalToken: b.transactionalToken, card: b.card, threeDsData: b.threeDsData });
  const out = await autra.createPayment({
    documentId: DOCUMENT_ID,
    transactionalToken: b.transactionalToken,
    transactionType: 'CREDIT',
    amount: Number(b.amount || 12),
    currency: 'BRL',
    installments: 1,
    orderId: b.orderId || `3ds-example-${Date.now()}`,
    card: {
      number: b.card.number,
      expirationDate: b.card.expirationDate, // MMAAAA
      securityCode: b.card.securityCode,
      holderName: b.card.holderName
    },
    payerName: b.payerName || b.card.holderName,
    payerDocument: b.payerDocument || '12345678909',
    payerEmail: b.payerEmail || 'cliente@example.com',
    threeDsData: b.threeDsData
  });
  res.json(out);
}));

/**
 * /api/3ds/return — returnUrl enviado no authenticate. A Cardinal/ACS faz um
 * form POST aqui (campos `Response` ou `JWT`, e `MD`) quando o desafio termina.
 * Respondemos um HTML mínimo que avisa a página pai (3ds.html) via postMessage.
 * Em produção esta URL precisa ser https e pública.
 */
function returnPage(fields) {
  const jwt = fields.Response || fields.JWT || fields.jwt || '';
  const md = fields.MD || fields.md || '';
  const msg = { type: '3DS_CHALLENGE_COMPLETE', jwt, md, allFields: fields };
  // JSON dentro de <script>: escapa "<" para não fechar a tag.
  const json = JSON.stringify(msg).replace(/</g, '\\u003c');
  // Mesmo visual da 3ds.html (branding Autra). Esta página aparece dentro do
  // iframe do desafio por um instante, até a página pai receber o postMessage.
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light">
<title>Autenticação concluída — Autra</title>
<link rel="icon" type="image/png" href="/assets/autra-favicon-green.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;700;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}html,body{margin:0;overflow-x:hidden}
body{font-family:"Plus Jakarta Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#171717;background:#FAFAFA linear-gradient(180deg,#FDFFF0 0%,#FAFAFA 220px);min-height:100vh;padding:16px;-webkit-font-smoothing:antialiased}
.page{max-width:440px;margin:0 auto}.header{padding:8px 0 20px}.header img{height:28px;width:auto;display:block}
.card{background:#fff;border-radius:24px;box-shadow:0 25px 50px -12px rgba(10,10,10,.18);padding:32px 20px;text-align:center}
.icon{width:64px;height:64px;border-radius:50%;background:#0A0A0A;margin:0 auto 16px;display:flex;align-items:center;justify-content:center}
.icon svg{width:30px;height:30px}h1{font-size:20px;font-weight:800;margin:0 0 6px;letter-spacing:-.01em}p{color:#525252;font-size:14px;margin:0}
.spinner{width:28px;height:28px;margin:20px auto 0;border-radius:50%;border:3px solid #EAF9B2;border-top-color:#0A0A0A;animation:spin .9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head>
<body><main class="page"><header class="header"><img src="/assets/logo-autra-dark.png" alt="Autra"></header>
<div class="card" role="status" aria-live="polite">
<div class="icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="#D7F274" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L19 7"/></svg></div>
<h1>Autenticação concluída</h1><p>Retornando ao aplicativo…</p><div class="spinner" aria-hidden="true"></div>
</div></main>
<script>try{window.parent.postMessage(${json},'*')}catch(e){}</script></body></html>`;
}
app.post('/api/3ds/return', (req, res) => res.type('html').send(returnPage(req.body || {})));
app.get('/api/3ds/return', (req, res) => res.type('html').send(returnPage(req.query || {})));

app.get('/api/health', (req, res) => res.json({ ok: true, baseUrl: autra.baseUrl, documentId: DOCUMENT_ID }));

// ---- utilitários -----------------------------------------------------------

function wrap(handler) {
  return (req, res) => handler(req, res).catch((err) => {
    if (err instanceof AutraError) {
      // Repassa status e envelope do core sem alterar.
      return res.status(err.status).json(err.body);
    }
    console.error('[3ds-example] erro inesperado:', err.message);
    res.status(500).json({ errors: [{ code: 'INTERNAL_ERROR', msg: err.message, requestId: '' }] });
  });
}

function requireFields(obj) {
  const missing = Object.keys(obj).filter((k) => obj[k] === undefined || obj[k] === null || obj[k] === '');
  if (missing.length) {
    throw new AutraError(400, { errors: [{ code: 'MISSING_FIELDS', msg: `campos obrigatórios: ${missing.join(', ')}`, requestId: '' }] });
  }
}

/** "12" → "12.00"; "12.53" → "12.53". totalAmount do authenticate é string com 2 casas. */
function formatAmount(v) {
  const n = Number(v);
  return (Number.isFinite(n) && n > 0 ? n : 12).toFixed(2);
}

/** IP do cliente; normaliza loopback IPv6 para IPv4 (a Cardinal espera um IP válido). */
function clientIp(req) {
  let ip = req.ip || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1' || ip === '') ip = '127.0.0.1';
  return ip;
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`3DS example em http://localhost:${PORT}/3ds.html (core: ${autra.baseUrl})`);
    console.log(`returnUrl: ${PUBLIC_RETURN_URL}`);
  });
}

module.exports = { app, returnPage, formatAmount, clientIp, core };
