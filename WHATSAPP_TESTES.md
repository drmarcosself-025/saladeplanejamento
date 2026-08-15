# Maison D'Or — Teste de saúde do módulo WhatsApp

Use dois celulares/números:
- **A** = o WhatsApp Business já conectado no painel (o da clínica).
- **B** = qualquer outro WhatsApp (pessoal, de teste).

Rode esse roteiro sempre na mesma ordem, sempre que quiser confirmar que nada
quebrou depois de uma mudança. Marque cada passo com ✅ ou 🔴 e anote a data.

Não precisa rodar toda vez que mudar qualquer coisinha — só depois de mudanças
que mexam no WhatsApp (index.html, whatsapp-proxy, whatsapp-webhook,
whatsapp-process-inbox, ou configuração da Evolution API).

## Roteiro

1. [ ] Abrir o painel (`drmarcosself-025.github.io/saladeplanejamento`).
2. [ ] Confirmar badge **"Conectado"** (não "Desconectado" nem QR Code).
3. [ ] De **B**, mandar uma mensagem de texto pra **A**.
4. [ ] Sem clicar em nada, esperar ~15s e confirmar que a mensagem **aparece sozinha** no painel (não precisa de "Sincronizar conversas").
5. [ ] Responder pelo painel (de **A** pra **B**).
6. [ ] Confirmar que **B** recebeu a resposta no celular.
7. [ ] De **B**, mandar uma **foto**.
8. [ ] De **A** (painel), mandar uma **foto** de volta.
9. [ ] De **B**, mandar um **áudio**.
10. [ ] De **B**, mandar um **documento** (PDF, por exemplo).
11. [ ] Atualizar a página do painel (F5).
12. [ ] Confirmar que o **histórico continua todo lá** (nada sumiu).
13. [ ] Conferir se o **nome** do contato está certo.
14. [ ] Conferir se o **telefone** está certo (sem código estranho de LID).
15. [ ] Conferir se a **foto de perfil** do contato apareceu (se ele tiver foto pública).
16. [ ] Confirmar que **não apareceu conversa duplicada** pro mesmo contato.
17. [ ] Fechar a aba e abrir de novo.
18. [ ] Confirmar que tudo continua igual (conectado, histórico, fotos).

## Matriz completa — entrada/saída por tipo de mensagem

Roteiro mais detalhado que os passos 7-10 do "Roteiro" acima, cobrindo os
dois sentidos (enviar de A, receber em B / mandar de B, receber em A) pra
cada tipo de conteúdo. Marque cada célula com ✅ ou 🔴 e a data do teste.
Enquanto uma célula não for testada de verdade, ela fica 🟡 (código existe,
sem confirmação) — não marque ✅ só porque "deveria funcionar".

| Tipo | B → A (recebido) | A → B (enviado) | Aparece no histórico após F5? | Observações |
|---|---|---|---|---|
| Texto | 🟡 | 🟡 | 🟡 | |
| Imagem | 🟡 | 🟡 | 🟡 | |
| Vídeo | 🟡 | 🟡 | 🟡 | |
| Áudio | 🟡 | 🟡 | 🟡 | corrigido no código (commit `3e0c382`), nunca testado de ponta a ponta |
| Documento (PDF) | 🟡 | 🟡 | 🟡 | |
| Figurinha (sticker) | 🟡 | — (painel não tem botão de enviar figurinha) | 🟡 | recebimento relatado como "lento" antes da correção de reconexão do tempo real (commit `b08e8df`) — ainda sem confirmação após essa correção |

Passo a passo pra preencher a matriz (repita pra cada linha/tipo):
1. Mandar o conteúdo de **B** pra **A**, sem tocar em nada no painel.
2. Cronometrar: apareceu sozinho em até ~5s? Marque ✅ nessa célula. Se só apareceu depois de "Sincronizar conversas" ou de um F5, marque 🔴 e anote quanto tempo demorou.
3. Pelo painel (conversa de **A**), mandar o mesmo tipo de conteúdo de volta pra **B**.
4. Confirmar no celular **B** que chegou certo (imagem abre, áudio toca, documento abre, vídeo reproduz).
5. Dar F5 no painel e confirmar que tanto a mensagem recebida quanto a enviada continuam no histórico, com a mídia carregando normalmente (não só o texto/legenda).

## Baseline mais recente

**Maison D'Or WhatsApp — Baseline 1.0**
Data: 15/08/2026
Commit: `3543104`

Confirmado funcionando (rodado de verdade, não só "deveria funcionar"):
- Conexão / QR Code
- Envio de texto
- Recebimento de texto
- Tempo real (mensagem aparece sem clicar em nada)
- Foto de perfil do contato
- Correção manual de telefone (LID)
- Sincronização manual de histórico

Ainda não confirmado com teste real (passos 7-10 do roteiro acima nunca foram
executados de ponta a ponta desde a migração pra Hetzner):
- Envio/recebimento de imagem, vídeo, áudio, documento

Problemas conhecidos nesta baseline:
- Envio de áudio pelo painel foi corrigido no código (commit `3e0c382`), mas ainda não tem teste real confirmando — ver matriz acima e `WHATSAPP_INVENTARIO.md`, seção 3.
- LID pode duplicar conversa em casos específicos (mitigado, não resolvido).
- Não lidas, status de leitura (✓✓) e toast de mensagem nova: não implementados.

Correções feitas **depois** desta baseline, ainda não incorporadas nela (a
baseline só muda quando alguém rodar o roteiro completo de novo e confirmar):
- Caixa de compor mensagem sumindo em conversas longas (bug de CSS) — commit `061d8f5`.
- Reconexão automática do tempo real quando o canal cai sozinho — commit `b08e8df`.

> Se uma mudança futura "bagunçar tudo", isso aqui é o ponto de referência —
> o que estava confirmado funcionando nesta data, com este commit.
