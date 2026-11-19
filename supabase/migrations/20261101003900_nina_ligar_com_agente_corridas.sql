-- nina_ligar_com_agente_corridas (17/11/2026): as corridas da ligação com o agente escolhido
-- (revisão do Sol 6.1 no PR #26, rodada 2).
-- - ligacao_iniciar_saida(uuid, uuid, timestamptz, text) (recriada, texto da base 0038): o agente
--   escolhido é travado para leitura e precisa estar na ElevenLabs ('agente_indisponivel'); as
--   simultâneas da conta contam as em andamento dos últimos 32 min (o teto mais longo), não pelo
--   teto editável do agente.
-- - ligacao_iniciar(..., p_conferir_conta boolean) (nova, a partir do texto da base 0035): com
--   p_conferir_conta, a entrada também respeita os limites da conta (simultâneas e por dia, as duas
--   direções, todos os agentes), sob a mesma trava da saída. Só o início da ligação confere; o
--   pós-chamada continua na versão de 7 argumentos, que fica sem mudança.
-- - ligacao_agente_soltar(uuid) (nova): o apagar do agente solta o id dele na mesma transação que
--   confere que ele não atende e não tem ligação em andamento; a reserva da saída espera ou recusa.
--   Devolve o motivo ('nao_encontrado', 'atende', 'em_ligacao') ou o id_externo que saiu.
-- Depende de: nina_ligar_com_agente_limites (0038). Ordem: sozinho. Nada é semeado: a
-- preparar_copia() não muda. Pode rodar duas vezes. Sem BEGIN/COMMIT.

-- ---------------------------------------------------------------------
-- Trava: sem a versão de 4 argumentos da saída, este envio para aqui.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.ligacao_iniciar_saida(uuid, uuid, timestamptz, text)') is null then
    raise exception using message = 'falta_a_funcao_ligacao_iniciar_saida_4',
      hint = 'Aplique antes o nina_ligar_com_agente_limites (base 0038).';
  end if;
end;
$$;

create or replace function public.ligacao_iniciar_saida(
  p_conversa uuid,
  p_agente uuid,
  p_momento timestamptz,
  p_objetivo text)
returns table (ligacao_id uuid, id_externo text, permitida boolean, motivo text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_conv    public.conversas%rowtype;
  v_conexao uuid;
  v_limite  integer;
  v_qtd     integer;
  v_lig     uuid := gen_random_uuid();
  v_ext     text;
  v_msg     uuid;
  v_obj     text := nullif(btrim(coalesce(p_objetivo, '')), '');
  v_simult  integer;
  v_dia     integer;
begin
  if p_conversa is null or p_momento is null then
    raise exception using message = 'ligacao_invalida', errcode = 'P0001';
  end if;
  if v_obj is not null and char_length(v_obj) > 500 then
    raise exception using message = 'objetivo_invalido', errcode = 'P0001';
  end if;

  -- a conexão ativa da Meta com as ligações ativas, travada para leitura até o fim desta transação:
  -- uma desativação (ou outra ativação) que grava na conexão espera, e a que já gravou é vista
  select cx.id into v_conexao
    from public.conexoes cx
   where cx.ativa and cx.gateway = 'meta'
   limit 1
     for share;
  if v_conexao is null then
    return query select null::uuid, null::text, false, 'sem_conexao'::text;
    return;
  end if;
  if not exists (select 1 from public.conexoes cx
                  where cx.id = v_conexao
                    and cx.parametros -> 'ligacoes' ->> 'situacao' = 'ativa') then
    return query select null::uuid, null::text, false, 'sem_ligacoes'::text;
    return;
  end if;

  select c.* into v_conv from public.conversas c where c.id = p_conversa;
  if not found then
    return query select null::uuid, null::text, false, 'conversa_nao_encontrada'::text;
    return;
  end if;

  -- o agente escolhido, travado para leitura até o fim desta transação, e com o agente na
  -- ElevenLabs: o apagar (ligacao_agente_soltar) espera esta reserva, ou já soltou o agente e ela
  -- recusa (Sol, PR #26). Nulo = a primeira versão das ligações, sem linha
  if p_agente is not null then
    perform 1 from public.ligacao_agentes a
     where a.id = p_agente and a.id_externo is not null
       for share;
    if not found then
      return query select null::uuid, null::text, false, 'agente_indisponivel'::text;
      return;
    end if;
  end if;

  -- uma ligação por vez por contato até o fim desta transação (a mesma trava da entrada)
  perform pg_advisory_xact_lock(hashtextextended('nina_ligacao_contato:' || v_conv.contato_id::text, 0));

  if exists (select 1 from public.ligacoes l
              where l.conversa_id = p_conversa and l.status = 'em_andamento'
                and public.ligacao_teto(l.iniciada_em, l.agente_id) > now()) then
    return query select null::uuid, null::text, false, 'ligacao_em_andamento'::text;
    return;
  end if;

  -- os limites da conta valem para todos os agentes juntos (cada agente na ElevenLabs só conta as
  -- dele): uma saída registrada por vez na conta, até o fim desta transação
  perform pg_advisory_xact_lock(hashtextextended('nina_ligacao_conta', 0));
  select cf.ligacoes_simultaneas, cf.ligacoes_por_dia into v_simult, v_dia
    from public.configuracao cf where cf.id = 1;
  -- em andamento dentro do teto mais longo (30 min + 2): a duração do agente é editável, e a que
  -- ficou na ElevenLabs pode ser maior que a gravada aqui (Sol, PR #26)
  select count(*) into v_qtd
    from public.ligacoes l
   where l.status = 'em_andamento'
     and l.iniciada_em > now() - interval '32 minutes';
  if v_simult is not null and v_qtd >= v_simult then
    return query select null::uuid, null::text, false, 'limite_simultaneas'::text;
    return;
  end if;
  select count(*) into v_qtd
    from public.ligacoes l
   where l.status <> 'nao_completada'
     and l.iniciada_em >= ((p_momento at time zone 'America/Sao_Paulo')::date)::timestamp
                          at time zone 'America/Sao_Paulo';
  if v_dia is not null and v_qtd >= v_dia then
    return query select null::uuid, null::text, false, 'limite_por_dia'::text;
    return;
  end if;

  select cf.ligacoes_por_contato into v_limite from public.configuracao cf where cf.id = 1;
  select count(*) into v_qtd
    from public.ligacoes l
    join public.conversas c on c.id = l.conversa_id
   where c.contato_id = v_conv.contato_id
     and l.status <> 'nao_completada'
     and l.iniciada_em > p_momento - interval '24 hours';
  if v_qtd >= coalesce(v_limite, 10) then
    return query select null::uuid, null::text, false, 'limite_por_contato'::text;
    return;
  end if;

  -- a conversa como estava, travada (o gatilho da mensagem trava a mesma linha)
  select c.* into v_conv from public.conversas c where c.id = p_conversa for update;

  v_ext := 'saida-' || v_lig::text;
  insert into public.mensagens (conversa_id, conexao_id, direcao, origem, tipo, texto, status,
                                id_externo, momento)
  values (p_conversa, v_conexao, 'entrada', 'lead', 'ligacao',
          public.rotulo_da_ligacao('em_andamento', null), 'recebida',
          'ligacao:' || v_ext, p_momento)
  returning id into v_msg;

  -- a ligação feita pela empresa não é fala do lead: só a mensagem e a espera da Nina ficam
  update public.conversas c
     set nao_lidas = v_conv.nao_lidas,
         ultima_do_lead_em = v_conv.ultima_do_lead_em,
         aguardando_humano_desde = v_conv.aguardando_humano_desde
   where c.id = p_conversa;

  insert into public.ligacoes (id, conversa_id, mensagem_id, conexao_id, agente_id, direcao,
                               id_externo, iniciada_em, objetivo)
  values (v_lig, p_conversa, v_msg, v_conexao, p_agente, 'saida', v_ext, p_momento, v_obj);

  return query select v_lig, v_ext, true, null::text;
end;
$$;
revoke execute on function public.ligacao_iniciar_saida(uuid, uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.ligacao_iniciar_saida(uuid, uuid, timestamptz, text) to service_role;
create or replace function public.ligacao_iniciar(
  p_conexao uuid,
  p_ids jsonb,
  p_nome_whatsapp text,
  p_id_externo text,
  p_agente uuid,
  p_direcao public.ligacao_direcao,
  p_momento timestamptz,
  p_conferir_conta boolean)
returns table (ligacao_id uuid, conversa_id uuid, permitida boolean, motivo text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_ext     text := nullif(btrim(coalesce(p_id_externo, '')), '');
  v_lig     public.ligacoes%rowtype;
  v_limite  integer;
  v_contato uuid;
  v_qtd     integer;
  v_msg     uuid;
  v_conv    uuid;
  v_simult  integer;
  v_dia     integer;
begin
  if v_ext is null or p_momento is null or p_conexao is null then
    raise exception using message = 'ligacao_invalida', errcode = 'P0001';
  end if;
  if p_direcao is distinct from 'entrada'::public.ligacao_direcao then
    raise exception using message = 'direcao_nao_suportada', errcode = 'P0001';
  end if;

  select l.* into v_lig from public.ligacoes l where l.id_externo = v_ext;
  if found then
    return query select v_lig.id, v_lig.conversa_id, true, null::text;
    return;
  end if;

  -- o limite por contato, só para quem já é contato (sem criar ninguém)
  select ci.contato_id into v_contato
    from public.contato_identificadores ci
    join jsonb_array_elements(coalesce(p_ids, '[]'::jsonb)) e
      on ci.tipo::text = e ->> 'tipo' and ci.valor = e ->> 'valor'
   limit 1;
  if v_contato is not null then
    -- uma ligação por vez por contato até o fim desta transação: duas que chegam juntas não
    -- passam as duas pelo limite
    perform pg_advisory_xact_lock(hashtextextended('nina_ligacao_contato:' || v_contato::text, 0));
    -- outra chamada gravou esta mesma ligação enquanto esperava a trava
    select l.* into v_lig from public.ligacoes l where l.id_externo = v_ext;
    if found then
      return query select v_lig.id, v_lig.conversa_id, true, null::text;
      return;
    end if;
    select cf.ligacoes_por_contato into v_limite from public.configuracao cf where cf.id = 1;
    -- só as que foram atendidas e as que estão em curso contam: quem só teve falhas pode tentar
    -- de novo. As duas direções contam (a ligação de saída soma no mesmo limite)
    select count(*) into v_qtd
      from public.ligacoes l
      join public.conversas c on c.id = l.conversa_id
     where c.contato_id = v_contato
       and l.status <> 'nao_completada'
       and l.iniciada_em > p_momento - interval '24 hours';
    if v_qtd >= coalesce(v_limite, 10) then
      return query select null::uuid, null::uuid, false, 'limite_por_contato'::text;
      return;
    end if;
  end if;

  -- os limites da conta, nas duas direções e de todos os agentes (cada agente na ElevenLabs só conta
  -- as dele): só no início da ligação (o pós-chamada que grava uma ligação que já aconteceu não é
  -- recusado). A mesma trava da saída, depois da do contato (Sol, PR #26)
  if coalesce(p_conferir_conta, false) then
    perform pg_advisory_xact_lock(hashtextextended('nina_ligacao_conta', 0));
    select l.* into v_lig from public.ligacoes l where l.id_externo = v_ext;
    if found then
      return query select v_lig.id, v_lig.conversa_id, true, null::text;
      return;
    end if;
    select cf.ligacoes_simultaneas, cf.ligacoes_por_dia into v_simult, v_dia
      from public.configuracao cf where cf.id = 1;
    select count(*) into v_qtd
      from public.ligacoes l
     where l.status = 'em_andamento'
       and l.iniciada_em > now() - interval '32 minutes';
    if v_simult is not null and v_qtd >= v_simult then
      return query select null::uuid, null::uuid, false, 'limite_simultaneas'::text;
      return;
    end if;
    select count(*) into v_qtd
      from public.ligacoes l
     where l.status <> 'nao_completada'
       and l.iniciada_em >= ((p_momento at time zone 'America/Sao_Paulo')::date)::timestamp
                            at time zone 'America/Sao_Paulo';
    if v_dia is not null and v_qtd >= v_dia then
      return query select null::uuid, null::uuid, false, 'limite_por_dia'::text;
      return;
    end if;
  end if;

  select r.mensagem_id, r.conversa_id into v_msg, v_conv
    from public.registrar_entrada(
      p_conexao, coalesce(p_ids, '[]'::jsonb), coalesce(p_nome_whatsapp, ''),
      jsonb_build_object(
        'id_externo', 'ligacao:' || v_ext,
        'tipo', 'ligacao',
        'texto', public.rotulo_da_ligacao('em_andamento', null),
        'momento', p_momento)) r;
  if v_conv is null then
    raise exception using message = 'conversa_nao_criada', errcode = 'P0001';
  end if;

  insert into public.ligacoes (conversa_id, mensagem_id, conexao_id, agente_id, direcao, id_externo, iniciada_em)
  values (v_conv, v_msg, p_conexao, p_agente, p_direcao, v_ext, p_momento)
  on conflict (id_externo) do nothing
  returning * into v_lig;
  if v_lig.id is null then
    -- outra chamada gravou a mesma agora há pouco
    select l.* into v_lig from public.ligacoes l where l.id_externo = v_ext;
  end if;

  return query select v_lig.id, v_lig.conversa_id, true, null::text;
end;
$$;
revoke execute on function public.ligacao_iniciar(uuid, jsonb, text, text, uuid, public.ligacao_direcao, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.ligacao_iniciar(uuid, jsonb, text, text, uuid, public.ligacao_direcao, timestamptz, boolean) to service_role;

create or replace function public.ligacao_agente_soltar(p_agente uuid)
returns table (motivo text, id_externo text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_a public.ligacao_agentes%rowtype;
begin
  -- a linha travada: uma reserva de saída com este agente (que trava a linha para leitura) termina
  -- antes, e a ligação dela é vista; uma que vier depois vê o agente sem id e recusa
  select a.* into v_a from public.ligacao_agentes a where a.id = p_agente for update;
  if not found then
    return query select 'nao_encontrado'::text, null::text;
    return;
  end if;
  if v_a.atende then
    return query select 'atende'::text, null::text;
    return;
  end if;
  if exists (select 1 from public.ligacoes l
              where l.agente_id = p_agente and l.status = 'em_andamento'
                and l.iniciada_em > now() - interval '32 minutes') then
    return query select 'em_ligacao'::text, null::text;
    return;
  end if;
  update public.ligacao_agentes a
     set id_externo = null, sincronizado_em = null
   where a.id = p_agente;
  return query select null::text, v_a.id_externo;
end;
$$;
revoke execute on function public.ligacao_agente_soltar(uuid) from public, anon, authenticated;
grant execute on function public.ligacao_agente_soltar(uuid) to service_role;