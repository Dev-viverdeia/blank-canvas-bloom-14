-- nina_lacunas_gatilho (envio L3 das lacunas da mensageria, 02/11/2026).
-- Vai DEPOIS de publicar as telas que conhecem o motivo envio_falhou (sem isso, a
-- tela publicada mostraria um motivo sem texto). Depende do L1; não depende do L2.

-- ---------------------------------------------------------------------
-- Trava: sem o L1, este envio para aqui. O plpgsql só confere o valor do enum
-- quando a função roda; sem a trava, o L3 entraria sem erro e, na 1ª bolha da
-- Nina que falhasse, o gatilho daria 22P02 e travaria o pegar_envios (nenhuma
-- mensagem sairia mais). A trava só lê o catálogo e não usa o valor novo.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1
                   from pg_catalog.pg_enum e
                   join pg_catalog.pg_type t on t.oid = e.enumtypid
                   join pg_catalog.pg_namespace n on n.oid = t.typnamespace
                  where n.nspname = 'public' and t.typname = 'motivo_humano'
                    and e.enumlabel = 'envio_falhou') then
    raise exception using message = 'falta_o_L1_envio_falhou',
      hint = 'Aplique antes o L1 (nina_lacunas_enums): alter type public.motivo_humano add value if not exists ''envio_falhou''.';
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- Gatilho mensagens_envio_falhou (decisão 2): uma bolha da Nina que fica em
-- 'falhou' leva a conversa para a equipe com o motivo envio_falhou, e a Nina
-- para nela. Cobre todo caminho que grava 'falhou': falhar_envio, as duas
-- saídas de pegar_envios (sem_resposta_do_envio e conexao_inativa) e
-- atualizar_status (falha_no_gateway).
-- Igual ao ramo da equipe do falhar_rodada (0006): trava a conversa, só mexe
-- quando ela ainda está em modo nina, marca a rodada com foi_para_equipe e
-- grava o evento 'passou'. Conversa fora de nina (a equipe já assumiu, ou
-- outra bolha já passou) fica como está.
-- A Nina para nela: as outras bolhas dela que ainda estão 'na_fila' nessa
-- conversa são canceladas, como no assumir_conversa (o lead não recebe a 2ª
-- parte sem a 1ª). O cancelamento não dispara este gatilho de novo (o WHEN
-- exige 'falhou'). Pula a bolha travada por outra transação (skip locked):
-- assim este gatilho nunca espera uma mensagem enquanto segura a conversa.
-- A rodada da Nina que ainda está rodando nessa conversa (o lead escreveu de
-- novo depois da bolha) é cancelada e solta as entradas, como no
-- assumir_conversa: sem isso, um passar_para_humano dela marcaria passou_humano
-- e o concluir_rodada poria a despedida na fila. Também com skip locked (o
-- concluir_rodada trava a rodada e depois a conversa): a rodada que o
-- concluir_rodada segura termina com as respostas canceladas, porque a conversa
-- já está em humano; a que uma ferramenta da Nina segura naquele instante
-- (passar_para_humano, mover etapa) segue rodando (caso raro). As entradas
-- também com skip locked: o tg_mensagens_apos_atualizar de uma entrada que o
-- lead apagou trava a entrada e depois a conversa; a entrada pulada fica ligada
-- à rodada cancelada.
-- Trava em ordem inversa (caso raro, sem perda de dado), em dois casos:
-- (1) no caminho conexao_inativa, o pegar_envios trava a mensagem e o gatilho
-- pede a conversa; o tg_mensagens_apos_inserir e o assumir_conversa travam a
-- conversa e depois a mesma bolha 'na_fila'; (2) duas chamadas do pegar_envios
-- ao mesmo tempo (o ciclo do worker e a passada curta que a tela pede depois
-- de gravar, ou dois ciclos) travam cada uma bolhas de duas conversas e marcam
-- 'falhou' (sem_resposta_do_envio ou conexao_inativa) em ordens opostas: cada
-- gatilho segura uma conversa e pede a outra. Ao mesmo tempo, o Postgres
-- desfaz um dos dois (40P01): o pegar_envios roda de novo no ciclo seguinte
-- (ou na passada seguinte da tela), o webhook volta pelo eventos_webhook e o
-- Assumir mostra erro uma vez. O for update na conversa fica, porque evita
-- evento duplicado.
-- ---------------------------------------------------------------------
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

create or replace trigger mensagens_envio_falhou
  after update of status on public.mensagens
  for each row
  when (new.status = 'falhou' and old.status is distinct from 'falhou'
        and new.direcao = 'saida' and new.origem = 'nina')
  execute function public.tg_mensagens_envio_falhou();

-- Só o gatilho chama (como os outros tg_* do app).
revoke execute on function public.tg_mensagens_envio_falhou() from public, anon, authenticated, service_role;