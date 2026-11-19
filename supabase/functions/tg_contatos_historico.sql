-- Versão final da função public.tg_contatos_historico (última definição em 0000_nina_estrutura_inicial.sql).
-- Referência: quem aplica é a pasta migrations.

create function public.tg_contatos_historico()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rodada uuid;
  v_membro uuid;
  v_ator public.historico_ator;
begin
  if tg_op = 'UPDATE' and new.etapa_id is not distinct from old.etapa_id then
    return null;
  end if;

  v_rodada := nullif(current_setting('nina.rodada_id', true), '')::uuid;
  if v_rodada is not null then
    v_ator := 'nina';
  else
    if auth.uid() is not null then
      select m.id into v_membro from public.membros m where m.user_id = auth.uid();
    end if;
    v_ator := case when v_membro is not null then 'membro' else 'sistema' end;
  end if;

  insert into public.contato_etapa_historico (contato_id, de_etapa_id, para_etapa_id, ator, membro_id, rodada_id)
  values (
    new.id,
    case when tg_op = 'UPDATE' then old.etapa_id end,
    new.etapa_id,
    v_ator,
    v_membro,
    v_rodada
  );
  return null;
end;
$$;
