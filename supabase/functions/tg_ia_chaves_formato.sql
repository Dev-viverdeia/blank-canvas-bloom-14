-- Versão final da função public.tg_ia_chaves_formato (última definição em 0000_nina_estrutura_inicial.sql).
-- Referência: quem aplica é a pasta migrations.

create function public.tg_ia_chaves_formato()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.chave_cifrada is not null
     and new.chave_cifrada !~ '^v[0-9]+:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$' then
    raise exception using message = 'segredo_fora_do_formato', errcode = '23514';
  end if;
  return new;
end;
$$;
