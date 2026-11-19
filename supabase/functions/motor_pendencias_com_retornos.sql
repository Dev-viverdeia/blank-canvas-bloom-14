-- Versão final da função public.motor_pendencias_com_retornos (última definição em 0044_nina_retornos_funcoes.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.motor_pendencias_com_retornos()
returns table (proximo_em timestamptz, vencido_desde timestamptz, atrasado_desde timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_proximo  timestamptz;
  v_vencido  timestamptz;
  v_atrasado timestamptz;
  v_rt_prox  timestamptz;
  v_rt_rec   timestamptz;
  v_rt_venc  timestamptz;
begin
  -- a mesma trava da motor_pendencias, aqui também: a regra de acesso fica na função que tem o
  -- grant a authenticated
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and not coalesce(public.eh_membro(), false) then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;

  select mp.proximo_em, mp.vencido_desde, mp.atrasado_desde
    into v_proximo, v_vencido, v_atrasado
    from public.motor_pendencias() mp;

  -- a parte nova, protegida (B1): um defeito nela nunca derruba as pendências de hoje (o bastão, a
  -- renovação do toque e o "atrasada" da tela); no erro, só as de hoje. Desligados, a irmã não pega
  -- retorno nenhum: o retorno parado não acende o atraso
  begin
    if public.retornos_ligados() then
      select min(p.pronto_em) filter (where p.pronto_em > now()),
             min(p.pronto_em) filter (where p.pronto_em <= now()
                                        and p.pronto_em > now() - interval '10 minutes'),
             min(p.pronto_em) filter (where p.pronto_em <= now())
        into v_rt_prox, v_rt_rec, v_rt_venc
        from public.retornos_prontos() p
       where p.tipo = 'retorno';
    end if;
  exception when others then
    raise warning 'pendencias_retornos_falhou: %', sqlerrm;
    v_rt_prox := null;
    v_rt_rec := null;
    v_rt_venc := null;
  end;

  return query
    select least(v_proximo, v_rt_prox), least(v_vencido, v_rt_rec), least(v_atrasado, v_rt_venc);
end;
$$;
