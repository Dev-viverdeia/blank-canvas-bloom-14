-- Versão final da função public.concluir_rodada (última definição em 0045_nina_retornos_rodada.sql).
-- Referência: quem aplica é a pasta migrations.

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
