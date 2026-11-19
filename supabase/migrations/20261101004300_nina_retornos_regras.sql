-- nina_retornos_regras (envio 2 de 6 dos retornos, 18/11/2026).
-- As leituras e as regras dos retornos da Nina: 11 funções novas, todas internas (execute só do
-- dono) e inertes. Nenhuma tem grant para o servidor nem para a tela: quem as chama são as funções
-- do nina_retornos_funcoes, as do nina_retornos_rodada e as do próprio envio. Com o servidor
-- publicado hoje, nada chega a elas. Nenhuma função que existe hoje muda.
-- Este envio também acrescenta uma coluna, logo depois da trava: retornos.lembrete_horas (as horas
-- do ajuste com que o lembrete foi armado; nula no retorno combinado) e o check
-- retornos_lembrete_horas (só no lembrete, de 1 a 23). Por isso o types.ts muda com ele. Ela não
-- está no nina_retornos_tabelas porque a revisão das funções a pediu quando ele já estava aplicado
-- (o texto aplicado não muda mais). Ela vem antes da retornos_prontos, que é de language sql
-- (conferida na criação) e a lê. A coluna nasce nula e sem default, e o check aceita a linha com
-- ela nula: vale também numa tabela com linhas.
-- 1. Leituras e regras puras:
-- - rodada_tem_fala_do_lead(p_rodada): a rodada leu fala do lead (D9 e D4). Quem chama: a
--   nina_marcar_retorno, a nina_cancelar_retorno e o "levar junto" da pegar_rodadas_com_retornos
--   (nina_retornos_funcoes) e a varredura F (retornos_varrer);
-- - retorno_instante(p_data, p_hora): o dia e a hora de Brasília como instante. Quem chama: a
--   nina_marcar_retorno (nina_retornos_funcoes);
-- - lembrete_vence_em(p_base, p_horas, p_conversa) e lembrete_expira_em(p_vence): a hora e o prazo
--   do lembrete. Quem chama: a lembrete_ao_concluir (nina_retornos_funcoes);
-- - whatsapp_conectado_desde(): o WhatsApp conectado e desde quando (D2). Quem chama: a
--   retornos_prontos, a retorno_volta e a retornos_varrer (deste envio), e a
--   pegar_rodadas_com_retornos e a relogio_retornos (nina_retornos_funcoes);
-- - retornos_no_ar(): o último worker que rodou conhece retornos. Quem chama: a relogio_retornos
--   (nina_retornos_funcoes) e a trava da volta atrás pesada (nina_retornos_desfazer);
-- - retorno_conversa_livre(p_conversa): a Nina pode ir agora a esta conversa. Quem chama: a
--   retornos_prontos;
-- - retornos_prontos(): a regra única do "pode sair". Quem chama: a pegar_rodadas_com_retornos, a
--   relogio_retornos e a motor_pendencias_com_retornos (nina_retornos_funcoes).
-- 2. Transições (o chamador já segura as travas):
-- - retorno_pelas_bolhas(p_retorno): o "saiu ou não saiu" pelas bolhas da rodada. Quem chama: a
--   varredura F e G (retornos_varrer) e o gatilho das bolhas (tg_mensagens_saida_do_retorno, do
--   nina_retornos_rodada);
-- - retorno_volta(p_retorno, p_quando, p_rodada): o único caminho de volta a pendente. Quem chama:
--   a retorno_pelas_bolhas e a retornos_varrer (deste envio), e a retorno_ao_concluir e a
--   retorno_ao_falhar (nina_retornos_funcoes);
-- - retornos_varrer(p_max): a varredura do que não pode sair, item por item, cada um num bloco
--   protegido (a linha com defeito deixa um aviso e não derruba as outras). Quem chama: a
--   pegar_rodadas_com_retornos (50) e a relogio_retornos (500), do nina_retornos_funcoes.
-- As de language sql são conferidas na criação: cada uma vem depois das que ela usa, e nenhuma usa
-- função de outro envio dos retornos (da base, só a ligacao_teto). Nenhuma deste envio chama
-- função do nina_retornos_funcoes: por isso ele pode vir antes.
-- Depende de: nina_retornos_tabelas (a tabela retornos, que ganha a coluna nova, e as tabelas e as
-- colunas que as de language sql leem na criação) e da base 0037. Ordem: 2º envio dos retornos,
-- depois do nina_retornos_tabelas e antes do nina_retornos_funcoes (que usa estas funções e a
-- coluna nova). Quando vai ao agente do Lovable: antes do código novo, em envios separados e
-- seguidos (o nina_retornos_tabelas, já aplicado, depois este, depois o nina_retornos_funcoes),
-- cada um com o seu OK; os três são inertes com o servidor de hoje no ar, e o código novo precisa
-- do types.ts gerado com eles (com este, a coluna retornos.lembrete_horas).
-- Nada é semeado, sem tempo real: a preparar_copia() não muda aqui. Só acrescenta. Pode rodar
-- duas vezes. Sem BEGIN/COMMIT.

