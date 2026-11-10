# Jarvis — arquitetura

> **Status:** Fase 0 entregue (interface + modos + cérebro local, em modo
> demonstração, sem backend). Fases 1 a 5 são desenho. Este documento é a
> fonte de verdade; atualize o fim dele a cada fase.

> **Atualização:** o Supabase deixou de estar disponível e **não será usado**.
> As seções que citam Supabase, Edge Functions e schema `jarvis` (§1, §4, §5,
> o diagrama) descrevem o backend da Fase 1 e serão reescritas para um app
> local simples (servidor Node no PC, arquivo SQLite, segredos em `.env`),
> mantendo os mesmos contratos e as mesmas regras de segurança. Nada da
> Fase 0 depende disso. Já entregue sem backend: mensagens de WhatsApp por
> link `wa.me` com confirmação (contatos só no navegador).

Projeto **separado** do CRM Maison D'Or (raiz) e do `dental-leads/`. Nenhum
arquivo, tabela ou função deles é lido ou alterado por este. A integração com
o `dental-leads` (WhatsApp) é planejada e passa por contrato explícito (§6).

Em uma frase: **uma interface de voz que ativa agentes por contexto; cada
agente é um conjunto pequeno de ferramentas; o Claude decide qual usar, o
servidor executa, e nada que altere o mundo roda sem o seu “confirma”.**

```
 Você (voz/texto)
      │
 ┌────▼─────────────────────────┐        ┌──────────────────────────────┐
 │ web/  (navegador)            │        │ Seu PC (opcional, Fase 5)    │
 │  avatar · painéis · voz      │        │  agente local: abre projetos │
 │  roteador local de comandos  │        │  no Cursor / VS Code /       │
 └────┬─────────────────────────┘        │  Claude Code                 │
      │ HTTPS + token                    └──────────────▲───────────────┘
 ┌────▼─────────────────────────────────────────────────┴──────────┐
 │ Supabase  (Edge Functions + Postgres, schema `jarvis`)          │
 │  jarvis-data   → números para os painéis (só leitura)           │
 │  jarvis-brain  → Claude + ferramentas do modo ativo             │
 │  jarvis-exec   → executa ação CONFIRMADA (única que altera algo)│
 │  tabelas: interacoes · acoes_pendentes · execucoes · config     │
 └──┬───────────┬────────────┬───────────────┬─────────────────────┘
    │           │            │               │
 Clinicorp    Gmail /      Evolution API   Ads (Meta/Google)
 (agenda)     Calendar     (WhatsApp, já   CRM Maison D'Or
              (já conectado existe)        (somente leitura)
              ao Claude)
```

---

## 1. Por que não precisa de VPS (por enquanto)

| Peça | Onde roda | Motivo |
|---|---|---|
| Interface, voz, avatar | Navegador | Precisa do microfone e da caixa de som. Estático: pode ficar no GitHub Pages, como o resto do repo. |
| Backend (`jarvis-*`) | **Supabase Edge Functions** | Já é o padrão do repositório. Sem servidor para manter, URL pública pronta. |
| WhatsApp | **Evolution já existente** | Já roda e já é usada pelo `dental-leads`. Não instalar outra. |
| Agente Programador | **PC do usuário** | Só o PC alcança Cursor, VS Code e Claude Code. Fase 5, opcional. |

Uma VPS só passa a fazer sentido se algum conector exigir processo longo que
Edge Function não aguenta (ex.: sessão persistente de navegador). Não é o caso
das fases 1 a 4.

## 2. Camadas

1. **Interface (`web/`)** — `index.html`, `app.css`, `avatar.js` (canvas),
   `voice.js` (Web Speech API), `app.js` (controlador). Sem build, sem
   framework, sem dependência externa.
2. **Registro de modos (`modes.js`)** — cada agente é *dado*: nome, cor,
   apelidos de voz, fala de abertura, painel, ferramentas e nível de segurança.
3. **Roteador local (`brain.js`)** — trocar de modo, confirmar e cancelar são
   **determinísticos**, nunca passam por IA. Só pergunta aberta vai ao Claude.
