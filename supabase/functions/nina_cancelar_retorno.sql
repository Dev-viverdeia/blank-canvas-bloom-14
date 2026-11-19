-- Versão final da função public.nina_cancelar_retorno (última definição em 0044_nina_retornos_funcoes.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.nina_cancelar_retorno(p_rodada uuid, p_motivo text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r     public.rodadas;
  v_id    uuid;
  v_vence timestamptz;
  v_conv  uuid;
begin
  -- a conversa antes da rodada (a ordem do Assumir); o conversa_id de uma rodada nunca muda
  select rd.conversa_id into v_conv from public.rodadas rd where rd.id = p_rodada;
  perform 1 from public.conversas c where c.id = v_conv for update;
  v_r := public.rodada_rodando(p_rodada);

  if not public.rodada_tem_fala_do_lead(p_rodada) then
    raise exception using message = 'rodada_sem_lead', errcode = 'P0001';
  end if;

  with fecha as (
    update public.retornos rt
       set status = 'cancelado',
           fechado_por_rodada = p_rodada,
           resolvido_em = now(),
           nota_fim = nullif(left(btrim(coalesce(p_motivo, '')), 300), '')
     where rt.conversa_id = v_r.conversa_id and rt.tipo = 'retorno'
       and ((rt.status = 'em_rodada' and rt.rodada_id = p_rodada)
            or (rt.status = 'pendente'
                -- na mista, o pendente que esta rodada marcou fica (o exists lê o estado de antes
                -- deste update: ainda vê o levado em_rodada)
                and not (rt.rodada_origem_id is not distinct from p_rodada
                         and exists (select 1 from public.retornos lv
                                      where lv.conversa_id = v_r.conversa_id and lv.tipo = 'retorno'
                                        and lv.status = 'em_rodada' and lv.rodada_id = p_rodada))))
    returning rt.id, rt.vence_em, rt.rodada_id
  )
  select f.id, f.vence_em into v_id, v_vence
    from fecha f
   order by (f.rodada_id is null) desc, f.vence_em
   limit 1;

  if v_id is null then
    return jsonb_build_object('ok', false, 'erro', 'sem_retorno');
  end if;
  return jsonb_build_object('ok', true, 'retorno_id', v_id, 'vence_em', v_vence);
end;
$$;
