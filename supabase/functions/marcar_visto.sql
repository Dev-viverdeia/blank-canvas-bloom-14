-- Versão final da função public.marcar_visto (última definição em 0007_nina_ligacao_leituras.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.marcar_visto(p_onde text)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membro uuid := public.membro_atual();
  v_agora  timestamptz := now();
begin
  if p_onde is null or p_onde not in ('kanban', 'tour') then
    raise exception using message = 'parametro_invalido', errcode = '22023', detail = 'p_onde';
  end if;
  update public.membros m
     set vistos = coalesce(m.vistos, '{}'::jsonb) || jsonb_build_object(p_onde, v_agora)
   where m.id = v_membro;
  if not found then
    raise exception using message = 'nao_encontrado', errcode = 'P0001';
  end if;
  return v_agora;
end;
$$;
