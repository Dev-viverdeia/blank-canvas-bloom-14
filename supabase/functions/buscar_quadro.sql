-- Versão final da função public.buscar_quadro (última definição em 0007_nina_ligacao_leituras.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.buscar_quadro(p_q text)
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_membro uuid := public.membro_atual();
  v_q      text := nullif(public.texto_busca(p_q), '');
begin
  if v_q is null then
    return;
  end if;
  return query
  select c.id
    from public.contatos c
    left join public.conversas cv on cv.contato_id = c.id
   where strpos(public.texto_busca(c.nome), v_q) > 0
      or strpos(public.texto_busca(c.empresa), v_q) > 0
      or strpos(public.texto_busca(c.nome_whatsapp), v_q) > 0
      or (cv.id is not null and exists (
            select 1
              from public.mensagens m
             where m.conversa_id = cv.id
               and m.apagada_em is null
               and (strpos(public.texto_busca(m.texto), v_q) > 0
                    or strpos(public.texto_busca(m.transcricao), v_q) > 0)))
   order by cv.ultima_mensagem_em desc nulls last, c.id
   limit 50;
end;
$$;
