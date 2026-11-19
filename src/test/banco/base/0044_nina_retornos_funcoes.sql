-- nina_retornos_funcoes (envio 3 de 6 dos retornos, 18/11/2026).
-- As funções dos retornos da Nina que o servidor, a tela, o fim da rodada e o relógio chamam.
-- Todas novas e inertes: só o servidor novo as alcança. Nenhuma função que existe hoje muda; a
-- concluir_rodada e a falhar_rodada (que chamam as três do fim da rodada) são recriadas no
-- nina_retornos_rodada.
-- Chamadas pelo servidor (service_role):
-- - pegar_rodadas_com_retornos(p_limite, p_limite_puras): chama a pegar_rodadas de hoje (faixa 0,
--   sem mudança), varre, leva junto o retorno vencido da conversa em que o lead falou e, com a
--   vaga que sobrou, cria as rodadas de retorno (faixa 1) e de lembrete (faixa 2). As partes novas
--   nunca derrubam a faixa 0.
-- - nina_retorno_da_rodada(p_rodada): lê o retorno da rodada, sem gravar e sem travar (com
--   vencido: a hora marcada já passou; na rodada comum, nunca o de prazo vencido).
-- - nina_marcar_retorno e nina_cancelar_retorno: as ferramentas da Nina (só em rodada com fala do
--   lead).
-- Chamada só pela tela (cliente logado; o grant ao service_role segue o das outras RPCs da equipe,
-- mas sem membro ela recusa com sem_acesso):
-- - cancelar_retorno(p_retorno): o Cancelar da equipe (qualquer membro ativo).
-- Chamada pela tela e pelo servidor (authenticated, service_role):
-- - motor_pendencias_com_retornos(): a motor_pendencias de hoje (que não muda) mais o atraso do
--   retorno combinado, com a mesma trava de acesso. O lembrete nunca conta.
-- Internas (só o dono):
-- - retornos_ligados(): a regra única dos retornos ligados (abaixo). Quem chama: a
--   lembrete_ao_concluir, a nina_marcar_retorno, a pegar_rodadas_com_retornos, a
--   motor_pendencias_com_retornos e a relogio_retornos (não acorda o worker pelo item pronto);
-- - lembrete_ao_concluir, retorno_ao_concluir e retorno_ao_falhar: o fim da rodada. Quem chama: a
--   concluir_rodada e a falhar_rodada recriadas no nina_retornos_rodada (antes dele, ninguém);
-- - relogio_retornos(): o relógio dos retornos. Quem chama: o job nina-retornos, que a
--   preparar_copia() do nina_retornos_relogio instala. Varre e, quando há retorno ou lembrete
--   pronto, rodada de retorno presa ou bolha de retorno parada na fila, acorda o worker pela
--   acordar_motor que já existe; com o servidor antigo no ar e algum item pronto, isso dá um toque
--   à toa a cada ~10 min, de propósito (ver a relogio_retornos).
-- Desligados até o conjunto estar inteiro (retornos_ligados): sem o relógio da versão 1
-- (motor.relogio_versao, que só a preparar_copia() do nina_retornos_relogio grava) ou sem o gatilho
-- das bolhas do nina_retornos_rodada, a pegar_rodadas_com_retornos só faz a faixa 0, a
-- nina_marcar_retorno recusa (retornos_desligados), a lembrete_ao_concluir não arma (só apaga o
-- pendente), a motor_pendencias_com_retornos devolve só a de hoje e a relogio_retornos não acorda
-- o worker pelo item pronto (só pelo preso). O servidor novo publicado antes desses dois envios age como o de hoje, e a Nina não
-- promete retorno que não sairia (até a 1ª preparar_copia() nova: até ~1 h).
-- Usam as leituras e as regras do nina_retornos_regras: rodada_tem_fala_do_lead, retorno_instante,
-- lembrete_vence_em, lembrete_expira_em, whatsapp_conectado_desde, retornos_no_ar,
-- retornos_prontos, retorno_volta e retornos_varrer (a trava abaixo confere cada uma pela
-- assinatura), e a coluna retornos.lembrete_horas, que o nina_retornos_regras cria e a
-- lembrete_ao_concluir grava (a trava também a confere). A retornos_ligados é de language sql
-- (conferida na criação: lê só a tabela motor, do nina_retornos_tabelas); as outras deste envio são
-- plpgsql (o corpo só é conferido quando roda). Nenhuma função do nina_retornos_regras chama uma
-- deste envio.
-- Depende de: nina_retornos_tabelas, nina_retornos_regras (as funções e a coluna
-- retornos.lembrete_horas) e da base 0037. Ordem: 3º envio dos retornos, depois do
-- nina_retornos_regras e antes do nina_retornos_rodada e do nina_retornos_relogio.
-- Quando vai ao agente do Lovable: antes do código novo, em envios separados e seguidos (o
-- nina_retornos_tabelas, já aplicado, depois o nina_retornos_regras, depois este), cada um com o
-- seu OK; os três são inertes com o servidor de hoje no ar, e o código novo precisa do types.ts
-- gerado com eles. Este envio não cria tabela nem coluna, nada é semeado, sem tempo real: a
-- preparar_copia() não muda aqui. Só acrescenta. Pode rodar duas vezes. Sem BEGIN/COMMIT.

-- ---------------------------------------------------------------------
-- Trava: sem o nina_retornos_tabelas, sem as funções da base ou sem o nina_retornos_regras (as
-- funções dele e a coluna retornos.lembrete_horas, que ele cria), este envio para aqui.
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
                       and column_name = 'worker_retornos_em')
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'motor'
                       and column_name = 'relogio_versao') then
    raise exception using message = 'falta_nina_retornos_tabelas',
      hint = 'Aplique antes o nina_retornos_tabelas e o nina_retornos_regras, nessa ordem.';
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
  if to_regprocedure('public.rodada_tem_fala_do_lead(uuid)') is null
     or to_regprocedure('public.retorno_instante(date, time without time zone)') is null
     or to_regprocedure('public.lembrete_vence_em(timestamptz, integer, uuid)') is null
     or to_regprocedure('public.lembrete_expira_em(timestamptz)') is null
     or to_regprocedure('public.whatsapp_conectado_desde()') is null
     or to_regprocedure('public.retornos_no_ar()') is null
     or to_regprocedure('public.retornos_prontos()') is null
     or to_regprocedure('public.retorno_volta(uuid, timestamptz, uuid)') is null
     or to_regprocedure('public.retornos_varrer(integer)') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'retornos'
                       and column_name = 'lembrete_horas') then
    raise exception using message = 'falta_nina_retornos_regras',
      hint = 'Aplique antes o nina_retornos_regras (depois do nina_retornos_tabelas): ele cria as leituras e as regras e a coluna retornos.lembrete_horas.';
  end if;
end;
$$;

