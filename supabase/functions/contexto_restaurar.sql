-- Versão final da função public.contexto_restaurar (última definição em 0009_nina_ligacao_equipe_contexto.sql).
-- Referência: quem aplica é a pasta migrations.

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
