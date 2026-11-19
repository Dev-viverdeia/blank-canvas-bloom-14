-- Versão final da função public.tg_auth_primeira_conta (última definição em 0000_nina_estrutura_inicial.sql).
-- Referência: quem aplica é a pasta migrations.

create function public.tg_auth_primeira_conta()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('nina.primeira_conta'));
  if new.email is not null and not exists (select 1 from public.membros) then
    insert into public.membros (user_id, nome, email, papel)
    values (
      new.id,
      coalesce(nullif(btrim(new.raw_user_meta_data ->> 'nome'), ''),
               nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
               nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
               lower(btrim(new.email))),
      lower(btrim(new.email)),
      'admin'
    );
  end if;
  return null;
end;
$$;
