-- Versão final da função public.retorno_pelas_bolhas (última definição em 0043_nina_retornos_regras.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.retorno_pelas_bolhas(p_retorno uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rt       public.retornos;
  v_saiu     integer;
  v_fila     integer;
  v_falhou   integer;
  v_total    integer;
  v_primeira timestamptz;
  v_modo     public.conversa_modo;
  v_status   public.retorno_status;
  v_motivo   text;
  v_enviado  timestamptz;
  v_resolv   timestamptz;
begin
  select * into v_rt from public.retornos rt where rt.id = p_retorno;
  if not found or v_rt.rodada_id is null
     or v_rt.status not in ('saindo', 'enviado', 'nao_enviado') then
    return;
  end if;

  select count(*) filter (where m.status in ('enviada', 'entregue', 'lida')),
         count(*) filter (where m.status in ('na_fila', 'enviando')),
         count(*) filter (where m.status = 'falhou'),
         count(*),
         min(m.momento) filter (where m.status in ('enviada', 'entregue', 'lida'))
    into v_saiu, v_fila, v_falhou, v_total, v_primeira
    from public.mensagens m
   where m.rodada_id = v_rt.rodada_id and m.direcao = 'saida' and m.origem = 'nina';

  -- Sem bolha: o desfecho veio de outra fonte e não se recalcula.
  if v_total = 0 then
    return;
  end if;

  if v_saiu > 0 then
    v_status := 'enviado';
    v_motivo := null;
    v_enviado := v_primeira;
    -- a hora de quando já estava enviado fica; reaberto de não enviado, resolvido agora
    v_resolv := case when v_rt.status = 'enviado' then coalesce(v_rt.resolvido_em, now()) else now() end;
  elsif v_fila > 0 then
    v_status := 'saindo';
    v_motivo := null;
    v_enviado := null;
    v_resolv := null;
  elsif v_falhou > 0 then
    -- D7: o WhatsApp recusou o envio
    v_status := 'nao_enviado';
    v_motivo := 'envio_recusado';
    v_enviado := null;
    v_resolv := coalesce(v_rt.resolvido_em, now());
  else
    -- todas canceladas
    v_status := 'nao_enviado';
    v_enviado := null;
    v_resolv := coalesce(v_rt.resolvido_em, now());
    if v_rt.status = 'nao_enviado' then
      v_motivo := v_rt.nao_enviado_motivo;       -- decidido na hora certa: fica
    else
      select c.modo into v_modo from public.conversas c where c.id = v_rt.conversa_id;
      -- A mensagem da equipe (pela tela ou pelo celular) cancela as bolhas antes de gravar o modo
      -- humano na conversa (base 0006, tg_mensagens_apos_inserir): a mensagem humana gravada desde
      -- o começo da rodada também conta como "com a equipe".
      v_motivo := case
        when v_modo is distinct from 'nina'
          or exists (select 1
                       from public.mensagens h
                       join public.rodadas rd on rd.id = v_rt.rodada_id
                      where h.conversa_id = v_rt.conversa_id
                        and h.origem in ('humano_tela', 'humano_celular')
                        and h.criado_em >= rd.iniciada_em)
        then 'com_equipe' else 'desconectado' end;
    end if;
    -- A1 e caso 12: o retorno levado junto antes da hora (qualquer motivo), ou cancelado pelo
    -- Desconectar ou pelo Trocar de WhatsApp depois da hora, volta; a retorno_volta decide pelo
    -- prazo (pendente até expira_em, pronto quando o WhatsApp voltar; depois, desconectado ou
    -- passou_do_prazo). Na hora, o levado antes dela é decidido pela varredura (A ou C) ou pela
    -- faixa 1. A volta a pendente segura antes a conversa (a ordem do "um pendente por conversa":
    -- quem grava um pendente segura a conversa), com nowait: a varredura (F e G), o Assumir e a
    -- mensagem da equipe já a seguram; no gatilho das bolhas, a conversa ocupada (a nina_marcar_retorno
    -- em andamento) dá lock_not_available, que ele trata como adiado, e a varredura G faz a volta no
    -- minuto seguinte.
    if v_rt.tipo = 'retorno' and v_rt.status = 'saindo'
       and (now() < v_rt.vence_em or v_motivo = 'desconectado') then
      perform 1 from public.conversas c where c.id = v_rt.conversa_id for update nowait;
      update public.retornos rt set status = 'em_rodada' where rt.id = p_retorno;
      perform public.retorno_volta(p_retorno, now(), v_rt.rodada_id);
      return;
    end if;
  end if;

  if v_status is distinct from v_rt.status
     or v_motivo is distinct from v_rt.nao_enviado_motivo
     or v_enviado is distinct from v_rt.enviado_em then
    update public.retornos rt
       set status = v_status,
           nao_enviado_motivo = v_motivo,
           enviado_em = v_enviado,
           resolvido_em = v_resolv
     where rt.id = p_retorno;
  end if;
end;
$$;
