# Prompt de continuação: Jarvis

Copie tudo abaixo para uma nova conversa com o Claude Code, no repositório `saladeplanejamento`.

---

Você vai continuar um projeto já em andamento: o **Jarvis**, um painel de voz com agentes por contexto, para o dono de uma clínica odontológica. Leia este prompt inteiro e depois `jarvis/ARQUITETURA.md` e `jarvis/README.md` antes de mexer em qualquer coisa.

## 1. Quem é o usuário e como trabalhar com ele
- Dono de clínica odontológica (Brasil). **Não é desenvolvedor** e já ficou desanimado com complexidade. Responda em português, direto, sem jargão, e diga o que testou e o que **não** conseguiu testar.
- Seja honesto sobre limites. Nunca diga que algo funciona sem ter testado. Se um teste falhar, diga.
- Faça uma coisa por vez, entregue algo que ele possa usar e peça uma decisão só quando ela for realmente dele.
- Dados de pacientes e leads são dados pessoais (LGPD): colete o mínimo, avise onde ficam guardados, nunca ponha segredo em arquivo do repositório.
- Branch de trabalho: `claude/intelligent-ramanujan-uvnydv`. **Não crie PR** sem ele pedir. Commit e push ao terminar cada etapa, com testes passando.

## 2. O que é o Jarvis
Interface de voz/texto com avatar animado e **agentes (modos)**. Cada modo é um registro em `jarvis/web/modes.js` (nome, cor, apelidos, ferramentas, painel). Regras de segurança, que não podem ser quebradas:
- Ferramentas têm nível `READ`, `LOCAL` (grava na lista do próprio usuário), `PROPOSE` (prepara e mostra) e `EXECUTE` (só com o "confirma" dele).
- **A IA nunca executa.** Ela só informa e propõe. Trocar de modo, confirmar e cancelar são determinísticos (`brain.js`), sem IA.
- "Confirma" só vale como frase curta e só para a ação pendente mostrada na tela. Ação pendente expira em 10 minutos.
- WhatsApp: o Jarvis **abre a conversa com o texto pronto** (link `wa.me`); o usuário toca em enviar. Nada é enviado sozinho.

