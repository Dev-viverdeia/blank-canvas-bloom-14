-- Versão final da função public.registrar_saida_celular (última definição em 0006_nina_ligacao_conversa.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.registrar_saida_celular(p_conexao uuid, p_ids jsonb, p_msg jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id_ext  text := nullif(btrim(coalesce(p_msg ->> 'id_externo', '')), '');
  v_gw      text := nullif(btrim(coalesce(p_msg ->> 'id_gateway', '')), '');
  v_ref     text := nullif(btrim(coalesce(p_msg ->> 'midia_ref_externa', '')), '');
  v_texto   text := public.texto_normalizado(p_msg ->> 'texto');
  v_tipo    public.mensagem_tipo := public.tipo_de_mensagem(p_msg ->> 'tipo');
  v_cita    text := nullif(btrim(coalesce(p_msg ->> 'responde_a_id_externo', '')), '');
  v_resp    uuid;
  v_momento timestamptz;
  v_contato uuid;
  v_conv    uuid;
  v_msg     uuid;
begin
  if v_id_ext is null or nullif(p_msg ->> 'tipo', '') is null or nullif(p_msg ->> 'momento', '') is null then
    raise exception using message = 'mensagem_invalida', errcode = 'P0001';
  end if;
  v_momento := (p_msg ->> 'momento')::timestamptz;

  select m.id into v_msg
  from public.mensagens m
  where m.conexao_id = p_conexao and m.id_externo = v_id_ext;
  if v_msg is not null then
    return v_msg;
  end if;

  -- conhecida pelo id do gateway (o envio devolveu so esse id)
  if v_gw is not null then
    select m.id into v_msg
    from public.mensagens m
    where m.conexao_id = p_conexao and m.direcao = 'saida' and m.id_gateway = v_gw
    order by m.criado_em desc, m.id
    limit 1
    for update;
    if v_msg is not null then
      update public.mensagens m
         set id_externo = v_id_ext
       where m.id = v_msg and m.id_externo is null;
      return v_msg;
    end if;
  end if;

  v_contato := public.contato_por_ids(p_conexao, p_ids, null);
  v_conv := public.conversa_do_contato(v_contato, p_conexao);

  -- eco do nosso envio
  select m.id into v_msg
  from public.mensagens m
  where m.conversa_id = v_conv
    and m.direcao = 'saida'
    and m.origem in ('nina', 'humano_tela')
    and m.status in ('enviando', 'enviada')
    and m.id_externo is null
    and public.texto_normalizado(m.texto) is not distinct from v_texto
    and (v_texto is not null
         or (m.tipo = v_tipo
             and (nullif(p_msg ->> 'midia_nome', '') is null or m.midia_nome = p_msg ->> 'midia_nome')
             and (nullif(p_msg ->> 'midia_mime', '') is null or m.midia_mime = p_msg ->> 'midia_mime')))
    and coalesce(m.status_em, m.criado_em) > now() - interval '60 seconds'
  order by m.criado_em, m.ordem nulls last, m.id
  limit 1
  for update;

  if v_msg is not null then
    update public.mensagens m
       set id_externo = v_id_ext,
           id_gateway = coalesce(m.id_gateway, nullif(p_msg ->> 'id_gateway', ''))
     where m.id = v_msg;
    return v_msg;
  end if;

  -- novo: a citação, pela mesma conexão
  if v_cita is not null then
    select m.id into v_resp
    from public.mensagens m
    where m.conexao_id = p_conexao and m.id_externo = v_cita;
  end if;

  insert into public.mensagens (
    conversa_id, conexao_id, direcao, origem, tipo, texto, status, status_em,
    midia_ref_externa, midia_mime, midia_nome, midia_tamanho, midia_status,
    id_externo, id_gateway, momento, evento_id, responde_a_id)
  values (
    v_conv, p_conexao, 'saida', 'humano_celular', v_tipo,
    p_msg ->> 'texto', 'enviada', v_momento,
    v_ref, p_msg ->> 'midia_mime', p_msg ->> 'midia_nome',
    (nullif(p_msg ->> 'midia_tamanho', ''))::bigint,
    case when v_ref is not null then 'pendente'::public.midia_status end,
    v_id_ext, v_gw, v_momento,
    (nullif(p_msg ->> 'evento_id', ''))::bigint,
    v_resp)
  on conflict (conexao_id, id_externo) where id_externo is not null do nothing
  returning id into v_msg;

  if v_msg is null then
    select m.id into v_msg
    from public.mensagens m
    where m.conexao_id = p_conexao and m.id_externo = v_id_ext;
  end if;
  return v_msg;
end;
$$;
