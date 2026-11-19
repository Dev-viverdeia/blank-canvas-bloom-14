-- Versão final da função public.pegar_eventos_pendentes (última definição em 0020_nina_motor_acordado.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.pegar_eventos_pendentes(p_limite int)
returns table (id bigint, gateway public.gateway, conexao_id uuid, payload jsonb, tentativas smallint)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with alvo as (
    select e.id
    from public.eventos_webhook e
    where e.processado_em is null
      and e.tentativas < 5
      and e.recebido_em < now() - interval '30 seconds'
      and (e.pego_em is null or e.pego_em < now() - interval '2 minutes')
    order by e.id
    limit greatest(coalesce(p_limite, 0), 0)
    for update of e skip locked
  ), pegos as (
    update public.eventos_webhook e
       set pego_em = now()
      from alvo a
     where e.id = a.id
    returning e.id, e.gateway, e.conexao_id, e.payload, e.tentativas
  )
  select p.id, p.gateway, p.conexao_id, p.payload, p.tentativas
  from pegos p
  order by p.id;
end;
$$;