-- ---------------------------------------------------------------------
-- Trava: sem o nina_retornos_tabelas ou sem as funções da base, este envio para aqui (a coluna
-- retornos.lembrete_horas não entra na trava: é este envio que a cria, logo abaixo).
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.retornos') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'rodadas'
                       and column_name = 'retorno_id')
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'configuracao'
                       and column_name = 'lembrete_horas')
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'configuracao'
                       and column_name = 'worker_retornos_em') then
    raise exception using message = 'falta_nina_retornos_tabelas',
      hint = 'Aplique antes o nina_retornos_tabelas.';
  end if;
  if to_regprocedure('public.pegar_rodadas(integer)') is null
     or to_regprocedure('public.motor_pendencias()') is null
     or to_regprocedure('public.acordar_motor(boolean)') is null
     or to_regprocedure('public.ligacao_teto(timestamptz, uuid)') is null
     or to_regprocedure('public.rodada_rodando(uuid)') is null
     or to_regprocedure('public.membro_atual()') is null then
    raise exception using message = 'falta_a_base_0037',
      hint = 'Este banco precisa das funções do motor (base 0020, 0032) e da uma Nina por vez (base 0031).';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 0. A coluna das horas do lembrete armado e o check dela (deste envio, e não do
--    nina_retornos_tabelas, que já estava aplicado quando a revisão a pediu). Vem antes da
--    retornos_prontos, que a lê (language sql, conferida na criação).
-- ---------------------------------------------------------------------

-- As horas do ajuste com que o lembrete foi armado: o lembrete pendente cobra a pergunta pelas
-- horas de quando foi armado, e não pelas do ajuste de agora (nula no retorno combinado).
alter table public.retornos add column if not exists lembrete_horas integer;
alter table public.retornos drop constraint if exists retornos_lembrete_horas;
alter table public.retornos
  add constraint retornos_lembrete_horas check (
    lembrete_horas is null or (tipo = 'lembrete' and lembrete_horas between 1 and 23));

-- =====================================================================
-- 1. Leituras e regras puras (internas). As de language sql são conferidas na criação: cada uma
--    vem depois das que ela usa.
-- =====================================================================

-- A fala do lead na rodada (D9 e D4): uma entrada ligada à rodada que não é registro de ligação,
-- ou o registro de uma ligação concluída (em qualquer direção; a saída não atendida não conta).
create or replace function public.rodada_tem_fala_do_lead(p_rodada uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.mensagens m
     where m.rodada_id = p_rodada
       and m.direcao = 'entrada'
       and (m.tipo <> 'ligacao'
            or exists (select 1 from public.ligacoes l
                        where l.mensagem_id = m.id and l.status = 'concluida')));
$$;
revoke execute on function public.rodada_tem_fala_do_lead(uuid) from public, anon, authenticated, service_role;

-- O dia e a hora de Brasília como instante (nunca current_date).
create or replace function public.retorno_instante(p_data date, p_hora time)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select (p_data + p_hora) at time zone 'America/Sao_Paulo';
$$;
revoke execute on function public.retorno_instante(date, time) from public, anon, authenticated, service_role;

-- A hora do lembrete: p_base + p_horas, se cair entre 08:00 e 20:00 de Brasília. Fora disso, as
-- 08:00 seguintes, mais de 0 a 30 min tirados do id da conversa (a mesma conversa cai sempre no
-- mesmo minuto). O ::bigint vem antes do abs: abs(-2147483648) estoura em int.
create or replace function public.lembrete_vence_em(p_base timestamptz, p_horas integer, p_conversa uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when x.l::time >= time '08:00' and x.l::time < time '20:00' then x.t
           else ((case when x.l::time < time '08:00' then x.l::date else x.l::date + 1 end)
                 + time '08:00'
                 + make_interval(secs => (abs(hashtext(p_conversa::text)::bigint) % 1800)::double precision))
                at time zone 'America/Sao_Paulo'
         end
    from (select p_base + make_interval(hours => p_horas) as t,
                 (p_base + make_interval(hours => p_horas)) at time zone 'America/Sao_Paulo' as l) x;
$$;
revoke execute on function public.lembrete_vence_em(timestamptz, integer, uuid) from public, anon, authenticated, service_role;

-- O prazo do lembrete: 3 h depois da hora dele ou as 20:00 de Brasília do mesmo dia, o que vier
-- antes. Como a hora do lembrete fica sempre antes das 20:00, o prazo é sempre maior que ela.
create or replace function public.lembrete_expira_em(p_vence timestamptz)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select least(p_vence + interval '3 hours',
               ((p_vence at time zone 'America/Sao_Paulo')::date + time '20:00')
                 at time zone 'America/Sao_Paulo');
$$;
revoke execute on function public.lembrete_expira_em(timestamptz) from public, anon, authenticated, service_role;

-- O WhatsApp conectado (D2: ativa e com status conectada) e desde quando: o maior entre a última
-- ativação e a última volta a conectada (conexao_eventos; sem evento, a criação). Nulo = fora do ar.
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
revoke execute on function public.whatsapp_conectado_desde() from public, anon, authenticated, service_role;

-- O último worker que rodou conhece retornos (o servidor novo grava os dois sinais juntos).
create or replace function public.retornos_no_ar()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select cf.worker_retornos_em >= cf.worker_visto_em
                     from public.configuracao cf where cf.id = 1), false);
$$;
revoke execute on function public.retornos_no_ar() from public, anon, authenticated, service_role;

