-- Versão final da função public.contato_por_ids (última definição em 0002_nina_funcoes_fila_dashboard.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.contato_por_ids(p_conexao uuid, p_ids jsonb, p_nome_whatsapp text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids jsonb := public.ids_normalizados(p_ids);
  v_nome text := nullif(btrim(coalesce(p_nome_whatsapp, '')), '');
  v_tel text;
  v_contato uuid;
  v_volta int := 0;
begin
  if jsonb_array_length(v_ids) = 0 then
    raise exception using message = 'sem_identificador', errcode = 'P0001';
  end if;

  select i.valor into v_tel
  from jsonb_to_recordset(v_ids) as i(tipo text, valor text, prio int)
  where i.tipo = 'telefone'
  order by i.valor
  limit 1;

  loop
    v_volta := v_volta + 1;

    select ci.contato_id into v_contato
    from public.contato_identificadores ci
    join jsonb_to_recordset(v_ids) as i(tipo text, valor text, prio int)
      on ci.tipo = i.tipo::public.identificador_tipo and ci.valor = i.valor
    order by i.prio
    limit 1;

    if v_contato is not null then
      -- liga os ids que ainda nao existem; id de outro contato fica onde esta
      insert into public.contato_identificadores (contato_id, tipo, valor, conexao_id)
      select v_contato, i.tipo::public.identificador_tipo, i.valor, p_conexao
      from jsonb_to_recordset(v_ids) as i(tipo text, valor text, prio int)
      order by i.prio, i.valor
      on conflict (tipo, valor) do nothing;

      -- telefone na ficha so se o identificador de telefone e deste contato
      if v_tel is not null and not exists (
        select 1 from public.contato_identificadores ci
        where ci.tipo = 'telefone' and ci.valor = v_tel and ci.contato_id = v_contato) then
        v_tel := null;
      end if;

      update public.contatos c
         set nome_whatsapp = coalesce(v_nome, c.nome_whatsapp),
             telefone      = coalesce(c.telefone, v_tel),
             atualizado_em = now()
       where c.id = v_contato
         and ((v_nome is not null and c.nome_whatsapp is distinct from v_nome)
              or (c.telefone is null and v_tel is not null));

      return v_contato;
    end if;

    begin
      insert into public.contatos (nome_whatsapp, telefone)
      values (v_nome, v_tel)
      returning id into v_contato;

      insert into public.contato_identificadores (contato_id, tipo, valor, conexao_id)
      select v_contato, i.tipo::public.identificador_tipo, i.valor, p_conexao
      from jsonb_to_recordset(v_ids) as i(tipo text, valor text, prio int)
      order by i.prio, i.valor;

      return v_contato;
    exception when unique_violation then
      -- outra chamada criou o contato ao mesmo tempo: desfeito, busca de novo
      v_contato := null;
      if v_volta >= 5 then
        raise;
      end if;
    end;
  end loop;
end;
$$;
