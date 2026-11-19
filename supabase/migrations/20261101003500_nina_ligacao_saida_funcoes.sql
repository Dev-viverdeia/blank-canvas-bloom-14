-- nina_ligacao_saida_funcoes (17/11/2026): a Nina liga para o lead pelo WhatsApp
-- (seções 2 e 4).
-- - ligacao_iniciar_saida: registra a ligação de saída antes de chamar a ElevenLabs (ela não chama
--   o webhook de início na saída). Trava por contato, recusa com ligação em andamento na conversa
--   e aplica o limite por contato em 24 h contando as duas direções. Grava a mensagem do tipo
--   'ligacao' como a da entrada (assim a Nina de texto espera a ligação e manda depois o que a voz
--   combinou, como na recebida), mas desfaz o que a entrada mudou na conversa e que não vale para
--   uma ligação feita pela empresa: nao_lidas, ultima_do_lead_em (a janela de 24 h só abre se o
--   lead atender) e aguardando_humano_desde. A conversa não muda de mãos. O id_externo nasce
--   provisório ('saida-<id da ligação>') até o ligacao_saida_confirmar.
-- - ligacao_saida_confirmar: troca o provisório pelo id da conversa na ElevenLabs (na ligação e na
--   mensagem). Idempotente.
-- - ligacao_iniciar (recriada, texto da base 0029): o limite por contato conta as duas direções.
-- - ligacao_encerrar (recriada, texto da base 0024): a saída concluída (atendida) marca a
--   ultima_do_lead_em, porque abre a janela de 24 h da Meta.
-- Depende de: nina_ligacao_saida_tabela (1º envio), 0023, 0024 e 0029. Ordem: 2º envio. Nada é
-- semeado: a preparar_copia() não muda. Pode rodar duas vezes. Sem BEGIN/COMMIT.

-- ---------------------------------------------------------------------
-- Trava: sem o 1º envio, este para aqui.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.ligacao_permissoes') is null then
    raise exception using message = 'falta_a_tabela_ligacao_permissoes',
      hint = 'Aplique antes o nina_ligacao_saida_tabela.';
  end if;
  if to_regprocedure('public.ligacao_encerrar(text, public.ligacao_status, timestamptz, integer, text, text, jsonb, integer)') is null then
    raise exception using message = 'falta_a_funcao_ligacao_encerrar',
      hint = 'Aplique antes o nina_ligacoes_funcoes (base 0024).';
  end if;
end;
$$;

create or replace function public.ligacao_iniciar_saida(
  p_conversa uuid,
  p_agente uuid,
  p_momento timestamptz)
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
begin
  if p_conversa is null or p_momento is null then
    raise exception using message = 'ligacao_invalida', errcode = 'P0001';
  end if;

  select cx.id into v_conexao
    from public.conexoes cx
   where cx.ativa and cx.gateway = 'meta'
   limit 1;
  if v_conexao is null then
    return query select null::uuid, null::text, false, 'sem_conexao'::text;
    return;
  end if;

  select c.* into v_conv from public.conversas c where c.id = p_conversa;
  if not found then
    return query select null::uuid, null::text, false, 'conversa_nao_encontrada'::text;
    return;
  end if;

  -- uma ligação por vez por contato até o fim desta transação (a mesma trava da entrada)
  perform pg_advisory_xact_lock(hashtextextended('nina_ligacao_contato:' || v_conv.contato_id::text, 0));

  if exists (select 1 from public.ligacoes l
              where l.conversa_id = p_conversa and l.status = 'em_andamento'
                and public.ligacao_teto(l.iniciada_em, l.agente_id) > now()) then
    return query select null::uuid, null::text, false, 'ligacao_em_andamento'::text;
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
                               id_externo, iniciada_em)
  values (v_lig, p_conversa, v_msg, v_conexao, p_agente, 'saida', v_ext, p_momento);

  return query select v_lig, v_ext, true, null::text;
