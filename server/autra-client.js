'use strict';
/*
 * Cliente mínimo do core da Autra.
 *
 * - Obtém o token OAuth (client_credentials) e o mantém em cache até expirar.
 * - Em 401/403 renova o token e repete a chamada UMA vez.
 * - Erros do core chegam no envelope { errors: [{ code, msg, requestId }] };
 *   o chamador recebe status + corpo para repassar ao cliente.
 *
 * Usa o fetch global do Node (>= 18). Sem dependências.
 */

class AutraError extends Error {
  constructor(status, body) {
    const first = body && Array.isArray(body.errors) ? body.errors[0] : null;
    super(first ? `${first.code}: ${first.msg}` : `HTTP ${status}`);
    this.status = status;
    // Corpo no formato do core, para o endpoint de exemplo repassar como veio.
    this.body = body && typeof body === 'object'
      ? body
      : { errors: [{ code: 'UPSTREAM_ERROR', msg: String(body || `HTTP ${status}`), requestId: '' }] };
  }
}

class AutraClient {
  /**
   * @param {{ baseUrl: string, clientId: string, clientSecret: string }} cfg
   */
  constructor(cfg) {
    if (!cfg.clientId || !cfg.clientSecret) {
      throw new Error('AUTRA_CLIENT_ID e AUTRA_CLIENT_SECRET são obrigatórios (veja .env.example)');
    }
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.clientId = cfg.clientId;
    this.clientSecret = cfg.clientSecret;
    this.token = null;       // accessToken OAuth — NUNCA sai do servidor
    this.tokenExpiresAt = 0; // epoch ms
  }

  /** POST /v1/oauth/token?grant_type=client_credentials com Basic auth. */
  async fetchToken() {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await fetch(`${this.baseUrl}/v1/oauth/token?grant_type=client_credentials`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' }
    });
    const body = await readJson(res);
    if (!res.ok || !body || !body.accessToken) throw new AutraError(res.status, body);
    this.token = body.accessToken;
    // Renova 30 s antes de expirar para não cair em 401 por relógio.
    this.tokenExpiresAt = Date.now() + Math.max(0, (Number(body.expiresIn) || 300) - 30) * 1000;
    return this.token;
  }

  async getToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    return this.fetchToken();
  }

  /**
   * Chamada autenticada ao core. Retorna o JSON da resposta ou lança AutraError
   * com status + corpo originais.
   */
  async call(method, path, payload, { retried = false } = {}) {
    const token = await this.getToken();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: payload === undefined ? undefined : JSON.stringify(payload)
    });
    if ((res.status === 401 || res.status === 403) && !retried) {
      // Token expirado/revogado: renova e repete uma única vez.
      this.token = null;
      await res.text().catch(() => '');
      return this.call(method, path, payload, { retried: true });
    }
    const body = await readJson(res);
    if (!res.ok) throw new AutraError(res.status, body);
    return body;
  }

  // ---- Operações usadas pelo exemplo -------------------------------------

  /** POST /v1/acquiring/payments/initialize → { code: "ACCEPTED", transactionalToken } */
  initialize(documentId) {
    return this.call('POST', '/v1/acquiring/payments/initialize', { documentId });
  }

  /** POST /v1/acquiring/payments/3ds/setup → { requestId, referenceId, accessToken (JWT Cardinal), deviceDataCollectionUrl, ... } */
  threeDsSetup(payload) {
    return this.call('POST', '/v1/acquiring/payments/3ds/setup', payload);
  }

  /** POST /v1/acquiring/payments/3ds/authenticate → frictionless (ACCEPTED) ou desafio (WAITING_3DS_AUTHENTICATION) */
  threeDsAuthenticate(payload) {
    return this.call('POST', '/v1/acquiring/payments/3ds/authenticate', payload);
  }

  /** POST /v1/acquiring/payments/3ds/challenge-result → mesmos campos do frictionless */
  threeDsChallengeResult(payload) {
    return this.call('POST', '/v1/acquiring/payments/3ds/challenge-result', payload);
  }

  /** POST /v1/acquiring/payments → { paymentID, status, authorizationCode, nsu, rrn, trackingNumber } */
  createPayment(payload) {
    return this.call('POST', '/v1/acquiring/payments', payload);
  }
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return text;
  }
}

module.exports = { AutraClient, AutraError };
