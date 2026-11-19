-- Versão final da função public.tg_contexto_autor (última definição em 0000_nina_estrutura_inicial.sql).
-- Referência: quem aplica é a pasta migrations.

create function public.tg_contexto_autor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.criado_por is null and auth.uid() is not null then
    select m.id into new.criado_por from public.membros m where m.user_id = auth.uid();
  end if;
  return new;
end;
$$;
