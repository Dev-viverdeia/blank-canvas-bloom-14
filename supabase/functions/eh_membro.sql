-- Versão final da função public.eh_membro (última definição em 0000_nina_estrutura_inicial.sql).
-- Referência: quem aplica é a pasta migrations.

create function public.eh_membro()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.membros m
    where m.user_id = auth.uid() and m.ativo
  );
$$;