end;
$$;
revoke execute on function public.ligacao_iniciar_saida(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.ligacao_iniciar_saida(uuid, uuid, timestamptz) to service_role;

create or replace function public.ligacao_saida_confirmar(p_ligacao uuid, p_id_externo text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ext text := nullif(btrim(coalesce(p_id_externo, '')), '');
  v_l   public.ligacoes%rowtype;
begin
  if p_ligacao is null or v_ext is null or v_ext like 'saida-%' then
    raise exception using message = 'ligacao_invalida', errcode = 'P0001';
  end if;
  select l.* into v_l from public.ligacoes l where l.id = p_ligacao for update;
  if not found or v_l.direcao <> 'saida' then
    return false;
  end if;
  if v_l.id_externo = v_ext then
    return true;
  end if;
  if v_l.id_externo <> 'saida-' || p_ligacao::text then
    return false;
  end if;
  update public.ligacoes l set id_externo = v_ext where l.id = p_ligacao;
  if v_l.mensagem_id is not null then
    update public.mensagens m set id_externo = 'ligacao:' || v_ext where m.id = v_l.mensagem_id;
  end if;
  return true;
end;
$$;
revoke execute on function public.ligacao_saida_confirmar(uuid, text) from public, anon, authenticated;
grant execute on function public.ligacao_saida_confirmar(uuid, text) to service_role;

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
revoke execute on function public.ligacao_iniciar(uuid, jsonb, text, text, uuid, public.ligacao_direcao, timestamptz) from public, anon, authenticated;
grant execute on function public.ligacao_iniciar(uuid, jsonb, text, text, uuid, public.ligacao_direcao, timestamptz) to service_role;

create or replace function public.ligacao_encerrar(
  p_id_externo text,
  p_status public.ligacao_status,
  p_encerrada_em timestamptz,
  p_duracao_s integer,
  p_motivo_fim text,
  p_resumo text,
  p_transcricao jsonb,
  p_custo_creditos integer)
returns table (ligacao_id uuid, conversa_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_lig    public.ligacoes%rowtype;
  v_rotulo text;
begin
  if p_status is null or p_status = 'em_andamento' then
    raise exception using message = 'status_invalido', errcode = 'P0001';
  end if;

  select l.* into v_lig from public.ligacoes l
   where l.id_externo = nullif(btrim(coalesce(p_id_externo, '')), '')
   for update;
  if not found then
    return;
  end if;

  if not (v_lig.status = 'concluida' and p_status <> 'concluida') then
    update public.ligacoes l
       set status = p_status,
           encerrada_em = coalesce(p_encerrada_em, l.encerrada_em, now()),
           duracao_s = coalesce(p_duracao_s, l.duracao_s),
           motivo_fim = coalesce(left(nullif(btrim(coalesce(p_motivo_fim, '')), ''), 300), l.motivo_fim),
           resumo = coalesce(left(nullif(btrim(coalesce(p_resumo, '')), ''), 4000), l.resumo),
           transcricao = case
             when jsonb_typeof(p_transcricao) = 'array' and jsonb_array_length(p_transcricao) > 0 then p_transcricao
             else l.transcricao end,
           custo_creditos = coalesce(p_custo_creditos, l.custo_creditos)
     where l.id = v_lig.id
     returning * into v_lig;

    -- a ligação feita pela empresa e atendida abre a janela de 24 h da Meta, como uma fala do
    -- lead; a não atendida não abre (o ligacao_iniciar_saida desfez a marca da entrada)
    if v_lig.direcao = 'saida' and v_lig.status = 'concluida' then
      update public.conversas c
         set ultima_do_lead_em = greatest(c.ultima_do_lead_em, v_lig.iniciada_em)
       where c.id = v_lig.conversa_id;
    end if;

    v_rotulo := public.rotulo_da_ligacao(v_lig.status, v_lig.duracao_s);
    if v_lig.mensagem_id is not null then
      update public.mensagens m set texto = v_rotulo
       where m.id = v_lig.mensagem_id and m.texto is distinct from v_rotulo;
      update public.conversas c set ultima_mensagem_preview = v_rotulo
       where c.id = v_lig.conversa_id and c.ultima_mensagem_id = v_lig.mensagem_id
         and c.ultima_mensagem_preview is distinct from v_rotulo;
    end if;
  end if;

  return query select v_lig.id, v_lig.conversa_id;
end;
$$;
revoke execute on function public.ligacao_encerrar(text, public.ligacao_status, timestamptz, integer, text, text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.ligacao_encerrar(text, public.ligacao_status, timestamptz, integer, text, text, jsonb, integer) to service_role;