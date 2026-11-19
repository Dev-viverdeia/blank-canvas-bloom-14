-- nina_ligacao_uma_nina_por_vez (17/11/2026): a Nina de texto fica calada durante a ligação.
-- Decisão do Alexandre (17/11/2026), trazida da Nina vitrine (base 0029 de lá, só a parte "uma
-- Nina por vez", sem os pedidos da voz): na vitrine, duas respostas de texto saíram durante uma
-- ligação. O registro da ligação e o que o lead escrever no chat durante ela continuam armando a
-- conversa (responder_apos); a rodada só começa quando a ligação termina. Então ela lê o resumo e
-- a transcrição e manda o que a voz prometeu por mensagem (a rodada "depois da ligação", no
-- servidor). O pós-chamada acorda o worker.
--   1. ligacao_teto (ajudante, só das funções do banco): até quando uma ligação em andamento conta
--      como em andamento: o começo, mais a duração máxima do agente que atendeu, mais 2 min; sem
--      agente, 30 + 2 min. Depois do teto, a ligação sem pós-chamada não segura mais nada;
--   2. pegar_rodadas recriada (texto da base 0006, mesma assinatura): a conversa com ligação em
--      andamento dentro do teto fica de fora;
--   3. motor_pendencias recriada (texto da base 0020, mesma assinatura): a mesma regra, a conversa
--      que passou do teto volta vencida desde o teto, e a conversa que espera uma ligação acorda o
--      worker 2 min depois do começo dela (para conferir as presas), sem contar como atraso.
-- Depende de: nina_ligacoes_tabelas (base 0023: ligacoes, ligacao_agentes.duracao_max_s),
-- nina_ligacao_conversa (0006) e nina_motor_acordado (0020). Ordem: sozinho; seguro antes do
-- código novo (o servidor publicado conclui vazia a rodada só com o registro da ligação, D7).
-- Nenhuma tabela nem coluna muda, nada entra no tempo real e nada é semeado: a preparar_copia()
-- não muda. Só acrescenta (as recriadas mantêm a assinatura). Pode rodar duas vezes.
-- Sem BEGIN/COMMIT.

-- ---------------------------------------------------------------------
-- Trava: sem as dependências, este envio para aqui.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.ligacoes') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'ligacao_agentes'
                       and column_name = 'duracao_max_s')
     or to_regprocedure('public.pegar_rodadas(integer)') is null
     or to_regprocedure('public.motor_pendencias()') is null then
    raise exception using message = 'falta_ligacoes_ou_motor',
      hint = 'Aplique antes o nina_ligacoes_tabelas (0023), o nina_ligacao_conversa (0006) e o nina_motor_acordado (0020).';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 1. ligacao_teto
