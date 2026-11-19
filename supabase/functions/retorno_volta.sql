-- Versão final da função public.retorno_volta (última definição em 0043_nina_retornos_regras.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.retorno_volta(p_retorno uuid, p_quando timestamptz, p_rodada uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rt    public.retornos;
  v_outro uuid;
  v_desde timestamptz;
begin
  select * into v_rt from public.retornos rt where rt.id = p_retorno;
  if not found or v_rt.tipo <> 'retorno' or v_rt.status <> 'em_rodada' then
    return;
  end if;
  v_desde := public.whatsapp_conectado_desde();

  select o.id into v_outro
    from public.retornos o
   where o.conversa_id = v_rt.conversa_id and o.tipo = 'retorno' and o.status = 'pendente'
     and o.id <> p_retorno
   limit 1;

  if v_outro is not null then
    update public.retornos rt
       set status = 'cancelado',
           fechado_por_rodada = coalesce(p_rodada, rt.rodada_id),
           resolvido_em = now()
     where rt.id = p_retorno;
    update public.retornos o
       set substitui_id = coalesce(o.substitui_id, p_retorno)
     where o.id = v_outro;
  elsif v_rt.expira_em <= p_quando then
    -- a mesma regra da varredura C: o WhatsApp fora agora ou caído depois da hora é desconectado
    update public.retornos rt
       set status = 'nao_enviado',
           nao_enviado_motivo = case when v_desde is null or v_desde > v_rt.vence_em
                                     then 'desconectado' else 'passou_do_prazo' end,
           resolvido_em = now()
     where rt.id = p_retorno;
  else
    update public.retornos rt
       set status = 'pendente',
           tentar_apos = p_quando,
           rodada_id = null,
           resolvido_em = null,
           nao_enviado_motivo = null,
           enviado_em = null
     where rt.id = p_retorno;
  end if;
end;
$$;
