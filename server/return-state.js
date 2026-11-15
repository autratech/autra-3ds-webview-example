'use strict';
const { randomBytes } = require('node:crypto');

// Exemplo single-process. Em múltiplas instâncias, usar armazenamento compartilhado
// com expiração e consumo atômico. Não guarda cartão, token OAuth ou JWT 3DS.
class ReturnStates {
  constructor({ now = Date.now, ttlMs = 5 * 60 * 1000, maxEntries = 1000 } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }
  create(requestId) {
    for (const [key, value] of this.entries) {
      if (value.expiresAt <= this.now()) this.entries.delete(key);
    }
    if (this.entries.size >= this.maxEntries) throw new Error('3DS callback capacity reached');
    const state = randomBytes(32).toString('base64url');
    this.entries.set(state, { requestId, expiresAt: this.now() + this.ttlMs });
    return state;
  }
  bind(state, authenticationId) {
    const value = this.entries.get(state);
    if (value) value.authenticationId = authenticationId;
  }
  discard(state) { this.entries.delete(state); }
  consume(state, authenticationId) {
    const value = this.entries.get(state);
    if (!value || !value.authenticationId || value.authenticationId !== authenticationId || value.expiresAt <= this.now()) return null;
    this.entries.delete(state);
    return { state, requestId: value.requestId, authenticationId };
  }
}
module.exports = { ReturnStates };
