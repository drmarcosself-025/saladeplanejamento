# Jarvis — arquitetura atual

## Onde roda

O Jarvis é um HTML único publicado como artefato privado do Claude. `node jarvis/tools/build-artifact.mjs saida.html` reúne os scripts e estilos locais. Não usa Supabase, VPS nem os projetos antigos deste repositório. A publicação com a mesma URL depende da ferramenta Artifact, que deve receber o mesmo caminho do arquivo e o conjunto completo das capacidades.

No artefato, `db` guarda documentos nas coleções `leads` e `fin` com regras `read: owner` e `write: owner`, sincronizando os aparelhos do dono. Fora do artefato, essas coleções ficam no `localStorage` daquele navegador. Contatos importados e registro técnico também ficam no navegador. Coletar apenas nome, telefone, interesse, origem e informação comercial necessária; não inserir dados clínicos nas notas nem segredos no HTML/repositório.

Capacidades necessárias ao publicar: `dictation`, `tts`, `downloads`, `sample: {}`, `db: {rules: [{path:"leads",read:"owner",write:"owner"},{path:"fin",read:"owner",write:"owner"}]}`. Conferir os tipos da versão instalada do `artifact-capabilities` antes de chamar uma capacidade nova. O primeiro uso de `sample` pode solicitar consentimento.

## Fluxo e segurança

- `modes.js`: registro de modo, instrução, painel, apelidos e ferramentas.
- `brain.js`: troca de modo, confirmação, cancelamento e comandos de CRM/finanças são determinísticos. Perguntas abertas usam `sample` e recebem contexto limitado do modo, retornos, resumo financeiro e conversa recente. A IA fornece apenas fala curta, título, itens e sugestões; jamais executa ferramentas.
- `app.js`: desenha avatar, resposta em cartão, CRM e Contador. `leads.js` e `fin.js` mantêm as regras puras; `store.js` persiste cada documento.
- Níveis: `READ` consulta; `LOCAL` salva na lista do usuário; `PROPOSE` prepara e mostra; `EXECUTE` exige ação pendente visível e “confirma” curto. Propostas expiram em 10 minutos.
- WhatsApp usa `<a href="https://wa.me/...">` com texto pronto. O usuário abre e toca em enviar. Abrir o link não comprova envio; o contato só é registrado quando o usuário marca **Contato realizado**.
- O financeiro registra lançamentos e fechamentos, mas nunca paga contas. Receitas e despesas pendentes ficam fora do saldo pago.

## O que é real e o que é demo

Leads e financeiro são dados do dono. Dia a Dia usa contas pendentes do financeiro; agenda de pacientes e e-mails são dados fictícios claramente identificados. Tráfego e Social Media também são demo. Designer e Programador criam apenas textos para copiar e revisar. Não há agente local nem publicação automática.

## Próxima fase (exige infraestrutura separada)

Captura automática de WhatsApp por QR exige um servidor persistente e banco próprio, que não podem gravar diretamente no `db` do artefato. Comparar Evolution/Baileys (não oficial) e Cloud API oficial com coexistência, além de hospedagem e custos, antes da implementação. Clinicorp só após confirmar API de leitura com suporte. Gmail, Calendar e Ads exigem investigar os conectores e seus retornos reais antes de integração. Não reaproveitar CRM Maison D'Or nem `dental-leads`.

## Verificação

`node --test jarvis/tests/*.test.mjs` valida as regras puras. `node jarvis/tests/browser.mjs` exige Chromium executável e servidor `cd jarvis/web && python3 -m http.server 8000`; cobre CRM, financeiro, resposta estruturada, falta de `sample` e largura de 390px. Publicação e `ArtifactData` requerem as ferramentas do ambiente Claude e não são simuladas localmente.
