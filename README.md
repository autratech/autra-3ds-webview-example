# autra-3ds-webview-example

Exemplo de integração **3-D Secure (3DS 2)** com a API de adquirência da Autra
rodando **dentro de uma WebView** de app mobile, e de como o app nativo
(Android/iOS/React Native) interpreta o resultado.

Feito para integradores (ex.: Correios) que querem cobrar cartão de crédito no
app com autenticação do portador no emissor, sem embutir SDK de 3DS no app.

> Este repositório é um exemplo didático. Não é uma biblioteca suportada nem
> substitui a documentação oficial da Autra.

## Visão geral do fluxo

```
app nativo                 WebView (web/3ds.html)             seu backend (server/)            core Autra
----------                 ----------------------             ---------------------            ----------
abre 3ds.html  ─────────▶  formulário de cartão
                           POST /api/3ds/setup  ────────────▶ POST /v1/oauth/token ─────────▶ accessToken OAuth (fica no backend)
                                                              POST /v1/acquiring/payments/initialize ─▶ transactionalToken
                                                              POST .../3ds/setup ───────────▶ requestId, referenceId,
                           ◀──────────────────────────────── JWT Cardinal, deviceDataCollectionUrl
◀── 3DS_SETUP_DONE
                           form POST {JWT} em iframe OCULTO ─────────────────────────────────▶ Cardinal (coleta de dispositivo)
                           espera até 5 s por message {Status}
◀── 3DS_DDC_DONE
                           POST /api/3ds/authenticate ──────▶ POST .../3ds/authenticate ──────▶ DS / ACS do emissor
                           ◀─── ACCEPTED (frictionless)  ou  WAITING_3DS_AUTHENTICATION {stepUpUrl, accessToken, authenticationId}
◀── 3DS_AUTH_FRICTIONLESS                │
                                         └─▶ form POST {JWT, MD} em iframe VISÍVEL ─────────▶ ACS (desafio: senha, OTP, biometria…)
◀── 3DS_CHALLENGE_STARTED                    ACS faz form POST no returnUrl (/api/3ds/return)
                                             returnUrl responde HTML que faz postMessage 3DS_CHALLENGE_COMPLETE
◀── 3DS_CHALLENGE_COMPLETE                   POST /api/3ds/challenge-result ──▶ POST .../3ds/challenge-result ──▶ cavv, eci, …
◀── 3DS_RESULT {threeDsData, eciRaw, vres_enrolled}
                           POST /api/pay ───────────────────▶ POST /v1/acquiring/payments {card, threeDsData} ──▶ paymentID, status
◀── PAYMENT_RESULT {paymentID, status}
```

Em qualquer etapa, uma falha gera `ERROR {code, msg, requestId}` para o app.

## Estrutura

```
server/            backend Node.js (Express) — guarda as credenciais, fala com o core
  index.js         endpoints /api/3ds/setup, /api/3ds/authenticate, /api/3ds/challenge-result, /api/pay, /api/3ds/return
  autra-client.js  OAuth client_credentials com cache + retry em 401/403, envelope de erro do core
web/               página que roda dentro da WebView (sem framework)
  3ds.html         formulário de teste + iframes (coleta oculta, desafio visível)
  3ds.js           orquestra o fluxo e publica eventos para o app via notifyNative()
shared/
  threeds-core.js  funções puras: interpretMessage, buildThreeDsData, isChallenge, describeIndicators
android/           trechos de referência (WebView + addJavascriptInterface "AutraBridge")
ios/               trechos de referência (WKWebView + WKScriptMessageHandler "AutraBridge")
test/              node --test
```

## Como rodar

Requisitos: Node.js 18+ e uma credencial de API da Autra (sandbox).

```bash
cp .env.example .env     # preencha AUTRA_CLIENT_ID e AUTRA_CLIENT_SECRET
npm install
npm start
# abra http://localhost:3000/3ds.html
```

`npm test` roda os testes unitários (não chamam a API).

