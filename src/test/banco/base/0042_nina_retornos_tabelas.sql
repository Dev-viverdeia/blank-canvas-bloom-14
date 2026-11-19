-- nina_retornos_tabelas (envio 1 de 6 dos retornos, 18/11/2026).
-- Os retornos da Nina: a Nina marca o retorno que combinou com o lead e, quando espera a resposta
-- dele, arma um lembrete automático. Este envio cria a estrutura:
-- - retorno_tipo e retorno_status: os dois tipos novos (tipo NOVO, não valor novo num enum que já
--   existe, então podem ser usados neste mesmo envio).
-- - retornos: o retorno combinado (tipo 'retorno') e o lembrete automático (tipo 'lembrete'). No
--   máximo um retorno pendente e um lembrete pendente por conversa. Gravada só pelas funções do
--   banco (security definer); o membro só lê. O service_role tem o grant de escrita das outras
--   tabelas, mas o servidor nunca grava em retornos fora das RPCs.
-- - rodadas.retorno_id: a marca da rodada que leva um retorno ou um lembrete (nula = rodada comum,
--   como hoje). Sem FK de propósito.
-- - configuracao.lembrete_ligado e lembrete_horas: o ajuste do lembrete no cartão de ritmo (nasce
--   ligado, com 3 h; horas de 1 a 23). configuracao.worker_retornos_em: o sinal do worker que
--   conhece retornos.
-- - motor.relogio_versao: a versão do relógio que a preparar_copia() instalou (0 = reinstalar).
-- Depende de: base 0037. Ordem: 1º envio dos retornos, antes de todos os outros (o
-- nina_retornos_regras, o nina_retornos_funcoes, o nina_retornos_rodada, o nina_retornos_dashboard
-- e o nina_retornos_relogio dependem dele). Quando vai ao agente do Lovable: antes do código novo,
-- junto com o nina_retornos_regras e o nina_retornos_funcoes, nessa ordem; os três são inertes com
-- o servidor de hoje no ar, e o código novo precisa do types.ts gerado com eles. Só acrescenta:
-- nenhuma função muda, nada é semeado, sem tempo real; sem retorno gravado, nada se comporta
-- diferente de hoje. Pode rodar duas vezes. Sem BEGIN/COMMIT.

-- ---------------------------------------------------------------------
-- Trava: sem a base até a 0037, este envio para aqui.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.motor') is null
     or to_regclass('public.ligacoes') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'ligacoes'
                       and column_name = 'objetivo') then
    raise exception using message = 'falta_a_base_0037',
      hint = 'Este banco precisa das migrations do motor (base 0020) e das ligações (base 0023 a 0037).';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Tipos novos
-- ---------------------------------------------------------------------
do $$
begin
  create type public.retorno_tipo as enum ('retorno', 'lembrete');
exception when duplicate_object then
  null;
end;
$$;

do $$
begin
  create type public.retorno_status as enum
    ('pendente', 'em_rodada', 'saindo', 'enviado', 'dispensado', 'cancelado', 'nao_enviado');
exception when duplicate_object then
  null;
end;
$$;

