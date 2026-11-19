-- Versão final da função public.tg_conexoes_eventos (última definição em 0005_0005_nina_ligacao_tabelas.sql).
-- Referência: quem aplica é a pasta migrations.

create function public.tg_conexoes_eventos()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membro uuid;
begin
  if new.status is not distinct from old.status and new.ativa is not distinct from old.ativa then
    return null;
  end if;
  if auth.uid() is not null then
    select m.id into v_membro from public.membros m where m.user_id = auth.uid();
  end if;
  insert into public.conexao_eventos (conexao_id, status_de, status_para, ativa_de, ativa_para, ultimo_erro, ator_membro_id)
  values (new.id, old.status, new.status, old.ativa, new.ativa, new.ultimo_erro, v_membro);
  return null;
end;
$$;
