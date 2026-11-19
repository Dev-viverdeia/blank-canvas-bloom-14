-- nina_ligacoes_limite_por_contato (17/11/2026): o limite de ligações por contato em 24 h fica justo.
-- Recria a ligacao_iniciar (base 0024), com a mesma assinatura e o mesmo retorno, com duas mudanças:
-- - só contam as ligações atendidas ou em curso: as que não completaram (a ElevenLabs recusou, a
--   pessoa desistiu na fila) não contam. Antes, quem só teve falhas num dia de pico ouvia que já
--   tinha ligado demais;
-- - uma trava por contato (pg_advisory_xact_lock) até o fim da transação: duas ligações do mesmo
--   contato que chegam juntas não passam as duas pelo limite.
-- O resto é o texto da base 0024, sem mudança.
-- Depende de: nina_ligacoes_funcoes (base 0024). Ordem: sozinho. Pode rodar duas vezes.
-- Sem BEGIN/COMMIT. Só o servidor chama (service_role); as permissões são as da 0024.

-- ---------------------------------------------------------------------
-- Trava: sem a ligacao_iniciar da 0024, este envio para aqui.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.ligacao_iniciar(uuid, jsonb, text, text, uuid, public.ligacao_direcao, timestamptz)') is null then
    raise exception using message = 'falta_a_ligacao_iniciar',
      hint = 'Aplique antes o nina_ligacoes_funcoes (base 0024).';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- ligacao_iniciar: a ligação começou (o webhook de início da ElevenLabs). Idempotente pelo
-- id_externo. Antes de criar, o limite por contato em 24 h (configuracao.ligacoes_por_contato),
-- só para quem já é contato, contando as atendidas e as em curso, com a trava do contato.
-- Só entrada nesta versão: a mensagem de saída da Nina exige rodada (mensagens_nina_rodada).
-- ---------------------------------------------------------------------
create or replace function public.ligacao_iniciar(
  p_conexao uuid,
  p_ids jsonb,
  p_nome_whatsapp text,
  p_id_externo text,
  p_agente uuid,
  p_direcao public.ligacao_direcao,
  p_momento timestamptz)
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
    -- de novo
    select count(*) into v_qtd
      from public.ligacoes l
      join public.conversas c on c.id = l.conversa_id
     where c.contato_id = v_contato
       and l.direcao = 'entrada'
       and l.status <> 'nao_completada'
       and l.iniciada_em > p_momento - interval '24 hours';
    if v_qtd >= coalesce(v_limite, 10) then
      return query select null::uuid, null::uuid, false, 'limite_por_contato'::text;
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

revoke execute on function public.ligacao_iniciar(uuid, jsonb, text, text, uuid, public.ligacao_direcao, timestamptz)
  from public, anon, authenticated;
grant execute on function public.ligacao_iniciar(uuid, jsonb, text, text, uuid, public.ligacao_direcao, timestamptz)
  to service_role;