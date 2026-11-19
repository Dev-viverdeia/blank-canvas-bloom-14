-- Versão final da função public.concluir_envio (última definição em 0006_nina_ligacao_conversa.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.concluir_envio(p_msg uuid, p_id_externo text, p_id_gateway text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m   public.mensagens;
  v_id  text := nullif(btrim(coalesce(p_id_externo, '')), '');
  v_gw  text := nullif(btrim(coalesce(p_id_gateway, '')), '');
  v_dup public.mensagens;
  v_rod public.rodadas;
  v_volta int := 0;
begin
  select * into v_m from public.mensagens m where m.id = p_msg for update;
  if not found then
    raise exception using message = 'mensagem_nao_encontrada', errcode = 'P0001';
  end if;

  loop
    v_volta := v_volta + 1;

    if v_id is not null and v_id is distinct from v_m.id_externo then
      select * into v_dup
      from public.mensagens d
      where d.conexao_id = v_m.conexao_id and d.id_externo = v_id and d.id <> p_msg
      for update;

      if found then
        if v_dup.conversa_id = v_m.conversa_id
           and v_dup.origem = 'humano_celular'
           and v_dup.criado_em > now() - interval '60 seconds' then
          delete from public.mensagens d where d.id = v_dup.id;
          -- novo: o evento "celular" da duplicata não aconteceu
          delete from public.conversa_eventos e
           where e.conversa_id = v_m.conversa_id
             and e.tipo = 'celular'
             and e.criado_em = v_dup.criado_em;

          if v_m.origem = 'nina'
             and not exists (select 1 from public.mensagens h
                             where h.conversa_id = v_m.conversa_id
                               and h.origem in ('humano_tela', 'humano_celular')
                               and h.criado_em >= v_m.criado_em) then
            update public.conversas c
               set modo = 'nina',
                   motivo_humano = null
             where c.id = v_m.conversa_id
               and c.modo = 'humano'
               and c.motivo_humano = 'humano_celular'
               and c.responsavel_id is null;
            if found then
              -- So o que o insert da duplicata desfez: o gatilho dela grava
              -- status_em / terminada_em = now() da transacao em que ela entrou,
              -- que e o criado_em dela. Cancelado por outro motivo fica.
              update public.mensagens n
                 set status = 'na_fila', status_em = now()
               where n.conversa_id = v_m.conversa_id
                 and n.origem = 'nina' and n.status = 'cancelada'
                 and n.status_em = v_dup.criado_em;

              select * into v_rod
              from public.rodadas r
              where r.conversa_id = v_m.conversa_id
                and r.status = 'cancelada'
                and r.terminada_em = v_dup.criado_em
              order by r.iniciada_em desc
              limit 1
              for update;

              if found then
                if exists (select 1 from public.mensagens s
                           where s.rodada_id = v_rod.id and s.direcao = 'saida')
                   or coalesce(v_rod.ferramentas, '[]'::jsonb) <> '[]'::jsonb
                   or coalesce(v_rod.passos, 0) > 0 then
                  -- o worker ja concluiu a rodada cancelada (gravou respostas,
                  -- ferramentas ou passos): as respostas dela, gravadas como
                  -- canceladas so por causa da duplicata, voltam. Conclusao sem
                  -- nada disso nao se distingue: volta a rodar e, se ninguem a
                  -- concluir, expira em 5 min como falha passageira.
                  update public.mensagens s
                     set status = 'na_fila', status_em = now()
                   where s.rodada_id = v_rod.id and s.direcao = 'saida'
                     and s.origem = 'nina' and s.status = 'cancelada';
                  update public.rodadas r set status = 'concluida' where r.id = v_rod.id;
                elsif not exists (select 1 from public.rodadas o
                                  where o.conversa_id = v_m.conversa_id and o.status = 'rodando') then
                  -- o worker ainda esta com ela: volta a rodar
                  update public.rodadas r
                     set status = 'rodando', terminada_em = null
                   where r.id = v_rod.id;
                else
                  v_rod := null;
                end if;

                if v_rod.id is not null then
                  -- religa as entradas que ela lia (o pegar_rodadas liga todas as
                  -- soltas de antes do inicio dela)
                  update public.mensagens e
                     set rodada_id = v_rod.id
                   where e.conversa_id = v_m.conversa_id and e.direcao = 'entrada'
                     and e.rodada_id is null and e.criado_em <= v_rod.iniciada_em;
                end if;
              end if;

              -- Re-arma se sobrou entrada sem leitura depois da ultima rodada que
              -- concluiu ou esta rodando (o gatilho da duplicata limpou o armado).
              update public.conversas c
                 set responder_apos = coalesce(c.responder_apos, now())
               where c.id = v_m.conversa_id
                 and exists (select 1 from public.mensagens e
                             where e.conversa_id = c.id and e.direcao = 'entrada'
                               and e.rodada_id is null
                               and e.criado_em > coalesce(
                                     (select max(r.iniciada_em) from public.rodadas r
                                      where r.conversa_id = c.id
                                        and r.status in ('concluida', 'rodando')),
                                     '-infinity'::timestamptz));
            end if;
          end if;
        else
          v_id := null;
        end if;
      end if;
    end if;

    begin
      update public.mensagens m
         set status = case when m.status in ('na_fila', 'enviando')
                             or (m.status = 'falhou' and m.erro = 'sem_resposta_do_envio')
                           then 'enviada'::public.mensagem_status else m.status end,
             status_em = case when m.status in ('na_fila', 'enviando')
                                or (m.status = 'falhou' and m.erro = 'sem_resposta_do_envio')
                              then now() else m.status_em end,
             erro = case when m.status in ('na_fila', 'enviando')
                           or (m.status = 'falhou' and m.erro = 'sem_resposta_do_envio')
                         then null else m.erro end,
             id_externo = coalesce(v_id, m.id_externo),
             id_gateway = coalesce(v_gw, m.id_gateway),
             momento = case when m.status in ('na_fila', 'enviando')
                              or (m.status = 'falhou' and m.erro = 'sem_resposta_do_envio')
                            then now() else m.momento end
       where m.id = p_msg;
      return;
    exception when unique_violation then
      -- um eco entrou com esse id entre a conferencia e o update: confere de novo
      if v_volta >= 2 then
        v_id := null;
      end if;
    end;
  end loop;
end;
$$;