-- A Nina pode ir agora a esta conversa por um retorno ou um lembrete. É o espelho das travas da
-- pegar_rodadas (base 0031), mais: conversa não armada (a armada é da faixa 0, que leva o retorno
-- junto), nenhum retorno em_rodada (o órfão espera a varredura) e o WhatsApp conectado (D2).
create or replace function public.retorno_conversa_livre(p_conversa uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.conversas c
     where c.id = p_conversa
       and c.modo = 'nina'
       and c.responder_apos is null
       and not exists (select 1 from public.rodadas r
                        where r.conversa_id = c.id and r.status = 'rodando')
       and not exists (select 1 from public.retornos o
                        where o.conversa_id = c.id and o.status = 'em_rodada')
       and not exists (select 1 from public.mensagens m
                        where m.conversa_id = c.id and m.direcao = 'entrada'
                          and m.midia_status = 'pendente'
                          and m.criado_em > now() - interval '2 minutes')
       and exists (select 1 from public.conexoes cx
                    where cx.ativa and cx.status = 'conectada'
                      and (not cx.oficial
                           or (c.ultima_do_lead_em is not null
                               and c.ultima_do_lead_em + interval '24 hours' > now())))
       and not exists (select 1 from public.ligacoes l
                        where l.conversa_id = c.id and l.status = 'em_andamento'
                          and public.ligacao_teto(l.iniciada_em, l.agente_id) > now()));
$$;
revoke execute on function public.retorno_conversa_livre(uuid) from public, anon, authenticated, service_role;

