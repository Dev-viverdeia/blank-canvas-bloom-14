-- nina_retornos_rodada (envio 4 de 6 dos retornos, 18/11/2026).
-- O fim da rodada passa a fechar o retorno ou o lembrete que a rodada levou e a armar o lembrete
-- automático, e um gatilho novo acompanha as bolhas da Nina até elas saírem:
--   1. concluir_rodada recriada (texto da base 0014, mesma assinatura, mesmo retorno, mesmos
--      grants);
--   2. falhar_rodada recriada (texto da base 0006, mesma assinatura, mesmo retorno, mesmos grants);
--   3. o gatilho mensagens_saida_do_retorno, com a função tg_mensagens_saida_do_retorno().
-- As mudanças estão marcadas "novo (retornos)". Só a pegar_rodadas_com_retornos
-- (nina_retornos_funcoes), que só o servidor novo chama, põe retorno_id numa rodada. A rodada sem
-- retorno_id (toda rodada do servidor publicado hoje) percorre o caminho de hoje: o mesmo insert
-- das bolhas, que devolve o mesmo erro com o mesmo código e a mesma mensagem, o mesmo fecho da
-- rodada e o mesmo fecho da conversa na falha. O que roda a mais nela: a lembrete_ao_concluir, protegida, que, sem o campo
-- espera_resposta (o servidor publicado não o manda), só tenta apagar um lembrete pendente que não
-- existe; e o gatilho das bolhas, que sai na 1ª busca pela chave da rodada.
-- Depende de: nina_retornos_tabelas (retornos e rodadas.retorno_id), nina_retornos_regras
-- (retorno_pelas_bolhas, que o gatilho das bolhas chama) e nina_retornos_funcoes
-- (retorno_ao_concluir, lembrete_ao_concluir e retorno_ao_falhar, que o fim da rodada chama). Não
-- depende do nina_retornos_dashboard. Ordem: 4º envio dos retornos, depois do
-- nina_retornos_funcoes e antes do nina_retornos_relogio. Quando vai ao agente do Lovable: só
-- depois da revisão final do código novo, porque recria funções que o app publicado usa (o
-- nina_retornos_relogio vai por último, logo antes de publicar).
-- Nenhuma tabela nem coluna muda, nada entra no tempo real e nada é semeado: a preparar_copia()
-- não muda neste envio. Só acrescenta (as recriadas mantêm a assinatura). Pode rodar duas vezes.
-- Sem BEGIN/COMMIT.

-- Parte do texto da base 0014 (concluir_rodada) e da base 0006 (falhar_rodada): se outra
-- migration recriar uma delas antes deste envio, a trava recusa (funcao_mudou_antes_dos_retornos).
-- Antes de mandar: conferir na base se uma migration posterior recriou alguma das duas e ler em
-- produção, por SELECT puro, o md5(prosrc) de cada uma (select p.proname, md5(p.prosrc) from
-- pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname =
-- 'public' and p.proname in ('concluir_rodada', 'falhar_rodada')). Se o agente do Lovable tiver
-- reformatado o corpo, a trava também recusa (recusa segura): conferir o texto em produção e só
-- trocar o hash da lista se a diferença for só de forma. Se outra entrega mudou a função, refazer
-- este envio a partir do texto dela (item 12) e trocar os dois hashes dela.

-- ---------------------------------------------------------------------
-- Trava: sem o nina_retornos_tabelas, o nina_retornos_regras ou o nina_retornos_funcoes (também o
-- desfeito pela volta atrás pesada), este envio para aqui (a mensagem diz o primeiro que falta).
-- Depois, com a concluir_rodada ou a falhar_rodada recriada por outra entrega depois do texto de
-- que este envio parte, também para.
-- ---------------------------------------------------------------------
do $$
declare
  v_mudou text;
