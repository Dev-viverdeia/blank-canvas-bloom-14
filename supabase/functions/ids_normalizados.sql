-- Versão final da função public.ids_normalizados (última definição em 0002_nina_funcoes_fila_dashboard.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.ids_normalizados(p_ids jsonb)
returns jsonb
language sql
immutable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('tipo', x.tipo, 'valor', x.valor, 'prio', x.prio)
                            order by x.prio, x.valor), '[]'::jsonb)
  from (
    select distinct t.tipo, t.valor,
           array_position(array['bsuid', 'lid', 'telefone', 'zernio_conversa'], t.tipo) as prio
    from (
      select e ->> 'tipo' as tipo,
             case when e ->> 'tipo' = 'telefone'
                  then regexp_replace(coalesce(e ->> 'valor', ''), '[^0-9]', '', 'g')
                  else btrim(coalesce(e ->> 'valor', ''))
             end as valor
      from jsonb_array_elements(case when jsonb_typeof(p_ids) = 'array' then p_ids else '[]'::jsonb end) as e
      where jsonb_typeof(e) = 'object'
    ) t
    where t.tipo in ('bsuid', 'lid', 'telefone', 'zernio_conversa')
      and t.valor <> ''
  ) x
$$;
