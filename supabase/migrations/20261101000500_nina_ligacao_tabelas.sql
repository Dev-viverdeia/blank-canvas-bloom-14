-- =====================================================================
-- Ligar as telas ao banco, envio 2: tabelas, colunas, índices, policies,
-- grants por coluna e o gatilho de conexao_eventos.
-- Contrato: seção 2.3 (envio 2).
-- Depende do envio 1 (10-enums.sql: tipo conversa_evento_tipo).
-- Só acrescenta: nenhuma tabela, coluna ou função existente é apagada ou
-- renomeada, e toda coluna nova obrigatória tem default. Sem BEGIN/COMMIT.
-- =====================================================================

-- ---------------------------------------------------------------------
-- conversa_eventos: passagens da conversa (passou, assumiu, devolveu,
-- celular, voltou_para_fila). Gravada só pelas funções e gatilhos do banco
-- (envio 3); a tela só lê.
--   membro_id: quem assumiu, devolveu ou respondeu pelo celular;
--   de / de_membro_id: com quem a conversa estava antes;
--   motivo: o motivo da passagem para a equipe;
--   por_envio: o "assumiu" veio de uma mensagem mandada pela tela.
-- ---------------------------------------------------------------------
create table public.conversa_eventos (
  id uuid primary key default gen_random_uuid(),
  conversa_id uuid not null references public.conversas (id) on delete cascade,
  tipo public.conversa_evento_tipo not null,
  membro_id uuid references public.membros (id) on delete set null,
  de text constraint conversa_eventos_de check (de is null or de in ('nina', 'espera', 'outro', 'celular')),
  de_membro_id uuid references public.membros (id) on delete set null,
  motivo public.motivo_humano,
  por_envio boolean not null default false,
  criado_em timestamptz not null default now()
);
create index conversa_eventos_conversa on public.conversa_eventos (conversa_id, criado_em);

-- ---------------------------------------------------------------------
-- conexao_eventos: cada mudança de status ou de ativa em conexoes, gravada
-- pelo gatilho conexoes_eventos (abaixo). ator_membro_id = o membro do
-- auth.uid() (nulo quando quem mudou foi o servidor).
-- ---------------------------------------------------------------------
create table public.conexao_eventos (
  id uuid primary key default gen_random_uuid(),
  conexao_id uuid not null references public.conexoes (id) on delete cascade,
  status_de public.conexao_status,
  status_para public.conexao_status not null,
  ativa_de boolean,
  ativa_para boolean not null,
  ultimo_erro text,
  ator_membro_id uuid references public.membros (id) on delete set null,
  criado_em timestamptz not null default now()
);
create index conexao_eventos_conexao on public.conexao_eventos (conexao_id, criado_em);

