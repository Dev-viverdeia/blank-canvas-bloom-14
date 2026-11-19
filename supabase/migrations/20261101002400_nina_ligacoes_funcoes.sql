-- nina_ligacoes_funcoes (envio 3 de 4 da tela de Ligações, 12/11/2026).
-- As funções que gravam a ligação, cada uma numa transação só: o início (mensagem na conversa +
-- linha no histórico, com o limite por contato), o fim (status, duração, resumo, transcrição e o
-- rótulo da mensagem), a passagem para a equipe (uma vez por ligação) e a troca do agente que
-- atende. Substituem as escritas em duas etapas da primeira versão. Depende do envio 2. Só o
-- servidor chama (service_role).

-- ---------------------------------------------------------------------
-- Trava: sem o envio 2, este envio para aqui.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.ligacoes') is null or to_regclass('public.ligacao_agentes') is null then
    raise exception using message = 'falta_o_envio_2_tabelas_de_ligacoes',
      hint = 'Aplique antes o envio 2 (nina_ligacoes_tabelas).';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- O rótulo da ligação na conversa (o texto da mensagem e a prévia da lista).
-- ---------------------------------------------------------------------
create or replace function public.rotulo_da_ligacao(p_status public.ligacao_status, p_duracao_s integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_status = 'em_andamento' then 'Ligação em andamento'
    when p_status = 'nao_completada' then 'Ligação não completada'
    when p_duracao_s is null then 'Ligação'
    when p_duracao_s < 60 then 'Ligação · ' || p_duracao_s || ' s'
    when p_duracao_s % 60 = 0 then 'Ligação · ' || (p_duracao_s / 60) || ' min'
    else 'Ligação · ' || (p_duracao_s / 60) || ' min ' || (p_duracao_s % 60) || ' s'
  end
$$;

-- ---------------------------------------------------------------------
-- ligacao_iniciar: a ligação começou (o webhook de início da ElevenLabs). Idempotente pelo
-- id_externo: o mesmo início de novo, ou o pós-chamada que chegou sem o início, devolve a mesma.
-- Antes de criar, o limite por contato em 24 h (configuracao.ligacoes_por_contato), só para quem
-- já é contato. A mensagem entra pela registrar_entrada (cria contato e conversa na 1ª vez),
-- com o tipo 'ligacao' e o rótulo "Ligação em andamento".
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
    select cf.ligacoes_por_contato into v_limite from public.configuracao cf where cf.id = 1;
    select count(*) into v_qtd
      from public.ligacoes l
      join public.conversas c on c.id = l.conversa_id
     where c.contato_id = v_contato
       and l.direcao = 'entrada'
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

-- ---------------------------------------------------------------------
-- ligacao_encerrar: o pós-chamada. Sem a ligação gravada, não devolve linha (o servidor chama o
-- ligacao_iniciar com os identificadores e repete). Uma falha atrasada não desfaz uma ligação
-- concluída. Resumo, transcrição, duração e custo vazios não apagam o que já existe. Atualiza o
-- rótulo da mensagem e, se ela for a última da conversa, a prévia da lista.
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- ligacao_passar_para_equipe: a ferramenta "passar para a equipe" (durante a ligação) ou o
-- pós-chamada que achou a ferramenta no transcript. Uma vez por ligação (passou_equipe): se a
-- equipe já devolveu a conversa, o pós-chamada não passa de novo. Faz o mesmo que a
-- nina_passar_para_humano (0006), sem rodada: modo humano, motivo nina_passou, entra em
-- "Precisam de você" e grava o evento 'passou' (só quando a conversa estava com a Nina).
-- Devolve true quando a conversa mudou de mãos agora.
-- ---------------------------------------------------------------------
create or replace function public.ligacao_passar_para_equipe(p_ligacao uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lig public.ligacoes%rowtype;
begin
  select l.* into v_lig from public.ligacoes l where l.id = p_ligacao for update;
  if not found then
    raise exception using message = 'ligacao_nao_encontrada', errcode = 'P0001';
  end if;
  if v_lig.passou_equipe then
    return false;
  end if;

  update public.ligacoes l set passou_equipe = true where l.id = p_ligacao;

  update public.conversas c
     set modo = 'humano',
         motivo_humano = 'nina_passou',
         aguardando_humano_desde = coalesce(c.aguardando_humano_desde, now()),
         responder_apos = null
   where c.id = v_lig.conversa_id and c.modo = 'nina';
  if found then
    insert into public.conversa_eventos (conversa_id, tipo, motivo)
    values (v_lig.conversa_id, 'passou', 'nina_passou');
    return true;
  end if;
  return false;
end;
$$;

-- ---------------------------------------------------------------------
-- ligacao_agente_atender: o agente que atende as ligações (um por vez), numa transação só.
-- ---------------------------------------------------------------------
create or replace function public.ligacao_agente_atender(p_agente uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.ligacao_agentes a where a.id = p_agente) then
    raise exception using message = 'agente_nao_encontrado', errcode = 'P0001';
  end if;
  update public.ligacao_agentes a set atende = false where a.atende and a.id <> p_agente;
  update public.ligacao_agentes a set atende = true where a.id = p_agente and not a.atende;
end;
$$;

revoke execute on function public.rotulo_da_ligacao(public.ligacao_status, integer) from public, anon;
grant execute on function public.rotulo_da_ligacao(public.ligacao_status, integer) to authenticated, service_role;
revoke execute on function public.ligacao_iniciar(uuid, jsonb, text, text, uuid, public.ligacao_direcao, timestamptz) from public, anon, authenticated;
grant execute on function public.ligacao_iniciar(uuid, jsonb, text, text, uuid, public.ligacao_direcao, timestamptz) to service_role;
revoke execute on function public.ligacao_encerrar(text, public.ligacao_status, timestamptz, integer, text, text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.ligacao_encerrar(text, public.ligacao_status, timestamptz, integer, text, text, jsonb, integer) to service_role;
revoke execute on function public.ligacao_passar_para_equipe(uuid) from public, anon, authenticated;
grant execute on function public.ligacao_passar_para_equipe(uuid) to service_role;
revoke execute on function public.ligacao_agente_atender(uuid) from public, anon, authenticated;
grant execute on function public.ligacao_agente_atender(uuid) to service_role;