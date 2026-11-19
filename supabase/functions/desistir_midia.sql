-- Versão final da função public.desistir_midia (última definição em 0017_nina_lacunas_funcoes.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.desistir_midia(p_msg uuid, p_erro text)
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

  update public.mensagens m
     set midia_status = 'falhou',
         midia_pega_em = null,
         erro = case when m.direcao = 'entrada'
                     then coalesce(nullif(btrim(coalesce(p_erro, '')), ''), m.erro)
                     else m.erro end
   where m.id = p_msg and m.midia_status = 'pendente';
end;
$$;
