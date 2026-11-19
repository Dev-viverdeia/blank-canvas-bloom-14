-- Versão final da função public.ligacao_permissao_responder (última definição em 0041_nina_permissao_no_chat_funcoes.sql).
-- Referência: quem aplica é a pasta migrations.

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
