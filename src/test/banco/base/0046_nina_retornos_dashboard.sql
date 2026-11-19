-- nina_retornos_dashboard (envio 5 de 6 dos retornos, 18/11/2026).
-- O tempo de resposta da Nina no Dashboard deixa de contar as rodadas de retorno e de lembrete em
-- que o lead não falou: a mensagem do retorno combinado para "amanhã às 9h" não é uma resposta de
-- 17 h, e o lembrete automático não é resposta a nada. A rodada que levou o retorno junto da fala do
-- lead (o lead escreveu perto da hora marcada) continua contando: é resposta de verdade. As bolhas
-- continuam em enviadas, na série por dia e em todas as outras contas.
-- Recria a dashboard_periodo() (texto da base 0017, mesma assinatura, o mesmo JSON, os mesmos
-- grants), com uma mudança só, marcada "novo (retornos)": um filtro a mais no bloco 2 (resp).
-- Sem retorno gravado (rodadas.retorno_id nulo em todas as rodadas), o resultado é idêntico ao de
-- hoje.
-- Obrigatório: faz parte da entrega, como os outros cinco.
-- Depende de: só o nina_retornos_tabelas (rodadas.retorno_id). Não depende do
-- nina_retornos_regras, do nina_retornos_funcoes, do nina_retornos_rodada nem do
-- nina_retornos_relogio. O nina_retornos_relogio exige este envio (trava
-- falta_nina_retornos_dashboard). Ordem: 5º envio dos retornos, depois do
-- nina_retornos_rodada e antes do nina_retornos_relogio (o banco aceita em qualquer momento depois
-- do nina_retornos_tabelas). Quando vai ao agente do Lovable: só depois da revisão final do código
-- novo, porque recria uma função que o app publicado usa; antes do nina_retornos_relogio, que é o
-- último, logo antes de publicar. Nenhuma tabela nem coluna muda e nada é semeado: a
-- preparar_copia() não muda. Só acrescenta (a recriada mantém a assinatura). Pode rodar duas
-- vezes. Sem BEGIN/COMMIT.

-- Parte do texto da base 0017 (dashboard_periodo): se outra migration recriar a função antes deste
-- envio, a trava recusa (funcao_mudou_antes_dos_retornos). Antes de mandar: conferir na base se uma
-- migration posterior a recriou e ler em produção, por SELECT puro, o md5(prosrc) dela (select
-- md5(p.prosrc) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid =
-- p.pronamespace where n.nspname = 'public' and p.proname = 'dashboard_periodo'). Se o agente do
-- Lovable tiver reformatado o corpo, a trava também recusa (recusa segura): conferir o texto em
-- produção e só trocar o hash da lista se a diferença for só de forma. Se outra entrega mudou a
-- função, refazer este envio a partir do texto dela (item 12) e trocar os dois hashes.

-- ---------------------------------------------------------------------
-- Trava: sem o nina_retornos_tabelas, este envio para aqui. Depois, com a dashboard_periodo
-- recriada por outra entrega depois do texto de que este envio parte, também para.
-- ---------------------------------------------------------------------
do $$
declare
  v_mudou text;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'rodadas'
                    and column_name = 'retorno_id') then
    raise exception using message = 'falta_nina_retornos_tabelas',
      hint = 'Aplique antes o nina_retornos_tabelas.';
  end if;
  -- o texto em vigor: o da base de que este envio parte ou o deste envio (aplicado de novo)
  select string_agg(e.nome, ', ' order by e.nome) into v_mudou
    from (values
      ('dashboard_periodo', 'fe97bab5d5bdb81a2588ca29c7cb33ff', '9c74ce222792da4ff5c4269e4367b467')
    ) e(nome, h_partida, h_envio)
    join pg_catalog.pg_proc p on p.proname = e.nome
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
   where md5(p.prosrc) not in (e.h_partida, e.h_envio);
  if v_mudou is not null then
    raise exception using message = 'funcao_mudou_antes_dos_retornos',
      hint = 'Recriadas por outra entrega depois do texto de partida deste envio: ' || v_mudou
             || '. Refaça este envio a partir do texto mais recente de cada uma na base (item 12) e troque os hashes da lista.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- dashboard_periodo (texto da 0017). Único acréscimo: no bloco 2, fica de fora a rodada com
-- retorno_id (de retorno ou de lembrete) que não leu nenhuma entrada do lead.
-- Devolve:
--   {conversas, leadsNovos, recebidas, enviadas,
--    enviadasPorOrigem: {nina, humano_tela, humano_celular},
--    primeiraRespostaS, respostaNinaS, respostaNinaP90S,
--    conversasAutonomas, autonomiaPct,
--    passados: {ninaPassou, falha, porMotivo: {motivo: n}},
--    series: {conversas, recebidas, enviadas, respostaNinaS: [{dia, valor}],
--             custoUsd: [{dia, valor}] | null (null para quem não é admin)}}
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

revoke execute on function public.dashboard_periodo(timestamptz, timestamptz, timestamptz) from public, anon;
grant execute on function public.dashboard_periodo(timestamptz, timestamptz, timestamptz) to authenticated, service_role;
