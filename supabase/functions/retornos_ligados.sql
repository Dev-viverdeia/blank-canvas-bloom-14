-- Versão final da função public.retornos_ligados (última definição em 0044_nina_retornos_funcoes.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.retornos_ligados()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select mo.relogio_versao >= 1 from public.motor mo where mo.id), false)
     and exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = to_regprocedure('public.tg_mensagens_saida_do_retorno()')
                    and p.prosrc like '%retorno_pelas_bolhas%')
     and exists (select 1 from pg_catalog.pg_trigger tg
                  where tg.tgrelid = to_regclass('public.mensagens')
                    and tg.tgname = 'mensagens_saida_do_retorno'
                    and tg.tgenabled <> 'D')
     and exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = to_regprocedure('public.concluir_rodada(uuid, jsonb, jsonb, integer)')
                    and p.prosrc like '%retorno_ao_concluir%');
$$;
