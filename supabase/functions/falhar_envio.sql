-- Versão final da função public.falhar_envio (última definição em 0002_nina_funcoes_fila_dashboard.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.falhar_envio(p_msg uuid, p_erro text, p_definitivo boolean)
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
  if v_m.status not in ('na_fila', 'enviando') then
    return;
  end if;

  if coalesce(p_definitivo, false) or coalesce(v_m.tentativas, 0) >= 3 then
    update public.mensagens m
       set status = 'falhou', erro = p_erro, status_em = now()
     where m.id = p_msg;
  else
    update public.mensagens m
       set status = 'na_fila', erro = p_erro, status_em = now(),
           enviar_apos = now() + interval '30 seconds'
     where m.id = p_msg;
  end if;
end;
$$;
