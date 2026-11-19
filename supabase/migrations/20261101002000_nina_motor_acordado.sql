-- nina_motor_acordado (seção 2, envio M1): o motor da mensageria
-- acordado pelos acontecimentos, sem agendamento. O servidor pede o toque quando algo acontece (uma
-- mensagem nova, uma tela que vê atraso) e o banco chama a rota do worker com net.http_post, com
-- uma chave própria guardada aqui, numa tabela que ninguém lê.
--
-- O que este envio cria:
--   1. eventos_webhook.pego_em: a trava dos eventos pendentes (2 min), como a das mídias;
--   2. public.motor, uma linha só: o endereço publicado, a chave do toque e os momentos do toque,
--      da preparação da cópia e do relógio. A linha nasce aqui marcada como preparada: o banco
--      original nunca recebe os dados iniciais de novo (só a cópia do remix, que vem sem ela);
--   3. motor_endereco, acordar_motor e motor_confere (servidor);
--   4. motor_pendencias (servidor ou membro): quando o motor tem trabalho, com as mesmas
--      condições das funções que pegam o trabalho;
--   5. pegar_eventos_pendentes e falhar_evento (servidor): os eventos pendentes pegos com trava, e a
--      tentativa somada no banco, num comando só.
--
-- Este envio não agenda nada: o relógio vai no envio seguinte (nina_copia_sozinha), em separado.
-- A chave nunca sai do banco: nenhuma função a devolve, e a tabela não tem privilégio para ninguém.
-- Não grava endereço, segredo, id de usuário nem e-mail. Sem BEGIN/COMMIT.

-- O pg_net já existe no original e na cópia (remix de teste de 03/11/2026): esta linha não muda
-- nada lá, e só garante a extensão num banco refeito do zero.
create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. A trava dos eventos pendentes
-- ---------------------------------------------------------------------------
-- pego_em: quando o motor pegou o evento para reaplicar. Vence em 2 min (o motor caiu no meio).
alter table public.eventos_webhook add column if not exists pego_em timestamptz;

-- ---------------------------------------------------------------------------
-- 2. A linha do motor
-- ---------------------------------------------------------------------------
-- url: só https://<host>, sem caminho nem porta (até 253 caracteres de host).
-- chave: sorteada pelo banco na criação da linha; vai no cabeçalho x-nina-motor do toque.
-- url_em: quando o endereço foi gravado. tocado_em: o último toque.
-- preparada_em: quando os dados iniciais foram garantidos (no original, pela migration).
-- relogio_em: quando preparar_copia instalou o relógio pela última vez.
create table if not exists public.motor (
  id boolean primary key default true constraint motor_linha_unica check (id),
  url text constraint motor_url_formato check (
    url is null
    or (url ~ '^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]([a-z0-9-]*[a-z0-9])?$'
        and char_length(url) <= 261)
  ),
  chave text not null default encode(extensions.gen_random_bytes(32), 'hex'),
  url_em timestamptz,
  tocado_em timestamptz,
  preparada_em timestamptz,
  relogio_em timestamptz
);

-- Fechada para todos (nem o servidor lê): só as funções abaixo, que são do dono, mexem nela.
alter table public.motor enable row level security;
revoke all on table public.motor from public, anon, authenticated, service_role;

-- O original já tem os dados iniciais (0001 e 0015): a linha nasce preparada. No remix a linha não
-- vem (o remix não copia dados), e preparar_copia semeia a cópia uma vez só.
insert into public.motor (id, preparada_em) values (true, now())
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Endereço, toque e chave (servidor)
-- ---------------------------------------------------------------------------

