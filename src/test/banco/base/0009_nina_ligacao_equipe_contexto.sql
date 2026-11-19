-- =====================================================================
-- Ligar as telas ao banco, envio 3 (parte): Equipe, Contexto e onboarding.
-- Contrato: seção 2.3 ("Novas, em
-- 33-equipe-contexto.sql") e decisões 2, 4, 11 e 15.
-- Depende do envio 1 (auditoria_acao 'membro_reativado') e do envio 2
-- (contexto_versoes.numero e restaurada_de, conversa_eventos).
-- Todas as funções são só do admin (eh_admin, erro sem_acesso). Sem BEGIN/COMMIT.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Equipe
-- ---------------------------------------------------------------------

-- Desativa a pessoa e devolve à fila TODAS as conversas que estavam com ela,
-- em qualquer etapa (inclusive Ganho e Perdido, decisão 4): ficam sem
-- responsável, com aguardando_humano_desde = now() e o evento voltou_para_fila.
-- As mensagens que ela deixou na fila continuam e vão para o lead (decisão 15).
-- Devolve os ids das conversas devolvidas (vazio se já estava desativada e sem
-- conversas). O último admin é protegido pelo gatilho membros_ultimo_admin.
create or replace function public.desativar_membro(p_membro uuid)
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_eu     uuid;
  v_alvo   public.membros%rowtype;
  v_ids    uuid[];
begin
  if not coalesce(public.eh_admin(), false) then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;
  v_eu := public.membro_atual();
  if p_membro = v_eu then
    raise exception using message = 'proprio_membro', errcode = 'P0001';
  end if;

  select m.* into v_alvo from public.membros m where m.id = p_membro for update;
  if not found then
    raise exception using message = 'nao_encontrado', errcode = 'P0001';
  end if;

  if v_alvo.ativo then
    update public.membros m set ativo = false where m.id = p_membro;
  end if;

  with devolvidas as (
    update public.conversas c
       set responsavel_id = null,
           aguardando_humano_desde = now()
     where c.responsavel_id = p_membro
    returning c.id
  ), eventos as (
    insert into public.conversa_eventos (conversa_id, tipo, de, de_membro_id)
    select d.id, 'voltou_para_fila', 'outro', p_membro from devolvidas d
    returning conversa_id
  )
  select coalesce(array_agg(e.conversa_id order by e.conversa_id), '{}'::uuid[])
    into v_ids
    from eventos e;

  if v_alvo.ativo or cardinality(v_ids) > 0 then
    insert into public.auditoria (ator_membro_id, acao, alvo, detalhe)
    values (v_eu, 'membro_desativado', p_membro::text,
            jsonb_build_object('nome', v_alvo.nome, 'conversas_devolvidas', cardinality(v_ids)));
  end if;

  return v_ids;
end;
$$;

revoke execute on function public.desativar_membro(uuid) from public, anon;
grant execute on function public.desativar_membro(uuid) to authenticated, service_role;

-- Troca o papel de outra pessoa. Ninguém mexe no próprio papel (proprio_membro);
-- o último admin é protegido pelo gatilho membros_ultimo_admin (ultimo_admin).
-- O mesmo papel de antes não muda nada nem grava auditoria.
create or replace function public.trocar_papel_membro(p_membro uuid, p_papel public.papel_membro)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_eu   uuid;
  v_alvo public.membros%rowtype;
begin
  if not coalesce(public.eh_admin(), false) then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;
  v_eu := public.membro_atual();
  if p_membro = v_eu then
    raise exception using message = 'proprio_membro', errcode = 'P0001';
  end if;
  if p_papel is null then
    raise exception using message = 'nao_encontrado', errcode = 'P0001';
  end if;

  select m.* into v_alvo from public.membros m where m.id = p_membro for update;
  if not found then
    raise exception using message = 'nao_encontrado', errcode = 'P0001';
  end if;
  if v_alvo.papel = p_papel then
    return;
  end if;

  update public.membros m set papel = p_papel where m.id = p_membro;

  insert into public.auditoria (ator_membro_id, acao, alvo, detalhe)
  values (v_eu, 'membro_papel_trocado', p_membro::text,
          jsonb_build_object('nome', v_alvo.nome, 'de', v_alvo.papel, 'para', p_papel));
end;
$$;

revoke execute on function public.trocar_papel_membro(uuid, public.papel_membro) from public, anon;
grant execute on function public.trocar_papel_membro(uuid, public.papel_membro) to authenticated, service_role;

-- Reativa a pessoa. Não devolve conversas para ela (as que voltaram para a
-- fila continuam lá). Já ativa: não muda nada nem grava auditoria.
create or replace function public.reativar_membro(p_membro uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_eu   uuid;
  v_alvo public.membros%rowtype;
begin
  if not coalesce(public.eh_admin(), false) then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;
  v_eu := public.membro_atual();
  if p_membro = v_eu then
    raise exception using message = 'proprio_membro', errcode = 'P0001';
  end if;

  select m.* into v_alvo from public.membros m where m.id = p_membro for update;
  if not found then
    raise exception using message = 'nao_encontrado', errcode = 'P0001';
  end if;
  if v_alvo.ativo then
    return;
  end if;

  update public.membros m set ativo = true where m.id = p_membro;

  insert into public.auditoria (ator_membro_id, acao, alvo, detalhe)
  values (v_eu, 'membro_reativado', p_membro::text, jsonb_build_object('nome', v_alvo.nome));
end;
$$;

revoke execute on function public.reativar_membro(uuid) from public, anon;
grant execute on function public.reativar_membro(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Contexto (decisão 11)
-- ---------------------------------------------------------------------

-- Número da versão (1, 2, 3, sem buracos), dado na hora do insert, sob trava.
-- Vale para todo caminho que grava uma versão (contexto_salvar, contexto_restaurar
-- e o insert direto que a 0000 ainda permite ao admin). Uma chamada recusada não
-- chega ao insert, então não gasta número. O unique da coluna é a última defesa.
create or replace function public.tg_contexto_numerar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('nina.contexto'));
  select coalesce(max(cv.numero), 0) + 1 into new.numero from public.contexto_versoes cv;
  return new;
end;
$$;

create trigger contexto_numerar
  before insert on public.contexto_versoes
  for each row execute function public.tg_contexto_numerar();

revoke execute on function public.tg_contexto_numerar() from public, anon, authenticated, service_role;

-- Versão gravada entre o envio 2 (que numerou as antigas) e este gatilho fica com
-- numero nulo: recebe o número seguinte, pela ordem do id. Sem linha nula, não
-- muda nada.
select pg_advisory_xact_lock(hashtext('nina.contexto'));
update public.contexto_versoes cv
   set numero = n.numero
  from (
    select v.id,
           (select coalesce(max(x.numero), 0) from public.contexto_versoes x)
             + (row_number() over (order by v.id))::integer as numero
      from public.contexto_versoes v
     where v.numero is null
  ) n
 where n.id = cv.id;

-- A versão atual é a de maior id, a mesma regra da Nina (pegar_rodadas e o
-- servidor, mensageria/ia/responder.server.ts). O numero só mostra a ordem na
-- tela: uma gravação direta (a que a 0000 ainda permite ao admin) tira o id antes
-- da trava deste gatilho, e duas ao mesmo tempo podem sair com id e numero em
-- ordem trocada.

-- Grava uma versão nova a partir da atual, com as mudanças de um admin.
--   p_base: o id da versão que a tela abriu (nulo só quando ainda não há versão).
--   p_mudancas: {"<campo>": "texto", ..., "itens": [{"pergunta","resposta"}, ...]}
--     com qualquer um dos 8 campos de texto e/ou a lista inteira de itens livres.
--   Campos diferentes se juntam: o que não veio em p_mudancas fica como está na
--   versão atual. Um campo mudado (diferente do que estava em p_base) que também
--   mudou entre p_base e a atual dá contexto_mudou. A lista de itens conta como um
--   campo só.
--   Acima de 2.000 letras num campo ou numa resposta livre: limite_tamanho
--   (só no que veio em p_mudancas; versões antigas não são conferidas).
--   Nada diferente da atual: devolve a atual, sem versão nova.
-- Devolve {id, numero} da versão gravada.
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
      v_itens := '[]'::jsonb;
      for v_item in select e.value from jsonb_array_elements(v_valor) e loop
        if jsonb_typeof(v_item) <> 'object'
           or jsonb_typeof(v_item -> 'pergunta') is distinct from 'string'
           or jsonb_typeof(v_item -> 'resposta') is distinct from 'string' then
          raise exception using message = 'mudancas_invalidas', errcode = '22023';
        end if;
        if char_length(v_item ->> 'resposta') > c_limite then
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

revoke execute on function public.contexto_salvar(bigint, jsonb, public.contexto_origem) from public, anon;
grant execute on function public.contexto_salvar(bigint, jsonb, public.contexto_origem) to authenticated, service_role;

-- Grava uma versão nova igual à p_versao, com origem restauracao e restaurada_de.
-- Restaurar a própria versão atual não grava nada e devolve a atual.
-- Devolve {id, numero} da versão gravada.
create or replace function public.contexto_restaurar(p_versao bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_eu      uuid;
  v_alvo    public.contexto_versoes%rowtype;
  v_atual   bigint;
  v_numero  int;
  v_id      bigint;
begin
  if not coalesce(public.eh_admin(), false) then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;
  v_eu := public.membro_atual();

  perform pg_advisory_xact_lock(hashtext('nina.contexto'));

  select cv.* into v_alvo from public.contexto_versoes cv where cv.id = p_versao;
  if not found then
    raise exception using message = 'nao_encontrado', errcode = 'P0001';
  end if;

  select cv.id, cv.numero into v_atual, v_numero
    from public.contexto_versoes cv
   order by cv.id desc
   limit 1;
  if v_atual = p_versao then
    return jsonb_build_object('id', v_atual, 'numero', v_numero);
  end if;

  insert into public.contexto_versoes (empresa_oferta, cliente_ideal, preco, diferenciais, objecoes,
                                       quando_passar_humano, tom_voz, horario, itens, origem,
                                       criado_por, restaurada_de)
  values (v_alvo.empresa_oferta, v_alvo.cliente_ideal, v_alvo.preco, v_alvo.diferenciais,
          v_alvo.objecoes, v_alvo.quando_passar_humano, v_alvo.tom_voz, v_alvo.horario,
          v_alvo.itens, 'restauracao', v_eu, v_alvo.id)
  returning id, numero into v_id, v_numero;

  return jsonb_build_object('id', v_id, 'numero', v_numero);
end;
$$;

revoke execute on function public.contexto_restaurar(bigint) from public, anon;
grant execute on function public.contexto_restaurar(bigint) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Onboarding (decisão 2)
-- ---------------------------------------------------------------------

-- Marca o onboarding da empresa como concluído e devolve a data. Chamar de novo
-- não muda nada (nem a data, nem o atualizado_em) e devolve a data da 1ª vez.
create or replace function public.concluir_onboarding()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_em timestamptz;
begin
  if not coalesce(public.eh_admin(), false) then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;

  select cf.onboarding_concluido_em into v_em from public.configuracao cf where cf.id = 1 for update;
  if v_em is not null then
    return v_em;
  end if;

  insert into public.configuracao as cf (id, onboarding_concluido_em)
  values (1, now())
  on conflict (id) do update
    set onboarding_concluido_em = coalesce(cf.onboarding_concluido_em, excluded.onboarding_concluido_em)
  returning onboarding_concluido_em into v_em;

  return v_em;
end;
$$;

revoke execute on function public.concluir_onboarding() from public, anon;
grant execute on function public.concluir_onboarding() to authenticated, service_role;