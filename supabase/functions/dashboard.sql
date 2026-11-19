-- Versão final da função public.dashboard (última definição em 0002_nina_funcoes_fila_dashboard.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.dashboard(p_inicio date, p_fim date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin boolean;
  v_de timestamptz;
  v_ate timestamptz;
  v_custo numeric;
  v_sem_preco bigint;
  v_res jsonb;
begin
  if not coalesce(public.eh_membro(), false) then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;

  v_admin := coalesce(public.eh_admin(), false);

  -- Meia-noite de São Paulo do primeiro dia e do dia seguinte ao último.
  v_de  := p_inicio::timestamp at time zone 'America/Sao_Paulo';
  v_ate := (p_fim + 1)::timestamp at time zone 'America/Sao_Paulo';

  with coorte as (
    select c.id, c.etapa_id, c.primeira_mensagem_em
    from public.contatos c
    where c.primeira_mensagem_em >= v_de
      and c.primeira_mensagem_em <  v_ate
  ),
  -- Etapas por onde cada contato da coorte passou: destino e origem do histórico
  -- e a etapa atual (a atual entra para não depender só do histórico).
  passagens as (
    select h.contato_id, h.para_etapa_id as etapa_id
    from public.contato_etapa_historico h
    join coorte k on k.id = h.contato_id
    where h.para_etapa_id is not null
    union
    select h.contato_id, h.de_etapa_id
    from public.contato_etapa_historico h
    join coorte k on k.id = h.contato_id
    where h.de_etapa_id is not null
    union
    select k.id, k.etapa_id
    from coorte k
    where k.etapa_id is not null
  ),
  resumo as (
    select p.contato_id,
           max(e.ordem) filter (where e.tipo <> 'perdido') as max_ordem_nao_perdida,
           array_agg(p.etapa_id) as etapas
    from passagens p
    join public.etapas e on e.id = p.etapa_id
    group by p.contato_id
  ),
  funil as (
    select e.id, e.nome, e.ordem, e.tipo,
           count(r.contato_id) as chegaram
    from public.etapas e
    left join resumo r
      on r.max_ordem_nao_perdida > e.ordem
      or e.id = any (r.etapas)
    where not e.arquivada
    group by e.id, e.nome, e.ordem, e.tipo
  ),
  primeiras_respostas as (
    select k.id,
           extract(epoch from (min(m.momento) - k.primeira_mensagem_em)) as segundos
    from coorte k
    join public.conversas cv on cv.contato_id = k.id
    join public.mensagens m on m.conversa_id = cv.id
    where m.direcao = 'saida'
      and m.status in ('enviada', 'entregue', 'lida')
      and m.momento >= k.primeira_mensagem_em
    group by k.id, k.primeira_mensagem_em
  )
  select jsonb_build_object(
    'leads_novos', (select count(*) from coorte),
    'funil', coalesce(
      (select jsonb_agg(
                jsonb_build_object(
                  'etapa_id', f.id,
                  'nome', f.nome,
                  'ordem', f.ordem,
                  'tipo', f.tipo,
                  'chegaram', f.chegaram
                )
                order by f.ordem, f.nome, f.id
              )
       from funil f),
      '[]'::jsonb),
    'ganhos', (select count(*)
               from coorte k
               join public.etapas e on e.id = k.etapa_id
               where e.tipo = 'ganho'),
    'perdidos', (select count(*)
                 from coorte k
                 join public.etapas e on e.id = k.etapa_id
                 where e.tipo = 'perdido'),
    'mediana_primeira_resposta_s', (select (percentile_cont(0.5) within group (order by pr.segundos))::numeric
                                    from primeiras_respostas pr),
    'passados_para_humano', (select count(*)
                             from coorte k
                             where exists (
                               select 1
                               from public.conversas cv
                               join public.rodadas r on r.conversa_id = cv.id
                               where cv.contato_id = k.id
                                 and r.passou_humano
                             )),
    'aguardando_agora', (select count(*)
                         from public.conversas cv
                         where cv.aguardando_humano_desde is not null)
  )
  into v_res;

  if v_admin then
    select coalesce(sum(ch.custo_usd), 0),
           count(*) filter (where ch.custo_origem = 'sem_preco')
    into v_custo, v_sem_preco
    from public.ia_chamadas ch
    where ch.criado_em >= v_de
      and ch.criado_em <  v_ate;

    v_res := v_res || jsonb_build_object('custo_usd', v_custo, 'chamadas_sem_preco', v_sem_preco);
  else
    v_res := v_res || jsonb_build_object('custo_usd', null, 'chamadas_sem_preco', null);
  end if;

  return v_res;
end;
$$;
