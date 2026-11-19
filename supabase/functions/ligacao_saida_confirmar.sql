-- Versão final da função public.ligacao_saida_confirmar (última definição em 0035_nina_ligacao_saida_funcoes.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.ligacao_saida_confirmar(p_ligacao uuid, p_id_externo text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ext text := nullif(btrim(coalesce(p_id_externo, '')), '');
  v_l   public.ligacoes%rowtype;
begin
  if p_ligacao is null or v_ext is null or v_ext like 'saida-%' then
    raise exception using message = 'ligacao_invalida', errcode = 'P0001';
  end if;
  select l.* into v_l from public.ligacoes l where l.id = p_ligacao for update;
  if not found or v_l.direcao <> 'saida' then
    return false;
  end if;
  if v_l.id_externo = v_ext then
    return true;
  end if;
  if v_l.id_externo <> 'saida-' || p_ligacao::text then
    return false;
  end if;
  update public.ligacoes l set id_externo = v_ext where l.id = p_ligacao;
  if v_l.mensagem_id is not null then
    update public.mensagens m set id_externo = 'ligacao:' || v_ext where m.id = v_l.mensagem_id;
  end if;
  return true;
end;
$$;