-- ---------------------------------------------------------------------
create or replace function public.ligacao_teto(p_iniciada_em timestamptz, p_agente uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select p_iniciada_em
         + make_interval(secs => coalesce((select a.duracao_max_s
                                             from public.ligacao_agentes a
                                            where a.id = p_agente), 1800) + 120)
$$;

revoke execute on function public.ligacao_teto(timestamptz, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. pegar_rodadas: o texto da 0006, com a mudança marcada "novo (uma Nina por vez)".
-- ---------------------------------------------------------------------
create or replace function public.pegar_rodadas(p_limite int)
returns setof public.rodadas
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_velha  uuid;
  v_ctx    bigint;
  v_prov   public.ia_provedor;
  v_modelo text;
  v_ids    uuid[];
begin
  for v_velha in
    select r.id from public.rodadas r
    where r.status = 'rodando' and r.iniciada_em < now() - interval '5 minutes'
    order by r.iniciada_em
    for update skip locked
  loop
    perform public.falhar_rodada(v_velha, 'erro_provedor', true);
  end loop;

  -- novo
  if not exists (select 1 from public.configuracao cf
                 where cf.id = 1 and cf.onboarding_concluido_em is not null) then
    return;
  end if;

  select max(cv.id) into v_ctx from public.contexto_versoes cv;
  select k.provedor, k.modelo into v_prov, v_modelo
  from public.ia_chaves k where k.finalidade = 'resposta';

  -- instrucao unica: trava (SKIP LOCKED), limpa responder_apos e cria a rodada
  with alvo as (
    select c.id
    from public.conversas c
    where c.responder_apos <= now()
      and c.modo = 'nina'
      and not exists (select 1 from public.rodadas r
                      where r.conversa_id = c.id and r.status = 'rodando')
      and not exists (select 1 from public.mensagens m
                      where m.conversa_id = c.id and m.direcao = 'entrada'
                        and m.midia_status = 'pendente'
                        and m.criado_em > now() - interval '2 minutes')
      and exists (select 1 from public.conexoes cx
                  where cx.ativa
                    and (not cx.oficial
                         or (c.ultima_do_lead_em is not null
                             and c.ultima_do_lead_em + interval '24 hours' > now())))
      -- novo (uma Nina por vez): com ligação em andamento dentro do teto, a conversa espera
      and not exists (select 1 from public.ligacoes l
                      where l.conversa_id = c.id and l.status = 'em_andamento'
                        and public.ligacao_teto(l.iniciada_em, l.agente_id) > now())
    order by c.responder_apos, c.id
    limit greatest(coalesce(p_limite, 0), 0)
    for update of c skip locked
  ), limpa as (
    update public.conversas c
       set responder_apos = null
      from alvo a
     where c.id = a.id
    returning c.id
  ), nova as (
    insert into public.rodadas (conversa_id, status, contexto_versao_id, provedor, modelo,
                                passos, tentativa, passou_humano, iniciada_em)
    select l.id, 'rodando', v_ctx, v_prov, v_modelo, 0,
           1 + (select count(*) from public.rodadas f
                where f.conversa_id = l.id and f.status = 'falhou'
                  and f.criado_em > greatest(
                        coalesce((select max(k.criado_em) from public.rodadas k
                                  where k.conversa_id = l.id and k.status = 'concluida'),
                                 '-infinity'::timestamptz),
                        coalesce((select cv.devolvida_em from public.conversas cv where cv.id = l.id),
                                 '-infinity'::timestamptz))),
           false, now()
    from limpa l
    returning id
  )
  select array_agg(n.id) into v_ids from nova n;

  if v_ids is null then
    return;
  end if;

  -- liga as entradas ainda nao lidas a rodada
  update public.mensagens m
     set rodada_id = r.id
    from public.rodadas r
   where r.id = any (v_ids)
     and m.conversa_id = r.conversa_id
     and m.direcao = 'entrada'
     and m.rodada_id is null;

  return query
    select r.* from public.rodadas r where r.id = any (v_ids) order by r.criado_em, r.id;
end;
$$;

revoke execute on function public.pegar_rodadas(int) from public, anon, authenticated;
grant execute on function public.pegar_rodadas(int) to service_role;

-- ---------------------------------------------------------------------
-- 3. motor_pendencias: o texto da 0020, com as mudanças marcadas "novo (uma Nina por vez)".
-- ---------------------------------------------------------------------
create or replace function public.motor_pendencias()
returns table (proximo_em timestamptz, vencido_desde timestamptz, atrasado_desde timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and not coalesce(public.eh_membro(), false) then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;

  return query
  with ativas as (
    -- Cada conexão ativa e desde quando: a última ativação em conexao_eventos (o gatilho grava só
    -- as mudanças); sem evento, a conexão nasceu ativa.
    select a.id, a.oficial,
           coalesce((select max(ev.criado_em) from public.conexao_eventos ev
                      where ev.conexao_id = a.id and ev.ativa_para
                        and ev.ativa_de is distinct from true),
                    a.criado_em) as desde
    from public.conexoes a
    where a.ativa
  ), onboarding as (
    select cf.onboarding_concluido_em as desde from public.configuracao cf where cf.id = 1
  ), primeiras as (
    -- pegar_envios (0002:773-777): só a 1ª saída na fila de cada conversa pode sair
    select distinct on (m.conversa_id) m.id
    from public.mensagens m
    where m.direcao = 'saida' and m.status = 'na_fila'
    order by m.conversa_id, m.criado_em, m.ordem nulls last, m.id
  ), itens as (
    -- Conversa armada: pegar_rodadas (0006:595-598, o onboarding, e 0006:605-620, a conversa).
    -- Pronta em responder_apos; com uma rodada rodando, só depois da limpeza dela (5 min); com
    -- mídia de entrada pendente, só 2 min depois da última (as duas travas de 0006:610-615). Nunca
    -- antes da conclusão do onboarding nem da 1ª conexão ativa que serve a conversa.
    select greatest(
             c.responder_apos,
             (select ob.desde from onboarding ob),
             (select min(av.desde) from ativas av
               where not av.oficial
                  or (c.ultima_do_lead_em is not null
                      and c.ultima_do_lead_em + interval '24 hours' > now())),
             (select max(r.iniciada_em) + interval '5 minutes' from public.rodadas r
               where r.conversa_id = c.id and r.status = 'rodando'),
             (select max(m.criado_em) + interval '2 minutes' from public.mensagens m
               where m.conversa_id = c.id and m.direcao = 'entrada'
                 and m.midia_status = 'pendente'),
             -- novo (uma Nina por vez): o teto da ligação que passou dele sem pós-chamada
             (select max(public.ligacao_teto(l.iniciada_em, l.agente_id)) from public.ligacoes l
               where l.conversa_id = c.id and l.status = 'em_andamento')
           ) as pronto,
           false as evento
    from public.conversas c
    where c.responder_apos is not null
      and c.modo = 'nina'
      -- novo (uma Nina por vez): como no pegar_rodadas
      and not exists (select 1 from public.ligacoes l
                      where l.conversa_id = c.id and l.status = 'em_andamento'
                        and public.ligacao_teto(l.iniciada_em, l.agente_id) > now())
      and exists (select 1 from public.configuracao cf
                  where cf.id = 1 and cf.onboarding_concluido_em is not null)
      and exists (select 1 from public.conexoes cx
                  where cx.ativa
                    and (not cx.oficial
                         or (c.ultima_do_lead_em is not null
                             and c.ultima_do_lead_em + interval '24 hours' > now())))

    union all
    -- novo (uma Nina por vez): a conversa armada que espera uma ligação em andamento. A ligação
    -- que a ElevenLabs largou sem avisar seguraria a Nina de texto até o teto (até 32 min): 2 min
    -- depois do começo, o worker é acordado para conferir as presas (ligacoes/presas.server.ts).
    -- Conta como evento: a espera de uma ligação de verdade não é atraso do motor.
    select greatest(c.responder_apos, min(l.iniciada_em) + interval '2 minutes'), true
    from public.conversas c
    join public.ligacoes l on l.conversa_id = c.id
    where c.responder_apos is not null
      and c.modo = 'nina'
      and l.status = 'em_andamento'
      and public.ligacao_teto(l.iniciada_em, l.agente_id) > now()
    group by c.id, c.responder_apos

    union all
    -- Rodada presa: pegar_rodadas (0006:585-592) falha a rodada rodando há mais de 5 min.
    select r.iniciada_em + interval '5 minutes', false
    from public.rodadas r
    where r.status = 'rodando'

    union all
    -- Saída na fila em conexão ativa: pegar_envios (0002:778-790). Pronta em
    -- coalesce(enviar_apos, criado_em); com outra saída enviando na conversa, só depois da
    -- limpeza dela (2 min, 0002:739-745). Nunca antes da ativação da conexão dela.
    select greatest(
             coalesce(m.enviar_apos, m.criado_em),
             av.desde,
             (select max(coalesce(e.status_em, e.criado_em)) + interval '2 minutes'
                from public.mensagens e
               where e.conversa_id = m.conversa_id
                 and e.direcao = 'saida' and e.status = 'enviando')
           ),
           false
    from public.mensagens m
    join primeiras p on p.id = m.id
    join ativas av on av.id = m.conexao_id
    where m.status = 'na_fila'

    union all
    -- Órfã de conexão inativa, quando há outra conexão ativa: pegar_envios (0002:758-769) a
    -- falha logo. Pronta quando ficou órfã: a saída ou a 1ª ativação entre as conexões ativas, a
    -- mais nova.
    select greatest(
             coalesce(m.status_em, m.criado_em),
             (select min(av.desde) from ativas av)
           ),
           false
    from public.mensagens m
    where m.direcao = 'saida' and m.status = 'na_fila'
      and exists (select 1 from ativas)
      and not exists (select 1 from ativas av where av.id = m.conexao_id)

    union all
    -- Enviando há mais de 2 min: pegar_envios (0002:739-745) devolve à fila ou fecha.
    select coalesce(m.status_em, m.criado_em) + interval '2 minutes', false
    from public.mensagens m
    where m.direcao = 'saida' and m.status = 'enviando'

    union all
    -- Mídia pendente: pegar_midias (0002:1030-1039, a cópia, com referência e menos de 3
    -- tentativas, e 0002:1015-1021, a esgotada, com 3 ou mais). As duas esperam a trava de 2 min.
    select coalesce(m.midia_pega_em + interval '2 minutes', m.criado_em), false
    from public.mensagens m
    where m.midia_status = 'pendente'
      and ((m.midia_ref_externa is not null and m.midia_tentativas < 3)
           or m.midia_tentativas >= 3)

    union all
    -- Evento do webhook não processado: pegar_eventos_pendentes (abaixo), com menos de 5
    -- tentativas, recebido há mais de 30 s e a trava de 2 min vencida.
    select greatest(e.recebido_em + interval '30 seconds', e.pego_em + interval '2 minutes'), true
    from public.eventos_webhook e
    where e.processado_em is null and e.tentativas < 5
  )
  select min(i.pronto) filter (where i.pronto > now()),
         min(i.pronto) filter (where i.pronto <= now()),
         min(i.pronto) filter (where i.pronto <= now() and not i.evento)
  from itens i;
end;
$$;

revoke execute on function public.motor_pendencias() from public, anon;
grant execute on function public.motor_pendencias() to authenticated, service_role;