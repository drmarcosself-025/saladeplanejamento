# WhatsApp da Clinica - Fase 1 (minima)

Este projeto e SO a prova de que a ligacao "Meta WhatsApp Cloud API <-> nosso
servidor <-> Supabase" funciona de ponta a ponta. Nao tem IA, nao tem fila de
reenvio, nao tem logica de negocio - so:

1. Recebe mensagens do WhatsApp e salva na tabela `whatsapp_log` do Supabase.
2. Permite enviar UM template aprovado para UM numero, manualmente, por uma
   rota protegida por senha (ou pela paginha HTML de teste).

## Arquivos deste projeto

- `server.js` - o servidor (todo o codigo de verdade fica aqui, comentado).
- `lib/supabaseClient.js` - conexao com o Supabase.
- `public/index.html` - paginha com um formulario/botao pra testar o envio.
- `sql/whatsapp_log.sql` - script pra criar a tabela nova no Supabase.
- `.env.example` - lista de variaveis de ambiente necessarias (copie para `.env`).

## Passo 1 - Criar a tabela no Supabase

1. Abra o painel do seu projeto Supabase.
2. Va em **SQL Editor** (menu lateral) > **New query**.
3. Copie todo o conteudo do arquivo `sql/whatsapp_log.sql` e cole ali.
4. Clique em **Run**.
5. Confirme em **Table Editor** que a tabela `whatsapp_log` apareceu, com as
   colunas: `id`, `direcao`, `telefone`, `texto`, `wamid`, `status`, `criado_em`.

## Passo 2 - Rodar localmente (opcional, mas recomendado antes do deploy)

