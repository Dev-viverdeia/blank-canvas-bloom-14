-- Versão final da função public.ligacao_iniciar (última definição em 0039_nina_ligar_com_agente_corridas.sql).
-- Referência: quem aplica é a pasta migrations.

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
