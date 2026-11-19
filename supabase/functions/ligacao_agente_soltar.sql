-- Versão final da função public.ligacao_agente_soltar (última definição em 0039_nina_ligar_com_agente_corridas.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.ligacao_agente_soltar(p_agente uuid)
returns table (motivo text, id_externo text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_a public.ligacao_agentes%rowtype;
begin
  -- a linha travada: uma reserva de saída com este agente (que trava a linha para leitura) termina
  -- antes, e a ligação dela é vista; uma que vier depois vê o agente sem id e recusa
  select a.* into v_a from public.ligacao_agentes a where a.id = p_agente for update;
  if not found then
    return query select 'nao_encontrado'::text, null::text;
    return;
  end if;
  if v_a.atende then
    return query select 'atende'::text, null::text;
    return;
  end if;
  if exists (select 1 from public.ligacoes l
              where l.agente_id = p_agente and l.status = 'em_andamento'
                and l.iniciada_em > now() - interval '32 minutes') then
    return query select 'em_ligacao'::text, null::text;
    return;
  end if;
  update public.ligacao_agentes a
     set id_externo = null, sincronizado_em = null
   where a.id = p_agente;
  return query select null::text, v_a.id_externo;
end;
$$;
