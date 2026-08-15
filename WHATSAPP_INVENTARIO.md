# Maison D'Or — Inventário técnico do módulo WhatsApp

Última auditoria: 15/08/2026
Commit auditado: `3543104` (branch `claude/maison-dor-reception-panel-zuynl5`)

> Este arquivo descreve o que **existe de verdade no código hoje**, não o que
> deveria existir. Sempre que mexer em algo do WhatsApp, atualize a linha
> correspondente. Ver também `WHATSAPP_TESTES.md` para o roteiro de teste manual.

Legenda: ✅ implementado e testado · 🟡 implementado, não testado de verdade · 🔴 implementado com problema conhecido · ❌ não existe

## Tabela mestra (código existe × testei de verdade)

| Função | Código existe | Testei de verdade | Resultado |
|---|---|---|---|
| Conectar / QR Code | ✅ | ✅ | ✅ |
| Enviar texto | ✅ | ✅ | ✅ |
| Receber texto (webhook) | ✅ | ✅ | ✅ |
| Tempo real (mensagem aparece sozinha) | ✅ | ✅ | ✅ (corrigido hoje) |
| Enviar imagem | ✅ | 🟡 | 🟡 |
| Receber imagem | ✅ | 🟡 | 🟡 |
| Enviar vídeo | ✅ | ❌ | 🟡 |
| Receber vídeo | ✅ | ❌ | 🟡 |
| Enviar áudio | 🔴 (aceito no navegador, rejeitado no servidor) | ❌ | 🔴 |
| Receber áudio | ✅ | ❌ | 🟡 |
| Enviar documento | ✅ | ❌ | 🟡 |
| Receber documento | ✅ | ❌ | 🟡 |
| Foto de perfil do contato | ✅ | ✅ | ✅ |
| Corrigir telefone (LID → número real) | ✅ | ✅ | ✅ |
| Sincronizar histórico manualmente | ✅ | ✅ | ✅ |
| Busca de conversa (por nome/telefone) | ✅ | ❌ | 🟡 |
| Status enviada/entregue/lida (✓✓ azul) | ❌ | — | ❌ |
| Contador de mensagens não lidas | ❌ | — | ❌ |
| "Digitando..." | ❌ | — | ❌ |
| Toast de "nova mensagem chegou" | ❌ | — | ❌ |
| Grupos do WhatsApp | ❌ (ignorados de propósito) | — | ❌ |
| Reconexão automática se cair | ❌ (precisa gerar QR de novo manualmente) | ❌ | ❌ |
| Segurança (RLS, secrets, throttle anti-bloqueio) | ✅ | 🟡 | 🟡 |

## 1. Conexão WhatsApp
- **Status:** ✅ implementado e testado.
- **Onde:** `index.html` (`waConectarBtn`, `checkWaStatus`, `waStartRealtime`) + `whatsapp-proxy` (ações `create-instance`, `get-qr`, `status`, `logout`) + Evolution API (`/instance/*`).
- **Como funciona:** botão gera QR Code (`instance/create` + `instance/connect`), a tela consulta `instance/connectionState` a cada poucos segundos até conectar, depois reduz a frequência.
- **Dependências:** Evolution API rodando (hoje: VPS Hetzner via EasyPanel), instância nomeada em `EVOLUTION_INSTANCE`.
- **Riscos conhecidos:** nenhuma reconexão automática — se a sessão cair (ex.: celular ficou muito tempo offline, ou trocou de aparelho), precisa gerar QR novo manualmente. Sem alerta proativo pro usuário quando isso acontece (só descobre ao abrir a aba).
- **Teste manual:** ver `WHATSAPP_TESTES.md`, passo 1-2.

## 2. Recebimento de mensagens
- **Status:** ✅ (texto) / 🟡 (mídia).
- **Onde:** `whatsapp-webhook/index.ts` (evento `messages.upsert` da Evolution API) → grava em `wa_messages` e `wa_inbox`.
- **Como funciona:** Evolution API chama a URL do webhook (protegida por `?secret=`) a cada mensagem nova; a function extrai texto/tipo/telefone e grava.
- **Dependências:** webhook configurado na instância da Evolution (`/webhook/set/{instance}`), secret sincronizado entre Evolution e Supabase.
- **Riscos conhecidos:** protegido por secret na **query string** da URL (não em header) — aparece em logs/histórico do navegador mais facilmente que um header. Rotação de secret é manual (sem alerta de expiração).
- **Teste manual:** passo 3-4.