Para testar no celular com o backend local, exponha a porta 3000 por um túnel
https (ngrok, cloudflared etc.) e ajuste `PUBLIC_RETURN_URL` no `.env` — o
`returnUrl` precisa ser alcançável pela internet para o desafio voltar.

## Contrato entre a página e o app nativo

A página chama `notifyNative(event, data)`, que tenta, nesta ordem:

1. `window.AutraBridge.postMessage(json)` — Android (`addJavascriptInterface(obj, "AutraBridge")`)
2. `window.webkit.messageHandlers.AutraBridge.postMessage(obj)` — iOS (`WKScriptMessageHandler`)
3. `window.ReactNativeWebView.postMessage(json)` — React Native WebView
4. `window.parent.postMessage(obj, '*')` — página embutida em outra página (teste no navegador)

Cada mensagem é `{ "event": "<nome>", "data": { ... } }`.

| Evento | `data` | Terminal? |
|---|---|---|
| `3DS_SETUP_DONE` | `requestId`, `referenceId` | não |
| `3DS_DDC_DONE` | `timedOut` (true se a coleta não respondeu em 5 s), `sessionId` | não |
| `3DS_AUTH_FRICTIONLESS` | `authenticationId`, `eci` | não |
| `3DS_CHALLENGE_STARTED` | `authenticationId`, `stepUpUrl` — o portador vai interagir com o iframe | não |
| `3DS_CHALLENGE_COMPLETE` | `md`, `hasJwt` | não |
| `3DS_CHALLENGE_TIMEOUT` | `authenticationId` — 5 min sem resposta | sim |
| `3DS_RESULT` | `threeDsData`, `eci`, `eciRaw`, `vres_enrolled`, `interpretation` | não |
| `PAYMENT_RESULT` | `paymentID`, `status`, `authorizationCode`, `nsu`, `rrn`, `trackingNumber` | sim |
| `ERROR` | `code`, `msg`, `requestId`, `httpStatus` | sim |

`shared/threeds-core.js` exporta `interpretMessage(raw)`, que normaliza a
mensagem (string ou objeto) e devolve `{ ok, event, data, terminal, success, summary }`.
Serve para React Native e como referência do que o código Kotlin/Swift deve fazer.
Guarde sempre o `requestId` dos erros: é a chave para o suporte da Autra.

## Interpretação dos indicadores (PDT)

O resultado do `authenticate`/`challenge-result` traz, além do `threeDsData`,
indicadores que dizem **quanto** a transação foi autenticada:

| `vres_enrolled` | Significado |
|---|---|
| `Y` | Cartão participante do 3DS (emissor respondeu) |
| `N` | Cartão não participante |
| `U` | Directory Server ou ACS indisponível |
| `B` | Autenticação ignorada por regra do estabelecimento |

| `eciRaw` | Significado |
|---|---|
| `02` (Mastercard) / `05` (Visa, Elo e outras) | **Totalmente autenticada** |
| `01` (Mastercard) / `06` (Visa, Elo e outras) | **Tentativa** de autenticação (emissor/ACS não concluiu) |
| `00` (Mastercard) / `07` (Visa, Elo e outras) | **Não** autenticada por 3DS |

Use `describeIndicators({ eciRaw, vres_enrolled })` para obter um resumo em
texto. A decisão de prosseguir com a venda em caso de tentativa (`01`/`06`) é
sua política de risco — confirme com a Autra as regras de responsabilidade por
chargeback de cada bandeira.

## Endpoints do backend de exemplo

| Rota | Faz no core | Devolve à WebView |
|---|---|---|
| `POST /api/3ds/setup` | token → `payments/initialize` → `3ds/setup` | `requestId`, `referenceId`, `accessToken` (**JWT da Cardinal**, não o OAuth), `deviceDataCollectionUrl`, `transactionalToken` |
| `POST /api/3ds/authenticate` | `3ds/authenticate` (injeta `ipAddress`, `returnUrl`, `deviceChannel: Browser`, `acsWindowSize: 05`) | resposta do core como veio |
| `POST /api/3ds/challenge-result` | `3ds/challenge-result` | resposta do core como veio |
| `POST /api/pay` | `POST /v1/acquiring/payments` com `threeDsData` | `paymentID`, `status`, … |
| `POST /api/3ds/return` | — (é o `returnUrl` da Cardinal) | HTML que faz `postMessage({type:'3DS_CHALLENGE_COMPLETE', jwt, md, allFields})` |

