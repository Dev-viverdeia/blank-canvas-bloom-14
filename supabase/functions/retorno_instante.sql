-- Versão final da função public.retorno_instante (última definição em 0043_nina_retornos_regras.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.retorno_instante(p_data date, p_hora time)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select (p_data + p_hora) at time zone 'America/Sao_Paulo';
$$;
