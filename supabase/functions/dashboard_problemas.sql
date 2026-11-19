-- Versão final da função public.dashboard_problemas (última definição em 0008_nina_ligacao_dashboard.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.dashboard_problemas(p_de timestamptz, p_ate timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_corte timestamptz;
  v_ia jsonb;
  v_envio jsonb;
  v_midia jsonb;
  v_conexao jsonb;
begin
  if not coalesce(public.eh_membro(), false) then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;
  if p_de is null or p_ate is null or p_ate <= p_de or p_ate - p_de > interval '367 days' then
    raise exception using message = 'periodo_invalido', errcode = 'P0001';
  end if;

  -- 1. Falhas da IA. Começa da última rodada concluída antes do período: o que
  --    vem antes dela é outro problema.
  select max(r.terminada_em) into v_corte
    from public.rodadas r
   where r.status = 'concluida' and r.terminada_em < p_de;

  with ev as (
    select r.id, r.conversa_id, (r.status = 'falhou') as falhou, r.motivo, r.terminada_em as t
      from public.rodadas r
     where r.status in ('concluida', 'falhou')
       and r.terminada_em is not null
       and r.terminada_em > coalesce(v_corte, '-infinity'::timestamptz)
       and r.terminada_em < p_ate
  ),
  l as (
    select ev.*,
           lag(ev.falhou) over w as falhou_antes,
           lag(ev.motivo) over w as motivo_antes
      from ev
    window w as (order by ev.t, ev.id)
  ),
  g as (
    select l.*,
           sum(case when l.falhou and (l.falhou_antes is distinct from true or l.motivo_antes is distinct from l.motivo)
                    then 1 else 0 end) over (order by l.t, l.id) as grupo
      from l
  ),
  runs as (
    select g.grupo, g.motivo, min(g.t) as inicio, max(g.t) as fim, count(*) as falhas,
           (array_agg(g.id order by g.t, g.id))[1] as primeira
      from g
     where g.falhou
     group by g.grupo, g.motivo
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', 'falha_ia:' || x.primeira::text,
           'tipo', 'falha_ia',
           'quando', x.inicio,
           'fim', x.fim,
           'durMin', round(extract(epoch from (x.fim - x.inicio))::numeric / 60)::bigint,
           'motivo', x.motivo,
           'quantidade', x.falhas,
           'conversasAfetadas', (select count(distinct e.conversa_id)
                                   from public.conversa_eventos e
                                  where e.tipo = 'passou' and e.motivo is not distinct from x.motivo
                                    and e.criado_em >= x.inicio and e.criado_em <= x.fim))), '[]'::jsonb)
    into v_ia
    from runs x
   where x.inicio >= p_de;

  -- 2. Envios que falharam (Nina e tela; o celular não passa pelo nosso envio).
  select max(m.momento) into v_corte
    from public.mensagens m
   where m.direcao = 'saida' and m.origem in ('nina', 'humano_tela')
     and m.status in ('enviada', 'entregue', 'lida') and m.momento < p_de;

  with ev as (
    select x.id, x.conversa_id, x.falhou, x.t
      from (select m.id, m.conversa_id, (m.status = 'falhou') as falhou,
                   case when m.status = 'falhou' then coalesce(m.status_em, m.momento) else m.momento end as t
              from public.mensagens m
             where m.direcao = 'saida' and m.origem in ('nina', 'humano_tela')
               and m.status in ('enviada', 'entregue', 'lida', 'falhou')) x
     where x.t > coalesce(v_corte, '-infinity'::timestamptz) and x.t < p_ate
  ),
  g as (
    select ev.*, sum(case when ev.falhou then 0 else 1 end) over (order by ev.t, ev.id) as grupo
      from ev
  ),
  runs as (
    select g.grupo, min(g.t) as inicio, max(g.t) as fim, count(*) as n,
           count(distinct g.conversa_id) as conversas,
           (array_agg(g.id order by g.t, g.id))[1] as primeira
      from g
     where g.falhou
     group by g.grupo
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', 'envio:' || x.primeira::text,
           'tipo', 'envio',
           'quando', x.inicio,
           'fim', x.fim,
           'durMin', round(extract(epoch from (x.fim - x.inicio))::numeric / 60)::bigint,
           'motivo', null,
           'quantidade', x.n,
           'conversasAfetadas', x.conversas)), '[]'::jsonb)
    into v_envio
    from runs x
   where x.inicio >= p_de;

  -- 3. Mídias recebidas que não foram copiadas.
  select max(m.momento) into v_corte
    from public.mensagens m
   where m.midia_ref_externa is not null and m.midia_status = 'copiada' and m.momento < p_de;

  with ev as (
    select m.id, m.conversa_id, (m.midia_status = 'falhou') as falhou, m.momento as t
      from public.mensagens m
     where m.midia_ref_externa is not null
       and m.midia_status in ('copiada', 'falhou')
       and m.momento > coalesce(v_corte, '-infinity'::timestamptz) and m.momento < p_ate
  ),
  g as (
    select ev.*, sum(case when ev.falhou then 0 else 1 end) over (order by ev.t, ev.id) as grupo
      from ev
  ),
  runs as (
    select g.grupo, min(g.t) as inicio, max(g.t) as fim, count(*) as n,
           count(distinct g.conversa_id) as conversas,
           (array_agg(g.id order by g.t, g.id))[1] as primeira
      from g
     where g.falhou
     group by g.grupo
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', 'midia:' || x.primeira::text,
           'tipo', 'midia',
           'quando', x.inicio,
           'fim', x.fim,
           'durMin', round(extract(epoch from (x.fim - x.inicio))::numeric / 60)::bigint,
           'motivo', null,
           'quantidade', x.n,
           'conversasAfetadas', x.conversas)), '[]'::jsonb)
    into v_midia
    from runs x
   where x.inicio >= p_de;

  -- 4. Quedas da conexão ativa: de uma ida para desconectada/erro até a volta a conectada.
  with ev as (
    select e.id, e.conexao_id, e.status_para, e.ativa_para, e.criado_em as t,
           sum(case when e.status_para = 'conectada' then 1 else 0 end)
             over (partition by e.conexao_id order by e.criado_em, e.id) as grupo
      from public.conexao_eventos e
     where e.criado_em < p_ate
  ),
  runs as (
    select ev.conexao_id, ev.grupo, min(ev.t) as inicio, count(*) as n,
           (array_agg(ev.id order by ev.t, ev.id))[1] as primeira
      from ev
     where ev.status_para in ('desconectada', 'erro') and ev.ativa_para
     group by ev.conexao_id, ev.grupo
  ),
  com_fim as (
    select x.*,
           (select min(e2.criado_em)
              from public.conexao_eventos e2
             where e2.conexao_id = x.conexao_id and e2.status_para = 'conectada' and e2.criado_em > x.inicio) as fim
      from runs x
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', 'conexao:' || x.primeira::text,
           'tipo', 'conexao',
           'quando', x.inicio,
           'fim', x.fim,
           'durMin', round(extract(epoch from (coalesce(x.fim, now()) - x.inicio))::numeric / 60)::bigint,
           'motivo', null,
           'quantidade', x.n,
           'conversasAfetadas', 0)), '[]'::jsonb)
    into v_conexao
    from com_fim x
   where x.inicio >= p_de;

  return coalesce((
    select jsonb_agg(p.v order by (p.v ->> 'quando')::timestamptz desc, p.v ->> 'id')
      from jsonb_array_elements(v_ia || v_envio || v_midia || v_conexao) as p(v)
  ), '[]'::jsonb);
end;
$$;