-- =====================================================================
-- 0. Os retornos ligados (interna; vem antes de quem a usa)
-- =====================================================================

-- O conjunto inteiro no banco: o relógio da versão 1 (motor.relogio_versao, que só a
-- preparar_copia() do nina_retornos_relogio grava) e o nina_retornos_rodada em vigor, pelo
-- conteúdo e não só pelo nome: a função do gatilho das bolhas que recalcula, o gatilho ligado e a
-- concluir_rodada que fecha o retorno. Depois da volta atrás pesada, um refazer pela metade (só o
-- nina_retornos_funcoes) fica desligado. O like aguenta o agente do Lovable reformatar o corpo.
-- Sem o conjunto, um retorno ou um lembrete não sairia. Quem chama: a lembrete_ao_concluir (não
-- arma), a nina_marcar_retorno (retornos_desligados), a pegar_rodadas_com_retornos (só a faixa 0),
-- a motor_pendencias_com_retornos (só a de hoje) e a relogio_retornos (não acorda o worker pelo
-- item pronto).
create or replace function public.retornos_ligados()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select mo.relogio_versao >= 1 from public.motor mo where mo.id), false)
     and exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = to_regprocedure('public.tg_mensagens_saida_do_retorno()')
                    and p.prosrc like '%retorno_pelas_bolhas%')
     and exists (select 1 from pg_catalog.pg_trigger tg
                  where tg.tgrelid = to_regclass('public.mensagens')
                    and tg.tgname = 'mensagens_saida_do_retorno'
                    and tg.tgenabled <> 'D')
     and exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = to_regprocedure('public.concluir_rodada(uuid, jsonb, jsonb, integer)')
                    and p.prosrc like '%retorno_ao_concluir%');
$$;
revoke execute on function public.retornos_ligados() from public, anon, authenticated, service_role;

-- =====================================================================
-- 1. O fim da rodada (internas: a concluir_rodada e a falhar_rodada do nina_retornos_rodada as
--    chamam com a rodada e a conversa já travadas)
-- =====================================================================

