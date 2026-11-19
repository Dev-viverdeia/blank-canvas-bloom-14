-- =====================================================================
-- Ligar as telas ao banco, envio 3 (parte do Dashboard): 32-dashboard.sql
-- Contrato: seção 2.3 ("Novas, em
-- 32-dashboard.sql") e decisão 9. Formatos: os tipos de
-- src/features/plataforma/dashboard/dados/tipos.ts, sem os campos que o front
-- calcula. Depende dos envios 1 e 2 (conversa_eventos, conexao_eventos,
-- ia_chamadas.conversa_id). Sem BEGIN/COMMIT.
--
-- Como o front usa (uma chamada por janela; o front monta as Tendencia):
--   - período atual:    dashboard_periodo(de, ate, null) e dashboard_funil(de, ate, null);
--   - período anterior: dashboard_periodo(de - dias, de, now() - dias) e
--                       dashboard_funil(de - dias, de, now() - dias)
--     ("o anterior é lido como estava na mesma idade");
--   - custo: dashboard_custo(de, ate) e dashboard_custo(de - dias, de) (o total
--     do anterior) e dashboard_custo(1º do mês, now()) (a previsão do mês);
--   - "conversas desde ontem": dashboard_periodo(ontem 00:00, now(), null).conversas.
-- As janelas são [p_de, p_ate), em instantes; o front passa a meia-noite de
-- São Paulo (00:00-03:00). As séries têm um ponto por dia de São Paulo da
-- janela, inclusive os zeros.
--
-- Chaves do JSON: os mesmos nomes de tipos.ts (camelCase). Um campo que lá é
-- Tendencia vem como o número do período (o "atual"); o front junta com o do
-- anterior. Os campos de custo vêm null para quem não é admin.
--
-- Definições (decisão 9 e "como contamos"):
--   - saiu (enviada) = mensagem de saída com status enviada, entregue ou lida,
--     pela hora do envio (mensagens.momento). na_fila, enviando, falhou e
--     cancelada não contam (9c);
--   - conversas = conversas com 1 mensagem do lead ou 1 que saiu na janela;
--   - passados para a equipe = eventos 'passou' de conversa_eventos na janela
--     (9a). Falha = motivo chave_invalida, sem_credito, audio_sem_transcricao,
--     limite_passos ou erro_provedor; o resto é "a Nina decidiu". Só existem
--     daqui em diante (as conversas antigas não têm evento);
--   - autonomia = conversas da janela sem mensagem humana (tela ou celular, não
--     cancelada) e sem passagem na janela ('passou' ou 'assumiu': assumir pelo
--     botão, mesmo sem escrever, também é passagem, como nos avisos da conversa);
--   - coorte = contatos com primeira_mensagem_em na janela (e, no funil, até
--     p_estado_em: quem ainda não tinha chegado naquele instante não conta);
--   - custo = ia_chamadas pela data do gasto (criado_em), com a resposta, a
--     transcrição e o onboarding em linhas próprias, todas no total (9d);
--   - problema = falhas seguidas do mesmo motivo (9b): ver dashboard_problemas.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Ajudante: a etapa do contato num instante (pelo histórico de etapa).
-- Antes do 1º registro do histórico, a etapa de entrada; sem histórico, a
-- etapa de hoje. Só para as funções deste arquivo (sem grant).
-- ---------------------------------------------------------------------
create or replace function public.dashboard_etapa_em(p_contato uuid, p_instante timestamptz)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select h.para_etapa_id
       from public.contato_etapa_historico h
      where h.contato_id = p_contato and h.criado_em <= p_instante
      order by h.criado_em desc, h.id desc
      limit 1),
    (select coalesce(h.de_etapa_id, h.para_etapa_id)
       from public.contato_etapa_historico h
      where h.contato_id = p_contato
      order by h.criado_em, h.id
      limit 1),
    (select c.etapa_id from public.contatos c where c.id = p_contato)
  )
$$;

