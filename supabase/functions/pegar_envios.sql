-- Versão final da função public.pegar_envios (última definição em 0002_nina_funcoes_fila_dashboard.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.pegar_envios(p_limite int)
returns setof public.mensagens
language plpgsql
security definer
set search_path = ''
as $$
begin
  with presas as (
    select m.id
    from public.mensagens m
    where m.direcao = 'saida' and m.status = 'enviando'
      and coalesce(m.status_em, m.criado_em) < now() - interval '2 minutes'
    for update skip locked
  )
  update public.mensagens m
     set status    = case when m.id_externo is not null then 'enviada'::public.mensagem_status
                          when m.tentativas >= 3 then 'falhou'::public.mensagem_status
                          else 'na_fila'::public.mensagem_status end,
         erro      = case when m.id_externo is null and m.tentativas >= 3 then 'sem_resposta_do_envio'
                          else m.erro end,
         momento   = case when m.id_externo is not null then coalesce(m.status_em, m.momento)
                          else m.momento end,
         status_em = now()
    from presas p
   where m.id = p.id;

  with orfas as (
    select m.id
    from public.mensagens m
    where m.direcao = 'saida' and m.status = 'na_fila'
      and exists (select 1 from public.conexoes a where a.ativa)
      and not exists (select 1 from public.conexoes cx where cx.id = m.conexao_id and cx.ativa)
    for update skip locked
  )
  update public.mensagens m
     set status = 'falhou', erro = 'conexao_inativa', status_em = now()
    from orfas o
   where m.id = o.id;

  -- instrucao unica: trava (SKIP LOCKED) e passa para 'enviando'
  return query
  with primeiras as (
    select distinct on (m.conversa_id) m.id
    from public.mensagens m
    where m.direcao = 'saida' and m.status = 'na_fila'
    order by m.conversa_id, m.criado_em, m.ordem nulls last, m.id
  ), alvo as (
    select m.id
    from public.mensagens m
    join primeiras p on p.id = m.id
    join public.conexoes cx on cx.id = m.conexao_id and cx.ativa
    where m.status = 'na_fila'
      and coalesce(m.enviar_apos, m.criado_em) <= now()
      and not exists (select 1 from public.mensagens e
                      where e.conversa_id = m.conversa_id
                        and e.direcao = 'saida' and e.status = 'enviando')
    order by coalesce(m.enviar_apos, m.criado_em), m.id
    limit greatest(coalesce(p_limite, 0), 0)
    for update of m skip locked
  )
  update public.mensagens m
     set status = 'enviando',
         tentativas = coalesce(m.tentativas, 0) + 1,
         status_em = now()
    from alvo a
   where m.id = a.id
  returning m.*;
end;
$$;
