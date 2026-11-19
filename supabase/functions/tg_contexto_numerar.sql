-- Versão final da função public.tg_contexto_numerar (última definição em 0009_nina_ligacao_equipe_contexto.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.tg_contexto_numerar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('nina.contexto'));
  select coalesce(max(cv.numero), 0) + 1 into new.numero from public.contexto_versoes cv;
  return new;
end;
$$;
