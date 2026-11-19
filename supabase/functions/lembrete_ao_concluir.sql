-- Versão final da função public.lembrete_ao_concluir (última definição em 0044_nina_retornos_funcoes.sql).
-- Referência: quem aplica é a pasta migrations.

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
