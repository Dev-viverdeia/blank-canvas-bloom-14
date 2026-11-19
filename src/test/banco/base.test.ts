// @vitest-environment node
// A própria base dos testes do banco: a imitação do Supabase, as migrations aplicadas como
// dono_app e os ajudantes de montar.ts.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  arquivosExtra,
  arquivosMigrations,
  conferirPg17,
  limparSql,
  migrationsSemCopia,
  montarBase,
  TEMPO_TESTE,
  usarBanco,
  type Papel,
} from "./montar";

const base = await montarBase();
const t = usarBanco(base);

/** Um comando como dono_app (o "postgres" do Supabase real, que não é superusuário). */
async function comoDono(texto: string) {
  await t.sql("set role dono_app");
  try {
    return await t.sql(texto);
  } finally {
    await t.sql("reset role");
  }
}

describe("banco: a base dos testes", { timeout: TEMPO_TESTE }, () => {
  it("aplica todas as migrations do repositório em ordem de nome, depois as de NINA_SQL_EXTRA", async () => {
    const migrations = (await arquivosMigrations()).map((a) => a.split("/").pop());
    const extras = arquivosExtra().map((a) => a.split("/").pop());
    expect(migrations[0]).toBe("0000_nina_estrutura_inicial.sql");
    expect(base.aplicados).toEqual([...migrations, ...extras]);
  });

  // O remix do Lovable apaga os arquivos de drizzle/migrations. O que não estiver na base não chega
  // a quem remixar este projeto: o banco de testes da cópia nasceria sem essa migration.
  it("toda migration do Lovable (drizzle/migrations) tem cópia igual em src/test/banco/base", async () => {
    const semCopia = (await migrationsSemCopia()).map((a) => a.split("/").pop());
    expect(semCopia, "copie para src/test/banco/base/ com o próximo número da base").toEqual([]);
  });

  it("superusuário é postgres e os papéis têm os atributos do Supabase", async () => {
    t.igual((await t.sql("select current_user as u"))[0].u, "postgres", "superusuário");
    const papeis = await t.sql(
      `select rolname, rolcanlogin, rolbypassrls, rolsuper from pg_roles
        where rolname in ('anon', 'authenticated', 'service_role', 'dono_app') order by rolname`,
    );
    t.igual(papeis, [
      { rolname: "anon", rolcanlogin: false, rolbypassrls: false, rolsuper: false },
      { rolname: "authenticated", rolcanlogin: false, rolbypassrls: false, rolsuper: false },
      { rolname: "dono_app", rolcanlogin: false, rolbypassrls: true, rolsuper: false },
      { rolname: "service_role", rolcanlogin: false, rolbypassrls: true, rolsuper: false },
    ]);
    // dentro de como o usuário muda e depois volta
    const dentro = await t.como("authenticated", null, async (q) => (await q("select current_user as u"))[0].u);
    t.igual(dentro, "authenticated");
    t.igual((await t.sql("select current_user as u"))[0].u, "postgres", "voltou ao postgres");
  });

  it("as funções do app pertencem a dono_app, não ao superusuário", async () => {
    const donos = await t.sql(
      `select distinct pg_get_userbyid(p.proowner) as dono
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'`,
    );
    t.igual(donos, [{ dono: "dono_app" }]);
  });

  it("auth.uid() vem do claim: authenticated com usuário enxerga o id; anon não", async () => {
    const u = await t.criarUsuario("base-uid@exemplo.test");
    const comUsuario = await t.como("authenticated", u, async (q) => (await q("select auth.uid() as id"))[0].id);
    t.igual(comUsuario, u, "auth.uid() do authenticated");
    const semUsuario = await t.como("anon", null, async (q) => (await q("select auth.uid() as id, auth.role() as r"))[0]);
    t.igual(semUsuario, { id: null, r: "anon" }, "anon sem usuário");
    // depois do como, os claims ficam limpos
    t.igual((await t.sql("select auth.uid() as id"))[0].id, null, "claims limpos");
  });

  it("como volta ao superusuário e desfaz a transação quando o corpo falha", async () => {
    await t.sql("create table public.b_tx (id int)");
    await t.sql("grant insert, select on public.b_tx to service_role");
    await t.erro(
      t.como("service_role", null, async (q) => {
        await q("begin");
        await q("insert into public.b_tx values (1)");
        await q("select 1 / 0");
      }),
      "division by zero",
    );
    t.igual((await t.sql("select current_user as u"))[0].u, "postgres");
    t.igual((await t.sql("select count(*)::int as n from public.b_tx"))[0].n, 0, "insert desfeito");
  });

  it("criarUsuario dispara o gatilho da primeira conta: só a 1ª vira admin", async () => {
    const u1 = await t.criarUsuario("Primeira@Exemplo.test", "Primeira");
    const u2 = await t.criarUsuario("segunda@exemplo.test", "Segunda");
    const membros = await t.sql("select user_id, nome, email, papel::text from public.membros order by criado_em");
    t.igual(membros, [{ user_id: u1, nome: "Primeira", email: "primeira@exemplo.test", papel: "admin" }]);
    t.ok(u2 !== u1, "ids diferentes");
    // a admin enxerga o próprio membro pela RLS
    const visto = await t.como("authenticated", u1, async (q) => q("select papel::text from public.membros"));
    t.igual(visto, [{ papel: "admin" }]);
    // a segunda conta não é membro: não vê nada
    t.igual(await t.como("authenticated", u2, async (q) => q("select id from public.membros")), []);
  });

  it("erro e igual cumprem o contrato", async () => {
    await t.erro(t.sql("select public.nao_existe()"), "42883");
    await expect(t.erro(t.sql("select 1"), "x")).rejects.toThrow("mas deu certo");
    await expect(t.erro(t.sql("select 1 / 0"), "outro_codigo")).rejects.toThrow("esperava o erro 'outro_codigo'");
    t.igual({ a: [1, 2] }, { a: [1, 2] });
    expect(() => t.igual(1, 2, "conta")).toThrow("conta: veio 1, esperava 2");
    expect(() => t.ok(false, "falso")).toThrow("falso");
  });

  it("limparSql tira os create extension de pgcrypto, uuid-ossp, pg_cron e pg_net e mantém o cofre", () => {
    const texto = [
      "create extension if not exists pgcrypto with schema extensions;",
      'create extension "uuid-ossp";',
      "create extension supabase_vault;",
      "-- create extension pgcrypto; num comentário fica",
      "create extension if not exists pg_cron with schema pg_catalog;",
      "create extension if not exists pg_net with schema extensions;",
      "create extension pg_netx;",
    ].join("\n");
    const limpo = limparSql(texto).split("\n");
    expect(limpo[0]?.trim()).toBe("");
    expect(limpo[1]?.trim()).toBe("");
    expect(limpo[2]).toBe("create extension supabase_vault;");
    expect(limpo[3]).toContain("num comentário fica");
    expect(limpo[4]?.trim()).toBe("");
    expect(limpo[5]?.trim()).toBe("");
    expect(limpo[6]).toBe("create extension pg_netx;");
  });

  it("conferirPg17 recusa o que só existe no PostgreSQL 18", () => {
    expect(() => conferirPg17("alter table x add column y int generated always as (1)")).toThrow("STORED");
    expect(() => conferirPg17("alter table x add column y int generated always as (1) stored")).not.toThrow();
    expect(() => conferirPg17("select uuidv7()")).toThrow("uuidv7");
    expect(() => conferirPg17("-- select uuidv7()\nselect 1")).not.toThrow();
  });

  it("arquivosExtra aceita só caminhos absolutos que existem", () => {
    expect(arquivosExtra("")).toEqual([]);
    expect(() => arquivosExtra("relativo.sql")).toThrow("absoluto");
    expect(() => arquivosExtra("/nao/existe/x.sql")).toThrow("não existe");
  });

  it("isolamento 1/2: suja o banco", async () => {
    await t.sql("create table public.b_sujeira (id int)");
    await t.sql("insert into public.b_sujeira values (1)");
    await t.criarUsuario("base-isolamento@exemplo.test");
    await t.sql("insert into storage.buckets (id, name) values ('b_sujeira', 'b_sujeira')");
    await t.sql("select vault.create_secret('sujeira', 'b_sujeira')");
    await t.sql("alter publication supabase_realtime add table public.b_sujeira");
    await t.sql("create role b_papel_sujo");
    t.igual((await t.sql("select count(*)::int as n from public.membros"))[0].n, 1);
  });

  it("isolamento 2/2: nada do teste anterior aparece", async () => {
    t.igual((await t.sql("select to_regclass('public.b_sujeira')::text as r"))[0].r, null, "tabela");
    t.igual(
      (await t.sql("select count(*)::int as n from auth.users where email = 'base-isolamento@exemplo.test'"))[0].n,
      0,
      "usuário",
    );
    t.igual((await t.sql("select count(*)::int as n from public.membros"))[0].n, 0, "membro");
    t.igual((await t.sql("select count(*)::int as n from storage.buckets where id = 'b_sujeira'"))[0].n, 0, "bucket");
    t.igual((await t.sql("select count(*)::int as n from vault.secrets where name = 'b_sujeira'"))[0].n, 0, "segredo");
    t.igual(
      (
        await t.sql(
          "select count(*)::int as n from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'b_sujeira'",
        )
      )[0].n,
      0,
      "publicação",
    );
    t.igual((await t.sql("select count(*)::int as n from pg_roles where rolname = 'b_papel_sujo'"))[0].n, 0, "papel");
  });
});

