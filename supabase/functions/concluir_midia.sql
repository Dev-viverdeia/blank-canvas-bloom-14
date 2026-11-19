-- Versão final da função public.concluir_midia (última definição em 0002_nina_funcoes_fila_dashboard.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.concluir_midia(
  p_msg uuid, p_caminho text, p_mime text, p_tamanho bigint, p_ok boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m public.mensagens;
begin
  select * into v_m from public.mensagens m where m.id = p_msg for update;
  if not found then
    raise exception using message = 'mensagem_nao_encontrada', errcode = 'P0001';
  end if;

  if coalesce(p_ok, false) then
    update public.mensagens m
       set midia_status = 'copiada',
           midia_caminho = p_caminho,
           midia_mime = coalesce(nullif(p_mime, ''), m.midia_mime),
           midia_tamanho = coalesce(p_tamanho, m.midia_tamanho),
           midia_pega_em = null
     where m.id = p_msg;
  else
    update public.mensagens m
       set midia_status = case when m.midia_tentativas >= 3 then 'falhou'::public.midia_status
                               else 'pendente'::public.midia_status end,
           midia_pega_em = null
     where m.id = p_msg and m.midia_status = 'pendente';
  end if;
end;
$$;
