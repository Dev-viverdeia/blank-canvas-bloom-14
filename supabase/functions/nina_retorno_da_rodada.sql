-- Versão final da função public.nina_retorno_da_rodada (última definição em 0044_nina_retornos_funcoes.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.nina_retorno_da_rodada(p_rodada uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_r  public.rodadas;
  v_rt public.retornos;
begin
  select * into v_r from public.rodadas rd where rd.id = p_rodada;
  if not found or v_r.status not in ('rodando', 'cancelada') then
    raise exception using message = 'rodada_nao_rodando', errcode = 'P0001';
  end if;

  if v_r.retorno_id is not null then
    -- em_rodada nesta rodada; ou, só o retorno, num estado que o fim desta rodada ou o gatilho das
    -- bolhas dela ainda retomam (a rodada revivida pelo eco duplicado depois da varredura F ou A):
    -- pendente e solto, ou não enviado com a equipe, solto ou ainda nela
    select * into v_rt from public.retornos rt
     where rt.id = v_r.retorno_id
       and ((rt.status = 'em_rodada' and rt.rodada_id = p_rodada)
            or (rt.tipo = 'retorno'
                and ((rt.status = 'pendente' and rt.rodada_id is null)
                     or (rt.status = 'nao_enviado' and rt.nao_enviado_motivo = 'com_equipe'
                         and (rt.rodada_id is null or rt.rodada_id = p_rodada)))));
    if not found then
      return null;
    end if;
    return jsonb_build_object('da_rodada', true, 'retorno_id', v_rt.id, 'tipo', v_rt.tipo,
                              'vence_em', v_rt.vence_em, 'motivo', v_rt.motivo,
                              'marcado_em', v_rt.marcado_em, 'vencido', v_rt.vence_em <= now());
  end if;

  -- o pendente com o prazo vencido não aparece (a varredura C o fecha)
  select * into v_rt from public.retornos rt
   where rt.conversa_id = v_r.conversa_id and rt.tipo = 'retorno' and rt.status = 'pendente'
     and rt.expira_em > now()
   order by rt.vence_em
   limit 1;
  if not found then
    return null;
  end if;
  return jsonb_build_object('da_rodada', false, 'retorno_id', v_rt.id, 'tipo', v_rt.tipo,
                            'vence_em', v_rt.vence_em, 'motivo', v_rt.motivo,
                            'marcado_em', v_rt.marcado_em, 'vencido', v_rt.vence_em <= now());
end;
$$;
