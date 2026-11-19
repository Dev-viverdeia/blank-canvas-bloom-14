-- nina_ligar_com_agente (17/11/2026): a ligação de saída escolhe o agente e leva um objetivo
-- .
-- - ligacao_agente_uso: o agente Receptivo ('receber', recebe as ligações do número) ou Ativo
--   ('ligar', faz ligações). Os agentes que já existem viram Receptivos (o padrão).
-- - ligacao_agentes.uso e o check: só um agente Receptivo pode atender o número.
-- - ligacoes.objetivo: o objetivo da ligação que a equipe escreveu ao ligar (até 500 caracteres).
-- Depende de: nina_ligacoes_tabelas (0023). Ordem: sozinho. Sem dado semeado, sem tempo real: a
-- preparar_copia() não muda. Pode rodar duas vezes. Sem BEGIN/COMMIT.

-- ---------------------------------------------------------------------
-- Trava: sem as tabelas das ligações, este envio para aqui.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.ligacao_agentes') is null or to_regclass('public.ligacoes') is null then
    raise exception using message = 'falta_a_tabela_de_ligacoes',
      hint = 'Aplique antes o nina_ligacoes_tabelas (base 0023).';
  end if;
end;
$$;

do $$
begin
  create type public.ligacao_agente_uso as enum ('receber', 'ligar');
exception when duplicate_object then
  null;
end;
$$;

alter table public.ligacao_agentes
  add column if not exists uso public.ligacao_agente_uso not null default 'receber';
alter table public.ligacao_agentes drop constraint if exists ligacao_agentes_atende_recebe;
alter table public.ligacao_agentes
  add constraint ligacao_agentes_atende_recebe check (not atende or uso = 'receber');

alter table public.ligacoes add column if not exists objetivo text;
alter table public.ligacoes drop constraint if exists ligacoes_objetivo;
alter table public.ligacoes
  add constraint ligacoes_objetivo check (objetivo is null or char_length(objetivo) between 1 and 500);