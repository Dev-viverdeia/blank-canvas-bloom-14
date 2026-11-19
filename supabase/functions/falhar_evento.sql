-- Versão final da função public.falhar_evento (última definição em 0020_nina_motor_acordado.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.falhar_evento(p_id bigint, p_erro text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.eventos_webhook e
     set erro = left(p_erro, 200),
         tentativas = e.tentativas + 1,
         pego_em = null
   where e.id = p_id
     and e.processado_em is null;
end;
$$;