4. **Fonte de dados (`data.js`)** — `DATA_URL` vazio = demonstração (dados
   fictícios, selo **DEMO** visível). Preenchido = backend, selo **AO VIVO**.
5. **Backend (Fase 1+)** — três Edge Functions com responsabilidades
   separadas de propósito (§4).

## 3. Como um modo funciona

Ao dizer “Jarvis, ativa o agente X”:

1. `brain.js` reconhece verbo + apelido → `ativar(X)` (sem IA).
2. `data.js` busca os números do modo (`jarvis-data?mode=X`).
3. A abertura é montada **a partir dos dados** e falada (“Ontem você investiu
   R$ …”). O avatar muda de cor; o painel mostra os KPIs.
4. Perguntas seguintes vão para `jarvis-brain` com `{mode, text}`. O Claude
   recebe **só as ferramentas daquele modo** — o agente de tráfego não enxerga
   e-mail, o de gestão não enxerga anúncios.
5. “Jarvis, desativa…” / “volta ao normal” → modo neutro, ferramentas zeradas.

Adicionar um agente novo = uma entrada em `modes.js` + suas ferramentas no
backend. Hoje há 7: Gestão do Dia, Tráfego, Social Media, WhatsApp, Editor de
Vídeo, Automação, Programador.

## 4. Segurança: três níveis de ferramenta

| Nível | Pode | Exemplo | Como roda |
|---|---|---|---|
| `READ` | só ler | agenda de amanhã, gasto de ontem, e-mails a responder | direto |
| `PROPOSE` | preparar e **mostrar** | lista de confirmações com a mensagem de cada paciente | grava em `acoes_pendentes`; aparece no painel |
| `EXECUTE` | alterar/enviar de verdade | enviar WhatsApp, pausar campanha, publicar post | **só** `jarvis-exec`, e só para uma ação pendente que você confirmou |

Regras que o código tem de garantir (e que os testes da Fase 1 devem cobrir):

- **A IA nunca executa.** Ela só devolve uma ação *proposta*; quem executa é
  `jarvis-exec`, por id de ação, depois do “confirma”. Mesmo princípio do
  `dental-leads`: *a IA pensa, o servidor decide e executa*.
- **“Confirma” só vale como frase curta** e só para a ação pendente exibida
  na tela. Frase longa (“não confirma essa consulta”) é pergunta, não
  confirmação (já testado em `tests/brain.test.mjs`).
- **Ação pendente expira** (proposta: 10 min) e é de uso único.
- **Credenciais só nas Edge Functions** (`supabase secrets`). `web/config.js`
  é público e nunca recebe chave.
- **Financeiro: só lembrar.** Nenhuma ferramenta paga conta. Não é limitação
  técnica, é decisão.
- **Cada interação e cada execução gera registro** (§7), com o que foi
  proposto, confirmado e executado.

## 5. Contratos do backend (para a Fase 1)

**`GET jarvis-data?mode=gestao`** → JSON com os mesmos campos que
`data.js` hoje fabrica em `demo()`. Só leitura. Qualquer campo ausente deve
degradar para “indisponível”, nunca para número inventado.

**`POST jarvis-brain`** `{ mode, text }` →
```json
{ "speech": "texto falado e exibido",
  "pending_action": { "id": "uuid", "nivel": "EXECUTE",
      "titulo": "Enviar 4 confirmações", "detalhe": ["09:00 · …"],
      "exemplo": "Olá! …" } }
```
`pending_action` é opcional e já está persistido em `acoes_pendentes`.

**`POST jarvis-exec`** `{ action_id }` → executa a ação pendente (uma vez) e
devolve `{ ok, resumo }`. É a única função com permissão de escrita nos
sistemas externos.

Autenticação: token pessoal ou JWT do login Supabase; RLS nas tabelas.

## 6. Integrações, na ordem em que fazem sentido

