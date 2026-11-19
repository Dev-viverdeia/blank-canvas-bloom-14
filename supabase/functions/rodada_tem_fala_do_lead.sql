-- Versão final da função public.rodada_tem_fala_do_lead (última definição em 0043_nina_retornos_regras.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.rodada_tem_fala_do_lead(p_rodada uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.mensagens m
     where m.rodada_id = p_rodada
       and m.direcao = 'entrada'
       and (m.tipo <> 'ligacao'
            or exists (select 1 from public.ligacoes l
                        where l.mensagem_id = m.id and l.status = 'concluida')));
$$;
