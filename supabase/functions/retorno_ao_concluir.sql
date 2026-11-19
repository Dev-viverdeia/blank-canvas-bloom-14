-- Versão final da função public.retorno_ao_concluir (última definição em 0044_nina_retornos_funcoes.sql).
-- Referência: quem aplica é a pasta migrations.

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
