-- Versão final da função public.tg_mensagens_envio_falhou (última definição em 0018_nina_lacunas_gatilho.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.tg_mensagens_envio_falhou()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_modo public.conversa_modo;
begin
  select c.modo into v_modo from public.conversas c where c.id = new.conversa_id for update;

  if v_modo is distinct from 'nina' then
    return null;
  end if;

  update public.conversas c
     set modo = 'humano',
         aguardando_humano_desde = now(),
         motivo_humano = 'envio_falhou',
         responder_apos = null
   where c.id = new.conversa_id;

  -- a Nina para nela: as outras bolhas dela na fila não saem
  update public.mensagens m
     set status = 'cancelada', status_em = now()
   where m.id in (select f.id
                    from public.mensagens f
                   where f.conversa_id = new.conversa_id
                     and f.origem = 'nina' and f.status = 'na_fila'
                     for update skip locked);

  -- a Nina para nela: a rodada que ainda roda nessa conversa é cancelada e solta as entradas
  with canceladas as (
    update public.rodadas r
       set status = 'cancelada', terminada_em = now()
     where r.id in (select k.id
                      from public.rodadas k
                     where k.conversa_id = new.conversa_id
                       and k.status = 'rodando' and not k.passou_humano
                       for update skip locked)
    returning r.id
  )
  update public.mensagens m
     set rodada_id = null
   where m.id in (select e.id
                    from public.mensagens e
                    join canceladas k on k.id = e.rodada_id
                   where e.direcao = 'entrada'
                     for update of e skip locked);

  if new.rodada_id is not null then
    update public.rodadas r set foi_para_equipe = true where r.id = new.rodada_id;
  end if;

  insert into public.conversa_eventos (conversa_id, tipo, motivo)
  values (new.conversa_id, 'passou', 'envio_falhou');

  return null;
end;
$$;
