-- Versão final da função public.ligacao_agente_atender (última definição em 0024_nina_ligacoes_funcoes.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.ligacao_agente_atender(p_agente uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.ligacao_agentes a where a.id = p_agente) then
    raise exception using message = 'agente_nao_encontrado', errcode = 'P0001';
  end if;
  update public.ligacao_agentes a set atende = false where a.atende and a.id <> p_agente;
  update public.ligacao_agentes a set atende = true where a.id = p_agente and not a.atende;
end;
$$;
