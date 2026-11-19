-- Versão final da função public.rodada_rodando (última definição em 0002_nina_funcoes_fila_dashboard.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.rodada_rodando(p_rodada uuid)
returns public.rodadas
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.rodadas;
begin
  select * into v_r from public.rodadas r where r.id = p_rodada for update;
  if not found or v_r.status <> 'rodando' then
    raise exception using message = 'rodada_nao_rodando', errcode = 'P0001';
  end if;
  return v_r;
end;
$$;
