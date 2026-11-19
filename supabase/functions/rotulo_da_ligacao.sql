-- Versão final da função public.rotulo_da_ligacao (última definição em 0024_nina_ligacoes_funcoes.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.rotulo_da_ligacao(p_status public.ligacao_status, p_duracao_s integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_status = 'em_andamento' then 'Ligação em andamento'
    when p_status = 'nao_completada' then 'Ligação não completada'
    when p_duracao_s is null then 'Ligação'
    when p_duracao_s < 60 then 'Ligação · ' || p_duracao_s || ' s'
    when p_duracao_s % 60 = 0 then 'Ligação · ' || (p_duracao_s / 60) || ' min'
    else 'Ligação · ' || (p_duracao_s / 60) || ' min ' || (p_duracao_s % 60) || ' s'
  end
$$;
