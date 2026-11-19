-- Versão final da função public.concluir_onboarding (última definição em 0009_nina_ligacao_equipe_contexto.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.concluir_onboarding()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_em timestamptz;
begin
  if not coalesce(public.eh_admin(), false) then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;

  select cf.onboarding_concluido_em into v_em from public.configuracao cf where cf.id = 1 for update;
  if v_em is not null then
    return v_em;
  end if;

  insert into public.configuracao as cf (id, onboarding_concluido_em)
  values (1, now())
  on conflict (id) do update
    set onboarding_concluido_em = coalesce(cf.onboarding_concluido_em, excluded.onboarding_concluido_em)
  returning onboarding_concluido_em into v_em;

  return v_em;
end;
$$;
