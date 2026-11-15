(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AutraThreeDSMessages = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function waitForMessage(options) {
    var target = options.target;
    var origin = options.expectedOrigin;
    if (!origin || origin === '*' || origin === 'null' || !options.expectedSource) {
      throw new Error('Origem e iframe esperados são obrigatórios');
    }
    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        target.removeEventListener('message', onMessage);
        resolve({ data: null, timedOut: true });
      }, options.timeoutMs);
      function onMessage(ev) {
        if (ev.origin !== origin || ev.source !== options.expectedSource) return;
        var data = ev.data;
        if (typeof data === 'string') {
          try { data = JSON.parse(data); } catch (_e) { return; }
        }
        if (!data || typeof data !== 'object' || !options.predicate(data)) return;
        clearTimeout(timer);
        target.removeEventListener('message', onMessage);
        resolve({ data: data, timedOut: false });
      }
      target.addEventListener('message', onMessage);
    });
  }
  return { waitForMessage: waitForMessage };
});
