-- Versão final da função public.ligacao_teto (última definição em 0031_nina_ligacao_uma_nina_por_vez.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.ligacao_teto(p_iniciada_em timestamptz, p_agente uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select p_iniciada_em
         + make_interval(secs => coalesce((select a.duracao_max_s
                                             from public.ligacao_agentes a
                                            where a.id = p_agente), 1800) + 120)
$$;
