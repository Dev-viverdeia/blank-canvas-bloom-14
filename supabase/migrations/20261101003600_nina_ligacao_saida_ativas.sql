-- nina_ligacao_saida_ativas (17/11/2026): a ligação de saída só é registrada com as ligações ativas
-- (seção 2; revisão do Sol 6.1 no PR #24).
-- ligacao_iniciar_saida (recriada, texto da base 0035) passa a exigir
-- conexoes.parametros.ligacoes.situacao = 'ativa' na conexão ativa da Meta, e trava a linha da
-- conexão (for share) até o fim da transação: uma desativação que começou no meio do "Ligar" não
-- deixa a ligação ser registrada com o tronco antigo. Sem as ligações ativas, devolve
-- 'sem_ligacoes'. A assinatura e o resto do texto não mudam.
-- Depende de: nina_ligacao_saida_funcoes (0035). Ordem: sozinho. Nada é semeado: a
-- preparar_copia() não muda. Pode rodar duas vezes. Sem BEGIN/COMMIT.

-- ---------------------------------------------------------------------
-- Trava: sem o 2º envio da ligação de saída, este para aqui.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.ligacao_iniciar_saida(uuid, uuid, timestamptz)') is null then
    raise exception using message = 'falta_a_funcao_ligacao_iniciar_saida',
      hint = 'Aplique antes o nina_ligacao_saida_funcoes (base 0035).';
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
