-- Versão final da função public.dashboard_periodo (última definição em 0046_nina_retornos_dashboard.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.dashboard_periodo(p_de timestamptz, p_ate timestamptz, p_estado_em timestamptz)
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
  v_msg jsonb;
  v_resp jsonb;
  v_coorte jsonb;
  v_pass jsonb;
  v_custo jsonb;
  v_conversas bigint;
  v_autonomas bigint;
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

  -- 1. Mensagens: contagens, origem, autonomia e as séries por dia.
  with msg as (
    select m.conversa_id, m.direcao, m.origem, m.status,
           (m.momento at time zone 'America/Sao_Paulo')::date as dia,
           (m.direcao = 'saida' and m.status in ('enviada', 'entregue', 'lida')) as saiu
      from public.mensagens m
     where m.momento >= p_de and m.momento < p_ate
  ),
  conv as (
    select x.conversa_id,
           bool_or(x.direcao = 'entrada' or x.saiu) as conta,
           bool_or(x.origem in ('humano_tela', 'humano_celular') and x.status <> 'cancelada') as humano
      from msg x
     group by x.conversa_id
  ),
  passou as (
    -- passagem: a Nina passou ou alguém assumiu (pelo botão ou mandando mensagem)
    select distinct e.conversa_id
      from public.conversa_eventos e
     where e.tipo in ('passou', 'assumiu') and e.criado_em >= p_de and e.criado_em < p_ate
  ),
  dias as (
    select d::date as dia from generate_series(v_d0, v_d1, interval '1 day') d
  ),
  por_dia as (
    select x.dia,
           count(distinct x.conversa_id) filter (where x.direcao = 'entrada' or x.saiu) as conversas,
           count(*) filter (where x.direcao = 'entrada') as recebidas,
           count(*) filter (where x.saiu) as enviadas
      from msg x
     group by x.dia
  )
  select jsonb_build_object(
           'conversas', (select count(*) from conv c where c.conta),
           'conversasAutonomas', (select count(*) from conv c
                                   where c.conta and not c.humano
                                     and not exists (select 1 from passou p where p.conversa_id = c.conversa_id)),
           'recebidas', (select count(*) from msg x where x.direcao = 'entrada'),
           'enviadas', (select count(*) from msg x where x.saiu),
           'enviadasPorOrigem', jsonb_build_object(
             'nina', (select count(*) from msg x where x.saiu and x.origem = 'nina'),
             'humano_tela', (select count(*) from msg x where x.saiu and x.origem = 'humano_tela'),
             'humano_celular', (select count(*) from msg x where x.saiu and x.origem = 'humano_celular')),
           'series', jsonb_build_object(
             'conversas', (select jsonb_agg(jsonb_build_object('dia', to_char(d.dia, 'YYYY-MM-DD'), 'valor', coalesce(p.conversas, 0)) order by d.dia)
                             from dias d left join por_dia p on p.dia = d.dia),
             'recebidas', (select jsonb_agg(jsonb_build_object('dia', to_char(d.dia, 'YYYY-MM-DD'), 'valor', coalesce(p.recebidas, 0)) order by d.dia)
                             from dias d left join por_dia p on p.dia = d.dia),
             'enviadas', (select jsonb_agg(jsonb_build_object('dia', to_char(d.dia, 'YYYY-MM-DD'), 'valor', coalesce(p.enviadas, 0)) order by d.dia)
                            from dias d left join por_dia p on p.dia = d.dia)))
    into v_msg;

  v_conversas := (v_msg ->> 'conversas')::bigint;
  v_autonomas := (v_msg ->> 'conversasAutonomas')::bigint;

  -- 2. Respostas da Nina: por rodada, a 1ª bolha que saiu (na janela) menos a
  --    última mensagem do lead que a rodada leu (ou, sem ela, a última do lead
  --    antes da bolha). Mediana, p90 (posição mais próxima) e a mediana por dia.
  with bolhas as (
    select m.rodada_id, min(m.momento) as t
      from public.mensagens m
     where m.origem = 'nina' and m.status in ('enviada', 'entregue', 'lida')
       and m.rodada_id in (select m2.rodada_id
                             from public.mensagens m2
                            where m2.origem = 'nina' and m2.status in ('enviada', 'entregue', 'lida')
                              and m2.momento >= p_de and m2.momento < p_ate)
     group by m.rodada_id
  ),
  resp as (
    select b.t, (b.t at time zone 'America/Sao_Paulo')::date as dia,
           extract(epoch from (b.t - coalesce(
             (select max(e.momento) from public.mensagens e
               where e.rodada_id = b.rodada_id and e.direcao = 'entrada' and e.momento <= b.t),
             (select max(e.momento) from public.mensagens e
                join public.rodadas r on r.id = b.rodada_id
               where e.conversa_id = r.conversa_id and e.direcao = 'entrada' and e.momento <= b.t))))::float8 as s
      from bolhas b
     where b.t >= p_de and b.t < p_ate
       -- novo (retornos): fora a rodada de retorno ou de lembrete que não leu fala do lead
       and not exists (select 1 from public.rodadas r0
                        where r0.id = b.rodada_id and r0.retorno_id is not null
                          and not exists (select 1 from public.mensagens e0
                                           where e0.rodada_id = r0.id and e0.direcao = 'entrada'))
  ),
  validas as (
    select r.dia, r.s from resp r where r.s is not null and r.s >= 0
  ),
  dias as (
    select d::date as dia from generate_series(v_d0, v_d1, interval '1 day') d
  ),
  med_dia as (
    select v.dia, percentile_cont(0.5) within group (order by v.s) as med from validas v group by v.dia
  )
  select jsonb_build_object(
           'respostaNinaS', (select round((percentile_cont(0.5) within group (order by v.s))::numeric)::bigint from validas v),
           'respostaNinaP90S', (select round((percentile_disc(0.9) within group (order by v.s))::numeric)::bigint from validas v),
           'serie', (select jsonb_agg(jsonb_build_object('dia', to_char(d.dia, 'YYYY-MM-DD'),
                                                         'valor', coalesce(round(md.med::numeric)::bigint, 0)) order by d.dia)
                       from dias d left join med_dia md on md.dia = d.dia))
    into v_resp;

  -- 3. Coorte: leads novos e a 1ª resposta (de qualquer origem, que saiu até p_estado_em).
  with coorte as (
    select c.id, c.primeira_mensagem_em as t0
      from public.contatos c
     where c.primeira_mensagem_em >= p_de and c.primeira_mensagem_em < p_ate
  ),
  primeiras as (
    select k.id,
           (select extract(epoch from (min(m.momento) - k.t0))::float8
              from public.conversas cv
              join public.mensagens m on m.conversa_id = cv.id
             where cv.contato_id = k.id
               and m.direcao = 'saida' and m.status in ('enviada', 'entregue', 'lida')
               and m.momento >= k.t0 and m.momento <= v_estado) as s
      from coorte k
  )
  select jsonb_build_object(
           'leadsNovos', (select count(*) from coorte),
           'primeiraRespostaS', (select round((percentile_cont(0.5) within group (order by p.s))::numeric)::bigint
                                   from primeiras p where p.s is not null))
    into v_coorte;

  -- 4. Passados para a equipe (9a): as passagens da janela, decisão × falha.
  --    novo: envio_falhou entra nas duas listas de falha.
  with ev as (
    select e.motivo
      from public.conversa_eventos e
     where e.tipo = 'passou' and e.criado_em >= p_de and e.criado_em < p_ate
  )
  select jsonb_build_object(
           'falha', (select count(*) from ev
                      where ev.motivo in ('chave_invalida', 'sem_credito', 'audio_sem_transcricao', 'limite_passos', 'erro_provedor', 'envio_falhou')),
           'ninaPassou', (select count(*) from ev
                           where ev.motivo is null
                              or ev.motivo not in ('chave_invalida', 'sem_credito', 'audio_sem_transcricao', 'limite_passos', 'erro_provedor', 'envio_falhou')),
           'porMotivo', coalesce((select jsonb_object_agg(x.motivo, x.n)
                                    from (select ev.motivo::text as motivo, count(*) as n
                                            from ev where ev.motivo is not null group by ev.motivo) x), '{}'::jsonb))
    into v_pass;

  -- 5. Custo por dia (só o admin): todas as chamadas com preço, pela data do gasto.
  if v_admin then
    with dias as (
      select d::date as dia from generate_series(v_d0, v_d1, interval '1 day') d
    ),
    por_dia as (
      select (ch.criado_em at time zone 'America/Sao_Paulo')::date as dia, sum(ch.custo_usd) as usd
        from public.ia_chamadas ch
       where ch.criado_em >= p_de and ch.criado_em < p_ate and ch.custo_usd is not null
       group by 1
    )
    select jsonb_agg(jsonb_build_object('dia', to_char(d.dia, 'YYYY-MM-DD'), 'valor', coalesce(p.usd, 0)) order by d.dia)
      into v_custo
      from dias d left join por_dia p on p.dia = d.dia;
  else
    v_custo := null;
  end if;

  return jsonb_build_object(
    'conversas', v_conversas,
    'leadsNovos', (v_coorte -> 'leadsNovos'),
    'recebidas', (v_msg -> 'recebidas'),
    'enviadas', (v_msg -> 'enviadas'),
    'enviadasPorOrigem', (v_msg -> 'enviadasPorOrigem'),
    'primeiraRespostaS', (v_coorte -> 'primeiraRespostaS'),
    'respostaNinaS', (v_resp -> 'respostaNinaS'),
    'respostaNinaP90S', (v_resp -> 'respostaNinaP90S'),
    'conversasAutonomas', v_autonomas,
    'autonomiaPct', case when v_conversas > 0 then round(v_autonomas * 100.0 / v_conversas, 1) end,
    'passados', v_pass,
    'series', (v_msg -> 'series')
                || jsonb_build_object('respostaNinaS', v_resp -> 'serie', 'custoUsd', v_custo)
  );
end;
$$;
