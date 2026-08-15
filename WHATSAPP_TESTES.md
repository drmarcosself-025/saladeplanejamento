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
- Envio de áudio pelo painel está quebrado (rejeitado pelo servidor) — ver `WHATSAPP_INVENTARIO.md`, seção 3.
- LID pode duplicar conversa em casos específicos (mitigado, não resolvido).
- Não lidas, status de leitura (✓✓) e toast de mensagem nova: não implementados.

> Se uma mudança futura "bagunçar tudo", isso aqui é o ponto de referência —
> o que estava confirmado funcionando nesta data, com este commit.
