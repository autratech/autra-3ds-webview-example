# iOS — trechos de referência (Swift)

Trechos para o app nativo hospedar `3ds.html` numa `WKWebView` e receber os
eventos do fluxo. **Não é um projeto compilável**; copie o que precisar.

Pontos de atenção:

- `WKWebView` já executa JavaScript e permite `localStorage` por padrão; os
  iframes **cross-origin** da Cardinal/ACS/`returnUrl` funcionam sem
  configuração extra.
- O canal página → app é `window.webkit.messageHandlers.AutraBridge.postMessage(obj)`.
  Registre o handler com o nome exato `AutraBridge`.
- A página envia um **objeto** (não string) nesse canal; `message.body` chega
  como `[String: Any]`.
- O `returnUrl` enviado no `authenticate` deve ser **https público** em
  produção; a Cardinal/ACS faz um form POST nele a partir da internet. Com
  App Transport Security, `http://localhost` só funciona em simulador com
  exceção explícita no `Info.plist` — use https sempre que possível.
- Nunca intercepte, registre ou persista o conteúdo dos iframes nem o PAN/CVV.

## `ThreeDsWebViewController.swift`

Veja [`ThreeDsWebViewController.swift`](./ThreeDsWebViewController.swift).
