-- Versão final da função public.dashboard_agora (última definição em 0008_nina_ligacao_dashboard.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.dashboard_agora()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_res jsonb;
  v_ultima_nina timestamptz;
begin
  if not coalesce(public.eh_membro(), false) then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;

  select max(cv.ultima_da_nina_em) into v_ultima_nina from public.conversas cv;
  if v_ultima_nina is null then
    select max(m.momento) into v_ultima_nina
      from public.mensagens m
     where m.origem = 'nina' and m.status in ('enviada', 'entregue', 'lida');
  end if;

  with cv as (
    select c.id, c.contato_id, c.modo, c.responsavel_id, c.aguardando_humano_desde, c.motivo_humano,
           c.nao_lidas, c.ultima_do_lead_em, c.ultima_mensagem_em,
           ct.nome, ct.nome_whatsapp, ct.telefone, et.tipo as etapa_tipo,
           (c.modo = 'humano' and c.responsavel_id is null and c.aguardando_humano_desde is not null) as aguardando
      from public.conversas c
      join public.contatos ct on ct.id = c.contato_id
      left join public.etapas et on et.id = ct.etapa_id
  ),
  ativas as (
    select cv.id, cv.contato_id, cv.nome, cv.nome_whatsapp, cv.telefone,
           (select max(r.iniciada_em) from public.rodadas r where r.conversa_id = cv.id and r.status = 'rodando') as rodando_desde
      from cv
     where cv.modo = 'nina'
       and (cv.etapa_tipo is null or cv.etapa_tipo = 'aberta')
  ),
  ativas_agora as (
    select a.*
      from ativas a
     where a.rodando_desde is not null
        or exists (select 1 from public.mensagens m
                    where m.conversa_id = a.id
                      and m.origem in ('nina', 'lead')
                      and m.status not in ('cancelada', 'falhou')
                      and m.momento >= now() - interval '5 minutes')
  ),
  ve as (
    select e.id, e.nome, e.tipo, e.ordem from public.etapas e where not e.arquivada
  ),
  leads as (
    select ct.id, ct.etapa_id, ct.nome, ct.nome_whatsapp, ct.telefone, ct.etapa_desde,
           c.id as conversa_id,
           now() - coalesce(c.ultima_do_lead_em, ct.primeira_mensagem_em, ct.criado_em) > interval '7 days' as parado
      from public.contatos ct
      left join public.conversas c on c.contato_id = ct.id
  )
  select jsonb_build_object(
    'aguardando', jsonb_build_object(
      'total', (select count(*) from cv where cv.aguardando),
      'maisAntigaDesde', (select min(cv.aguardando_humano_desde) from cv where cv.aguardando),
      'itens', coalesce((select jsonb_agg(jsonb_build_object(
                                  'conversaId', cv.id, 'contatoId', cv.contato_id,
                                  'nome', cv.nome, 'nomeWhatsapp', cv.nome_whatsapp, 'telefone', cv.telefone,
                                  'motivo', cv.motivo_humano, 'aguardandoDesde', cv.aguardando_humano_desde)
                                order by cv.aguardando_humano_desde, cv.id)
                           from cv where cv.aguardando), '[]'::jsonb)),
    'naoLidas', jsonb_build_object(
      'conversas', (select count(*) from cv where cv.nao_lidas > 0),
      'mensagens', (select coalesce(sum(cv.nao_lidas), 0) from cv)),
    'comQuem', jsonb_build_object(
      'nina', (select count(*) from cv where cv.modo = 'nina'),
      'membros', coalesce((select jsonb_agg(jsonb_build_object('membroId', x.id, 'nome', x.nome, 'n', x.n)
                                            order by x.n desc, x.nome, x.id)
                             from (select m.id, m.nome, count(*) as n
                                     from cv join public.membros m on m.id = cv.responsavel_id
                                    where cv.modo = 'humano'
                                    group by m.id, m.nome) x), '[]'::jsonb),
      'celular', (select count(*) from cv
                   where cv.modo = 'humano' and cv.responsavel_id is null and cv.aguardando_humano_desde is null)),
    'ninaAtiva', jsonb_build_object(
      'conversas', (select count(*) from ativas_agora),
      'digitando', (select jsonb_build_object('contatoId', a.contato_id, 'nome', a.nome,
                                              'nomeWhatsapp', a.nome_whatsapp, 'telefone', a.telefone)
                      from ativas a
                     where a.rodando_desde is not null
                     order by a.rodando_desde desc, a.id
                     limit 1)),
    'kanban', coalesce((select jsonb_agg(jsonb_build_object(
                                 'etapaId', ve.id, 'nome', ve.nome, 'tipo', ve.tipo,
                                 'n', (select count(*) from public.contatos ct where ct.etapa_id = ve.id))
                               order by ve.ordem, ve.nome, ve.id)
                          from ve), '[]'::jsonb),
    'esfriando', (select count(*) from cv
                   where not cv.aguardando
                     and cv.etapa_tipo = 'aberta'
                     and cv.ultima_do_lead_em is not null
                     and cv.ultima_mensagem_em > cv.ultima_do_lead_em
                     and now() - cv.ultima_do_lead_em >= interval '24 hours'),
    'porEtapa', coalesce((select jsonb_agg(jsonb_build_object(
                                   'etapaId', ve.id,
                                   'paradosMais7d', case when ve.tipo = 'aberta'
                                                         then (select count(*) from leads l where l.etapa_id = ve.id and l.parado)
                                                         else 0 end,
                                   'leads', coalesce((select jsonb_agg(jsonb_build_object(
                                                               'contatoId', y.id, 'conversaId', y.conversa_id,
                                                               'nome', y.nome, 'nomeWhatsapp', y.nome_whatsapp,
                                                               'telefone', y.telefone, 'etapaDesde', y.etapa_desde)
                                                             order by y.etapa_desde, y.id)
                                                        from (select l.* from leads l
                                                               where l.etapa_id = ve.id
                                                               order by l.etapa_desde, l.id
                                                               limit 5) y), '[]'::jsonb))
                                 order by ve.ordem, ve.nome, ve.id)
                            from ve), '[]'::jsonb),
    'ultimaRecebidaEm', (select max(cv.ultima_do_lead_em) from cv),
    'ultimaDaNinaEm', v_ultima_nina
  )
  into v_res;

  return v_res;
end;
$$;
