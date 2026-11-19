-- Versão final da função public.retorno_ao_falhar (última definição em 0044_nina_retornos_funcoes.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.retorno_ao_falhar(
  p_rodada uuid, p_passageiro boolean, p_tentativa smallint, p_modo public.conversa_modo)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rt public.retornos;
begin
  select rt.* into v_rt
    from public.rodadas rd
    join public.retornos rt on rt.id = rd.retorno_id
   where rd.id = p_rodada and rt.status = 'em_rodada' and rt.rodada_id = p_rodada
     for update of rt;
  if not found then
    return;
  end if;

  if v_rt.tipo = 'lembrete' then
    update public.retornos rt
       set status = 'nao_enviado',
           nao_enviado_motivo = case when p_modo is distinct from 'nina'
                                     then 'com_equipe' else 'nina_falhou' end,
           resolvido_em = now()
     where rt.id = v_rt.id;
    return;
  end if;

  if p_modo is distinct from 'nina' then
    if now() < v_rt.vence_em then
      perform public.retorno_volta(v_rt.id, now(), p_rodada);
    else
      update public.retornos rt
         set status = 'nao_enviado', nao_enviado_motivo = 'com_equipe', resolvido_em = now()
       where rt.id = v_rt.id;
    end if;
    return;
  end if;

  if coalesce(p_passageiro, false) and coalesce(p_tentativa, 1) < 3 then
    perform public.retorno_volta(v_rt.id, now() + interval '30 seconds', p_rodada);
    return;
  end if;

  -- o retorno levado na mista antes da hora não acaba antes dela: volta, e na hora quem decide é a
  -- varredura A (a falha definitiva levou a conversa à equipe) ou a faixa 1 (já devolvida)
  if now() < v_rt.vence_em then
    perform public.retorno_volta(v_rt.id, now(), p_rodada);
    return;
  end if;

  update public.retornos rt
     set status = 'nao_enviado', nao_enviado_motivo = 'nina_falhou', resolvido_em = now()
   where rt.id = v_rt.id;
end;
$$;
