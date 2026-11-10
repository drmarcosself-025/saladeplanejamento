# Jarvis

Painel de voz com agentes por contexto (gestão do dia, tráfego, social
media, WhatsApp…). **Fase 0: roda sem backend, em modo demonstração** — os
números são fictícios e a interface avisa com o selo **DEMO**.

Leia `ARQUITETURA.md` antes de mexer: ele define o que é decidido, o que é
desenho e as regras de segurança (a IA nunca executa; só você confirma).

## Rodar agora

```bash
cd jarvis/web
python3 -m http.server 8000      # ou qualquer servidor estático
# abra http://localhost:8000
```

`localhost` é necessário para o microfone funcionar (ou HTTPS). Use Chrome ou
Edge para voz; em outros navegadores dá para digitar.

## Experimente

- “Jarvis, ativa o agente gestão do dia”
- “quero confirmar os pacientes de amanhã” → aparece o painel de confirmação
- “Jarvis, confirma” (em demonstração **não envia nada**)
- “Jarvis, ativa agora o agente social media”
- “Jarvis, desativa o agente social media” / “volta ao normal”
- Ou clique nos atalhos no topo.

O botão ⚙ abre o registro das suas interações (fica só no navegador;
exportável em JSON).

## Testes

```bash
node --test jarvis/tests/brain.test.mjs
```

Cobrem o interpretador de comandos, incluindo a regra de que “confirma” só
vale como frase curta.

## Estrutura

```
jarvis/
  ARQUITETURA.md        arquitetura, segurança, contratos, fases
  web/
    index.html app.css  tela
    app.js              controlador
    modes.js            registro dos 7 agentes (dados, não código)
    brain.js            roteador local de comandos + respostas de demo
    data.js             dados de demonstração / chamada ao backend
    avatar.js           busto em canvas (cor por modo, amplitude por estado)
    voice.js            Web Speech API (entrada e saída)
    config.js           URLs públicas do backend (vazio = demo)
  tests/brain.test.mjs
```

## Ligar um backend (Fase 1+)

Preencha `DATA_URL`, `BRAIN_URL` e `JARVIS_TOKEN` em `web/config.js`. **Nunca**
coloque chave de IA, token do Clinicorp ou senha de e-mail neste arquivo: ele
é público. Segredos ficam só nas Edge Functions.
