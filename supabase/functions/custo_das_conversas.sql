-- Versão final da função public.custo_das_conversas (última definição em 0007_nina_ligacao_leituras.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.custo_das_conversas(p_conversas uuid[])
returns table (conversa_id uuid, custo_usd numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not coalesce(public.eh_admin(), false) then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;
  if p_conversas is null or cardinality(p_conversas) = 0 then
    return;
  end if;
  if cardinality(p_conversas) > 200 then
    raise exception using message = 'parametro_invalido', errcode = '22023', detail = 'p_conversas';
  end if;
  return query
  select cv.id, coalesce(sum(k.custo_usd), 0)::numeric
    from public.conversas cv
    left join (
      select coalesce(ch.conversa_id, r.conversa_id) as conversa_id, ch.custo_usd
        from public.ia_chamadas ch
        left join public.rodadas r on r.id = ch.rodada_id
       where coalesce(ch.conversa_id, r.conversa_id) = any (p_conversas)
    ) k on k.conversa_id = cv.id
   where cv.id = any (p_conversas)
   group by cv.id;
end;
$$;
