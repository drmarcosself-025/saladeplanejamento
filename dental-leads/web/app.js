// Painel do funil. Uma tela, um Kanban, um drawer.
//
// O navegador nunca vê a service role key: usa a anon key + sessão, e o RLS
// no Postgres é quem decide o que pode ser lido e quais colunas podem ser
// alteradas. Não existe chamada para Evolution nem para IA aqui.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  window.APP_CONFIG.SUPABASE_URL,
  window.APP_CONFIG.SUPABASE_ANON_KEY,
  { db: { schema: "dental_leads" } },
);

const COLUMNS = [
  { stage: "NEW", label: "Novo" },
  { stage: "CONVERSATION", label: "Em conversa" },
  { stage: "INTEREST", label: "Interesse" },
  { stage: "SCHEDULING", label: "Agendamento" },
  { stage: "CONVERTED", label: "Convertido" },
  { stage: "LOST", label: "Perdido" },
];

const AUTOMATION_LABEL = {
  ACTIVE: "IA ativa",
  HUMAN_REQUIRED: "⚠ Humano necessário",
  HUMAN_TAKEOVER: "Humano assumiu",
  PAUSED: "IA desligada",
};

const POLL_INTERVAL_MS = 20000;

const el = (id) => document.getElementById(id);
const state = { leads: [], lastMessages: new Map(), selectedId: null, timer: null };

// ---------------------------------------------------------------------------
// Sessão
// ---------------------------------------------------------------------------
el("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  el("loginError").hidden = true;
  const { error } = await supabase.auth.signInWithPassword({
    email: el("email").value.trim(),
    password: el("password").value,
  });
  if (error) {
    el("loginError").textContent = "Não foi possível entrar. Confira e-mail e senha.";
    el("loginError").hidden = false;
    return;
  }
  await start();
});

el("logoutBtn").addEventListener("click", async () => {
  clearInterval(state.timer);
  await supabase.auth.signOut();
  el("app").hidden = true;
  el("login").hidden = false;
});

el("refreshBtn").addEventListener("click", () => load());