-- ---------------------------------------------------------------------
-- convites: quem foi convidado e ainda não entrou. Só o servidor grava
-- (service_role); o admin lê. O convite vence pelo enviado_em, que o
-- Reenviar atualiza.
-- ---------------------------------------------------------------------
create table public.convites (
  id uuid primary key default gen_random_uuid(),
  email text not null unique constraint convites_email_minusculo check (email = lower(email) and email <> ''),
  papel public.papel_membro not null default 'atendente',
  convidado_por uuid references public.membros (id) on delete set null,
  user_id uuid unique,
  enviado_em timestamptz not null default now(),
  criado_em timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Colunas novas nas tabelas que já existem
-- ---------------------------------------------------------------------

-- mensagens: citação (a mensagem respondida) e duração da mídia (áudio).
alter table public.mensagens
  add column responde_a_id uuid references public.mensagens (id) on delete set null,
  add column midia_duracao_s integer constraint mensagens_midia_duracao_s check (midia_duracao_s is null or midia_duracao_s >= 0);
create index mensagens_responde_a on public.mensagens (responde_a_id) where responde_a_id is not null;

-- conversas: a última mensagem (para a prévia) e a última resposta da Nina que saiu.
alter table public.conversas
  add column ultima_mensagem_id uuid references public.mensagens (id) on delete set null,
  add column ultima_da_nina_em timestamptz;
create index conversas_ultima_mensagem on public.conversas (ultima_mensagem_id) where ultima_mensagem_id is not null;

-- contatos: quando a Nina resumiu e as anotações dela
-- ({fatos:[{rotulo,valor,mensagem_id?}], proximo_passo:{titulo,texto}|null}).
-- A tela só lê: não entram no grant de update.
alter table public.contatos
  add column resumo_nina_em timestamptz,
  add column anotacoes_nina jsonb constraint contatos_anotacoes_nina_objeto check (anotacoes_nina is null or jsonb_typeof(anotacoes_nina) = 'object');

-- rodadas: a rodada terminou passando a conversa para a equipe.
alter table public.rodadas
  add column foi_para_equipe boolean not null default false;

-- ia_chamadas: a conversa da chamada (a transcrição não tem rodada).
alter table public.ia_chamadas
  add column conversa_id uuid references public.conversas (id) on delete set null;
create index ia_chamadas_conversa on public.ia_chamadas (conversa_id) where conversa_id is not null;

-- configuracao: última passada do worker e limites do ritmo
-- (espera de 2 a 30 s, teto de 20 a 120 s, teto pelo menos 5 s acima da espera).
alter table public.configuracao
  add column worker_visto_em timestamptz,
  add constraint configuracao_ritmo check (
    espera_lote_s between 2 and 30
    and espera_lote_max_s between 20 and 120
    and espera_lote_max_s >= espera_lote_s + 5
  );

-- membros: o que a pessoa já viu ({"kanban": iso, "tour": iso}).
alter table public.membros
  add column vistos jsonb not null default '{}'::jsonb constraint membros_vistos_objeto check (jsonb_typeof(vistos) = 'object');

-- contexto_versoes: número da versão (1, 2, 3, sem buracos) e de qual versão
-- veio a restauração. As linhas que já existem são numeradas pela ordem do id.
alter table public.contexto_versoes
  add column numero integer,
  add column restaurada_de bigint references public.contexto_versoes (id);

update public.contexto_versoes cv
   set numero = n.numero
  from (
    select v.id, (row_number() over (order by v.id))::integer as numero
      from public.contexto_versoes v
  ) n
 where n.id = cv.id;

alter table public.contexto_versoes
  add constraint contexto_versoes_numero_unico unique (numero);

-- ---------------------------------------------------------------------
-- Gatilho: conexao_eventos
-- ---------------------------------------------------------------------
create function public.tg_conexoes_eventos()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membro uuid;
begin
  if new.status is not distinct from old.status and new.ativa is not distinct from old.ativa then
    return null;
  end if;
  if auth.uid() is not null then
    select m.id into v_membro from public.membros m where m.user_id = auth.uid();
  end if;
  insert into public.conexao_eventos (conexao_id, status_de, status_para, ativa_de, ativa_para, ultimo_erro, ator_membro_id)
  values (new.id, old.status, new.status, old.ativa, new.ativa, new.ultimo_erro, v_membro);
  return null;
end;
$$;

create trigger conexoes_eventos
  after update of status, ativa on public.conexoes
  for each row execute function public.tg_conexoes_eventos();

revoke execute on function public.tg_conexoes_eventos() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Permissões nas tabelas novas (tira o padrão do Supabase, como na 0000)
-- ---------------------------------------------------------------------
revoke all on table public.conversa_eventos, public.conexao_eventos, public.convites from anon, authenticated;
grant all on table public.conversa_eventos, public.conexao_eventos, public.convites to service_role;
-- conexao_eventos é escrita só pelo gatilho (como contato_etapa_historico).
revoke insert, update, delete, truncate on table public.conexao_eventos from service_role;

grant select on table public.conversa_eventos, public.conexao_eventos, public.convites to authenticated;

-- Escrita por coluna nas tabelas que já existem: a tela grava a citação e a
-- duração do áudio junto com a mensagem.
grant insert (responde_a_id, midia_duracao_s) on public.mensagens to authenticated;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.conversa_eventos enable row level security;
alter table public.conexao_eventos enable row level security;
alter table public.convites enable row level security;

-- Membro ativo lê.
create policy conversa_eventos_membro_le on public.conversa_eventos
  for select to authenticated using ((select public.eh_membro()));
create policy conexao_eventos_membro_le on public.conexao_eventos
  for select to authenticated using ((select public.eh_membro()));
-- A configuração (onboarding concluído, ritmo, worker) passa a ser lida por
-- todo membro; a policy do admin continua.
create policy configuracao_membro_le on public.configuracao
  for select to authenticated using ((select public.eh_membro()));

-- Admin lê os convites; só o servidor grava.
create policy convites_admin_le on public.convites
  for select to authenticated using ((select public.eh_admin()));

-- A tela só cita mensagem da mesma conversa (restritiva: soma-se à
-- mensagens_membro_insere da 0000, que continua igual). A conferência fica numa
-- função security definer: uma policy de mensagens que lê mensagens direto dá
-- "infinite recursion detected in policy".
create or replace function public.mensagem_da_conversa(p_msg uuid, p_conversa uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.mensagens m where m.id = p_msg and m.conversa_id = p_conversa
  );
$$;

revoke execute on function public.mensagem_da_conversa(uuid, uuid) from public, anon;
grant execute on function public.mensagem_da_conversa(uuid, uuid) to authenticated, service_role;

create policy mensagens_citacao_mesma_conversa on public.mensagens
  as restrictive
  for insert to authenticated
  with check (
    responde_a_id is null
    or public.mensagem_da_conversa(responde_a_id, conversa_id)
  );

-- Índices para as leituras de período do Dashboard (32-dashboard.sql), que filtram
-- por data e não por conversa.
create index mensagens_momento on public.mensagens (momento);
create index rodadas_terminada on public.rodadas (terminada_em) where status in ('concluida', 'falhou');
create index conversa_eventos_tipo on public.conversa_eventos (tipo, criado_em);