-- ---------------------------------------------------------------------
-- retornos: gravada só pelas funções do banco (security definer); a tela lê.
-- rodada_id, rodada_origem_id, fechado_por_rodada e substitui_id são uuid SEM FK de propósito:
-- apontam para linhas da MESMA conversa, que caem juntas pela cascata de conversas.
-- ---------------------------------------------------------------------
create table if not exists public.retornos (
  id uuid primary key default gen_random_uuid(),
  conversa_id uuid not null references public.conversas (id) on delete cascade,
  tipo public.retorno_tipo not null,
  status public.retorno_status not null default 'pendente',
  -- a hora marcada (retorno) ou calculada (lembrete)
  vence_em timestamptz not null,
  -- o fim da tolerância: retorno = vence_em + 3 h; lembrete = 3 h ou 20:00 do dia (o que vier antes)
  expira_em timestamptz not null,
  -- nova tentativa não antes de (só depois de uma falha passageira)
  tentar_apos timestamptz,
  -- o assunto do retorno, na frase da Nina (o lembrete não tem)
  motivo text,
  marcado_em timestamptz not null default now(),
  rodada_origem_id uuid,
  substitui_id uuid,
  rodada_id uuid,
  tentativas smallint not null default 0,
  enviado_em timestamptz,
  resolvido_em timestamptz,
  nao_enviado_motivo text,
  cancelado_por uuid references public.membros (id) on delete set null,
  fechado_por_rodada uuid,
  nota_fim text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint retornos_prazo check (expira_em > vence_em),
  constraint retornos_motivo check (
    (tipo = 'retorno' and char_length(btrim(coalesce(motivo, ''))) between 1 and 300)
    or (tipo = 'lembrete' and motivo is null)),
  constraint retornos_aberto check (
    (status in ('pendente', 'em_rodada', 'saindo')) = (resolvido_em is null)),
  constraint retornos_na_rodada check (status not in ('em_rodada', 'saindo') or rodada_id is not null),
  constraint retornos_nao_enviado check ((status = 'nao_enviado') = (nao_enviado_motivo is not null)),
  constraint retornos_nao_enviado_motivo check (nao_enviado_motivo is null or nao_enviado_motivo in
    ('com_equipe', 'fora_24h', 'desconectado', 'passou_do_prazo', 'envio_recusado', 'nina_falhou')),
  constraint retornos_cancelado check (cancelado_por is null or status = 'cancelado'),
  constraint retornos_enviado check (status <> 'enviado' or enviado_em is not null),
  constraint retornos_tentativas check (tentativas between 0 and 50),
  constraint retornos_nota_fim check (nota_fim is null or char_length(nota_fim) between 1 and 300)
);

revoke all on table public.retornos from anon, authenticated;
grant all on table public.retornos to service_role;
grant select on table public.retornos to authenticated;
alter table public.retornos enable row level security;
drop policy if exists retornos_membro_le on public.retornos;
create policy retornos_membro_le on public.retornos
  for select to authenticated using ((select public.eh_membro()));

create or replace trigger retornos_atualizado before update on public.retornos
  for each row execute function public.tg_tocar_atualizado_em();

-- No máximo um retorno pendente e um lembrete pendente por conversa. 'em_rodada' e 'saindo' ficam
-- de fora de propósito: a Nina pode marcar o próximo retorno enquanto o atual sai.
create unique index if not exists retornos_um_retorno on public.retornos (conversa_id)
  where tipo = 'retorno' and status = 'pendente';
create unique index if not exists retornos_um_lembrete on public.retornos (conversa_id)
  where tipo = 'lembrete' and status = 'pendente';
-- A fila (a função que pega as rodadas, o relógio, as pendências, a varredura): só os pendentes.
create index if not exists retornos_vencendo on public.retornos (vence_em) where status = 'pendente';
-- Os que estão numa rodada ou saindo (órfãos e o gatilho das bolhas).
create index if not exists retornos_andamento on public.retornos (rodada_id)
  where status in ('em_rodada', 'saindo');
-- O histórico da conversa na tela.
create index if not exists retornos_conversa on public.retornos (conversa_id, criado_em desc);

-- ---------------------------------------------------------------------
-- A marca da rodada que leva um retorno ou um lembrete (nula = rodada comum, como hoje). Sem FK de
-- propósito: a linha apontada só some junto com a conversa (cascata).
-- ---------------------------------------------------------------------
alter table public.rodadas add column if not exists retorno_id uuid;

-- ---------------------------------------------------------------------
-- O ajuste do lembrete (cartão de ritmo) e o sinal do worker que conhece retornos.
-- ---------------------------------------------------------------------
alter table public.configuracao
  add column if not exists lembrete_ligado boolean not null default true,
  add column if not exists lembrete_horas integer not null default 3,
  add column if not exists worker_retornos_em timestamptz;
alter table public.configuracao drop constraint if exists configuracao_lembrete_horas;
alter table public.configuracao
  add constraint configuracao_lembrete_horas check (lembrete_horas between 1 and 23);
comment on column public.configuracao.worker_retornos_em is
  'Gravado só pelo marcarWorkerVisto do servidor que conhece retornos, com o mesmo valor de worker_visto_em. worker_retornos_em >= worker_visto_em quer dizer: o último worker que rodou conhece retornos.';

-- ---------------------------------------------------------------------
-- A versão do relógio que a preparar_copia() instalou (0 = não sei: reinstala).
-- ---------------------------------------------------------------------
alter table public.motor add column if not exists relogio_versao smallint not null default 0;
