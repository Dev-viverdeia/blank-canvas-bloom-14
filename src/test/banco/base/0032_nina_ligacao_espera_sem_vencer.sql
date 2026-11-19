-- nina_ligacao_espera_sem_vencer (17/11/2026): corrige a espera da ligação na motor_pendencias.
-- Achado da revisão do Sol 6.1 sobre o envio nina_ligacao_uma_nina_por_vez (base 0031): o item que
-- acorda o worker durante uma ligação vencia 2 min depois do começo e ficava vencido até a ligação
-- acabar. Ele virava o menor vencido_desde; passados 10 min, a renovação do toque e o bastão (que
-- olham o vencido mais antigo) deixavam de pedir a próxima chamada, e uma mensagem nova de outro
-- lead, chegando no trecho final de uma chamada, ficava esperando o próximo acontecimento.
-- Agora o item é sempre o próximo marco de 2 min desde o começo da ligação (sempre no futuro): o
-- worker continua acordado durante a ligação, confere as presas, e o vencido mais antigo volta a
-- ser só trabalho de verdade.
-- Recria a motor_pendencias a partir do texto da base 0031, com a mesma assinatura; só o item da
-- espera muda. Depende de: nina_ligacao_uma_nina_por_vez (base 0031, ligacao_teto). Ordem:
-- sozinho. Nada é semeado, nenhuma tabela muda: a preparar_copia() não muda. Pode rodar duas
-- vezes. Sem BEGIN/COMMIT.

-- ---------------------------------------------------------------------
-- Trava: sem a ligacao_teto da 0031, este envio para aqui.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.ligacao_teto(timestamptz, uuid)') is null then
    raise exception using message = 'falta_a_ligacao_teto',
      hint = 'Aplique antes o nina_ligacao_uma_nina_por_vez (base 0031).';
  end if;
end;
$$;

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
    -- uma Nina por vez (0031), corrigido na 0032: a conversa armada que espera uma ligação em
    -- andamento acorda o worker a cada 2 min desde o começo da ligação, para conferir as presas
    -- (ligacoes/presas.server.ts). Sempre no próximo marco, nunca vencido: o item vencido ficava
    -- como o menor vencido_desde e, passados 10 min, escondia o trabalho novo de outra conversa (a
    -- renovação e o bastão olham o vencido mais antigo). Conta como evento: não é atraso do motor.
    select greatest(
             c.responder_apos,
             min(l.iniciada_em)
               + interval '2 minutes'
                 * (floor(extract(epoch from (now() - min(l.iniciada_em))) / 120) + 1)
           ), true
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