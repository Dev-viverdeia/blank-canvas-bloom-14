-- Versão final da função public.motor_confere (última definição em 0020_nina_motor_acordado.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.motor_confere(p_chave text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return p_chave is not null
     and exists (select 1 from public.motor mo where mo.id and mo.chave = p_chave);
end;
$$;
