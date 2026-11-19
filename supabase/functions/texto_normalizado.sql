-- Versão final da função public.texto_normalizado (última definição em 0002_nina_funcoes_fila_dashboard.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.texto_normalizado(p_texto text)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select nullif(regexp_replace(btrim(coalesce(p_texto, ''), E' \t\r\n'), '\s+', ' ', 'g'), '')
$$;
