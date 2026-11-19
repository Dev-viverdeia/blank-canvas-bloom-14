-- Versão final da função public.cancelar_retorno (última definição em 0044_nina_retornos_funcoes.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.cancelar_retorno(p_retorno uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membro uuid := public.membro_atual();
  v_conv   uuid;
begin
  perform 1 from public.membros m where m.id = v_membro and m.ativo for share;
  if not found then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;

  select rt.conversa_id into v_conv from public.retornos rt where rt.id = p_retorno;
  if not found then
    raise exception using message = 'retorno_nao_pendente', errcode = 'P0001';
  end if;

  perform 1 from public.conversas c where c.id = v_conv for update;

  update public.retornos rt
     set status = 'cancelado', cancelado_por = v_membro, resolvido_em = now()
   where rt.id = p_retorno and rt.status = 'pendente';
  if not found then
    raise exception using message = 'retorno_nao_pendente', errcode = 'P0001';
  end if;
end;
$$;
