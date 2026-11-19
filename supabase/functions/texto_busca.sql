-- Versão final da função public.texto_busca (última definição em 0007_nina_ligacao_leituras.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.texto_busca(p_texto text)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select btrim(regexp_replace(
    lower(translate(
      p_texto,
      'ÁÀÂÃÄÅáàâãäåÇçÉÈÊËéèêëÍÌÎÏíìîïÑñÓÒÔÕÖóòôõöÚÙÛÜúùûüÝýÿ',
      'AAAAAAaaaaaaCcEEEEeeeeIIIIiiiiNnOOOOOoooooUUUUuuuuYyy'
    )),
    '\s+', ' ', 'g'
  ))
$$;