begin
  if to_regclass('public.retornos') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'rodadas'
                       and column_name = 'retorno_id') then
    raise exception using message = 'falta_nina_retornos_tabelas',
      hint = 'Aplique antes o nina_retornos_tabelas, o nina_retornos_regras e o nina_retornos_funcoes, nessa ordem.';
  end if;
  if to_regprocedure('public.retorno_pelas_bolhas(uuid)') is null then
    raise exception using message = 'falta_nina_retornos_regras',
      hint = 'Aplique antes o nina_retornos_regras e o nina_retornos_funcoes, nessa ordem.';
  end if;
  if to_regprocedure('public.retorno_ao_concluir(uuid, public.mensagem_status, integer, boolean, text, jsonb, integer, boolean)') is null
     or to_regprocedure('public.lembrete_ao_concluir(uuid, public.mensagem_status, integer, jsonb)') is null
     or to_regprocedure('public.retorno_ao_falhar(uuid, boolean, smallint, public.conversa_modo)') is null
     or to_regprocedure('public.retornos_ligados()') is null then
    raise exception using message = 'falta_nina_retornos_funcoes',
      hint = 'Aplique antes o nina_retornos_funcoes.';
  end if;
  -- o nina_retornos_funcoes em vigor (e não o texto que a volta atrás pesada grava): a irmã leva às
  -- faixas e o lembrete arma. Obriga, no refazer, o nina_retornos_funcoes antes deste envio.
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = to_regprocedure('public.pegar_rodadas_com_retornos(integer, integer)')
                    and p.prosrc like '%retornos_prontos%')
     or exists (select 1 from pg_catalog.pg_proc p
                 where p.oid = to_regprocedure('public.lembrete_ao_concluir(uuid, public.mensagem_status, integer, jsonb)')
                   and p.prosrc !~* 'insert\s+into\s+public\.retornos') then
    raise exception using message = 'falta_nina_retornos_funcoes',
      hint = 'O nina_retornos_funcoes não está em vigor (a volta atrás pesada o desfez?): reaplique-o antes deste envio. Se ele foi aplicado, o agente pode ter reformatado o corpo: conferir o texto em produção.';
  end if;
  -- o texto em vigor de cada recriada: o da base de que este envio parte (também o que a volta
  -- atrás pesada grava) ou o deste envio (aplicado de novo)
  select string_agg(e.nome, ', ' order by e.nome) into v_mudou
    from (values
      ('concluir_rodada', '3ad0e4974c52410d11ccf2d0c2ec01cf', 'c528fd90c8ab33787672a7632cc54fe9'),
      ('falhar_rodada',   '01db0be283e10e21e2051a14b8e4ef89', '6aa02d88b2b7b727b0325cf192323957')
    ) e(nome, h_partida, h_envio)
    join pg_catalog.pg_proc p on p.proname = e.nome
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
   where md5(p.prosrc) not in (e.h_partida, e.h_envio);
  if v_mudou is not null then
    raise exception using message = 'funcao_mudou_antes_dos_retornos',
      hint = 'Recriadas por outra entrega depois do texto de partida deste envio: ' || v_mudou
             || '. Refaça este envio a partir do texto mais recente de cada uma na base (item 12) e troque os hashes da lista.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 1. concluir_rodada: o texto da base 0014, com as mudanças marcadas "novo (retornos)".
