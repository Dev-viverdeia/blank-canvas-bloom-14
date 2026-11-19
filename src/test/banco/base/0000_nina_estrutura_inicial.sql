-- =====================================================================
-- Nina nova: estrutura do banco (01)
-- Enums, tabelas, índices, RLS, permissões, eh_membro/eh_admin,
-- colunas cifradas, gatilhos e realtime. O bucket 'midias' fica no 05.
-- Contrato: a spec. Sem BEGIN/COMMIT.
-- Chaves de IA e credenciais dos gateways ficam em coluna cifrada pelo
-- servidor do app (AES-256-GCM, chave mestra fora do banco). O banco só
-- guarda o texto cifrado e confere o formato v<n>:<iv base64>:<cifra base64>,
-- para nunca entrar texto puro. authenticated não lê essas colunas.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Enums (valores na ordem da spec)
-- ---------------------------------------------------------------------
create type public.papel_membro as enum ('admin', 'atendente');
create type public.gateway as enum ('meta', 'zernio', 'lovable', 'zapi', 'evolution');
create type public.conexao_status as enum ('conectando', 'conectada', 'desconectada', 'erro');
create type public.ia_provedor as enum ('anthropic', 'openai', 'openrouter', 'groq');
create type public.ia_finalidade as enum ('resposta', 'transcricao');
create type public.chave_status as enum ('ativa', 'invalida', 'sem_credito', 'removida');
create type public.identificador_tipo as enum ('telefone', 'bsuid', 'lid', 'zernio_conversa');
create type public.etapa_tipo as enum ('aberta', 'ganho', 'perdido');
create type public.historico_ator as enum ('membro', 'nina', 'sistema');
create type public.conversa_modo as enum ('nina', 'humano');
create type public.motivo_humano as enum ('nina_passou', 'humano_tela', 'humano_celular', 'chave_invalida', 'sem_credito', 'audio_sem_transcricao', 'limite_passos', 'erro_provedor');
create type public.mensagem_direcao as enum ('entrada', 'saida');
create type public.mensagem_origem as enum ('lead', 'nina', 'humano_tela', 'humano_celular');
create type public.mensagem_tipo as enum ('texto', 'imagem', 'audio', 'video', 'documento', 'figurinha', 'outro');
create type public.mensagem_status as enum ('recebida', 'na_fila', 'enviando', 'enviada', 'entregue', 'lida', 'falhou', 'cancelada');
create type public.midia_status as enum ('pendente', 'copiada', 'falhou', 'expirada');
create type public.rodada_status as enum ('rodando', 'concluida', 'falhou', 'cancelada');
create type public.chamada_tipo as enum ('resposta', 'transcricao', 'onboarding');
create type public.custo_origem as enum ('provedor', 'tabela', 'sem_preco');
create type public.contexto_origem as enum ('onboarding', 'edicao', 'restauracao');
create type public.auditoria_acao as enum ('chave_cadastrada', 'chave_trocada', 'chave_removida', 'chave_recusada', 'conexao_criada', 'conexao_ativada', 'conexao_desativada', 'membro_convidado', 'membro_desativado', 'membro_papel_trocado', 'contato_apagado');

-- ---------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------

-- Equipe. A 1ª conta vira admin pelo gatilho em auth.users; as outras
-- entram pelo convite (o servidor cria a linha com o user_id do convite).
create table public.membros (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users (id) on delete set null,
  nome text not null,
  email text not null unique check (email = lower(email) and email <> ''),
  papel public.papel_membro not null default 'atendente',
  ativo boolean not null default true,
  convidado_por uuid references public.membros (id) on delete set null,
  criado_em timestamptz not null default now()
);

-- Linha única (id = 1).
create table public.configuracao (
  id smallint primary key default 1 check (id = 1),
  espera_lote_s integer not null default 8 check (espera_lote_s > 0),
  espera_lote_max_s integer not null default 60,
  onboarding_concluido_em timestamptz,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  check (espera_lote_max_s >= espera_lote_s)
);

create table public.ia_chaves (
  id uuid primary key default gen_random_uuid(),
  finalidade public.ia_finalidade not null unique,
  provedor public.ia_provedor not null,
  modelo text not null,
  workspace_id text,
  -- Formato da cifra; nulo na transcrição = usa a chave da resposta.
  -- O gatilho ia_chaves_formato_cifra confere antes (sem citar o valor); o check
  -- fica como última barreira.
  chave_cifrada text constraint ia_chaves_chave_cifrada_formato
    check (chave_cifrada is null or chave_cifrada ~ '^v[0-9]+:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$'),
  ultimos4 text check (ultimos4 is null or char_length(ultimos4) <= 4),
  status public.chave_status not null default 'ativa',
  ultimo_erro text,
  validada_em timestamptz,
  atualizada_em timestamptz not null default now(),
  atualizada_por uuid references public.membros (id) on delete set null,
  criado_em timestamptz not null default now(),
  constraint ia_chaves_groq_so_transcricao check (provedor <> 'groq' or finalidade = 'transcricao')
);

