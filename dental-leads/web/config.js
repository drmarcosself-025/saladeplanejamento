// Configuração pública do painel.
//
// Aqui entram APENAS a URL do projeto e a chave "anon". Ela é pública por
// design e só funciona com RLS + login. NUNCA coloque a service role key
// neste arquivo — ela dá acesso total ao banco e este arquivo vai para o
// GitHub Pages.
window.APP_CONFIG = {
  SUPABASE_URL: "https://SEU-PROJETO.supabase.co",
  SUPABASE_ANON_KEY: "SUA_ANON_KEY",
};
