-- =====================================================================
-- Ligar as telas ao banco, envio 4: tempo real.
-- Contrato: seção 2.3 (envio 4).
-- O mesmo bloco idempotente da 0000: só acrescenta a tabela que ainda não
-- está na publicação. conexoes e ia_chaves ficam de fora (a tela relê no
-- foco e a cada 60 s). Depende do envio 2 (conversa_eventos). Sem BEGIN/COMMIT.
-- =====================================================================
do $$
declare
  v_tabela text;
begin
  foreach v_tabela in array array['etapas', 'contato_etapa_historico', 'rodadas', 'membros', 'conversa_eventos'] loop
    if not exists (
      select 1 from pg_catalog.pg_publication_tables p
      where p.pubname = 'supabase_realtime' and p.schemaname = 'public' and p.tablename = v_tabela
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_tabela);
    end if;
  end loop;
end;
$$;