create table public.conexoes (
  id uuid primary key default gen_random_uuid(),
  gateway public.gateway not null,
  nome text not null,
  id_externo text not null,
  parametros jsonb not null default '{}'::jsonb check (jsonb_typeof(parametros) = 'object'),
  -- nome -> texto no formato da cifra. Valor que não é texto ou fora do
  -- formato é recusado (strict + silent: não estoura erro, o check de objeto pega).
  -- O nome do segredo segue o padrão dos campos do app (token, apiKey, verifyToken...),
  -- para o servidor não usar o próprio segredo como nome por engano.
  -- O gatilho conexoes_segredos_formato_cifra confere o mesmo antes (sem citar o valor);
  -- estes checks ficam como última barreira.
  segredos jsonb not null default '{}'::jsonb check (jsonb_typeof(segredos) = 'object'),
  constraint conexoes_segredos_formato check (
    not jsonb_path_exists(
      segredos,
      'strict $.* ? (@.type() != "string" || !(@ like_regex "^v[0-9]+:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$"))',
      '{}'::jsonb,
      true
    )
    and not jsonb_path_exists(
      segredos,
      'strict $.keyvalue() ? (!(@.key like_regex "^[a-z][A-Za-z0-9_]{0,39}$"))',
      '{}'::jsonb,
      true
    )
  ),
  status public.conexao_status not null default 'conectando',
  ultimo_erro text,
  ativa boolean not null default false,
  oficial boolean generated always as (gateway in ('meta', 'zernio', 'lovable')) stored,
  criado_por uuid references public.membros (id) on delete set null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (gateway, id_externo)
);
-- Um número ativo por vez.
create unique index conexoes_uma_ativa on public.conexoes (ativa) where ativa;

create table public.etapas (
  id uuid primary key default gen_random_uuid(),
  chave text unique,
  nome text not null check (btrim(nome) <> ''),
  cor text,
  ordem integer not null,
  tipo public.etapa_tipo not null default 'aberta',
  nina_pode_mover boolean not null default false,
  arquivada boolean not null default false,
  criado_em timestamptz not null default now()
);
create index etapas_ordem on public.etapas (ordem) where not arquivada;

