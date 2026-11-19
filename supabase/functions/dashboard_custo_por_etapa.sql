-- Versão final da função public.dashboard_custo_por_etapa (última definição em 0008_nina_ligacao_dashboard.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.dashboard_custo_por_etapa(p_de timestamptz, p_ate timestamptz, p_estado_em timestamptz)
returns table (etapa_id uuid, usd numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select public.dashboard_etapa_em(c.id, ch.criado_em) as etapa_id,
         sum(ch.custo_usd) as usd
    from public.ia_chamadas ch
    left join public.rodadas r on r.id = ch.rodada_id
    join public.conversas cv on cv.id = coalesce(ch.conversa_id, r.conversa_id)
    join public.contatos c on c.id = cv.contato_id
   where ch.tipo = 'resposta'
     and ch.custo_usd is not null
     and ch.criado_em >= p_de and ch.criado_em < p_ate and ch.criado_em <= p_estado_em
     and c.primeira_mensagem_em >= p_de and c.primeira_mensagem_em < p_ate
     and c.primeira_mensagem_em <= p_estado_em
   group by 1
$$;
