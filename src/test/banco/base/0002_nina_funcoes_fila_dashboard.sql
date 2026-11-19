-- 03-fila.sql
-- Funcoes de entrada (webhook), fila (rodadas da Nina, envios, copia de midia),
-- ferramentas da Nina e acoes do membro na conversa. Depende so do 01-estrutura.sql.
--
-- Os gatilhos do 01 ja fazem, no insert em mensagens: previa, nao lidas,
-- ultima_do_lead_em, responder_apos (modo nina), modo humano + cancelamento da
-- fila da Nina (humano_tela/humano_celular), sem_conexao_ativa e janela_fechada.
-- Tambem fazem o historico de etapa e a etapa de entrada. Nada disso se repete aqui.
--
-- Itens de fila sao pegos com FOR UPDATE SKIP LOCKED numa instrucao unica que
-- trava e muda o estado, para dois workers nunca pegarem o mesmo item.
--
-- Todas as funcoes: SECURITY DEFINER, search_path vazio, so service_role,
-- menos assumir_conversa, devolver_para_nina e marcar_lida (authenticated).

-- ===========================================================================
-- Auxiliares internas (ninguem executa direto; so as funcoes abaixo)
-- ===========================================================================

-- Normaliza p_ids: [{tipo, valor}] -> so tipos validos, valor sem espaco,
-- telefone so com digitos, sem repeticao, com a prioridade (1 = mais forte).
create or replace function public.ids_normalizados(p_ids jsonb)
returns jsonb
language sql
immutable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('tipo', x.tipo, 'valor', x.valor, 'prio', x.prio)
                            order by x.prio, x.valor), '[]'::jsonb)
  from (
    select distinct t.tipo, t.valor,
           array_position(array['bsuid', 'lid', 'telefone', 'zernio_conversa'], t.tipo) as prio
    from (
      select e ->> 'tipo' as tipo,
             case when e ->> 'tipo' = 'telefone'
                  then regexp_replace(coalesce(e ->> 'valor', ''), '[^0-9]', '', 'g')
                  else btrim(coalesce(e ->> 'valor', ''))
             end as valor
      from jsonb_array_elements(case when jsonb_typeof(p_ids) = 'array' then p_ids else '[]'::jsonb end) as e
      where jsonb_typeof(e) = 'object'
    ) t
    where t.tipo in ('bsuid', 'lid', 'telefone', 'zernio_conversa')
      and t.valor <> ''
  ) x
$$;

revoke execute on function public.ids_normalizados(jsonb) from public, anon, authenticated, service_role;

