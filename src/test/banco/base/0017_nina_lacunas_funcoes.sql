-- nina_lacunas_funcoes (envio L2 das lacunas da mensageria, 02/11/2026).
-- Depende do L1 (o valor 'envio_falhou' de public.motivo_humano).
-- Funções recriadas com a mesma assinatura, partindo do texto mais recente:
--   reenviar_mensagem (0006), dashboard_periodo (0008), contexto_salvar (0009).
-- Função nova: desistir_midia. O gatilho mensagens_envio_falhou vai no L3, depois de
-- publicar as telas que conhecem o motivo envio_falhou.
--
-- Antes do envio, a sessão principal confere no banco real, só com SELECT:
--  1) o dono de contexto_versoes é o mesmo das funções contexto_salvar e
--     contexto_restaurar, e a RLS não é forçada (senão o revoke e o drop da
--     policy do fim quebram o Salvar do Contexto):
--     select c.relowner::regrole::text as dono_tabela, c.relforcerowsecurity as rls_forcada,
--            (select string_agg(p.proname || '=' || p.proowner::regrole::text, ', ') from pg_proc p
--              where p.oid in ('public.contexto_salvar(bigint, jsonb, public.contexto_origem)'::regprocedure,
--                              'public.contexto_restaurar(bigint)'::regprocedure)) as donos_funcoes
--       from pg_class c where c.oid = 'public.contexto_versoes'::regclass
--  2) a versão atual do Contexto cabe nos limites novos (itens <= 50 e
--     maior_pergunta <= 2000; senão todo salvar de itens dá erro até o admin cortar):
--     select jsonb_array_length(cv.itens) as itens,
--            (select max(char_length(i ->> 'pergunta')) from jsonb_array_elements(cv.itens) i) as maior_pergunta
--       from public.contexto_versoes cv order by cv.id desc limit 1

-- ---------------------------------------------------------------------
-- Trava: sem o L1, este envio para aqui. O plpgsql só confere o valor do enum
-- quando a função roda; sem a trava, o L2 entraria sem erro e, na 1ª bolha da
-- Nina que falhasse, o gatilho daria 22P02 e travaria o pegar_envios (nenhuma
-- mensagem sairia mais) e o dashboard_periodo. A trava só lê o catálogo e não
-- usa o valor novo, por isso passa também com o L1 e o L2 na mesma transação.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1
                   from pg_catalog.pg_enum e
                   join pg_catalog.pg_type t on t.oid = e.enumtypid
                   join pg_catalog.pg_namespace n on n.oid = t.typnamespace
                  where n.nspname = 'public' and t.typname = 'motivo_humano'
                    and e.enumlabel = 'envio_falhou') then
    raise exception using message = 'falta_o_L1_envio_falhou',
      hint = 'Aplique antes o L1 (nina_lacunas_enums): alter type public.motivo_humano add value if not exists ''envio_falhou''.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- mensagens.reenvios: quantas vezes a equipe usou o "Tentar de novo" na
-- mensagem. O servidor monta com ele a chave de idempotência da Zernio
-- (id, ou id:rN depois do N-ésimo reenvio). As tentativas automáticas não
-- mexem nele. Só as funções gravam (a tela não tem grant nessa coluna).
-- ---------------------------------------------------------------------
alter table public.mensagens
  add column if not exists reenvios int not null default 0
  constraint mensagens_reenvios_nao_negativo check (reenvios >= 0);

