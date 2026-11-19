-- Versão final da função public.lembrete_expira_em (última definição em 0043_nina_retornos_regras.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.lembrete_expira_em(p_vence timestamptz)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select least(p_vence + interval '3 hours',
               ((p_vence at time zone 'America/Sao_Paulo')::date + time '20:00')
                 at time zone 'America/Sao_Paulo');
$$;
