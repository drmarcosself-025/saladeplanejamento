// Configuração pública do Jarvis.
//
// Vazio = modo DEMONSTRAÇÃO (dados fictícios, sem backend).
// Quando as Edge Functions existirem, preencha as URLs. NUNCA coloque aqui
// chave do Claude, token do Clinicorp, senha do Gmail nem service role do
// Supabase: este arquivo é público. Segredos vivem só nas Edge Functions.
window.APP_CONFIG = {
  // Ex.: https://SEU-PROJETO.supabase.co/functions/v1/jarvis-data
  DATA_URL: "",
  // Ex.: https://SEU-PROJETO.supabase.co/functions/v1/jarvis-brain
  BRAIN_URL: "",
  // Token pessoal (ou JWT do login) que autoriza o painel a chamar o backend.
  JARVIS_TOKEN: "",
};
