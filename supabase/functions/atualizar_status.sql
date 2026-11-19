-- Versão final da função public.atualizar_status (última definição em 0002_nina_funcoes_fila_dashboard.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.atualizar_status(
  p_conexao uuid, p_id text, p_status public.mensagem_status, p_momento timestamptz)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_casaram int;
begin
  if nullif(btrim(coalesce(p_id, '')), '') is null then
    return 0;
  end if;

  with alvo as (
    select m.id, m.status
    from public.mensagens m
    where m.conexao_id = p_conexao
      and m.direcao = 'saida'
      and (m.id_externo = p_id or m.id_gateway = p_id)
    for update
  ), muda as (
    update public.mensagens m
       set status = p_status,
           status_em = coalesce(p_momento, now()),
           erro = case when p_status = 'falhou' then 'falha_no_gateway' else m.erro end,
           momento = case when a.status in ('na_fila', 'enviando') and p_status <> 'falhou'
                          then coalesce(m.status_em, m.momento) else m.momento end
      from alvo a
     where m.id = a.id
       and (
         (p_status in ('enviada', 'entregue', 'lida')
          and a.status in ('na_fila', 'enviando', 'enviada', 'entregue')
          and array_position(array['na_fila', 'enviando', 'enviada', 'entregue', 'lida'], p_status::text)
            > array_position(array['na_fila', 'enviando', 'enviada', 'entregue', 'lida'], a.status::text))
         or (p_status = 'falhou' and a.status in ('enviando', 'enviada'))
       )
    returning m.id
  )
  select count(*) into v_casaram from alvo;

  return v_casaram;
end;
$$;
