-- Versão final da função public.marcar_lida (última definição em 0002_nina_funcoes_fila_dashboard.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.marcar_lida(p_conversa uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membro uuid := public.membro_atual();
begin
  update public.conversas c set nao_lidas = 0 where c.id = p_conversa;
  if not found then
    raise exception using message = 'conversa_nao_encontrada', errcode = 'P0001';
  end if;
end;
$$;
