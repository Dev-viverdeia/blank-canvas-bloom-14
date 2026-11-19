-- Versão final da função public.dashboard_etapa_em (última definição em 0008_nina_ligacao_dashboard.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.dashboard_etapa_em(p_contato uuid, p_instante timestamptz)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select h.para_etapa_id
       from public.contato_etapa_historico h
      where h.contato_id = p_contato and h.criado_em <= p_instante
      order by h.criado_em desc, h.id desc
      limit 1),
    (select coalesce(h.de_etapa_id, h.para_etapa_id)
       from public.contato_etapa_historico h
      where h.contato_id = p_contato
      order by h.criado_em, h.id
      limit 1),
    (select c.etapa_id from public.contatos c where c.id = p_contato)
  )
$$;
