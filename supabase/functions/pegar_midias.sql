-- Versão final da função public.pegar_midias (última definição em 0002_nina_funcoes_fila_dashboard.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.pegar_midias(p_limite int)
returns setof public.mensagens
language plpgsql
security definer
set search_path = ''
as $$
begin
  with esgotadas as (
    select m.id
    from public.mensagens m
    where m.midia_status = 'pendente'
      and m.midia_tentativas >= 3
      and (m.midia_pega_em is null or m.midia_pega_em < now() - interval '2 minutes')
    for update skip locked
  )
  update public.mensagens m
     set midia_status = 'falhou', midia_pega_em = null
    from esgotadas e
   where m.id = e.id;

  -- instrucao unica: trava (SKIP LOCKED) e marca como pega
  return query
  with alvo as (
    select m.id
    from public.mensagens m
    where m.midia_status = 'pendente'
      and m.midia_ref_externa is not null
      and m.midia_tentativas < 3
      and (m.midia_pega_em is null or m.midia_pega_em < now() - interval '2 minutes')
    order by m.criado_em, m.id
    limit greatest(coalesce(p_limite, 0), 0)
    for update of m skip locked
  )
  update public.mensagens m
     set midia_pega_em = now(),
         midia_tentativas = m.midia_tentativas + 1
    from alvo a
   where m.id = a.id
  returning m.*;
end;
$$;