## 3. Envio de mensagens
- **Status:** ✅ (texto e imagem/vídeo/documento) / 🔴 (áudio).
- **Onde:** `index.html` (composer, `waComposeSendBtn`, `waAttachBtn`) → `whatsapp-proxy` (ações `send-text` inexistente no fluxo do painel — hoje o painel usa link `wa.me` direto pro texto simples; `send-media` cobre anexos).
- **Bug encontrado:** `whatsapp-proxy` linha ~253 só aceita `mediatype` em `["image","video","document"]`. O anexo de áudio foi liberado no navegador hoje (`accept="...audio/*..."`) mas vai bater nessa validação e falhar com erro 400. **Precisa de 1 linha de correção** (adicionar `"audio"` na lista).
- **Teste manual:** passo 5, 8.

## 4. Histórico / conversas
- **Status:** ✅.
- **Onde:** `index.html` (`renderWaConversations`, agrupamento por telefone).
- **Como funciona:** lê toda a tabela `wa_messages` e agrupa por dígitos do telefone (evita duplicar por formatação diferente do mesmo número).
- **Riscos conhecidos:** não pagina — carrega a tabela inteira toda vez. Com poucos meses de uso isso deve ficar lento.

## 5. Realtime
- **Status:** ✅ (corrigido hoje).
- **Onde:** `index.html` (`waStartRealtime`, canal `wa_messages_live`) + Supabase Realtime (publicação `supabase_realtime`, tabela `wa_messages` habilitada manualmente no painel).
- **Bug corrigido hoje:** o canal era recriado a cada 25s (checagem periódica de status), causando perda de mensagens na janela de re-inscrição. Corrigido pra só (re)criar na transição de "desconectado" → "conectado".
- **Risco conhecido:** a habilitação da tabela `wa_messages` na publicação `supabase_realtime` foi feita **manualmente no painel do Supabase**, não está no `schema.sql`. Se o projeto for recriado do zero a partir do schema, o tempo real vai parecer quebrado até alguém lembrar de reativar esse toggle.

## 6. Contatos e identidade
- **Status:** 🟡.
- **Onde:** `index.html` (agrupamento por telefone, `pareceTelefoneValido`).
- **Risco conhecido:** identidade é só o número de telefone — não existe um "id de contato" único separado. Ver seção LID abaixo.

## 7. LID / remoteJid / remoteJidAlt
- **Status:** 🟡 (mitigado, não resolvido).
- **Onde:** `whatsapp-webhook` e `whatsapp-proxy` (`extrairTelefoneInfo`, duplicada nos dois arquivos), `index.html` (`pareceTelefoneValido`, botão "Editar").
- **Como funciona hoje:** quando o WhatsApp esconde o número real (`@lid`), tenta usar `remoteJidAlt` se a Evolution já resolveu; se não, guarda o código LID cru e marca `telefone_e_lid=true`, que faz o painel avisar e impedir ações de envio até correção manual.
- **Risco conhecido:** se o mesmo contato mandar mensagem às vezes com LID e às vezes com número resolvido, viram **duas conversas separadas** até alguém usar o botão "Editar" pra mesclar manualmente. Corrigido hoje: "Editar" agora limpa a marca de LID corretamente (antes deixava o aviso preso mesmo após corrigir).

## 8. Fotos de perfil
- **Status:** ✅ (implementado e confirmado funcionando hoje).
- **Onde:** `whatsapp-proxy` (ação `get-profile-pic` → Evolution `/chat/fetchProfilePictureUrl`) + `index.html` (`waLoadAvatarsPendentes`, cache em `localStorage` por 24h).
- **Risco conhecido:** depende da Evolution conseguir resolver o telefone (não funciona bem pra conversas ainda marcadas como LID).

## 9-12. Imagens / Vídeos / Áudios / Documentos
- **Status:** 🟡 no geral, 🔴 no envio de áudio (ver seção 3).
- **Onde:** `whatsapp-webhook` (`extractMediaNode`, `baixarEGuardarMidia`, download da Evolution pro bucket `wa-media`) + `index.html` (render de mídia na conversa, `waCarregarMidias` com signed URLs).
- **Risco conhecido:** o download de mídia recebida depende de um endpoint (`/chat/getBase64FromMediaMessage`) cujo formato exato de resposta nunca foi confirmado com a instância real rodando hoje na Hetzner (o código tenta vários formatos de campo, mas não foi validado ponta-a-ponta com um teste real de imagem/vídeo/áudio/documento recebido).

## 13. Status enviada/entregue/lida
- **Status:** ❌ não implementado. Não existe coluna de status/ack em `wa_messages`.

## 14. Mensagens não lidas
- **Status:** ❌ não implementado (nem por conversa nem contador geral).

## 15. Toast / notificações
- **Status:** ❌ (só existe toast de "WhatsApp conectado/desconectado" — não de mensagem nova chegando). Especificação completa já foi discutida (módulo de notificações), não implementada ainda.

## 16. Busca
- **Status:** 🟡. Existe campo de busca por nome/telefone na lista de conversas (`waConvBusca`), nunca testado formalmente.

