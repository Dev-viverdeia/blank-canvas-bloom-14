-- Versão final da função public.reativar_membro (última definição em 0009_nina_ligacao_equipe_contexto.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.reativar_membro(p_membro uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_eu   uuid;
  v_alvo public.membros%rowtype;
begin
  if not coalesce(public.eh_admin(), false) then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;
  v_eu := public.membro_atual();
  if p_membro = v_eu then
    raise exception using message = 'proprio_membro', errcode = 'P0001';
  end if;

  select m.* into v_alvo from public.membros m where m.id = p_membro for update;
  if not found then
    raise exception using message = 'nao_encontrado', errcode = 'P0001';
  end if;
  if v_alvo.ativo then
    return;
  end if;

  update public.membros m set ativo = true where m.id = p_membro;

  insert into public.auditoria (ator_membro_id, acao, alvo, detalhe)
  values (v_eu, 'membro_reativado', p_membro::text, jsonb_build_object('nome', v_alvo.nome));
end;
$$;
