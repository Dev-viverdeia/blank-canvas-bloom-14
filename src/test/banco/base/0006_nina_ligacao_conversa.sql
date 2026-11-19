-- =====================================================================
-- Ligar as telas ao banco, envio 3 (parte 1): funções e gatilhos da conversa.
-- Contrato: seção 2.3 ("Recriadas, em
-- 30-conversa.sql" e "Novas, também em 30-conversa.sql") e decisões 3, 4 e 8.
-- Depende dos envios 1 e 2 (conversa_evento_tipo, conversa_eventos e as colunas
-- novas de mensagens, conversas, contatos e rodadas). Sem BEGIN/COMMIT.
--
-- As funções recriadas mantêm a assinatura, o retorno e o corpo da migration de
-- origem (0000 para o gatilho, 0002 para as outras); só o que está marcado com
-- "novo:" é acréscimo. Os grants são repetidos iguais aos da origem.
--
-- conversa_eventos.de (de onde a conversa veio quando alguém assumiu), na mesma
-- regra do selo da tela (exemplo/regras.ts, seloDaConversa):
--   nina    = modo nina;
--   outro   = modo humano com responsável (de_membro_id = quem estava);
--   celular = modo humano, sem responsável e fora da espera;
--   espera  = modo humano, sem responsável e esperando a equipe.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Gatilho: mensagem nova (depois). Recriado (0000).
-- novo: ultima_mensagem_id junto com a prévia; eventos "assumiu" (por envio) e
-- "celular"; decisão 4 (o lead que escreve numa conversa humana sem responsável
-- e fora da espera entra na espera).
-- ---------------------------------------------------------------------
create or replace function public.tg_mensagens_apos_inserir()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conv public.conversas%rowtype;
  v_espera integer;
  v_teto integer;
  v_primeira timestamptz;
  v_de text;
  v_canceladas integer;
begin
  select * into v_conv from public.conversas c where c.id = new.conversa_id for update;
  if not found then
    return null;
  end if;

  -- Prévia: só a mensagem mais recente (pelo momento) e não cancelada.
  if new.status <> 'cancelada'
     and (v_conv.ultima_mensagem_em is null or new.momento >= v_conv.ultima_mensagem_em) then
    v_conv.ultima_mensagem_em := new.momento;
    v_conv.ultima_mensagem_id := new.id; -- novo
    v_conv.ultima_mensagem_preview := left(
      coalesce(nullif(btrim(new.texto), ''), '[' || new.tipo::text || ']'), 140);
  end if;

  if new.direcao = 'entrada' then
    v_conv.nao_lidas := v_conv.nao_lidas + 1;
    v_conv.ultima_do_lead_em := greatest(v_conv.ultima_do_lead_em, new.momento);
    if v_conv.modo = 'nina' then
      select cf.espera_lote_s, cf.espera_lote_max_s into v_espera, v_teto
      from public.configuracao cf where cf.id = 1;
      -- 1ª pendente do lote. Sem nada armado, o lote começa nesta mensagem. Senão,
      -- conta só as entradas soltas que chegaram depois da última rodada: as que
      -- ficaram soltas no modo humano ou numa rodada que falhou ou foi cancelada
      -- não podem puxar o teto para o passado. Um armado vencido há mais que o teto
      -- (a conversa esperou armada sem conexão ativa ou com a janela oficial
      -- fechada) conta como nada armado: o lote recomeça nesta mensagem.
      if v_conv.responder_apos is not null
         and v_conv.responder_apos < now() - make_interval(secs => coalesce(v_teto, 60)) then
        v_conv.responder_apos := null;
      end if;
      if v_conv.responder_apos is null then
        v_primeira := now();
      else
        select min(m.criado_em) into v_primeira
        from public.mensagens m
        where m.conversa_id = new.conversa_id and m.direcao = 'entrada' and m.rodada_id is null
          and m.criado_em > coalesce((select max(r.iniciada_em) from public.rodadas r
                                      where r.conversa_id = new.conversa_id), '-infinity'::timestamptz);
      end if;
      -- 8 s que recomeçam a cada mensagem, com teto de 60 s desde a 1ª pendente.
      -- Um re-armado que já está mais adiante (falha passageira: +30 s) é mantido.
      v_conv.responder_apos := greatest(
        coalesce(v_conv.responder_apos, '-infinity'::timestamptz),
        least(
          now() + make_interval(secs => coalesce(v_espera, 8)),
          coalesce(v_primeira, now()) + make_interval(secs => coalesce(v_teto, 60))
        )
      );
    elsif v_conv.responsavel_id is null and v_conv.aguardando_humano_desde is null then
      -- novo (decisão 4): conversa humana sem ninguém (atendida pelo celular): o lead
      -- que escreve entra em "Precisam de você".
      v_conv.aguardando_humano_desde := now();
    end if;
  elsif new.origem in ('humano_tela', 'humano_celular') then
    -- novo: de onde a conversa vem, antes de mudar.
    v_de := case when v_conv.modo = 'nina' then 'nina'
                 when v_conv.responsavel_id is not null then 'outro'
                 when v_conv.aguardando_humano_desde is null then 'celular'
                 else 'espera' end;
    if new.origem = 'humano_tela' and v_de <> 'outro' then
      -- Mandar pela tela tira a conversa da Nina, da espera ou do celular (com outra
      -- pessoa, o responsável continua quem estava: não é assumir).
      insert into public.conversa_eventos (conversa_id, tipo, membro_id, de, por_envio)
      values (new.conversa_id, 'assumiu', new.autor_membro_id, v_de, true);
    elsif new.origem = 'humano_celular' and v_de in ('nina', 'espera') then
      -- O celular tirou a conversa da Nina ou da espera (já no celular ou com uma
      -- pessoa, não muda de mãos: sem evento).
      insert into public.conversa_eventos (conversa_id, tipo, de)
      values (new.conversa_id, 'celular', v_de);
    end if;

    if new.origem = 'humano_tela' and v_conv.responsavel_id is null
       and new.autor_membro_id is not null then
      -- novo: a conversa vai para quem mandou. Espera o desativar_membro que
      -- estiver rodando (for update no membro) e confere de novo que a pessoa
      -- continua ativa; senão ela ficaria com uma conversa depois de desativada.
      perform 1 from public.membros mb
       where mb.id = new.autor_membro_id and mb.ativo
         for share;
      if not found then
        raise exception using message = 'sem_acesso', errcode = 'P0001';
      end if;
    end if;
    if v_conv.modo = 'nina' then
      v_conv.motivo_humano := new.origem::text::public.motivo_humano;
    end if;
    v_conv.modo := 'humano';
    v_conv.responsavel_id := coalesce(v_conv.responsavel_id, new.autor_membro_id);
    v_conv.aguardando_humano_desde := null;
    v_conv.responder_apos := null;
    update public.mensagens m
    set status = 'cancelada', status_em = now()
    where m.conversa_id = new.conversa_id and m.origem = 'nina' and m.status = 'na_fila';
    get diagnostics v_canceladas = row_count;
    if v_canceladas > 0 then
      -- novo: o gatilho mensagens_apos_atualizar pode ter refeito a prévia sem as
      -- canceladas (só quando a cancelada era a última); vale a da tabela. Quando
      -- a última era outra, a tabela ainda tem a prévia de antes desta mensagem:
      -- a regra da mensagem nova vale de novo por cima.
      select c.ultima_mensagem_em, c.ultima_mensagem_id, c.ultima_mensagem_preview
        into v_conv.ultima_mensagem_em, v_conv.ultima_mensagem_id, v_conv.ultima_mensagem_preview
        from public.conversas c where c.id = new.conversa_id;
      if new.status <> 'cancelada'
         and (v_conv.ultima_mensagem_em is null or new.momento >= v_conv.ultima_mensagem_em) then
        v_conv.ultima_mensagem_em := new.momento;
        v_conv.ultima_mensagem_id := new.id;
        v_conv.ultima_mensagem_preview := left(
          coalesce(nullif(btrim(new.texto), ''), '[' || new.tipo::text || ']'), 140);
      end if;
    end if;
    -- A rodada que ainda está rodando foi atropelada pelo humano: fica 'cancelada'
    -- (o concluir_rodada grava as respostas dela como canceladas) e solta as entradas.
    with canceladas as (
      update public.rodadas r
         set status = 'cancelada', terminada_em = now()
       where r.conversa_id = new.conversa_id and r.status = 'rodando'
      returning r.id
    )
    update public.mensagens m
       set rodada_id = null
      from canceladas k
     where m.rodada_id = k.id and m.direcao = 'entrada';
  end if;

  update public.conversas c
  set ultima_mensagem_em = v_conv.ultima_mensagem_em,
      ultima_mensagem_id = v_conv.ultima_mensagem_id,
      ultima_mensagem_preview = v_conv.ultima_mensagem_preview,
      nao_lidas = v_conv.nao_lidas,
      ultima_do_lead_em = v_conv.ultima_do_lead_em,
      responder_apos = v_conv.responder_apos,
      modo = v_conv.modo,
      motivo_humano = v_conv.motivo_humano,
      responsavel_id = v_conv.responsavel_id,
      aguardando_humano_desde = v_conv.aguardando_humano_desde
  where c.id = new.conversa_id;
  return null;
end;
$$;

revoke execute on function public.tg_mensagens_apos_inserir() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Gatilho novo: mensagem alterada (depois), só quando muda status ou apagada_em.
-- - Prévia: quando a mensagem deixa de valer (vira cancelada ou é apagada) e era
--   a última, ou volta a valer e pode ser a última, refaz ultima_mensagem_id, a
--   prévia e ultima_mensagem_em pela mais recente que vale (mesma regra e mesmo
--   texto do insert). Conversa ainda sem ultima_mensagem_id (de antes deste
--   pacote, ou cuja última foi apagada de vez) também é refeita.
-- - ultima_da_nina_em: a hora (momento) em que uma resposta da Nina saiu
--   (passou a enviada, entregue ou lida).
-- ---------------------------------------------------------------------
create or replace function public.tg_mensagens_apos_atualizar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_valia boolean := old.status <> 'cancelada' and old.apagada_em is null;
  v_vale boolean := new.status <> 'cancelada' and new.apagada_em is null;
  v_ult uuid;
  v_ult_em timestamptz;
  v_refaz boolean;
  v_m record;
begin
  if new.origem = 'nina'
     and new.status in ('enviada', 'entregue', 'lida')
     and old.status not in ('enviada', 'entregue', 'lida') then
    update public.conversas c
       set ultima_da_nina_em = greatest(c.ultima_da_nina_em, new.momento)
     where c.id = new.conversa_id
       and (c.ultima_da_nina_em is null or c.ultima_da_nina_em < new.momento);
  end if;

  select c.ultima_mensagem_id, c.ultima_mensagem_em into v_ult, v_ult_em
    from public.conversas c where c.id = new.conversa_id;
  if not found then
    return null;
  end if;

  v_refaz := case
    when v_valia and not v_vale then v_ult is null or v_ult = new.id
    when v_vale and not v_valia then v_ult is null or v_ult_em is null or new.momento >= v_ult_em
    else v_ult is null and v_ult_em is not null
  end;
  if not v_refaz then
    return null;
  end if;

  -- Vai refazer: trava a conversa (como o gatilho de inserir) e confere de novo.
  -- Uma mensagem nova que entrou enquanto isso (o lead apagou e mandou outra) já
  -- aparece aqui, e a escolha abaixo não grava a anterior por cima dela. Só trava
  -- quando vai refazer: a troca de status comum (pegar_envios, atualizar_status)
  -- continua sem trava na conversa.
  perform 1 from public.conversas c where c.id = new.conversa_id for update;
  select c.ultima_mensagem_id, c.ultima_mensagem_em into v_ult, v_ult_em
    from public.conversas c where c.id = new.conversa_id;
  if not found then
    return null;
  end if;
  v_refaz := case
    when v_valia and not v_vale then v_ult is null or v_ult = new.id
    when v_vale and not v_valia then v_ult is null or v_ult_em is null or new.momento >= v_ult_em
    else v_ult is null and v_ult_em is not null
  end;
  if not v_refaz then
    return null;
  end if;

  select m.id, m.momento,
         left(coalesce(nullif(btrim(m.texto), ''), '[' || m.tipo::text || ']'), 140) as previa
    into v_m
    from public.mensagens m
   where m.conversa_id = new.conversa_id
     and m.status <> 'cancelada'
     and m.apagada_em is null
   order by m.momento desc, m.criado_em desc, m.ordem desc nulls last, m.id desc
   limit 1;

  if found then
    update public.conversas c
       set ultima_mensagem_id = v_m.id,
           ultima_mensagem_em = v_m.momento,
           ultima_mensagem_preview = v_m.previa
     where c.id = new.conversa_id;
  else
    -- nenhuma vale: sem prévia (a hora da última atividade fica)
    update public.conversas c
       set ultima_mensagem_id = null,
           ultima_mensagem_preview = null
     where c.id = new.conversa_id
       and (c.ultima_mensagem_id is not null or c.ultima_mensagem_preview is not null);
  end if;
  return null;
end;
$$;

create or replace trigger mensagens_apos_atualizar
  after update of status, apagada_em on public.mensagens
  for each row
  when (old.status is distinct from new.status or old.apagada_em is distinct from new.apagada_em)
  execute function public.tg_mensagens_apos_atualizar();

revoke execute on function public.tg_mensagens_apos_atualizar() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Entrada (recriadas, 0002). novo: p_msg.responde_a_id_externo vira
-- responde_a_id, achando a mensagem citada pelo id_externo na mesma conexão;
-- quando não acha, fica nulo. Só na mensagem nova (reentrega, edição e
-- apagamento não mexem na citação).
-- ---------------------------------------------------------------------
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
  v_cita    text := nullif(btrim(coalesce(p_msg ->> 'responde_a_id_externo', '')), '');
  v_resp    uuid;
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

    -- novo: a citação, pela mesma conexão
    if v_cita is not null then
      select m.id into v_resp
      from public.mensagens m
      where m.conexao_id = p_conexao and m.id_externo = v_cita;
    end if;

    insert into public.mensagens (
      conversa_id, conexao_id, direcao, origem, tipo, texto, status,
      midia_ref_externa, midia_mime, midia_nome, midia_tamanho, midia_status,
      id_externo, id_gateway, momento, evento_id, editada, responde_a_id)
    values (
      v_conv, p_conexao, 'entrada', 'lead', public.tipo_de_mensagem(p_msg ->> 'tipo'),
      p_msg ->> 'texto', 'recebida',
      v_ref, p_msg ->> 'midia_mime', p_msg ->> 'midia_nome',
      (nullif(p_msg ->> 'midia_tamanho', ''))::bigint,
      case when v_ref is not null then 'pendente'::public.midia_status end,
      v_id_ext, nullif(p_msg ->> 'id_gateway', ''), v_momento,
      (nullif(p_msg ->> 'evento_id', ''))::bigint,
      -- edicao que chega antes da original ja entra marcada como editada
      coalesce((p_msg ->> 'editada')::boolean, false),
      v_resp)
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
  v_cita    text := nullif(btrim(coalesce(p_msg ->> 'responde_a_id_externo', '')), '');
  v_resp    uuid;
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

  -- novo: a citação, pela mesma conexão
  if v_cita is not null then
    select m.id into v_resp
    from public.mensagens m
    where m.conexao_id = p_conexao and m.id_externo = v_cita;
  end if;

  insert into public.mensagens (
    conversa_id, conexao_id, direcao, origem, tipo, texto, status, status_em,
    midia_ref_externa, midia_mime, midia_nome, midia_tamanho, midia_status,
    id_externo, id_gateway, momento, evento_id, responde_a_id)
  values (
    v_conv, p_conexao, 'saida', 'humano_celular', v_tipo,
    p_msg ->> 'texto', 'enviada', v_momento,
    v_ref, p_msg ->> 'midia_mime', p_msg ->> 'midia_nome',
    (nullif(p_msg ->> 'midia_tamanho', ''))::bigint,
    case when v_ref is not null then 'pendente'::public.midia_status end,
    v_id_ext, v_gw, v_momento,
    (nullif(p_msg ->> 'evento_id', ''))::bigint,
    v_resp)
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

-- ---------------------------------------------------------------------
-- Rodadas (recriadas, 0002).
-- ---------------------------------------------------------------------

-- novo: no ramo que vai para a equipe, a rodada fica com foi_para_equipe e a
-- conversa ganha o evento "passou" com o motivo.
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

    -- novo
    update public.rodadas r set foi_para_equipe = true where r.id = p_rodada;
    insert into public.conversa_eventos (conversa_id, tipo, motivo)
    values (v_r.conversa_id, 'passou', p_motivo);
  end if;
end;
$$;

revoke execute on function public.falhar_rodada(uuid, public.motivo_humano, boolean) from public, anon, authenticated;
grant execute on function public.falhar_rodada(uuid, public.motivo_humano, boolean) to service_role;

-- novo (decisão 2): enquanto o onboarding não foi concluído, a Nina não atende
-- (devolve vazio; as mensagens que chegam ficam armadas e são respondidas depois).
-- A limpeza das rodadas presas roda antes, como sempre.
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

  -- novo
  if not exists (select 1 from public.configuracao cf
                 where cf.id = 1 and cf.onboarding_concluido_em is not null) then
    return;
  end if;

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

-- ---------------------------------------------------------------------
-- Ferramentas da Nina (recriadas, 0002; só com a rodada rodando).
-- ---------------------------------------------------------------------

-- novo (decisão 3): etapa_travada quando o lead está em Ganho ou Perdido, ou
-- quando o último movimento dele foi de uma pessoa e a conversa não foi devolvida
-- para a Nina depois disso. Mover para a etapa em que ele já está não faz nada
-- (nem dá erro). O motivo do movimento fica na entrada da ferramenta, em
-- rodadas.ferramentas (spec, premissas).
create or replace function public.nina_mover_etapa(p_rodada uuid, p_etapa uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.rodadas := public.rodada_rodando(p_rodada);
  v_contato uuid;
  v_devolvida timestamptz;
  v_atual uuid;
  v_tipo public.etapa_tipo;
  v_ator public.historico_ator;
  v_movido_em timestamptz;
begin
  if not exists (select 1 from public.etapas e
                 where e.id = p_etapa and e.nina_pode_mover and not e.arquivada) then
    raise exception using message = 'etapa_nao_permitida', errcode = 'P0001';
  end if;

  select c.contato_id, c.devolvida_em into v_contato, v_devolvida
  from public.conversas c where c.id = v_r.conversa_id;

  -- novo: as travas da decisão 3 (o contato fica travado até o fim, contra um
  -- movimento de pessoa ao mesmo tempo)
  select ct.etapa_id, e.tipo into v_atual, v_tipo
  from public.contatos ct
  join public.etapas e on e.id = ct.etapa_id
  where ct.id = v_contato
  for update of ct;

  if v_atual is not distinct from p_etapa then
    return;
  end if;
  if v_tipo in ('ganho', 'perdido') then
    raise exception using message = 'etapa_travada', errcode = 'P0001';
  end if;

  select h.ator, h.criado_em into v_ator, v_movido_em
  from public.contato_etapa_historico h
  where h.contato_id = v_contato
  order by h.criado_em desc, h.id desc
  limit 1;
  if v_ator = 'membro' and (v_devolvida is null or v_devolvida <= v_movido_em) then
    raise exception using message = 'etapa_travada', errcode = 'P0001';
  end if;

  -- o gatilho de historico le esta marca e grava ator = nina
  perform set_config('nina.rodada_id', p_rodada::text, true);

  update public.contatos c
     set etapa_id = p_etapa, etapa_desde = now(), atualizado_em = now()
   where c.id = v_contato and c.etapa_id is distinct from p_etapa;
end;
$$;

revoke execute on function public.nina_mover_etapa(uuid, uuid) from public, anon, authenticated;
grant execute on function public.nina_mover_etapa(uuid, uuid) to service_role;

-- novo: quando a conversa passa de fato (estava com a Nina), a rodada fica com
-- foi_para_equipe e a conversa ganha o evento "passou" (nina_passou).
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

  -- novo
  if found then
    update public.rodadas r set foi_para_equipe = true where r.id = p_rodada;
    insert into public.conversa_eventos (conversa_id, tipo, motivo)
    values (v_r.conversa_id, 'passou', 'nina_passou');
  end if;
end;
$$;

revoke execute on function public.nina_passar_para_humano(uuid) from public, anon, authenticated;
grant execute on function public.nina_passar_para_humano(uuid) to service_role;

-- Chaves aceitas: nome, email, empresa, resumo_nina, fatos e proximo_passo.
-- Qualquer outra chave, ou fatos e proximo_passo fora do formato: campo_nao_permitido.
-- novo (decisão 3):
-- - nome, email e empresa só entram quando estão vazios (nulo ou só espaço) e o
--   valor novo não é vazio; preenchidos são ignorados, sem erro;
-- - resumo_nina sempre, com resumo_nina_em = agora;
-- - fatos ([{rotulo, valor, mensagem_id?}], textos) e proximo_passo ({titulo,
--   texto} ou null) vão para anotacoes_nina, cada chave substituindo a anterior.
create or replace function public.nina_atualizar_contato(p_rodada uuid, p_campos jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.rodadas := public.rodada_rodando(p_rodada);
  v_contato uuid;
  v_fatos jsonb;
  v_passo jsonb;
  v_anot jsonb := '{}'::jsonb;
begin
  if jsonb_typeof(p_campos) is distinct from 'object'
     or exists (select 1 from jsonb_object_keys(p_campos) k
                where k not in ('nome', 'email', 'empresa', 'resumo_nina', 'fatos', 'proximo_passo')) then
    raise exception using message = 'campo_nao_permitido', errcode = 'P0001';
  end if;
  if p_campos = '{}'::jsonb then
    return;
  end if;

  -- novo: formato das anotações
  if p_campos ? 'fatos' then
    v_fatos := p_campos -> 'fatos';
    if jsonb_typeof(v_fatos) <> 'array'
       or exists (select 1 from jsonb_array_elements(v_fatos) f
                  where jsonb_typeof(f) <> 'object'
                     or jsonb_typeof(f -> 'rotulo') is distinct from 'string'
                     or jsonb_typeof(f -> 'valor') is distinct from 'string'
                     or (f ? 'mensagem_id' and jsonb_typeof(f -> 'mensagem_id') not in ('string', 'null'))) then
      raise exception using message = 'campo_nao_permitido', errcode = 'P0001';
    end if;
    v_anot := v_anot || jsonb_build_object('fatos', v_fatos);
  end if;
  if p_campos ? 'proximo_passo' then
    v_passo := p_campos -> 'proximo_passo';
    if jsonb_typeof(v_passo) <> 'null'
       and (jsonb_typeof(v_passo) <> 'object'
            or jsonb_typeof(v_passo -> 'titulo') is distinct from 'string'
            or jsonb_typeof(v_passo -> 'texto') is distinct from 'string') then
      raise exception using message = 'campo_nao_permitido', errcode = 'P0001';
    end if;
    v_anot := v_anot || jsonb_build_object('proximo_passo', v_passo);
  end if;

  select c.contato_id into v_contato from public.conversas c where c.id = v_r.conversa_id;

  update public.contatos c
     set nome        = case when p_campos ? 'nome'
                                 and nullif(btrim(coalesce(c.nome, '')), '') is null
                                 and nullif(btrim(coalesce(p_campos ->> 'nome', '')), '') is not null
                            then p_campos ->> 'nome' else c.nome end,
         email       = case when p_campos ? 'email'
                                 and nullif(btrim(coalesce(c.email, '')), '') is null
                                 and nullif(btrim(coalesce(p_campos ->> 'email', '')), '') is not null
                            then p_campos ->> 'email' else c.email end,
         empresa     = case when p_campos ? 'empresa'
                                 and nullif(btrim(coalesce(c.empresa, '')), '') is null
                                 and nullif(btrim(coalesce(p_campos ->> 'empresa', '')), '') is not null
                            then p_campos ->> 'empresa' else c.empresa end,
         resumo_nina = case when p_campos ? 'resumo_nina' then p_campos ->> 'resumo_nina' else c.resumo_nina end,
         resumo_nina_em = case when p_campos ? 'resumo_nina' then now() else c.resumo_nina_em end,
         anotacoes_nina = case when v_anot <> '{}'::jsonb
                               then coalesce(c.anotacoes_nina, '{}'::jsonb) || v_anot
                               else c.anotacoes_nina end,
         atualizado_em = now()
   where c.id = v_contato;
end;
$$;

revoke execute on function public.nina_atualizar_contato(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.nina_atualizar_contato(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------
-- Envio (recriada, 0002). Corpo igual ao da 0002.
-- novo: quando apaga a duplicata do eco (humano_celular que era o nosso próprio
-- envio), apaga também o evento "celular" que o gatilho gravou na entrada dela
-- (mesma conversa, mesma transação: criado_em igual ao dela). A conversa não
-- foi respondida pelo celular.
-- ---------------------------------------------------------------------
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
          -- novo: o evento "celular" da duplicata não aconteceu
          delete from public.conversa_eventos e
           where e.conversa_id = v_m.conversa_id
             and e.tipo = 'celular'
             and e.criado_em = v_dup.criado_em;

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

-- ---------------------------------------------------------------------
-- Membro (recriadas, 0002; authenticated; confere eh_membro, erro sem_acesso).
-- ---------------------------------------------------------------------

-- novo: grava o evento "assumiu" (pelo botão: por_envio = false), com o "de" e,
-- vindo de outra pessoa, de_membro_id. Assumir a própria conversa de novo não
-- grava evento.
create or replace function public.assumir_conversa(p_conversa uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membro uuid := public.membro_atual();
  v_antes public.conversas;
  v_de text;
begin
  -- novo: espera o desativar_membro que estiver rodando (for update no membro) e
  -- confere de novo que a pessoa continua ativa. Sem isso, quem é desativado
  -- enquanto clica em Assumir fica com a conversa (decisão 4). Ordem das travas
  -- igual à do desativar_membro: membro, depois conversa.
  perform 1 from public.membros mb where mb.id = v_membro and mb.ativo for share;
  if not found then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;

  -- novo: o estado de antes (travado), para o evento
  select * into v_antes from public.conversas c where c.id = p_conversa for update;
  if not found then
    raise exception using message = 'conversa_nao_encontrada', errcode = 'P0001';
  end if;

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

  -- novo
  if v_antes.modo = 'nina' or v_antes.responsavel_id is distinct from v_membro then
    v_de := case when v_antes.modo = 'nina' then 'nina'
                 when v_antes.responsavel_id is not null then 'outro'
                 when v_antes.aguardando_humano_desde is null then 'celular'
                 else 'espera' end;
    insert into public.conversa_eventos (conversa_id, tipo, membro_id, de, de_membro_id, por_envio)
    values (p_conversa, 'assumiu', v_membro, v_de,
            case when v_de = 'outro' then v_antes.responsavel_id end, false);
  end if;
end;
$$;

revoke execute on function public.assumir_conversa(uuid) from public, anon;
grant execute on function public.assumir_conversa(uuid) to authenticated, service_role;

-- novo: grava o evento "devolveu" (membro_id = quem devolveu) quando a conversa
-- estava com a equipe. Devolver o que já está com a Nina não grava evento.
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
  v_modo        public.conversa_modo;
begin
  select (not exists (select 1 from public.conexoes cx where cx.ativa and cx.oficial))
         or (c.ultima_do_lead_em is not null and c.ultima_do_lead_em + interval '24 hours' > now()),
         c.modo
    into v_janela, v_modo
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

  -- novo
  if v_modo = 'humano' then
    insert into public.conversa_eventos (conversa_id, tipo, membro_id)
    values (p_conversa, 'devolveu', v_membro);
  end if;
end;
$$;

revoke execute on function public.devolver_para_nina(uuid) from public, anon;
grant execute on function public.devolver_para_nina(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Nova: "Tentar de novo" (decisão 8). Membro (admin ou atendente).
-- Só a mensagem da equipe pela tela (saida, humano_tela) com status falhou.
-- nao_reenviavel também quando o envio pode ter chegado ao lead:
--   - o gateway devolveu um id (id_externo ou id_gateway): ele aceitou;
--   - sem_resposta_do_envio (pegar_envios: ficou enviando 2 min sem resposta);
--   - tempo_esgotado e falha_de_rede (ciclo.server.ts: o pedido pode ter chegado);
--   - 5xx do gateway (http_5xx, http:5xx, meta_5xx, zernio_http_5xx).
-- Exceção: falha_no_gateway (atualizar_status: o gateway avisou que não entregou)
-- pode sair de novo, mesmo com id, e os ids são limpos.
-- Recusa também sem conexão ativa (sem_conexao_ativa) e com a janela de 24 h
-- fechada na conexão oficial (janela_fechada), como o insert da tela.
-- A mensagem volta para na_fila na conexão ativa, com erro nulo, tentativas 0 e
-- enviar_apos = agora; o autor continua quem escreveu.
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
         id_gateway = null
   where m.id = p_msg;
end;
$$;

revoke execute on function public.reenviar_mensagem(uuid) from public, anon;
grant execute on function public.reenviar_mensagem(uuid) to authenticated, service_role;