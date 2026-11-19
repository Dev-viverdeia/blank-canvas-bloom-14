-- Versão final da função public.dashboard_custo (última definição em 0014_nina_voz_uso_colunas_funcoes.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.dashboard_custo(p_de timestamptz, p_ate timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_res jsonb;
  v_resposta numeric;
  v_no_funil numeric;
  v_conv bigint;
begin
  if not coalesce(public.eh_admin(), false) then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;
  if p_de is null or p_ate is null or p_ate <= p_de or p_ate - p_de > interval '367 days' then
    raise exception using message = 'periodo_invalido', errcode = 'P0001';
  end if;

  with ch as (
    select x.tipo, x.provedor, x.modelo, x.custo_usd, x.custo_origem
      from public.ia_chamadas x
     where x.criado_em >= p_de and x.criado_em < p_ate
  )
  select jsonb_build_object(
           'total', coalesce((select sum(ch.custo_usd) from ch), 0),
           'porTipo', jsonb_build_object(
             'resposta', coalesce((select sum(ch.custo_usd) from ch where ch.tipo = 'resposta'), 0),
             'transcricao', coalesce((select sum(ch.custo_usd) from ch where ch.tipo = 'transcricao'), 0),
             'onboarding', coalesce((select sum(ch.custo_usd) from ch where ch.tipo = 'onboarding'), 0),
             'fala', coalesce((select sum(ch.custo_usd) from ch where ch.tipo::text = 'fala'), 0)),
           'semPreco', (select count(*) from ch where ch.custo_origem = 'sem_preco'),
           'porModelo', coalesce((
             select jsonb_agg(jsonb_build_object('provedor', pm.provedor, 'modelo', pm.modelo, 'usd', pm.usd)
                              order by pm.usd desc, pm.provedor, pm.modelo)
               from (select ch.provedor::text as provedor, ch.modelo, sum(ch.custo_usd) as usd
                       from ch
                      group by ch.provedor, ch.modelo
                     having coalesce(sum(ch.custo_usd), 0) > 0) pm), '[]'::jsonb))
    into v_res;

  v_resposta := (v_res -> 'porTipo' ->> 'resposta')::numeric;

  select count(distinct m.conversa_id) into v_conv
    from public.mensagens m
   where m.origem = 'nina' and m.status in ('enviada', 'entregue', 'lida')
     and m.momento >= p_de and m.momento < p_ate;

  select coalesce(sum(ce.usd), 0) into v_no_funil
    from public.dashboard_custo_por_etapa(p_de, p_ate, now()) ce
    join public.etapas e on e.id = ce.etapa_id
   where not e.arquivada and e.tipo in ('aberta', 'ganho');

  return v_res || jsonb_build_object(
    'conversasComNina', v_conv,
    'porConversaUsd', case when v_conv > 0 then round(v_resposta / v_conv, 6) end,
    'foraDaCoorteUsd', v_resposta - v_no_funil
  );
end;
$$;
