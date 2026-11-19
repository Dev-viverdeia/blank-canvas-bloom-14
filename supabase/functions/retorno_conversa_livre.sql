-- Versão final da função public.retorno_conversa_livre (última definição em 0043_nina_retornos_regras.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.retorno_conversa_livre(p_conversa uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.conversas c
     where c.id = p_conversa
       and c.modo = 'nina'
       and c.responder_apos is null
       and not exists (select 1 from public.rodadas r
                        where r.conversa_id = c.id and r.status = 'rodando')
       and not exists (select 1 from public.retornos o
                        where o.conversa_id = c.id and o.status = 'em_rodada')
       and not exists (select 1 from public.mensagens m
                        where m.conversa_id = c.id and m.direcao = 'entrada'
                          and m.midia_status = 'pendente'
                          and m.criado_em > now() - interval '2 minutes')
       and exists (select 1 from public.conexoes cx
                    where cx.ativa and cx.status = 'conectada'
                      and (not cx.oficial
                           or (c.ultima_do_lead_em is not null
                               and c.ultima_do_lead_em + interval '24 hours' > now())))
       and not exists (select 1 from public.ligacoes l
                        where l.conversa_id = c.id and l.status = 'em_andamento'
                          and public.ligacao_teto(l.iniciada_em, l.agente_id) > now()));
$$;
