# Maison D'Or — Auditoria estrutural de confiabilidade (WhatsApp)

Auditoria feita em: 15/08/2026
Código analisado: `main` (commit `a510172`) — **não** a branch de trabalho, a versão que
realmente está publicada hoje (mesmo que ainda não tenha sido copiada pro Supabase).

> Isto é um levantamento de risco, não uma lista de tarefas pra fazer tudo de uma vez.
> Nenhum código foi alterado como parte desta auditoria.

---

## P0 — Perda de dados

### P0.1 — Chamadas ao Supabase sem checar `error`

**Achado confirmado:** em `whatsapp-webhook/index.ts`, todas as chamadas dentro do loop
principal ignoram o retorno `error`:
- linha 252-255: `wa_inbox.update(...)` (sem checar erro)
- linha 257-264: `wa_inbox.insert(...)` (sem checar erro)
- linha 282-285: `wa_messages.upsert(...)` (sem checar erro)
- linha 287-290: `wa_messages.insert(...)` (sem checar erro)

Em `whatsapp-proxy/index.ts`:
- linha 247-250 (`send-text`): `wa_messages.insert(...)` sem checar erro
- linha 326-330 (`send-media`): `wa_messages.insert(...)` sem checar erro

**Risco:** o Postgres pode recusar a gravação (RLS, constraint, coluna obrigatória faltando,
timeout) e a function segue em frente como se nada tivesse acontecido.

**Cenário real de falha:** uma migração futura adiciona uma coluna `not null` sem default;
todo INSERT em `wa_messages` passa a falhar; o webhook continua respondendo `{ok:true}` pra
Evolution API (então ela não reenvia); a mensagem desaparece sem nenhum log de erro visível.

**Correção mínima:** capturar `{ error }` de cada chamada, logar (`console.log` estruturado,
já existe o padrão no arquivo) e, se for a gravação principal da mensagem (não a do `wa_inbox`,
que é secundária), responder um status de erro em vez de `ok:true`.

**Correção estrutural futura:** um wrapper único (`gravarComLog(supabase, tabela, op, dados)`)
usado em todo lugar, pra não depender de lembrar de checar cada chamada manualmente.

---

### P0.2 — Webhook responde `ok:true` mesmo com falha de persistência

**Achado confirmado:** `whatsapp-webhook/index.ts`, linha 294 — `return json({ ok: true })`
incondicional no fim do loop, independente do que aconteceu em cada iteração.

**Risco:** mesmo problema do P0.1, mas no nível da resposta HTTP — a Evolution API usa a
resposta pra decidir se reenvia (`retryWebhookRequest`, já documentado no código-fonte da
Evolution que auditamos antes). Responder sucesso quando algo falhou elimina a chance de
retry automático que já existiria de graça.

**Correção mínima:** acumular falhas durante o loop; se alguma gravação principal falhou,
responder status 500 com detalhe (a Evolution já tem lógica de retry exponencial pronta,
não construída por nós — só precisa parar de mascarar o erro).

---

### P0.3 — `fromMe` é descartado inteiramente

**Achado confirmado:** `whatsapp-webhook/index.ts`, linha 220 —
`if (item.key?.fromMe) continue;`

**Risco:** mensagem mandada direto do celular da clínica ou do WhatsApp Web (não pelo painel)
nunca entra no pipeline em tempo real — só reaparece depois de "Sincronizar conversas" manual.
Isso quebra a promessa de "espelhar a conversa real do WhatsApp".

**Cenário real:** recepcionista responde uma paciente direto pelo celular (mais rápido que
abrir o painel); essa resposta não aparece pra ninguém até alguém lembrar de sincronizar.

**Correção mínima:** remover o `continue` só pra mensagens que **não** vieram do `whatsapp-proxy`
(que já grava as enviadas pelo painel). Como já existe dedupe por `wa_message_id` (upsert com
`onConflict: "wa_message_id"`), processar `fromMe` de novo é seguro — na pior hipótese, é um
upsert redundante sobre uma linha que o proxy já gravou.

**Risco a considerar antes de mexer:** a `wa_inbox` (fila de rascunho da IA) usa `direcao`
implícito ("recebida") — teria que revisar essa parte pra não tratar mensagem enviada pela
própria clínica como se fosse do paciente.

**Correção estrutural futura:** nenhuma — essa é resolvível com o modelo atual, só precisa de
teste cuidadoso antes de habilitar.

---

### P0.4 — Concorrência no `wa_inbox` (read-modify-write do array `mensagens`)

