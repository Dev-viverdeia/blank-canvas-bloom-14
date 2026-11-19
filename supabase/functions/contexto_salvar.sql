-- Versão final da função public.contexto_salvar (última definição em 0017_nina_lacunas_funcoes.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.contexto_salvar(
  p_base bigint,
  p_mudancas jsonb,
  p_origem public.contexto_origem default 'edicao'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_campos constant text[] := array['empresa_oferta', 'cliente_ideal', 'preco', 'diferenciais',
                                    'objecoes', 'quando_passar_humano', 'tom_voz', 'horario'];
  c_limite constant int := 2000;
  c_max_itens constant int := 50;
  v_eu      uuid;
  v_origem  public.contexto_origem := coalesce(p_origem, 'edicao');
  v_atual   jsonb;
  v_base    jsonb;
  v_novo    jsonb;
  v_chave   text;
  v_valor   jsonb;
  v_item    jsonb;
  v_itens   jsonb;
  v_id      bigint;
  v_numero  int;
begin
  if not coalesce(public.eh_admin(), false) then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;
  v_eu := public.membro_atual();

  if v_origem = 'restauracao' then
    raise exception using message = 'mudancas_invalidas', errcode = '22023';
  end if;
  if p_mudancas is null or jsonb_typeof(p_mudancas) <> 'object' then
    raise exception using message = 'mudancas_invalidas', errcode = '22023';
  end if;

  -- Formato e tamanho de cada mudança.
  for v_chave, v_valor in select k.key, k.value from jsonb_each(p_mudancas) k loop
    if v_chave = 'itens' then
      if jsonb_typeof(v_valor) <> 'array' then
        raise exception using message = 'mudancas_invalidas', errcode = '22023';
      end if;
      -- novo: no máximo 50 itens livres
      if jsonb_array_length(v_valor) > c_max_itens then
        raise exception using message = 'limite_itens', errcode = 'P0001';
      end if;
      v_itens := '[]'::jsonb;
      for v_item in select e.value from jsonb_array_elements(v_valor) e loop
        if jsonb_typeof(v_item) <> 'object'
           or jsonb_typeof(v_item -> 'pergunta') is distinct from 'string'
           or jsonb_typeof(v_item -> 'resposta') is distinct from 'string' then
          raise exception using message = 'mudancas_invalidas', errcode = '22023';
        end if;
        -- novo: a pergunta passa pelo mesmo limite da resposta
        if char_length(v_item ->> 'pergunta') > c_limite
           or char_length(v_item ->> 'resposta') > c_limite then
          raise exception using message = 'limite_tamanho', errcode = 'P0001';
        end if;
        v_itens := v_itens || jsonb_build_array(jsonb_build_object(
                     'pergunta', v_item ->> 'pergunta', 'resposta', v_item ->> 'resposta'));
      end loop;
    elsif v_chave = any (c_campos) then
      if jsonb_typeof(v_valor) <> 'string' then
        raise exception using message = 'mudancas_invalidas', errcode = '22023';
      end if;
      if char_length(v_valor #>> '{}') > c_limite then
        raise exception using message = 'limite_tamanho', errcode = 'P0001';
      end if;
    else
      raise exception using message = 'mudancas_invalidas', errcode = '22023';
    end if;
  end loop;

  -- Um admin por vez daqui até o insert.
  perform pg_advisory_xact_lock(hashtext('nina.contexto'));

  select to_jsonb(cv) into v_atual
    from public.contexto_versoes cv
   order by cv.id desc
   limit 1;

  if p_base is null then
    if v_atual is not null then
      raise exception using message = 'contexto_mudou', errcode = 'P0001';
    end if;
    v_base := '{}'::jsonb;
  else
    select to_jsonb(cv) into v_base from public.contexto_versoes cv where cv.id = p_base;
    if v_base is null then
      raise exception using message = 'nao_encontrado', errcode = 'P0001';
    end if;
  end if;

  -- Junta: parte da atual (ou do vazio) e põe por cima o que mudou.
  v_novo := jsonb_build_object('itens', coalesce(v_atual -> 'itens', '[]'::jsonb));
  foreach v_chave in array c_campos loop
    v_novo := v_novo || jsonb_build_object(v_chave, coalesce(v_atual ->> v_chave, ''));
  end loop;

  for v_chave, v_valor in select k.key, k.value from jsonb_each(p_mudancas) k loop
    if v_chave = 'itens' then
      v_valor := v_itens;
    end if;
    -- igual ao que a tela abriu: não é mudança
    if p_base is not null and v_valor = (v_base -> v_chave) then
      continue;
    end if;
    -- mudou também entre a base e a atual: outro admin mexeu no mesmo campo
    if p_base is not null and (v_base -> v_chave) is distinct from (v_atual -> v_chave) then
      raise exception using message = 'contexto_mudou', errcode = 'P0001';
    end if;
    v_novo := v_novo || jsonb_build_object(v_chave, v_valor);
  end loop;

  -- Nada diferente da atual: não grava versão nova.
  if v_atual is not null
     and v_novo = (select jsonb_object_agg(k.key, k.value)
                     from jsonb_each(v_atual) k
                    where k.key = any (c_campos) or k.key = 'itens') then
    return jsonb_build_object('id', (v_atual ->> 'id')::bigint, 'numero', (v_atual ->> 'numero')::int);
  end if;

  insert into public.contexto_versoes (empresa_oferta, cliente_ideal, preco, diferenciais, objecoes,
                                       quando_passar_humano, tom_voz, horario, itens, origem, criado_por)
  values (v_novo ->> 'empresa_oferta', v_novo ->> 'cliente_ideal', v_novo ->> 'preco',
          v_novo ->> 'diferenciais', v_novo ->> 'objecoes', v_novo ->> 'quando_passar_humano',
          v_novo ->> 'tom_voz', v_novo ->> 'horario', v_novo -> 'itens', v_origem, v_eu)
  returning id, numero into v_id, v_numero;

  return jsonb_build_object('id', v_id, 'numero', v_numero);
end;
$$;