revoke execute on function public.dashboard_etapa_em(uuid, timestamptz) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Ajudante: o custo das respostas da Nina para os leads da coorte, por etapa
-- em que o lead estava na hora da chamada. A conversa da chamada é
-- coalesce(ia_chamadas.conversa_id, rodadas.conversa_id). Usado pelo funil
-- (custo por etapa) e pelo custo (foraDaCoorteUsd), para as duas contas
-- fecharem. Sem grant.
-- ---------------------------------------------------------------------
create or replace function public.dashboard_custo_por_etapa(p_de timestamptz, p_ate timestamptz, p_estado_em timestamptz)
returns table (etapa_id uuid, usd numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select public.dashboard_etapa_em(c.id, ch.criado_em) as etapa_id,
         sum(ch.custo_usd) as usd
    from public.ia_chamadas ch
    left join public.rodadas r on r.id = ch.rodada_id
    join public.conversas cv on cv.id = coalesce(ch.conversa_id, r.conversa_id)
    join public.contatos c on c.id = cv.contato_id
   where ch.tipo = 'resposta'
     and ch.custo_usd is not null
     and ch.criado_em >= p_de and ch.criado_em < p_ate and ch.criado_em <= p_estado_em
     and c.primeira_mensagem_em >= p_de and c.primeira_mensagem_em < p_ate
     and c.primeira_mensagem_em <= p_estado_em
   group by 1
$$;

revoke execute on function public.dashboard_custo_por_etapa(timestamptz, timestamptz, timestamptz) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- dashboard_periodo: os números do período (ResumoPeriodo sem `problemas`,
-- que vem de dashboard_problemas).
-- Devolve:
--   {conversas, leadsNovos, recebidas, enviadas,
--    enviadasPorOrigem: {nina, humano_tela, humano_celular},
--    primeiraRespostaS, respostaNinaS, respostaNinaP90S,
--    conversasAutonomas, autonomiaPct,
--    passados: {ninaPassou, falha, porMotivo: {motivo: n}},
--    series: {conversas, recebidas, enviadas, respostaNinaS: [{dia, valor}],
--             custoUsd: [{dia, valor}] | null (null para quem não é admin)}}
-- p_estado_em (nulo = agora): a 1ª resposta dos leads novos só conta se saiu
-- até ali. As mensagens, as passagens e o custo são pela data, na janela.
-- Erros: sem_acesso, periodo_invalido.
-- ---------------------------------------------------------------------
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
  with ev as (
    select e.motivo
      from public.conversa_eventos e
     where e.tipo = 'passou' and e.criado_em >= p_de and e.criado_em < p_ate
  )
  select jsonb_build_object(
           'falha', (select count(*) from ev
                      where ev.motivo in ('chave_invalida', 'sem_credito', 'audio_sem_transcricao', 'limite_passos', 'erro_provedor')),
           'ninaPassou', (select count(*) from ev
                           where ev.motivo is null
                              or ev.motivo not in ('chave_invalida', 'sem_credito', 'audio_sem_transcricao', 'limite_passos', 'erro_provedor')),
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

revoke execute on function public.dashboard_periodo(timestamptz, timestamptz, timestamptz) from public, anon;
grant execute on function public.dashboard_periodo(timestamptz, timestamptz, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- dashboard_funil: o funil da coorte, lido como estava em p_estado_em
-- (nulo = agora). Etapas: as não arquivadas, abertas e Ganho, na ordem do
-- Kanban (Perdido é o destino de quem sai).
-- Devolve:
--   {leadsNovos, ganhos, cicloMedianoDias,
--    etapas: [{etapaId, nome, ordem, tipo, ninaPodeMover, chegaram, avancaram,
--              aindaEstao, abandonaram: {total, perdido, semResposta},
--              tempoMedianoH, custoUsd (null para quem não é admin),
--              mensagens: {recebidas, enviadas}, movimentos: {nina, equipe},
--              passadosParaEquipe, entradasPorDia: [{dia, valor}]}]}
-- Por contato da coorte (o que aconteceu até p_estado_em):
--   alcance = a etapa do funil mais adiante por onde passou (histórico ou a
--   etapa naquele instante; Perdido não conta). Numa etapa aberta X:
--   chegaram = alcance em X ou depois; avançaram = alcance depois de X; e quem
--   tem alcance em X está em Perdido (perdido), numa aberta com a última
--   mensagem do lead há mais de 7 dias (semResposta), ou ainda está (o resto).
--   Assim chegaram = avançaram + abandonaram + aindaEstao. No Ganho, aindaEstao
--   = os que estão no Ganho naquele instante.
--   tempoMedianoH = mediana, em horas, da 1ª passagem pela etapa de quem já saiu.
--   movimentos = quem fez o movimento que primeiro levou o lead para depois de X
--   (ator nina = a Nina; membro ou sistema = a equipe).
--   mensagens, custo e passados por etapa = os da janela, pela etapa em que o
--   lead estava na hora. entradasPorDia = a 1ª entrada na etapa, por dia.
--   cicloMedianoDias = mediana, em dias, da 1ª mensagem até a 1ª entrada no
--   Ganho, dos que estão no Ganho.
-- Erros: sem_acesso, periodo_invalido.
-- ---------------------------------------------------------------------
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

revoke execute on function public.dashboard_funil(timestamptz, timestamptz, timestamptz) from public, anon;
grant execute on function public.dashboard_funil(timestamptz, timestamptz, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- dashboard_custo (só o admin): o custo da IA no período, pela data do gasto.
-- Devolve:
--   {total, porTipo: {resposta, transcricao, onboarding}, semPreco,
--    porModelo: [{provedor, modelo, usd}] (só com custo > 0, do maior para o menor),
--    conversasComNina, porConversaUsd, foraDaCoorteUsd}
-- total = todas as chamadas com preço, inclusive o onboarding (9d), que vem
-- numa linha própria em porTipo. porConversaUsd = custo de resposta ÷ conversas
-- em que uma mensagem da Nina saiu na janela (null sem nenhuma).
-- foraDaCoorteUsd = o custo de resposta que não entra no custo por etapa do
-- funil (leads de fora da coorte, contatos apagados, tempo em Perdido ou em
-- etapa arquivada): Σ custoUsd das etapas + foraDaCoorteUsd = porTipo.resposta.
-- Erros: sem_acesso (atendente ou quem não é membro), periodo_invalido.
-- ---------------------------------------------------------------------
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
             'onboarding', coalesce((select sum(ch.custo_usd) from ch where ch.tipo = 'onboarding'), 0)),
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

revoke execute on function public.dashboard_custo(timestamptz, timestamptz) from public, anon;
grant execute on function public.dashboard_custo(timestamptz, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- dashboard_problemas: os problemas que começaram no período, do mais recente
-- para o mais antigo. Um problema junta as falhas seguidas do mesmo motivo (9b):
--   - falha_ia: rodadas que falharam (rodadas.status = 'falhou'), em ordem de
--     terminada_em. Seguidas = sem nenhuma rodada concluída nem falha de outro
--     motivo no meio (a rodada cancelada não conta). quantidade = as rodadas
--     que falharam; conversasAfetadas = as conversas com evento 'passou' do
--     mesmo motivo entre o início e o fim;
--   - envio: mensagens de saída da Nina ou da tela que ficaram 'falhou' (pelo
--     status_em), seguidas = sem nenhum envio que saiu no meio;
--   - midia: mídias recebidas (midia_ref_externa) que ficaram 'falhou' (pelo
--     momento da mensagem), seguidas = sem nenhuma copiada no meio;
--   - conexao: a conexão ativa ficou desconectada ou com erro
--     (conexao_eventos); o problema vai até ela voltar a 'conectada'.
-- Devolve: [{id, tipo, quando, fim, durMin, motivo, quantidade, conversasAfetadas}]
--   quando = a 1ª falha; fim = a última falha (na conexão: quando voltou, ou
--   null se ainda não voltou); durMin = minutos de quando até fim (na conexão
--   ainda caída, até agora); motivo só em falha_ia.
-- O título, a causa, a ação e o soAdmin são montados pelo front.
-- Erros: sem_acesso, periodo_invalido.
-- ---------------------------------------------------------------------
create or replace function public.dashboard_problemas(p_de timestamptz, p_ate timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_corte timestamptz;
  v_ia jsonb;
  v_envio jsonb;
  v_midia jsonb;
  v_conexao jsonb;
begin
  if not coalesce(public.eh_membro(), false) then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;
  if p_de is null or p_ate is null or p_ate <= p_de or p_ate - p_de > interval '367 days' then
    raise exception using message = 'periodo_invalido', errcode = 'P0001';
  end if;

  -- 1. Falhas da IA. Começa da última rodada concluída antes do período: o que
  --    vem antes dela é outro problema.
  select max(r.terminada_em) into v_corte
    from public.rodadas r
   where r.status = 'concluida' and r.terminada_em < p_de;

  with ev as (
    select r.id, r.conversa_id, (r.status = 'falhou') as falhou, r.motivo, r.terminada_em as t
      from public.rodadas r
     where r.status in ('concluida', 'falhou')
       and r.terminada_em is not null
       and r.terminada_em > coalesce(v_corte, '-infinity'::timestamptz)
       and r.terminada_em < p_ate
  ),
  l as (
    select ev.*,
           lag(ev.falhou) over w as falhou_antes,
           lag(ev.motivo) over w as motivo_antes
      from ev
    window w as (order by ev.t, ev.id)
  ),
  g as (
    select l.*,
           sum(case when l.falhou and (l.falhou_antes is distinct from true or l.motivo_antes is distinct from l.motivo)
                    then 1 else 0 end) over (order by l.t, l.id) as grupo
      from l
  ),
  runs as (
    select g.grupo, g.motivo, min(g.t) as inicio, max(g.t) as fim, count(*) as falhas,
           (array_agg(g.id order by g.t, g.id))[1] as primeira
      from g
     where g.falhou
     group by g.grupo, g.motivo
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', 'falha_ia:' || x.primeira::text,
           'tipo', 'falha_ia',
           'quando', x.inicio,
           'fim', x.fim,
           'durMin', round(extract(epoch from (x.fim - x.inicio))::numeric / 60)::bigint,
           'motivo', x.motivo,
           'quantidade', x.falhas,
           'conversasAfetadas', (select count(distinct e.conversa_id)
                                   from public.conversa_eventos e
                                  where e.tipo = 'passou' and e.motivo is not distinct from x.motivo
                                    and e.criado_em >= x.inicio and e.criado_em <= x.fim))), '[]'::jsonb)
    into v_ia
    from runs x
   where x.inicio >= p_de;

  -- 2. Envios que falharam (Nina e tela; o celular não passa pelo nosso envio).
  select max(m.momento) into v_corte
    from public.mensagens m
   where m.direcao = 'saida' and m.origem in ('nina', 'humano_tela')
     and m.status in ('enviada', 'entregue', 'lida') and m.momento < p_de;

  with ev as (
    select x.id, x.conversa_id, x.falhou, x.t
      from (select m.id, m.conversa_id, (m.status = 'falhou') as falhou,
                   case when m.status = 'falhou' then coalesce(m.status_em, m.momento) else m.momento end as t
              from public.mensagens m
             where m.direcao = 'saida' and m.origem in ('nina', 'humano_tela')
               and m.status in ('enviada', 'entregue', 'lida', 'falhou')) x
     where x.t > coalesce(v_corte, '-infinity'::timestamptz) and x.t < p_ate
  ),
  g as (
    select ev.*, sum(case when ev.falhou then 0 else 1 end) over (order by ev.t, ev.id) as grupo
      from ev
  ),
  runs as (
    select g.grupo, min(g.t) as inicio, max(g.t) as fim, count(*) as n,
           count(distinct g.conversa_id) as conversas,
           (array_agg(g.id order by g.t, g.id))[1] as primeira
      from g
     where g.falhou
     group by g.grupo
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', 'envio:' || x.primeira::text,
           'tipo', 'envio',
           'quando', x.inicio,
           'fim', x.fim,
           'durMin', round(extract(epoch from (x.fim - x.inicio))::numeric / 60)::bigint,
           'motivo', null,
           'quantidade', x.n,
           'conversasAfetadas', x.conversas)), '[]'::jsonb)
    into v_envio
    from runs x
   where x.inicio >= p_de;

  -- 3. Mídias recebidas que não foram copiadas.
  select max(m.momento) into v_corte
    from public.mensagens m
   where m.midia_ref_externa is not null and m.midia_status = 'copiada' and m.momento < p_de;

  with ev as (
    select m.id, m.conversa_id, (m.midia_status = 'falhou') as falhou, m.momento as t
      from public.mensagens m
     where m.midia_ref_externa is not null
       and m.midia_status in ('copiada', 'falhou')
       and m.momento > coalesce(v_corte, '-infinity'::timestamptz) and m.momento < p_ate
  ),
  g as (
    select ev.*, sum(case when ev.falhou then 0 else 1 end) over (order by ev.t, ev.id) as grupo
      from ev
  ),
  runs as (
    select g.grupo, min(g.t) as inicio, max(g.t) as fim, count(*) as n,
           count(distinct g.conversa_id) as conversas,
           (array_agg(g.id order by g.t, g.id))[1] as primeira
      from g
     where g.falhou
     group by g.grupo
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', 'midia:' || x.primeira::text,
           'tipo', 'midia',
           'quando', x.inicio,
           'fim', x.fim,
           'durMin', round(extract(epoch from (x.fim - x.inicio))::numeric / 60)::bigint,
           'motivo', null,
           'quantidade', x.n,
           'conversasAfetadas', x.conversas)), '[]'::jsonb)
    into v_midia
    from runs x
   where x.inicio >= p_de;

  -- 4. Quedas da conexão ativa: de uma ida para desconectada/erro até a volta a conectada.
  with ev as (
    select e.id, e.conexao_id, e.status_para, e.ativa_para, e.criado_em as t,
           sum(case when e.status_para = 'conectada' then 1 else 0 end)
             over (partition by e.conexao_id order by e.criado_em, e.id) as grupo
      from public.conexao_eventos e
     where e.criado_em < p_ate
  ),
  runs as (
    select ev.conexao_id, ev.grupo, min(ev.t) as inicio, count(*) as n,
           (array_agg(ev.id order by ev.t, ev.id))[1] as primeira
      from ev
     where ev.status_para in ('desconectada', 'erro') and ev.ativa_para
     group by ev.conexao_id, ev.grupo
  ),
  com_fim as (
    select x.*,
           (select min(e2.criado_em)
              from public.conexao_eventos e2
             where e2.conexao_id = x.conexao_id and e2.status_para = 'conectada' and e2.criado_em > x.inicio) as fim
      from runs x
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', 'conexao:' || x.primeira::text,
           'tipo', 'conexao',
           'quando', x.inicio,
           'fim', x.fim,
           'durMin', round(extract(epoch from (coalesce(x.fim, now()) - x.inicio))::numeric / 60)::bigint,
           'motivo', null,
           'quantidade', x.n,
           'conversasAfetadas', 0)), '[]'::jsonb)
    into v_conexao
    from com_fim x
   where x.inicio >= p_de;

  return coalesce((
    select jsonb_agg(p.v order by (p.v ->> 'quando')::timestamptz desc, p.v ->> 'id')
      from jsonb_array_elements(v_ia || v_envio || v_midia || v_conexao) as p(v)
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.dashboard_problemas(timestamptz, timestamptz) from public, anon;
grant execute on function public.dashboard_problemas(timestamptz, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- dashboard_agora: a foto de agora (Agora sem a Saúde, que o front monta com a
-- conexão, as chaves, o Contexto, a configuração e os problemas). As regras são
-- as de exemplo/regras.ts:
--   - aguardando = modo humano, sem responsável e com aguardando_humano_desde
--     (o selo "falha" ou "aguardando", pelo motivo, é do front);
--   - comQuem: nina = modo nina; membros = modo humano com responsável;
--     celular = modo humano, sem responsável e sem espera;
--   - ninaAtiva = modo nina, etapa aberta, e uma rodada rodando (o "digitando")
--     ou uma mensagem do lead ou da Nina (não cancelada nem falhou) nos últimos
--     5 min; digitando = o contato da rodada rodando mais recente;
--   - kanban e porEtapa = as etapas não arquivadas, na ordem;
--   - esfriando = não aguardando, etapa aberta, a última mensagem é da empresa e
--     o lead está calado há 24 h ou mais;
--   - paradosMais7d = só nas abertas: a última mensagem do lead (ou a 1ª, ou a
--     criação do contato) há mais de 7 dias;
--   - leads = até 5 por etapa, os há mais tempo nela (etapa_desde).
-- Devolve:
--   {aguardando: {total, maisAntigaDesde, itens: [{conversaId, contatoId, nome,
--      nomeWhatsapp, telefone, motivo, aguardandoDesde}]},
--    naoLidas: {conversas, mensagens},
--    comQuem: {nina, membros: [{membroId, nome, n}], celular},
--    ninaAtiva: {conversas, digitando: {contatoId, nome, nomeWhatsapp, telefone} | null},
--    kanban: [{etapaId, nome, tipo, n}], esfriando,
--    porEtapa: [{etapaId, paradosMais7d, leads: [{contatoId, conversaId, nome,
--      nomeWhatsapp, telefone, etapaDesde}]}],
--    ultimaRecebidaEm, ultimaDaNinaEm}
-- Erros: sem_acesso.
-- ---------------------------------------------------------------------
create or replace function public.dashboard_agora()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_res jsonb;
  v_ultima_nina timestamptz;
begin
  if not coalesce(public.eh_membro(), false) then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;

  select max(cv.ultima_da_nina_em) into v_ultima_nina from public.conversas cv;
  if v_ultima_nina is null then
    select max(m.momento) into v_ultima_nina
      from public.mensagens m
     where m.origem = 'nina' and m.status in ('enviada', 'entregue', 'lida');
  end if;

  with cv as (
    select c.id, c.contato_id, c.modo, c.responsavel_id, c.aguardando_humano_desde, c.motivo_humano,
           c.nao_lidas, c.ultima_do_lead_em, c.ultima_mensagem_em,
           ct.nome, ct.nome_whatsapp, ct.telefone, et.tipo as etapa_tipo,
           (c.modo = 'humano' and c.responsavel_id is null and c.aguardando_humano_desde is not null) as aguardando
      from public.conversas c
      join public.contatos ct on ct.id = c.contato_id
      left join public.etapas et on et.id = ct.etapa_id
  ),
  ativas as (
    select cv.id, cv.contato_id, cv.nome, cv.nome_whatsapp, cv.telefone,
           (select max(r.iniciada_em) from public.rodadas r where r.conversa_id = cv.id and r.status = 'rodando') as rodando_desde
      from cv
     where cv.modo = 'nina'
       and (cv.etapa_tipo is null or cv.etapa_tipo = 'aberta')
  ),
  ativas_agora as (
    select a.*
      from ativas a
     where a.rodando_desde is not null
        or exists (select 1 from public.mensagens m
                    where m.conversa_id = a.id
                      and m.origem in ('nina', 'lead')
                      and m.status not in ('cancelada', 'falhou')
                      and m.momento >= now() - interval '5 minutes')
  ),
  ve as (
    select e.id, e.nome, e.tipo, e.ordem from public.etapas e where not e.arquivada
  ),
  leads as (
    select ct.id, ct.etapa_id, ct.nome, ct.nome_whatsapp, ct.telefone, ct.etapa_desde,
           c.id as conversa_id,
           now() - coalesce(c.ultima_do_lead_em, ct.primeira_mensagem_em, ct.criado_em) > interval '7 days' as parado
      from public.contatos ct
      left join public.conversas c on c.contato_id = ct.id
  )
  select jsonb_build_object(
    'aguardando', jsonb_build_object(
      'total', (select count(*) from cv where cv.aguardando),
      'maisAntigaDesde', (select min(cv.aguardando_humano_desde) from cv where cv.aguardando),
      'itens', coalesce((select jsonb_agg(jsonb_build_object(
                                  'conversaId', cv.id, 'contatoId', cv.contato_id,
                                  'nome', cv.nome, 'nomeWhatsapp', cv.nome_whatsapp, 'telefone', cv.telefone,
                                  'motivo', cv.motivo_humano, 'aguardandoDesde', cv.aguardando_humano_desde)
                                order by cv.aguardando_humano_desde, cv.id)
                           from cv where cv.aguardando), '[]'::jsonb)),
    'naoLidas', jsonb_build_object(
      'conversas', (select count(*) from cv where cv.nao_lidas > 0),
      'mensagens', (select coalesce(sum(cv.nao_lidas), 0) from cv)),
    'comQuem', jsonb_build_object(
      'nina', (select count(*) from cv where cv.modo = 'nina'),
      'membros', coalesce((select jsonb_agg(jsonb_build_object('membroId', x.id, 'nome', x.nome, 'n', x.n)
                                            order by x.n desc, x.nome, x.id)
                             from (select m.id, m.nome, count(*) as n
                                     from cv join public.membros m on m.id = cv.responsavel_id
                                    where cv.modo = 'humano'
                                    group by m.id, m.nome) x), '[]'::jsonb),
      'celular', (select count(*) from cv
                   where cv.modo = 'humano' and cv.responsavel_id is null and cv.aguardando_humano_desde is null)),
    'ninaAtiva', jsonb_build_object(
      'conversas', (select count(*) from ativas_agora),
      'digitando', (select jsonb_build_object('contatoId', a.contato_id, 'nome', a.nome,
                                              'nomeWhatsapp', a.nome_whatsapp, 'telefone', a.telefone)
                      from ativas a
                     where a.rodando_desde is not null
                     order by a.rodando_desde desc, a.id
                     limit 1)),
    'kanban', coalesce((select jsonb_agg(jsonb_build_object(
                                 'etapaId', ve.id, 'nome', ve.nome, 'tipo', ve.tipo,
                                 'n', (select count(*) from public.contatos ct where ct.etapa_id = ve.id))
                               order by ve.ordem, ve.nome, ve.id)
                          from ve), '[]'::jsonb),
    'esfriando', (select count(*) from cv
                   where not cv.aguardando
                     and cv.etapa_tipo = 'aberta'
                     and cv.ultima_do_lead_em is not null
                     and cv.ultima_mensagem_em > cv.ultima_do_lead_em
                     and now() - cv.ultima_do_lead_em >= interval '24 hours'),
    'porEtapa', coalesce((select jsonb_agg(jsonb_build_object(
                                   'etapaId', ve.id,
                                   'paradosMais7d', case when ve.tipo = 'aberta'
                                                         then (select count(*) from leads l where l.etapa_id = ve.id and l.parado)
                                                         else 0 end,
                                   'leads', coalesce((select jsonb_agg(jsonb_build_object(
                                                               'contatoId', y.id, 'conversaId', y.conversa_id,
                                                               'nome', y.nome, 'nomeWhatsapp', y.nome_whatsapp,
                                                               'telefone', y.telefone, 'etapaDesde', y.etapa_desde)
                                                             order by y.etapa_desde, y.id)
                                                        from (select l.* from leads l
                                                               where l.etapa_id = ve.id
                                                               order by l.etapa_desde, l.id
                                                               limit 5) y), '[]'::jsonb))
                                 order by ve.ordem, ve.nome, ve.id)
                            from ve), '[]'::jsonb),
    'ultimaRecebidaEm', (select max(cv.ultima_do_lead_em) from cv),
    'ultimaDaNinaEm', v_ultima_nina
  )
  into v_res;

  return v_res;
end;
$$;

revoke execute on function public.dashboard_agora() from public, anon;
grant execute on function public.dashboard_agora() to authenticated, service_role;