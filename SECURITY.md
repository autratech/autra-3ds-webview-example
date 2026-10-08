# Política de segurança

Este repositório é um **exemplo de integração** (código de referência). Ele não recebe dados de cartão em produção da Autra, mas um integrador pode se basear nele, então tratamos vulnerabilidades com seriedade.

## Como relatar

- Use o **relato privado de vulnerabilidade** do GitHub: aba *Security* → *Report a vulnerability*. Não abra issue pública com detalhes exploráveis.
- Respondemos em até 5 dias úteis e combinamos a divulgação.

## Escopo

- Vazamento de credenciais, tokens ou dados de cartão pelo exemplo (logs, URLs, `postMessage` para origem errada).
- Interpretação incorreta dos eventos 3DS que leve a aprovar pagamento sem autenticação.

## Fora de escopo

- Vulnerabilidades da API da Autra em si: relate pelo canal oficial de suporte da Autra.
- Dependências de desenvolvimento sem impacto no exemplo em execução.

## Regras que o exemplo segue

- Segredos só em `.env` (ignorado pelo git); nunca em URL, log, código ou testes.
- O `accessToken` OAuth não sai do servidor; a WebView recebe apenas o JWT da Cardinal.
- Dados de cartão não são logados nem persistidos.
