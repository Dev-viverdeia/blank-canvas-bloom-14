-- Versão final da função public.dashboard_funil (última definição em 0008_nina_ligacao_dashboard.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.dashboard_funil(p_de timestamptz, p_ate timestamptz, p_estado_em timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin boolean;
  v_estado timestamptz;
  v_d0 date;
  v_d1 date;
  v_res jsonb;
begin
  if not coalesce(public.eh_membro(), false) then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;
  if p_de is null or p_ate is null or p_ate <= p_de or p_ate - p_de > interval '367 days' then
    raise exception using message = 'periodo_invalido', errcode = 'P0001';
  end if;

  v_admin := coalesce(public.eh_admin(), false);
  v_estado := coalesce(p_estado_em, now());
  v_d0 := (p_de at time zone 'America/Sao_Paulo')::date;
  v_d1 := ((p_ate - interval '1 microsecond') at time zone 'America/Sao_Paulo')::date;

  with fe as (
    select e.id, e.nome, e.ordem, e.tipo, e.nina_pode_mover,
           row_number() over (order by e.ordem, e.nome, e.id) as pos
      from public.etapas e
     where not e.arquivada and e.tipo in ('aberta', 'ganho')
  ),
  k as (
    select c.id, c.primeira_mensagem_em as t0
      from public.contatos c
     where c.primeira_mensagem_em >= p_de and c.primeira_mensagem_em < p_ate
       and c.primeira_mensagem_em <= v_estado
  ),
  h as (
    select hh.id, hh.contato_id, hh.de_etapa_id, hh.para_etapa_id, hh.ator, hh.criado_em
      from public.contato_etapa_historico hh
      join k on k.id = hh.contato_id
     where hh.criado_em <= v_estado
  ),
  em as (
    select k.id, k.t0, public.dashboard_etapa_em(k.id, v_estado) as etapa_id from k
  ),
  vis as (
    select h.contato_id, h.para_etapa_id as etapa_id from h
    union
    select h.contato_id, h.de_etapa_id from h where h.de_etapa_id is not null
    union
    select em.id, em.etapa_id from em
  ),
  pc as (
    select em.id, em.t0, em.etapa_id, et.tipo as tipo_em,
           (select max(fe.pos) from vis join fe on fe.id = vis.etapa_id where vis.contato_id = em.id) as alcance,
           v_estado - coalesce(
             (select max(m.momento)
                from public.conversas cv
                join public.mensagens m on m.conversa_id = cv.id
               where cv.contato_id = em.id and m.direcao = 'entrada' and m.momento <= v_estado),
             em.t0) > interval '7 days' as calado
      from em
      left join public.etapas et on et.id = em.etapa_id
  ),
  est as (
    select h.contato_id, h.para_etapa_id as etapa_id, h.criado_em as ini,
           lead(h.criado_em) over (partition by h.contato_id order by h.criado_em, h.id) as fim,
           row_number() over (partition by h.contato_id, h.para_etapa_id order by h.criado_em, h.id) as n
      from h
  ),
  tempos as (
    select est.etapa_id,
           percentile_cont(0.5) within group (order by extract(epoch from (est.fim - est.ini))::float8 / 3600) as med
      from est
     where est.n = 1 and est.fim is not null
     group by est.etapa_id
  ),
  entradas as (
    select est.etapa_id, (est.ini at time zone 'America/Sao_Paulo')::date as dia, count(*) as n
      from est
     where est.n = 1 and est.ini >= p_de and est.ini < p_ate
     group by 1, 2
  ),
  dias as (
    select d::date as dia from generate_series(v_d0, v_d1, interval '1 day') d
  ),
  msgs as (
    select public.dashboard_etapa_em(k.id, m.momento) as etapa_id,
           count(*) filter (where m.direcao = 'entrada') as recebidas,
           count(*) filter (where m.direcao = 'saida') as enviadas
      from k
      join public.conversas cv on cv.contato_id = k.id
      join public.mensagens m on m.conversa_id = cv.id
     where m.momento >= p_de and m.momento < p_ate and m.momento <= v_estado
       and (m.direcao = 'entrada' or m.status in ('enviada', 'entregue', 'lida'))
     group by 1
  ),
  pas as (
    select public.dashboard_etapa_em(k.id, e.criado_em) as etapa_id, count(*) as n
      from k
      join public.conversas cv on cv.contato_id = k.id
      join public.conversa_eventos e on e.conversa_id = cv.id
     where e.tipo = 'passou' and e.criado_em >= p_de and e.criado_em < p_ate and e.criado_em <= v_estado
     group by 1
  ),
  mov as (
    select f.id as etapa_id,
           count(*) filter (where x.ator = 'nina') as nina,
           count(*) filter (where x.ator is distinct from 'nina') as equipe
      from fe f
      join pc on pc.alcance > f.pos
      left join lateral (
        select hh.ator
          from h hh
          join fe f2 on f2.id = hh.para_etapa_id
         where hh.contato_id = pc.id and f2.pos > f.pos
         order by hh.criado_em, hh.id
         limit 1
      ) x on true
     where f.tipo = 'aberta'
     group by f.id
  ),
  custo as (
    select ce.etapa_id, ce.usd
      from public.dashboard_custo_por_etapa(p_de, p_ate, v_estado) ce
     where v_admin
  ),
  ciclo as (
    select percentile_cont(0.5) within group (order by extract(epoch from (g.t - pc.t0))::float8 / 86400) as med
      from pc
      join lateral (
        select min(hh.criado_em) as t
          from h hh
          join public.etapas e on e.id = hh.para_etapa_id
         where hh.contato_id = pc.id and e.tipo = 'ganho'
      ) g on true
     where pc.tipo_em = 'ganho' and g.t is not null
  ),
  linhas as (
    select f.pos,
           f.tipo,
           f.id,
           (select count(*) from pc where pc.alcance >= f.pos) as chegaram,
           case when f.tipo = 'aberta' then (select count(*) from pc where pc.alcance > f.pos) else 0 end as avancaram,
           case when f.tipo = 'aberta'
                then (select count(*) from pc where pc.alcance = f.pos and pc.tipo_em = 'perdido') else 0 end as perdido,
           case when f.tipo = 'aberta'
                then (select count(*) from pc where pc.alcance = f.pos and pc.tipo_em = 'aberta' and pc.calado) else 0 end as sem_resposta,
           case when f.tipo = 'aberta'
                then (select count(*) from pc
                       where pc.alcance = f.pos
                         and pc.tipo_em is distinct from 'perdido'
                         and not (pc.tipo_em = 'aberta' and pc.calado))
                else (select count(*) from pc where pc.etapa_id = f.id) end as ainda
      from fe f
  )
  select jsonb_build_object(
           'leadsNovos', (select count(*) from k),
           'ganhos', (select count(*) from pc where pc.tipo_em = 'ganho'),
           'cicloMedianoDias', (select round(c.med::numeric, 1) from ciclo c),
           'etapas', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'etapaId', f.id,
                      'nome', f.nome,
                      'ordem', f.ordem,
                      'tipo', f.tipo,
                      'ninaPodeMover', f.nina_pode_mover,
                      'chegaram', l.chegaram,
                      'avancaram', l.avancaram,
                      'aindaEstao', l.ainda,
                      'abandonaram', jsonb_build_object('total', l.perdido + l.sem_resposta,
                                                        'perdido', l.perdido,
                                                        'semResposta', l.sem_resposta),
                      'tempoMedianoH', case when f.tipo = 'aberta'
                                            then (select round(t.med::numeric, 1) from tempos t where t.etapa_id = f.id) end,
                      'custoUsd', case when v_admin
                                       then coalesce((select c.usd from custo c where c.etapa_id = f.id), 0) end,
                      'mensagens', jsonb_build_object(
                                     'recebidas', coalesce((select ms.recebidas from msgs ms where ms.etapa_id = f.id), 0),
                                     'enviadas', coalesce((select ms.enviadas from msgs ms where ms.etapa_id = f.id), 0)),
                      'movimentos', jsonb_build_object(
                                      'nina', coalesce((select mv.nina from mov mv where mv.etapa_id = f.id), 0),
                                      'equipe', coalesce((select mv.equipe from mov mv where mv.etapa_id = f.id), 0)),
                      'passadosParaEquipe', coalesce((select p.n from pas p where p.etapa_id = f.id), 0),
                      'entradasPorDia', (select jsonb_agg(jsonb_build_object('dia', to_char(d.dia, 'YYYY-MM-DD'),
                                                                             'valor', coalesce(en.n, 0)) order by d.dia)
                                           from dias d
                                           left join entradas en on en.etapa_id = f.id and en.dia = d.dia))
                    order by f.pos)
               from fe f
               join linhas l on l.id = f.id), '[]'::jsonb))
    into v_res;

  return v_res;
end;
$$;
