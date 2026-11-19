-- Versão final da função public.tg_conexoes_segredos_formato (última definição em 0000_nina_estrutura_inicial.sql).
-- Referência: quem aplica é a pasta migrations.

create function public.tg_conexoes_segredos_formato()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.segredos is not null and (
       jsonb_typeof(new.segredos) <> 'object'
       or jsonb_path_exists(
            new.segredos,
            'strict $.* ? (@.type() != "string" || !(@ like_regex "^v[0-9]+:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$"))',
            '{}'::jsonb,
            true)
       or jsonb_path_exists(
            new.segredos,
            'strict $.keyvalue() ? (!(@.key like_regex "^[a-z][A-Za-z0-9_]{0,39}$"))',
            '{}'::jsonb,
            true)
     ) then
    raise exception using message = 'segredo_fora_do_formato', errcode = '23514';
  end if;
  return new;
end;
$$;