-- Acha o contato pelos ids (prioridade bsuid, lid, telefone, zernio_conversa) ou
-- cria. Ids novos sao ligados ao contato achado so se estiverem livres: dois
-- contatos nunca se juntam. Corrida (duas chamadas ao mesmo tempo para um contato
-- novo): quem perde leva unique_violation em contato_identificadores, desfaz o
-- proprio contato (subtransacao) e busca de novo.
create or replace function public.contato_por_ids(p_conexao uuid, p_ids jsonb, p_nome_whatsapp text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids jsonb := public.ids_normalizados(p_ids);
  v_nome text := nullif(btrim(coalesce(p_nome_whatsapp, '')), '');
  v_tel text;
  v_contato uuid;
  v_volta int := 0;
begin
  if jsonb_array_length(v_ids) = 0 then
    raise exception using message = 'sem_identificador', errcode = 'P0001';
  end if;

  select i.valor into v_tel
  from jsonb_to_recordset(v_ids) as i(tipo text, valor text, prio int)
  where i.tipo = 'telefone'
  order by i.valor
  limit 1;

  loop
    v_volta := v_volta + 1;

    select ci.contato_id into v_contato
    from public.contato_identificadores ci
    join jsonb_to_recordset(v_ids) as i(tipo text, valor text, prio int)
      on ci.tipo = i.tipo::public.identificador_tipo and ci.valor = i.valor
    order by i.prio
    limit 1;

    if v_contato is not null then
      -- liga os ids que ainda nao existem; id de outro contato fica onde esta
      insert into public.contato_identificadores (contato_id, tipo, valor, conexao_id)
      select v_contato, i.tipo::public.identificador_tipo, i.valor, p_conexao
      from jsonb_to_recordset(v_ids) as i(tipo text, valor text, prio int)
      order by i.prio, i.valor
      on conflict (tipo, valor) do nothing;

      -- telefone na ficha so se o identificador de telefone e deste contato
      if v_tel is not null and not exists (
        select 1 from public.contato_identificadores ci
        where ci.tipo = 'telefone' and ci.valor = v_tel and ci.contato_id = v_contato) then
        v_tel := null;
      end if;

      update public.contatos c
         set nome_whatsapp = coalesce(v_nome, c.nome_whatsapp),
             telefone      = coalesce(c.telefone, v_tel),
             atualizado_em = now()
       where c.id = v_contato
         and ((v_nome is not null and c.nome_whatsapp is distinct from v_nome)
              or (c.telefone is null and v_tel is not null));

      return v_contato;
    end if;

    begin
      insert into public.contatos (nome_whatsapp, telefone)
      values (v_nome, v_tel)
      returning id into v_contato;

      insert into public.contato_identificadores (contato_id, tipo, valor, conexao_id)
      select v_contato, i.tipo::public.identificador_tipo, i.valor, p_conexao
      from jsonb_to_recordset(v_ids) as i(tipo text, valor text, prio int)
      order by i.prio, i.valor;

      return v_contato;
    exception when unique_violation then
      -- outra chamada criou o contato ao mesmo tempo: desfeito, busca de novo
      v_contato := null;
      if v_volta >= 5 then
        raise;
      end if;
    end;
  end loop;
end;
$$;

revoke execute on function public.contato_por_ids(uuid, jsonb, text) from public, anon, authenticated, service_role;

-- Acha ou cria a conversa (uma por contato).
create or replace function public.conversa_do_contato(p_contato uuid, p_conexao uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conv uuid;
begin
  insert into public.conversas (contato_id, conexao_id)
  values (p_contato, p_conexao)
  on conflict (contato_id) do nothing
  returning id into v_conv;

  if v_conv is null then
    select c.id into v_conv from public.conversas c where c.contato_id = p_contato;
  end if;
  return v_conv;
end;
$$;

revoke execute on function public.conversa_do_contato(uuid, uuid) from public, anon, authenticated, service_role;

-- Tipo de mensagem: valor fora da lista vira 'outro'.
create or replace function public.tipo_de_mensagem(p_tipo text)
returns public.mensagem_tipo
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_tipo = any (enum_range(null::public.mensagem_tipo)::text[])
              then p_tipo::public.mensagem_tipo
              else 'outro'::public.mensagem_tipo
         end
$$;

revoke execute on function public.tipo_de_mensagem(text) from public, anon, authenticated, service_role;

-- Texto para comparar o eco: sem espaco nas pontas e com todo espaco em branco
-- (\r\n, \n, tab, espacos repetidos) virando um espaco so. Vazio vira nulo.
create or replace function public.texto_normalizado(p_texto text)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select nullif(regexp_replace(btrim(coalesce(p_texto, ''), E' \t\r\n'), '\s+', ' ', 'g'), '')
$$;

revoke execute on function public.texto_normalizado(text) from public, anon, authenticated, service_role;

-- Confere que a rodada existe e esta rodando; devolve a linha travada.
create or replace function public.rodada_rodando(p_rodada uuid)
returns public.rodadas
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.rodadas;
begin
  select * into v_r from public.rodadas r where r.id = p_rodada for update;
  if not found or v_r.status <> 'rodando' then
    raise exception using message = 'rodada_nao_rodando', errcode = 'P0001';
  end if;
  return v_r;
end;
$$;

revoke execute on function public.rodada_rodando(uuid) from public, anon, authenticated, service_role;

-- Membro ativo da sessao (ou erro sem_acesso).
create or replace function public.membro_atual()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_membro uuid;
begin
  if not coalesce(public.eh_membro(), false) then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;
  select m.id into v_membro from public.membros m where m.user_id = auth.uid() and m.ativo;
  if v_membro is null then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;
  return v_membro;
end;
$$;

revoke execute on function public.membro_atual() from public, anon, authenticated, service_role;

-- ===========================================================================
-- Entrada
-- ===========================================================================

-- Mensagem do lead. Mesmo id_externo na mesma conexao: nao duplica
-- (editada troca o texto, apagada preenche apagada_em, senao nada; nova = false).
create or replace function public.registrar_entrada(
  p_conexao uuid, p_ids jsonb, p_nome_whatsapp text, p_msg jsonb)
returns table (mensagem_id uuid, conversa_id uuid, nova boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_id_ext  text := nullif(btrim(coalesce(p_msg ->> 'id_externo', '')), '');
  v_momento timestamptz;
  v_ref     text := nullif(btrim(coalesce(p_msg ->> 'midia_ref_externa', '')), '');
  v_contato uuid;
  v_conv    uuid;
  v_msg     uuid;
begin
  if v_id_ext is null or nullif(p_msg ->> 'tipo', '') is null or nullif(p_msg ->> 'momento', '') is null then
    raise exception using message = 'mensagem_invalida', errcode = 'P0001';
  end if;
  v_momento := (p_msg ->> 'momento')::timestamptz;

  -- ja existe (reentrega do webhook, edicao ou apagamento)
  select m.id, m.conversa_id into v_msg, v_conv
  from public.mensagens m
  where m.conexao_id = p_conexao and m.id_externo = v_id_ext;

  if v_msg is null then
    -- Apagamento de mensagem que nunca foi gravada (enviada antes da conexao, ou a
    -- original ainda em nova tentativa): nao cria contato, conversa nem mensagem
    -- (nao arma a Nina nem conta lead novo).
    if coalesce((p_msg ->> 'apagada')::boolean, false) then
      return query select null::uuid, null::uuid, false;
      return;
    end if;

    v_contato := public.contato_por_ids(p_conexao, p_ids, p_nome_whatsapp);
    -- Trava o contato antes da conversa (o gatilho do insert trava a conversa), na
    -- mesma ordem para todas as chamadas: duas entradas ao mesmo tempo nao se travam.
    perform 1 from public.contatos c where c.id = v_contato for update;
    v_conv := public.conversa_do_contato(v_contato, p_conexao);

    update public.conversas c
       set conexao_id = p_conexao
     where c.id = v_conv and c.conexao_id is distinct from p_conexao;

    insert into public.mensagens (
      conversa_id, conexao_id, direcao, origem, tipo, texto, status,
      midia_ref_externa, midia_mime, midia_nome, midia_tamanho, midia_status,
      id_externo, id_gateway, momento, evento_id, editada)
    values (
      v_conv, p_conexao, 'entrada', 'lead', public.tipo_de_mensagem(p_msg ->> 'tipo'),
      p_msg ->> 'texto', 'recebida',
      v_ref, p_msg ->> 'midia_mime', p_msg ->> 'midia_nome',
      (nullif(p_msg ->> 'midia_tamanho', ''))::bigint,
      case when v_ref is not null then 'pendente'::public.midia_status end,
      v_id_ext, nullif(p_msg ->> 'id_gateway', ''), v_momento,
      (nullif(p_msg ->> 'evento_id', ''))::bigint,
      -- edicao que chega antes da original ja entra marcada como editada
      coalesce((p_msg ->> 'editada')::boolean, false))
    on conflict (conexao_id, id_externo) where id_externo is not null do nothing
    returning id into v_msg;

    if v_msg is not null then
      update public.contatos c
         set primeira_mensagem_em = v_momento
       where c.id = v_contato
         and (c.primeira_mensagem_em is null or c.primeira_mensagem_em > v_momento);

      return query select v_msg, v_conv, true;
      return;
    end if;

    -- outra chamada gravou o mesmo id agora ha pouco
    select m.id, m.conversa_id into v_msg, v_conv
    from public.mensagens m
    where m.conexao_id = p_conexao and m.id_externo = v_id_ext;
  end if;

  if coalesce((p_msg ->> 'editada')::boolean, false) then
    update public.mensagens m
       set texto = p_msg ->> 'texto', editada = true
     where m.id = v_msg;
  end if;
  if coalesce((p_msg ->> 'apagada')::boolean, false) then
    update public.mensagens m
       set apagada_em = coalesce(m.apagada_em, now())
     where m.id = v_msg;
  end if;

  return query select v_msg, v_conv, false;
end;
$$;

revoke execute on function public.registrar_entrada(uuid, jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function public.registrar_entrada(uuid, jsonb, text, jsonb) to service_role;

-- Mensagem que saiu pelo celular. Id conhecido (id_externo, ou id_gateway que o
-- concluir_envio gravou, caso da Zernio): ignorado, so completa o id_externo. Eco
-- do nosso envio (mensagem 'enviando', ou 'enviada' ainda sem id_externo, com o
-- mesmo texto normalizado na mesma conversa nos ultimos 60 s; sem texto, mesmo
-- tipo e, se vierem, mesmo nome e mime da midia): so ganha o id_externo. Senao
-- entra como humano_celular (o gatilho poe a conversa no modo humano).
create or replace function public.registrar_saida_celular(p_conexao uuid, p_ids jsonb, p_msg jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id_ext  text := nullif(btrim(coalesce(p_msg ->> 'id_externo', '')), '');
  v_gw      text := nullif(btrim(coalesce(p_msg ->> 'id_gateway', '')), '');
  v_ref     text := nullif(btrim(coalesce(p_msg ->> 'midia_ref_externa', '')), '');
  v_texto   text := public.texto_normalizado(p_msg ->> 'texto');
  v_tipo    public.mensagem_tipo := public.tipo_de_mensagem(p_msg ->> 'tipo');
  v_momento timestamptz;
  v_contato uuid;
  v_conv    uuid;
  v_msg     uuid;
begin
  if v_id_ext is null or nullif(p_msg ->> 'tipo', '') is null or nullif(p_msg ->> 'momento', '') is null then
    raise exception using message = 'mensagem_invalida', errcode = 'P0001';
  end if;
  v_momento := (p_msg ->> 'momento')::timestamptz;

  select m.id into v_msg
  from public.mensagens m
  where m.conexao_id = p_conexao and m.id_externo = v_id_ext;
  if v_msg is not null then
    return v_msg;
  end if;

  -- conhecida pelo id do gateway (o envio devolveu so esse id)
  if v_gw is not null then
    select m.id into v_msg
    from public.mensagens m
    where m.conexao_id = p_conexao and m.direcao = 'saida' and m.id_gateway = v_gw
    order by m.criado_em desc, m.id
    limit 1
    for update;
    if v_msg is not null then
      update public.mensagens m
         set id_externo = v_id_ext
       where m.id = v_msg and m.id_externo is null;
      return v_msg;
    end if;
  end if;

  v_contato := public.contato_por_ids(p_conexao, p_ids, null);
  v_conv := public.conversa_do_contato(v_contato, p_conexao);

  -- eco do nosso envio
  select m.id into v_msg
  from public.mensagens m
  where m.conversa_id = v_conv
    and m.direcao = 'saida'
    and m.origem in ('nina', 'humano_tela')
    and m.status in ('enviando', 'enviada')
    and m.id_externo is null
    and public.texto_normalizado(m.texto) is not distinct from v_texto
    and (v_texto is not null
         or (m.tipo = v_tipo
             and (nullif(p_msg ->> 'midia_nome', '') is null or m.midia_nome = p_msg ->> 'midia_nome')
             and (nullif(p_msg ->> 'midia_mime', '') is null or m.midia_mime = p_msg ->> 'midia_mime')))
    and coalesce(m.status_em, m.criado_em) > now() - interval '60 seconds'
  order by m.criado_em, m.ordem nulls last, m.id
  limit 1
  for update;

  if v_msg is not null then
    update public.mensagens m
       set id_externo = v_id_ext,
           id_gateway = coalesce(m.id_gateway, nullif(p_msg ->> 'id_gateway', ''))
     where m.id = v_msg;
    return v_msg;
  end if;

  insert into public.mensagens (
    conversa_id, conexao_id, direcao, origem, tipo, texto, status, status_em,
    midia_ref_externa, midia_mime, midia_nome, midia_tamanho, midia_status,
    id_externo, id_gateway, momento, evento_id)
  values (
    v_conv, p_conexao, 'saida', 'humano_celular', v_tipo,
    p_msg ->> 'texto', 'enviada', v_momento,
    v_ref, p_msg ->> 'midia_mime', p_msg ->> 'midia_nome',
    (nullif(p_msg ->> 'midia_tamanho', ''))::bigint,
    case when v_ref is not null then 'pendente'::public.midia_status end,
    v_id_ext, v_gw, v_momento,
    (nullif(p_msg ->> 'evento_id', ''))::bigint)
  on conflict (conexao_id, id_externo) where id_externo is not null do nothing
  returning id into v_msg;

  if v_msg is null then
    select m.id into v_msg
    from public.mensagens m
    where m.conexao_id = p_conexao and m.id_externo = v_id_ext;
  end if;
  return v_msg;
end;
$$;

revoke execute on function public.registrar_saida_celular(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.registrar_saida_celular(uuid, jsonb, jsonb) to service_role;

-- Status vindo do gateway. Casa por id_externo ou id_gateway na conexao e so
-- avanca: na_fila < enviando < enviada < entregue < lida; falhou so a partir de
-- enviando ou enviada (com erro = 'falha_no_gateway', que o concluir_envio nao
-- desfaz). Se o status chega antes do concluir_envio, 'momento' (hora do envio)
-- passa a ser a hora em que a mensagem foi pega para envio. Devolve quantas
-- mensagens casaram (0 = o evento fica para nova tentativa).
create or replace function public.atualizar_status(
  p_conexao uuid, p_id text, p_status public.mensagem_status, p_momento timestamptz)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_casaram int;
begin
  if nullif(btrim(coalesce(p_id, '')), '') is null then
    return 0;
  end if;

  with alvo as (
    select m.id, m.status
    from public.mensagens m
    where m.conexao_id = p_conexao
      and m.direcao = 'saida'
      and (m.id_externo = p_id or m.id_gateway = p_id)
    for update
  ), muda as (
    update public.mensagens m
       set status = p_status,
           status_em = coalesce(p_momento, now()),
           erro = case when p_status = 'falhou' then 'falha_no_gateway' else m.erro end,
           momento = case when a.status in ('na_fila', 'enviando') and p_status <> 'falhou'
                          then coalesce(m.status_em, m.momento) else m.momento end
      from alvo a
     where m.id = a.id
       and (
         (p_status in ('enviada', 'entregue', 'lida')
          and a.status in ('na_fila', 'enviando', 'enviada', 'entregue')
          and array_position(array['na_fila', 'enviando', 'enviada', 'entregue', 'lida'], p_status::text)
            > array_position(array['na_fila', 'enviando', 'enviada', 'entregue', 'lida'], a.status::text))
         or (p_status = 'falhou' and a.status in ('enviando', 'enviada'))
       )
    returning m.id
  )
  select count(*) into v_casaram from alvo;

  return v_casaram;
end;
$$;

revoke execute on function public.atualizar_status(uuid, text, public.mensagem_status, timestamptz) from public, anon, authenticated;
grant execute on function public.atualizar_status(uuid, text, public.mensagem_status, timestamptz) to service_role;

-- ===========================================================================
-- Fila: rodadas da Nina
-- ===========================================================================

-- Falha de rodada. Passageira com tentativa < 3: re-arma responder_apos em 30 s.
-- A 3a, ou falha nao passageira: conversa vai para aguardando humano com o motivo.
-- As entradas lidas pela rodada sao soltas (rodada_id = null). Rodada que um
-- humano ja cancelou (assumiu ou respondeu): nada a fazer.
create or replace function public.falhar_rodada(
  p_rodada uuid, p_motivo public.motivo_humano, p_passageiro boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.rodadas;
  v_modo public.conversa_modo;
begin
  if exists (select 1 from public.rodadas r where r.id = p_rodada and r.status = 'cancelada') then
    return;
  end if;
  v_r := public.rodada_rodando(p_rodada);

  update public.rodadas r
     set status = 'falhou', motivo = p_motivo, terminada_em = now()
   where r.id = p_rodada;

  update public.mensagens m
     set rodada_id = null
   where m.rodada_id = p_rodada and m.direcao = 'entrada';

  select c.modo into v_modo from public.conversas c where c.id = v_r.conversa_id for update;

  -- se a conversa ja saiu do modo nina (humano assumiu), nao mexe nela
  if v_modo is distinct from 'nina' then
    return;
  end if;

  if coalesce(p_passageiro, false) and coalesce(v_r.tentativa, 1) < 3 then
    update public.conversas c
       set responder_apos = now() + interval '30 seconds'
     where c.id = v_r.conversa_id;
  else
    update public.conversas c
       set modo = 'humano',
           aguardando_humano_desde = now(),
           motivo_humano = p_motivo,
           responder_apos = null
     where c.id = v_r.conversa_id;
  end if;
end;
$$;

revoke execute on function public.falhar_rodada(uuid, public.motivo_humano, boolean) from public, anon, authenticated;
grant execute on function public.falhar_rodada(uuid, public.motivo_humano, boolean) to service_role;

-- Pega as conversas prontas para a Nina responder e cria uma rodada para cada.
-- Antes, rodada rodando ha mais de 5 min falha como erro_provedor passageiro.
-- Nao abre rodada fadada a falhar: sem conexao ativa, ou com conexao oficial e a
-- janela de 24 h fechada (a conversa espera armada). A tentativa conta as falhas
-- desde a ultima rodada concluida ou desde o ultimo "Devolver para a Nina".
create or replace function public.pegar_rodadas(p_limite int)
returns setof public.rodadas
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_velha  uuid;
  v_ctx    bigint;
  v_prov   public.ia_provedor;
  v_modelo text;
  v_ids    uuid[];
begin
  for v_velha in
    select r.id from public.rodadas r
    where r.status = 'rodando' and r.iniciada_em < now() - interval '5 minutes'
    order by r.iniciada_em
    for update skip locked
  loop
    perform public.falhar_rodada(v_velha, 'erro_provedor', true);
  end loop;

  select max(cv.id) into v_ctx from public.contexto_versoes cv;
  select k.provedor, k.modelo into v_prov, v_modelo
  from public.ia_chaves k where k.finalidade = 'resposta';

  -- instrucao unica: trava (SKIP LOCKED), limpa responder_apos e cria a rodada
  with alvo as (
    select c.id
    from public.conversas c
    where c.responder_apos <= now()
      and c.modo = 'nina'
      and not exists (select 1 from public.rodadas r
                      where r.conversa_id = c.id and r.status = 'rodando')
      and not exists (select 1 from public.mensagens m
                      where m.conversa_id = c.id and m.direcao = 'entrada'
                        and m.midia_status = 'pendente'
                        and m.criado_em > now() - interval '2 minutes')
      and exists (select 1 from public.conexoes cx
                  where cx.ativa
                    and (not cx.oficial
                         or (c.ultima_do_lead_em is not null
                             and c.ultima_do_lead_em + interval '24 hours' > now())))
    order by c.responder_apos, c.id
    limit greatest(coalesce(p_limite, 0), 0)
    for update of c skip locked
  ), limpa as (
    update public.conversas c
       set responder_apos = null
      from alvo a
     where c.id = a.id
    returning c.id
  ), nova as (
    insert into public.rodadas (conversa_id, status, contexto_versao_id, provedor, modelo,
                                passos, tentativa, passou_humano, iniciada_em)
    select l.id, 'rodando', v_ctx, v_prov, v_modelo, 0,
           1 + (select count(*) from public.rodadas f
                where f.conversa_id = l.id and f.status = 'falhou'
                  and f.criado_em > greatest(
                        coalesce((select max(k.criado_em) from public.rodadas k
                                  where k.conversa_id = l.id and k.status = 'concluida'),
                                 '-infinity'::timestamptz),
                        coalesce((select cv.devolvida_em from public.conversas cv where cv.id = l.id),
                                 '-infinity'::timestamptz))),
           false, now()
    from limpa l
    returning id
  )
  select array_agg(n.id) into v_ids from nova n;

  if v_ids is null then
    return;
  end if;

  -- liga as entradas ainda nao lidas a rodada
  update public.mensagens m
     set rodada_id = r.id
    from public.rodadas r
   where r.id = any (v_ids)
     and m.conversa_id = r.conversa_id
     and m.direcao = 'entrada'
     and m.rodada_id is null;

  return query
    select r.* from public.rodadas r where r.id = any (v_ids) order by r.criado_em, r.id;
end;
$$;

revoke execute on function public.pegar_rodadas(int) from public, anon, authenticated;
grant execute on function public.pegar_rodadas(int) to service_role;

-- Conclui a rodada: cada resposta vira mensagem saida/nina/texto com ordem 1..n e
-- enviar_apos = now() + (ordem-1) * 2 s. Se a conversa saiu do modo nina durante
-- a rodada, entram como 'cancelada' (excecao: a propria Nina passou para humano e
-- nenhum humano escreveu desde o inicio da rodada; ai a despedida vai). Sair e
-- voltar tambem conta como sair: assumir ou mensagem humana cancela a rodada
-- (status 'cancelada'), e qualquer mensagem humana desde o inicio da rodada
-- cancela as respostas mesmo com o modo de volta em 'nina'.
-- Para o worker: 'sem_conexao_ativa' ou 'janela_fechada' vindos daqui (gatilho do
-- insert) nao sao passageiros; chamar falhar_rodada(p_rodada, 'erro_provedor',
-- false) em vez de deixar a rodada expirar.
create or replace function public.concluir_rodada(
  p_rodada uuid, p_respostas jsonb, p_ferramentas jsonb, p_passos int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r       public.rodadas;
  v_c       public.conversas;
  v_status  public.mensagem_status;
  v_conexao uuid;
begin
  select * into v_r from public.rodadas r where r.id = p_rodada for update;
  if not found or v_r.status not in ('rodando', 'cancelada') then
    raise exception using message = 'rodada_nao_rodando', errcode = 'P0001';
  end if;

  select * into v_c from public.conversas c where c.id = v_r.conversa_id for update;

  if v_r.status = 'rodando'
     and (v_c.modo = 'nina' or coalesce(v_r.passou_humano, false))
     and not exists (select 1 from public.mensagens h
                     where h.conversa_id = v_c.id
                       and h.origem in ('humano_tela', 'humano_celular')
                       and h.criado_em >= v_r.iniciada_em) then
    v_status := 'na_fila';
  else
    v_status := 'cancelada';
  end if;

  select cx.id into v_conexao from public.conexoes cx where cx.ativa limit 1;
  v_conexao := coalesce(v_conexao, v_c.conexao_id);

  insert into public.mensagens (conversa_id, conexao_id, direcao, origem, tipo, texto, status,
                                ordem, enviar_apos, rodada_id, momento)
  select v_c.id, v_conexao, 'saida', 'nina', 'texto', x.texto, v_status,
         x.n, now() + (x.n - 1)::int * interval '2 seconds', p_rodada, now()
  from (
    select e.val ->> 'texto' as texto, row_number() over (order by e.ord) as n
    from jsonb_array_elements(case when jsonb_typeof(p_respostas) = 'array' then p_respostas else '[]'::jsonb end)
         with ordinality as e(val, ord)
    where jsonb_typeof(e.val) = 'object'
      and btrim(coalesce(e.val ->> 'texto', '')) <> ''
  ) x
  order by x.n;

  update public.rodadas r
     set status = case when r.status = 'cancelada' then r.status
                       else 'concluida'::public.rodada_status end,
         ferramentas = coalesce(p_ferramentas, r.ferramentas),
         passos = coalesce(p_passos, r.passos),
         terminada_em = coalesce(r.terminada_em, now())
   where r.id = p_rodada;
end;
$$;

revoke execute on function public.concluir_rodada(uuid, jsonb, jsonb, int) from public, anon, authenticated;
grant execute on function public.concluir_rodada(uuid, jsonb, jsonb, int) to service_role;

-- ===========================================================================
-- Fila: envios
-- ===========================================================================

-- Pega no maximo a 1a mensagem pendente de cada conversa, so com conexao ativa,
-- sem outra 'enviando' na conversa e com enviar_apos vencido. Antes: 'enviando'
-- ha mais de 2 min volta para na_fila (ou falhou, se ja foi a 3a tentativa; ou
-- enviada, se o eco ja gravou o id_externo, que prova que saiu). Com uma conexao
-- ativa, 'na_fila' presa a outra conexao (desativada) vira falhou com erro
-- 'conexao_inativa', para nao travar a fila da conversa. Sem nenhuma ativa, fica.
create or replace function public.pegar_envios(p_limite int)
returns setof public.mensagens
language plpgsql
security definer
set search_path = ''
as $$
begin
  with presas as (
    select m.id
    from public.mensagens m
    where m.direcao = 'saida' and m.status = 'enviando'
      and coalesce(m.status_em, m.criado_em) < now() - interval '2 minutes'
    for update skip locked
  )
  update public.mensagens m
     set status    = case when m.id_externo is not null then 'enviada'::public.mensagem_status
                          when m.tentativas >= 3 then 'falhou'::public.mensagem_status
                          else 'na_fila'::public.mensagem_status end,
         erro      = case when m.id_externo is null and m.tentativas >= 3 then 'sem_resposta_do_envio'
                          else m.erro end,
         momento   = case when m.id_externo is not null then coalesce(m.status_em, m.momento)
                          else m.momento end,
         status_em = now()
    from presas p
   where m.id = p.id;

  with orfas as (
    select m.id
    from public.mensagens m
    where m.direcao = 'saida' and m.status = 'na_fila'
      and exists (select 1 from public.conexoes a where a.ativa)
      and not exists (select 1 from public.conexoes cx where cx.id = m.conexao_id and cx.ativa)
    for update skip locked
  )
  update public.mensagens m
     set status = 'falhou', erro = 'conexao_inativa', status_em = now()
    from orfas o
   where m.id = o.id;

  -- instrucao unica: trava (SKIP LOCKED) e passa para 'enviando'
  return query
  with primeiras as (
    select distinct on (m.conversa_id) m.id
    from public.mensagens m
    where m.direcao = 'saida' and m.status = 'na_fila'
    order by m.conversa_id, m.criado_em, m.ordem nulls last, m.id
  ), alvo as (
    select m.id
    from public.mensagens m
    join primeiras p on p.id = m.id
    join public.conexoes cx on cx.id = m.conexao_id and cx.ativa
    where m.status = 'na_fila'
      and coalesce(m.enviar_apos, m.criado_em) <= now()
      and not exists (select 1 from public.mensagens e
                      where e.conversa_id = m.conversa_id
                        and e.direcao = 'saida' and e.status = 'enviando')
    order by coalesce(m.enviar_apos, m.criado_em), m.id
    limit greatest(coalesce(p_limite, 0), 0)
    for update of m skip locked
  )
  update public.mensagens m
     set status = 'enviando',
         tentativas = coalesce(m.tentativas, 0) + 1,
         status_em = now()
    from alvo a
   where m.id = a.id
  returning m.*;
end;
$$;

revoke execute on function public.pegar_envios(int) from public, anon, authenticated;
grant execute on function public.pegar_envios(int) to service_role;

-- Envio aceito pelo gateway. Nunca falha por id_externo repetido: se um eco do
-- celular ja gravou esse id na mesma conversa nos ultimos 60 s, a duplicata e
-- apagada e o id fica nesta mensagem; se o id e de outra mensagem qualquer, esta
-- fica sem id_externo. Ao apagar a duplicata, desfaz o que ela causou quando
-- nenhum humano escreveu de verdade desde a criacao desta mensagem da Nina:
-- a conversa volta ao modo nina, as respostas da Nina que ela cancelou voltam
-- para a fila, a rodada que ela cancelou volta a rodar (ou, se o worker ja a
-- concluiu, vira concluida e as respostas dela voltam para a fila), e entrada
-- ainda sem leitura re-arma responder_apos. 'falhou' so vira 'enviada' quando a falha foi o tempo esgotado do
-- proprio pegar_envios (sem_resposta_do_envio); falha avisada pelo gateway fica.
create or replace function public.concluir_envio(p_msg uuid, p_id_externo text, p_id_gateway text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m   public.mensagens;
  v_id  text := nullif(btrim(coalesce(p_id_externo, '')), '');
  v_gw  text := nullif(btrim(coalesce(p_id_gateway, '')), '');
  v_dup public.mensagens;
  v_rod public.rodadas;
  v_volta int := 0;
begin
  select * into v_m from public.mensagens m where m.id = p_msg for update;
  if not found then
    raise exception using message = 'mensagem_nao_encontrada', errcode = 'P0001';
  end if;

  loop
    v_volta := v_volta + 1;

    if v_id is not null and v_id is distinct from v_m.id_externo then
      select * into v_dup
      from public.mensagens d
      where d.conexao_id = v_m.conexao_id and d.id_externo = v_id and d.id <> p_msg
      for update;

      if found then
        if v_dup.conversa_id = v_m.conversa_id
           and v_dup.origem = 'humano_celular'
           and v_dup.criado_em > now() - interval '60 seconds' then
          delete from public.mensagens d where d.id = v_dup.id;

          if v_m.origem = 'nina'
             and not exists (select 1 from public.mensagens h
                             where h.conversa_id = v_m.conversa_id
                               and h.origem in ('humano_tela', 'humano_celular')
                               and h.criado_em >= v_m.criado_em) then
            update public.conversas c
               set modo = 'nina',
                   motivo_humano = null
             where c.id = v_m.conversa_id
               and c.modo = 'humano'
               and c.motivo_humano = 'humano_celular'
               and c.responsavel_id is null;
            if found then
              -- So o que o insert da duplicata desfez: o gatilho dela grava
              -- status_em / terminada_em = now() da transacao em que ela entrou,
              -- que e o criado_em dela. Cancelado por outro motivo fica.
              update public.mensagens n
                 set status = 'na_fila', status_em = now()
               where n.conversa_id = v_m.conversa_id
                 and n.origem = 'nina' and n.status = 'cancelada'
                 and n.status_em = v_dup.criado_em;

              select * into v_rod
              from public.rodadas r
              where r.conversa_id = v_m.conversa_id
                and r.status = 'cancelada'
                and r.terminada_em = v_dup.criado_em
              order by r.iniciada_em desc
              limit 1
              for update;

              if found then
                if exists (select 1 from public.mensagens s
                           where s.rodada_id = v_rod.id and s.direcao = 'saida')
                   or coalesce(v_rod.ferramentas, '[]'::jsonb) <> '[]'::jsonb
                   or coalesce(v_rod.passos, 0) > 0 then
                  -- o worker ja concluiu a rodada cancelada (gravou respostas,
                  -- ferramentas ou passos): as respostas dela, gravadas como
                  -- canceladas so por causa da duplicata, voltam. Conclusao sem
                  -- nada disso nao se distingue: volta a rodar e, se ninguem a
                  -- concluir, expira em 5 min como falha passageira.
                  update public.mensagens s
                     set status = 'na_fila', status_em = now()
                   where s.rodada_id = v_rod.id and s.direcao = 'saida'
                     and s.origem = 'nina' and s.status = 'cancelada';
                  update public.rodadas r set status = 'concluida' where r.id = v_rod.id;
                elsif not exists (select 1 from public.rodadas o
                                  where o.conversa_id = v_m.conversa_id and o.status = 'rodando') then
                  -- o worker ainda esta com ela: volta a rodar
                  update public.rodadas r
                     set status = 'rodando', terminada_em = null
                   where r.id = v_rod.id;
                else
                  v_rod := null;
                end if;

                if v_rod.id is not null then
                  -- religa as entradas que ela lia (o pegar_rodadas liga todas as
                  -- soltas de antes do inicio dela)
                  update public.mensagens e
                     set rodada_id = v_rod.id
                   where e.conversa_id = v_m.conversa_id and e.direcao = 'entrada'
                     and e.rodada_id is null and e.criado_em <= v_rod.iniciada_em;
                end if;
              end if;

              -- Re-arma se sobrou entrada sem leitura depois da ultima rodada que
              -- concluiu ou esta rodando (o gatilho da duplicata limpou o armado).
              update public.conversas c
                 set responder_apos = coalesce(c.responder_apos, now())
               where c.id = v_m.conversa_id
                 and exists (select 1 from public.mensagens e
                             where e.conversa_id = c.id and e.direcao = 'entrada'
                               and e.rodada_id is null
                               and e.criado_em > coalesce(
                                     (select max(r.iniciada_em) from public.rodadas r
                                      where r.conversa_id = c.id
                                        and r.status in ('concluida', 'rodando')),
                                     '-infinity'::timestamptz));
            end if;
          end if;
        else
          v_id := null;
        end if;
      end if;
    end if;

    begin
      update public.mensagens m
         set status = case when m.status in ('na_fila', 'enviando')
                             or (m.status = 'falhou' and m.erro = 'sem_resposta_do_envio')
                           then 'enviada'::public.mensagem_status else m.status end,
             status_em = case when m.status in ('na_fila', 'enviando')
                                or (m.status = 'falhou' and m.erro = 'sem_resposta_do_envio')
                              then now() else m.status_em end,
             erro = case when m.status in ('na_fila', 'enviando')
                           or (m.status = 'falhou' and m.erro = 'sem_resposta_do_envio')
                         then null else m.erro end,
             id_externo = coalesce(v_id, m.id_externo),
             id_gateway = coalesce(v_gw, m.id_gateway),
             momento = case when m.status in ('na_fila', 'enviando')
                              or (m.status = 'falhou' and m.erro = 'sem_resposta_do_envio')
                            then now() else m.momento end
       where m.id = p_msg;
      return;
    exception when unique_violation then
      -- um eco entrou com esse id entre a conferencia e o update: confere de novo
      if v_volta >= 2 then
        v_id := null;
      end if;
    end;
  end loop;
end;
$$;

revoke execute on function public.concluir_envio(uuid, text, text) from public, anon, authenticated;
grant execute on function public.concluir_envio(uuid, text, text) to service_role;

-- Envio recusado. Definitivo ou 3a tentativa: falhou. Senao volta para na_fila
-- e tenta de novo em 30 s.
create or replace function public.falhar_envio(p_msg uuid, p_erro text, p_definitivo boolean)
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
  if v_m.status not in ('na_fila', 'enviando') then
    return;
  end if;

  if coalesce(p_definitivo, false) or coalesce(v_m.tentativas, 0) >= 3 then
    update public.mensagens m
       set status = 'falhou', erro = p_erro, status_em = now()
     where m.id = p_msg;
  else
    update public.mensagens m
       set status = 'na_fila', erro = p_erro, status_em = now(),
           enviar_apos = now() + interval '30 seconds'
     where m.id = p_msg;
  end if;
end;
$$;

revoke execute on function public.falhar_envio(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.falhar_envio(uuid, text, boolean) to service_role;

-- ===========================================================================
-- Fila: copia de midia para o Storage
-- ===========================================================================

-- Pega midias pendentes (trava = midia_pega_em, vence em 2 min; ate 3 tentativas).
-- Pendente com 3 tentativas e trava vencida vira 'falhou'.
create or replace function public.pegar_midias(p_limite int)
returns setof public.mensagens
language plpgsql
security definer
set search_path = ''
as $$
begin
  with esgotadas as (
    select m.id
    from public.mensagens m
    where m.midia_status = 'pendente'
      and m.midia_tentativas >= 3
      and (m.midia_pega_em is null or m.midia_pega_em < now() - interval '2 minutes')
    for update skip locked
  )
  update public.mensagens m
     set midia_status = 'falhou', midia_pega_em = null
    from esgotadas e
   where m.id = e.id;

  -- instrucao unica: trava (SKIP LOCKED) e marca como pega
  return query
  with alvo as (
    select m.id
    from public.mensagens m
    where m.midia_status = 'pendente'
      and m.midia_ref_externa is not null
      and m.midia_tentativas < 3
      and (m.midia_pega_em is null or m.midia_pega_em < now() - interval '2 minutes')
    order by m.criado_em, m.id
    limit greatest(coalesce(p_limite, 0), 0)
    for update of m skip locked
  )
  update public.mensagens m
     set midia_pega_em = now(),
         midia_tentativas = m.midia_tentativas + 1
    from alvo a
   where m.id = a.id
  returning m.*;
end;
$$;

revoke execute on function public.pegar_midias(int) from public, anon, authenticated;
grant execute on function public.pegar_midias(int) to service_role;

-- Resultado da copia. ok: copiada com caminho, mime e tamanho. Falha: volta a
-- pendente para nova tentativa, ou falhou se ja foram 3.
create or replace function public.concluir_midia(
  p_msg uuid, p_caminho text, p_mime text, p_tamanho bigint, p_ok boolean)
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

  if coalesce(p_ok, false) then
    update public.mensagens m
       set midia_status = 'copiada',
           midia_caminho = p_caminho,
           midia_mime = coalesce(nullif(p_mime, ''), m.midia_mime),
           midia_tamanho = coalesce(p_tamanho, m.midia_tamanho),
           midia_pega_em = null
     where m.id = p_msg;
  else
    update public.mensagens m
       set midia_status = case when m.midia_tentativas >= 3 then 'falhou'::public.midia_status
                               else 'pendente'::public.midia_status end,
           midia_pega_em = null
     where m.id = p_msg and m.midia_status = 'pendente';
  end if;
end;
$$;

revoke execute on function public.concluir_midia(uuid, text, text, bigint, boolean) from public, anon, authenticated;
grant execute on function public.concluir_midia(uuid, text, text, bigint, boolean) to service_role;

-- ===========================================================================
-- Ferramentas da Nina (so com a rodada rodando)
-- ===========================================================================

create or replace function public.nina_mover_etapa(p_rodada uuid, p_etapa uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.rodadas := public.rodada_rodando(p_rodada);
  v_contato uuid;
begin
  if not exists (select 1 from public.etapas e
                 where e.id = p_etapa and e.nina_pode_mover and not e.arquivada) then
    raise exception using message = 'etapa_nao_permitida', errcode = 'P0001';
  end if;

  select c.contato_id into v_contato from public.conversas c where c.id = v_r.conversa_id;

  -- o gatilho de historico le esta marca e grava ator = nina
  perform set_config('nina.rodada_id', p_rodada::text, true);

  update public.contatos c
     set etapa_id = p_etapa, etapa_desde = now(), atualizado_em = now()
   where c.id = v_contato and c.etapa_id is distinct from p_etapa;
end;
$$;

revoke execute on function public.nina_mover_etapa(uuid, uuid) from public, anon, authenticated;
grant execute on function public.nina_mover_etapa(uuid, uuid) to service_role;

create or replace function public.nina_passar_para_humano(p_rodada uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.rodadas := public.rodada_rodando(p_rodada);
begin
  update public.rodadas r set passou_humano = true where r.id = p_rodada;

  update public.conversas c
     set modo = 'humano',
         motivo_humano = 'nina_passou',
         aguardando_humano_desde = coalesce(c.aguardando_humano_desde, now()),
         responder_apos = null
   where c.id = v_r.conversa_id and c.modo = 'nina';
end;
$$;

revoke execute on function public.nina_passar_para_humano(uuid) from public, anon, authenticated;
grant execute on function public.nina_passar_para_humano(uuid) to service_role;

-- So nome, email, empresa e resumo_nina. Qualquer outra chave: campo_nao_permitido.
create or replace function public.nina_atualizar_contato(p_rodada uuid, p_campos jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.rodadas := public.rodada_rodando(p_rodada);
  v_contato uuid;
begin
  if jsonb_typeof(p_campos) is distinct from 'object'
     or exists (select 1 from jsonb_object_keys(p_campos) k
                where k not in ('nome', 'email', 'empresa', 'resumo_nina')) then
    raise exception using message = 'campo_nao_permitido', errcode = 'P0001';
  end if;
  if p_campos = '{}'::jsonb then
    return;
  end if;

  select c.contato_id into v_contato from public.conversas c where c.id = v_r.conversa_id;

  update public.contatos c
     set nome        = case when p_campos ? 'nome' then p_campos ->> 'nome' else c.nome end,
         email       = case when p_campos ? 'email' then p_campos ->> 'email' else c.email end,
         empresa     = case when p_campos ? 'empresa' then p_campos ->> 'empresa' else c.empresa end,
         resumo_nina = case when p_campos ? 'resumo_nina' then p_campos ->> 'resumo_nina' else c.resumo_nina end,
         atualizado_em = now()
   where c.id = v_contato;
end;
$$;

revoke execute on function public.nina_atualizar_contato(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.nina_atualizar_contato(uuid, jsonb) to service_role;

-- ===========================================================================
-- Membro (authenticated; confere eh_membro, erro sem_acesso)
-- ===========================================================================

-- Assume a conversa: modo humano, responsavel = eu, sai do aguardando, cancela
-- o que a Nina tinha na fila e a rodada que ainda estava rodando (menos a que a
-- propria Nina passou para humano: a despedida dela ainda vai).
create or replace function public.assumir_conversa(p_conversa uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membro uuid := public.membro_atual();
begin
  update public.conversas c
     set modo = 'humano',
         responsavel_id = v_membro,
         aguardando_humano_desde = null,
         motivo_humano = case when c.modo = 'nina' then 'humano_tela'::public.motivo_humano
                              else c.motivo_humano end,
         responder_apos = null
   where c.id = p_conversa;
  if not found then
    raise exception using message = 'conversa_nao_encontrada', errcode = 'P0001';
  end if;

  update public.mensagens m
     set status = 'cancelada', status_em = now()
   where m.conversa_id = p_conversa and m.origem = 'nina' and m.status = 'na_fila';

  with canceladas as (
    update public.rodadas r
       set status = 'cancelada', terminada_em = now()
     where r.conversa_id = p_conversa and r.status = 'rodando' and not r.passou_humano
    returning r.id
  )
  update public.mensagens m
     set rodada_id = null
    from canceladas k
   where m.rodada_id = k.id and m.direcao = 'entrada';
end;
$$;

revoke execute on function public.assumir_conversa(uuid) from public, anon;
grant execute on function public.assumir_conversa(uuid) to authenticated, service_role;

-- Devolve para a Nina. Se a ultima mensagem do lead ainda nao teve resposta
-- (nenhuma saida valida depois dela), ja arma responder_apos = now(), menos com
-- conexao ativa oficial e a janela de 24 h fechada (a resposta seria recusada).
-- Grava devolvida_em, que zera a contagem de tentativas da rodada.
create or replace function public.devolver_para_nina(p_conversa uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membro uuid := public.membro_atual();
  v_ult_entrada timestamptz;
  v_ult_saida   timestamptz;
  v_janela      boolean;
begin
  select (not exists (select 1 from public.conexoes cx where cx.ativa and cx.oficial))
         or (c.ultima_do_lead_em is not null and c.ultima_do_lead_em + interval '24 hours' > now())
    into v_janela
  from public.conversas c where c.id = p_conversa for update;
  if not found then
    raise exception using message = 'conversa_nao_encontrada', errcode = 'P0001';
  end if;

  select max(m.criado_em) filter (where m.direcao = 'entrada'),
         max(m.criado_em) filter (where m.direcao = 'saida' and m.status not in ('cancelada', 'falhou'))
    into v_ult_entrada, v_ult_saida
  from public.mensagens m
  where m.conversa_id = p_conversa;

  update public.conversas c
     set modo = 'nina',
         motivo_humano = null,
         aguardando_humano_desde = null,
         responsavel_id = null,
         devolvida_em = now(),
         responder_apos = case when v_ult_entrada is not null
                                    and (v_ult_saida is null or v_ult_entrada > v_ult_saida)
                                    and v_janela
                               then now() else null end
   where c.id = p_conversa;
end;
$$;

revoke execute on function public.devolver_para_nina(uuid) from public, anon;
grant execute on function public.devolver_para_nina(uuid) to authenticated, service_role;

create or replace function public.marcar_lida(p_conversa uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membro uuid := public.membro_atual();
begin
  update public.conversas c set nao_lidas = 0 where c.id = p_conversa;
  if not found then
    raise exception using message = 'conversa_nao_encontrada', errcode = 'P0001';
  end if;
end;
$$;

revoke execute on function public.marcar_lida(uuid) from public, anon;
grant execute on function public.marcar_lida(uuid) to authenticated, service_role;

-- 04-dashboard.sql
-- Dashboard da Nina por coorte (spec: decisão 5 e "Membro" em Funções).
-- Depende só do 01-estrutura.sql (tabelas, enums, eh_membro, eh_admin).
--
-- Definições:
-- - coorte = contatos com (primeira_mensagem_em at time zone 'America/Sao_Paulo')::date
--   entre p_inicio e p_fim (inclusivo). Escrito como intervalo de timestamptz
--   [p_inicio 00:00 SP, p_fim + 1 dia 00:00 SP), que é a mesma coisa e usa índice.
-- - funil: etapas não arquivadas, em ordem. "Chegou à etapa X" = o contato da coorte
--   passou por X (histórico ou etapa atual) ou por uma etapa de ordem maior que não
--   seja do tipo perdido.
-- - ganhos / perdidos: contatos da coorte cuja etapa atual é do tipo ganho / perdido.
-- - mediana_primeira_resposta_s: por contato da coorte, segundos entre
--   primeira_mensagem_em e a 1ª mensagem de saída da conversa com status enviada,
--   entregue ou lida, pela hora do ENVIO (mensagens.momento: o concluir_envio grava
--   now() ao passar para enviada; no celular é a hora do WhatsApp). Não usa
--   status_em, que muda a cada entregue/lida e mediria quando o lead leu.
--   percentile_cont(0.5); nula se ninguém foi respondido.
-- - passados_para_humano: contatos da coorte com alguma rodada passou_humano = true.
-- - aguardando_agora: conversas com aguardando_humano_desde não nulo (agora, sem coorte).
-- - custo_usd / chamadas_sem_preco: ia_chamadas pela data (SP) de criado_em no período;
--   nulos para quem não é admin.

-- Índices usados pelo filtro de período: já criados no 01-estrutura.sql
-- (contatos_coorte em contatos(primeira_mensagem_em) e ia_chamadas_criado em ia_chamadas(criado_em)).

create or replace function public.dashboard(p_inicio date, p_fim date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin boolean;
  v_de timestamptz;
  v_ate timestamptz;
  v_custo numeric;
  v_sem_preco bigint;
  v_res jsonb;
begin
  if not coalesce(public.eh_membro(), false) then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;

  v_admin := coalesce(public.eh_admin(), false);

  -- Meia-noite de São Paulo do primeiro dia e do dia seguinte ao último.
  v_de  := p_inicio::timestamp at time zone 'America/Sao_Paulo';
  v_ate := (p_fim + 1)::timestamp at time zone 'America/Sao_Paulo';

  with coorte as (
    select c.id, c.etapa_id, c.primeira_mensagem_em
    from public.contatos c
    where c.primeira_mensagem_em >= v_de
      and c.primeira_mensagem_em <  v_ate
  ),
  -- Etapas por onde cada contato da coorte passou: destino e origem do histórico
  -- e a etapa atual (a atual entra para não depender só do histórico).
  passagens as (
    select h.contato_id, h.para_etapa_id as etapa_id
    from public.contato_etapa_historico h
    join coorte k on k.id = h.contato_id
    where h.para_etapa_id is not null
    union
    select h.contato_id, h.de_etapa_id
    from public.contato_etapa_historico h
    join coorte k on k.id = h.contato_id
    where h.de_etapa_id is not null
    union
    select k.id, k.etapa_id
    from coorte k
    where k.etapa_id is not null
  ),
  resumo as (
    select p.contato_id,
           max(e.ordem) filter (where e.tipo <> 'perdido') as max_ordem_nao_perdida,
           array_agg(p.etapa_id) as etapas
    from passagens p
    join public.etapas e on e.id = p.etapa_id
    group by p.contato_id
  ),
  funil as (
    select e.id, e.nome, e.ordem, e.tipo,
           count(r.contato_id) as chegaram
    from public.etapas e
    left join resumo r
      on r.max_ordem_nao_perdida > e.ordem
      or e.id = any (r.etapas)
    where not e.arquivada
    group by e.id, e.nome, e.ordem, e.tipo
  ),
  primeiras_respostas as (
    select k.id,
           extract(epoch from (min(m.momento) - k.primeira_mensagem_em)) as segundos
    from coorte k
    join public.conversas cv on cv.contato_id = k.id
    join public.mensagens m on m.conversa_id = cv.id
    where m.direcao = 'saida'
      and m.status in ('enviada', 'entregue', 'lida')
      and m.momento >= k.primeira_mensagem_em
    group by k.id, k.primeira_mensagem_em
  )
  select jsonb_build_object(
    'leads_novos', (select count(*) from coorte),
    'funil', coalesce(
      (select jsonb_agg(
                jsonb_build_object(
                  'etapa_id', f.id,
                  'nome', f.nome,
                  'ordem', f.ordem,
                  'tipo', f.tipo,
                  'chegaram', f.chegaram
                )
                order by f.ordem, f.nome, f.id
              )
       from funil f),
      '[]'::jsonb),
    'ganhos', (select count(*)
               from coorte k
               join public.etapas e on e.id = k.etapa_id
               where e.tipo = 'ganho'),
    'perdidos', (select count(*)
                 from coorte k
                 join public.etapas e on e.id = k.etapa_id
                 where e.tipo = 'perdido'),
    'mediana_primeira_resposta_s', (select (percentile_cont(0.5) within group (order by pr.segundos))::numeric
                                    from primeiras_respostas pr),
    'passados_para_humano', (select count(*)
                             from coorte k
                             where exists (
                               select 1
                               from public.conversas cv
                               join public.rodadas r on r.conversa_id = cv.id
                               where cv.contato_id = k.id
                                 and r.passou_humano
                             )),
    'aguardando_agora', (select count(*)
                         from public.conversas cv
                         where cv.aguardando_humano_desde is not null)
  )
  into v_res;

  if v_admin then
    select coalesce(sum(ch.custo_usd), 0),
           count(*) filter (where ch.custo_origem = 'sem_preco')
    into v_custo, v_sem_preco
    from public.ia_chamadas ch
    where ch.criado_em >= v_de
      and ch.criado_em <  v_ate;

    v_res := v_res || jsonb_build_object('custo_usd', v_custo, 'chamadas_sem_preco', v_sem_preco);
  else
    v_res := v_res || jsonb_build_object('custo_usd', null, 'chamadas_sem_preco', null);
  end if;

  return v_res;
end;
$$;

revoke execute on function public.dashboard(date, date) from public, anon;
grant execute on function public.dashboard(date, date) to authenticated, service_role;