## 17. Sync manual
- **Status:** ✅ testado hoje (botão "Sincronizar conversas", ação `sync-messages`, paginação com fallback page/offset).

## 18. Reconexão / fallback
- **Status:** ❌. Sem retry automático de conexão nem aviso proativo de queda — só reflete o estado quando o painel está aberto e consulta o status.

## 19. Tratamento de erros
- **Status:** 🟡. A maioria das ações mostra erro via `showToast`, e as Edge Functions devolvem mensagens de erro detalhadas (não escondem falha). Não há um padrão único de retry/backoff no navegador.

## 20. Segurança
- **Status:** 🟡.
- RLS: select/insert/update abertos pra qualquer usuário autenticado, delete restrito ao owner (em `wa_send_log`, `wa_inbox`, `wa_messages`).
- Secrets: `EVOLUTION_API_KEY` nunca aparece no frontend (fica só nas Edge Functions). `WEBHOOK_SECRET` vai na query string da URL do webhook (ponto fraco conhecido, já rotacionado hoje por ter sido exposto em print/log).
- Anti-bloqueio: throttle atômico via `wa_throttle_claim` (advisory lock), reforçado no servidor (não só no navegador).

---

## Mapa de dependências

```
Evolution API (Baileys) → webhook (whatsapp-webhook) → wa_messages / wa_inbox
                                                              │
                                                              ▼
                                          Supabase Realtime (publicação supabase_realtime)
                                                              │
                                                              ▼
                                                    index.html (painel)

LID/identidade → agrupamento por telefone → conversa → histórico → envio
  (se errado, cria conversa duplicada; botão "Editar" corrige manualmente)

whatsapp-proxy (Edge Function) → Evolution API
  ├─ status/QR/conexão      (ADMIN_ACTIONS: só owner)
  ├─ send-text / send-media (throttle anti-bloqueio via wa_throttle_claim)
  ├─ get-profile-pic        (qualquer usuário autenticado)
  └─ sync-messages          (qualquer usuário autenticado)

wa-media (Storage bucket privado) ← upload (whatsapp-webhook, recebido) / (index.html, enviado)
                                   → signed URLs geradas na hora de exibir
```

**Implicação prática:** qualquer mudança em `extrairTelefoneInfo` (duplicada em `whatsapp-webhook` E `whatsapp-proxy`) precisa ser replicada nos dois arquivos — não há import compartilhado entre Edge Functions. Esquecer de atualizar um dos dois já causou inconsistência antes.

**Importante sobre deploy:** mudar o código de uma Edge Function no GitHub **não** publica ela sozinha no Supabase — precisa colar o conteúdo atualizado no editor do painel do Supabase e clicar "Deploy updates" manualmente (diferente do `index.html`, que publica sozinho via GitHub Pages a cada merge na `main`). Esquecer esse passo foi causa de confusão hoje (código certo no GitHub, function antiga rodando em produção).

---

## Totais
- ✅ Completo e testado: **9**
- 🟡 Existe, não testado / risco leve: **9**
- 🔴 Problema conhecido: **2** (envio de áudio rejeitado no servidor; secret do webhook em query string)
- ❌ Não implementado: **6**

## 5 partes mais frágeis
1. **Envio de áudio** — quebrado de verdade agora (código incompleto), não só "não testado".
2. **LID/identidade duplicando conversa** — mitigado mas não resolvido na raiz, depende de correção manual.
3. **Deploy manual de Edge Functions dessincronizado do GitHub** — causa real de bugs "fantasma" (código certo, comportamento antigo) hoje.
4. **Realtime habilitado só manualmente no painel do Supabase** (fora do `schema.sql`) — não sobrevive a uma reconstrução do projeto do zero.
5. **Download de mídia recebida** (`baixarEGuardarMidia`) — nunca validado ponta-a-ponta com a instância real; formato de resposta é "melhor palpite".

## 5 partes mais estáveis
1. Conexão/QR Code.
2. Envio e recebimento de texto.
3. Tempo real (recém-corrigido, mecanismo agora é simples e correto).
4. Foto de perfil (recém-implementado, testado e confirmado).
5. Anti-bloqueio / throttle (protegido em dois níveis, com advisory lock).

## Recomendação de ordem de estabilização
1. Corrigir a validação de `mediatype` pra aceitar `"audio"` no `whatsapp-proxy` (1 linha, resolve um 🔴 real).
2. Testar de verdade envio/recebimento de imagem, vídeo, áudio e documento (hoje é só 🟡 "deveria funcionar").
3. Adicionar a habilitação do Realtime em `wa_messages` como SQL versionado (`alter publication supabase_realtime add table wa_messages`) dentro do `schema.sql`, pra não depender de alguém lembrar de clicar no painel.
4. Só depois disso, avançar pra funcionalidades novas (não lidas, toast, status de leitura) — construir em cima de uma base confirmada, não presumida.