-- Cada item de p_respostas continua como na 0014: {"texto": "..."} ou o áudio da Nina
-- ({"tipo": "audio", "id", "transcricao", "midia_caminho", "midia_mime", "midia_tamanho",
-- "midia_duracao_s"}). O que entra, só para a rodada com retorno_id:
--   - mista = a rodada leu entrada do lead (a faixa 0 levou o retorno junto); pura = nenhuma
--     entrada (as faixas 1 e 2, de retorno ou de lembrete);
--   - o descarte: a rodada pura em que o lead escreveu enquanto a Nina escrevia (a conversa ficou
--     armada) não grava bolha. O retorno volta e a faixa 0 o leva junto da resposta ao lead, numa
--     mensagem só (caso 8); o lembrete vira dispensado. Na rodada pura do lembrete, também quando o
--     lead escreveu ou respondeu ao pedido de permissão durante ela (a entrada solta desde a âncora
--     do lembrete, a mesma da retornos_prontos: a resposta ao pedido não arma a conversa); a do
--     retorno combinado não (a resposta ao pedido não trava o retorno);
--   - na rodada pura, sem_conexao_ativa e janela_fechada do gatilho do insert não sobem: a
--     retorno_ao_concluir decide (o retorno volta ou fica "não enviado"; a conversa não vai para a
--     equipe por isso). Na mista e na rodada comum, os dois sobem como hoje;
--   - depois do fecho da rodada, a retorno_ao_concluir fecha o retorno ou o lembrete. Na rodada
--     pura, sem proteção, de propósito: se ela errar, a rodada inteira falha e o servidor a trata
--     como falha passageira, em vez de fechar o retorno errado em silêncio. Na mista, protegida: um
--     defeito nela nunca derruba a resposta ao lead que falou (B1); o retorno fica em_rodada e a
--     varredura (F) o fecha pelas bolhas.
-- E para toda rodada, por último (a ordem do quadro 2: as bolhas, o retorno saindo, o lembrete), a
-- lembrete_ao_concluir, protegida: um defeito nela nunca segura o fim da rodada.
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
  -- novo (retornos)
  v_lead      boolean := false;
  v_descartar boolean := false;
  v_n         integer := 0;
  v_erro      text;
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

  -- novo (retornos): a rodada que leva um retorno ou um lembrete. v_lead = mista (leu entrada do
  -- lead). Descarte: a pura em que o lead escreveu durante a rodada (a conversa ficou armada) e,
  -- só na de lembrete, a entrada solta do lead desde a âncora do lembrete (a resposta ao pedido de
  -- permissão, que não arma a conversa; a âncora é a da retornos_prontos).
  if v_r.retorno_id is not null then
    v_lead := exists (select 1 from public.mensagens e
                       where e.rodada_id = p_rodada and e.direcao = 'entrada');
    v_descartar := v_status = 'na_fila' and not v_lead
      and (v_c.responder_apos is not null
           or exists (select 1 from public.retornos rt
                       where rt.id = v_r.retorno_id and rt.tipo = 'lembrete'
                         and exists (select 1 from public.mensagens e
                                      where e.conversa_id = v_c.id and e.direcao = 'entrada'
                                        and e.rodada_id is null
                                        and e.criado_em >= coalesce(
                                              (select ro.iniciada_em from public.rodadas ro
                                                where ro.id = rt.rodada_origem_id),
                                              rt.marcado_em))));
  end if;

  -- novo (retornos): o insert de hoje, sem mudar uma letra, dentro de um bloco. Na rodada comum e
  -- na mista, o erro do gatilho do insert sobe igual (o mesmo código e a mesma mensagem).
  begin
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
    where not v_descartar                                          -- novo (retornos)
    order by x.n;
    get diagnostics v_n = row_count;                               -- novo (retornos)
  exception when sqlstate 'P0001' then
    -- novo (retornos): só a rodada pura segura os dois erros do gatilho do insert; o resto sobe
    if v_r.retorno_id is null or v_lead
       or sqlerrm not in ('sem_conexao_ativa', 'janela_fechada') then
      raise;
    end if;
    v_erro := sqlerrm;
    v_n := 0;
  end;

  update public.rodadas r
     set status = case when r.status = 'cancelada' then r.status
                       else 'concluida'::public.rodada_status end,
         ferramentas = coalesce(p_ferramentas, r.ferramentas),
         passos = coalesce(p_passos, r.passos),
         terminada_em = coalesce(r.terminada_em, now())
   where r.id = p_rodada;

  -- novo (retornos): fecha o retorno ou o lembrete que a rodada levou (na pura, sem proteção, de
  -- propósito; na mista, protegida: a resposta ao lead nunca cai por ela)
  if v_r.retorno_id is not null then
    if v_lead then
      begin
        perform public.retorno_ao_concluir(
          p_rodada => p_rodada, p_status => v_status, p_bolhas => v_n, p_descartou => v_descartar,
          p_erro => v_erro, p_ferramentas => p_ferramentas, p_passos => p_passos, p_mista => v_lead);
      exception when others then
        raise warning 'retorno_ao_concluir_falhou: %', sqlerrm;
      end;
    else
      perform public.retorno_ao_concluir(
        p_rodada => p_rodada, p_status => v_status, p_bolhas => v_n, p_descartou => v_descartar,
        p_erro => v_erro, p_ferramentas => p_ferramentas, p_passos => p_passos, p_mista => v_lead);
    end if;
  end if;

  -- novo (retornos): por último, o lembrete (arma ou apaga), em toda rodada e protegido
  begin
    perform public.lembrete_ao_concluir(
      p_rodada => p_rodada, p_status => v_status, p_bolhas => v_n, p_ferramentas => p_ferramentas);
  exception when others then
    raise warning 'lembrete_ao_concluir_falhou: %', sqlerrm;
  end;