**Achado confirmado:** `whatsapp-webhook/index.ts`, linhas 242-266 — busca a conversa
"aguardando" (`select`), monta o array em JavaScript (`[...(existente.mensagens||[]), {...}]`),
e só depois faz `update`. Três passos separados, sem lock.

**Risco:** duas mensagens chegando quase ao mesmo tempo (webhook processa em paralelo,
sem fila serializada) podem ler o mesmo estado inicial e uma sobrescrever a outra — perde-se
uma mensagem da fila de rascunho da IA (o histórico em `wa_messages` continua correto, é só
a fila de rascunho que perde uma).

**Cenário real:** paciente manda duas mensagens em sequência rápida ("Oi" + "Queria saber
sobre Invisalign"); a IA gera rascunho só considerando uma delas.

**Correção mínima:** função Postgres com `pg_advisory_xact_lock` (mesmo padrão já usado em
`wa_throttle_claim`, em `schema.sql`) fazendo o append atomicamente no banco, não em JavaScript.

**Correção estrutural futura:** trocar `mensagens jsonb` (array mutável) por uma tabela própria
de itens da fila, evitando o padrão read-modify-write de vez.

---

### P0.5 — Download de mídia acontece antes da mensagem estar garantidamente salva

**Achado confirmado:** `whatsapp-webhook/index.ts`, linhas 272-291 — a ordem é: baixar mídia
(`baixarEGuardarMidia`, uma chamada de rede extra pra Evolution) **primeiro**, e só depois
gravar a linha em `wa_messages`.

**Risco:** se o download travar/demorar (rede lenta, Evolution sobrecarregada, arquivo grande),
a mensagem inteira demora ou falha por causa de um problema que é só do anexo — o texto/metadado
já poderia estar salvo independentemente.

**Nuance:** hoje isso já é parcialmente mitigado — `baixarEGuardarMidia` tem `try/catch` interno
e retorna `null` em vez de lançar exceção, então uma falha no download **não** impede a
mensagem de ser salva (ela só fica sem `media_path`). O risco real é de **latência**
(function decorrida mais tempo, mais chance de timeout do lado da Evolution), não de perda.

**Correção mínima:** nenhuma urgente — o comportamento atual já é "degrada graciosamente".

**Correção estrutural futura:** separar em duas etapas (mensagem salva imediatamente com
`media_status: 'pending'`; um processo separado baixa e atualiza pra `'ready'`/`'failed'`)
se o volume de mídia crescer a ponto da latência incomodar.

---

### P0.6 — Timeout e resposta não-JSON da Evolution

**Achado confirmado:** nenhuma chamada `fetch()` em `whatsapp-webhook` ou `whatsapp-proxy` tem
timeout explícito (usa o timeout padrão do runtime, que existe mas não é controlado por nós).
`await r.json()` é chamado direto em vários pontos (`whatsapp-proxy` linha 228, 313; `sync-messages`
já usa `.catch(() => null)` nas páginas, mas `send-text`/`send-media` **não**).

**Risco:** se a Evolution (ou um proxy/CDN na frente dela) responder algo não-JSON (HTML de
erro 502, corpo vazio), `r.json()` lança exceção não tratada — a function inteira falha com 500
genérico, sem log estruturado do que realmente aconteceu.

**Correção mínima:** trocar `await r.json()` por `await r.json().catch(() => null)` nos pontos
que ainda não têm essa proteção (`send-text`, `send-media`), e logar quando vier `null`.

---

### P0.7 — Envio confirmado pela Evolution, gravação falha depois

**Achado confirmado:** mesmo ponto do P0.1 — `whatsapp-proxy`, `send-text` (linha 247) e
`send-media` (linha 326): se `r.ok` (Evolution confirmou o envio) mas o `insert` em
`wa_messages` falhar, a function responde `respBody` (sucesso da Evolution) sem avisar que o
histórico não foi salvo.

**Risco:** mensagem realmente enviada ao paciente, mas sem registro no painel — a equipe acha
que não mandou (ou manda de novo).

**Correção mínima:** checar `error` do insert; se falhar, ainda retornar sucesso pro usuário
(a mensagem FOI enviada, não faz sentido dizer que falhou), mas logar com destaque
(`event: "grave_historico_falhou_apos_envio_confirmado"`) pra aparecer separado nos Logs.

---

### P0.8 — Regra "telefone real nunca pode virar LID" no código versionado

**Achado confirmado:** **a correção existe, mas não está na `main` ainda** — está commitada
na branch de trabalho (`fbe520d`), pendente de merge. Na `main` atual, tanto `whatsapp-webhook`
quanto `whatsapp-proxy`/`sync-messages` fazem upsert direto de `telefone`/`telefone_e_lid` sem
checar o que já existia.

**Ação:** mesclar `fbe520d` — não é uma correção nova, é destravar uma que já foi escrita.

---

## P1 — Observabilidade / recovery

### P1.1 — `wa_events` (fila/registro de recebimento)
**Não existe hoje.** Proposta: tabela separada que registra "a Evolution mandou isso" antes
de qualquer interpretação, com status (`received`/`processing`/`processed`/`failed`/`ignored`).
**Correção estrutural futura** — não é pouco código, envolve mudar o formato do handler pra
duas fases (recebe+grava bruto / processa depois). Não recomendo começar sem planejar à parte.

### P1.2 — Dead-letter para formato desconhecido
**Parcialmente existe:** o `sync-messages` já conta `formatoDesconhecido` no retorno (feito
hoje), mas não persiste — desaparece quando a tela fecha. **Correção mínima:** gravar numa
tabela simples (`wa_ingest_desconhecidos`: `wa_message_id`, `payload_bruto`, `recebido_em`)
sempre que cair em "formato desconhecido", tanto no sync quanto no webhook.

### P1.3 — `debugMessageId` expõe payload bruto
**Achado confirmado:** `whatsapp-proxy/index.ts`, linha ~445-454 (já na `main`, mesclado hoje)
— `itemBruto: achado` devolve o item inteiro (incluindo texto da mensagem do paciente) pra
quem chamar a ação, sem filtro. **Risco:** informação de paciente trafegando/logada em
ferramentas de debug do navegador. **Correção mínima:** trocar `itemBruto: achado` por um
resumo (`tipo`, `temTexto: boolean`, `tamanhoTexto`, `remoteJid` mascarado, `messageTimestamp`)
sem o conteúdo real.

### P1.4 — `source`, `received_at`, `processed_at`, `raw_remote_jid*`, `instance`
**Não existem hoje.** `wa_messages` só tem `created_at` (data da mensagem no WhatsApp, não de
quando processamos). Proposta de colunas aditivas (`add column if not exists`, não quebra
nada existente) — viável como correção mínima quando decidirmos fazer, mas requer também
atualizar os dois arquivos que gravam a tabela.

### P1.5 — Sync incremental + reconciliador leve
**Achado confirmado:** `sync-messages` sempre busca do zero (até 10 páginas × 200 = 2000 itens),
sem lembrar de onde parou da última vez. **Correção estrutural futura** — guardar
`ultima_sincronizacao_em` (por telefone ou global) e usar como filtro na próxima chamada, se
a Evolution API instalada suportar filtro por data (precisa confirmar na documentação da
versão real, não assumir).

### P1.6 — Teto de 10 páginas × 200 mensagens
**Achado confirmado**, `whatsapp-proxy/index.ts` linha ~355-357. Hoje (poucos meses de uso)
não é um problema real — é uma preocupação de médio prazo, não urgente.

---

## P1 — Identidade (desenho, sem migrar ainda)

**Proposta (não implementar agora):** `wa_contacts` (pessoa/paciente real) +
`wa_contact_identities` (aliases: `phone`, `pn_jid`, `lid`, cada um com nível de confiança).
Mensagens passariam a referenciar `contact_id` em vez de `telefone` direto.

**Por que não fazer agora:** é uma migração de dado real (toda a tabela `wa_messages` existente
precisaria ganhar `contact_id` e passar por um processo de "resolver identidade" retroativo).
Justamente por resolver o problema do LID **na raiz**, é a mudança de maior risco da lista —
merece uma sessão própria, com um plano de migração e teste, não uma alteração encaixada.

**Chave composta `(instance, wa_message_id)`:** hoje `wa_message_id` é único globalmente (uma
única instância Evolution rodando). Só passa a importar no dia em que houver mais de uma
instância — não é urgente com uma clínica só.

---

## P2 — Performance

### P2.1 — Realtime recarrega a tabela inteira a cada mensagem
**Achado confirmado:** `index.html`, `waStartRealtime` → callback chama `renderWaConversations()`
→ que faz `sb.from('wa_messages').select('*').order(...)` (busca **todas** as mensagens, sempre).
**Risco:** com centenas/milhares de mensagens, cada mensagem nova recarrega tudo — lento e caro.
**Correção estrutural futura:** tabela `wa_conversations` (resumo por conversa: última mensagem,
horário, não lidas) pra alimentar a lista sem precisar do histórico completo; histórico
paginado (últimas 50 + "carregar mais") só ao abrir uma conversa específica.
**Não é urgente hoje** (volume atual é baixo), mas é a maior bomba-relógio de performance da
lista.

### P2.2 — Busca de foto de perfil sem limite de concorrência
**Achado confirmado:** `index.html`, `waLoadAvatarsPendentes` usa `Promise.all(pendentes.map(...))`
— todas as buscas de uma vez, sem teto. Com poucos contatos (hoje) é rápido e sem risco; com
centenas de contatos novos de uma vez, dispara muitas chamadas simultâneas pra Evolution API.
**Correção mínima futura:** processar em lotes de 4-8 por vez em vez de tudo de uma vez.

---

## P2 — Lifecycle (modelo de dados, sem UI ainda)

Não existe hoje nenhum campo de status de entrega (`pending`/`sent`/`delivered`/`read`/`failed`),
nem de edição/exclusão/resposta citada. Fica registrado como direção futura — **não** desenhar
o schema disso agora; é acoplado à decisão de identidade (P1) e merece ser pensado junto.

---

## Segurança

### RLS de `wa_messages`/`wa_inbox`
**Achado confirmado**, `schema.sql` linhas 505-522: as policies de `update` são
`using (true)` **sem** `with check` restringindo colunas — qualquer usuário autenticado pode
alterar qualquer campo de qualquer mensagem (incluindo `wa_message_id`, `direcao`, `telefone`),
não só marcar como lida. Só o `delete` é restrito a `is_owner()`.
**Risco real, hoje:** baixo (equipe pequena, confiável) — mas é uma porta aberta maior do que
o necessário.
**Correção mínima futura:** RLS mais específica (`with check` limitando quais colunas podem
mudar) ou mover updates sensíveis pra dentro de uma function (`security definer`), como já é
o padrão usado em `wa_throttle_claim`.

### CORS
`Access-Control-Allow-Origin: "*"` nas duas functions — aberto pra qualquer origem. Aceitável
hoje (as actions exigem JWT/secret), mas vale revisar se algum dia isso for um problema.

### Segredo do webhook
Já auditado e corrigido hoje (rotacionado). Continua na query string da URL (risco de design
já conhecido e aceito, não meta pra hoje).

---

## Operação

### Painel de saúde / detectar GitHub ≠ Supabase
**Não existe hoje.** Essa é, na prática, a lacuna que mais nos custou tempo hoje (várias horas
de confusão por function desatualizada no Supabase). **Recomendo priorizar isso primeiro entre
os itens de P1/operação** — mesmo que simples (uma action `version` que devolve o hash do commit
embutido no build, comparável manualmente com o GitHub).

---

## Testes

### Fixtures sanitizadas dos parsers
**Não existe hoje.** Proposta: arquivos JSON de exemplo (texto, imagem, vídeo, áudio, documento,
figurinha, `ephemeralMessage`, `viewOnceMessage`, LID com/sem `remoteJidAlt`, `fromMe`, formato
desconhecido) + um teste que roda `extractText`/`extractTipo`/`desembrulhar` contra cada um e
confirma o resultado esperado. **Baixo custo, alto valor** — não precisa de deploy nem mudança
de produção, só um script de teste dentro do repositório.

---

## Ordem de execução recomendada

1. Mesclar `fbe520d` (P0.8 — já pronto).
2. P0.1 + P0.2 + P0.7 (checar erro, não fingir sucesso) — mesma categoria, pouco código, alto valor.
3. P0.6 (`r.json()` defensivo) — trivial.
4. Testes de fixture (baixo custo, protege contra regressão nas correções de hoje).
5. Painel de saúde / detecção de versão desatualizada — ataca o maior gargalo operacional real de hoje.
6. P0.3 (`fromMe`) — mudança de comportamento real, precisa de teste cuidadoso antes de publicar.
7. P0.4 (concorrência `wa_inbox`) — function Postgres dedicada, mesmo padrão do throttle.
8. P1.3 (sanitizar `debugMessageId`) — pequeno, mas envolve dado de paciente, não deixar pra depois.
9. Todo o resto (identidade/contatos, `wa_events`, `wa_conversations`, lifecycle, sync incremental,
   reconciliador) — cada um como projeto próprio, com sessão dedicada.

## O que NÃO mexer agora
- Modelo de identidade (`wa_contacts`/`wa_contact_identities`) — mudança de schema arriscada, não apressar.
- `wa_events` / restruturar o pipeline em duas fases — mudança grande de arquitetura.
- Qualquer feature cosmética (não lidas, toast, "digitando...", UI) — já combinado, fica pra depois dos P0.
- CI/CD automático — só faz sentido depois de termos uma versão realmente estável congelada.
