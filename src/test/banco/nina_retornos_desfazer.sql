-- nina_retornos_desfazer (a volta atrás "pesada" dos retornos, 18/11/2026).
-- Mora em src/test/banco/nina_retornos_desfazer.sql (não é migration; nunca vai para base/ nem
-- para drizzle/ a não ser enviado ao agente do Lovable). O teste confere a lista de hashes em toda
-- rodada. Quando uma migration recriar uma das 8 funções, atualizar este arquivo ou, com os
-- retornos estáveis, apagá-lo junto com o grupo de testes.
-- Só se a volta atrás leve não bastar, e só DEPOIS de ela estar publicada: o commit de revert do
-- código na main, publicado, com o servidor antigo (o que não conhece retornos) no ar. Vai como um
-- envio novo ao agente do Lovable, com OK do Davi. Com o código novo no ar, este arquivo não serve
-- e a trava recusa: a Nina continuaria marcando retornos que nunca sairiam.
-- Ordem: depois do nina_retornos_rodada (em produção, depois dos 6 envios dos retornos); a trava
-- recusa antes dele. Quando vai ao agente do Lovable: só depois de a volta atrás leve estar
-- publicada (ver "Quando aplicar", abaixo), com OK do Davi.
-- Só recria funções, com as mesmas assinaturas; nada é apagado (as tabelas, as colunas, os dados,
-- o gatilho das bolhas e os dois jobs ficam):
--   1. concluir_rodada e falhar_rodada com o texto exato de antes dos retornos (base 0014 e base
--      0006), com os mesmos grants: o fim da rodada volta a não saber de retorno nem de lembrete;
--   2. tg_mensagens_saida_do_retorno() devolve null: o gatilho das bolhas fica, sem efeito;
--   3. lembrete_ao_concluir não faz nada: o lembrete deixa de armar;
--   4. pegar_rodadas_com_retornos só chama a pegar_rodadas de hoje, com os dois parâmetros de
--      sempre: nenhuma rodada de retorno ou de lembrete nasce;
--   5. relogio_retornos só varre, sem pedir passada ao worker. Os estados continuam convergindo
--      sozinhos, pelo job de cada minuto, enquanto ele estiver ligado: o retorno pendente com a
--      equipe na hora marcada vira "não enviado"; o resto, 3 h depois da hora ("passou do prazo");
--      o lembrete pendente some ou expira; o que estava numa rodada ou saindo fecha pelas bolhas;
--   6. nina_marcar_retorno recusa (retornos_desligados) depois das checagens da rodada: se o código
--      novo for republicado sem reaplicar o nina_retornos_funcoes e o nina_retornos_rodada, a Nina
--      não marca retorno novo que não sairia. A proteção é parcial: a nina_retorno_da_rodada (que
--      não volta) continua mostrando a ela o retorno pendente de antes, que só fecha pela varredura
--      (com a equipe na hora ou 3 h depois). Por isso o código novo só volta depois do refazer
--      inteiro, conferido como no parágrafo "Para refazer os retornos";
--   7. motor_pendencias_com_retornos devolve só a motor_pendencias de hoje (a mesma trava de
--      acesso): o retorno parado não acende o atraso nem prende o worker novo num laço.
-- Das 8 funções recriadas, 5 são do nina_retornos_funcoes (lembrete_ao_concluir,
-- pegar_rodadas_com_retornos, relogio_retornos, nina_marcar_retorno e
-- motor_pendencias_com_retornos) e 3 do nina_retornos_rodada (concluir_rodada, falhar_rodada e
-- tg_mensagens_saida_do_retorno).
-- Não volta (não precisa): as funções do nina_retornos_regras e as outras do nina_retornos_funcoes,
-- que só o servidor novo, o fim da rodada e o relógio chamam e que não criam retorno nem acordam o
-- worker; a preparar_copia() do nina_retornos_relogio (ela continua instalando os dois jobs, e o
-- nina-retornos só varre); e a dashboard_periodo() do nina_retornos_dashboard (sem rodada de
-- retorno, dá o mesmo de hoje).
-- Para refazer os retornos: reaplicar o nina_retornos_funcoes (que devolve a lembrete_ao_concluir,
-- a pegar_rodadas_com_retornos, a relogio_retornos, a nina_marcar_retorno e a
-- motor_pendencias_com_retornos) e depois o nina_retornos_rodada (que devolve a concluir_rodada, a
-- falhar_rodada e a tg_mensagens_saida_do_retorno), nessa ordem; o nina_retornos_regras não
-- precisa voltar (este arquivo não o toca, e a trava do nina_retornos_funcoes o confere). Antes,
-- conferir na base se uma migration posterior recriou alguma função do nina_retornos_funcoes ou do
-- nina_retornos_rodada (também as 6 que este arquivo não toca: retornos_ligados,
-- retorno_ao_concluir, retorno_ao_falhar, nina_retorno_da_rodada, nina_cancelar_retorno e
-- cancelar_retorno): reaplicar o envio inteiro desfaria esse conserto sem aviso. Se recriou, o
-- refazer manda o texto mais recente de cada função na base (item 12). A trava
-- do nina_retornos_rodada recusa (falta_nina_retornos_funcoes) se ele vier antes do
-- nina_retornos_funcoes; o contrário (o nina_retornos_funcoes reaplicado e o nina_retornos_rodada
-- esquecido) nenhuma trava pega, porque o envio que faltou não roda. Nesse meio-termo os retornos
-- ficam desligados: a retornos_ligados (nina_retornos_funcoes) confere o conteúdo do
-- nina_retornos_rodada (a função do gatilho das bolhas que recalcula pelas bolhas, o gatilho ligado
-- e a concluir_rodada que fecha o retorno), e não só o nome, então a irmã só faz a faixa 0, a Nina
-- não marca (retornos_desligados) e o lembrete não arma até o nina_retornos_rodada voltar. Mesmo
-- assim, antes de publicar, conferir por SELECT puro (query_database):
--   select p.proname, md5(p.prosrc) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on
--   n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('concluir_rodada',
--   'falhar_rodada', 'lembrete_ao_concluir', 'motor_pendencias_com_retornos',
--   'nina_marcar_retorno', 'pegar_rodadas_com_retornos', 'relogio_retornos',
--   'tg_mensagens_saida_do_retorno') order by 1
-- As 8 têm de bater com o h_envio da lista da trava deste arquivo. Se alguma estiver no
-- h_desfeito, falta o envio dela (as 5 do nina_retornos_funcoes ou as 3 do nina_retornos_rodada):
-- parar e não publicar. No refazer, os dois jobs ativos não provam o nina_retornos_funcoes nem o
-- nina_retornos_rodada, porque o nina_retornos_relogio não é reaplicado (a preparar_copia() dele
-- já está no banco). Depois, religar o job nina-retornos em More → Database → Manage → Jobs (a
-- preparar_copia() não religa um job desligado: o cron.schedule com o mesmo nome só troca o
-- horário e o comando) e conferir na mesma tela que ele foi religado; só então publicar o código
-- novo de novo.
-- Quando aplicar: ao menos 5 min depois de publicar a volta atrás leve, e depois da 1ª passada do
-- worker antigo. A falhar_rodada de antes arma a conversa na falha passageira, e com ela uma
-- rodada pura de retorno que ainda estivesse rodando seria respondida pelo servidor antigo, que não
-- sabe do retorno. Por isso a trava abaixo recusa o envio enquanto houver rodada com retorno
-- rodando (a limpeza de presas a fecha em 5 min) ou enquanto o último worker que rodou for o novo.
-- Depois de aplicar: deixar o job nina-retornos ligado até a contagem de retornos com status
-- pendente, em_rodada ou saindo chegar a zero (cada um fecha sozinho até 3 h depois da sua hora; o
-- marcado para daqui a 30 dias leva até 30 dias e 3 h), e só então desligá-lo (não apagar) em More
-- → Database → Manage → Jobs: ele só varre, mas roda a cada minuto e enche o histórico do cron. A
-- preparar_copia() do nina_retornos_relogio refaz os dois jobs quando o relógio dela passa de 1
-- dia, sem religar o desligado: depois disso, conferir na mesma tela que o nina-retornos continua
-- desligado.
-- Depende de: o nina_retornos_tabelas, o nina_retornos_regras, o nina_retornos_funcoes e o
-- nina_retornos_rodada (não do nina_retornos_dashboard nem do nina_retornos_relogio). Pode rodar
-- duas vezes. Sem BEGIN/COMMIT.

