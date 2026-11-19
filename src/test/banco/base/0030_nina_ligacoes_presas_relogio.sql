-- nina_ligacoes_presas_relogio (17/11/2026): o relógio de hora em hora também acorda o worker
-- quando há ligação presa em "em andamento".
-- O worker confere na ElevenLabs as ligações que passaram de 2 min sem o pós-chamada e fecha o
-- que ela confirma (src/features/mensageria/ligacoes/presas.server.ts). Mas ele só roda quando
-- algo o acorda (uma mensagem, uma tela); num horário calmo, a ligação presa ficava esperando.
-- Recria a manutencao_nina (base 0021) com a mesma assinatura: apaga os eventos do webhook com
-- mais de 30 dias, como antes, e, se houver ligação em andamento há mais de 2 min (iniciada nos
-- últimos 2 dias), pede uma passada com acordar_motor(false). O toque nunca derruba a manutenção.
-- Depende de: nina_motor_acordado (base 0020, acordar_motor), nina_copia_sozinha (base 0021,
-- manutencao_nina) e nina_ligacoes_tabelas (base 0023, public.ligacoes). Ordem: sozinho.
-- O job nina-relogio não muda (a preparar_copia() o instala na cópia e chama esta função).
-- Pode rodar duas vezes. Sem BEGIN/COMMIT.

-- ---------------------------------------------------------------------
-- Trava: sem as dependências, este envio para aqui.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.acordar_motor(boolean)') is null
     or to_regprocedure('public.manutencao_nina()') is null
     or to_regclass('public.ligacoes') is null then
    raise exception using message = 'falta_motor_manutencao_ou_ligacoes',
      hint = 'Aplique antes o nina_motor_acordado (0020), o nina_copia_sozinha (0021) e o nina_ligacoes_tabelas (0023).';
  end if;
end;
$$;

create or replace function public.manutencao_nina()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.eventos_webhook e
   where e.recebido_em < now() - interval '30 days';

  -- ligação presa: o worker confere na ElevenLabs e fecha o que ela confirmar
  if exists (select 1 from public.ligacoes l
              where l.status = 'em_andamento'
                and l.iniciada_em < now() - interval '2 minutes'
                and l.iniciada_em > now() - interval '2 days') then
    begin
      perform public.acordar_motor(false);
    exception when others then
      raise warning 'manutencao_toque_falhou: %', sqlerrm;
    end;
  end if;
end;
$$;
revoke execute on function public.manutencao_nina() from public, anon, authenticated, service_role;