-- Versão final da função public.retornos_no_ar (última definição em 0043_nina_retornos_regras.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.retornos_no_ar()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select cf.worker_retornos_em >= cf.worker_visto_em
                     from public.configuracao cf where cf.id = 1), false);
$$;