-- O lembrete no fim de toda rodada (a concluir_rodada a chama protegida, com a rodada e a conversa
-- travadas). Com o servidor antigo só o passo de apagar roda, e não acha nada.
-- 1. Rodada de lembrete nunca arma outro lembrete.
-- 2 e 3. O lead falou nesta rodada, ou a Nina escreveu de novo: o silêncio que o lembrete contava
--    acabou ou recomeçou, e o pendente é apagado (também com os retornos desligados).
-- 4 a 12. Arma só com bolha na fila e os retornos ligados (retornos_ligados: desligados, o lembrete
--    não sairia), o último responder aceito com espera_resposta = 'sim', o ajuste ligado, a
--    conversa com a Nina e não armada, sem entrada solta do lead desde o começo da rodada (a
--    resposta ao pedido de permissão, que não arma a conversa: qualquer mensagem do lead conta),
--    a etapa aberta, nenhum retorno aberto (o da própria rodada
--    já está saindo), um lembrete só por silêncio (o que a equipe cancelou também conta, mesmo
--    depois de o membro ser apagado: só a cancelar_retorno leva um lembrete a cancelado) e, na
--    oficial, dentro das 24 h.
create or replace function public.lembrete_ao_concluir(
  p_rodada uuid, p_status public.mensagem_status, p_bolhas integer, p_ferramentas jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r      public.rodadas;
  v_c      public.conversas;
  v_lead   boolean;
  v_escreveu boolean := coalesce(p_status = 'na_fila', false) and coalesce(p_bolhas, 0) > 0;
  v_espera text;
  v_ligado boolean;
  v_horas  integer;
  v_etapa  public.etapa_tipo;
  v_vence  timestamptz;
  v_expira timestamptz;
begin
  select * into v_r from public.rodadas rd where rd.id = p_rodada;
  if not found then
    return;
  end if;

  -- 1. rodada de lembrete
  if v_r.retorno_id is not null
     and exists (select 1 from public.retornos rt
                  where rt.id = v_r.retorno_id and rt.tipo = 'lembrete') then
    return;
  end if;

  -- 2 e 3.
  v_lead := exists (select 1 from public.mensagens m
                     where m.rodada_id = p_rodada and m.direcao = 'entrada');
  if v_lead or v_escreveu then
    delete from public.retornos rt
     where rt.conversa_id = v_r.conversa_id and rt.tipo = 'lembrete' and rt.status = 'pendente';
  end if;

  -- 4. (desligados: o lembrete armado não sairia)
  if not v_escreveu or not public.retornos_ligados() then
    return;
  end if;

  -- 5. o último responder aceito
  select e.val -> 'entrada' ->> 'espera_resposta' into v_espera
    from jsonb_array_elements(case when jsonb_typeof(p_ferramentas) = 'array'
                                   then p_ferramentas else '[]'::jsonb end)
         with ordinality as e(val, ord)
   where jsonb_typeof(e.val) = 'object'
     and e.val ->> 'ferramenta' = 'responder'
     and e.val -> 'resultado' ->> 'ok' = 'true'
   order by e.ord desc
   limit 1;
  if v_espera is distinct from 'sim' then
    return;
  end if;

  -- 6. o ajuste
  select cf.lembrete_ligado, cf.lembrete_horas into v_ligado, v_horas
    from public.configuracao cf where cf.id = 1;
  if not coalesce(v_ligado, false) or v_horas is null then
    return;
  end if;

  -- 7. a conversa (já travada pela concluir_rodada): com a Nina, não armada e sem entrada solta
  -- desde o começo da rodada (a resposta ao pedido de permissão, que não arma a conversa)
  select * into v_c from public.conversas c where c.id = v_r.conversa_id;
  if not found or v_c.modo is distinct from 'nina' or v_c.responder_apos is not null
     or exists (select 1 from public.mensagens m
                 where m.conversa_id = v_c.id and m.direcao = 'entrada'
                   and m.rodada_id is null and m.criado_em >= v_r.iniciada_em) then
    return;
  end if;

  -- 8. a etapa
  select e.tipo into v_etapa
    from public.contatos ct join public.etapas e on e.id = ct.etapa_id
   where ct.id = v_c.contato_id;
  if v_etapa is distinct from 'aberta' then
    return;
  end if;

  -- 9. retorno aberto
  if exists (select 1 from public.retornos o
              where o.conversa_id = v_c.id and o.tipo = 'retorno'
                and o.status in ('pendente', 'em_rodada')) then
    return;
  end if;

  -- 10. um por silêncio
  if exists (select 1 from public.retornos o
              where o.conversa_id = v_c.id and o.tipo = 'lembrete'
                and o.status in ('saindo', 'enviado', 'cancelado')
                and o.marcado_em > coalesce(v_c.ultima_do_lead_em, '-infinity'::timestamptz)) then
    return;
  end if;

  -- 11. hora e prazo
  v_vence := public.lembrete_vence_em(now(), v_horas, v_c.id);
  v_expira := public.lembrete_expira_em(v_vence);
  if exists (select 1 from public.conexoes cx where cx.ativa and cx.oficial) then
    if v_c.ultima_do_lead_em is null then
      return;
    end if;
    v_expira := least(v_expira, v_c.ultima_do_lead_em + interval '23 hours 50 minutes');
    if v_expira <= v_vence then
      return;
    end if;
  end if;

  -- 12. (com as horas do ajuste de agora: o pendente as guarda, e o ajuste mudado depois não o move)
  insert into public.retornos (conversa_id, tipo, status, vence_em, expira_em, marcado_em,
                               rodada_origem_id, lembrete_horas)
  values (v_c.id, 'lembrete', 'pendente', v_vence, v_expira, now(), p_rodada, v_horas);
end;
$$;
revoke execute on function public.lembrete_ao_concluir(uuid, public.mensagem_status, integer, jsonb) from public, anon, authenticated, service_role;

-- O retorno ou o lembrete da rodada no fim dela (a concluir_rodada a chama só para rodada com
-- retorno_id: na pura, sem proteção, de propósito; na mista, protegida). p_mista: a rodada leva
-- também a fala do lead. Sem o retorno em_rodada desta rodada, sai; só a rodada revivida pelo eco
-- duplicado, com IA e bolha na fila, retoma o retorno que a varredura F já tinha devolvido a
-- pendente, ou que a varredura A fechou com a equipe depois disso, na hora, solto da rodada
-- (saindo, como o gatilho das bolhas faz). A rodada sem IA (p_passos = 0: a bolha fixa do áudio)
-- nunca deixa o retorno preso a ela.
-- O primeiro caso que vale:
-- 1. cancelada, ou sem bolha com a conversa fora da Nina: com a equipe (o retorno levado antes da
--    hora, ou com a conversa na janela do eco duplicado, volta a pendente: quem decide é a
--    varredura A, que espera a janela, ou a faixa 1);
-- 2. janela_fechada no insert (só na rodada pura): 24 h;
-- 3. sem_conexao_ativa no insert (só na pura): o retorno volta em 30 s; o lembrete, desconectado;
-- 4. descarte (o lead escreveu durante a rodada pura): o retorno volta; o lembrete, dispensado;
-- 5. sem IA (p_passos = 0): o retorno volta em 30 s; o lembrete, a Nina não conseguiu;
-- 6. mista sem bolha: o retorno volta (a Nina respondeu ao lead e não tratou dele);
-- 7. com bolha: saindo (as bolhas decidem depois);
-- 8. resto (a IA leu e não escreveu): dispensado, com o porquê do último sem_resposta aceito.
create or replace function public.retorno_ao_concluir(
  p_rodada uuid, p_status public.mensagem_status, p_bolhas integer, p_descartou boolean,
  p_erro text, p_ferramentas jsonb, p_passos integer, p_mista boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rt     public.retornos;
  v_modo   public.conversa_modo;
  v_eco    boolean;
  v_bolhas integer := coalesce(p_bolhas, 0);
  v_nota   text;
begin
  select rt.* into v_rt
    from public.rodadas rd
    join public.retornos rt on rt.id = rd.retorno_id
   where rd.id = p_rodada and rt.status = 'em_rodada' and rt.rodada_id = p_rodada
     for update of rt;
  if not found then
    -- a rodada revivida pelo eco duplicado (base 0006, concluir_envio) depois de a varredura F ter
    -- devolvido o retorno dela a pendente: com bolha na fila, ela o retoma (saindo), como o gatilho
    -- das bolhas faz na volta delas, em vez de ele sair de novo, em dobro, pela faixa 1. A conversa
    -- já está travada pela concluir_rodada. Só a rodada com IA retoma: a bolha fixa do áudio
    -- (p_passos = 0, caso 5) nunca é o retorno, e o não enviado que esta rodada ainda segura (a
    -- varredura F o fechou com a equipe) é solto dela, para a bolha fixa não o reabrir ao sair.
    if coalesce(p_passos, 0) = 0 then
      update public.retornos rt set rodada_id = null
        from public.rodadas rd
       where rd.id = p_rodada and rt.id = rd.retorno_id and rt.rodada_id = p_rodada
         and rt.status = 'nao_enviado';
    elsif p_status = 'na_fila' and v_bolhas > 0 then
      -- o pendente, ou o que a varredura A fechou com a equipe enquanto o eco segurava a conversa
      -- (o eco era da própria Nina: a equipe não assumiu)
      perform 1 from public.rodadas rd
        join public.retornos rt on rt.id = rd.retorno_id
       where rd.id = p_rodada and rt.tipo = 'retorno' and rt.rodada_id is null
         and (rt.status = 'pendente'
              or (rt.status = 'nao_enviado' and rt.nao_enviado_motivo = 'com_equipe'))
         for update of rt;
      if found then
        update public.retornos rt
           set status = 'saindo', rodada_id = p_rodada, tentar_apos = null,
               nao_enviado_motivo = null, resolvido_em = null
          from public.rodadas rd
         where rd.id = p_rodada and rt.id = rd.retorno_id;
      end if;
    end if;
    return;                                  -- a varredura ou um cancelamento já o fechou
  end if;

  -- a conversa e a janela do eco duplicado (a mesma do passo A da retornos_varrer: saiu da Nina só
  -- pelo celular, sem responsável, com uma mensagem do celular de menos de 60 s)
  select c.modo,
         c.motivo_humano is not distinct from 'humano_celular' and c.responsavel_id is null
           and exists (select 1 from public.mensagens h
                        where h.conversa_id = c.id and h.origem = 'humano_celular'
                          and h.criado_em > now() - interval '60 seconds')
    into v_modo, v_eco
    from public.conversas c where c.id = v_rt.conversa_id;

  -- 1. (o com_equipe mantém o rodada_id, para a bolha que o eco duplicado devolve o reabrir; a
  -- bolha fixa do áudio, p_passos = 0, nunca é o retorno: aí ele sai da rodada). Na janela do eco,
  -- o retorno vencido também volta: o passo A, que espera a janela, fecha com a equipe se o eco
  -- não for desfeito, e a faixa 1 o manda se for (a bolha fixa nunca o retoma)
  if p_status = 'cancelada' or (v_bolhas = 0 and v_modo is distinct from 'nina') then
    if v_rt.tipo = 'retorno' and (now() < v_rt.vence_em or coalesce(v_eco, false)) then
      perform public.retorno_volta(v_rt.id, now(), p_rodada);
      update public.retornos rt set rodada_id = null
       where rt.id = v_rt.id and rt.status = 'nao_enviado' and coalesce(p_passos, 0) = 0;
    else
      update public.retornos rt
         set status = 'nao_enviado', nao_enviado_motivo = 'com_equipe', resolvido_em = now(),
             rodada_id = case when coalesce(p_passos, 0) = 0 then null else rt.rodada_id end
       where rt.id = v_rt.id;
    end if;
    return;
  end if;

  -- 2.
  if p_erro = 'janela_fechada' then
    update public.retornos rt
       set status = 'nao_enviado', nao_enviado_motivo = 'fora_24h', resolvido_em = now()
     where rt.id = v_rt.id;
    return;
  end if;

  -- 3.
  if p_erro = 'sem_conexao_ativa' then
    if v_rt.tipo = 'retorno' then
      perform public.retorno_volta(v_rt.id, now() + interval '30 seconds', p_rodada);
    else
      update public.retornos rt
         set status = 'nao_enviado', nao_enviado_motivo = 'desconectado', resolvido_em = now()
       where rt.id = v_rt.id;
    end if;
    return;
  end if;

  -- 4.
  if coalesce(p_descartou, false) then
    if v_rt.tipo = 'retorno' then
      perform public.retorno_volta(v_rt.id, now(), p_rodada);
    else
      update public.retornos rt set status = 'dispensado', resolvido_em = now() where rt.id = v_rt.id;
    end if;
    return;
  end if;

  -- 5.
  if coalesce(p_passos, 0) = 0 then
    if v_rt.tipo = 'retorno' then
      perform public.retorno_volta(v_rt.id, now() + interval '30 seconds', p_rodada);
      -- perto do prazo a retorno_volta fecha como não enviado e mantém o rodada_id: aqui ele sai,
      -- porque a bolha fixa desta rodada nunca é o retorno (o gatilho das bolhas não o reabre)
      update public.retornos rt set rodada_id = null
       where rt.id = v_rt.id and rt.status = 'nao_enviado';
    else
      update public.retornos rt
         set status = 'nao_enviado', nao_enviado_motivo = 'nina_falhou', resolvido_em = now()
       where rt.id = v_rt.id;
    end if;
    return;
  end if;

  -- 6.
  if coalesce(p_mista, false) and v_bolhas = 0 and v_rt.tipo = 'retorno' then
    perform public.retorno_volta(v_rt.id, now(), p_rodada);
    return;
  end if;

  -- 7.
  if v_bolhas > 0 then
    update public.retornos rt set status = 'saindo' where rt.id = v_rt.id;
    return;
  end if;

  -- 8.
  if v_rt.tipo = 'retorno' then
    select nullif(left(btrim(coalesce(e.val -> 'entrada' ->> 'motivo', '')), 300), '') into v_nota
      from jsonb_array_elements(case when jsonb_typeof(p_ferramentas) = 'array'
                                     then p_ferramentas else '[]'::jsonb end)
           with ordinality as e(val, ord)
     where jsonb_typeof(e.val) = 'object'
       and e.val ->> 'ferramenta' = 'sem_resposta'
       and e.val -> 'resultado' ->> 'ok' = 'true'
     order by e.ord desc
     limit 1;
  end if;
  update public.retornos rt
     set status = 'dispensado', nota_fim = v_nota, resolvido_em = now()
   where rt.id = v_rt.id;
end;
$$;
revoke execute on function public.retorno_ao_concluir(uuid, public.mensagem_status, integer, boolean, text, jsonb, integer, boolean) from public, anon, authenticated, service_role;

-- O retorno ou o lembrete da rodada que falhou (a falhar_rodada a chama protegida, só para rodada
-- com retorno_id; a limpeza de presas da pegar_rodadas de hoje também passa por ela).
-- Lembrete: uma tentativa só, nunca à equipe. Retorno: a regra de hoje (passageira até a 3ª
-- tentativa volta em 30 s; senão a Nina não conseguiu); com a conversa fora da Nina, com a equipe.
-- O retorno levado antes da hora (na mista) volta a pendente nos dois casos.
create or replace function public.retorno_ao_falhar(
  p_rodada uuid, p_passageiro boolean, p_tentativa smallint, p_modo public.conversa_modo)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rt public.retornos;
begin
  select rt.* into v_rt
    from public.rodadas rd
    join public.retornos rt on rt.id = rd.retorno_id
   where rd.id = p_rodada and rt.status = 'em_rodada' and rt.rodada_id = p_rodada
     for update of rt;
  if not found then
    return;
  end if;

  if v_rt.tipo = 'lembrete' then
    update public.retornos rt
       set status = 'nao_enviado',
           nao_enviado_motivo = case when p_modo is distinct from 'nina'
                                     then 'com_equipe' else 'nina_falhou' end,
           resolvido_em = now()
     where rt.id = v_rt.id;
    return;
  end if;

  if p_modo is distinct from 'nina' then
    if now() < v_rt.vence_em then
      perform public.retorno_volta(v_rt.id, now(), p_rodada);
    else
      update public.retornos rt
         set status = 'nao_enviado', nao_enviado_motivo = 'com_equipe', resolvido_em = now()
       where rt.id = v_rt.id;
    end if;
    return;
  end if;

  if coalesce(p_passageiro, false) and coalesce(p_tentativa, 1) < 3 then
    perform public.retorno_volta(v_rt.id, now() + interval '30 seconds', p_rodada);
    return;
  end if;

  -- o retorno levado na mista antes da hora não acaba antes dela: volta, e na hora quem decide é a
  -- varredura A (a falha definitiva levou a conversa à equipe) ou a faixa 1 (já devolvida)
  if now() < v_rt.vence_em then
    perform public.retorno_volta(v_rt.id, now(), p_rodada);
    return;
  end if;

  update public.retornos rt
     set status = 'nao_enviado', nao_enviado_motivo = 'nina_falhou', resolvido_em = now()
   where rt.id = v_rt.id;
end;
$$;
revoke execute on function public.retorno_ao_falhar(uuid, boolean, smallint, public.conversa_modo) from public, anon, authenticated, service_role;

-- =====================================================================
-- 2. Servidor (service_role)
-- =====================================================================

-- O retorno da rodada, para o servidor montar o bloco e as ferramentas. Não grava e não trava.
-- Rodada com retorno_id: o retorno ou o lembrete que ela leva (da_rodada: true), se ainda está
-- em_rodada nela, ou o retorno que o fim dela ou o gatilho das bolhas ainda retomam (o eco
-- duplicado, com a varredura F ou A antes da leitura: pendente e solto, ou não enviado com a
-- equipe, solto ou ainda nela; com a rodada de fato assumida pela equipe, as bolhas nascem
-- canceladas e só se perde a chamada de IA); senão nulo. Rodada sem retorno_id: o retorno pendente da conversa ainda dentro do
-- prazo (expira_em no futuro; da_rodada: false), ou nulo. Nos dois, vencido: a hora marcada já
-- passou (vence_em <= now()), para a Nina saber. Nunca devolve lembrete pendente. Aceita a rodada
-- rodando ou cancelada (o mesmo par da concluir_rodada): a cancelada pelo Assumir ou pelo eco do
-- celular pode reviver (base 0006, concluir_envio), e quem decide o retorno é o fim dela.
create or replace function public.nina_retorno_da_rodada(p_rodada uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_r  public.rodadas;
  v_rt public.retornos;
begin
  select * into v_r from public.rodadas rd where rd.id = p_rodada;
  if not found or v_r.status not in ('rodando', 'cancelada') then
    raise exception using message = 'rodada_nao_rodando', errcode = 'P0001';
  end if;

  if v_r.retorno_id is not null then
    -- em_rodada nesta rodada; ou, só o retorno, num estado que o fim desta rodada ou o gatilho das
    -- bolhas dela ainda retomam (a rodada revivida pelo eco duplicado depois da varredura F ou A):
    -- pendente e solto, ou não enviado com a equipe, solto ou ainda nela
    select * into v_rt from public.retornos rt
     where rt.id = v_r.retorno_id
       and ((rt.status = 'em_rodada' and rt.rodada_id = p_rodada)
            or (rt.tipo = 'retorno'
                and ((rt.status = 'pendente' and rt.rodada_id is null)
                     or (rt.status = 'nao_enviado' and rt.nao_enviado_motivo = 'com_equipe'
                         and (rt.rodada_id is null or rt.rodada_id = p_rodada)))));
    if not found then
      return null;
    end if;
    return jsonb_build_object('da_rodada', true, 'retorno_id', v_rt.id, 'tipo', v_rt.tipo,
                              'vence_em', v_rt.vence_em, 'motivo', v_rt.motivo,
                              'marcado_em', v_rt.marcado_em, 'vencido', v_rt.vence_em <= now());
  end if;

  -- o pendente com o prazo vencido não aparece (a varredura C o fecha)
  select * into v_rt from public.retornos rt
   where rt.conversa_id = v_r.conversa_id and rt.tipo = 'retorno' and rt.status = 'pendente'
     and rt.expira_em > now()
   order by rt.vence_em
   limit 1;
  if not found then
    return null;
  end if;
  return jsonb_build_object('da_rodada', false, 'retorno_id', v_rt.id, 'tipo', v_rt.tipo,
                            'vence_em', v_rt.vence_em, 'motivo', v_rt.motivo,
                            'marcado_em', v_rt.marcado_em, 'vencido', v_rt.vence_em <= now());
end;
$$;
revoke execute on function public.nina_retorno_da_rodada(uuid) from public, anon, authenticated;
grant execute on function public.nina_retorno_da_rodada(uuid) to service_role;

-- A ferramenta marcar_retorno da Nina. Trava a conversa e depois a rodada (a ordem do Assumir, base
-- 0006: sem impasse com ele nem com a mensagem da equipe). Só em rodada com fala do lead (D9). A
-- data e a hora são de Brasília. A mesma hora do retorno pendente dentro do prazo, ou do levado
-- por esta rodada com a hora já vencida, não grava nada (igual), mesmo que essa hora já tenha
-- passado (o levado vencido sai pelas bolhas desta rodada). A mesma hora do levado antes da hora
-- grava um pendente novo nessa hora: o lead adiou o assunto, e o levado sai pelas bolhas desta
-- rodada (a promessa de "te chamo às 9" é cumprida às 9). Senão, recusa sem gravar: no passado, mais de 30 dias à frente e, na oficial,
-- depois das 24 h da última mensagem do lead (com 10 min de folga). Senão substitui o pendente (a
-- linha nova leva substitui_id) e apaga o lembrete pendente. Com os retornos desligados (o relógio
-- antes da versão 1 ou sem o gatilho das bolhas: ver o cabeçalho), recusa com retornos_desligados
-- depois das checagens da rodada, sem gravar: o servidor trata como "não deu para marcar agora".
create or replace function public.nina_marcar_retorno(
  p_rodada uuid, p_data date, p_hora time, p_motivo text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r        public.rodadas;
  v_c        public.conversas;
  v_motivo   text;
  v_quando   timestamptz;
  v_limite   timestamptz;
  v_igual    uuid;
  v_ant      uuid;
  v_ant_em   timestamptz;
  v_novo     uuid;
  v_conv     uuid;
begin
  -- a conversa antes da rodada (a ordem do Assumir); o conversa_id de uma rodada nunca muda
  select rd.conversa_id into v_conv from public.rodadas rd where rd.id = p_rodada;
  select * into v_c from public.conversas c where c.id = v_conv for update;
  v_r := public.rodada_rodando(p_rodada);

  if not public.rodada_tem_fala_do_lead(p_rodada) then
    raise exception using message = 'rodada_sem_lead', errcode = 'P0001';
  end if;

  -- os retornos desligados: sem o relógio da versão 1 (nina_retornos_relogio) ou sem o gatilho das
  -- bolhas (nina_retornos_rodada), o retorno marcado não sairia
  if not public.retornos_ligados() then
    raise exception using message = 'retornos_desligados', errcode = 'P0001';
  end if;

  if p_data is null or p_hora is null then
    raise exception using message = 'data_invalida', errcode = 'P0001';
  end if;
  v_motivo := btrim(coalesce(p_motivo, ''));
  if char_length(v_motivo) not between 1 and 300 then
    raise exception using message = 'motivo_invalido', errcode = 'P0001';
  end if;

  v_quando := public.retorno_instante(p_data, p_hora);

  -- a mesma hora: nada muda (antes das recusas de prazo: o levado vencido há pouco também é igual;
  -- o pendente com o prazo vencido, que a varredura C fecha, não). O levado antes da hora não é
  -- igual: a mesma hora grava um pendente novo (o lead adiou; o levado sai pelas bolhas)
  select rt.id into v_igual
    from public.retornos rt
   where rt.conversa_id = v_c.id and rt.tipo = 'retorno' and rt.vence_em = v_quando
     and ((rt.status = 'pendente' and rt.expira_em > now())
          or (rt.status = 'em_rodada' and rt.rodada_id = p_rodada and rt.vence_em <= now()))
   order by (rt.status = 'pendente') desc
   limit 1;
  if v_igual is not null then
    return jsonb_build_object('ok', true, 'retorno_id', v_igual, 'vence_em', v_quando,
                              'substituido_vence_em', null::timestamptz, 'igual', true);
  end if;

  if v_quando <= now() then
    return jsonb_build_object('ok', false, 'erro', 'no_passado', 'limite', null::timestamptz);
  end if;
  if v_quando > now() + interval '30 days' then
    return jsonb_build_object('ok', false, 'erro', 'longe_demais',
                              'limite', now() + interval '30 days');
  end if;
  if exists (select 1 from public.conexoes cx where cx.ativa and cx.oficial) then
    v_limite := v_c.ultima_do_lead_em + interval '23 hours 50 minutes';
    if v_limite is null or v_quando > v_limite then
      return jsonb_build_object('ok', false, 'erro', 'fora_das_24h', 'limite', v_limite);
    end if;
  end if;

  -- substitui só o pendente (o levado por esta rodada sai pelas bolhas dela)
  update public.retornos rt
     set status = 'cancelado', fechado_por_rodada = p_rodada, resolvido_em = now()
   where rt.conversa_id = v_c.id and rt.tipo = 'retorno' and rt.status = 'pendente'
  returning rt.id, rt.vence_em into v_ant, v_ant_em;

  -- marcar cancela o lembrete pendente
  delete from public.retornos rt
   where rt.conversa_id = v_c.id and rt.tipo = 'lembrete' and rt.status = 'pendente';

  insert into public.retornos (conversa_id, tipo, status, vence_em, expira_em, motivo, marcado_em,
                               rodada_origem_id, substitui_id)
  values (v_c.id, 'retorno', 'pendente', v_quando, v_quando + interval '3 hours', v_motivo, now(),
          p_rodada, v_ant)
  returning id into v_novo;

  return jsonb_build_object('ok', true, 'retorno_id', v_novo, 'vence_em', v_quando,
                            'substituido_vence_em', v_ant_em, 'igual', false);
end;
$$;
revoke execute on function public.nina_marcar_retorno(uuid, date, time, text) from public, anon, authenticated;
grant execute on function public.nina_marcar_retorno(uuid, date, time, text) to service_role;

-- A ferramenta cancelar_retorno da Nina. Trava a conversa e depois a rodada (a ordem do Assumir).
-- Só em rodada com fala do lead (D9). Cancela o retorno pendente da conversa e também o que esta
-- rodada leva (a mista), com o porquê dela em nota_fim. Na mista, cancela só o levado; o pendente
-- que esta rodada acabou de marcar fica (o lead remarcou: a Nina marca o novo e cancela o antigo,
-- em qualquer ordem). Fora da mista, cancela o pendente, mesmo o que esta rodada marcou.
create or replace function public.nina_cancelar_retorno(p_rodada uuid, p_motivo text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r     public.rodadas;
  v_id    uuid;
  v_vence timestamptz;
  v_conv  uuid;
begin
  -- a conversa antes da rodada (a ordem do Assumir); o conversa_id de uma rodada nunca muda
  select rd.conversa_id into v_conv from public.rodadas rd where rd.id = p_rodada;
  perform 1 from public.conversas c where c.id = v_conv for update;
  v_r := public.rodada_rodando(p_rodada);

  if not public.rodada_tem_fala_do_lead(p_rodada) then
    raise exception using message = 'rodada_sem_lead', errcode = 'P0001';
  end if;

  with fecha as (
    update public.retornos rt
       set status = 'cancelado',
           fechado_por_rodada = p_rodada,
           resolvido_em = now(),
           nota_fim = nullif(left(btrim(coalesce(p_motivo, '')), 300), '')
     where rt.conversa_id = v_r.conversa_id and rt.tipo = 'retorno'
       and ((rt.status = 'em_rodada' and rt.rodada_id = p_rodada)
            or (rt.status = 'pendente'
                -- na mista, o pendente que esta rodada marcou fica (o exists lê o estado de antes
                -- deste update: ainda vê o levado em_rodada)
                and not (rt.rodada_origem_id is not distinct from p_rodada
                         and exists (select 1 from public.retornos lv
                                      where lv.conversa_id = v_r.conversa_id and lv.tipo = 'retorno'
                                        and lv.status = 'em_rodada' and lv.rodada_id = p_rodada))))
    returning rt.id, rt.vence_em, rt.rodada_id
  )
  select f.id, f.vence_em into v_id, v_vence
    from fecha f
   order by (f.rodada_id is null) desc, f.vence_em
   limit 1;

  if v_id is null then
    return jsonb_build_object('ok', false, 'erro', 'sem_retorno');
  end if;
  return jsonb_build_object('ok', true, 'retorno_id', v_id, 'vence_em', v_vence);
end;
$$;
revoke execute on function public.nina_cancelar_retorno(uuid, text) from public, anon, authenticated;
grant execute on function public.nina_cancelar_retorno(uuid, text) to service_role;

-- =====================================================================
-- 3. A equipe (authenticated) e o servidor
-- =====================================================================

-- O Cancelar da equipe, para o retorno e para o lembrete, por qualquer membro ativo. Trava o
-- membro, depois a conversa (espera a função que pega as rodadas ou a varredura, que nunca esperam
-- ninguém), depois o retorno. Só o pendente: o que já entrou numa rodada recusa
-- (retorno_nao_pendente).
create or replace function public.cancelar_retorno(p_retorno uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membro uuid := public.membro_atual();
  v_conv   uuid;
begin
  perform 1 from public.membros m where m.id = v_membro and m.ativo for share;
  if not found then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;

  select rt.conversa_id into v_conv from public.retornos rt where rt.id = p_retorno;
  if not found then
    raise exception using message = 'retorno_nao_pendente', errcode = 'P0001';
  end if;

  perform 1 from public.conversas c where c.id = v_conv for update;

  update public.retornos rt
     set status = 'cancelado', cancelado_por = v_membro, resolvido_em = now()
   where rt.id = p_retorno and rt.status = 'pendente';
  if not found then
    raise exception using message = 'retorno_nao_pendente', errcode = 'P0001';
  end if;
end;
$$;
revoke execute on function public.cancelar_retorno(uuid) from public, anon;
grant execute on function public.cancelar_retorno(uuid) to authenticated, service_role;

-- "A Nina está atrasada" com os retornos (D8): a motor_pendencias de hoje (com a checagem de acesso
-- dela) mais o retorno combinado pronto. O lembrete nunca conta. O retorno futuro não entra em
-- proximo_em (só a nova tentativa dos 30 s). Em vencido_desde só entra o retorno pronto há menos de
-- 10 min (o retorno velho na fila não esconde do bastão o lead que escreveu agora); em
-- atrasado_desde ele continua contando. Com os retornos desligados (retornos_ligados), nenhum
-- retorno sai, e ela devolve só a motor_pendencias de hoje; com um defeito na parte nova também
-- (protegida, com o aviso pendencias_retornos_falhou).
create or replace function public.motor_pendencias_com_retornos()
returns table (proximo_em timestamptz, vencido_desde timestamptz, atrasado_desde timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_proximo  timestamptz;
  v_vencido  timestamptz;
  v_atrasado timestamptz;
  v_rt_prox  timestamptz;
  v_rt_rec   timestamptz;
  v_rt_venc  timestamptz;
begin
  -- a mesma trava da motor_pendencias, aqui também: a regra de acesso fica na função que tem o
  -- grant a authenticated
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and not coalesce(public.eh_membro(), false) then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;

  select mp.proximo_em, mp.vencido_desde, mp.atrasado_desde
    into v_proximo, v_vencido, v_atrasado
    from public.motor_pendencias() mp;

  -- a parte nova, protegida (B1): um defeito nela nunca derruba as pendências de hoje (o bastão, a
  -- renovação do toque e o "atrasada" da tela); no erro, só as de hoje. Desligados, a irmã não pega
  -- retorno nenhum: o retorno parado não acende o atraso
  begin
    if public.retornos_ligados() then
      select min(p.pronto_em) filter (where p.pronto_em > now()),
             min(p.pronto_em) filter (where p.pronto_em <= now()
                                        and p.pronto_em > now() - interval '10 minutes'),
             min(p.pronto_em) filter (where p.pronto_em <= now())
        into v_rt_prox, v_rt_rec, v_rt_venc
        from public.retornos_prontos() p
       where p.tipo = 'retorno';
    end if;
  exception when others then
    raise warning 'pendencias_retornos_falhou: %', sqlerrm;
    v_rt_prox := null;
    v_rt_rec := null;
    v_rt_venc := null;
  end;

  return query
    select least(v_proximo, v_rt_prox), least(v_vencido, v_rt_rec), least(v_atrasado, v_rt_venc);
end;
$$;
revoke execute on function public.motor_pendencias_com_retornos() from public, anon;
grant execute on function public.motor_pendencias_com_retornos() to authenticated, service_role;

-- =====================================================================
-- 4. A função que pega as rodadas com os retornos (servidor novo)
-- =====================================================================

-- Uma transação, em quatro passos:
-- 1. Faixa 0: a pegar_rodadas de hoje, sem mudança (limpeza de presas, onboarding, travas, as
--    entradas soltas). O erro dela sobe como hoje.
-- 2. Varredura curta, antes do levar junto: o órfão da conversa que a faixa 0 acabou de pegar
--    (a rodada que o levava foi cancelada pela equipe e a conversa, devolvida) volta a pendente
--    nesta mesma transação, e o passo 3 já o leva junto da resposta ao lead.
-- 3. Levar junto (caso 8): o retorno vencido (ou a até 10 min da hora, se foi marcado mais de 30
--    min antes) da conversa em que o lead falou vai na rodada dela, numa resposta só. Não olha o
--    tentar_apos: a rodada da faixa 0 já tem o espaçamento dela. O lembrete nunca vai junto.
-- 4. Faixas 1 (retornos) e 2 (lembretes), só com a vaga que a faixa 0 deixou e até p_limite_puras.
--    Nenhuma entrada solta é ligada: a rodada pura não leu fala do lead.
-- Os passos 2 a 4 são protegidos: um defeito neles nunca impede a resposta ao lead. E só rodam com
-- os retornos ligados (o relógio da versão 1 e o gatilho das bolhas: ver o cabeçalho); desligados,
-- a função devolve só a faixa 0, igual à pegar_rodadas de hoje.
-- A tentativa da rodada pura (como a da faixa 0, na pegar_rodadas de hoje) conta toda rodada
-- 'falhou' da conversa desde a última concluída ou a devolução, de qualquer tipo. Premissa: 3
-- falhas seguidas da IA na mesma conversa, de resposta ao lead, de retorno ou de lembrete, levam
-- a conversa à equipe (na falha da rodada de lembrete ela nunca vai, mas a falha conta).
create or replace function public.pegar_rodadas_com_retornos(p_limite integer, p_limite_puras integer)
returns setof public.rodadas
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids    uuid[];
  v_novas  uuid[] := '{}'::uuid[];
  v_resto  integer;
  v_ctx    bigint;
  v_prov   public.ia_provedor;
  v_modelo text;
begin
  -- 1. faixa 0
  select coalesce(array_agg(r.id), '{}'::uuid[]) into v_ids from public.pegar_rodadas(p_limite) r;

  -- os retornos desligados: sem o relógio da versão 1 (nina_retornos_relogio) ou sem o gatilho das
  -- bolhas (nina_retornos_rodada), só a faixa 0
  if not public.retornos_ligados() then
    return query
      select r.* from public.rodadas r where r.id = any (v_ids) order by r.criado_em, r.id;
    return;
  end if;

  -- 2. varredura curta (antes do levar junto)
  begin
    perform public.retornos_varrer(50);
  exception when others then
    raise warning 'retornos_varrer_falhou: %', sqlerrm;
  end;

  -- 3. levar junto
  if cardinality(v_ids) > 0 then
    begin
      with par as (
        select rd.id as rodada_id, rt.id as retorno_id
          from public.rodadas rd
          join public.retornos rt on rt.conversa_id = rd.conversa_id
         where rd.id = any (v_ids)
           and rt.tipo = 'retorno' and rt.status = 'pendente'
           and (rt.vence_em <= now()
                or (rt.vence_em <= now() + interval '10 minutes'
                    and rt.marcado_em <= rt.vence_em - interval '30 minutes'))
           and rt.expira_em > now()
           and public.rodada_tem_fala_do_lead(rd.id)
           and public.whatsapp_conectado_desde() is not null
           and not exists (select 1 from public.retornos o
                            where o.conversa_id = rd.conversa_id and o.status = 'em_rodada')
           for update of rt skip locked
      ), marca as (
        update public.retornos rt
           set status = 'em_rodada', rodada_id = p.rodada_id,
               tentativas = least(rt.tentativas + 1, 50), tentar_apos = null
          from par p
         where rt.id = p.retorno_id
        returning rt.id, p.rodada_id
      )
      update public.rodadas rd
         set retorno_id = m.id
        from marca m
       where rd.id = m.rodada_id;
    exception when others then
      raise warning 'retornos_levar_junto_falhou: %', sqlerrm;
    end;
  end if;

  -- 4. faixas 1 e 2
  begin
    v_resto := least(greatest(coalesce(p_limite, 0), 0) - cardinality(v_ids),
                     greatest(coalesce(p_limite_puras, 0), 0));
    if v_resto > 0 then
      select max(cv.id) into v_ctx from public.contexto_versoes cv;
      select k.provedor, k.modelo into v_prov, v_modelo
        from public.ia_chaves k where k.finalidade = 'resposta';

      with alvo as (
        select rt.id as retorno_id, c.id as conversa_id
          from public.retornos rt
          join public.conversas c on c.id = rt.conversa_id
         where rt.id in (select p.retorno_id from public.retornos_prontos() p
                          where p.pronto_em <= now())
           and rt.status = 'pendente' and c.modo = 'nina' and c.responder_apos is null
         order by case rt.tipo when 'retorno' then 1 else 2 end, rt.vence_em, c.id
         limit v_resto
           for update of c, rt skip locked
      ), nova as (
        insert into public.rodadas (conversa_id, status, contexto_versao_id, provedor, modelo,
                                    passos, tentativa, passou_humano, iniciada_em, retorno_id)
        select a.conversa_id, 'rodando', v_ctx, v_prov, v_modelo, 0,
               1 + (select count(*) from public.rodadas f
                    where f.conversa_id = a.conversa_id and f.status = 'falhou'
                      and f.criado_em > greatest(
                            coalesce((select max(k.criado_em) from public.rodadas k
                                      where k.conversa_id = a.conversa_id and k.status = 'concluida'),
                                     '-infinity'::timestamptz),
                            coalesce((select cv.devolvida_em from public.conversas cv
                                      where cv.id = a.conversa_id),
                                     '-infinity'::timestamptz))),
               false, now(), a.retorno_id
          from alvo a
        on conflict (conversa_id) where status = 'rodando' do nothing
        returning id, retorno_id
      ), marca as (
        update public.retornos rt
           set status = 'em_rodada', rodada_id = n.id,
               tentativas = least(rt.tentativas + 1, 50), tentar_apos = null
          from nova n
         where rt.id = n.retorno_id
        returning rt.id
      )
      select coalesce(array_agg(n.id), '{}'::uuid[]) into v_novas from nova n;
    end if;
  exception when others then
    raise warning 'retornos_faixas_falhou: %', sqlerrm;
    v_novas := '{}'::uuid[];
  end;

  return query
    select r.* from public.rodadas r where r.id = any (v_ids || v_novas) order by r.criado_em, r.id;
end;
$$;
revoke execute on function public.pegar_rodadas_com_retornos(integer, integer) from public, anon, authenticated;
grant execute on function public.pegar_rodadas_com_retornos(integer, integer) to service_role;

-- =====================================================================
-- 5. O relógio dos retornos (só o dono: quem o chama é o job nina-retornos, que a preparar_copia()
--    do nina_retornos_relogio instala)
-- =====================================================================

-- 1. Varre (protegido).
-- 2. Acorda o worker pela acordar_motor que já existe (protegido) quando há retorno ou lembrete
--    pronto e: o último worker que rodou conhece retornos e o item ficou pronto há menos de 10 min;
--    ou o último worker conhece retornos e uma rodada qualquer (de retorno, de lembrete ou de
--    resposta ao lead) terminou há menos de 3 min, concluída ou com falha (a pilha andando, caso
--    21: sem isso, depois de 10 min da hora o worker não se renova, porque o retorno velho sai do
--    vencido_desde pelo A4; e, depois de uma rajada de leads que ocupou as vagas, a pilha volta a
--    andar no minuto seguinte, sem depender do servidor);
--    ou o worker não é visto há mais de 10 min. O item pronto há mais tempo, que a função que pega
--    as rodadas não conseguiu pegar, não vira um toque a cada minuto: com o worker vivo, no pior
--    caso um a cada 10 min. Com o worker fora (não visto há mais de 10 min), um por minuto, como a
--    regra de hoje (a acordar_motor só segura o toque de menos de 40 s). A regra dos 10 min não
--    olha o sinal de propósito (o sinal preso: uma passada de instância velha no Publicar o deixa
--    falso, e só um toque traz o worker novo de volta). O preço: com o servidor antigo no ar (a volta
--    atrás leve) e algum retorno ou lembrete pronto, um toque à toa a cada ~10 min (o worker antigo
--    roda e grava o worker_visto_em), até cada um fechar (o retorno, 3 h depois da hora). Com os
--    retornos desligados (retornos_ligados), o item pronto não acorda ninguém: a irmã não o pegaria.
-- 3. Acorda também, por fora da regra do item pronto, quando há item preso que só uma passada do
--    worker resolve: a rodada de retorno ou de lembrete rodando há mais de 5 min (o corte da
--    limpeza de presas da pegar_rodadas) ou a bolha da Nina de um retorno ou lembrete saindo
--    parada na fila há mais de 1 min (ou enviando há mais de 2 min, o corte da pegar_envios), com
--    o WhatsApp conectado e dentro do prazo (expira_em). Sem essas duas travas, a bolha que não
--    pode sair viraria um toque por minuto sem fim; depois do prazo, a varredura G e o
--    acontecimento seguinte cuidam do resto. Com o worker vivo, a trava de 40 s da acordar_motor
--    segura a repetição. A rodada comum presa (sem retorno_id) não conta: fica como hoje.
create or replace function public.relogio_retornos()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_algum   boolean;
  v_recente boolean;
  v_preso   boolean;
  v_visto   timestamptz;
  v_andando boolean;
begin
  begin
    perform public.retornos_varrer(500);
  exception when others then
    raise warning 'retornos_varrer_falhou: %', sqlerrm;
  end;

  begin
    select count(*) > 0, coalesce(bool_or(p.pronto_em > now() - interval '10 minutes'), false)
      into v_algum, v_recente
      from public.retornos_prontos() p
     where p.pronto_em <= now();
    -- desligados, a irmã não pega o item pronto: o toque seria à toa (o preso, abaixo, continua)
    v_algum := v_algum and public.retornos_ligados();
    v_preso := exists (
                 select 1 from public.rodadas r
                  where r.status = 'rodando' and r.retorno_id is not null
                    and r.iniciada_em < now() - interval '5 minutes')
            or (public.whatsapp_conectado_desde() is not null
                and exists (
                  select 1 from public.retornos rt
                    join public.mensagens m on m.rodada_id = rt.rodada_id
                   where rt.status = 'saindo' and rt.expira_em > now()
                     and m.direcao = 'saida' and m.origem = 'nina'
                     and ((m.status = 'na_fila'
                           and coalesce(m.enviar_apos, m.criado_em) < now() - interval '1 minute')
                          or (m.status = 'enviando'
                              and coalesce(m.status_em, m.criado_em) < now() - interval '2 minutes'))));
    select cf.worker_visto_em into v_visto from public.configuracao cf where cf.id = 1;
    -- a pilha está andando: uma rodada qualquer (de retorno, de lembrete ou de resposta ao lead)
    -- terminou há menos de 3 min, concluída ou com falha (usa o índice rodadas_terminada)
    v_andando := v_algum and not v_recente and exists (
                   select 1 from public.rodadas r
                    where r.status in ('concluida', 'falhou')
                      and r.terminada_em > now() - interval '3 minutes');
    if v_preso
       or (v_algum and (((v_recente or v_andando) and public.retornos_no_ar())
                        or coalesce(v_visto, '-infinity'::timestamptz) < now() - interval '10 minutes')) then
      perform public.acordar_motor(false);
    end if;
  exception when others then
    raise warning 'relogio_retornos_toque_falhou: %', sqlerrm;
  end;
end;
$$;
revoke execute on function public.relogio_retornos() from public, anon, authenticated, service_role;
