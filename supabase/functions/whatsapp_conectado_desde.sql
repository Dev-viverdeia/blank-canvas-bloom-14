-- Versão final da função public.whatsapp_conectado_desde (última definição em 0043_nina_retornos_regras.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.whatsapp_conectado_desde()
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(
           coalesce((select max(ev.criado_em) from public.conexao_eventos ev
                      where ev.conexao_id = cx.id and ev.ativa_para
                        and ev.ativa_de is distinct from true),
                    cx.criado_em),
           coalesce((select max(ev.criado_em) from public.conexao_eventos ev
                      where ev.conexao_id = cx.id and ev.status_para = 'conectada'
                        and ev.status_de is distinct from 'conectada'),
                    cx.criado_em))
    from public.conexoes cx
   where cx.ativa and cx.status = 'conectada'
   limit 1;
$$;
