-- Imitação do Supabase (Lovable Cloud) para o banco de teste (PGlite).
-- Só para teste: nunca vai ao banco real. Aplicada por src/test/banco/montar.ts ANTES das
-- migrations de drizzle/migrations. Roda como superusuário (postgres).
-- Referência: banco real = PostgreSQL 17 + supabase_vault 0.3.1 + pgcrypto + uuid-ossp.

-- ---------------------------------------------------------------------------
-- Papéis (como no Supabase). O superusuário segue sendo postgres.
-- ---------------------------------------------------------------------------
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

-- dono_app faz o papel do "postgres" do Supabase real, que aplica as migrations:
-- NÃO é superusuário, tem bypassrls e createrole e só os privilégios que recebe abaixo
-- (vault, auth, storage, publicação). montar.ts aplica as migrations com
-- "set role dono_app", então todas as funções SECURITY DEFINER do app pertencem a ele
-- e rodam só com esse poder (o superusuário do PGlite passaria por cima de qualquer GRANT).
create role dono_app nologin bypassrls createrole;

-- Donos das tabelas do Supabase (como no real: auth e storage não são do postgres).
create role supabase_auth_admin nologin noinherit;
create role supabase_storage_admin nologin noinherit;

-- ---------------------------------------------------------------------------
-- Schemas
-- ---------------------------------------------------------------------------
create schema if not exists auth;
create schema if not exists extensions;
create schema if not exists storage;
create schema if not exists vault;

grant usage on schema public     to anon, authenticated, service_role;
grant usage on schema auth       to anon, authenticated, service_role;
grant usage on schema storage    to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;
grant usage, create on schema public to dono_app;
grant usage on schema auth, storage, extensions to dono_app;
grant usage on schema auth to supabase_auth_admin;
grant usage on schema storage to supabase_storage_admin;
-- vault: sem nenhum acesso para anon e authenticated. service_role lê e apaga, como no
-- banco real (ver os grants depois das funções do vault).

-- Extensões do banco real que ficam no schema extensions (pgcrypto, uuid-ossp).
-- As migrations podem usar extensions.gen_random_bytes(), extensions.digest(), etc.
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;

-- ---------------------------------------------------------------------------
-- Privilégios padrão do Supabase no schema public: tudo para os três papéis.
-- (O PUBLIC continua executando funções novas, como no Postgres.)
-- ---------------------------------------------------------------------------
alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
-- o mesmo para o dono das migrations (o "postgres" do real)
alter default privileges for role dono_app in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges for role dono_app in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role dono_app in schema public grant all on sequences to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- auth
-- ---------------------------------------------------------------------------
create table auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  raw_app_meta_data  jsonb not null default '{}'::jsonb,
  email_confirmed_at timestamptz,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);
create unique index users_email_key on auth.users (email);
alter table auth.users enable row level security;
-- anon e authenticated não têm nenhum privilégio em auth.users (como no real).
grant all on table auth.users to service_role;
-- Dono real: supabase_auth_admin (é ele quem insere no cadastro, com search_path = auth).
alter table auth.users owner to supabase_auth_admin;
-- O "postgres" do real cria gatilho e chave estrangeira em auth.users.
grant select, trigger, references on table auth.users to dono_app;

create function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create function auth.role() returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

revoke all on function auth.uid(), auth.role(), auth.jwt() from public;
grant execute on function auth.uid(), auth.role(), auth.jwt() to anon, authenticated, service_role, dono_app;