-- Antes de enviar: conferir na base se alguma migration depois dos envios dos retornos recria uma
-- das 8 funções que este arquivo recria (concluir_rodada, falhar_rodada,
-- tg_mensagens_saida_do_retorno, lembrete_ao_concluir, pegar_rodadas_com_retornos,
-- relogio_retornos, nina_marcar_retorno, motor_pendencias_com_retornos). Se recriar, este arquivo
-- tem de partir do texto mais recente dela (item 12), e a trava abaixo recusa de
-- propósito até isso ser feito. A trava compara o md5(prosrc) de cada uma com a lista dela: se o
-- agente do Lovable tiver reformatado um corpo ao aplicar o nina_retornos_funcoes ou o
-- nina_retornos_rodada, ela também recusa (recusa segura); conferir então em produção, por SELECT
-- puro, o md5(prosrc) e o texto, e só trocar o hash da lista se a diferença for só de forma.
-- Foi o que aconteceu com a falhar_rodada em 19/11/2026: o nina_retornos_rodada foi aplicado
-- (drizzle 0023, base 0045) com uma linha em branco a menos dentro dela do que o texto revisado (a
-- transcrição do envio a perdeu; o resto do arquivo é igual, byte a byte). O h_envio dela na lista
-- abaixo é o md5 do corpo aplicado (1c3d6a2f...), conferido em produção por SELECT puro. A trava do
-- próprio nina_retornos_rodada guarda o md5 do texto revisado (6aa02d88...) e por isso recusa ser
-- reaplicada por cima de si mesma; depois deste arquivo ela passa (ele devolve a falhar_rodada ao
-- texto de partida), e o refazer descrito acima continua valendo.

