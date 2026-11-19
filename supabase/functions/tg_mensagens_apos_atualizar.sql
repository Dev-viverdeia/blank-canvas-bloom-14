-- Versão final da função public.tg_mensagens_apos_atualizar (última definição em 0006_nina_ligacao_conversa.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.tg_mensagens_apos_atualizar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_valia boolean := old.status <> 'cancelada' and old.apagada_em is null;
  v_vale boolean := new.status <> 'cancelada' and new.apagada_em is null;
  v_ult uuid;
  v_ult_em timestamptz;
  v_refaz boolean;
  v_m record;
begin
  if new.origem = 'nina'
     and new.status in ('enviada', 'entregue', 'lida')
     and old.status not in ('enviada', 'entregue', 'lida') then
    update public.conversas c
       set ultima_da_nina_em = greatest(c.ultima_da_nina_em, new.momento)
     where c.id = new.conversa_id
       and (c.ultima_da_nina_em is null or c.ultima_da_nina_em < new.momento);
  end if;

  select c.ultima_mensagem_id, c.ultima_mensagem_em into v_ult, v_ult_em
    from public.conversas c where c.id = new.conversa_id;
  if not found then
    return null;
  end if;

  v_refaz := case
    when v_valia and not v_vale then v_ult is null or v_ult = new.id
    when v_vale and not v_valia then v_ult is null or v_ult_em is null or new.momento >= v_ult_em
    else v_ult is null and v_ult_em is not null
  end;
  if not v_refaz then
    return null;
  end if;

  -- Vai refazer: trava a conversa (como o gatilho de inserir) e confere de novo.
  -- Uma mensagem nova que entrou enquanto isso (o lead apagou e mandou outra) já
  -- aparece aqui, e a escolha abaixo não grava a anterior por cima dela. Só trava
  -- quando vai refazer: a troca de status comum (pegar_envios, atualizar_status)
  -- continua sem trava na conversa.
  perform 1 from public.conversas c where c.id = new.conversa_id for update;
  select c.ultima_mensagem_id, c.ultima_mensagem_em into v_ult, v_ult_em
    from public.conversas c where c.id = new.conversa_id;
  if not found then
    return null;
  end if;
  v_refaz := case
    when v_valia and not v_vale then v_ult is null or v_ult = new.id
    when v_vale and not v_valia then v_ult is null or v_ult_em is null or new.momento >= v_ult_em
    else v_ult is null and v_ult_em is not null
  end;
  if not v_refaz then
    return null;
  end if;

  select m.id, m.momento,
         left(coalesce(nullif(btrim(m.texto), ''), '[' || m.tipo::text || ']'), 140) as previa
    into v_m
    from public.mensagens m
   where m.conversa_id = new.conversa_id
     and m.status <> 'cancelada'
     and m.apagada_em is null
   order by m.momento desc, m.criado_em desc, m.ordem desc nulls last, m.id desc
   limit 1;

  if found then
    update public.conversas c
       set ultima_mensagem_id = v_m.id,
           ultima_mensagem_em = v_m.momento,
           ultima_mensagem_preview = v_m.previa
     where c.id = new.conversa_id;
  else
    -- nenhuma vale: sem prévia (a hora da última atividade fica)
    update public.conversas c
       set ultima_mensagem_id = null,
           ultima_mensagem_preview = null
     where c.id = new.conversa_id
       and (c.ultima_mensagem_id is not null or c.ultima_mensagem_preview is not null);
  end if;
  return null;
end;
$$;
