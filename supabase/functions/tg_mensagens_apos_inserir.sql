-- Versão final da função public.tg_mensagens_apos_inserir (última definição em 0006_nina_ligacao_conversa.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.tg_mensagens_apos_inserir()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conv public.conversas%rowtype;
  v_espera integer;
  v_teto integer;
  v_primeira timestamptz;
  v_de text;
  v_canceladas integer;
begin
  select * into v_conv from public.conversas c where c.id = new.conversa_id for update;
  if not found then
    return null;
  end if;

  -- Prévia: só a mensagem mais recente (pelo momento) e não cancelada.
  if new.status <> 'cancelada'
     and (v_conv.ultima_mensagem_em is null or new.momento >= v_conv.ultima_mensagem_em) then
    v_conv.ultima_mensagem_em := new.momento;
    v_conv.ultima_mensagem_id := new.id; -- novo
    v_conv.ultima_mensagem_preview := left(
      coalesce(nullif(btrim(new.texto), ''), '[' || new.tipo::text || ']'), 140);
  end if;

  if new.direcao = 'entrada' then
    v_conv.nao_lidas := v_conv.nao_lidas + 1;
    v_conv.ultima_do_lead_em := greatest(v_conv.ultima_do_lead_em, new.momento);
    if v_conv.modo = 'nina' then
      select cf.espera_lote_s, cf.espera_lote_max_s into v_espera, v_teto
      from public.configuracao cf where cf.id = 1;
      -- 1ª pendente do lote. Sem nada armado, o lote começa nesta mensagem. Senão,
      -- conta só as entradas soltas que chegaram depois da última rodada: as que
      -- ficaram soltas no modo humano ou numa rodada que falhou ou foi cancelada
      -- não podem puxar o teto para o passado. Um armado vencido há mais que o teto
      -- (a conversa esperou armada sem conexão ativa ou com a janela oficial
      -- fechada) conta como nada armado: o lote recomeça nesta mensagem.
      if v_conv.responder_apos is not null
         and v_conv.responder_apos < now() - make_interval(secs => coalesce(v_teto, 60)) then
        v_conv.responder_apos := null;
      end if;
      if v_conv.responder_apos is null then
        v_primeira := now();
      else
        select min(m.criado_em) into v_primeira
        from public.mensagens m
        where m.conversa_id = new.conversa_id and m.direcao = 'entrada' and m.rodada_id is null
          and m.criado_em > coalesce((select max(r.iniciada_em) from public.rodadas r
                                      where r.conversa_id = new.conversa_id), '-infinity'::timestamptz);
      end if;
      -- 8 s que recomeçam a cada mensagem, com teto de 60 s desde a 1ª pendente.
      -- Um re-armado que já está mais adiante (falha passageira: +30 s) é mantido.
      v_conv.responder_apos := greatest(
        coalesce(v_conv.responder_apos, '-infinity'::timestamptz),
        least(
          now() + make_interval(secs => coalesce(v_espera, 8)),
          coalesce(v_primeira, now()) + make_interval(secs => coalesce(v_teto, 60))
        )
      );
    elsif v_conv.responsavel_id is null and v_conv.aguardando_humano_desde is null then
      -- novo (decisão 4): conversa humana sem ninguém (atendida pelo celular): o lead
      -- que escreve entra em "Precisam de você".
      v_conv.aguardando_humano_desde := now();
    end if;
  elsif new.origem in ('humano_tela', 'humano_celular') then
    -- novo: de onde a conversa vem, antes de mudar.
    v_de := case when v_conv.modo = 'nina' then 'nina'
                 when v_conv.responsavel_id is not null then 'outro'
                 when v_conv.aguardando_humano_desde is null then 'celular'
                 else 'espera' end;
    if new.origem = 'humano_tela' and v_de <> 'outro' then
      -- Mandar pela tela tira a conversa da Nina, da espera ou do celular (com outra
      -- pessoa, o responsável continua quem estava: não é assumir).
      insert into public.conversa_eventos (conversa_id, tipo, membro_id, de, por_envio)
      values (new.conversa_id, 'assumiu', new.autor_membro_id, v_de, true);
    elsif new.origem = 'humano_celular' and v_de in ('nina', 'espera') then
      -- O celular tirou a conversa da Nina ou da espera (já no celular ou com uma
      -- pessoa, não muda de mãos: sem evento).
      insert into public.conversa_eventos (conversa_id, tipo, de)
      values (new.conversa_id, 'celular', v_de);
    end if;

    if new.origem = 'humano_tela' and v_conv.responsavel_id is null
       and new.autor_membro_id is not null then
      -- novo: a conversa vai para quem mandou. Espera o desativar_membro que
      -- estiver rodando (for update no membro) e confere de novo que a pessoa
      -- continua ativa; senão ela ficaria com uma conversa depois de desativada.
      perform 1 from public.membros mb
       where mb.id = new.autor_membro_id and mb.ativo
         for share;
      if not found then
        raise exception using message = 'sem_acesso', errcode = 'P0001';
      end if;
    end if;
    if v_conv.modo = 'nina' then
      v_conv.motivo_humano := new.origem::text::public.motivo_humano;
    end if;
    v_conv.modo := 'humano';
    v_conv.responsavel_id := coalesce(v_conv.responsavel_id, new.autor_membro_id);
    v_conv.aguardando_humano_desde := null;
    v_conv.responder_apos := null;
    update public.mensagens m
    set status = 'cancelada', status_em = now()
    where m.conversa_id = new.conversa_id and m.origem = 'nina' and m.status = 'na_fila';
    get diagnostics v_canceladas = row_count;
    if v_canceladas > 0 then
      -- novo: o gatilho mensagens_apos_atualizar pode ter refeito a prévia sem as
      -- canceladas (só quando a cancelada era a última); vale a da tabela. Quando
      -- a última era outra, a tabela ainda tem a prévia de antes desta mensagem:
      -- a regra da mensagem nova vale de novo por cima.
      select c.ultima_mensagem_em, c.ultima_mensagem_id, c.ultima_mensagem_preview
        into v_conv.ultima_mensagem_em, v_conv.ultima_mensagem_id, v_conv.ultima_mensagem_preview
        from public.conversas c where c.id = new.conversa_id;
      if new.status <> 'cancelada'
         and (v_conv.ultima_mensagem_em is null or new.momento >= v_conv.ultima_mensagem_em) then
        v_conv.ultima_mensagem_em := new.momento;
        v_conv.ultima_mensagem_id := new.id;
        v_conv.ultima_mensagem_preview := left(
          coalesce(nullif(btrim(new.texto), ''), '[' || new.tipo::text || ']'), 140);
      end if;
    end if;
    -- A rodada que ainda está rodando foi atropelada pelo humano: fica 'cancelada'
    -- (o concluir_rodada grava as respostas dela como canceladas) e solta as entradas.
    with canceladas as (
      update public.rodadas r
         set status = 'cancelada', terminada_em = now()
       where r.conversa_id = new.conversa_id and r.status = 'rodando'
      returning r.id
    )
    update public.mensagens m
       set rodada_id = null
      from canceladas k
     where m.rodada_id = k.id and m.direcao = 'entrada';
  end if;

  update public.conversas c
  set ultima_mensagem_em = v_conv.ultima_mensagem_em,
      ultima_mensagem_id = v_conv.ultima_mensagem_id,
      ultima_mensagem_preview = v_conv.ultima_mensagem_preview,
      nao_lidas = v_conv.nao_lidas,
      ultima_do_lead_em = v_conv.ultima_do_lead_em,
      responder_apos = v_conv.responder_apos,
      modo = v_conv.modo,
      motivo_humano = v_conv.motivo_humano,
      responsavel_id = v_conv.responsavel_id,
      aguardando_humano_desde = v_conv.aguardando_humano_desde
  where c.id = new.conversa_id;
  return null;
end;
$$;
