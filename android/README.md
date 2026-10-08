# Android — trechos de referência (Kotlin)

Trechos para o app nativo hospedar `3ds.html` numa `WebView` e receber os
eventos do fluxo. **Não é um projeto compilável**; copie o que precisar.

Pontos de atenção:

- `javaScriptEnabled` e `domStorageEnabled` são obrigatórios: a Cardinal usa
  JavaScript e `localStorage` nos iframes de coleta e de desafio.
- Os iframes são **cross-origin** (`centinelapi.cardinalcommerce.com`, ACS do
  emissor, seu `returnUrl`). Isso funciona normalmente na WebView; não há
  nada a configurar além do JavaScript.
- `window.AutraBridge.postMessage(json)` é o canal da página para o app. O nome
  `AutraBridge` precisa ser exatamente este (veja `web/3ds.js`).
- O `returnUrl` enviado no `authenticate` deve ser **https público** em
  produção: a Cardinal/ACS faz um form POST nele a partir da internet.
- Nunca intercepte, registre ou persista o conteúdo dos iframes nem o PAN/CVV.

## `ThreeDsWebViewActivity.kt`

Veja [`ThreeDsWebViewActivity.kt`](./ThreeDsWebViewActivity.kt).