-- ---------------------------------------------------------------------------
-- vault (como o supabase_vault 0.3.1; nomes de parâmetro new_* como no real, o 4o é ignorado).
-- A coluna secret guarda o texto "cifrado"
-- (aqui: base64 com prefixo); decrypted_secrets devolve o texto claro.
-- ---------------------------------------------------------------------------
create table vault.secrets (
  id          uuid primary key default gen_random_uuid(),
  name        text,
  description text not null default '',
  secret      text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index secrets_name_idx on vault.secrets (name) where name is not null;

create function vault.secrets_cifrar() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' or new.secret is distinct from old.secret then
    new.secret := 'cifrado:' || encode(convert_to(new.secret, 'UTF8'), 'base64');
  end if;
  return new;
end;
$$;

create trigger secrets_cifrar
  before insert or update on vault.secrets
  for each row execute function vault.secrets_cifrar();

create view vault.decrypted_secrets as
  select s.id,
         s.name,
         s.description,
         convert_from(decode(substr(s.secret, 9), 'base64'), 'UTF8') as decrypted_secret,
         s.created_at,
         s.updated_at
    from vault.secrets s;

create function vault.create_secret(
  new_secret text,
  new_name text default null,
  new_description text default '',
  new_key_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  novo_id uuid;
begin
  insert into vault.secrets (secret, name, description)
  values (new_secret, new_name, coalesce(new_description, ''))
  returning id into novo_id;
  return novo_id;
end;
$$;

create function vault.update_secret(
  secret_id uuid,
  new_secret text default null,
  new_name text default null,
  new_description text default null,
  new_key_id uuid default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update vault.secrets s
     set secret      = coalesce(new_secret, convert_from(decode(substr(s.secret, 9), 'base64'), 'UTF8')),
         name        = coalesce(new_name, s.name),
         description = coalesce(new_description, s.description),
         updated_at  = now()
   where s.id = secret_id;
end;
$$;

-- O PUBLIC executa funções novas por padrão: tirar, para valer "sem acesso" a anon/authenticated.
revoke all on function vault.create_secret(text, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function vault.update_secret(uuid, text, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on table vault.secrets, vault.decrypted_secrets from public, anon, authenticated, service_role;
-- O "postgres" do real (aqui dono_app) chega ao vault só por estes privilégios: lê o
-- texto claro pela view, apaga pela tabela e grava pelas funções (security definer,
-- como no supabase_vault 0.3). Nunca insere nem altera vault.secrets direto.
grant usage on schema vault to dono_app;
grant select, delete on table vault.secrets to dono_app;
grant select on table vault.decrypted_secrets to dono_app;
grant execute on function vault.create_secret(text, text, text, uuid) to dono_app;
grant execute on function vault.update_secret(uuid, text, text, text, uuid) to dono_app;
-- Conferido no banco real em 28/10/2026 (sessão principal, só SELECT): service_role tem
-- SELECT e DELETE em vault.secrets e vault.decrypted_secrets e executa create_secret e
-- update_secret. anon e authenticated não têm nada.
grant usage on schema vault to service_role;
grant select, delete on table vault.secrets to service_role;
grant select on table vault.decrypted_secrets to service_role;
grant execute on function vault.create_secret(text, text, text, uuid) to service_role;
grant execute on function vault.update_secret(uuid, text, text, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- storage
-- ---------------------------------------------------------------------------
create table storage.buckets (
  id                 text primary key,
  name               text not null unique,
  public             boolean default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);
alter table storage.buckets enable row level security;

create table storage.objects (
  id          uuid primary key default gen_random_uuid(),
  bucket_id   text references storage.buckets (id),
  name        text,
  owner       uuid,
  metadata    jsonb,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
create unique index objects_bucket_name_idx on storage.objects (bucket_id, name);
alter table storage.objects enable row level security;

grant all on table storage.buckets, storage.objects to anon, authenticated, service_role;
-- Dono real: supabase_storage_admin. ATENÇÃO, conferido no banco real em 28/10/2026:
-- o "postgres" real NÃO é membro de supabase_storage_admin (tem só privilégios com grant
-- option em storage.objects e insert em storage.buckets). Criar política em storage.objects
-- exige ser dono, então a migration das regras do storage (0003) só passa no real porque o
-- agente do Lovable a aplica com um papel que pode. Aqui o dono_app vira membro para testar
-- a lógica das políticas.
alter table storage.buckets owner to supabase_storage_admin;
alter table storage.objects owner to supabase_storage_admin;
grant supabase_storage_admin to dono_app;
grant all on table storage.buckets, storage.objects to dono_app;

create function storage.foldername(name text) returns text[]
language plpgsql immutable
as $$
declare
  partes text[];
begin
  select string_to_array(name, '/') into partes;
  return partes[1:array_length(partes, 1) - 1];
end;
$$;

create function storage.filename(name text) returns text
language plpgsql immutable
as $$
declare
  partes text[];
begin
  select string_to_array(name, '/') into partes;
  return partes[array_length(partes, 1)];
end;
$$;

create function storage.extension(name text) returns text
language plpgsql immutable
as $$
declare
  partes text[];
  nome_arquivo text;
begin
  select string_to_array(name, '/') into partes;
  nome_arquivo := partes[array_length(partes, 1)];
  return case when position('.' in nome_arquivo) > 0
              then (string_to_array(nome_arquivo, '.'))[array_length(string_to_array(nome_arquivo, '.'), 1)]
              else '' end;
end;
$$;

grant execute on function storage.foldername(text), storage.filename(text), storage.extension(text)
  to anon, authenticated, service_role, dono_app;

-- ---------------------------------------------------------------------------
-- realtime: publicação vazia (o app acrescenta suas tabelas)
-- ---------------------------------------------------------------------------
create publication supabase_realtime;
-- O "postgres" do real é quem acrescenta tabelas (alter publication exige ser dono).
alter publication supabase_realtime owner to dono_app;

-- ---------------------------------------------------------------------------
-- cron (como o pg_cron 1.6.4, só o que o app usa): a tabela cron.job e as funções
-- cron.schedule(job_name, schedule, command), cron.unschedule(job_name) e
-- cron.alter_job(job_id, schedule, command, database, username, active). Com o mesmo nome e o
-- mesmo usuário (current_user de quem chama), o schedule troca o intervalo e o comando do job
-- que já existe (sem mexer em active), como no real. Aqui nada roda sozinho: o teste lê cron.job.
-- Como no real (conferido em 03/11/2026, só SELECT), o "postgres" (aqui dono_app) só LÊ
-- cron.job: as mudanças passam pelas funções, que gravam por dentro com os privilégios do
-- superusuário (cron_imitacao.*, security definer), guardando como username o current_user de
-- quem chamou. Uma função do app que gravasse direto em cron.job falha aqui como lá.
-- ---------------------------------------------------------------------------
create schema if not exists cron;
create schema if not exists cron_imitacao;

create table cron.job (
  jobid    bigserial primary key,
  schedule text not null,
  command  text not null,
  nodename text not null default 'localhost',
  nodeport integer not null default 5432,
  database text not null default current_database(),
  username text not null default current_user,
  active   boolean not null default true,
  jobname  text,
  constraint jobname_username_uniq unique (jobname, username)
);

create function cron_imitacao.schedule(p_usuario text, p_nome text, p_intervalo text, p_comando text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into cron.job (jobname, schedule, command, username)
  values (p_nome, p_intervalo, p_comando, p_usuario)
  on conflict (jobname, username) do update
    set schedule = excluded.schedule, command = excluded.command
  returning jobid into v_id;
  return v_id;
end;
$$;

create function cron_imitacao.unschedule(p_usuario text, p_nome text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from cron.job j where j.jobname = p_nome and j.username = p_usuario;
  if not found then
    raise exception 'could not find valid entry for job ''%''', p_nome;
  end if;
  return true;
end;
$$;

create function cron_imitacao.alter_job(
  p_usuario text, p_id bigint, p_intervalo text, p_comando text, p_banco text, p_dono text, p_ativo boolean
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_dono is not null then
    raise exception 'must be superuser to alter username';
  end if;
  update cron.job j
     set schedule = coalesce(p_intervalo, j.schedule),
         command  = coalesce(p_comando, j.command),
         database = coalesce(p_banco, j.database),
         active   = coalesce(p_ativo, j.active)
   where j.jobid = p_id and j.username = p_usuario;
  if not found then
    raise exception 'Job % does not exist or you don''t own it', p_id;
  end if;
end;
$$;

-- As do real: security invoker, para o current_user ser o de quem chamou.
create function cron.schedule(job_name text, schedule text, command text) returns bigint
language sql
as $$ select cron_imitacao.schedule(current_user::text, job_name, schedule, command) $$;

create function cron.unschedule(job_name text) returns boolean
language sql
as $$ select cron_imitacao.unschedule(current_user::text, job_name) $$;

create function cron.alter_job(
  job_id bigint,
  schedule text default null,
  command text default null,
  database text default null,
  username text default null,
  active boolean default null
) returns void
language sql
as $$ select cron_imitacao.alter_job(current_user::text, job_id, schedule, command, database, username, active) $$;

-- O "postgres" do real (aqui dono_app) usa as funções do cron e só lê cron.job.
revoke all on schema cron, cron_imitacao from public;
revoke all on table cron.job from public, anon, authenticated, service_role;
revoke all on function
  cron.schedule(text, text, text), cron.unschedule(text),
  cron.alter_job(bigint, text, text, text, text, boolean),
  cron_imitacao.schedule(text, text, text, text), cron_imitacao.unschedule(text, text),
  cron_imitacao.alter_job(text, bigint, text, text, text, text, boolean)
  from public, anon, authenticated, service_role;
grant usage on schema cron, cron_imitacao to dono_app;
grant select on table cron.job to dono_app;
grant execute on function
  cron.schedule(text, text, text), cron.unschedule(text),
  cron.alter_job(bigint, text, text, text, text, boolean),
  cron_imitacao.schedule(text, text, text, text), cron_imitacao.unschedule(text, text),
  cron_imitacao.alter_job(text, bigint, text, text, text, text, boolean)
  to dono_app;

-- ---------------------------------------------------------------------------
-- net (como o pg_net 0.20.4, só o que o app usa): net.http_post com a mesma assinatura e os
-- mesmos padrões do real. No real ela é assíncrona (o pedido sai depois do commit); aqui só
-- grava cada chamada em net.http_request_queue para o teste ler, e nada sai da máquina.
-- ---------------------------------------------------------------------------
create schema if not exists net;

create table net.http_request_queue (
  id                   bigserial primary key,
  method               text not null,
  url                  text not null,
  headers              jsonb,
  body                 jsonb,
  params               jsonb,
  timeout_milliseconds integer,
  criado_em            timestamptz not null default now()
);

create function net.http_post(
  url text,
  body jsonb default '{}'::jsonb,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer default 5000
) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into net.http_request_queue (method, url, headers, body, params, timeout_milliseconds)
  values ('POST', url, headers, body, params, timeout_milliseconds)
  returning id into v_id;
  return v_id;
end;
$$;

-- Como no real (o padrão do Supabase, conferido em 03/11/2026, só SELECT): anon, authenticated,
-- service_role e o "postgres" (aqui dono_app) têm usage no schema net e execute no
-- net.http_post. Isso não é do app: os testes do app não dependem do contrário.
revoke all on schema net from public;
revoke all on table net.http_request_queue from public, anon, authenticated, service_role;
revoke all on function net.http_post(text, jsonb, jsonb, jsonb, integer) from public;
grant usage on schema net to anon, authenticated, service_role, dono_app;
grant execute on function net.http_post(text, jsonb, jsonb, jsonb, integer)
  to anon, authenticated, service_role, dono_app;
