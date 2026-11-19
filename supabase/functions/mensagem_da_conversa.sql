-- Versão final da função public.mensagem_da_conversa (última definição em 0005_0005_nina_ligacao_tabelas.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.mensagem_da_conversa(p_msg uuid, p_conversa uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.mensagens m where m.id = p_msg and m.conversa_id = p_conversa
  );
$$;
