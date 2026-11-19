-- Versão final da função public.ligacao_permissao_registrar (última definição em 0041_nina_permissao_no_chat_funcoes.sql).
-- Referência: quem aplica é a pasta migrations.

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