end;
$$;

revoke execute on function public.concluir_rodada(uuid, jsonb, jsonb, int) from public, anon, authenticated;
grant execute on function public.concluir_rodada(uuid, jsonb, jsonb, int) to service_role;

-- ---------------------------------------------------------------------
-- 2. falhar_rodada: o texto da base 0006, com as mudanças marcadas "novo (retornos)".
-- O que entra, só para a rodada com retorno_id:
--   - a retorno_ao_falhar fecha ou devolve o retorno ou o lembrete (protegida: a falhar_rodada
--     também é chamada pela limpeza de presas da pegar_rodadas, e um defeito aqui nunca pode
--     derrubar a pegada; se o erro for engolido, a varredura do relógio fecha o retorno);
--   - a rodada de lembrete nunca leva a conversa à equipe nem a arma (uma tentativa só);
--   - a rodada pura de retorno (nenhuma entrada do lead) não arma a conversa na falha passageira:
--     a nova tentativa sai pela faixa 1, com o tentar_apos do retorno. Assim o servidor publicado
--     nunca responde por ela sem saber do retorno (D5). A falha definitiva segue a regra de hoje
--     (a conversa vai para a equipe, e o retorno fica "não enviado").
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
  -- novo (retornos)
  v_entradas integer := 0;
  v_lembrete boolean := false;
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
  -- novo (retornos): quantas entradas do lead a rodada lia (0 = rodada pura de retorno ou lembrete)
  get diagnostics v_entradas = row_count;

  select c.modo into v_modo from public.conversas c where c.id = v_r.conversa_id for update;

  -- novo (retornos): o retorno ou o lembrete que a rodada levava
  if v_r.retorno_id is not null then
    v_lembrete := exists (select 1 from public.retornos rt
                           where rt.id = v_r.retorno_id and rt.tipo = 'lembrete');
    begin
      perform public.retorno_ao_falhar(
        p_rodada => p_rodada, p_passageiro => coalesce(p_passageiro, false),
        p_tentativa => v_r.tentativa, p_modo => v_modo);
    exception when others then
      raise warning 'retorno_ao_falhar_falhou: %', sqlerrm;
    end;
  end if;

  -- se a conversa ja saiu do modo nina (humano assumiu), nao mexe nela
  if v_modo is distinct from 'nina' then
    return;
  end if;

  -- novo (retornos): a rodada de lembrete nunca leva a conversa à equipe nem a arma
  if v_lembrete then
    return;
  end if;

  if coalesce(p_passageiro, false) and coalesce(v_r.tentativa, 1) < 3 then
    -- novo (retornos): a rodada pura de retorno não arma a conversa (a faixa 1 tenta de novo)
    if v_r.retorno_id is null or v_entradas > 0 then
      update public.conversas c
         set responder_apos = now() + interval '30 seconds'
       where c.id = v_r.conversa_id;
    end if;
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
-- 3. O gatilho das bolhas (novo (retornos)). Quando uma bolha da Nina de uma rodada com
-- retorno_id muda de classe (na fila, saiu, falhou, cancelada), o retorno ou o lembrete da rodada
-- é recalculado pelas bolhas (retorno_pelas_bolhas, do nina_retornos_regras): alguma saiu →
-- enviado; nenhuma saiu e alguma falhou → não enviado (o WhatsApp recusou o envio); e de volta, se
-- a bolha volta atrás.
-- - Não dispara em na_fila ↔ enviando nem em enviada → entregue → lida (o caminho mais quente).
-- - A bolha de rodada sem retorno_id (toda bolha de hoje) sai na 1ª busca, pela chave da rodada.
-- - Trava o retorno e, só para devolvê-lo a pendente (retorno_pelas_bolhas), a conversa, sempre com
--   nowait, dentro de um bloco: não espera trava de ninguém (nem o índice de um pendente por
--   conversa, porque quem grava um pendente segura a conversa) e nunca derruba quem mudou a bolha
--   (o envio, o webhook, o Assumir). Se pular, só o saindo e o em_rodada são revistos pela
--   varredura do relógio (em até 1 min); num retorno já fechado (enviado ou não enviado), o
--   recálculo adiado fica até a próxima mudança de classe de uma bolha da rodada.
-- - Só a bolha que sai de 'cancelada' e volta à fila ou sai (o eco duplicado devolve as canceladas,
--   base 0006, concluir_envio), com o retorno da rodada já de volta a pendente (rodada_id nulo: A1,
--   ou o Desconectar depois da hora) ou fechado depois disso pela varredura A (com a equipe, na
--   hora, solto da rodada; o passo A espera a janela de 60 s do eco, então isso só acontece na
--   corrida do fim dela), retoma: o retorno é retomado por esta rodada (saindo) antes de
--   recalcular, em vez de sair de novo, em dobro, pela faixa 1, ou de sair com o retorno marcado
--   como não enviado. A bolha que nunca foi cancelada não
--   retoma, e a da rodada sem IA (passos = 0) também não, nem cancelada e devolvida: a bolha fixa
--   do áudio (caso 5 da retorno_ao_concluir) sai com o retorno já de volta a pendente de
--   propósito, e ele sai depois, pela faixa 1.
-- - Roda depois de mensagens_apos_atualizar e de mensagens_envio_falhou (os gatilhos AFTER rodam
--   na ordem do nome). A regra de hoje da bolha que falha (a conversa vai para a equipe) não muda.
-- ---------------------------------------------------------------------
create or replace function public.tg_mensagens_saida_do_retorno()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ret uuid;
begin
  select rd.retorno_id into v_ret from public.rodadas rd where rd.id = new.rodada_id;
  if v_ret is null then
    return null;
  end if;

  begin
    -- a bolha cancelada que volta à fila ou sai (o eco duplicado, base 0006, concluir_envio), com o
    -- retorno já de volta a pendente (A1 ou o Desconectar depois da hora): retoma. A bolha que nunca
    -- foi cancelada (a bolha fixa do áudio, caso 5 da retorno_ao_concluir) não retoma: o retorno
    -- voltou de propósito e sai depois, pela faixa 1. Nem a bolha fixa cancelada e devolvida pelo
    -- eco: só a bolha de uma rodada com IA (passos > 0) retoma.
    if old.status = 'cancelada'
       and new.status in ('na_fila', 'enviando', 'enviada', 'entregue', 'lida')
       and exists (select 1 from public.rodadas rd
                    where rd.id = new.rodada_id and coalesce(rd.passos, 0) > 0) then
      -- o pendente, ou o que a varredura A fechou com a equipe na hora enquanto o eco segurava a
      -- conversa (o eco era da própria Nina: a equipe não assumiu)
      perform 1 from public.retornos rt
       where rt.id = v_ret and rt.tipo = 'retorno' and rt.rodada_id is null
         and (rt.status = 'pendente'
              or (rt.status = 'nao_enviado' and rt.nao_enviado_motivo = 'com_equipe'))
         for update nowait;
      if found then
        update public.retornos rt
           set status = 'saindo', rodada_id = new.rodada_id, tentar_apos = null,
               nao_enviado_motivo = null, resolvido_em = null
         where rt.id = v_ret;
      end if;
    end if;
    perform 1 from public.retornos rt
     where rt.id = v_ret and rt.rodada_id = new.rodada_id
       and rt.status in ('saindo', 'enviado', 'nao_enviado')
       for update nowait;
    if found then
      perform public.retorno_pelas_bolhas(v_ret);
    end if;
  exception
    when lock_not_available then
      raise warning 'retorno_bolhas_adiado: %', v_ret;
    when others then
      raise warning 'retorno_bolhas_falhou: %', sqlerrm;
  end;
  return null;
end;
$$;

create or replace trigger mensagens_saida_do_retorno
  after update of status on public.mensagens
  for each row
  when (new.direcao = 'saida' and new.origem = 'nina' and new.rodada_id is not null
        and (case when old.status in ('na_fila', 'enviando') then 1
                  when old.status in ('enviada', 'entregue', 'lida') then 2
                  when old.status = 'falhou' then 3 else 4 end)
            is distinct from
            (case when new.status in ('na_fila', 'enviando') then 1
                  when new.status in ('enviada', 'entregue', 'lida') then 2
                  when new.status = 'falhou' then 3 else 4 end))
  execute function public.tg_mensagens_saida_do_retorno();

-- Só o gatilho chama (como os outros tg_* do app).
revoke execute on function public.tg_mensagens_saida_do_retorno() from public, anon, authenticated, service_role;
