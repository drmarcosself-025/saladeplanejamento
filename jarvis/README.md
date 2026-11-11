# Jarvis

## Interface 3.0

Navegação **Hoje / Conversa / Espaços / Você**, busto holográfico azul com núcleo âmbar e compositor separado da navegação no celular. Hoje reúne retornos reais, contas pendentes e prioridades que você cadastra. A área Você guarda nome, tom, foco e rotina apenas neste navegador. O contexto pessoal só acompanha perguntas ao Claude se você ativar a opção correspondente. As tarefas pessoais também ficam neste navegador; leads e financeiro preservam o armazenamento do artefato.

O arquivo único agora inclui viewport para abertura em celulares. A atualização do código não altera automaticamente o artefato já publicado no Claude.

Painel privado de voz e texto para organizar leads, finanças e tarefas da clínica. O avatar e sete modos ficam no mesmo artefato HTML. **Agenda, e-mails, tráfego e social são demonstração.** Leads e lançamentos financeiros são seus dados.

## Usar localmente

```bash
cd jarvis/web
python3 -m http.server 8000
# abra http://localhost:8000
```

Use os botões do topo ou digite “abre o CRM”, “novo lead, João, 27 99999-1234, veio do Instagram, quer alinhadores”, “conta de energia 189,90 vence sexta”, “resumo financeiro do mês” e “ativa o agente designer”. No CRM, arraste cartões no computador; no celular, abra o cartão e escolha a etapa. Em Contador, navegue por mês, lance valores, marque pago, exporte CSV e copie o relatório.

A voz fala um resumo curto; detalhes e textos gerados aparecem em cartões com botão **Copiar**. Perguntas abertas usam o Claude apenas no artefato com a capacidade `sample`; sem ela, o painel informa que não está disponível. Não promete executar programação, publicar posts, pagar contas ou enviar WhatsApp.

O link do WhatsApp abre uma conversa com a mensagem pronta; você precisa tocar em **Enviar**. Depois, marque **Contato realizado** na ficha se de fato falou com o lead.

## Dados

No artefato, leads e financeiro são documentos privados para o dono, sincronizados pelo armazenamento `db` do Claude. Fora do artefato, ficam apenas no navegador em que foram lançados. Contatos importados e registro técnico ficam no navegador. Evite registrar dados clínicos e guarde só o necessário para o atendimento.

## Gerar e verificar

```bash
node jarvis/tools/build-artifact.mjs saida.html
node --test jarvis/tests/*.test.mjs
# com o servidor local rodando e Chromium disponível:
node jarvis/tests/browser.mjs
```

Publicar `saida.html` requer Artifact com todas as capacidades e regras de dono descritas em [ARQUITETURA.md](ARQUITETURA.md). A integração automática com WhatsApp, Clinicorp e e-mail pertence à próxima fase.
