-- Versão final da função public.tg_etapas_arquivar (última definição em 0000_nina_estrutura_inicial.sql).
-- Referência: quem aplica é a pasta migrations.

create function public.tg_etapas_arquivar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_saindo boolean;
  v_perde_aberta boolean;
begin
  v_saindo := tg_op = 'DELETE' or (new.arquivada and not old.arquivada);
  v_perde_aberta := old.tipo = 'aberta' and not old.arquivada
    and (tg_op = 'DELETE' or new.arquivada or new.tipo <> 'aberta');

  if v_saindo or v_perde_aberta then
    perform pg_advisory_xact_lock(hashtext('nina.etapas'));
  end if;

  if v_saindo and exists (select 1 from public.contatos c where c.etapa_id = old.id) then
    raise exception using message = 'etapa_com_leads', errcode = 'P0001';
  end if;

  if v_perde_aberta and not exists (
    select 1 from public.etapas e
    where e.id <> old.id and e.tipo = 'aberta' and not e.arquivada
  ) then
    raise exception using message = 'sem_etapa_de_entrada', errcode = 'P0001';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