Estes comandos assumem que voce tem o [Node.js](https://nodejs.org) instalado
(versao 18 ou mais nova). Rode um de cada vez, no terminal, dentro da pasta
do projeto.

### 1. Instalar as dependencias

```
npm install
```

O que esperar: uma pasta `node_modules` sera criada e vai aparecer uma
mensagem tipo `added 42 packages` no final. Isso baixa as bibliotecas que o
`server.js` usa (Express, cliente do Supabase, etc).

### 2. Criar o arquivo de variaveis de ambiente

```
cp .env.example .env
```

O que esperar: nenhuma saida no terminal (comando silencioso). Agora abra o
arquivo `.env` (recem-criado) num editor de texto e preencha cada variavel -
os comentarios dentro do `.env.example` explicam onde achar cada valor no
painel da Meta e do Supabase. Para testar localmente, o `META_VERIFY_TOKEN` e
o `ENVIAR_TEMPLATE_TOKEN` podem ser qualquer senha inventada por voce (ex:
`teste123`).

### 3. Rodar o servidor

```
npm start
```

O que esperar: a mensagem `Servidor rodando na porta 3000` no terminal. O
terminal fica "preso" nessa tela enquanto o servidor estiver ligado - isso e
normal, use outra aba/janela de terminal para os proximos testes. Para
desligar, aperte `Ctrl + C`.

Rodando localmente, a Meta nao consegue chamar seu webhook (ela precisa de
uma URL publica na internet), entao o teste completo do webhook so acontece
depois do deploy no Passo 3. Mas voce ja pode abrir
`http://localhost:3000` no navegador pra ver a paginha de teste carregando.

## Passo 3 - Deploy no Railway (plano gratuito)

### 1. Subir o codigo para o GitHub

Se ainda nao fez isso, crie um repositorio no GitHub e suba este projeto:

```
git add .
git commit -m "Fase 1: webhook whatsapp + envio manual de template"
git push
```

O que esperar: uma lista de arquivos enviados e, no final, algo como
`branch 'main' set up to track 'origin/main'` ou similar.

### 2. Criar o projeto no Railway

1. Acesse [railway.app](https://railway.app) e faca login (pode ser com sua
   conta do GitHub).
2. Clique em **New Project** > **Deploy from GitHub repo**.
3. Escolha o repositorio deste projeto.
4. O Railway vai detectar que e um projeto Node.js e comecar um primeiro
   deploy automaticamente (ele vai falhar ainda, porque faltam as variaveis
   de ambiente - normal, vamos configurar no proximo passo).

### 3. Colar as variaveis de ambiente no Railway

1. Dentro do projeto criado, clique no servico (o quadradinho com o nome do
   repositorio).
2. Va na aba **Variables**.
3. Clique em **New Variable** (ou use o botao de "colar em bloco" / "Raw
   Editor", se disponivel) e adicione, uma por uma, as MESMAS variaveis do
   seu arquivo `.env`:
   - `META_APP_SECRET`
   - `META_ACCESS_TOKEN`
   - `META_PHONE_NUMBER_ID`
   - `META_VERIFY_TOKEN`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `ENVIAR_TEMPLATE_TOKEN`
4. Nao precisa criar a variavel `PORT` - o Railway define essa automaticamente.
5. Depois de salvar as variaveis, o Railway faz um novo deploy sozinho. Espere
   o status ficar **Success** (ou "Active") na aba **Deployments**.

### 4. Pegar a URL publica do servidor

1. Na aba **Settings** do servico, procure por **Networking** / **Public
   Networking**.
2. Clique em **Generate Domain**.
3. O Railway vai gerar uma URL tipo `https://seu-projeto.up.railway.app`.
   Guarde essa URL - e ela que voce vai usar no painel da Meta.

### 5. Configurar o Webhook no painel da Meta

1. Va em [developers.facebook.com](https://developers.facebook.com) > seu
   App > **WhatsApp** > **Configuration** (ou "Configuracao").
2. Em **Webhook**, clique em **Edit** (ou "Editar").
3. Em **Callback URL**, cole: `https://seu-projeto.up.railway.app/webhooks/whatsapp`
4. Em **Verify token**, cole exatamente o mesmo valor que voce colocou na
   variavel `META_VERIFY_TOKEN` no Railway.
5. Clique em **Verify and save**. Se tudo estiver certo, a Meta chama seu
   servidor (GET) e ele responde com sucesso - a tela vai mostrar confirmado.
6. Ainda na mesma tela, va em **Webhook fields** e clique em **Subscribe**
   no campo `messages` (isso faz a Meta comecar a mandar as mensagens
   recebidas para o seu webhook).

## Checklist de teste manual

Marque cada item conforme for confirmando:

- [ ] **Tabela criada**: `whatsapp_log` aparece no Table Editor do Supabase.
- [ ] **Deploy no ar**: o Railway mostra o deploy como "Success"/"Active".
- [ ] **Verificacao do webhook**: ao clicar em "Verify and save" no painel da
      Meta, aparece confirmacao (sem erro 403).
- [ ] **Recebimento de mensagem**: mande uma mensagem de WhatsApp de outro
      celular para o numero da clinica. Depois, confira no Supabase (Table
      Editor > whatsapp_log) se apareceu uma linha nova com `direcao =
      entrada`, o `telefone` de quem mandou e o `texto` da mensagem.
- [ ] **Assinatura funcionando**: nos logs do Railway (aba **Deployments** >
      clique no deploy ativo > **View Logs**), voce NAO deve ver a mensagem
      "Assinatura invalida" quando uma mensagem de verdade chega da Meta.
- [ ] **Envio manual de template**: abra
      `https://seu-projeto.up.railway.app` no navegador, preencha o
      formulario (telefone, nome exato do template aprovado, idioma, senha) e
      clique em Enviar. Confirme que:
  - [ ] A pagina mostra "Sucesso!" com uma resposta da Meta.
  - [ ] O WhatsApp do numero de destino recebe a mensagem de fato.
  - [ ] Aparece uma linha nova em `whatsapp_log` com `direcao = saida` e
        `status = enviado`.
- [ ] **Protecao funcionando**: tente enviar o formulario com a senha errada
      (campo "Senha da rota") e confirme que a pagina mostra erro 401 / "Token
      invalido" - ou seja, ninguem sem a senha consegue mandar mensagem.

Quando todos os itens acima estiverem marcados, a Fase 1 esta concluida: a
ponte Meta <-> servidor <-> Supabase esta provada, dos dois lados (entrada e
saida).

## Lembrete do plano de aquecimento do numero

Este projeto so envia UM template por vez, manualmente, de proposito - para
te ajudar a seguir o plano de aquecimento conservador (maximo 10 mensagens
iniciadas por dia na primeira semana, so para pacientes que ja confirmaram
interesse). Nao existe nenhum botao de "enviar para todos" nesta fase.
