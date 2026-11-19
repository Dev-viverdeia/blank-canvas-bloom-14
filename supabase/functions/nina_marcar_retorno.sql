-- Versão final da função public.nina_marcar_retorno (última definição em 0044_nina_retornos_funcoes.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.nina_marcar_retorno(
  p_rodada uuid, p_data date, p_hora time, p_motivo text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r        public.rodadas;
  v_c        public.conversas;
  v_motivo   text;
  v_quando   timestamptz;
  v_limite   timestamptz;
  v_igual    uuid;
  v_ant      uuid;
  v_ant_em   timestamptz;
  v_novo     uuid;
  v_conv     uuid;
begin
  -- a conversa antes da rodada (a ordem do Assumir); o conversa_id de uma rodada nunca muda
  select rd.conversa_id into v_conv from public.rodadas rd where rd.id = p_rodada;
  select * into v_c from public.conversas c where c.id = v_conv for update;
  v_r := public.rodada_rodando(p_rodada);

  if not public.rodada_tem_fala_do_lead(p_rodada) then
    raise exception using message = 'rodada_sem_lead', errcode = 'P0001';
  end if;

  -- os retornos desligados: sem o relógio da versão 1 (nina_retornos_relogio) ou sem o gatilho das
  -- bolhas (nina_retornos_rodada), o retorno marcado não sairia
  if not public.retornos_ligados() then
    raise exception using message = 'retornos_desligados', errcode = 'P0001';
  end if;

  if p_data is null or p_hora is null then
    raise exception using message = 'data_invalida', errcode = 'P0001';
  end if;
  v_motivo := btrim(coalesce(p_motivo, ''));
  if char_length(v_motivo) not between 1 and 300 then
    raise exception using message = 'motivo_invalido', errcode = 'P0001';
  end if;

  v_quando := public.retorno_instante(p_data, p_hora);

  -- a mesma hora: nada muda (antes das recusas de prazo: o levado vencido há pouco também é igual;
  -- o pendente com o prazo vencido, que a varredura C fecha, não). O levado antes da hora não é
  -- igual: a mesma hora grava um pendente novo (o lead adiou; o levado sai pelas bolhas)
  select rt.id into v_igual
    from public.retornos rt
   where rt.conversa_id = v_c.id and rt.tipo = 'retorno' and rt.vence_em = v_quando
     and ((rt.status = 'pendente' and rt.expira_em > now())
          or (rt.status = 'em_rodada' and rt.rodada_id = p_rodada and rt.vence_em <= now()))
   order by (rt.status = 'pendente') desc
   limit 1;
  if v_igual is not null then
    return jsonb_build_object('ok', true, 'retorno_id', v_igual, 'vence_em', v_quando,
                              'substituido_vence_em', null::timestamptz, 'igual', true);
  end if;

  if v_quando <= now() then
    return jsonb_build_object('ok', false, 'erro', 'no_passado', 'limite', null::timestamptz);
  end if;
  if v_quando > now() + interval '30 days' then
    return jsonb_build_object('ok', false, 'erro', 'longe_demais',
                              'limite', now() + interval '30 days');
  end if;
  if exists (select 1 from public.conexoes cx where cx.ativa and cx.oficial) then
    v_limite := v_c.ultima_do_lead_em + interval '23 hours 50 minutes';
    if v_limite is null or v_quando > v_limite then
      return jsonb_build_object('ok', false, 'erro', 'fora_das_24h', 'limite', v_limite);
    end if;
  end if;

  -- substitui só o pendente (o levado por esta rodada sai pelas bolhas dela)
  update public.retornos rt
     set status = 'cancelado', fechado_por_rodada = p_rodada, resolvido_em = now()
   where rt.conversa_id = v_c.id and rt.tipo = 'retorno' and rt.status = 'pendente'
  returning rt.id, rt.vence_em into v_ant, v_ant_em;

  -- marcar cancela o lembrete pendente
  delete from public.retornos rt
   where rt.conversa_id = v_c.id and rt.tipo = 'lembrete' and rt.status = 'pendente';

  insert into public.retornos (conversa_id, tipo, status, vence_em, expira_em, motivo, marcado_em,
                               rodada_origem_id, substitui_id)
  values (v_c.id, 'retorno', 'pendente', v_quando, v_quando + interval '3 hours', v_motivo, now(),
          p_rodada, v_ant)
  returning id into v_novo;

  return jsonb_build_object('ok', true, 'retorno_id', v_novo, 'vence_em', v_quando,
                            'substituido_vence_em', v_ant_em, 'igual', false);
end;
$$;