create table public.contatos (
  id uuid primary key default gen_random_uuid(),
  nome text,
  nome_whatsapp text,
  telefone text check (telefone is null or telefone ~ '^[0-9]+$'),
  email text,
  empresa text,
  observacoes text,
  resumo_nina text,
  etapa_id uuid not null references public.etapas (id) on delete restrict,
  etapa_desde timestamptz not null default now(),
  primeira_mensagem_em timestamptz,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index contatos_etapa on public.contatos (etapa_id);
create index contatos_coorte on public.contatos (primeira_mensagem_em);
create index contatos_telefone on public.contatos (telefone) where telefone is not null;
create index contatos_atualizado on public.contatos (atualizado_em desc);

create table public.contato_identificadores (
  id uuid primary key default gen_random_uuid(),
  contato_id uuid not null references public.contatos (id) on delete cascade,
  tipo public.identificador_tipo not null,
  valor text not null check (valor <> ''),
  conexao_id uuid references public.conexoes (id) on delete set null,
  criado_em timestamptz not null default now(),
  unique (tipo, valor)
);
create index contato_identificadores_contato on public.contato_identificadores (contato_id);

create table public.conversas (
  id uuid primary key default gen_random_uuid(),
  contato_id uuid not null unique references public.contatos (id) on delete cascade,
  conexao_id uuid references public.conexoes (id) on delete set null,
  modo public.conversa_modo not null default 'nina',
  responsavel_id uuid references public.membros (id) on delete set null,
  aguardando_humano_desde timestamptz,
  motivo_humano public.motivo_humano,
  responder_apos timestamptz,
  ultima_mensagem_em timestamptz,
  ultima_mensagem_preview text,
  ultima_do_lead_em timestamptz,
  nao_lidas integer not null default 0 check (nao_lidas >= 0),
  -- Desvio da spec: última vez que alguém clicou em "Devolver para a Nina". Zera a
  -- contagem de tentativas da rodada (decisão 7: depois de devolver, a Nina volta a
  -- ter 2 novas tentativas em erro passageiro).
  devolvida_em timestamptz,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index conversas_lote on public.conversas (responder_apos) where responder_apos is not null and modo = 'nina';
create index conversas_lista on public.conversas (ultima_mensagem_em desc nulls last);
create index conversas_aguardando on public.conversas (aguardando_humano_desde) where aguardando_humano_desde is not null;
create index conversas_responsavel on public.conversas (responsavel_id) where responsavel_id is not null;

-- Versões do Contexto (id = número da versão; imutável; atual = maior id).
create table public.contexto_versoes (
  id bigint generated always as identity primary key,
  empresa_oferta text not null default '',
  cliente_ideal text not null default '',
  preco text not null default '',
  diferenciais text not null default '',
  objecoes text not null default '',
  quando_passar_humano text not null default '',
  tom_voz text not null default '',
  horario text not null default '',
  itens jsonb not null default '[]'::jsonb check (jsonb_typeof(itens) = 'array'),
  origem public.contexto_origem not null default 'edicao',
  criado_por uuid references public.membros (id) on delete set null,
  criado_em timestamptz not null default now()
);

create table public.rodadas (
  id uuid primary key default gen_random_uuid(),
  conversa_id uuid not null references public.conversas (id) on delete cascade,
  status public.rodada_status not null default 'rodando',
  motivo public.motivo_humano,
  contexto_versao_id bigint references public.contexto_versoes (id) on delete restrict,
  provedor public.ia_provedor,
  modelo text,
  passos integer not null default 0 check (passos >= 0),
  tentativa smallint not null default 1 check (tentativa >= 1),
  passou_humano boolean not null default false,
  ferramentas jsonb not null default '[]'::jsonb,
  iniciada_em timestamptz not null default now(),
  terminada_em timestamptz,
  criado_em timestamptz not null default now()
);
-- No máximo 1 rodada rodando por conversa.
create unique index rodadas_uma_rodando on public.rodadas (conversa_id) where status = 'rodando';
create index rodadas_rodando_desde on public.rodadas (iniciada_em) where status = 'rodando';
create index rodadas_conversa on public.rodadas (conversa_id, iniciada_em desc);

-- Conteúdo bruto do webhook (limpeza de 30 dias). Sem regra para ninguém.
create table public.eventos_webhook (
  id bigint generated always as identity primary key,
  gateway public.gateway not null,
  conexao_id uuid references public.conexoes (id) on delete set null,
  id_evento text,
  tipo text,
  payload jsonb not null,
  recebido_em timestamptz not null default now(),
  processado_em timestamptz,
  erro text,
  tentativas smallint not null default 0,
  criado_em timestamptz not null default now()
);
create unique index eventos_webhook_unico on public.eventos_webhook (gateway, id_evento) where id_evento is not null;
create index eventos_webhook_recebido on public.eventos_webhook (recebido_em);
create index eventos_webhook_pendentes on public.eventos_webhook (recebido_em) where processado_em is null;

create table public.mensagens (
  id uuid primary key default gen_random_uuid(),
  conversa_id uuid not null references public.conversas (id) on delete cascade,
  conexao_id uuid not null references public.conexoes (id) on delete restrict,
  direcao public.mensagem_direcao not null,
  origem public.mensagem_origem not null,
  tipo public.mensagem_tipo not null default 'texto',
  texto text,
  transcricao text,
  midia_ref_externa text,
  midia_caminho text,
  midia_mime text,
  midia_tamanho bigint,
  midia_nome text,
  midia_status public.midia_status,
  midia_tentativas smallint not null default 0,
  midia_pega_em timestamptz,
  id_externo text,
  id_gateway text,
  status public.mensagem_status not null default 'recebida',
  erro text,
  tentativas smallint not null default 0,
  enviar_apos timestamptz,
  autor_membro_id uuid references public.membros (id),
  -- sem "on delete": a rodada só some junto com a conversa (cascata), e
  -- "set null" quebraria o check de que mensagem da Nina tem rodada.
  rodada_id uuid references public.rodadas (id),
  ordem integer,
  editada boolean not null default false,
  apagada_em timestamptz,
  momento timestamptz not null default now(),
  status_em timestamptz,
  evento_id bigint references public.eventos_webhook (id) on delete set null,
  criado_em timestamptz not null default now(),
  constraint mensagens_entrada_e_lead check ((direcao = 'entrada') = (origem = 'lead')),
  constraint mensagens_entrada_recebida check ((direcao = 'entrada') = (status = 'recebida')),
  constraint mensagens_humano_tela_autor check (origem <> 'humano_tela' or autor_membro_id is not null),
  constraint mensagens_nina_rodada check (origem <> 'nina' or rodada_id is not null)
);
create unique index mensagens_id_externo on public.mensagens (conexao_id, id_externo) where id_externo is not null;
create index mensagens_id_gateway on public.mensagens (conexao_id, id_gateway) where id_gateway is not null;
create index mensagens_conversa on public.mensagens (conversa_id, momento);
create index mensagens_fila_envio on public.mensagens (enviar_apos) where status = 'na_fila';
create index mensagens_enviando on public.mensagens (status_em) where status = 'enviando';
create index mensagens_midia_pendente on public.mensagens (criado_em) where midia_status = 'pendente';
create index mensagens_entradas_soltas on public.mensagens (conversa_id, criado_em) where direcao = 'entrada' and rodada_id is null;
create index mensagens_rodada on public.mensagens (rodada_id) where rodada_id is not null;
create index mensagens_evento on public.mensagens (evento_id) where evento_id is not null;

-- Escrito só por gatilho.
create table public.contato_etapa_historico (
  id uuid primary key default gen_random_uuid(),
  contato_id uuid not null references public.contatos (id) on delete cascade,
  de_etapa_id uuid references public.etapas (id),
  para_etapa_id uuid not null references public.etapas (id),
  ator public.historico_ator not null,
  membro_id uuid references public.membros (id) on delete set null,
  rodada_id uuid references public.rodadas (id),
  criado_em timestamptz not null default now()
);
create index contato_etapa_historico_contato on public.contato_etapa_historico (contato_id, criado_em);
create index contato_etapa_historico_para on public.contato_etapa_historico (para_etapa_id);
create index contato_etapa_historico_rodada on public.contato_etapa_historico (rodada_id) where rodada_id is not null;

create table public.ia_precos (
  id uuid primary key default gen_random_uuid(),
  provedor public.ia_provedor not null,
  modelo text not null,
  vigente_desde date not null,
  a_partir_de_tokens integer not null default 0 check (a_partir_de_tokens >= 0),
  entrada numeric,
  cache_leitura numeric,
  cache_escrita numeric,
  saida numeric,
  audio_por_minuto numeric,
  fonte text not null check (btrim(fonte) <> ''),
  criado_em timestamptz not null default now(),
  unique (provedor, modelo, vigente_desde, a_partir_de_tokens)
);

-- Custo da IA: nunca apagado (sem dado pessoal); a rodada vira nula.
create table public.ia_chamadas (
  id bigint generated always as identity primary key,
  rodada_id uuid references public.rodadas (id) on delete set null,
  tipo public.chamada_tipo not null,
  provedor public.ia_provedor not null,
  modelo text not null,
  passo integer,
  tokens_entrada integer,
  tokens_cache_leitura integer,
  tokens_cache_escrita integer,
  tokens_saida integer,
  tokens_raciocinio integer,
  segundos_audio numeric,
  custo_usd numeric(12, 6),
  custo_origem public.custo_origem not null,
  preco_id uuid references public.ia_precos (id) on delete set null,
  request_id text,
  uso_bruto jsonb,
  criado_em timestamptz not null default now(),
  constraint ia_chamadas_sem_preco check ((custo_origem = 'sem_preco') = (custo_usd is null))
);
create index ia_chamadas_criado on public.ia_chamadas (criado_em);
create index ia_chamadas_rodada on public.ia_chamadas (rodada_id) where rodada_id is not null;

-- Só insert, pelo servidor.
create table public.auditoria (
  id bigint generated always as identity primary key,
  ator_membro_id uuid references public.membros (id) on delete set null,
  acao public.auditoria_acao not null,
  alvo text,
  ultimos4 text,
  detalhe jsonb not null default '{}'::jsonb,
  criado_em timestamptz not null default now()
);
create index auditoria_criado on public.auditoria (criado_em desc);

-- ---------------------------------------------------------------------
-- Funções de acesso (usadas nas regras)
-- ---------------------------------------------------------------------
create function public.eh_membro()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.membros m
    where m.user_id = auth.uid() and m.ativo
  );
$$;

create function public.eh_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.membros m
    where m.user_id = auth.uid() and m.ativo and m.papel = 'admin'
  );
