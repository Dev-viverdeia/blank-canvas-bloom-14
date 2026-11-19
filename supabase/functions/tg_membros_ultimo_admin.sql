-- Versão final da função public.tg_membros_ultimo_admin (última definição em 0000_nina_estrutura_inicial.sql).
-- Referência: quem aplica é a pasta migrations.

create function public.tg_membros_ultimo_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.papel = 'admin' and old.ativo and old.user_id is not null
     and (tg_op = 'DELETE' or new.papel <> 'admin' or not new.ativo or new.user_id is null) then
    perform pg_advisory_xact_lock(hashtext('nina.membros_admin'));
    if not exists (
      select 1 from public.membros m
      where m.id <> old.id and m.papel = 'admin' and m.ativo and m.user_id is not null
    ) then
      raise exception using message = 'ultimo_admin', errcode = 'P0001';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
