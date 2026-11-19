-- Versão final da função public.desativar_membro (última definição em 0009_nina_ligacao_equipe_contexto.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.desativar_membro(p_membro uuid)
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_eu     uuid;
  v_alvo   public.membros%rowtype;
  v_ids    uuid[];
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
    update public.membros m set ativo = false where m.id = p_membro;
  end if;

  with devolvidas as (
    update public.conversas c
       set responsavel_id = null,
           aguardando_humano_desde = now()
     where c.responsavel_id = p_membro
    returning c.id
  ), eventos as (
    insert into public.conversa_eventos (conversa_id, tipo, de, de_membro_id)
    select d.id, 'voltou_para_fila', 'outro', p_membro from devolvidas d
    returning conversa_id
  )
  select coalesce(array_agg(e.conversa_id order by e.conversa_id), '{}'::uuid[])
    into v_ids
    from eventos e;

  if v_alvo.ativo or cardinality(v_ids) > 0 then
    insert into public.auditoria (ator_membro_id, acao, alvo, detalhe)
    values (v_eu, 'membro_desativado', p_membro::text,
            jsonb_build_object('nome', v_alvo.nome, 'conversas_devolvidas', cardinality(v_ids)));
  end if;

  return v_ids;
end;
$$;
