-- Versão final da função public.tipo_de_mensagem (última definição em 0002_nina_funcoes_fila_dashboard.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.tipo_de_mensagem(p_tipo text)
returns public.mensagem_tipo
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_tipo = any (enum_range(null::public.mensagem_tipo)::text[])
              then p_tipo::public.mensagem_tipo
              else 'outro'::public.mensagem_tipo
         end
$$;