| # | Integração | Para quê | Situação |
|---|---|---|---|
| 1 | **Gmail** (leitura) | triagem de e-mails e boletos/contas a vencer | Conector já existe nesta conta do Claude; no backend próprio, precisa de OAuth do Google. |
| 2 | **Clinicorp** (agenda) | confirmar pacientes de amanhã | **Bloqueada**: nenhuma API pública confirmada. A tela *Acesso Externo e integrações* **não** é API (vincula “central”, com acesso total). Caminho: chamado ao suporte pedindo API **somente leitura**. Até lá: colar/exportar a agenda do dia. |
| 3 | **Google Calendar** | agenda pessoal | Conector existe; não contém a agenda de pacientes. |
| 4 | **Evolution / dental-leads** | enviar confirmações, ver leads | Evolution existe. Envio do Jarvis passaria pelo mesmo `evaluatePostPolicy()` + rate limit do `dental-leads`; **não** criar caminho de envio paralelo. |
| 5 | **Ads (Meta/Google)** | modo Tráfego | Leitura primeiro. Pausar/orçamento = `EXECUTE`. |
| 6 | **CRM Maison D'Or** | vendas por origem | Somente leitura, via view dedicada. |
| 7 | **Agente local no PC** | modo Programador | Processo no PC que **disca para fora** (WebSocket), sem abrir porta. Abre pasta no Cursor/VS Code/Claude Code. |

**Dados de pacientes são dados de saúde (LGPD).** O Jarvis só pega o mínimo
para a tarefa (confirmação: nome, horário, procedimento, telefone), não
guarda o conteúdo da agenda no banco do Jarvis além da ação pendente, e a
conversa registrada em `interacoes` não deve conter dados clínicos.

## 7. Coleta de dados (o que o Jarvis aprende de você)

Fase 0 já registra, **só no navegador** (`localStorage`, exportável em JSON):
horário, modo, tipo (ativar / pergunta / confirmar…), texto e origem
(voz/texto/clique). Na Fase 1 isso vai para `jarvis.interacoes` no Supabase.

Serve para: ver quais comandos você realmente usa, quais não foram
entendidos, quanto tempo leva uma confirmação, e decidir o que automatizar
primeiro. Não serve para treinar modelo nenhum.

## 8. Voz

Web Speech API no navegador: grátis, sem enviar áudio a servidor nosso.
Limites conhecidos: melhor no Chrome/Edge; exige HTTPS ou `localhost`; no
celular depende do navegador. “Jarvis” como palavra de ativação é por texto
reconhecido (sem detector offline): o microfone fica ligado enquanto o botão
estiver ativo, então use-o **ligado só quando for falar**. Se a qualidade não
bastar, trocar `voice.js` por Whisper/Realtime API sem tocar no resto.

## 9. Fases

| Fase | Entrega | Estado |
|---|---|---|
| **0** | Interface, 7 modos, roteador local, confirmação com painel, registro local, modo DEMO | **Feita** |
| **1** | Schema `jarvis`, `jarvis-brain` (Claude + ferramentas do modo), `jarvis-exec`, registro no banco, login | A fazer |
| **2** | Gestão do Dia real: Gmail (e-mails + boletos), agenda do Clinicorp (API ou colagem), mensagens de confirmação | A fazer — depende da resposta do suporte do Clinicorp |
| **3** | Envio de confirmações pelo WhatsApp via `dental-leads`/Evolution, com política e aprovação por voz | A fazer |
| **4** | Tráfego e Social reais (leitura → proposta → execução) | A fazer |
| **5** | Agente local no PC (modo Programador) | A fazer |

## 10. Decisões em aberto

1. **Login:** Supabase Auth com e-mail (como o `30d`) ou token fixo? Recomendo
   Auth, porque as tabelas terão dado sensível.
2. **Projeto Supabase:** reutilizar o do `dental-leads` (schema `jarvis`
   isolado, como já foi feito com `dental_leads`) ou criar outro? Recomendo
   reutilizar, para o envio de WhatsApp ficar no mesmo lugar.
3. **Modelo de IA:** o `dental-leads` usa Claude Haiku por custo. Para o
   Jarvis, que raciocina com ferramentas, um modelo maior no `jarvis-brain` e
   um menor para triagem de e-mail.
4. **Clinicorp:** aguardando resposta do suporte sobre API somente leitura.
