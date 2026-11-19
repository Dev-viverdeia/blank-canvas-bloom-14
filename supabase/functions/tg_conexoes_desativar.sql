-- Versão final da função public.tg_conexoes_desativar (última definição em 0000_nina_estrutura_inicial.sql).
-- Referência: quem aplica é a pasta migrations.

create function public.tg_conexoes_desativar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.ativa and not new.ativa then
    new.segredos := '{}'::jsonb;
  end if;
  return new;
end;
$$;
