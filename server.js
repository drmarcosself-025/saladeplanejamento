// Servidor da Fase 1 da automacao de WhatsApp da clinica.
//
// O que este arquivo faz (e SO isso):
//   1. GET  /webhooks/whatsapp     -> responde ao "desafio" de verificacao da Meta
//   2. POST /webhooks/whatsapp     -> recebe mensagens do WhatsApp e so salva no Supabase
//   3. POST /enviar-template       -> manda UM template pra UM numero, manualmente
//   4. GET  /                      -> pagina HTML simples com um botao pra testar o envio
//
// Nao ha fila, nao ha IA, nao ha reenvio automatico. So o minimo pra provar que a
// ponte "Meta <-> nosso servidor <-> Supabase" funciona.

require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const supabase = require('./lib/supabaseClient');

const app = express();

// Guardamos o corpo "cru" (raw) da requisicao, porque a validacao de assinatura da Meta
// (X-Hub-Signature-256) precisa ser calculada sobre os bytes exatos que a Meta enviou -
// se a gente so usar o JSON ja "interpretado", a assinatura nao bate.
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Serve a paginha HTML de teste (public/index.html) em "/".
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// 1) GET /webhooks/whatsapp - verificacao do webhook (feita uma vez, no painel da Meta)
// ---------------------------------------------------------------------------
// Quando voce cadastra a URL do webhook no painel da Meta, ela faz uma chamada GET
// pra confirmar que o servidor e realmente seu. A Meta manda um "verify_token" que
// deve ser igual ao que voce configurou (META_VERIFY_TOKEN), e um "challenge" que
// a gente so precisa devolver de volta.
app.get('/webhooks/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    console.log('Webhook verificado com sucesso pela Meta.');
    return res.status(200).send(challenge);
  }

  console.log('Falha na verificacao do webhook (token nao confere).');
  return res.sendStatus(403);
});

// ---------------------------------------------------------------------------
// 2) POST /webhooks/whatsapp - recebe mensagens e apenas registra no Supabase
// ---------------------------------------------------------------------------
app.post('/webhooks/whatsapp', async (req, res) => {
  // Primeiro conferimos a assinatura, pra garantir que quem mandou isso foi
  // realmente a Meta (e nao alguem tentando forjar uma mensagem).
  if (!assinaturaValida(req)) {
    console.log('Assinatura invalida - requisicao ignorada.');
    return res.sendStatus(401);
  }

  // Respondemos 200 rapido pra Meta parar de tentar reenviar. O processamento
  // em si e simples e rapido (so um insert), entao fazemos tudo antes de responder.
  try {
    const entradas = req.body?.entry || [];

    for (const entrada of entradas) {
      for (const mudanca of entrada.changes || []) {
        const mensagens = mudanca.value?.messages || [];

        for (const mensagem of mensagens) {
          await registrarMensagem({
            direcao: 'entrada',
            telefone: mensagem.from,
            texto: extrairTexto(mensagem),
            wamid: mensagem.id,
            status: 'recebido',
          });
        }
      }
    }
  } catch (erro) {
    // Mesmo se der erro ao salvar, respondemos 200 pra Meta (senao ela fica
    // reenviando o mesmo webhook varias vezes). O erro fica so no log do servidor.
    console.error('Erro ao registrar mensagem recebida:', erro);
  }

  return res.sendStatus(200);
});

// Extrai um texto legivel da mensagem, dependendo do tipo (texto, imagem, audio, etc).
function extrairTexto(mensagem) {
  if (mensagem.type === 'text') {
    return mensagem.text?.body || '';
  }
  // Para outros tipos (imagem, audio, botao, etc.) so guardamos uma indicacao do tipo,
  // sem processar o conteudo - isso fica pra uma fase futura.
  return `[mensagem do tipo: ${mensagem.type}]`;
}

// Confere a assinatura HMAC-SHA256 que a Meta manda no header X-Hub-Signature-256.
function assinaturaValida(req) {
  const assinaturaRecebida = req.get('X-Hub-Signature-256');
  if (!assinaturaRecebida || !req.rawBody) return false;

  const hmac = crypto.createHmac('sha256', process.env.META_APP_SECRET);
  hmac.update(req.rawBody);
  const assinaturaEsperada = 'sha256=' + hmac.digest('hex');

  // Usamos timingSafeEqual pra evitar "timing attacks" (comparar string por string
  // normal pode vazar informacao sobre onde a comparacao falhou).
  const bufRecebido = Buffer.from(assinaturaRecebida);
  const bufEsperado = Buffer.from(assinaturaEsperada);

  if (bufRecebido.length !== bufEsperado.length) return false;
  return crypto.timingSafeEqual(bufRecebido, bufEsperado);
}

// Insere uma linha na tabela whatsapp_log.
async function registrarMensagem({ direcao, telefone, texto, wamid, status }) {
  const { error } = await supabase
    .from('whatsapp_log')
    .insert({ direcao, telefone, texto, wamid, status });

  if (error) {
    console.error('Erro ao inserir em whatsapp_log:', error);
  }
}

// ---------------------------------------------------------------------------
// 3) POST /enviar-template - envia UM template pra UM numero, manualmente
// ---------------------------------------------------------------------------
// Protegido por uma senha simples (ENVIAR_TEMPLATE_TOKEN) pra evitar que qualquer
// pessoa que descubra o endereco do servidor consiga mandar mensagens pelo seu numero.
app.post('/enviar-template', async (req, res) => {
  const tokenRecebido = req.get('x-token');
  if (!process.env.ENVIAR_TEMPLATE_TOKEN || tokenRecebido !== process.env.ENVIAR_TEMPLATE_TOKEN) {
    return res.status(401).json({ erro: 'Token invalido.' });
  }

  const { telefone, template, idioma, parametros } = req.body || {};

  if (!telefone || !template || !idioma) {
    return res.status(400).json({
      erro: 'Faltam campos obrigatorios: telefone, template e idioma.',
    });
  }

  const corpoRequisicao = {
    messaging_product: 'whatsapp',
    to: telefone,
    type: 'template',
    template: {
      name: template,
      language: { code: idioma },
    },
  };

  // Se foram passados parametros (ex: nome do paciente, data, hora), eles preenchem
  // as variaveis {{1}}, {{2}}, etc. do corpo do template aprovado na Meta.
  if (Array.isArray(parametros) && parametros.length > 0) {
    corpoRequisicao.template.components = [
      {
        type: 'body',
        parameters: parametros.map((valor) => ({ type: 'text', text: String(valor) })),
      },
    ];
  }

  try {
    const respostaMeta = await fetch(
      `https://graph.facebook.com/v21.0/${process.env.META_PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(corpoRequisicao),
      }
    );

    const dadosResposta = await respostaMeta.json();
    const deuCerto = respostaMeta.ok;

    await registrarMensagem({
      direcao: 'saida',
      telefone,
      texto: `template: ${template}`,
      wamid: dadosResposta?.messages?.[0]?.id || null,
      status: deuCerto ? 'enviado' : 'erro',
    });

    if (!deuCerto) {
      console.error('Erro retornado pela Meta:', dadosResposta);
      return res.status(502).json({ erro: 'Meta recusou o envio.', detalhes: dadosResposta });
    }

    return res.status(200).json({ sucesso: true, resposta: dadosResposta });
  } catch (erro) {
    console.error('Erro ao chamar a API da Meta:', erro);
    return res.status(500).json({ erro: 'Falha ao chamar a API da Meta.' });
  }
});

// ---------------------------------------------------------------------------
const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
  console.log(`Servidor rodando na porta ${PORTA}`);
});
