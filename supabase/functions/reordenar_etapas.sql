-- Versão final da função public.reordenar_etapas (última definição em 0007_nina_ligacao_leituras.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.reordenar_etapas(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_qtd      int;
  v_achadas  int;
  v_abertas  int;
  v_posicoes int[];
begin
  if not coalesce(public.eh_admin(), false) then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;
  v_qtd := coalesce(cardinality(p_ids), 0);
  if v_qtd = 0 then
    return;
  end if;
  if array_position(p_ids, null) is not null
     or (select count(distinct x) from unnest(p_ids) as x) <> v_qtd then
    raise exception using message = 'nao_encontrado', errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('nina.etapas'));
  perform 1 from public.etapas e where e.id = any (p_ids) for update;

  select count(*), count(*) filter (where e.tipo = 'aberta'), array_agg(e.ordem order by e.ordem, e.id)
    into v_achadas, v_abertas, v_posicoes
    from public.etapas e
   where e.id = any (p_ids);
  if v_achadas <> v_qtd then
    raise exception using message = 'nao_encontrado', errcode = 'P0001';
  end if;
  if v_abertas <> 0 and v_abertas <> v_achadas then
    raise exception using message = 'sem_permissao', errcode = 'P0001';
  end if;

  update public.etapas e
     set ordem = v_posicoes[k.pos]
    from unnest(p_ids) with ordinality as k (id, pos)
   where e.id = k.id
     and e.ordem is distinct from v_posicoes[k.pos];
end;
$$;
