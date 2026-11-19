-- Versão final da função public.conversa_do_contato (última definição em 0002_nina_funcoes_fila_dashboard.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.conversa_do_contato(p_contato uuid, p_conexao uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conv uuid;
begin
  insert into public.conversas (contato_id, conexao_id)
  values (p_contato, p_conexao)
  on conflict (contato_id) do nothing
  returning id into v_conv;

  if v_conv is null then
    select c.id into v_conv from public.conversas c where c.contato_id = p_contato;
  end if;
  return v_conv;
end;
$$;
