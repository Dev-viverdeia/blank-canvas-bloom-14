-- Versão final da função public.membro_atual (última definição em 0002_nina_funcoes_fila_dashboard.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.membro_atual()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_membro uuid;
begin
  if not coalesce(public.eh_membro(), false) then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;
  select m.id into v_membro from public.membros m where m.user_id = auth.uid() and m.ativo;
  if v_membro is null then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;
  return v_membro;
end;
$$;
