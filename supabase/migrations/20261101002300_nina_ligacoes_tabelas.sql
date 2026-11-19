-- nina_ligacoes_tabelas (envio 2 de 4 da tela de Ligações, 12/11/2026).
-- Os agentes de voz (ligacao_agentes), o histórico de ligações (ligacoes) e os limites das
-- ligações na configuracao. Depende do envio 1 (mensagem_tipo 'ligacao'). Antes do envio 3.
-- Só acrescenta: nenhuma tabela, coluna ou função existente é apagada ou renomeada, e toda
-- coluna nova obrigatória tem default. Sem BEGIN/COMMIT. Cada tabela sai com as permissões e o RLS
-- logo depois do create table (regra do agente do Lovable do produto; na vitrine, o mesmo conteúdo
-- foi aplicado com as permissões no fim).

-- ---------------------------------------------------------------------
-- Trava: sem o envio 1, este envio para aqui (só lê o catálogo).
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1
                   from pg_catalog.pg_enum e
                   join pg_catalog.pg_type t on t.oid = e.enumtypid
                   join pg_catalog.pg_namespace n on n.oid = t.typnamespace
                  where n.nspname = 'public' and t.typname = 'mensagem_tipo'
                    and e.enumlabel = 'ligacao') then
    raise exception using message = 'falta_o_envio_1_mensagem_tipo_ligacao',
      hint = 'Aplique antes o envio 1 (nina_ligacoes_enums): alter type public.mensagem_tipo add value if not exists ''ligacao''.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Tipos novos (cada um só é criado se ainda não existe)
-- ---------------------------------------------------------------------
do $$
begin
  create type public.ligacao_direcao as enum ('entrada', 'saida');
exception when duplicate_object then null;
end;
$$;
do $$
begin
  create type public.ligacao_status as enum ('em_andamento', 'concluida', 'nao_completada');
exception when duplicate_object then null;
end;
$$;
do $$
begin
  create type public.ligacao_objetivo as enum ('vendas', 'suporte', 'outro');
exception when duplicate_object then null;
end;
$$;
-- O perfil escolhe os modelos (a tabela perfil → modelos fica no código, com versão).
do $$
begin
  create type public.ligacao_perfil as enum ('recomendado', 'rapido', 'caprichado');
exception when duplicate_object then null;
end;
$$;

-- ---------------------------------------------------------------------
-- Limites das ligações (da conta toda, como o ritmo das mensagens)
-- ---------------------------------------------------------------------
alter table public.configuracao
  add column if not exists ligacoes_simultaneas integer not null default 2
    constraint configuracao_ligacoes_simultaneas check (ligacoes_simultaneas between 1 and 20),
  add column if not exists ligacoes_por_dia integer not null default 100
    constraint configuracao_ligacoes_por_dia check (ligacoes_por_dia between 1 and 10000),
  add column if not exists ligacoes_por_contato integer not null default 10
    constraint configuracao_ligacoes_por_contato check (ligacoes_por_contato between 1 and 100);

