-- Versão final da função public.pegar_rodadas_com_retornos (última definição em 0044_nina_retornos_funcoes.sql).
-- Referência: quem aplica é a pasta migrations.

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
