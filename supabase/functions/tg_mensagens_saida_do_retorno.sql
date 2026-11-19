-- Versão final da função public.tg_mensagens_saida_do_retorno (última definição em 0045_nina_retornos_rodada.sql).
-- Referência: quem aplica é a pasta migrations.

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