-- Grava o endereço publicado, se for válido e diferente do atual. Cria a linha se faltar (na cópia
-- ela nasce sem preparada_em). Devolve se gravou.
create or replace function public.motor_endereco(p_url text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.motor (id) values (true)
  on conflict (id) do nothing;
  if p_url is null
     or char_length(p_url) > 261
     or p_url !~ '^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]([a-z0-9-]*[a-z0-9])?$' then
    return false;
  end if;
  update public.motor mo
     set url = p_url, url_em = now()
   where mo.id and mo.url is distinct from p_url;
  return found;
end;
$$;

revoke execute on function public.motor_endereco(text) from public, anon, authenticated;
grant execute on function public.motor_endereco(text) to service_role;

-- Pede ao worker uma passada: um POST na rota dele, com a chave no cabeçalho x-nina-motor.
--   'sem_endereco': nenhum endereço gravado ainda;
--   'recente': houve toque ou o worker rodou nos últimos 40 s (contra toque em dobro);
--   'tocado': o pedido foi para a fila do pg_net (sai depois do commit) e tocado_em foi gravado.
-- p_renovar = true é só a renovação do fim do laço: o laço que pede ainda é o worker visto e o
-- toque que o abriu (38 a 45 s antes), então ela não olha worker_visto_em e só dá 'recente' se
-- outro toque saiu nos últimos 10 s.
-- A linha fica travada até o fim: dois pedidos ao mesmo tempo dão um toque só.
-- O teto de 60 s do pedido cobre a passada do worker (~45 s), para o pg_net não cortar antes.
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

revoke execute on function public.acordar_motor(boolean) from public, anon, authenticated;
grant execute on function public.acordar_motor(boolean) to service_role;

-- A rota do worker confere a chave que chegou no cabeçalho. Só diz sim ou não.
create or replace function public.motor_confere(p_chave text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return p_chave is not null
     and exists (select 1 from public.motor mo where mo.id and mo.chave = p_chave);
end;
$$;

revoke execute on function public.motor_confere(text) from public, anon, authenticated;
grant execute on function public.motor_confere(text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. As pendências do motor (servidor ou membro)
-- ---------------------------------------------------------------------------
-- Cada item tem um "pronto": o momento a partir do qual o motor o pega. As condições são cópia das
-- funções que pegam o trabalho, em vigor (citadas em cada bloco): um item que o motor nunca pegaria
-- não aparece. Devolve uma linha só:
--   proximo_em: o menor "pronto" ainda no futuro, de qualquer tipo;
--   vencido_desde: o menor "pronto" já vencido, de qualquer tipo;
--   atrasado_desde: o mesmo, sem os eventos do webhook (a Saúde e o Dashboard avisam por ele).
-- O "pronto" de uma conversa ou saída nunca vem antes de o motor poder pegá-la: da conclusão do
-- onboarding e da ativação da conexão. Esses termos são sempre do passado: não mudam proximo_em nem
-- o que é pego, só o "desde" (uma cópia nova não aparece atrasada logo depois do onboarding).
-- Quem chama: o servidor (service_role) ou um membro ativo; outro recebe sem_acesso. O servidor é
-- reconhecido pelo papel do JWT do pedido (auth.jwt() ->> 'role'), que vem assinado.
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
                 and m.midia_status = 'pendente')
           ) as pronto,
           false as evento
    from public.conversas c
    where c.responder_apos is not null
      and c.modo = 'nina'
      and exists (select 1 from public.configuracao cf
                  where cf.id = 1 and cf.onboarding_concluido_em is not null)
      and exists (select 1 from public.conexoes cx
                  where cx.ativa
                    and (not cx.oficial
                         or (c.ultima_do_lead_em is not null
                             and c.ultima_do_lead_em + interval '24 hours' > now())))

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

-- ---------------------------------------------------------------------------
-- 5. Os eventos pendentes do webhook (servidor)
-- ---------------------------------------------------------------------------

-- Pega até p_limite eventos não processados, com menos de 5 tentativas, recebidos há mais de 30 s
-- e sem trava (ou com a trava de 2 min vencida). Trava com SKIP LOCKED e grava pego_em: duas
-- passadas ao mesmo tempo não pegam o mesmo evento. Devolve na ordem do id.
create or replace function public.pegar_eventos_pendentes(p_limite int)
returns table (id bigint, gateway public.gateway, conexao_id uuid, payload jsonb, tentativas smallint)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with alvo as (
    select e.id
    from public.eventos_webhook e
    where e.processado_em is null
      and e.tentativas < 5
      and e.recebido_em < now() - interval '30 seconds'
      and (e.pego_em is null or e.pego_em < now() - interval '2 minutes')
    order by e.id
    limit greatest(coalesce(p_limite, 0), 0)
    for update of e skip locked
  ), pegos as (
    update public.eventos_webhook e
       set pego_em = now()
      from alvo a
     where e.id = a.id
    returning e.id, e.gateway, e.conexao_id, e.payload, e.tentativas
  )
  select p.id, p.gateway, p.conexao_id, p.payload, p.tentativas
  from pegos p
  order by p.id;
end;
$$;

revoke execute on function public.pegar_eventos_pendentes(int) from public, anon, authenticated;
grant execute on function public.pegar_eventos_pendentes(int) to service_role;

-- O evento continua pendente: grava o erro (até 200 caracteres), soma 1 tentativa e solta a
-- trava, num comando só. Evento já processado não muda.
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

revoke execute on function public.falhar_evento(bigint, text) from public, anon, authenticated;
grant execute on function public.falhar_evento(bigint, text) to service_role;