-- ---------------------------------------------------------------------
-- ligacao_agentes: os agentes de voz. Na ativação nasce o "Nina", que segue o Contexto; o admin
-- muda e cria outros. Um só atende as ligações (atende = true). id_externo é o id do agente na
-- ElevenLabs (nulo enquanto não existe lá: antes de ativar ou depois de desativar). versao_config
-- é a versão da configuração do código aplicada lá (a tela oferece atualizar quando o código
-- tem uma mais nova).
--   regras_equipe nulo = passa para a equipe pelas regras do Contexto (as mesmas da Nina de texto).
-- Gravada só pelo servidor; a tela lê.
-- ---------------------------------------------------------------------
create table if not exists public.ligacao_agentes (
  id uuid primary key default gen_random_uuid(),
  nome text not null constraint ligacao_agentes_nome check (char_length(btrim(nome)) between 1 and 60),
  objetivo public.ligacao_objetivo not null default 'vendas',
  instrucoes text not null default ''
    constraint ligacao_agentes_instrucoes check (char_length(instrucoes) <= 4000),
  regras_equipe text
    constraint ligacao_agentes_regras_equipe check (regras_equipe is null or char_length(btrim(regras_equipe)) between 1 and 2000),
  voz_id text constraint ligacao_agentes_voz_id check (voz_id is null or voz_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  voz_nome text constraint ligacao_agentes_voz_nome check (voz_nome is null or char_length(voz_nome) <= 120),
  perfil public.ligacao_perfil not null default 'recomendado',
  saudacao text not null default 'Oi, {nome}! Aqui é a Nina. Como posso te ajudar?'
    constraint ligacao_agentes_saudacao check (char_length(btrim(saudacao)) between 1 and 300),
  duracao_max_s integer not null default 600
    constraint ligacao_agentes_duracao check (duracao_max_s between 180 and 1800),
  silencio_s integer not null default 25
    constraint ligacao_agentes_silencio check (silencio_s between 10 and 60),
  atende boolean not null default false,
  id_externo text unique constraint ligacao_agentes_id_externo check (id_externo is null or id_externo <> ''),
  versao_config integer not null default 0 constraint ligacao_agentes_versao check (versao_config >= 0),
  sincronizado_em timestamptz,
  erro_sincronia text,
  criado_por uuid references public.membros (id) on delete set null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- Permissões e RLS de ligacao_agentes, logo depois de criar (tira o padrão do Supabase, como na 0000 e na
-- 0005): membro ativo lê; só o servidor grava.
revoke all on table public.ligacao_agentes from anon, authenticated;
grant all on table public.ligacao_agentes to service_role;
grant select on table public.ligacao_agentes to authenticated;
alter table public.ligacao_agentes enable row level security;
drop policy if exists ligacao_agentes_membro_le on public.ligacao_agentes;
create policy ligacao_agentes_membro_le on public.ligacao_agentes
  for select to authenticated using ((select public.eh_membro()));
-- Um agente atende as ligações por vez.
create unique index if not exists ligacao_agentes_um_atende on public.ligacao_agentes (atende) where atende;

-- ---------------------------------------------------------------------
-- ligacoes: o histórico. Cada ligação tem a sua mensagem na conversa (tipo 'ligacao',
-- mensagem_id), que põe a ligação na linha do tempo, na prévia da lista e no histórico da Nina
-- de texto; os dados dela (status, duração, resumo, transcrição) moram aqui. id_externo é o id da
-- conversa na ElevenLabs. transcricao: [{ "papel": "lead"|"nina", "texto": "...", "segundos": n }].
-- Gravada só pelas funções do envio 3 (service_role); a tela lê.
-- ---------------------------------------------------------------------
create table if not exists public.ligacoes (
  id uuid primary key default gen_random_uuid(),
  conversa_id uuid not null references public.conversas (id) on delete cascade,
  mensagem_id uuid unique references public.mensagens (id) on delete set null,
  conexao_id uuid references public.conexoes (id) on delete set null,
  agente_id uuid references public.ligacao_agentes (id) on delete set null,
  direcao public.ligacao_direcao not null,
  status public.ligacao_status not null default 'em_andamento',
  id_externo text not null unique constraint ligacoes_id_externo check (id_externo <> ''),
  iniciada_em timestamptz not null default now(),
  encerrada_em timestamptz,
  duracao_s integer constraint ligacoes_duracao check (duracao_s is null or duracao_s >= 0),
  motivo_fim text,
  resumo text,
  transcricao jsonb not null default '[]'::jsonb
    constraint ligacoes_transcricao check (jsonb_typeof(transcricao) = 'array'),
  passou_equipe boolean not null default false,
  custo_creditos integer constraint ligacoes_custo check (custo_creditos is null or custo_creditos >= 0),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- Permissões e RLS de ligacoes, logo depois de criar (tira o padrão do Supabase, como na 0000 e na
-- 0005): membro ativo lê; só o servidor grava.
revoke all on table public.ligacoes from anon, authenticated;
grant all on table public.ligacoes to service_role;
grant select on table public.ligacoes to authenticated;
alter table public.ligacoes enable row level security;
drop policy if exists ligacoes_membro_le on public.ligacoes;
create policy ligacoes_membro_le on public.ligacoes
  for select to authenticated using ((select public.eh_membro()));
create index if not exists ligacoes_iniciada on public.ligacoes (iniciada_em desc);
create index if not exists ligacoes_conversa on public.ligacoes (conversa_id, iniciada_em desc);
create index if not exists ligacoes_agente on public.ligacoes (agente_id) where agente_id is not null;
create index if not exists ligacoes_em_andamento on public.ligacoes (iniciada_em) where status = 'em_andamento';

-- ---------------------------------------------------------------------
-- atualizado_em (a mesma função das outras tabelas, da 0000)
-- ---------------------------------------------------------------------
create or replace trigger ligacao_agentes_atualizado before update on public.ligacao_agentes
  for each row execute function public.tg_tocar_atualizado_em();
create or replace trigger ligacoes_atualizado before update on public.ligacoes
  for each row execute function public.tg_tocar_atualizado_em();