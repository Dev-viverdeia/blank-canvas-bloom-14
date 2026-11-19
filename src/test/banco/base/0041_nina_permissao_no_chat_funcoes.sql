-- nina_permissao_no_chat_funcoes (18/11/2026): o pedido de permissão para ligar e a resposta do lead
-- viram mensagens do chat (tipo 'permissao_ligacao'), sem tirar a conversa da Nina nem armar a Nina
-- de texto (a decisão de 17/11/2026 continua).
-- - ligacao_permissoes.mensagem_id e resposta_mensagem_id: as mensagens do pedido e da resposta.
-- - ligacao_permissao_registrar: grava o pedido (o que o servidor fazia por insert) e a mensagem
--   dele, de saída, já enviada, com o wamid no id_gateway (os status da Meta casam nela). Origem
--   'nina': não tira a conversa de ninguém; quem pediu fica em autor_membro_id. Idempotente.
-- - ligacao_permissao_responder: grava a resposta no pedido e a mensagem do lead, uma vez só. A
--   mensagem conta como não lida e abre a janela de 24 h (é uma resposta do lead), mas não arma a
--   Nina: o responder_apos volta ao que era. Devolve quantos pedidos casaram (0 = o pedido ainda não
--   está gravado: o webhook repete).
-- Depende de: nina_permissao_no_chat_tipo (1º envio) e nina_ligacao_saida_tabela (0034). Ordem: 2º
-- envio. Nada é semeado: a preparar_copia() não muda. Pode rodar duas vezes. Sem BEGIN/COMMIT.

-- ---------------------------------------------------------------------
-- Trava: sem o 1º envio, este para aqui.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
                  where t.typname = 'mensagem_tipo' and e.enumlabel = 'permissao_ligacao') then
    raise exception using message = 'falta_o_tipo_permissao_ligacao',
      hint = 'Aplique antes o nina_permissao_no_chat_tipo.';
  end if;
  if to_regclass('public.ligacao_permissoes') is null then
    raise exception using message = 'falta_a_tabela_ligacao_permissoes';
  end if;
end;
$$;

alter table public.ligacao_permissoes
  add column if not exists mensagem_id uuid references public.mensagens (id) on delete set null;
alter table public.ligacao_permissoes
  add column if not exists resposta_mensagem_id uuid references public.mensagens (id) on delete set null;

create or replace function public.ligacao_permissao_registrar(
  p_conversa uuid,
  p_conexao uuid,
  p_wamid text,
  p_membro uuid,
  p_texto text,
  p_momento timestamptz)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_wamid text := nullif(btrim(coalesce(p_wamid, '')), '');
  v_texto text := nullif(btrim(coalesce(p_texto, '')), '');
  v_id    uuid;
  v_msg   uuid;
  v_rod   uuid;
begin
  if p_conversa is null or p_conexao is null or v_wamid is null or v_texto is null
     or p_momento is null then
    raise exception using message = 'pedido_invalido', errcode = 'P0001';
  end if;

  select p.id, p.mensagem_id into v_id, v_msg from public.ligacao_permissoes p
   where p.conexao_id = p_conexao and p.id_gateway = v_wamid
   for update;
  if v_id is null then
    insert into public.ligacao_permissoes (conversa_id, conexao_id, id_gateway, pedido_por, pedido_em)
    values (p_conversa, p_conexao, v_wamid, p_membro, p_momento)
    returning id into v_id;
  end if;
  if v_msg is not null then
    return v_id;
  end if;

  -- a mensagem do pedido: de saída e já enviada (o gatilho não a põe na fila nem confere a janela);
  -- origem 'nina' não muda o modo da conversa; o status da Meta casa pelo id_gateway. A mensagem da
  -- Nina exige rodada (mensagens_nina_rodada): uma rodada já concluída, sem passos, como a do aviso
  -- de ligação não completada (base 0028)
  insert into public.rodadas (conversa_id, status, contexto_versao_id, provedor, modelo,
                              passos, tentativa, passou_humano, iniciada_em, terminada_em)
  values (p_conversa, 'concluida', (select max(cv.id) from public.contexto_versoes cv), null, null,
          0, 1, false, now(), now())
  returning id into v_rod;
  insert into public.mensagens (conversa_id, conexao_id, direcao, origem, tipo, texto, status,
                                id_gateway, autor_membro_id, rodada_id, momento)
  values (p_conversa, p_conexao, 'saida', 'nina', 'permissao_ligacao', v_texto, 'enviada',
          v_wamid, p_membro, v_rod, p_momento)
  returning id into v_msg;
  update public.ligacao_permissoes p set mensagem_id = v_msg where p.id = v_id;
  return v_id;
end;
$$;
revoke execute on function public.ligacao_permissao_registrar(uuid, uuid, text, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.ligacao_permissao_registrar(uuid, uuid, text, uuid, text, timestamptz) to service_role;

create or replace function public.ligacao_permissao_responder(
  p_conexao uuid,
  p_pedido_wamid text,
  p_resposta text,
  p_permanente boolean,
  p_expira_em timestamptz,
  p_momento timestamptz,
  p_texto text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_wamid   text := nullif(btrim(coalesce(p_pedido_wamid, '')), '');
  v_texto   text := nullif(btrim(coalesce(p_texto, '')), '');
  v_p       public.ligacao_permissoes%rowtype;
  v_armado  timestamptz;
  v_msg     uuid;
begin
  if p_conexao is null or v_wamid is null or p_momento is null or v_texto is null
     or p_resposta not in ('aceitou', 'recusou') then
    raise exception using message = 'resposta_invalida', errcode = 'P0001';
  end if;

  select p.* into v_p from public.ligacao_permissoes p
   where p.conexao_id = p_conexao and p.id_gateway = v_wamid
   for update;
  if not found then
    return 0;
  end if;

  update public.ligacao_permissoes p
     set resposta = p_resposta,
         permanente = case when p_resposta = 'aceitou' then p_permanente else null end,
         expira_em = p_expira_em,
         respondido_em = p_momento
   where p.id = v_p.id;

  -- a mensagem do lead, uma vez só (a resposta repetida da Meta só atualiza o pedido)
  if v_p.resposta_mensagem_id is not null then
    return 1;
  end if;

  -- o responder_apos de antes: a resposta ao pedido não arma a Nina de texto
  select c.responder_apos into v_armado from public.conversas c
   where c.id = v_p.conversa_id
   for update;

  insert into public.mensagens (conversa_id, conexao_id, direcao, origem, tipo, texto, status,
                                id_externo, momento)
  values (v_p.conversa_id, p_conexao, 'entrada', 'lead', 'permissao_ligacao', v_texto, 'recebida',
          'permissao:' || v_wamid, p_momento)
  on conflict do nothing
  returning id into v_msg;

  if v_msg is not null then
    update public.conversas c set responder_apos = v_armado where c.id = v_p.conversa_id;
    update public.ligacao_permissoes p set resposta_mensagem_id = v_msg where p.id = v_p.id;
  end if;
  return 1;
end;
$$;
revoke execute on function public.ligacao_permissao_responder(uuid, text, text, boolean, timestamptz, timestamptz, text) from public, anon, authenticated;
grant execute on function public.ligacao_permissao_responder(uuid, text, text, boolean, timestamptz, timestamptz, text) to service_role;