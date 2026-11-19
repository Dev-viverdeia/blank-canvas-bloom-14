-- Versão final da função public.nina_mover_etapa (última definição em 0006_nina_ligacao_conversa.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.nina_mover_etapa(p_rodada uuid, p_etapa uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.rodadas := public.rodada_rodando(p_rodada);
  v_contato uuid;
  v_devolvida timestamptz;
  v_atual uuid;
  v_tipo public.etapa_tipo;
  v_ator public.historico_ator;
  v_movido_em timestamptz;
begin
  if not exists (select 1 from public.etapas e
                 where e.id = p_etapa and e.nina_pode_mover and not e.arquivada) then
    raise exception using message = 'etapa_nao_permitida', errcode = 'P0001';
  end if;

  select c.contato_id, c.devolvida_em into v_contato, v_devolvida
  from public.conversas c where c.id = v_r.conversa_id;

  -- novo: as travas da decisão 3 (o contato fica travado até o fim, contra um
  -- movimento de pessoa ao mesmo tempo)
  select ct.etapa_id, e.tipo into v_atual, v_tipo
  from public.contatos ct
  join public.etapas e on e.id = ct.etapa_id
  where ct.id = v_contato
  for update of ct;

  if v_atual is not distinct from p_etapa then
    return;
  end if;
  if v_tipo in ('ganho', 'perdido') then
    raise exception using message = 'etapa_travada', errcode = 'P0001';
  end if;

  select h.ator, h.criado_em into v_ator, v_movido_em
  from public.contato_etapa_historico h
  where h.contato_id = v_contato
  order by h.criado_em desc, h.id desc
  limit 1;
  if v_ator = 'membro' and (v_devolvida is null or v_devolvida <= v_movido_em) then
    raise exception using message = 'etapa_travada', errcode = 'P0001';
  end if;

  -- o gatilho de historico le esta marca e grava ator = nina
  perform set_config('nina.rodada_id', p_rodada::text, true);

  update public.contatos c
     set etapa_id = p_etapa, etapa_desde = now(), atualizado_em = now()
   where c.id = v_contato and c.etapa_id is distinct from p_etapa;
end;
$$;