## 3. Onde roda (restrições importantes)
- **Não há Supabase nem VPS.** O usuário não tem mais Supabase. O projeto antigo do repositório (CRM Maison D'Or, `dental-leads`, `30d`) não faz parte do Jarvis e não deve ser reaproveitado.
- O Jarvis é publicado como **artefato privado do claude.ai**: https://claude.ai/artifact/AyYZj7hWjRyWAGwbv5dJGs (só o dono abre). Gerar o arquivo único: `node jarvis/tools/build-artifact.mjs <saida.html>` e publicar com a ferramenta `Artifact` no mesmo caminho de arquivo (mantém a URL).
- Dentro do artefato, o microfone do navegador é bloqueado. Por isso o projeto usa capacidades do claude.ai: `dictation` (ditado, só "segurar para falar"), `tts` (voz do Claude), `downloads`, `db` (armazenamento que sincroniza iPhone e computador) e `sample` (perguntar ao Claude da conta do usuário). **No iPhone/Safari e nos apps do Claude, ditado e a voz do Claude não existem**: há reserva (voz do aparelho para falar; microfone do teclado para ditar).
- Ao publicar, **declare todas as capacidades de novo** (`capabilities` é um conjunto completo). Regras do `db`: `{path:"leads",read:"owner",write:"owner"}` e `{path:"fin",read:"owner",write:"owner"}`. Antes de usar uma capacidade, leia os tipos em `/tmp/claude-0/bundled-skills/*/artifact-capabilities/0.2.96/*.d.ts` (skill `artifact-capabilities`).
- Regras do artefato: sem `alert/confirm/prompt`, sem `window.open` garantido (use `<a href>` de verdade), `localStorage` só para conveniência, CSS/JS tudo embutido, fontes só do Google Fonts.

## 4. O que já está feito e publicado (artefato, versão 5)
Interface completa (avatar de canvas com anéis/partículas/anel de áudio, fundo animado, sons, abertura, legenda que "digita", painel Conversa), voz em dois caminhos (artefato e navegador), 7 modos (Gestão do Dia, Leads, Tráfego, Social, Editor de Vídeo, Automação, Programador; Tráfego/Social/Gestão usam **dados de demonstração** com selo DEMO), **importação de contatos** (.vcf/.csv, busca, sem duplicar), **mensagem de WhatsApp com confirmação**, e **modo Leads** com retorno obrigatório (armazenado no `db`).

## 5. O que está commitado no repositório mas NÃO ligado à interface nem publicado
Commit `d75ad43` (46 testes passando: `node --test jarvis/tests/*.test.mjs`):
- `web/store.js`: armazenamento genérico (db do claude.ai ou localStorage).
- `web/leads.js`: **etapas novas** (`novo, interessado, proposta, aguardando, agendou, fechou, sem_interesse`), histórico por lead, valor, notas, migração dos nomes antigos (`conversando→interessado`, `orcamento→proposta`, `perdido→sem_interesse`). Entrar numa etapa ativa remarca o retorno (`DIAS_PADRAO`).
- `web/fin.js`: lançamentos (receita/despesa, pago/pendente, vencimento), categorias de clínica, resumo mensal (só o PAGO conta em receitas/despesas; pendente vai à parte), contas a pagar, fechamento do mês, CSV e relatório de texto para o contador.
- `web/brain.js`: comandos por voz para etapa ("o João demonstrou interesse", "passei a proposta pro João"), `crm_abrir/crm_fechar`, `lead_detalhe`, `lead_nota` (campo **`nota`**, não `texto`: o roteador sobrescreve `texto`), `lead_valor`, `fin_lancar/fin_resumo/fin_pendentes/fin_pagar/fin_fechar`, e `perguntarClaude` (usa `sample.json`, modelo `quick`, sem ferramentas).
- `app.js` ainda trata só os comandos de lead antigos. Os novos tipos caem na "pergunta aberta" (resposta de demonstração).

## 6. O que falta fazer (Fase A, só front-end), nesta ordem
1. **modes.js**: renomear `gestao` para "Dia a Dia"; trocar `video` por **Designer**; remover `automacao`; criar **Contador**; dar a cada modo um campo `instrucao` (usado no prompt do Claude). Designer: legendas, roteiros de Reels, ideias de post, briefing de arte, sem promessa de resultado nem preço promocional (conferir regras do CFO). Programador: transformar a ideia em briefing/prompt para o Claude Code e checklist, tudo copiável (não há agente local no PC). KPIs de Leads com "Sem interesse".
2. **data.js**: dados do Contador vindos de `JarvisFin`; em Dia a Dia, as **contas** passam a vir do financeiro real (`pendentes`), mantendo pacientes/e-mails como demo.
3. **app.js**: tratar todos os intents novos; perguntar o valor quando faltar ("Qual o valor?"); `aplicarEtapa` com mensagens das etapas novas; ligar `perguntarClaude` com um **montador de contexto** (resumo do modo, leads devidos, financeiro do mês, histórico recente) quando a pergunta não for determinística.
4. **Resposta estruturada**: cartão na tela (título, itens, botões de ação sugerida, "Copiar" nos textos criados), com **fala curta** ("Você tem 3 retornos. Mostrei na tela."). Hoje a fala lê tudo e a estrutura é ruim: este é um pedido explícito do usuário.
5. **CRM (tela cheia)**: quadro por etapa (arrastar entre colunas no desktop; no celular, botões no painel), cartão com nome, interesse, valor e retorno; painel lateral do lead com histórico, nota, valor, "Retornar", adiar, resultado do contato. Métricas: ativos, hoje, atrasados, valor em aberto, conversão, ticket, por origem. Visual **limpo e sóbrio** (sem brilho), diferente do avatar.
6. **Contador (painel)**: navegação por mês, receitas/despesas/saldo, a pagar/a receber, barras por categoria, lista de lançamentos (marcar pago, apagar), formulário, exportar CSV do mês, copiar relatório, "Fechar o mês" (grava o fechamento).
7. `index.html`/CSS dos itens acima; `tools/build-artifact.mjs` já lê a ordem dos scripts do `index.html`.
8. **Publicar** com `capabilities`: `dictation, tts, downloads, sample:{}, db:{rules:[leads owner, fin owner]}`. Depois, **uma passada funcional** com a ferramenta `ArtifactData`: gravar um documento `_probe` em `leads` e em `fin`, ler, conferir com `as_level:"admin"` que não aparece, e apagar. A primeira chamada ao Claude (`sample`) pede consentimento ao usuário.
9. Testes de navegador (Playwright já instalado) para: CRM, financeiro (voz e formulário), resposta estruturada, e o caminho sem `sample` (mensagem clara). Rodar também em 390px de largura.

## 7. Fase B (back-end), só depois da Fase A
- **QR code do WhatsApp com entrada automática de novos números no funil**: **não dá para fazer só no navegador.** Exige um servidor que fique ligado 24 h recebendo mensagens e um banco próprio; o armazenamento do artefato **não** é gravável por servidor externo. Duas rotas: (a) Evolution API (QR, não oficial, risco de banimento do número) ou (b) WhatsApp Cloud API oficial com "coexistência" (sem QR, sem risco de banimento, exige verificação da Meta). Recomendar a (b) para atendimento e deixar a (a) só se o usuário aceitar o risco, em número separado. Decidir antes: onde hospedar (VPS pequena ou Cloudflare Workers + D1).
- Agenda do **Clinicorp**: aguardando o suporte dizer se existe API **somente leitura**. A tela "Acesso Externo e integrações" do Clinicorp **não** é API (vincula uma "central" com acesso total); não usar.
- Gmail, Google Calendar e Google Ads via capacidade `mcp` do artefato (conectores do próprio usuário, somente leitura). Antes, ler `mcp.d.ts` e chamar uma ferramenta segura para ver o formato real das respostas.
- Agente local no PC para o modo Programador (Cursor/VS Code/Claude Code).

## 8. Ideias de melhoria já levantadas (priorizar com o usuário)
Resumo falado de "Bom dia" com retornos, contas e agenda; modelos de mensagem editáveis por etapa; metas do dia; desfazer em ações destrutivas; backup/exportação de tudo; tela de primeiro uso guiada; atalhos de teclado visíveis; leads de uma conversa exportada do WhatsApp; acessibilidade (leitor de tela, contraste); registro de auditoria das ações.

## 9. Como rodar e conferir
- Testes: `node --test jarvis/tests/brain.test.mjs jarvis/tests/contacts.test.mjs jarvis/tests/leads.test.mjs jarvis/tests/fin.test.mjs`.
- Local: `cd jarvis/web && python3 -m http.server 8000` e abrir `http://localhost:8000`.
- Armadilhas já encontradas: o atributo `hidden` perde para `display:flex` (por isso há `[hidden]{display:none!important}`); campos do resultado do roteador não podem se chamar `texto`; `localStorage` pode falhar (sempre `try/catch`); o Playwright trata `aria-disabled` como não clicável; no desktop o palco precisa caber na tela (as colunas laterais rolam por dentro).
