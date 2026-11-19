-- Versão final da função public.registrar_entrada (última definição em 0006_nina_ligacao_conversa.sql).
-- Referência: quem aplica é a pasta migrations.

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
