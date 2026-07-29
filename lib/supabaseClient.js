// Cria a conexao com o Supabase usando a chave "service_role".
// Essa chave tem acesso total ao banco - por isso ela so pode existir aqui no servidor,
// nunca em codigo que roda no navegador (como a paginha HTML de teste).

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = supabase;