// O porte do 00-harness do banco2: o que a imitação do Supabase garante e o que os testes acima
// não cobrem (RLS, privilégios, vault, storage, publicação, t.aplicar e a recusa do PG18). Os
// arquivos SQL de t.aplicar vão numa pasta temporária do sistema.
let PASTA_TMP = "";

describe("banco: o porte do 00-harness", { timeout: TEMPO_TESTE }, () => {
  beforeAll(async () => {
    PASTA_TMP = await mkdtemp(join(tmpdir(), "nina-banco-"));
  });
  afterAll(async () => {
    if (PASTA_TMP) await rm(PASTA_TMP, { recursive: true, force: true });
  });

  it("harness: anon e authenticated não leem tabela com RLS e sem política", async () => {
    await t.sql(`create table public.h_rls (id int primary key, v text);
                 alter table public.h_rls enable row level security;
                 insert into public.h_rls values (1, 'a'), (2, 'b');`);
    t.igual(
      (await t.sql("select count(*)::int as n from public.h_rls"))[0].n,
      2,
      "superusuário vê tudo",
    );
    await t.como("anon", null, async (q) => {
      t.igual((await q("select * from public.h_rls")).length, 0, "anon vê 0 linhas");
      await t.erro(q(`insert into public.h_rls values (3, 'c')`), "row-level security");
    });
    const u = await t.criarUsuario("h-rls@exemplo.test");
    await t.como("authenticated", u, async (q) => {
      t.igual(
        (await q("select * from public.h_rls")).length,
        0,
        "authenticated sem política vê 0 linhas",
      );
      const r = await q(`update public.h_rls set v = 'x' returning id`);
      t.igual(r.length, 0, "update sob RLS atinge 0 linhas sem erro");
    });
    // política para authenticated: só agora enxerga
    await t.sql(`create policy h_le on public.h_rls for select to authenticated using (id = 1)`);
    await t.como("authenticated", u, async (q) => {
      t.igual(
        (await q("select id from public.h_rls")).map((r) => r.id),
        [1],
        "política deixa ver a linha 1",
      );
    });
    await t.como("anon", null, async (q) => {
      t.igual((await q("select * from public.h_rls")).length, 0, "anon continua sem ver");
    });
  });

  it("harness: função com revoke de public e anon bloqueia anon; sem revoke o PUBLIC executa", async () => {
    await t.sql(`
      create function public.h_fechada() returns int language sql security definer set search_path = '' as $$ select 1 $$;
      revoke execute on function public.h_fechada() from public, anon;
      grant execute on function public.h_fechada() to authenticated, service_role;
      create function public.h_aberta() returns int language sql as $$ select 2 $$;
      create function public.h_so_servidor() returns int language sql as $$ select 3 $$;
      revoke execute on function public.h_so_servidor() from public, anon, authenticated;
      grant execute on function public.h_so_servidor() to service_role;
    `);
    await t.como("anon", null, async (q) => {
      await t.erro(q("select public.h_fechada()"), "permission denied");
      await t.erro(q("select public.h_so_servidor()"), "42501");
      t.igual(
        (await q("select public.h_aberta() as v"))[0].v,
        2,
        "sem revoke o anon executa (como no Supabase)",
      );
    });
    const u = await t.criarUsuario("h-fn@exemplo.test");
    await t.como("authenticated", u, async (q) => {
      t.igual((await q("select public.h_fechada() as v"))[0].v, 1);
      await t.erro(q("select public.h_so_servidor()"), "permission denied");
    });
    await t.como("service_role", null, async (q) => {
      t.igual((await q("select public.h_so_servidor() as v"))[0].v, 3);
    });
  });

  it("harness: authenticated com claim enxerga auth.uid(); anon não", async () => {
    const u = await t.criarUsuario("h-uid@exemplo.test", "Fulana");
    await t.como("authenticated", u, async (q) => {
      const [r] = await q(
        "select auth.uid()::text as uid, auth.role() as papel, auth.jwt() ->> 'sub' as sub",
      );
      t.igual(r.uid, u, "auth.uid()");
      t.igual(r.papel, "authenticated", "auth.role()");
      t.igual(r.sub, u, "auth.jwt()->>sub");
    });
    await t.como("anon", null, async (q) => {
      const [r] = await q("select auth.uid() as uid, auth.role() as papel");
      t.igual(r.uid, null, "anon: auth.uid() nulo");
      t.igual(r.papel, "anon");
    });
    // auth.uid() lê request.jwt.claims quando request.jwt.claim.sub está vazio
    await t.como("authenticated", null, async (q) => {
      await q(`select set_config('request.jwt.claim.sub', '', false),
                      set_config('request.jwt.claims', '{"sub":"${u}","role":"authenticated"}', false)`);
      t.igual((await q("select auth.uid()::text as uid"))[0].uid, u, "uid pelo JSON de claims");
    });
    // e os claims não vazam depois do t.como
    t.igual((await t.sql("select auth.uid() as uid"))[0].uid, null, "claims limpos ao sair");
  });

  it("harness: service_role ignora RLS; authenticated não", async () => {
    await t.sql(`create table public.h_srv (id int primary key, v text);
                 alter table public.h_srv enable row level security;
                 insert into public.h_srv values (1, 'a');`);
    await t.como("service_role", null, async (q) => {
      t.igual((await q("select count(*)::int as n from public.h_srv"))[0].n, 1, "service_role lê");
      await q(`insert into public.h_srv values (2, 'b')`);
      const r = await q(`update public.h_srv set v = 'z' returning id`);
      t.igual(r.length, 2, "service_role atualiza as 2 linhas");
    });
    const u = await t.criarUsuario("h-srv@exemplo.test");
    await t.como("authenticated", u, async (q) => {
      t.igual((await q("select * from public.h_srv")).length, 0);
      await t.erro(q(`insert into public.h_srv values (3, 'c')`), "row-level security");
    });
    t.igual((await t.sql("select count(*)::int as n from public.h_srv"))[0].n, 2);
  });

  it("harness: privilégios padrão do public (3 papéis em tabelas, funções e sequências)", async () => {
    await t.sql(
      `create table public.h_priv (id bigint generated always as identity primary key, v text)`,
    );
    for (const papel of ["anon", "authenticated", "service_role"]) {
      const [r] = await t.sql(
        `select has_table_privilege($1, 'public.h_priv', 'select,insert,update,delete') as tab,
                has_sequence_privilege($1, 'public.h_priv_id_seq', 'usage') as seq,
                has_schema_privilege($1, 'public', 'usage') as sch`,
        [papel],
      );
      t.igual(r, { tab: true, seq: true, sch: true }, `privilégios de ${papel}`);
    }
    // ninguém além do dono cria objetos no public (Postgres 15+)
    await t.como("anon", null, async (q) => {
      await t.erro(q("create table public.h_x (id int)"), "permission denied");
    });
  });

  it("harness: criarUsuario insere em auth.users e dispara os gatilhos", async () => {
    await t.sql(`
      create table public.h_log (user_id uuid, email text, nome text);
      create function public.h_ao_criar() returns trigger language plpgsql security definer set search_path = '' as $$
      begin
        insert into public.h_log values (new.id, new.email, new.raw_user_meta_data ->> 'nome');
        return new;
      end $$;
      create trigger h_ao_criar after insert on auth.users for each row execute function public.h_ao_criar();
    `);
    const [{ sp: spAntes }] = await t.sql("select current_setting($1) as sp", ["search_path"]);
    const u = await t.criarUsuario("h-um@exemplo.test", "Fulano");
    t.ok(/^[0-9a-f-]{36}$/.test(u), "devolve uuid");
    const [log] = await t.sql("select * from public.h_log where user_id = $1", [u]);
    t.igual(log.email, "h-um@exemplo.test");
    t.igual(log.nome, "Fulano", "metadados chegam ao gatilho");
    const [usr] = await t.sql(
      "select email_confirmed_at is not null as conf, created_at is not null as cri from auth.users where id = $1",
      [u],
    );
    t.igual(usr, { conf: true, cri: true });
    await t.erro(t.criarUsuario("h-um@exemplo.test"), "23505");
    t.igual(
      (await t.sql("select current_user as u, current_setting($1) as sp", ["search_path"]))[0],
      { u: "postgres", sp: spAntes },
      "criarUsuario volta ao postgres e ao search_path de antes",
    );
    // como no real: quem insere é supabase_auth_admin, com search_path = auth e sem
    // privilégio no public. Gatilho que não é security definer, ou que usa nome sem
    // schema, quebra o cadastro.
    await t.sql(`
      create function public.h_ao_criar_invoker() returns trigger language plpgsql as $$
      begin
        insert into public.h_log values (new.id, new.email, current_user);
        return new;
      end $$;
      create trigger h_ao_criar_invoker after insert on auth.users for each row execute function public.h_ao_criar_invoker();
    `);
    await t.erro(t.criarUsuario("h-dois@exemplo.test"), "permission denied");
    await t.sql("drop trigger h_ao_criar_invoker on auth.users");
    await t.sql(`
      create function public.h_papel() returns trigger language plpgsql as $$
      begin
        perform set_config('h.papel', current_user::text, false);
        return new;
      end $$;
      create trigger h_papel before insert on auth.users for each row execute function public.h_papel();
    `);
    await t.sql(`grant execute on function public.h_papel() to supabase_auth_admin`);
    await t.criarUsuario("h-tres@exemplo.test");
    t.igual(
      (await t.sql(`select current_setting('h.papel') as p`))[0].p,
      "supabase_auth_admin",
      "insere como supabase_auth_admin",
    );
    // authenticated não lê auth.users (como no real)
    await t.como("authenticated", u, async (q) => {
      await t.erro(q("select * from auth.users"), "permission denied");
    });
  });

  it("harness: vault grava, lê, atualiza e apaga; anon e authenticated não chegam lá", async () => {
    const [{ id }] = await t.sql(
      `select vault.create_secret('segredo-1', 'h_nome', 'descrição') as id`,
    );
    t.ok(/^[0-9a-f-]{36}$/.test(id), "create_secret devolve uuid");
    const [lido] = await t.sql(
      "select name, description, decrypted_secret from vault.decrypted_secrets where id = $1",
      [id],
    );
    t.igual(lido, { name: "h_nome", description: "descrição", decrypted_secret: "segredo-1" });
    const [cru] = await t.sql("select secret from vault.secrets where id = $1", [id]);
    t.ok(cru.secret !== "segredo-1", "a coluna secret não guarda o texto claro");

    await t.sql("select vault.update_secret($1, $2)", [id, "segredo-2"]);
    t.igual(
      (
        await t.sql(
          "select decrypted_secret as s, name from vault.decrypted_secrets where id = $1",
          [id],
        )
      )[0],
      { s: "segredo-2", name: "h_nome" },
      "update só do segredo mantém o nome",
    );
    await t.sql(`select vault.update_secret($1, null, 'h_nome2', 'outra')`, [id]);
    t.igual(
      (
        await t.sql(
          "select decrypted_secret as s, name, description as d from vault.decrypted_secrets where id = $1",
          [id],
        )
      )[0],
      { s: "segredo-2", name: "h_nome2", d: "outra" },
    );

    // sem nome (nulo) pode repetir; com nome repetido não
    const [{ a }] = await t.sql(`select vault.create_secret('x') as a`);
    const [{ b }] = await t.sql(`select vault.create_secret('y') as b`);
    t.ok(a !== b, "dois segredos sem nome");
    await t.erro(t.sql(`select vault.create_secret('z', 'h_nome2')`), "23505");

    await t.sql("delete from vault.secrets where id = $1", [id]);
    t.igual(
      (await t.sql("select 1 from vault.decrypted_secrets where id = $1", [id])).length,
      0,
      "apagado",
    );

    const u = await t.criarUsuario("h-vault@exemplo.test");
    for (const [papel, uid] of [
      ["anon", null],
      ["authenticated", u],
    ] as const) {
      await t.como(papel, uid, async (q) => {
        await t.erro(q("select * from vault.decrypted_secrets"), "permission denied");
        await t.erro(q("select * from vault.secrets"), "permission denied");
        await t.erro(q(`select vault.create_secret('hack')`), "permission denied");
        await t.erro(q(`select vault.update_secret('${a}', 'hack')`), "permission denied");
      });
    }
    // função security definer do app (dona: dono_app, o "postgres" do real, que NÃO é
    // superusuário) alcança o vault só pelos privilégios dados a ele
    await t.sql(`set role dono_app;
                 create function public.h_ler(p uuid) returns text language sql security definer set search_path = ''
                 as $$ select decrypted_secret from vault.decrypted_secrets where id = p $$;
                 create function public.h_gravar(v text) returns uuid language sql security definer set search_path = ''
                 as $$ select vault.create_secret(v) $$;
                 create function public.h_apagar(p uuid) returns void language sql security definer set search_path = ''
                 as $$ delete from vault.secrets where id = p $$;
                 create function public.h_inserir_direto() returns void language sql security definer set search_path = ''
                 as $$ insert into vault.secrets (secret) values ('direto') $$;
                 revoke execute on function public.h_ler(uuid), public.h_gravar(text), public.h_apagar(uuid), public.h_inserir_direto() from public, anon;
                 grant execute on function public.h_ler(uuid), public.h_gravar(text), public.h_apagar(uuid), public.h_inserir_direto() to service_role;
                 reset role;`);
    await t.como("service_role", null, async (q) => {
      t.igual((await q("select public.h_ler($1) as s", [a]))[0].s, "x", "definer lê o vault");
      const [{ g }] = await q(`select public.h_gravar('pelo-dono') as g`);
      t.igual(
        (await q("select public.h_ler($1) as s", [g]))[0].s,
        "pelo-dono",
        "definer grava pelo create_secret",
      );
      await q("select public.h_apagar($1)", [g]);
      t.igual((await q("select public.h_ler($1) as s", [g]))[0].s, null, "definer apaga");
      await t.erro(q("select public.h_inserir_direto()"), "permission denied");
    });
  });

  it("harness: storage com RLS, foldername e grant para os três papéis", async () => {
    await t.sql(
      `insert into storage.buckets (id, name, public) values ('h_midias', 'h_midias', false)`,
    );
    t.igual(
      (await t.sql(`select public from storage.buckets where id = 'h_midias'`))[0].public,
      false,
      "privado por padrão",
    );
    t.igual(
      (await t.sql(`select storage.foldername('a/b/c.png') as f`))[0].f,
      ["a", "b"],
      "foldername",
    );
    t.igual(
      (await t.sql(`select storage.foldername('c.png') as f`))[0].f,
      [],
      "foldername sem pasta",
    );
    const [{ rls }] = await t.sql(
      `select relrowsecurity as rls from pg_class where oid = 'storage.objects'::regclass`,
    );
    t.igual(rls, true, "RLS ligada em storage.objects");

    await t.sql(`insert into storage.objects (bucket_id, name) values ('h_midias', 'conv1/msg1')`);
    const u = await t.criarUsuario("h-storage@exemplo.test");
    await t.como("authenticated", u, async (q) => {
      t.igual((await q("select * from storage.objects")).length, 0, "sem política não lê");
      await t.erro(
        q(`insert into storage.objects (bucket_id, name) values ('h_midias', 'conv1/msg2')`),
        "row-level security",
      );
    });
    await t.sql(`create policy h_le_midias on storage.objects for select to authenticated
                 using (bucket_id = 'h_midias' and (storage.foldername(name))[1] = 'conv1')`);
    await t.como("authenticated", u, async (q) => {
      t.igual(
        (await q("select name from storage.objects")).map((r) => r.name),
        ["conv1/msg1"],
      );
    });
    await t.como("anon", null, async (q) => {
      t.igual((await q("select * from storage.objects")).length, 0);
    });
    await t.como("service_role", null, async (q) => {
      await q(`insert into storage.objects (bucket_id, name) values ('h_midias', 'conv1/msg3')`);
      t.igual((await q("select * from storage.objects")).length, 2, "service_role ignora RLS");
    });
    await t.erro(
      t.sql(`insert into storage.objects (bucket_id, name) values ('nao_existe', 'x')`),
      "23503",
    );
  });

  it("harness: extensions tem pgcrypto/uuid-ossp e a publicação supabase_realtime existe vazia", async () => {
    const [pub] = await t.sql(
      `select count(*)::int as n from pg_publication where pubname = 'supabase_realtime'`,
    );
    t.igual(pub.n, 1, "publicação existe");
    // vazia na imitação; com as migrations já tem as tabelas do app, então só contamos as de teste
    const [{ n: antes }] = await t.sql(
      `select count(*)::int as n from pg_publication_tables where pubname = 'supabase_realtime'`,
    );
    const [{ n: tabelas }] = await t.sql(
      `select count(*)::int as n from pg_tables where schemaname = 'public'`,
    );
    if (tabelas === 0) t.igual(antes, 0, "vazia na imitação pura");
    await t.sql(`create table public.h_rt (id int primary key);
                 alter publication supabase_realtime add table public.h_rt;`);
    t.igual(
      (
        await t.sql(
          `select tablename from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'h_rt'`,
        )
      ).map((r) => r.tablename),
      ["h_rt"],
    );
    t.igual(
      (
        await t.sql(
          `select count(*)::int as n from pg_publication_tables where pubname = 'supabase_realtime'`,
        )
      )[0].n,
      antes + 1,
      "só uma a mais",
    );

    t.igual(
      (await t.sql(`select length(extensions.gen_random_bytes(8)) as n`))[0].n,
      8,
      "pgcrypto no schema extensions",
    );
    t.ok(
      /^[0-9a-f-]{36}$/.test((await t.sql(`select extensions.uuid_generate_v4()::text as u`))[0].u),
      "uuid-ossp",
    );
    const [e] = await t.sql(
      `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'extensions'`,
    );
    t.ok(e.n > 0, "funções das extensões estão em extensions");
  });

  it("harness: pg_cron imitado: o dono só lê cron.job; as funções gravam com o usuário de quem chamou", async () => {
    t.igual(await comoDono("select count(*)::int as n from cron.job"), [{ n: 0 }], "lê");
    for (const sql of [
      "insert into cron.job (jobname, schedule, command) values ('x', '* * * * *', 'select 1')",
      "update cron.job set active = false",
      "delete from cron.job",
    ])
      await t.erro(comoDono(sql), "permission denied");
    const [{ id }] = await comoDono("select cron.schedule('x', '* * * * *', 'select 1') as id");
    await comoDono(`select cron.alter_job(job_id := ${Number(id)}, active := false)`);
    t.igual(
      await t.sql("select jobname, username, active from cron.job"),
      [{ jobname: "x", username: "dono_app", active: false }],
      "gravado pelas funções, com o usuário de quem chamou",
    );
    await comoDono("select cron.schedule('x', '*/5 * * * *', 'select 2')");
    t.igual(
      await t.sql("select jobid, schedule, command, active from cron.job"),
      [{ jobid: id, schedule: "*/5 * * * *", command: "select 2", active: false }],
      "o schedule troca o mesmo job sem mexer em active",
    );
    await t.sql(
      "insert into cron.job (jobname, schedule, command, username) values ('y', '* * * * *', 'select 1', 'outro')",
    );
    const [{ y }] = await t.sql("select jobid as y from cron.job where jobname = 'y'");
    await t.erro(
      comoDono(`select cron.alter_job(job_id := ${Number(y)}, active := false)`),
      "you don't own it",
    );
    await comoDono("select cron.unschedule('x')");
    t.igual(await t.sql("select jobname from cron.job"), [{ jobname: "y" }], "unschedule");
  });

  it("harness: pg_net imitado: net.http_post com a assinatura e os padrões do real só grava na fila", async () => {
    const [assinatura] = await t.sql(
      `select pg_get_function_arguments(p.oid) as args, pg_get_function_result(p.oid) as r
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'net' and p.proname = 'http_post'`,
    );
    t.igual(
      assinatura,
      {
        args:
          "url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb, " +
          `headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb, ` +
          "timeout_milliseconds integer DEFAULT 5000",
        r: "bigint",
      },
      "a assinatura e os padrões",
    );
    // só com o endereço: os padrões vão para a fila
    const [{ id }] = await comoDono(
      "select net.http_post(url := 'https://nina-a.exemplo.test/rota') as id",
    );
    t.igual(
      await t.sql(
        "select id, method, url, headers, body, params, timeout_milliseconds from net.http_request_queue",
      ),
      [
        {
          id,
          method: "POST",
          url: "https://nina-a.exemplo.test/rota",
          headers: { "Content-Type": "application/json" },
          body: {},
          params: {},
          timeout_milliseconds: 5000,
        },
      ],
      "o pedido com os padrões, na fila",
    );
    // com tudo dado: grava o que veio, sem misturar com os padrões
    await comoDono(
      `select net.http_post(url := 'https://nina-b.exemplo.test/outra', body := '{"a": 1}'::jsonb,
         headers := '{"x-teste": "1"}'::jsonb, timeout_milliseconds := 60000)`,
    );
    t.igual(
      await t.sql(
        "select headers, body, timeout_milliseconds from net.http_request_queue where id > $1",
        [id],
      ),
      [{ headers: { "x-teste": "1" }, body: { a: 1 }, timeout_milliseconds: 60000 }],
      "o pedido dado",
    );
    // anon e authenticated não leem a fila (só chamam net.http_post)
    for (const papel of ["anon", "authenticated"] as Papel[]) {
      await t.como(papel, null, async (q) => {
        await t.erro(q("select count(*) from net.http_request_queue"), "permission denied");
      });
    }
  });

  it("harness: t.erro, t.ok, t.igual e t.como cumprem o contrato", async () => {
    // t.erro passa quando o erro contém o código
    await t.erro(t.sql(`select 1/0`), "division by zero");
    await t.erro(
      t.sql(`do $$ begin raise exception using message = 'meu_codigo', errcode = 'P0001'; end $$`),
      "meu_codigo",
    );
    await t.erro(
      t.sql(`do $$ begin raise exception using message = 'meu_codigo', errcode = 'P0001'; end $$`),
      "P0001",
    );
    // t.erro falha quando deu certo ou quando o código é outro
    let falhou = false;
    try {
      await t.erro(t.sql("select 1"), "x");
    } catch (e) {
      falhou = /deu certo/.test((e as Error).message);
    }
    t.ok(falhou, "t.erro deve falhar se a promessa der certo");
    falhou = false;
    try {
      await t.erro(t.sql(`select 1/0`), "outro_codigo");
    } catch (e) {
      falhou = /outro_codigo/.test((e as Error).message);
    }
    t.ok(falhou, "t.erro deve falhar se o código for outro");

    // t.ok e t.igual
    falhou = false;
    try {
      t.ok(false, "minha msg");
    } catch (e) {
      falhou = (e as Error).message === "minha msg";
    }
    t.ok(falhou, "t.ok lança a mensagem");
    t.igual({ a: [1, 2], b: "x" }, { a: [1, 2], b: "x" });
    falhou = false;
    try {
      t.igual(1, 2, "números");
    } catch (e) {
      falhou = (e as Error).message.startsWith("números");
    }
    t.ok(falhou, "t.igual lança com a mensagem");

    // t.como: volta ao postgres e limpa os claims mesmo quando a função lança
    const u = await t.criarUsuario("h-como@exemplo.test");
    await t.erro(
      t.como("authenticated", u, async (q) => {
        await q("select 1");
        throw new Error("estouro_no_teste");
      }),
      "estouro_no_teste",
    );
    t.igual(
      (await t.sql("select current_user as u"))[0].u,
      "postgres",
      "voltou ao postgres após erro",
    );
    t.igual((await t.sql("select auth.uid() as uid"))[0].uid, null, "claims limpos após erro");

    // erro de SQL dentro de t.como e transação aberta e abortada dentro dele
    await t.erro(
      t.como("authenticated", u, async (q) => {
        await q("begin");
        await q("select 1/0");
      }),
      "division by zero",
    );
    t.igual(
      (await t.sql("select current_user as u"))[0].u,
      "postgres",
      "voltou ao postgres após transação abortada",
    );
    t.igual((await t.sql("select 1 as x"))[0].x, 1, "conexão utilizável");

    // papel inválido
    await t.erro(
      t.como("postgres" as Papel, null, async () => {}),
      "papel inválido",
    );

    // t.sql com vários comandos (sem parâmetros) e com parâmetros
    t.igual(
      (
        await t.sql(
          `create table public.h_p (n int); insert into public.h_p values (1),(2); select sum(n)::int as s from public.h_p`,
        )
      )[0].s,
      3,
      "vários comandos",
    );
    t.igual((await t.sql("select $1::int + $2::int as s", [2, 3]))[0].s, 5, "com parâmetros");
    t.igual((await t.sql("select count(*) as n from public.h_p"))[0].n, 2, "count vem como número");
  });

  it("harness: t.aplicar roda o arquivo tirando create extension de pgcrypto e uuid-ossp; supabase_vault quebra", async () => {
    const arqCofre = join(PASTA_TMP, `_harness-cofre-${process.pid}.sql`);
    await writeFile(
      arqCofre,
      "  CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;\n",
    );
    try {
      await t.erro(t.aplicar(arqCofre), "supabase_vault");
    } finally {
      await rm(arqCofre, { force: true });
    }
    const arq = join(PASTA_TMP, `_harness-aplicar-${process.pid}.sql`);
    const conteudo = [
      "-- create extension pgcrypto (comentário sem ponto e vírgula, não pode comer o código)",
      "create table public.h_ap (id int primary key);",
      "create extension if not exists pgcrypto with schema extensions;",
      'create extension if not exists "uuid-ossp";',
      "insert into public.h_ap values (1) on conflict (id) do nothing;",
    ].join("\n");
    await writeFile(arq, conteudo);
    try {
      await t.aplicar(arq);
      await t.aplicar(arq); // repetível: create table falha na 2ª vez
    } catch (e) {
      // a 2ª aplicação falha porque a tabela já existe; a 1ª tem de ter passado
      const m = (e as Error).message;
      t.ok(/already exists/.test(m), `erro inesperado: ${m}`);
    } finally {
      await rm(arq, { force: true });
    }
    t.igual(
      (await t.sql("select count(*)::int as n from public.h_ap"))[0].n,
      1,
      "primeira aplicação valeu",
    );
    await t.erro(t.aplicar("nao-existe.sql"), "não existe");
  });

  it("harness: as migrations são aplicadas por dono_app, que não é superusuário (como o postgres do real)", async () => {
    const [d] = await t.sql(
      `select rolsuper, rolbypassrls, rolcreaterole from pg_roles where rolname = 'dono_app'`,
    );
    t.igual(
      d,
      { rolsuper: false, rolbypassrls: true, rolcreaterole: true },
      "atributos de dono_app",
    );
    const [{ n: tabelas }] = await t.sql(
      `select count(*)::int as n from pg_tables where schemaname = 'public'`,
    );
    if (tabelas > 0) {
      const donos = await t.sql(
        `select distinct pg_get_userbyid(c.relowner) as dono from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind in ('r', 'S', 'v')
         union
         select distinct pg_get_userbyid(p.proowner) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'`,
      );
      t.igual(
        donos.map((x) => x.dono),
        ["dono_app"],
        "dono de tabelas e funções do public",
      );
      const [pub] = await t.sql(
        `select pg_get_userbyid(pubowner) as dono from pg_publication where pubname = 'supabase_realtime'`,
      );
      t.igual(pub.dono, "dono_app", "dono da publicação");
    }
    // superusuário passaria; dono_app não insere direto no vault nem lê auth.users de outro jeito
    await t.erro(
      t.sql(`set role dono_app; insert into vault.secrets (secret) values ('x')`),
      "permission denied",
    );
    await t.sql("reset role");
    t.igual((await t.sql("select current_user as u"))[0].u, "postgres");
  });

  it("harness: recusa SQL que só existe no PostgreSQL 18", async () => {
    const casos = [
      ["create table public.h_g1 (a int, b int generated always as (a * 2));", true],
      ["create table public.h_g2 (a int, b int generated always as (a * 2) virtual);", true],
      [
        "create table public.h_g3 (a text, b boolean generated always as (a in ('x', 'y')) stored);",
        false,
      ],
      ["create table public.h_g4 (id bigint generated always as identity primary key);", false],
      ["create table public.h_g5 (id uuid default uuidv7());", true],
      ["create table public.h_g6 (a int, check (a > 0) not enforced);", true],
    ];
    for (const [i, [sql, recusa]] of casos.entries()) {
      const arq = join(PASTA_TMP, `_harness-pg18-${process.pid}-${i}.sql`);
      await writeFile(arq, `-- generated always as (x) virtual num comentário não conta\n${sql}\n`);
      try {
        if (recusa) await t.erro(t.aplicar(arq), "PostgreSQL 18");
        else await t.aplicar(arq);
      } finally {
        await rm(arq, { force: true });
      }
    }
  });
});
