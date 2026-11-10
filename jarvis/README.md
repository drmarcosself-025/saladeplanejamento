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

## Voz

| Controle | O que faz |
|---|---|
| 🗣 **Segurar** (ou segure **Espaço**, fora de campos de texto) | Escuta só enquanto você aperta. Dispensa dizer “Jarvis”. Mais confiável com barulho. |
| 🎙 **Contínuo** | Fica ouvindo e só responde quando ouvir “Jarvis” (aceita “Jarvi”, “Jarves”…). Pausa enquanto o Jarvis fala, para não ouvir a si mesmo. |
| Medidor ao lado do 🎙 | Mostra o nível real do microfone. Se não mexe, o navegador não está ouvindo. |
| Painel **Voz** | Escolha da voz do Jarvis, velocidade e “Testar voz”. |

Enquanto você fala, o texto aparece ao vivo abaixo do avatar, e o avatar reage
à sua voz.

**Privacidade:** no Chrome/Edge o reconhecimento de fala é feito pelo servidor
do navegador (Google/Microsoft): o áudio **sai do seu computador** enquanto o
microfone está ativo. A voz do Jarvis é local. Para falar nome de paciente,
use o modo segurar só quando precisar, ou digite.

Se o microfone não funcionar: abra por `http://localhost:8000` (não pelo
arquivo), permita o microfone no cadeado da barra de endereço, e use Chrome ou
Edge. No iPhone/Safari o reconhecimento de voz é limitado: digite.

## Experimente

- “Jarvis, ativa o agente gestão do dia”
- “quero confirmar os pacientes de amanhã” → aparece o painel de confirmação
- “Jarvis, confirma” (em demonstração **não envia nada**)
- “Jarvis, ativa agora o agente social media”
- “Jarvis, desativa o agente social media” / “volta ao normal”
- Ou clique nos atalhos no topo.

### Mandar mensagem no WhatsApp (funciona hoje, em qualquer modo)

1. Abra **Contatos** (painel à esquerda) e cadastre nome + WhatsApp com DDD.
   Os contatos ficam só no seu navegador.
2. Diga ou digite, por exemplo:
   - “Jarvis, manda mensagem pro João Silva dizendo que a consulta é amanhã às 9h”
   - “Jarvis, entra em contato com a Maria” → ele pergunta o que dizer
3. O Jarvis mostra a mensagem no painel. Diga **“confirma”** (ou clique em
   Confirmar) e o WhatsApp abre na conversa certa **com o texto pronto**.
   Você toca em enviar. **Nada é enviado sozinho.**

Se houver dois contatos parecidos (“João”), ele pergunta qual. Se a confirmação
foi por voz e o navegador bloquear a janela, use o botão Confirmar.

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
