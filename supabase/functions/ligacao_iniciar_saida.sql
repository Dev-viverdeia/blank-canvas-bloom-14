-- Versão final da função public.ligacao_iniciar_saida (última definição em 0039_nina_ligar_com_agente_corridas.sql).
-- Referência: quem aplica é a pasta migrations.

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