async function start() {
  el("login").hidden = true;
  el("app").hidden = false;
  await load();
  clearInterval(state.timer);
  // Polling simples: um Kanban de clínica não precisa de tempo real.
  state.timer = setInterval(load, POLL_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Dados
// ---------------------------------------------------------------------------
async function load() {
  const { data: leads, error } = await supabase
    .from("leads")
    .select("id, whatsapp_id, phone, is_lid, name, stage, treatment_interest, automation_status, needs_human, human_reason, conversation_summary, last_message_at")
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(300);

  if (error) {
    console.error(error);
    return;
  }

  state.leads = leads ?? [];

  // Última mensagem de cada lead, em uma consulta só. Não é histórico
  // navegável — é a prévia do card.
  const { data: messages } = await supabase
    .from("messages")
    .select("lead_id, text, direction, created_at")
    .order("created_at", { ascending: false })
    .limit(600);

  state.lastMessages = new Map();
  for (const message of messages ?? []) {
    if (!state.lastMessages.has(message.lead_id)) {
      state.lastMessages.set(message.lead_id, message);
    }
  }

  render();
  el("updatedAt").textContent = `atualizado ${formatTime(new Date().toISOString())}`;
  if (state.selectedId) openDrawer(state.selectedId, false);
}

// ---------------------------------------------------------------------------
// Kanban
// ---------------------------------------------------------------------------
function render() {
  const board = el("board");
  board.textContent = "";

  for (const column of COLUMNS) {
    const leads = state.leads.filter((lead) => lead.stage === column.stage);

    const section = document.createElement("section");
    section.className = "column";

    const title = document.createElement("h2");
    title.append(column.label, Object.assign(document.createElement("span"), {
      textContent: String(leads.length),
    }));
    section.append(title);

    for (const lead of leads) section.append(renderCard(lead));
    board.append(section);
  }
}

function renderCard(lead) {
  const card = document.createElement("article");
  card.className = "card" + (lead.needs_human ? " needs-human" : "");
  card.addEventListener("click", () => openDrawer(lead.id, true));

  const name = document.createElement("div");
  name.className = "name";
  name.textContent = lead.name || displayPhone(lead);
  card.append(name);

  if (lead.treatment_interest) {
    const interest = document.createElement("div");
    interest.className = "interest";
    interest.textContent = lead.treatment_interest;
    card.append(interest);
  }

  const message = state.lastMessages.get(lead.id);
  if (message?.text) {
    const last = document.createElement("div");
    last.className = "last";
    last.textContent = `"${message.text}"`;
    card.append(last);
  }

  const foot = document.createElement("div");
  foot.className = "foot";
  const status = document.createElement("span");
  status.className = lead.needs_human ? "alert" : "";
  status.textContent = lead.needs_human
    ? AUTOMATION_LABEL.HUMAN_REQUIRED
    : (AUTOMATION_LABEL[lead.automation_status] ?? lead.automation_status);
  foot.append(status, Object.assign(document.createElement("span"), {
    textContent: formatRelative(lead.last_message_at),
  }));
  card.append(foot);

  return card;
}

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------
document.querySelectorAll("[data-close]").forEach((node) => {
  node.addEventListener("click", () => {
    state.selectedId = null;
    el("drawer").hidden = true;
  });
});

async function openDrawer(leadId, focus) {
  const lead = state.leads.find((item) => item.id === leadId);
  if (!lead) return;

  state.selectedId = leadId;
  el("drawer").hidden = false;
  el("drawerError").hidden = true;

  el("drawerName").textContent = lead.name || "Sem nome";
  el("drawerPhone").textContent = lead.phone
    ? lead.phone
    : "telefone não confirmado (contato protegido pelo WhatsApp)";
  el("drawerInterest").textContent = lead.treatment_interest || "—";
  el("drawerStage").textContent = COLUMNS.find((c) => c.stage === lead.stage)?.label ?? lead.stage;
  el("drawerAutomation").textContent = AUTOMATION_LABEL[lead.automation_status] ?? lead.automation_status;
  el("drawerSummary").textContent = lead.conversation_summary || "—";
  el("drawerLastMessage").textContent = state.lastMessages.get(leadId)?.text || "—";
  el("stageSelect").value = lead.stage;

  const link = el("whatsappLink");
  if (lead.phone) {
    link.href = `https://wa.me/${lead.phone}`;
    link.setAttribute("aria-disabled", "false");
  } else {
    // Sem telefone confirmado não existe link seguro — e um código LID nunca
    // vira número "no chute".
    link.removeAttribute("href");
    link.setAttribute("aria-disabled", "true");
  }

  el("toggleAiBtn").textContent = lead.automation_status === "ACTIVE" ? "Desligar IA" : "Ligar IA";

  // A justificativa da última decisão fica em automation_decisions — é o
  // "por que a IA respondeu isso?".
  const { data: decisions } = await supabase
    .from("automation_decisions")
    .select("intent, risk, confidence, action, reason, reply_sent, created_at")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .limit(1);

  const decision = decisions?.[0];
  el("drawerReason").textContent = decision
    ? [
      `intenção: ${decision.intent ?? "—"}`,
      `risco: ${decision.risk ?? "—"}`,
      `confiança: ${decision.confidence ?? "—"}`,
      `ação: ${decision.action}`,
      `resposta enviada: ${decision.reply_sent ? "sim" : "não"}`,
      `motivo: ${decision.reason ?? "—"}`,
    ].join("\n")
    : "Nenhuma decisão registrada ainda.";

  if (focus) el("drawer").scrollTop = 0;
}

el("toggleAiBtn").addEventListener("click", async () => {
  const lead = currentLead();
  if (!lead) return;
  const next = lead.automation_status === "ACTIVE" ? "PAUSED" : "ACTIVE";
  // Religar a IA também limpa a pendência humana: é a reativação manual
  // exigida depois de um takeover.
  await updateLead(lead.id, next === "ACTIVE"
    ? { automation_status: "ACTIVE", needs_human: false, human_reason: null }
    : { automation_status: "PAUSED" });
});

el("stageSelect").addEventListener("change", async (event) => {
  const lead = currentLead();
  if (lead) await updateLead(lead.id, { stage: event.target.value });
});

el("convertedBtn").addEventListener("click", async () => {
  const lead = currentLead();
  if (lead) await updateLead(lead.id, { stage: "CONVERTED" });
});

el("lostBtn").addEventListener("click", async () => {
  const lead = currentLead();
  if (lead) await updateLead(lead.id, { stage: "LOST" });
});

function currentLead() {
  return state.leads.find((item) => item.id === state.selectedId) ?? null;
}

async function updateLead(leadId, patch) {
  const { error } = await supabase.from("leads").update(patch).eq("id", leadId);
  if (error) {
    el("drawerError").textContent = "Não foi possível salvar essa alteração.";
    el("drawerError").hidden = false;
    return;
  }
  await load();
}

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------
function displayPhone(lead) {
  return lead.phone ?? "contato sem número confirmado";
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function formatRelative(iso) {
  if (!iso) return "—";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `há ${hours}h`;
  return `há ${Math.round(hours / 24)}d`;
}

// Sessão já ativa (F5 no painel) entra direto.
const { data: session } = await supabase.auth.getSession();
if (session?.session) await start();