-- ---------------------------------------------------------------------
-- Trava: sem o nina_retornos_regras, o nina_retornos_funcoes e o nina_retornos_rodada, não há o
-- que desfazer. Com uma das 8 funções recriada depois dos envios (o texto em vigor não é o do
-- envio nem o deste arquivo), com uma rodada de retorno ou de lembrete ainda rodando, ou com o
-- servidor novo ainda no ar (retornos_no_ar(): o último worker que rodou conhece retornos), também
-- para.
-- ---------------------------------------------------------------------
do $$
declare
  v_mudou text;
begin
  if to_regprocedure('public.pegar_rodadas_com_retornos(integer, integer)') is null
     or to_regprocedure('public.lembrete_ao_concluir(uuid, public.mensagem_status, integer, jsonb)') is null
     or to_regprocedure('public.relogio_retornos()') is null
     or to_regprocedure('public.retornos_varrer(integer)') is null
     or to_regprocedure('public.retornos_no_ar()') is null
     or to_regprocedure('public.tg_mensagens_saida_do_retorno()') is null then
    raise exception using message = 'falta_nina_retornos_rodada',
      hint = 'Não há o que desfazer: o nina_retornos_regras, o nina_retornos_funcoes e o nina_retornos_rodada não estão todos neste banco.';
  end if;
  -- o texto em vigor de cada uma: o md5 do corpo do envio (nina_retornos_funcoes ou
  -- nina_retornos_rodada) ou o do corpo que este arquivo grava (aceitar os dois mantém o "pode
  -- rodar duas vezes" e o "refazer, depois desfazer de novo")
  select string_agg(e.nome, ', ' order by e.nome) into v_mudou
    from (values
      ('concluir_rodada',               'c528fd90c8ab33787672a7632cc54fe9', '3ad0e4974c52410d11ccf2d0c2ec01cf'),
      ('falhar_rodada',                 '1c3d6a2fd5326dd6a154c51d1cbca400', '01db0be283e10e21e2051a14b8e4ef89'),
      ('lembrete_ao_concluir',          '54b43bf0706d989ca4a494138bb4c061', 'df1d27b72395121809e164e74504d6d6'),
      ('motor_pendencias_com_retornos', 'fdedfa456eff1a9e916575c53bd0f54c', '29f16df3cce54e9cb161733cfd78b145'),
      ('nina_marcar_retorno',           '11beed4cfe99d84eb46e6238950a55db', '3cd20eea50f333ad87161ab9699c1f0e'),
      ('pegar_rodadas_com_retornos',    '8184e62b6caeb3712b13fbdc4adcd32b', '97ee62334ac3713aa8c05be749d69ec7'),
      ('relogio_retornos',              '5756a38970d8f858e232b305c054939a', 'dec281e2ed6c82f627bf0e2a4ccd544e'),
      ('tg_mensagens_saida_do_retorno', '66a78d5d2fb013f99d78696dbd32b9e9', '969e0ac3d849820c6d57760bd9cd5671')
    ) e(nome, h_envio, h_desfeito)
    join pg_catalog.pg_proc p on p.proname = e.nome
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
   where md5(p.prosrc) not in (e.h_envio, e.h_desfeito);
  if v_mudou is not null then
    raise exception using message = 'funcao_mudou_depois_dos_retornos',
      hint = 'Estas funções foram recriadas depois dos envios dos retornos: ' || v_mudou
             || '. Refaça este arquivo a partir do texto mais recente de cada uma na base (item 12) antes de enviar.';
  end if;
  if exists (select 1 from public.rodadas r where r.status = 'rodando' and r.retorno_id is not null) then
    raise exception using message = 'rodada_de_retorno_rodando',
      hint = 'Espere a limpeza de presas (5 min) e envie de novo.';
  end if;
  if public.retornos_no_ar() then
    raise exception using message = 'servidor_novo_no_ar',
      hint = 'O último worker que rodou conhece retornos: publique antes a volta atrás leve, espere a 1ª passada do worker antigo (worker_retornos_em < worker_visto_em) e envie de novo.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 1a. concluir_rodada: o texto exato da base 0014 (antes dos retornos).
-- ---------------------------------------------------------------------
create or replace function public.concluir_rodada(
  p_rodada uuid, p_respostas jsonb, p_ferramentas jsonb, p_passos int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r       public.rodadas;
  v_c       public.conversas;
  v_status  public.mensagem_status;
  v_conexao uuid;
begin
  select * into v_r from public.rodadas r where r.id = p_rodada for update;
  if not found or v_r.status not in ('rodando', 'cancelada') then
    raise exception using message = 'rodada_nao_rodando', errcode = 'P0001';
  end if;

  select * into v_c from public.conversas c where c.id = v_r.conversa_id for update;

  if v_r.status = 'rodando'
     and (v_c.modo = 'nina' or coalesce(v_r.passou_humano, false))
     and not exists (select 1 from public.mensagens h
                     where h.conversa_id = v_c.id
                       and h.origem in ('humano_tela', 'humano_celular')
                       and h.criado_em >= v_r.iniciada_em) then
    v_status := 'na_fila';
  else
    v_status := 'cancelada';
  end if;

  select cx.id into v_conexao from public.conexoes cx where cx.ativa limit 1;
  v_conexao := coalesce(v_conexao, v_c.conexao_id);

  with itens as (
    select e.ord,
           case when e.val ->> 'tipo' = 'audio' then 'audio' else 'texto' end as tipo,
           e.val ->> 'texto' as texto,
           btrim(coalesce(e.val ->> 'transcricao', '')) as transcricao,
           case when (e.val ->> 'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then (e.val ->> 'id')::uuid end as id,
           e.val ->> 'midia_caminho' as caminho,
           e.val ->> 'midia_mime' as mime,
           -- CASE aninhado: só converte depois de saber que é número (a ordem de um AND não é garantida)
           case when jsonb_typeof(e.val -> 'midia_tamanho') = 'number' then
             case when (e.val ->> 'midia_tamanho')::numeric between 1 and 104857600
                  then round((e.val ->> 'midia_tamanho')::numeric)::bigint end
           end as tamanho,
           case when jsonb_typeof(e.val -> 'midia_duracao_s') = 'number' then
             case when (e.val ->> 'midia_duracao_s')::numeric between 0 and 86400
                  then round((e.val ->> 'midia_duracao_s')::numeric)::integer end
           end as duracao
    from jsonb_array_elements(case when jsonb_typeof(p_respostas) = 'array' then p_respostas else '[]'::jsonb end)
         with ordinality as e(val, ord)
    where jsonb_typeof(e.val) = 'object'
  ), validos as (
    select i.*, row_number() over (order by i.ord) as n
    from itens i
    where (i.tipo = 'texto' and btrim(coalesce(i.texto, '')) <> '')
       or (i.tipo = 'audio'
           and i.id is not null
           and i.caminho = v_c.id::text || '/' || i.id::text
           and i.transcricao <> ''
           and coalesce(i.mime, '') ~* '^audio/[a-z0-9.+-]+(;.*)?$')
  )
  insert into public.mensagens (id, conversa_id, conexao_id, direcao, origem, tipo, texto,
                                transcricao, midia_caminho, midia_mime, midia_tamanho,
                                midia_duracao_s, midia_status, status, ordem, enviar_apos,
                                rodada_id, momento)
  select case when x.tipo = 'audio' then x.id else gen_random_uuid() end,
         v_c.id, v_conexao, 'saida', 'nina', x.tipo::public.mensagem_tipo,
         case when x.tipo = 'texto' then x.texto end,
         case when x.tipo = 'audio' then x.transcricao end,
         case when x.tipo = 'audio' then x.caminho end,
         case when x.tipo = 'audio' then x.mime end,
         case when x.tipo = 'audio' then x.tamanho end,
         case when x.tipo = 'audio' then x.duracao end,
         case when x.tipo = 'audio' then 'copiada'::public.midia_status end,
         v_status, x.n, now() + (x.n - 1)::int * interval '2 seconds', p_rodada, now()
  from validos x
  order by x.n;

  update public.rodadas r
     set status = case when r.status = 'cancelada' then r.status
                       else 'concluida'::public.rodada_status end,
         ferramentas = coalesce(p_ferramentas, r.ferramentas),
         passos = coalesce(p_passos, r.passos),
         terminada_em = coalesce(r.terminada_em, now())
   where r.id = p_rodada;
end;
$$;

revoke execute on function public.concluir_rodada(uuid, jsonb, jsonb, int) from public, anon, authenticated;
grant execute on function public.concluir_rodada(uuid, jsonb, jsonb, int) to service_role;

-- ---------------------------------------------------------------------
-- 1b. falhar_rodada: o texto exato da base 0006 (antes dos retornos).
-- ---------------------------------------------------------------------
create or replace function public.falhar_rodada(
  p_rodada uuid, p_motivo public.motivo_humano, p_passageiro boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.rodadas;
  v_modo public.conversa_modo;
begin
  if exists (select 1 from public.rodadas r where r.id = p_rodada and r.status = 'cancelada') then
    return;
  end if;
  v_r := public.rodada_rodando(p_rodada);

  update public.rodadas r
     set status = 'falhou', motivo = p_motivo, terminada_em = now()
   where r.id = p_rodada;

  update public.mensagens m
     set rodada_id = null
   where m.rodada_id = p_rodada and m.direcao = 'entrada';

  select c.modo into v_modo from public.conversas c where c.id = v_r.conversa_id for update;

  -- se a conversa ja saiu do modo nina (humano assumiu), nao mexe nela
  if v_modo is distinct from 'nina' then
    return;
  end if;

  if coalesce(p_passageiro, false) and coalesce(v_r.tentativa, 1) < 3 then
    update public.conversas c
       set responder_apos = now() + interval '30 seconds'
     where c.id = v_r.conversa_id;
  else
    update public.conversas c
       set modo = 'humano',
           aguardando_humano_desde = now(),
           motivo_humano = p_motivo,
           responder_apos = null
     where c.id = v_r.conversa_id;

    -- novo
    update public.rodadas r set foi_para_equipe = true where r.id = p_rodada;
    insert into public.conversa_eventos (conversa_id, tipo, motivo)
    values (v_r.conversa_id, 'passou', p_motivo);
  end if;
end;
$$;

revoke execute on function public.falhar_rodada(uuid, public.motivo_humano, boolean) from public, anon, authenticated;
grant execute on function public.falhar_rodada(uuid, public.motivo_humano, boolean) to service_role;

-- ---------------------------------------------------------------------
-- 2. O gatilho das bolhas fica, sem efeito.
-- ---------------------------------------------------------------------
create or replace function public.tg_mensagens_saida_do_retorno()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  return null;
end;
$$;

revoke execute on function public.tg_mensagens_saida_do_retorno() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. O lembrete deixa de armar (nada mais chama esta função depois do passo 1; fica por defesa).
-- ---------------------------------------------------------------------
create or replace function public.lembrete_ao_concluir(
  p_rodada uuid, p_status public.mensagem_status, p_bolhas integer, p_ferramentas jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  return;
end;
$$;

revoke execute on function public.lembrete_ao_concluir(uuid, public.mensagem_status, integer, jsonb) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. Nenhuma rodada de retorno ou de lembrete nasce: só a pegar_rodadas de hoje.
-- ---------------------------------------------------------------------
create or replace function public.pegar_rodadas_com_retornos(p_limite integer, p_limite_puras integer)
returns setof public.rodadas
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
    select r.* from public.pegar_rodadas(p_limite) r order by r.criado_em, r.id;
end;
$$;

revoke execute on function public.pegar_rodadas_com_retornos(integer, integer) from public, anon, authenticated;
grant execute on function public.pegar_rodadas_com_retornos(integer, integer) to service_role;

-- ---------------------------------------------------------------------
-- 5. O relógio dos retornos só varre (os estados convergem; nenhuma passada é pedida ao worker).
-- ---------------------------------------------------------------------
create or replace function public.relogio_retornos()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform public.retornos_varrer(500);
  exception when others then
    raise warning 'retornos_varrer_falhou: %', sqlerrm;
  end;
end;
$$;

revoke execute on function public.relogio_retornos() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 6. A ferramenta marcar_retorno da Nina recusa (retornos_desligados), depois das mesmas
-- checagens da rodada: se o código novo voltar ao ar sem reaplicar o nina_retornos_funcoes e o
-- nina_retornos_rodada, a Nina não confirma ao lead um retorno que nunca sairia. Mesma assinatura,
-- mesmo retorno, mesmos grants.
-- ---------------------------------------------------------------------
create or replace function public.nina_marcar_retorno(
  p_rodada uuid, p_data date, p_hora time, p_motivo text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r    public.rodadas;
  v_conv uuid;
begin
  -- a conversa antes da rodada (a ordem do Assumir); o conversa_id de uma rodada nunca muda
  select rd.conversa_id into v_conv from public.rodadas rd where rd.id = p_rodada;
  perform 1 from public.conversas c where c.id = v_conv for update;
  v_r := public.rodada_rodando(p_rodada);

  if not public.rodada_tem_fala_do_lead(p_rodada) then
    raise exception using message = 'rodada_sem_lead', errcode = 'P0001';
  end if;

  raise exception using message = 'retornos_desligados', errcode = 'P0001';
end;
$$;

revoke execute on function public.nina_marcar_retorno(uuid, date, time, text) from public, anon, authenticated;
grant execute on function public.nina_marcar_retorno(uuid, date, time, text) to service_role;

-- ---------------------------------------------------------------------
-- 7. "A Nina está atrasada" volta a ser só a motor_pendencias de hoje, com a mesma trava de acesso:
-- o retorno que nunca vai sair não acende o atraso nem prende o worker num laço. Mesma assinatura,
-- mesmo retorno, mesmos grants.
-- ---------------------------------------------------------------------
create or replace function public.motor_pendencias_com_retornos()
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
    select mp.proximo_em, mp.vencido_desde, mp.atrasado_desde from public.motor_pendencias() mp;
end;
$$;

revoke execute on function public.motor_pendencias_com_retornos() from public, anon;
grant execute on function public.motor_pendencias_com_retornos() to authenticated, service_role;
