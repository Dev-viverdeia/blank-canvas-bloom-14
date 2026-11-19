-- Versão final da função public.motor_endereco (última definição em 0020_nina_motor_acordado.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.motor_endereco(p_url text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.motor (id) values (true)
  on conflict (id) do nothing;
  if p_url is null
     or char_length(p_url) > 261
     or p_url !~ '^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]([a-z0-9-]*[a-z0-9])?$' then
    return false;
  end if;
  update public.motor mo
     set url = p_url, url_em = now()
   where mo.id and mo.url is distinct from p_url;
  return found;
end;
$$;