$$;

-- ---------------------------------------------------------------------
-- Gatilhos
-- ---------------------------------------------------------------------

-- 1ª conta vira admin. A trava impede duas contas ao mesmo tempo de virarem admin.
create function public.tg_auth_primeira_conta()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('nina.primeira_conta'));
  if new.email is not null and not exists (select 1 from public.membros) then
    insert into public.membros (user_id, nome, email, papel)
    values (
      new.id,
      coalesce(nullif(btrim(new.raw_user_meta_data ->> 'nome'), ''),
               nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
               nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
               lower(btrim(new.email))),
      lower(btrim(new.email)),
      'admin'
    );
  end if;
  return null;
end;
$$;

create trigger membros_primeira_conta
  after insert on auth.users
  for each row execute function public.tg_auth_primeira_conta();

-- E-mail do membro sempre minúsculo.
create function public.tg_membros_normalizar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.email := lower(btrim(new.email));
  return new;
end;
$$;

create trigger membros_normalizar
  before insert or update of email on public.membros
  for each row execute function public.tg_membros_normalizar();

-- Precisa sobrar ao menos 1 admin ativo (com conta). Apagar a conta do admin em
-- auth.users vira um UPDATE de user_id (set null) e também passa por aqui.
create function public.tg_membros_ultimo_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.papel = 'admin' and old.ativo and old.user_id is not null
     and (tg_op = 'DELETE' or new.papel <> 'admin' or not new.ativo or new.user_id is null) then
    perform pg_advisory_xact_lock(hashtext('nina.membros_admin'));
    if not exists (
      select 1 from public.membros m
      where m.id <> old.id and m.papel = 'admin' and m.ativo and m.user_id is not null
    ) then
      raise exception using message = 'ultimo_admin', errcode = 'P0001';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger membros_ultimo_admin
  before update of papel, ativo, user_id or delete on public.membros
  for each row execute function public.tg_membros_ultimo_admin();

-- atualizado_em / atualizada_em
create function public.tg_tocar_atualizado_em()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.atualizado_em := now();
  return new;
end;
$$;

create function public.tg_tocar_atualizada_em()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.atualizada_em := now();
  return new;
end;
$$;

create trigger configuracao_atualizado before update on public.configuracao
  for each row execute function public.tg_tocar_atualizado_em();
create trigger conexoes_atualizado before update on public.conexoes
  for each row execute function public.tg_tocar_atualizado_em();
create trigger conversas_atualizado before update on public.conversas
  for each row execute function public.tg_tocar_atualizado_em();
create trigger ia_chaves_atualizada before update on public.ia_chaves
  for each row execute function public.tg_tocar_atualizada_em();

-- Arquivar (ou apagar) etapa: só sem leads, e precisa sobrar 1 etapa aberta.
create function public.tg_etapas_arquivar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_saindo boolean;
  v_perde_aberta boolean;
begin
  v_saindo := tg_op = 'DELETE' or (new.arquivada and not old.arquivada);
  v_perde_aberta := old.tipo = 'aberta' and not old.arquivada
    and (tg_op = 'DELETE' or new.arquivada or new.tipo <> 'aberta');

  if v_saindo or v_perde_aberta then
    perform pg_advisory_xact_lock(hashtext('nina.etapas'));
  end if;

  if v_saindo and exists (select 1 from public.contatos c where c.etapa_id = old.id) then
    raise exception using message = 'etapa_com_leads', errcode = 'P0001';
  end if;

  if v_perde_aberta and not exists (
    select 1 from public.etapas e
    where e.id <> old.id and e.tipo = 'aberta' and not e.arquivada
  ) then
    raise exception using message = 'sem_etapa_de_entrada', errcode = 'P0001';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger etapas_arquivar
  before update of arquivada, tipo or delete on public.etapas
  for each row execute function public.tg_etapas_arquivar();

