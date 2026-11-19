-- Versão final da função public.tg_contatos_antes (última definição em 0000_nina_estrutura_inicial.sql).
-- Referência: quem aplica é a pasta migrations.

create function public.tg_contatos_antes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_arquivada boolean;
begin
  if tg_op = 'INSERT' then
    if new.etapa_id is null then
      -- FOR SHARE: conflita com o UPDATE que arquiva a etapa e põe os dois em fila
      -- (a trava da chave estrangeira sozinha não conflita).
      select e.id into new.etapa_id
      from public.etapas e
      where e.tipo = 'aberta' and not e.arquivada
      order by e.ordem, e.criado_em, e.id
      limit 1
      for share;
      if new.etapa_id is null then
        raise exception using message = 'sem_etapa_de_entrada', errcode = 'P0001';
      end if;
    end if;
  else
    new.atualizado_em := now();
    if new.etapa_id is not distinct from old.etapa_id then
      return new;
    end if;
    new.etapa_desde := now();
  end if;

  if new.etapa_id is not null then
    select e.arquivada into v_arquivada
    from public.etapas e where e.id = new.etapa_id
    for share;
    if coalesce(v_arquivada, false) then
      raise exception using message = 'etapa_arquivada', errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
