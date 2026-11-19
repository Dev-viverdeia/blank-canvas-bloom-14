-- Versão final da função public.retornos_varrer (última definição em 0043_nina_retornos_regras.sql).
-- Referência: quem aplica é a pasta migrations.

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