Erros do core chegam no envelope `{"errors":[{"code","msg","requestId"}]}` e
são repassados com o mesmo status HTTP. Em 401/403 o backend renova o token e
repete a chamada uma vez.

## Sandbox

`AUTRA_BASE_URL=https://api.sandbox.autra.io` roda a adquirência em **modo
simulado** (sem Dock/Cardinal reais):

- Qualquer número de cartão é aceito. Use o de teste `4176660000000100`.
- Venda com valor terminado em `.51` → recusa (402); `.52` → adquirente indisponível (500).
- **`totalAmount` terminado em `.53` no `authenticate` → desafio** (`WAITING_3DS_AUTHENTICATION` + `stepUpUrl`). Qualquer outro valor → frictionless.
- As páginas da Cardinal são simuladas em
  `https://sandbox.autra.io/api/threeds/mock?mode=ddc` (responde na hora com
  `{MessageType:"profile.completed", SessionId, Status:true}`) e
  `?mode=challenge` (mostra um botão **"Confirmar autenticação"** que envia o
  `3DS_CHALLENGE_COMPLETE` direto para a página pai — no sandbox o `returnUrl`
  não é chamado).
- O `transactionalToken` do sandbox é um JWT sintético válido por 1 h.
- `AUTRA_DOCUMENT_ID=67757775000187` é o CNPJ de teste do estabelecimento no sandbox.

Roteiro sugerido: pague `12.00` (frictionless) e depois `12.53` (desafio).

## Produção

- `AUTRA_BASE_URL=https://api.autra.io`, com credencial própria do tenant e os
  **IPs de saída do seu backend liberados** na allowlist da Autra.
- A Cardinal e o ACS do emissor são reais: a coleta pode demorar e o desafio
  depende do portador.
- `PUBLIC_RETURN_URL` precisa ser **https público**; o ACS faz um form POST
  nela a partir da internet.
- `merchantUrl` deve ser a URL pública do seu site/app.
- Trate `3DS_CHALLENGE_TIMEOUT` e `ERROR` como falha e permita nova tentativa;
  não reaproveite `transactionalToken` entre tentativas.

## Avisos PCI

- **PAN e CVV nunca vão para log**, nem no backend nem no app. Este exemplo não
  registra o corpo das requisições; mantenha assim.
- **Nunca manipule PAN/CVV no app nativo.** O cartão entra na página da WebView
  e vai direto ao seu backend por https; o app só recebe eventos.
- Prefira, sempre que possível, **cartão tokenizado (`tokenData`) ou a página
  hospedada da Autra**, que tiram o PAN do seu escopo PCI. Este exemplo
  recebe o PAN no backend apenas para ficar curto e didático.
- Não injete JavaScript nos iframes da Cardinal/ACS nem capture o conteúdo
  deles.

## App nativo

- [`android/`](./android/) — `WebView` com `javaScriptEnabled`, `domStorageEnabled`
  e `addJavascriptInterface(obj, "AutraBridge")`.
- [`ios/`](./ios/) — `WKWebView` com `WKUserContentController.add(handler, name: "AutraBridge")`.

Iframes cross-origin (Cardinal, ACS, `returnUrl`) funcionam normalmente nas
duas WebViews; não há configuração extra além do JavaScript habilitado.

## Pontos assumidos do contrato

- `cardExpirationDate` e `card.expirationDate` em `MMAAAA` (ex.: `122030`).
- `totalAmount` do `authenticate` é string com 2 casas (`"12.53"`); `amount` da venda é número.
- `threeDsData.secureVersion` recebe `secureVersion` ou, na falta, `specificationVersion`.
- `authenticationTransactionId` do `challenge-result` = `allFields.TransactionId`, senão `MD`, senão `authenticationId`.

## Licença

MIT — veja [LICENSE](./LICENSE).