-- Contato: etapa de entrada, etapa_desde e atualizado_em.
create function public.tg_contatos_antes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_arquivada boolean;
begin
  if tg_op = 'INSERT' then
    if new.etapa_id is null then
      -- FOR SHARE: conflita com o UPDATE que arquiva a etapa e põe os dois em fila
      -- (a trava da chave estrangeira sozinha não conflita).
      select e.id into new.etapa_id
      from public.etapas e
      where e.tipo = 'aberta' and not e.arquivada
      order by e.ordem, e.criado_em, e.id
      limit 1
      for share;
      if new.etapa_id is null then
        raise exception using message = 'sem_etapa_de_entrada', errcode = 'P0001';
      end if;
    end if;
  else
    new.atualizado_em := now();
    if new.etapa_id is not distinct from old.etapa_id then
      return new;
    end if;
    new.etapa_desde := now();
  end if;

  if new.etapa_id is not null then
    select e.arquivada into v_arquivada
    from public.etapas e where e.id = new.etapa_id
    for share;
    if coalesce(v_arquivada, false) then
      raise exception using message = 'etapa_arquivada', errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create trigger contatos_antes
  before insert or update on public.contatos
  for each row execute function public.tg_contatos_antes();

-- Histórico de etapa: nina (nina.rodada_id na transação), membro (auth.uid()) ou sistema.
create function public.tg_contatos_historico()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rodada uuid;
  v_membro uuid;
  v_ator public.historico_ator;
begin
  if tg_op = 'UPDATE' and new.etapa_id is not distinct from old.etapa_id then
    return null;
  end if;

  v_rodada := nullif(current_setting('nina.rodada_id', true), '')::uuid;
  if v_rodada is not null then
    v_ator := 'nina';
  else
    if auth.uid() is not null then
      select m.id into v_membro from public.membros m where m.user_id = auth.uid();
    end if;
    v_ator := case when v_membro is not null then 'membro' else 'sistema' end;
  end if;

  insert into public.contato_etapa_historico (contato_id, de_etapa_id, para_etapa_id, ator, membro_id, rodada_id)
  values (
    new.id,
    case when tg_op = 'UPDATE' then old.etapa_id end,
    new.etapa_id,
    v_ator,
    v_membro,
    v_rodada
  );
  return null;
end;
$$;

create trigger contatos_historico_insert
  after insert on public.contatos
  for each row execute function public.tg_contatos_historico();
create trigger contatos_historico_update
  after update of etapa_id on public.contatos
  for each row execute function public.tg_contatos_historico();

-- Mensagem nova (antes): autor, mídia, conexão ativa, janela de 24h, enviar_apos.
create function public.tg_mensagens_antes_inserir()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ativa uuid;
  v_oficial boolean;
  v_a_enviar boolean;
  v_ultima_lead timestamptz;
begin
  if new.origem = 'humano_tela' and new.autor_membro_id is null and auth.uid() is not null then
    select m.id into new.autor_membro_id
    from public.membros m where m.user_id = auth.uid() and m.ativo;
  end if;

  if new.midia_status is null then
    if new.midia_ref_externa is not null then
      new.midia_status := 'pendente';
    elsif new.midia_caminho is not null then
      new.midia_status := 'copiada';
    end if;
  end if;

  if new.direcao = 'saida' then
    v_a_enviar := new.status in ('na_fila', 'enviando');
    select c.id, c.oficial into v_ativa, v_oficial from public.conexoes c where c.ativa;

    if v_a_enviar then
      -- Sai sempre pelo número ativo.
      if v_ativa is null then
        raise exception using message = 'sem_conexao_ativa', errcode = 'P0001';
      end if;
      new.conexao_id := v_ativa;

      if v_oficial and new.origem <> 'humano_celular' then
        select cv.ultima_do_lead_em into v_ultima_lead
        from public.conversas cv where cv.id = new.conversa_id;
        if v_ultima_lead is null or v_ultima_lead + interval '24 hours' <= now() then
          raise exception using message = 'janela_fechada', errcode = 'P0001';
        end if;
      end if;

      if new.status = 'na_fila' and new.enviar_apos is null then
        new.enviar_apos := now();
      end if;
    elsif new.conexao_id is null then
      new.conexao_id := coalesce(
        v_ativa,
        (select cv.conexao_id from public.conversas cv where cv.id = new.conversa_id)
      );
      if new.conexao_id is null then
        raise exception using message = 'sem_conexao_ativa', errcode = 'P0001';
      end if;
    end if;
  end if;
  return new;
end;
$$;

create trigger mensagens_antes_inserir
  before insert on public.mensagens
  for each row execute function public.tg_mensagens_antes_inserir();

-- Mensagem nova (depois): atualiza a conversa.
create function public.tg_mensagens_apos_inserir()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conv public.conversas%rowtype;
  v_espera integer;
  v_teto integer;
  v_primeira timestamptz;
