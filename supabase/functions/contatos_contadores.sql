-- Versão final da função public.contatos_contadores (última definição em 0007_nina_ligacao_leituras.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.contatos_contadores()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_membro uuid := public.membro_atual();
  v_hoje   date := (now() at time zone 'America/Sao_Paulo')::date;
  v_r      jsonb;
begin
  select jsonb_build_object(
           'todos', count(*),
           'precisam', count(*) filter (
             where c.primeira_mensagem_em is not null and cv.modo = 'humano'
               and cv.responsavel_id is null and cv.aguardando_humano_desde is not null),
           'novos_hoje', count(*) filter (
             where c.primeira_mensagem_em is not null
               and (c.primeira_mensagem_em at time zone 'America/Sao_Paulo')::date = v_hoje),
           'com_nina', count(*) filter (
             where c.primeira_mensagem_em is not null and cv.modo = 'nina'),
           'comigo', count(*) filter (
             where c.primeira_mensagem_em is not null and cv.modo = 'humano'
               and cv.responsavel_id = v_membro))
    into v_r
    from public.contatos c
    left join public.conversas cv on cv.contato_id = c.id;
  return v_r;
end;
$$;
