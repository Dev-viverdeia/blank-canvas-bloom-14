-- Versão final da função public.acordar_motor (última definição em 0020_nina_motor_acordado.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.acordar_motor(p_renovar boolean default false)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text;
  v_chave  text;
  v_tocado timestamptz;
  v_visto  timestamptz;
begin
  select mo.url, mo.chave, mo.tocado_em into v_url, v_chave, v_tocado
    from public.motor mo where mo.id
     for update;
  if v_url is null then
    return 'sem_endereco';
  end if;
  if coalesce(p_renovar, false) then
    if v_tocado > now() - interval '10 seconds' then
      return 'recente';
    end if;
  else
    select cf.worker_visto_em into v_visto from public.configuracao cf where cf.id = 1;
    if v_tocado > now() - interval '40 seconds' or v_visto > now() - interval '40 seconds' then
      return 'recente';
    end if;
  end if;
  perform net.http_post(
    url := v_url || '/api/public/cron/mensageria',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-nina-motor', v_chave),
    timeout_milliseconds := 60000
  );
  update public.motor mo set tocado_em = now() where mo.id;
  return 'tocado';
end;
$$;