begin
  select * into v_conv from public.conversas c where c.id = new.conversa_id for update;
  if not found then
    return null;
  end if;

  -- Prévia: só a mensagem mais recente (pelo momento) e não cancelada.
  if new.status <> 'cancelada'
     and (v_conv.ultima_mensagem_em is null or new.momento >= v_conv.ultima_mensagem_em) then
    v_conv.ultima_mensagem_em := new.momento;
    v_conv.ultima_mensagem_preview := left(
      coalesce(nullif(btrim(new.texto), ''), '[' || new.tipo::text || ']'), 140);
  end if;

  if new.direcao = 'entrada' then
    v_conv.nao_lidas := v_conv.nao_lidas + 1;
    v_conv.ultima_do_lead_em := greatest(v_conv.ultima_do_lead_em, new.momento);
    if v_conv.modo = 'nina' then
      select cf.espera_lote_s, cf.espera_lote_max_s into v_espera, v_teto
      from public.configuracao cf where cf.id = 1;
      -- 1ª pendente do lote. Sem nada armado, o lote começa nesta mensagem. Senão,
      -- conta só as entradas soltas que chegaram depois da última rodada: as que
      -- ficaram soltas no modo humano ou numa rodada que falhou ou foi cancelada
      -- não podem puxar o teto para o passado. Um armado vencido há mais que o teto
      -- (a conversa esperou armada sem conexão ativa ou com a janela oficial
      -- fechada) conta como nada armado: o lote recomeça nesta mensagem.
      if v_conv.responder_apos is not null
         and v_conv.responder_apos < now() - make_interval(secs => coalesce(v_teto, 60)) then
        v_conv.responder_apos := null;
      end if;
      if v_conv.responder_apos is null then
        v_primeira := now();
      else
        select min(m.criado_em) into v_primeira
        from public.mensagens m
        where m.conversa_id = new.conversa_id and m.direcao = 'entrada' and m.rodada_id is null
          and m.criado_em > coalesce((select max(r.iniciada_em) from public.rodadas r
                                      where r.conversa_id = new.conversa_id), '-infinity'::timestamptz);
      end if;
      -- 8 s que recomeçam a cada mensagem, com teto de 60 s desde a 1ª pendente.
      -- Um re-armado que já está mais adiante (falha passageira: +30 s) é mantido.
      v_conv.responder_apos := greatest(
        coalesce(v_conv.responder_apos, '-infinity'::timestamptz),
        least(
          now() + make_interval(secs => coalesce(v_espera, 8)),
          coalesce(v_primeira, now()) + make_interval(secs => coalesce(v_teto, 60))
        )
      );
    end if;
  elsif new.origem in ('humano_tela', 'humano_celular') then
    if v_conv.modo = 'nina' then
      v_conv.motivo_humano := new.origem::text::public.motivo_humano;
    end if;
    v_conv.modo := 'humano';
    v_conv.responsavel_id := coalesce(v_conv.responsavel_id, new.autor_membro_id);
    v_conv.aguardando_humano_desde := null;
    v_conv.responder_apos := null;
    update public.mensagens m
    set status = 'cancelada', status_em = now()
    where m.conversa_id = new.conversa_id and m.origem = 'nina' and m.status = 'na_fila';
    -- A rodada que ainda está rodando foi atropelada pelo humano: fica 'cancelada'
    -- (o concluir_rodada grava as respostas dela como canceladas) e solta as entradas.
    with canceladas as (
      update public.rodadas r
         set status = 'cancelada', terminada_em = now()
       where r.conversa_id = new.conversa_id and r.status = 'rodando'
      returning r.id
    )
    update public.mensagens m
       set rodada_id = null
      from canceladas k
     where m.rodada_id = k.id and m.direcao = 'entrada';
  end if;

  update public.conversas c
  set ultima_mensagem_em = v_conv.ultima_mensagem_em,
      ultima_mensagem_preview = v_conv.ultima_mensagem_preview,
      nao_lidas = v_conv.nao_lidas,
      ultima_do_lead_em = v_conv.ultima_do_lead_em,
      responder_apos = v_conv.responder_apos,
      modo = v_conv.modo,
      motivo_humano = v_conv.motivo_humano,
      responsavel_id = v_conv.responsavel_id,
      aguardando_humano_desde = v_conv.aguardando_humano_desde
  where c.id = new.conversa_id;
  return null;
end;
$$;

create trigger mensagens_apos_inserir
  after insert on public.mensagens
  for each row execute function public.tg_mensagens_apos_inserir();

-- Contexto: criado_por = quem está logado, se vier vazio.
create function public.tg_contexto_autor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.criado_por is null and auth.uid() is not null then
    select m.id into new.criado_por from public.membros m where m.user_id = auth.uid();
  end if;
  return new;
end;
$$;

create trigger contexto_autor
  before insert on public.contexto_versoes
  for each row execute function public.tg_contexto_autor();

-- conexoes: desativar apaga os segredos cifrados dela.
create function public.tg_conexoes_desativar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.ativa and not new.ativa then
    new.segredos := '{}'::jsonb;
  end if;
  return new;
end;
$$;

create trigger conexoes_desativar
  before update of ativa on public.conexoes
  for each row execute function public.tg_conexoes_desativar();

