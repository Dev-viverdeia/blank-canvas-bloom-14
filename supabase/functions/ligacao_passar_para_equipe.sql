-- Versão final da função public.ligacao_passar_para_equipe (última definição em 0024_nina_ligacoes_funcoes.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.ligacao_passar_para_equipe(p_ligacao uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lig public.ligacoes%rowtype;
begin
  select l.* into v_lig from public.ligacoes l where l.id = p_ligacao for update;
  if not found then
    raise exception using message = 'ligacao_nao_encontrada', errcode = 'P0001';
  end if;
  if v_lig.passou_equipe then
    return false;
  end if;

  update public.ligacoes l set passou_equipe = true where l.id = p_ligacao;

  update public.conversas c
     set modo = 'humano',
         motivo_humano = 'nina_passou',
         aguardando_humano_desde = coalesce(c.aguardando_humano_desde, now()),
         responder_apos = null
   where c.id = v_lig.conversa_id and c.modo = 'nina';
  if found then
    insert into public.conversa_eventos (conversa_id, tipo, motivo)
    values (v_lig.conversa_id, 'passou', 'nina_passou');
    return true;
  end if;
  return false;
end;
$$;