-- A regra única de "pode sair": a função que pega as rodadas, o relógio e a
-- motor_pendencias_com_retornos usam a mesma. pronto_em = desde quando pode sair; só o tentar_apos
-- (os 30 s depois de uma falha) fica no futuro, e quem lê filtra pronto_em <= now().
-- O lembrete exige também: o ajuste ligado, a etapa aberta, o lead calado desde que ele foi
-- armado (nenhuma entrada solta desde o começo da rodada que o armou: a solta mais velha, que a
-- rodada pura deixou de lado, não prende o lembrete), nenhuma devolução depois de armar, nenhum
-- retorno aberto e a pergunta da rodada que o armou já saiu (nenhuma bolha dela ainda na fila ou
-- enviando) há pelo menos as horas com que ele foi armado (retornos.lembrete_horas; o ajuste
-- mudado depois só vale para os lembretes armados depois dele), contadas do momento em que a
-- última bolha saiu. A
-- pergunta cancelada pelo Desconectar ou pelo Trocar de WhatsApp nunca sai, e a que ficou parada
-- na fila não é cobrada antes de o lead recebê-la; o lembrete gravado sem rodada de origem não tem
-- essa conferência. O pronto_em do lembrete conta também essa hora (o toque do relógio no instante
-- certo). A tela que mostra o cartão do lembrete usa a mesma regra.
create or replace function public.retornos_prontos()
returns table (retorno_id uuid, conversa_id uuid, tipo public.retorno_tipo, pronto_em timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  with cf as (
    select k.onboarding_concluido_em, k.lembrete_ligado, k.lembrete_horas
      from public.configuracao k where k.id = 1
  ), wa as (
    select public.whatsapp_conectado_desde() as desde
  )
  select rt.id, rt.conversa_id, rt.tipo,
         greatest(rt.vence_em, coalesce(rt.tentar_apos, rt.vence_em), wa.desde,
                  cf.onboarding_concluido_em, pg.desde)
    from public.retornos rt
    join public.conversas c on c.id = rt.conversa_id
   cross join cf
   cross join wa
    -- a pergunta da rodada que armou o lembrete: desde quando pode ser cobrada (a última bolha que
    -- saiu, mais as horas com que ele foi armado; o ajuste mudado depois não o move) e se alguma
    -- bolha dela ainda está na fila ou enviando
    left join lateral (
      select max(m.momento) filter (where m.status in ('enviada', 'entregue', 'lida'))
               + make_interval(hours => coalesce(rt.lembrete_horas, cf.lembrete_horas)) as desde,
             bool_or(m.status in ('na_fila', 'enviando')) as na_fila
        from public.mensagens m
       where rt.tipo = 'lembrete'
         and m.rodada_id = rt.rodada_origem_id
         and m.direcao = 'saida' and m.origem = 'nina'
         and m.apagada_em is null
         and m.status in ('na_fila', 'enviando', 'enviada', 'entregue', 'lida')
    ) pg on true
   where rt.status = 'pendente'
     and rt.vence_em <= now()
     and rt.expira_em > now()
     and cf.onboarding_concluido_em is not null
     and wa.desde is not null
     and public.retorno_conversa_livre(rt.conversa_id)
     and (rt.tipo = 'retorno'
          or (cf.lembrete_ligado
              and exists (select 1 from public.contatos ct
                            join public.etapas e on e.id = ct.etapa_id
                           where ct.id = c.contato_id and e.tipo = 'aberta')
              and (c.ultima_do_lead_em is null or c.ultima_do_lead_em <= rt.marcado_em)
              and coalesce(c.devolvida_em, '-infinity'::timestamptz) <= rt.marcado_em
              and (rt.rodada_origem_id is null
                   or (pg.desde is not null and not coalesce(pg.na_fila, false)
                       and pg.desde <= now()))
              and not exists (select 1 from public.mensagens m
                               where m.conversa_id = rt.conversa_id and m.direcao = 'entrada'
                                 and m.rodada_id is null
                                 and m.criado_em >= coalesce(
                                       (select ro.iniciada_em from public.rodadas ro
                                         where ro.id = rt.rodada_origem_id),
                                       rt.marcado_em))
              and not exists (select 1 from public.retornos o
                               where o.conversa_id = rt.conversa_id and o.tipo = 'retorno'
                                 and o.status in ('pendente', 'em_rodada'))));
$$;
revoke execute on function public.retornos_prontos() from public, anon, authenticated, service_role;

-- =====================================================================
-- 2. Transições internas: as bolhas, a volta a pendente e a varredura (o chamador já segura as
--    travas). As do fim da rodada (lembrete_ao_concluir, retorno_ao_concluir e retorno_ao_falhar)
--    ficam no nina_retornos_funcoes.
-- =====================================================================

-- O "saiu ou não saiu" pelas bolhas da rodada que levou o retorno ou o lembrete. O chamador segura
-- a trava do retorno; a da conversa, esta função toma (nowait) só antes de devolver o retorno a
-- pendente. Só grava se o estado, o motivo ou a hora do envio mudou. Todas canceladas:
-- não enviado, com a equipe (a conversa saiu da Nina ou a equipe escreveu desde o começo da
-- rodada) ou desconectado (o Desconectar ou o Trocar de WhatsApp cancelou as bolhas na fila). O
-- retorno saindo volta pela retorno_volta antes da hora, com qualquer motivo (A1), e depois da hora
-- quando o motivo seria desconectado (caso 12: até 3 h depois da hora, sai; a retorno_volta decide
-- pelo prazo). Todas canceladas depois da hora: com_equipe fica final; desconectado volta pela
-- retorno_volta. O lembrete nunca volta.
create or replace function public.retorno_pelas_bolhas(p_retorno uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rt       public.retornos;
  v_saiu     integer;
  v_fila     integer;
  v_falhou   integer;
  v_total    integer;
  v_primeira timestamptz;
  v_modo     public.conversa_modo;
  v_status   public.retorno_status;
  v_motivo   text;
  v_enviado  timestamptz;
  v_resolv   timestamptz;
begin
  select * into v_rt from public.retornos rt where rt.id = p_retorno;
  if not found or v_rt.rodada_id is null
     or v_rt.status not in ('saindo', 'enviado', 'nao_enviado') then
    return;
  end if;

  select count(*) filter (where m.status in ('enviada', 'entregue', 'lida')),
         count(*) filter (where m.status in ('na_fila', 'enviando')),
         count(*) filter (where m.status = 'falhou'),
         count(*),
         min(m.momento) filter (where m.status in ('enviada', 'entregue', 'lida'))
    into v_saiu, v_fila, v_falhou, v_total, v_primeira
    from public.mensagens m
   where m.rodada_id = v_rt.rodada_id and m.direcao = 'saida' and m.origem = 'nina';

  -- Sem bolha: o desfecho veio de outra fonte e não se recalcula.
  if v_total = 0 then
    return;
  end if;

  if v_saiu > 0 then
    v_status := 'enviado';
    v_motivo := null;
    v_enviado := v_primeira;
    -- a hora de quando já estava enviado fica; reaberto de não enviado, resolvido agora
    v_resolv := case when v_rt.status = 'enviado' then coalesce(v_rt.resolvido_em, now()) else now() end;
  elsif v_fila > 0 then
    v_status := 'saindo';
    v_motivo := null;
    v_enviado := null;
    v_resolv := null;
  elsif v_falhou > 0 then
    -- D7: o WhatsApp recusou o envio
    v_status := 'nao_enviado';
    v_motivo := 'envio_recusado';
    v_enviado := null;
    v_resolv := coalesce(v_rt.resolvido_em, now());
  else
    -- todas canceladas
    v_status := 'nao_enviado';
    v_enviado := null;
    v_resolv := coalesce(v_rt.resolvido_em, now());
    if v_rt.status = 'nao_enviado' then
      v_motivo := v_rt.nao_enviado_motivo;       -- decidido na hora certa: fica
    else
      select c.modo into v_modo from public.conversas c where c.id = v_rt.conversa_id;
      -- A mensagem da equipe (pela tela ou pelo celular) cancela as bolhas antes de gravar o modo
      -- humano na conversa (base 0006, tg_mensagens_apos_inserir): a mensagem humana gravada desde
      -- o começo da rodada também conta como "com a equipe".
      v_motivo := case
        when v_modo is distinct from 'nina'
          or exists (select 1
                       from public.mensagens h
                       join public.rodadas rd on rd.id = v_rt.rodada_id
                      where h.conversa_id = v_rt.conversa_id
                        and h.origem in ('humano_tela', 'humano_celular')
                        and h.criado_em >= rd.iniciada_em)
        then 'com_equipe' else 'desconectado' end;
    end if;
    -- A1 e caso 12: o retorno levado junto antes da hora (qualquer motivo), ou cancelado pelo
    -- Desconectar ou pelo Trocar de WhatsApp depois da hora, volta; a retorno_volta decide pelo
    -- prazo (pendente até expira_em, pronto quando o WhatsApp voltar; depois, desconectado ou
    -- passou_do_prazo). Na hora, o levado antes dela é decidido pela varredura (A ou C) ou pela
    -- faixa 1. A volta a pendente segura antes a conversa (a ordem do "um pendente por conversa":
    -- quem grava um pendente segura a conversa), com nowait: a varredura (F e G), o Assumir e a
    -- mensagem da equipe já a seguram; no gatilho das bolhas, a conversa ocupada (a nina_marcar_retorno
    -- em andamento) dá lock_not_available, que ele trata como adiado, e a varredura G faz a volta no
    -- minuto seguinte.
    if v_rt.tipo = 'retorno' and v_rt.status = 'saindo'
       and (now() < v_rt.vence_em or v_motivo = 'desconectado') then
      perform 1 from public.conversas c where c.id = v_rt.conversa_id for update nowait;
      update public.retornos rt set status = 'em_rodada' where rt.id = p_retorno;
      perform public.retorno_volta(p_retorno, now(), v_rt.rodada_id);
      return;
    end if;
  end if;

  if v_status is distinct from v_rt.status
     or v_motivo is distinct from v_rt.nao_enviado_motivo
     or v_enviado is distinct from v_rt.enviado_em then
    update public.retornos rt
       set status = v_status,
           nao_enviado_motivo = v_motivo,
           enviado_em = v_enviado,
           resolvido_em = v_resolv
     where rt.id = p_retorno;
  end if;
end;
$$;
revoke execute on function public.retorno_pelas_bolhas(uuid) from public, anon, authenticated, service_role;

-- O único caminho de volta a pendente (um pendente por conversa). O chamador segura a conversa e o
-- retorno. Só o retorno em_rodada passa por aqui; o lembrete nunca volta.
-- 1. Se a Nina já marcou outro nesta conversa, este é cancelado e o novo fica como a remarcação.
-- 2. Senão, passado o prazo, não enviado: desconectado (o WhatsApp fora agora ou caído depois da
--    hora, como na varredura C) ou passou do prazo.
-- 3. Senão, pendente de novo, não antes de p_quando.
create or replace function public.retorno_volta(p_retorno uuid, p_quando timestamptz, p_rodada uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rt    public.retornos;
  v_outro uuid;
  v_desde timestamptz;
begin
  select * into v_rt from public.retornos rt where rt.id = p_retorno;
  if not found or v_rt.tipo <> 'retorno' or v_rt.status <> 'em_rodada' then
    return;
  end if;
  v_desde := public.whatsapp_conectado_desde();

  select o.id into v_outro
    from public.retornos o
   where o.conversa_id = v_rt.conversa_id and o.tipo = 'retorno' and o.status = 'pendente'
     and o.id <> p_retorno
   limit 1;

  if v_outro is not null then
    update public.retornos rt
       set status = 'cancelado',
           fechado_por_rodada = coalesce(p_rodada, rt.rodada_id),
           resolvido_em = now()
     where rt.id = p_retorno;
    update public.retornos o
       set substitui_id = coalesce(o.substitui_id, p_retorno)
     where o.id = v_outro;
  elsif v_rt.expira_em <= p_quando then
    -- a mesma regra da varredura C: o WhatsApp fora agora ou caído depois da hora é desconectado
    update public.retornos rt
       set status = 'nao_enviado',
           nao_enviado_motivo = case when v_desde is null or v_desde > v_rt.vence_em
                                     then 'desconectado' else 'passou_do_prazo' end,
           resolvido_em = now()
     where rt.id = p_retorno;
  else
    update public.retornos rt
       set status = 'pendente',
           tentar_apos = p_quando,
           rodada_id = null,
           resolvido_em = null,
           nao_enviado_motivo = null,
           enviado_em = null
     where rt.id = p_retorno;
  end if;
end;
$$;
revoke execute on function public.retorno_volta(uuid, timestamptz, uuid) from public, anon, authenticated, service_role;

-- A varredura do que não pode sair. Quem chama: o relógio (500) e a função que pega as rodadas
-- (50), as duas com o erro seguro. Cada passo trava com skip locked (não espera a trava de
-- ninguém), na ordem conversa e retorno ("for update of c, rt": a linha com a conversa ocupada é
-- pulada antes de travar o retorno). Com a conversa travada, a volta a pendente (F e G) também não
-- disputa o índice de um pendente por conversa: quem grava um pendente segura a conversa. Devolve
-- quantas linhas mudou. Cada item de cada passo roda num bloco protegido: a linha que estoura deixa
-- um aviso (retornos_varrer_item_falhou, com o passo, o id e o erro), não entra na contagem e não
-- derruba os outros itens nem a passada seguinte (a trava pulada continua pulada, sem aviso).
-- A. Retorno vencido com a conversa fora da Nina: não enviado, com a equipe (na hora). Menos a
--    conversa que saiu da Nina só pelo celular, sem responsável, com uma mensagem do celular de
--    menos de 60 s: é a janela do eco duplicado (base 0006, concluir_envio), em que a cópia da
--    própria mensagem da Nina ainda pode devolver a conversa. Espera; a mensagem de verdade do
--    celular fecha o retorno na 1ª passada depois dos 60 s. A conversa assumida pela tela ou com
--    responsável fecha na hora.
-- B. Retorno vencido na conexão oficial com a janela de 24 h fechada: não enviado, 24 h.
-- C. Retorno pendente com o prazo vencido: não enviado, desconectado (WhatsApp fora agora ou caído
--    depois da hora) ou passou do prazo.
-- D. Lembrete pendente que perdeu o sentido: apagado. Sem esperar a hora: ajuste desligado,
--    conversa devolvida depois de armar ou a pergunta da rodada que o armou cancelada pelo
--    Desconectar ou pelo Trocar de WhatsApp (nenhuma bolha da Nina dessa rodada sem cancelar, sem
--    falhar e sem apagar), menos a pergunta cancelada há menos de 2 min (a janela do eco
--    duplicado). Perto da hora (5 min): conversa fora da Nina (menos a janela do eco duplicado,
--    como no passo A), o lead falou (a última do lead depois de armar, ou a entrada solta que a
--    retornos_prontos olha), etapa fechada ou retorno aberto.
-- E. Lembrete expirado (desconectado ou passou do prazo) ou com a janela oficial fechada (24 h),
--    em silêncio.
-- F. Órfão (em_rodada cuja rodada já não roda): com bolha, saindo e as bolhas decidem (todas
--    canceladas antes da hora, ou pelo Desconectar depois dela: o retorno volta), menos a bolha
--    fixa do áudio (rodada sem IA, passos = 0), que nunca é o retorno: aí vale o caso sem bolha,
--    com a volta em 30 s, e o fechado sai da rodada (o caso 5 da retorno_ao_concluir); sem bolha e fora
--    da Nina, com a equipe (o retorno levado antes da hora, ou com a conversa na janela do eco
--    duplicado, como no passo A, volta a pendente: o passo A espera a janela); sem bolha numa rodada
--    cancelada (a equipe atropelou a rodada e já devolveu), a regra do fim da rodada cancelada
--    (retorno_ao_concluir, caso 1): o retorno levado antes da hora volta, e depois da hora, com a
--    equipe; sem bolha numa rodada concluída pela IA sem a fala do lead, dispensado; senão o
--    retorno volta e o lembrete vira não enviado (a Nina não conseguiu).
-- G. Saindo: as bolhas decidem (todas canceladas antes da hora, ou pelo Desconectar depois dela:
--    o retorno volta); ainda saindo depois do prazo com o WhatsApp fora, nenhuma bolha em envio
--    há menos de 2 min e nenhuma bolha já saiu: desconectado.
create or replace function public.retornos_varrer(p_max integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max     integer := greatest(coalesce(p_max, 0), 0);
  v_total   integer := 0;
  v_desde   timestamptz := public.whatsapp_conectado_desde();
  v_oficial boolean := exists (select 1 from public.conexoes cx where cx.ativa and cx.oficial);
  v_ligado  boolean;
  v_item    record;
  v_rd      public.rodadas;
  v_depois  public.retorno_status;
  v_bolha   boolean;
  v_fixa    boolean;
begin
  if v_max = 0 then
    return 0;
  end if;
  select cf.lembrete_ligado into v_ligado from public.configuracao cf where cf.id = 1;
  v_ligado := coalesce(v_ligado, false);

  -- A. Com a equipe na hora (D1)
  for v_item in
    select rt.id
      from public.retornos rt
      join public.conversas c on c.id = rt.conversa_id
     where rt.tipo = 'retorno' and rt.status = 'pendente' and rt.vence_em <= now()
       and c.modo <> 'nina'
       -- a janela do eco duplicado (base 0006, concluir_envio: 60 s): a cópia da própria mensagem
       -- da Nina, vinda do celular, ainda pode devolver a conversa; espera
       and not (c.motivo_humano is not distinct from 'humano_celular' and c.responsavel_id is null
                and exists (select 1 from public.mensagens h
                             where h.conversa_id = c.id and h.origem = 'humano_celular'
                               and h.criado_em > now() - interval '60 seconds'))
     order by rt.vence_em
     limit v_max
       for update of c, rt skip locked
  loop
    begin
      update public.retornos rt
         set status = 'nao_enviado', nao_enviado_motivo = 'com_equipe', resolvido_em = now()
       where rt.id = v_item.id;
      v_total := v_total + 1;
    exception when others then
      raise warning 'retornos_varrer_item_falhou: A %: %', v_item.id, sqlerrm;
    end;
  end loop;

  -- B. Janela oficial fechada
  if v_oficial then
    for v_item in
      select rt.id
        from public.retornos rt
        join public.conversas c on c.id = rt.conversa_id
       where rt.tipo = 'retorno' and rt.status = 'pendente' and rt.vence_em <= now()
         and (c.ultima_do_lead_em is null or c.ultima_do_lead_em + interval '24 hours' <= now())
       order by rt.vence_em
       limit v_max
         for update of c, rt skip locked
    loop
      begin
        update public.retornos rt
           set status = 'nao_enviado', nao_enviado_motivo = 'fora_24h', resolvido_em = now()
         where rt.id = v_item.id;
        v_total := v_total + 1;
      exception when others then
        raise warning 'retornos_varrer_item_falhou: B %: %', v_item.id, sqlerrm;
      end;
    end loop;
  end if;

  -- C. Prazo do retorno
  for v_item in
    select rt.id
      from public.retornos rt
      join public.conversas c on c.id = rt.conversa_id
     where rt.tipo = 'retorno' and rt.status = 'pendente'
       and rt.vence_em <= now() and rt.expira_em <= now()
     order by rt.vence_em
     limit v_max
       for update of c, rt skip locked
  loop
    begin
      update public.retornos rt
         set status = 'nao_enviado',
             nao_enviado_motivo = case when v_desde is null or v_desde > rt.vence_em
                                       then 'desconectado' else 'passou_do_prazo' end,
             resolvido_em = now()
       where rt.id = v_item.id;
      v_total := v_total + 1;
    exception when others then
      raise warning 'retornos_varrer_item_falhou: C %: %', v_item.id, sqlerrm;
    end;
  end loop;

  -- D. Lembrete que perdeu o sentido: apagado (a pergunta cancelada também, sem esperar a hora)
  for v_item in
    select rt.id
      from public.retornos rt
      join public.conversas c on c.id = rt.conversa_id
     where rt.tipo = 'lembrete' and rt.status = 'pendente'
       and (not v_ligado
            or coalesce(c.devolvida_em, '-infinity'::timestamptz) > rt.marcado_em
            or (rt.rodada_origem_id is not null
                and not exists (select 1 from public.mensagens m
                                 where m.rodada_id = rt.rodada_origem_id
                                   and m.direcao = 'saida' and m.origem = 'nina'
                                   and m.status not in ('cancelada', 'falhou')
                                   and m.apagada_em is null)
                -- a janela do eco duplicado (base 0006, concluir_envio: 60 s): a pergunta cancelada
                -- há menos de 2 min ainda pode voltar à fila; enquanto isso, a retornos_prontos já
                -- segura o lembrete
                and not exists (select 1 from public.mensagens m
                                 where m.rodada_id = rt.rodada_origem_id
                                   and m.direcao = 'saida' and m.origem = 'nina'
                                   and m.status = 'cancelada'
                                   and m.status_em > now() - interval '2 minutes'))
            or (rt.vence_em <= now() + interval '5 minutes'
                and ((c.modo <> 'nina'
                      -- a janela do eco duplicado (como no passo A): espera
                      and not (c.motivo_humano is not distinct from 'humano_celular' and c.responsavel_id is null
                               and exists (select 1 from public.mensagens h
                                            where h.conversa_id = c.id and h.origem = 'humano_celular'
                                              and h.criado_em > now() - interval '60 seconds')))
                     or c.ultima_do_lead_em > rt.marcado_em
                     -- a mesma entrada solta que a retornos_prontos olha (a resposta ao pedido de
                     -- permissão, que não arma a conversa, com o horário da Meta de antes de armar)
                     or exists (select 1 from public.mensagens m
                                 where m.conversa_id = rt.conversa_id and m.direcao = 'entrada'
                                   and m.rodada_id is null
                                   and m.criado_em >= coalesce(
                                         (select ro.iniciada_em from public.rodadas ro
                                           where ro.id = rt.rodada_origem_id),
                                         rt.marcado_em))
                     or not exists (select 1 from public.contatos ct
                                      join public.etapas e on e.id = ct.etapa_id
                                     where ct.id = c.contato_id and e.tipo = 'aberta')
                     or exists (select 1 from public.retornos o
                                 where o.conversa_id = rt.conversa_id and o.tipo = 'retorno'
                                   and o.status in ('pendente', 'em_rodada')))))
     order by rt.vence_em
     limit v_max
       for update of c, rt skip locked
  loop
    begin
      delete from public.retornos rt where rt.id = v_item.id;
      v_total := v_total + 1;
    exception when others then
      raise warning 'retornos_varrer_item_falhou: D %: %', v_item.id, sqlerrm;
    end;
  end loop;

  -- E. Lembrete expirado, em silêncio
  for v_item in
    select rt.id
      from public.retornos rt
      join public.conversas c on c.id = rt.conversa_id
     where rt.tipo = 'lembrete' and rt.status = 'pendente'
       and rt.vence_em <= now() and rt.expira_em <= now()
     order by rt.vence_em
     limit v_max
       for update of c, rt skip locked
  loop
    begin
      update public.retornos rt
         set status = 'nao_enviado',
             nao_enviado_motivo = case when v_desde is null or v_desde > rt.vence_em
                                       then 'desconectado' else 'passou_do_prazo' end,
             resolvido_em = now()
       where rt.id = v_item.id;
      v_total := v_total + 1;
    exception when others then
      raise warning 'retornos_varrer_item_falhou: E %: %', v_item.id, sqlerrm;
    end;
  end loop;

  -- E. Lembrete vencido com a janela oficial fechada, em silêncio
  if v_oficial then
    for v_item in
      select rt.id
        from public.retornos rt
        join public.conversas c on c.id = rt.conversa_id
       where rt.tipo = 'lembrete' and rt.status = 'pendente' and rt.vence_em <= now()
         and (c.ultima_do_lead_em is null or c.ultima_do_lead_em + interval '24 hours' <= now())
       order by rt.vence_em
       limit v_max
         for update of c, rt skip locked
    loop
      begin
        update public.retornos rt
           set status = 'nao_enviado', nao_enviado_motivo = 'fora_24h', resolvido_em = now()
         where rt.id = v_item.id;
        v_total := v_total + 1;
      exception when others then
        raise warning 'retornos_varrer_item_falhou: E %: %', v_item.id, sqlerrm;
      end;
    end loop;
  end if;

  -- F. Órfãos
  for v_item in
    select rt.id, rt.tipo, rt.vence_em, rt.rodada_id, c.modo,
           -- a janela do eco duplicado (como no passo A)
           (c.motivo_humano is not distinct from 'humano_celular' and c.responsavel_id is null
            and exists (select 1 from public.mensagens h
                         where h.conversa_id = c.id and h.origem = 'humano_celular'
                           and h.criado_em > now() - interval '60 seconds')) as eco
      from public.retornos rt
      join public.conversas c on c.id = rt.conversa_id
     where rt.status = 'em_rodada'
       and not exists (select 1 from public.rodadas rd
                        where rd.id = rt.rodada_id and rd.status = 'rodando')
     order by rt.vence_em
     limit v_max
       for update of c, rt skip locked
  loop
    begin
      select * into v_rd from public.rodadas rd where rd.id = v_item.rodada_id;
      -- a rodada concluída sem IA (passos = 0) com bolha: a bolha fixa do áudio, que nunca é o
      -- retorno (a regra do caso 5 da retorno_ao_concluir): o retorno não segue pelas bolhas e,
      -- fechado, sai da rodada (a bolha fixa que sai não o reabre)
      v_bolha := exists (select 1 from public.mensagens m
                          where m.rodada_id = v_item.rodada_id and m.direcao = 'saida'
                            and m.origem = 'nina');
      v_fixa := v_bolha and coalesce(v_rd.passos, 0) = 0;
      if v_bolha and not v_fixa then
        update public.retornos rt set status = 'saindo' where rt.id = v_item.id;
        perform public.retorno_pelas_bolhas(v_item.id);
      elsif v_item.modo is distinct from 'nina' then
        if v_item.tipo = 'retorno' and (now() < v_item.vence_em or v_item.eco) then
          -- levado junto antes da hora, ou a conversa na janela do eco duplicado: volta, e quem
          -- decide é a varredura A (que espera a janela) ou a faixa 1 (fechado no prazo, sai da
          -- rodada da bolha fixa)
          perform public.retorno_volta(v_item.id, now(), v_item.rodada_id);
          if v_fixa then
            update public.retornos rt set rodada_id = null
             where rt.id = v_item.id and rt.status = 'nao_enviado';
          end if;
        else
          -- mantém o rodada_id: se a rodada reviver, o gatilho das bolhas recalcula (a da bolha
          -- fixa, não)
          update public.retornos rt
             set status = 'nao_enviado', nao_enviado_motivo = 'com_equipe', resolvido_em = now(),
                 rodada_id = case when v_fixa then null else rt.rodada_id end
           where rt.id = v_item.id;
        end if;
      else
        if v_rd.status = 'cancelada' then
          -- a mesma regra da retorno_ao_concluir (caso 1) para a rodada cancelada: o desfecho não
          -- depende de quem chega primeiro, a varredura ou o fim da rodada
          if v_item.tipo = 'retorno' and (now() < v_item.vence_em or v_item.eco) then
            perform public.retorno_volta(v_item.id, now(), v_item.rodada_id);
            if v_fixa then
              update public.retornos rt set rodada_id = null
               where rt.id = v_item.id and rt.status = 'nao_enviado';
            end if;
          else
            update public.retornos rt
               set status = 'nao_enviado', nao_enviado_motivo = 'com_equipe', resolvido_em = now(),
                   rodada_id = case when v_fixa then null else rt.rodada_id end
             where rt.id = v_item.id;
          end if;
        elsif v_rd.status = 'concluida' and coalesce(v_rd.passos, 0) > 0
           and (v_item.tipo = 'lembrete' or not public.rodada_tem_fala_do_lead(v_item.rodada_id)) then
          update public.retornos rt

             set status = 'dispensado', resolvido_em = now()
           where rt.id = v_item.id;
        elsif v_item.tipo = 'retorno' then
          -- a bolha fixa: volta em 30 s, como no caso 5 (e, fechado perto do prazo, sai da rodada)
          perform public.retorno_volta(v_item.id,
                                       case when v_fixa then now() + interval '30 seconds' else now() end,
                                       v_item.rodada_id);
          if v_fixa then
            update public.retornos rt set rodada_id = null
             where rt.id = v_item.id and rt.status = 'nao_enviado';
          end if;
        else
          update public.retornos rt
             set status = 'nao_enviado', nao_enviado_motivo = 'nina_falhou', resolvido_em = now(),
                 rodada_id = case when v_fixa then null else rt.rodada_id end
           where rt.id = v_item.id;
        end if;
      end if;
      v_total := v_total + 1;
    exception when others then
      raise warning 'retornos_varrer_item_falhou: F %: %', v_item.id, sqlerrm;
    end;
  end loop;

  -- G. Saindo
  for v_item in
    select rt.id, rt.expira_em, rt.rodada_id
      from public.retornos rt
      join public.conversas c on c.id = rt.conversa_id
     where rt.status = 'saindo'
     order by rt.vence_em
     limit v_max
       for update of c, rt skip locked
  loop
    begin
      perform public.retorno_pelas_bolhas(v_item.id);
      select rt.status into v_depois from public.retornos rt where rt.id = v_item.id;
      if v_depois is distinct from 'saindo' then
        v_total := v_total + 1;
      elsif v_item.expira_em <= now() and v_desde is null
            and not exists (select 1 from public.mensagens m
                             where m.rodada_id = v_item.rodada_id
                               and m.direcao = 'saida' and m.origem = 'nina'
                               and m.status = 'enviando'
                               and coalesce(m.status_em, m.criado_em) > now() - interval '2 minutes')
            and not exists (select 1 from public.mensagens m
                             where m.rodada_id = v_item.rodada_id
                               and m.direcao = 'saida' and m.origem = 'nina'
                               and m.status in ('enviada', 'entregue', 'lida')) then
        -- o gatilho das bolhas o reabre se a bolha sair depois. Com uma bolha em envio há menos de
        -- 2 min, espera a passada seguinte: se o envio terminasse enquanto esta varredura segura o
        -- retorno, o gatilho adiado não o reabriria. A 'enviando' mais velha que isso a
        -- pegar_envios já trata como presa (o mesmo corte de 2 min). A bolha que saiu depois do
        -- recálculo acima (com o gatilho dela adiado por esta trava) também segura: a passada
        -- seguinte recalcula pelas bolhas e grava enviado.
        update public.retornos rt
           set status = 'nao_enviado', nao_enviado_motivo = 'desconectado', resolvido_em = now()
         where rt.id = v_item.id;
        v_total := v_total + 1;
      end if;
    exception when others then
      raise warning 'retornos_varrer_item_falhou: G %: %', v_item.id, sqlerrm;
    end;
  end loop;

  return v_total;
end;
$$;
revoke execute on function public.retornos_varrer(integer) from public, anon, authenticated, service_role;