-- Formato da cifra conferido por gatilho, antes dos checks. Quando um check
-- recusa a linha, o Postgres põe a linha inteira no detalhe do erro ("Failing
-- row contains ..."), e o servidor (service_role) receberia ali o texto puro que
-- tentou gravar por engano, que também iria para o log do banco. O erro destes
-- gatilhos tem mensagem fixa, sem nenhum valor.
create function public.tg_ia_chaves_formato()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.chave_cifrada is not null
     and new.chave_cifrada !~ '^v[0-9]+:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$' then
    raise exception using message = 'segredo_fora_do_formato', errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger ia_chaves_formato_cifra
  before insert or update of chave_cifrada on public.ia_chaves
  for each row execute function public.tg_ia_chaves_formato();

-- Este gatilho só dispara quando o UPDATE cita a coluna segredos no SET. Num
-- UPDATE que só muda ativa, ele não roda; o '{}' que conexoes_desativar põe é
-- válido e os checks da tabela continuam valendo. Quando o mesmo UPDATE muda
-- ativa e segredos, os dois disparam em ordem alfabética: conexoes_desativar
-- roda antes e este confere o '{}' que ele deixou.
create function public.tg_conexoes_segredos_formato()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.segredos is not null and (
       jsonb_typeof(new.segredos) <> 'object'
       or jsonb_path_exists(
            new.segredos,
            'strict $.* ? (@.type() != "string" || !(@ like_regex "^v[0-9]+:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$"))',
            '{}'::jsonb,
            true)
       or jsonb_path_exists(
            new.segredos,
            'strict $.keyvalue() ? (!(@.key like_regex "^[a-z][A-Za-z0-9_]{0,39}$"))',
            '{}'::jsonb,
            true)
     ) then
    raise exception using message = 'segredo_fora_do_formato', errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger conexoes_segredos_formato_cifra
  before insert or update of segredos on public.conexoes
  for each row execute function public.tg_conexoes_segredos_formato();

-- ---------------------------------------------------------------------
-- Permissões de execução das funções
-- ---------------------------------------------------------------------
revoke execute on function public.eh_membro() from public, anon;
revoke execute on function public.eh_admin() from public, anon;
grant execute on function public.eh_membro() to authenticated, service_role;
grant execute on function public.eh_admin() to authenticated, service_role;

-- Funções de gatilho: ninguém chama direto.
revoke execute on function public.tg_auth_primeira_conta() from public, anon, authenticated, service_role;
revoke execute on function public.tg_membros_normalizar() from public, anon, authenticated, service_role;
revoke execute on function public.tg_membros_ultimo_admin() from public, anon, authenticated, service_role;
revoke execute on function public.tg_tocar_atualizado_em() from public, anon, authenticated, service_role;
revoke execute on function public.tg_tocar_atualizada_em() from public, anon, authenticated, service_role;
revoke execute on function public.tg_etapas_arquivar() from public, anon, authenticated, service_role;
revoke execute on function public.tg_contatos_antes() from public, anon, authenticated, service_role;
revoke execute on function public.tg_contatos_historico() from public, anon, authenticated, service_role;
revoke execute on function public.tg_mensagens_antes_inserir() from public, anon, authenticated, service_role;
revoke execute on function public.tg_mensagens_apos_inserir() from public, anon, authenticated, service_role;
revoke execute on function public.tg_contexto_autor() from public, anon, authenticated, service_role;
revoke execute on function public.tg_conexoes_desativar() from public, anon, authenticated, service_role;
revoke execute on function public.tg_ia_chaves_formato() from public, anon, authenticated, service_role;
revoke execute on function public.tg_conexoes_segredos_formato() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Permissões nas tabelas
-- Tira o padrão do Supabase (tudo para anon e authenticated) e dá só o
-- necessário. service_role continua com tudo (e ignora RLS).
-- ---------------------------------------------------------------------
revoke all on table
  public.membros, public.configuracao, public.ia_chaves, public.conexoes,
  public.etapas, public.contatos, public.contato_identificadores,
  public.contato_etapa_historico, public.conversas, public.mensagens,
  public.eventos_webhook, public.rodadas, public.ia_chamadas, public.ia_precos,
  public.contexto_versoes, public.auditoria
from anon, authenticated;

grant all on table
  public.membros, public.configuracao, public.ia_chaves, public.conexoes,
  public.etapas, public.contatos, public.contato_identificadores,
  public.contato_etapa_historico, public.conversas, public.mensagens,
  public.eventos_webhook, public.rodadas, public.ia_chamadas, public.ia_precos,
  public.contexto_versoes, public.auditoria
to service_role;
-- Imutáveis também para o servidor: versão do Contexto e auditoria só recebem
-- insert; o histórico de etapa é escrito só pelo gatilho. As ações das chaves
-- estrangeiras (cascade, set null) rodam com o dono da tabela e continuam valendo.
revoke update, delete, truncate on table public.contexto_versoes, public.auditoria from service_role;
revoke insert, update, delete, truncate on table public.contato_etapa_historico from service_role;

revoke all on sequence
  public.contexto_versoes_id_seq, public.eventos_webhook_id_seq,
  public.ia_chamadas_id_seq, public.auditoria_id_seq
from anon, authenticated;
grant usage, select on sequence
  public.contexto_versoes_id_seq, public.eventos_webhook_id_seq,
  public.ia_chamadas_id_seq, public.auditoria_id_seq
to service_role;

-- Leitura (o RLS decide quais linhas). eventos_webhook fica sem nada.
grant select on table
  public.membros, public.configuracao,
  public.etapas, public.contatos, public.contato_identificadores,
  public.contato_etapa_historico, public.conversas, public.mensagens,
  public.rodadas, public.ia_chamadas, public.ia_precos,
  public.contexto_versoes, public.auditoria
to authenticated;

-- ia_chaves e conexoes: leitura por coluna. chave_cifrada e segredos ficam
-- só com o servidor (service_role); nem o admin lê.
grant select (id, finalidade, provedor, modelo, workspace_id, ultimos4, status, ultimo_erro, validada_em, atualizada_em, atualizada_por, criado_em) on public.ia_chaves to authenticated;
grant select (id, gateway, nome, id_externo, parametros, status, ultimo_erro, ativa, oficial, criado_por, criado_em, atualizado_em) on public.conexoes to authenticated;

-- Escrita por coluna.
grant update (nome, email, empresa, observacoes, resumo_nina, etapa_id) on public.contatos to authenticated;
grant insert (id, conversa_id, conexao_id, direcao, origem, tipo, texto, midia_caminho, midia_mime, midia_tamanho, midia_nome, status, autor_membro_id) on public.mensagens to authenticated;
grant insert (nome, cor, ordem, tipo, nina_pode_mover) on public.etapas to authenticated;
grant update (nome, cor, ordem, tipo, nina_pode_mover, arquivada) on public.etapas to authenticated;
grant insert (empresa_oferta, cliente_ideal, preco, diferenciais, objecoes, quando_passar_humano, tom_voz, horario, itens, origem, criado_por) on public.contexto_versoes to authenticated;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.membros enable row level security;
alter table public.configuracao enable row level security;
alter table public.ia_chaves enable row level security;
alter table public.conexoes enable row level security;
alter table public.etapas enable row level security;
alter table public.contatos enable row level security;
alter table public.contato_identificadores enable row level security;
alter table public.contato_etapa_historico enable row level security;
alter table public.conversas enable row level security;
alter table public.mensagens enable row level security;
alter table public.eventos_webhook enable row level security;
alter table public.rodadas enable row level security;
alter table public.ia_chamadas enable row level security;
alter table public.ia_precos enable row level security;
alter table public.contexto_versoes enable row level security;
alter table public.auditoria enable row level security;

-- Membro ativo lê.
create policy membros_membro_le on public.membros
  for select to authenticated using ((select public.eh_membro()));
create policy etapas_membro_le on public.etapas
  for select to authenticated using ((select public.eh_membro()));
create policy contatos_membro_le on public.contatos
  for select to authenticated using ((select public.eh_membro()));
create policy contato_identificadores_membro_le on public.contato_identificadores
  for select to authenticated using ((select public.eh_membro()));
create policy contato_etapa_historico_membro_le on public.contato_etapa_historico
  for select to authenticated using ((select public.eh_membro()));
create policy conversas_membro_le on public.conversas
  for select to authenticated using ((select public.eh_membro()));
create policy mensagens_membro_le on public.mensagens
  for select to authenticated using ((select public.eh_membro()));
create policy rodadas_membro_le on public.rodadas
  for select to authenticated using ((select public.eh_membro()));
create policy conexoes_membro_le on public.conexoes
  for select to authenticated using ((select public.eh_membro()));
create policy contexto_versoes_membro_le on public.contexto_versoes
  for select to authenticated using ((select public.eh_membro()));

-- Admin lê.
create policy configuracao_admin_le on public.configuracao
  for select to authenticated using ((select public.eh_admin()));
create policy ia_chaves_admin_le on public.ia_chaves
  for select to authenticated using ((select public.eh_admin()));
create policy ia_chamadas_admin_le on public.ia_chamadas
  for select to authenticated using ((select public.eh_admin()));
create policy ia_precos_admin_le on public.ia_precos
  for select to authenticated using ((select public.eh_admin()));
create policy auditoria_admin_le on public.auditoria
  for select to authenticated using ((select public.eh_admin()));

-- Membro altera contatos (as colunas vêm do grant por coluna).
create policy contatos_membro_altera on public.contatos
  for update to authenticated
  using ((select public.eh_membro()))
  with check ((select public.eh_membro()));

-- Membro insere mensagem só como humano_tela, na fila e como ele mesmo.
create policy mensagens_membro_insere on public.mensagens
  for insert to authenticated
  with check (
    (select public.eh_membro())
    and direcao = 'saida'
    and origem = 'humano_tela'
    and status = 'na_fila'
    and autor_membro_id = (
      select m.id from public.membros m
      where m.user_id = (select auth.uid()) and m.ativo
    )
  );

-- Admin grava em etapas (sem apagar: apagar é arquivar).
create policy etapas_admin_insere on public.etapas
  for insert to authenticated with check ((select public.eh_admin()));
create policy etapas_admin_altera on public.etapas
  for update to authenticated
  using ((select public.eh_admin()))
  with check ((select public.eh_admin()));

-- Admin insere versão do Contexto, em nome dele mesmo.
create policy contexto_versoes_admin_insere on public.contexto_versoes
  for insert to authenticated
  with check (
    (select public.eh_admin())
    and criado_por = (
      select m.id from public.membros m
      where m.user_id = (select auth.uid()) and m.ativo
    )
  );

-- eventos_webhook: nenhuma política (só o servidor).

-- ---------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------
do $$
declare
  v_tabela text;
begin
  foreach v_tabela in array array['mensagens', 'conversas', 'contatos'] loop
    if not exists (
      select 1 from pg_catalog.pg_publication_tables p
      where p.pubname = 'supabase_realtime' and p.schemaname = 'public' and p.tablename = v_tabela
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_tabela);
    end if;
  end loop;
end;
$$;