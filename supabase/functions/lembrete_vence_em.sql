-- Versão final da função public.lembrete_vence_em (última definição em 0043_nina_retornos_regras.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.lembrete_vence_em(p_base timestamptz, p_horas integer, p_conversa uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when x.l::time >= time '08:00' and x.l::time < time '20:00' then x.t
           else ((case when x.l::time < time '08:00' then x.l::date else x.l::date + 1 end)
                 + time '08:00'
                 + make_interval(secs => (abs(hashtext(p_conversa::text)::bigint) % 1800)::double precision))
                at time zone 'America/Sao_Paulo'
         end
    from (select p_base + make_interval(hours => p_horas) as t,
                 (p_base + make_interval(hours => p_horas)) at time zone 'America/Sao_Paulo' as l) x;
$$;