-- ---------------------------------------------------------------------
-- reenviar_mensagem (texto da 0006). Único acréscimo: reenvios = reenvios + 1.
-- Recusa: nao_encontrado, nao_reenviavel, sem_conexao_ativa, janela_fechada.
-- ---------------------------------------------------------------------
create or replace function public.reenviar_mensagem(p_msg uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membro uuid := public.membro_atual();
  v_m public.mensagens;
  v_ativa uuid;
  v_oficial boolean;
  v_ultima_lead timestamptz;
begin
  select * into v_m from public.mensagens m where m.id = p_msg for update;
  if not found then
    raise exception using message = 'nao_encontrado', errcode = 'P0001';
  end if;

  if v_m.direcao <> 'saida' or v_m.origem <> 'humano_tela' or v_m.status <> 'falhou' then
    raise exception using message = 'nao_reenviavel', errcode = 'P0001';
  end if;
  -- falha_no_gateway: o gateway aceitou e depois avisou que a entrega falhou, então a
  -- mensagem não chegou e pode sair de novo (decisão 8). Os outros casos podem ter chegado.
  if coalesce(v_m.erro, '') <> 'falha_no_gateway'
     and (v_m.id_externo is not null
          or v_m.id_gateway is not null
          or coalesce(v_m.erro, '') in ('sem_resposta_do_envio', 'tempo_esgotado', 'falha_de_rede')
          or coalesce(v_m.erro, '') ~ '^(http_|http:|meta_|zernio_http_)5[0-9][0-9]') then
    raise exception using message = 'nao_reenviavel', errcode = 'P0001';
  end if;

  select c.id, c.oficial into v_ativa, v_oficial from public.conexoes c where c.ativa;
  if v_ativa is null then
    raise exception using message = 'sem_conexao_ativa', errcode = 'P0001';
  end if;
  if v_oficial then
    select cv.ultima_do_lead_em into v_ultima_lead
    from public.conversas cv where cv.id = v_m.conversa_id;
    if v_ultima_lead is null or v_ultima_lead + interval '24 hours' <= now() then
      raise exception using message = 'janela_fechada', errcode = 'P0001';
    end if;
  end if;

  update public.mensagens m
     set status = 'na_fila',
         erro = null,
         tentativas = 0,
         enviar_apos = now(),
         status_em = now(),
         conexao_id = v_ativa,
         id_externo = null,
         id_gateway = null,
         -- novo: conta o reenvio (a chave da Zernio muda a cada um)
         reenvios = m.reenvios + 1
   where m.id = p_msg;
end;
$$;

revoke execute on function public.reenviar_mensagem(uuid) from public, anon;
grant execute on function public.reenviar_mensagem(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- dashboard_periodo (texto da 0008). Único acréscimo: 'envio_falhou' nas
-- duas listas de falha do bloco 4 (conta como falha, não como "a Nina
-- decidiu passar").
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

-- ---------------------------------------------------------------------
-- desistir_midia (nova, só o servidor): erro definitivo na cópia da mídia
-- (por exemplo midia_grande_demais). A mídia que ainda está pendente vira
-- 'falhou' na hora, sem esperar as 3 tentativas e sem gastar outra.
-- Mídia já copiada, já falhada ou expirada fica como está.
-- p_erro vai para mensagens.erro só nas mensagens de entrada (nelas a coluna
-- não é usada pelo envio); nas de saída o erro do envio fica como está.
-- Erro: mensagem_nao_encontrada (como concluir_midia).
-- ---------------------------------------------------------------------
create or replace function public.desistir_midia(p_msg uuid, p_erro text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m public.mensagens;
begin
  select * into v_m from public.mensagens m where m.id = p_msg for update;
  if not found then
    raise exception using message = 'mensagem_nao_encontrada', errcode = 'P0001';
  end if;

  update public.mensagens m
     set midia_status = 'falhou',
         midia_pega_em = null,
         erro = case when m.direcao = 'entrada'
                     then coalesce(nullif(btrim(coalesce(p_erro, '')), ''), m.erro)
                     else m.erro end
   where m.id = p_msg and m.midia_status = 'pendente';
end;
$$;

revoke execute on function public.desistir_midia(uuid, text) from public, anon, authenticated;
grant execute on function public.desistir_midia(uuid, text) to service_role;

-- ---------------------------------------------------------------------
-- contexto_salvar (texto da 0009). Acréscimos:
--   - a pergunta de cada item livre também tem o limite de 2.000 letras
--     (limite_tamanho), como a resposta;
--   - no máximo 50 itens livres: mais que isso dá limite_itens.
-- O resto é igual: junção de campos, contexto_mudou, nada diferente devolve a atual.
-- Devolve {id, numero} da versão gravada.
-- ---------------------------------------------------------------------
create or replace function public.contexto_salvar(
  p_base bigint,
  p_mudancas jsonb,
  p_origem public.contexto_origem default 'edicao'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_campos constant text[] := array['empresa_oferta', 'cliente_ideal', 'preco', 'diferenciais',
                                    'objecoes', 'quando_passar_humano', 'tom_voz', 'horario'];
  c_limite constant int := 2000;
  c_max_itens constant int := 50;
  v_eu      uuid;
  v_origem  public.contexto_origem := coalesce(p_origem, 'edicao');
  v_atual   jsonb;
  v_base    jsonb;
  v_novo    jsonb;
  v_chave   text;
  v_valor   jsonb;
  v_item    jsonb;
  v_itens   jsonb;
  v_id      bigint;
  v_numero  int;
begin
  if not coalesce(public.eh_admin(), false) then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;
  v_eu := public.membro_atual();

  if v_origem = 'restauracao' then
    raise exception using message = 'mudancas_invalidas', errcode = '22023';
  end if;
  if p_mudancas is null or jsonb_typeof(p_mudancas) <> 'object' then
    raise exception using message = 'mudancas_invalidas', errcode = '22023';
  end if;

  -- Formato e tamanho de cada mudança.
  for v_chave, v_valor in select k.key, k.value from jsonb_each(p_mudancas) k loop
    if v_chave = 'itens' then
      if jsonb_typeof(v_valor) <> 'array' then
        raise exception using message = 'mudancas_invalidas', errcode = '22023';
      end if;
      -- novo: no máximo 50 itens livres
      if jsonb_array_length(v_valor) > c_max_itens then
        raise exception using message = 'limite_itens', errcode = 'P0001';
      end if;
      v_itens := '[]'::jsonb;
      for v_item in select e.value from jsonb_array_elements(v_valor) e loop
        if jsonb_typeof(v_item) <> 'object'
           or jsonb_typeof(v_item -> 'pergunta') is distinct from 'string'
           or jsonb_typeof(v_item -> 'resposta') is distinct from 'string' then
          raise exception using message = 'mudancas_invalidas', errcode = '22023';
        end if;
        -- novo: a pergunta passa pelo mesmo limite da resposta
        if char_length(v_item ->> 'pergunta') > c_limite
           or char_length(v_item ->> 'resposta') > c_limite then
          raise exception using message = 'limite_tamanho', errcode = 'P0001';
        end if;
        v_itens := v_itens || jsonb_build_array(jsonb_build_object(
                     'pergunta', v_item ->> 'pergunta', 'resposta', v_item ->> 'resposta'));
      end loop;
    elsif v_chave = any (c_campos) then
      if jsonb_typeof(v_valor) <> 'string' then
        raise exception using message = 'mudancas_invalidas', errcode = '22023';
      end if;
      if char_length(v_valor #>> '{}') > c_limite then
        raise exception using message = 'limite_tamanho', errcode = 'P0001';
      end if;
    else
      raise exception using message = 'mudancas_invalidas', errcode = '22023';
    end if;
  end loop;

  -- Um admin por vez daqui até o insert.
  perform pg_advisory_xact_lock(hashtext('nina.contexto'));

  select to_jsonb(cv) into v_atual
    from public.contexto_versoes cv
   order by cv.id desc
   limit 1;

  if p_base is null then
    if v_atual is not null then
      raise exception using message = 'contexto_mudou', errcode = 'P0001';
    end if;
    v_base := '{}'::jsonb;
  else
    select to_jsonb(cv) into v_base from public.contexto_versoes cv where cv.id = p_base;
    if v_base is null then
      raise exception using message = 'nao_encontrado', errcode = 'P0001';
    end if;
  end if;

  -- Junta: parte da atual (ou do vazio) e põe por cima o que mudou.
  v_novo := jsonb_build_object('itens', coalesce(v_atual -> 'itens', '[]'::jsonb));
  foreach v_chave in array c_campos loop
    v_novo := v_novo || jsonb_build_object(v_chave, coalesce(v_atual ->> v_chave, ''));
  end loop;

  for v_chave, v_valor in select k.key, k.value from jsonb_each(p_mudancas) k loop
    if v_chave = 'itens' then
      v_valor := v_itens;
    end if;
    -- igual ao que a tela abriu: não é mudança
    if p_base is not null and v_valor = (v_base -> v_chave) then
      continue;
    end if;
    -- mudou também entre a base e a atual: outro admin mexeu no mesmo campo
    if p_base is not null and (v_base -> v_chave) is distinct from (v_atual -> v_chave) then
      raise exception using message = 'contexto_mudou', errcode = 'P0001';
    end if;
    v_novo := v_novo || jsonb_build_object(v_chave, v_valor);
  end loop;

  -- Nada diferente da atual: não grava versão nova.
  if v_atual is not null
     and v_novo = (select jsonb_object_agg(k.key, k.value)
                     from jsonb_each(v_atual) k
                    where k.key = any (c_campos) or k.key = 'itens') then
    return jsonb_build_object('id', (v_atual ->> 'id')::bigint, 'numero', (v_atual ->> 'numero')::int);
  end if;

  insert into public.contexto_versoes (empresa_oferta, cliente_ideal, preco, diferenciais, objecoes,
                                       quando_passar_humano, tom_voz, horario, itens, origem, criado_por)
  values (v_novo ->> 'empresa_oferta', v_novo ->> 'cliente_ideal', v_novo ->> 'preco',
          v_novo ->> 'diferenciais', v_novo ->> 'objecoes', v_novo ->> 'quando_passar_humano',
          v_novo ->> 'tom_voz', v_novo ->> 'horario', v_novo -> 'itens', v_origem, v_eu)
  returning id, numero into v_id, v_numero;

  return jsonb_build_object('id', v_id, 'numero', v_numero);
end;
$$;

revoke execute on function public.contexto_salvar(bigint, jsonb, public.contexto_origem) from public, anon;
grant execute on function public.contexto_salvar(bigint, jsonb, public.contexto_origem) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- O Contexto só é gravado pelas funções (contexto_salvar e contexto_restaurar,
-- security definer). Fecha o insert direto que a 0000 deixava ao admin: tira
-- a policy e o grant de insert (o revoke da tabela leva junto o grant por coluna).
-- A leitura (contexto_versoes_membro_le) continua.
-- ---------------------------------------------------------------------
drop policy if exists contexto_versoes_admin_insere on public.contexto_versoes;
revoke insert on public.contexto_versoes from authenticated;
