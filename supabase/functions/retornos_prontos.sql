-- Versão final da função public.retornos_prontos (última definição em 0043_nina_retornos_regras.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.retornos_prontos()
returns table (retorno_id uuid, conversa_id uuid, tipo public.retorno_tipo, pronto_em timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  with cf as (
    select k.onboarding_concluido_em, k.lembrete_ligado, k.lembrete_horas
      from public.configuracao k where k.id = 1
  ), wa as (
    select public.whatsapp_conectado_desde() as desde
  )
  select rt.id, rt.conversa_id, rt.tipo,
         greatest(rt.vence_em, coalesce(rt.tentar_apos, rt.vence_em), wa.desde,
                  cf.onboarding_concluido_em, pg.desde)
    from public.retornos rt
    join public.conversas c on c.id = rt.conversa_id
   cross join cf
   cross join wa
    -- a pergunta da rodada que armou o lembrete: desde quando pode ser cobrada (a última bolha que
    -- saiu, mais as horas com que ele foi armado; o ajuste mudado depois não o move) e se alguma
    -- bolha dela ainda está na fila ou enviando
    left join lateral (
      select max(m.momento) filter (where m.status in ('enviada', 'entregue', 'lida'))
               + make_interval(hours => coalesce(rt.lembrete_horas, cf.lembrete_horas)) as desde,
             bool_or(m.status in ('na_fila', 'enviando')) as na_fila
        from public.mensagens m
       where rt.tipo = 'lembrete'
         and m.rodada_id = rt.rodada_origem_id
         and m.direcao = 'saida' and m.origem = 'nina'
         and m.apagada_em is null
         and m.status in ('na_fila', 'enviando', 'enviada', 'entregue', 'lida')
    ) pg on true
   where rt.status = 'pendente'
     and rt.vence_em <= now()
     and rt.expira_em > now()
     and cf.onboarding_concluido_em is not null
     and wa.desde is not null
     and public.retorno_conversa_livre(rt.conversa_id)
     and (rt.tipo = 'retorno'
          or (cf.lembrete_ligado
              and exists (select 1 from public.contatos ct
                            join public.etapas e on e.id = ct.etapa_id
                           where ct.id = c.contato_id and e.tipo = 'aberta')
              and (c.ultima_do_lead_em is null or c.ultima_do_lead_em <= rt.marcado_em)
              and coalesce(c.devolvida_em, '-infinity'::timestamptz) <= rt.marcado_em
              and (rt.rodada_origem_id is null
                   or (pg.desde is not null and not coalesce(pg.na_fila, false)
                       and pg.desde <= now()))
              and not exists (select 1 from public.mensagens m
                               where m.conversa_id = rt.conversa_id and m.direcao = 'entrada'
                                 and m.rodada_id is null
                                 and m.criado_em >= coalesce(
                                       (select ro.iniciada_em from public.rodadas ro
                                         where ro.id = rt.rodada_origem_id),
                                       rt.marcado_em))
              and not exists (select 1 from public.retornos o
                               where o.conversa_id = rt.conversa_id and o.tipo = 'retorno'
                                 and o.status in ('pendente', 'em_rodada'))));
$$;
