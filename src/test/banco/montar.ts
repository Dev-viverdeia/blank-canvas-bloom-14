// Base dos testes do banco da Nina: o PGlite (o Postgres dentro do Node) com a imitação do
// Supabase e o SQL do banco guardado no repositório.
//
// Banco-base, montado nesta ordem:
//   1. src/test/banco/supabase-imitacao.sql, como superusuário (postgres);
//   2. src/test/banco/base/NNNN_*.sql, em ordem de nome, como dono_app (o "postgres" do Supabase
//      real, que não é superusuário). É a história inteira do banco: o remix do Lovable copia a
//      estrutura mas apaga os arquivos de drizzle/migrations, e esta pasta é código comum, que vai
//      junto na cópia. Os `create extension pgcrypto|uuid-ossp|pg_cron|pg_net` saem antes (a
//      imitação já instala as duas primeiras e imita as duas últimas, schemas cron e net);
//      `supabase_vault` fica, para a montagem quebrar se alguém tentar criar o cofre;
//   3. drizzle/migrations/NNNN_*.sql (as que o agente do Lovable gravou neste projeto) que ainda
//      não têm cópia igual na base, em ordem de nome, também como dono_app. Toda migration do
//      Lovable é copiada para a base com o próximo número; o teste de base.test.ts cobra;
//   4. os arquivos da variável NINA_SQL_EXTRA (caminhos absolutos separados por vírgula), na
//      ordem dada, também como dono_app. Serve para testar um SQL antes de ele virar migration.
// Cada arquivo é um exec separado (uma transação implícita por arquivo): um valor de enum criado
// num arquivo já pode ser usado no seguinte.
//
// Uso num arquivo de teste (que precisa de `// @vitest-environment node` na 1ª linha):
//   const base = await montarBase();          // uma vez por arquivo (dumpDataDir)
//   const t = usarBanco(base);                // banco novo por teste (loadDataDir)
//   it("...", async () => { await t.sql("select 1"); });
//
// Tipos que o PGlite devolve: int2/int4/int8 -> number; numeric -> string; boolean -> boolean;
// date/timestamp/timestamptz -> Date; json/jsonb -> objeto; uuid/text -> string; arrays -> array.
// O PGlite 0.5.10 é o PostgreSQL 18 e o banco real é o 17: o SQL aplicado é conferido contra o
// que só existe no 18 (conferirPg17).
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { afterEach, beforeEach } from "vitest";

/** A raiz do repositório (este arquivo fica em src/test/banco/). */
export const RAIZ = fileURLToPath(new URL("../../../", import.meta.url));
/** O SQL do banco que vai junto no remix (a história inteira, em ordem de nome). */
export const PASTA_BASE = join(RAIZ, "src", "test", "banco", "base");
/** As migrations que o agente do Lovable gravou neste projeto (o remix apaga estes arquivos). */
export const PASTA_MIGRATIONS = join(RAIZ, "drizzle", "migrations");
export const ARQ_IMITACAO = join(RAIZ, "src", "test", "banco", "supabase-imitacao.sql");

/** Tempo máximo de um teste do banco (cada um carrega uma cópia do banco-base). */
export const TEMPO_TESTE = 60_000;

const EXTENSOES = { pgcrypto, uuid_ossp };

function novoPg(opcoes: { loadDataDir?: Blob | File } = {}): PGlite {
  return new PGlite({ extensions: EXTENSOES, ...opcoes });
}

// ---------------------------------------------------------------------------
// Limpeza e conferência do SQL
// ---------------------------------------------------------------------------

// Tira os `create extension ... pgcrypto|uuid-ossp|pg_cron|pg_net ...;` (a imitação já cobre:
// as duas primeiras de verdade, as duas últimas imitadas em supabase-imitacao.sql). Só casa no
// começo da linha, para não comer código por causa de um comentário. Troca por espaços, para
// a linha de um erro continuar certa.
const RE_EXTENSAO =
  /^[ \t]*create[ \t]+extension[ \t]+(?:if[ \t]+not[ \t]+exists[ \t]+)?"?(?:pgcrypto|uuid-ossp|pg_cron|pg_net)"?(?=[\s;"])[^;]*;/gim;

export function limparSql(texto: string): string {
  return texto.replace(RE_EXTENSAO, (m) => m.replace(/[^\n]/g, " "));
}

function semComentarios(texto: string): string {
  return texto.replace(/--[^\n]*/g, (m) => " ".repeat(m.length));
}

// Coluna gerada sem STORED (no 18 vira VIRTUAL por padrão; no 17 não existe).
function geradaSemStored(texto: string): string | null {
  const re = /generated\s+always\s+as\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto))) {
    let i = re.lastIndex;
    let nivel = 1;
    let aspas = false;
    while (i < texto.length && nivel > 0) {
      const c = texto[i];
      if (c === "'") aspas = !aspas;
      else if (!aspas && c === "(") nivel++;
      else if (!aspas && c === ")") nivel--;
      i++;
    }
    if (!/^\s*stored\b/i.test(texto.slice(i))) {
      return texto.slice(m.index, Math.min(i + 20, texto.length));
    }
  }
  return null;
}

const SO_NO_18: [RegExp, string][] = [
  [/\buuidv7\s*\(/i, "uuidv7()"],
  [/\breturning\s+(old|new)\./i, "OLD/NEW no RETURNING"],
  [/\bnot\s+enforced\b/i, "NOT ENFORCED"],
  [/\bwithout\s+overlaps\b/i, "WITHOUT OVERLAPS"],
];

/** Recusa o que só existe no PostgreSQL 18 (o banco real é o 17). */
export function conferirPg17(texto: string): void {
  const limpo = semComentarios(texto);
  const g = geradaSemStored(limpo);
  if (g) throw new Error(`só existe no PostgreSQL 18 (coluna gerada sem STORED): ${g.replace(/\s+/g, " ")}`);
  for (const [re, nome] of SO_NO_18) {
    if (re.test(limpo)) throw new Error(`só existe no PostgreSQL 18 (${nome})`);
  }
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

/** Uma linha devolvida pelo banco (any de propósito: os testes leem as colunas pelo nome). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Linha = any;

type ErroPg = Error & { code?: string; detail?: string; hint?: string; position?: string | number };

// Com params usa o protocolo estendido (um comando só); sem params usa exec (vários comandos)
// e devolve as linhas do último comando.
async function executar(db: PGlite, texto: string, params?: unknown[] | null): Promise<Linha[]> {
  if (params !== undefined && params !== null) {
    return (await db.query<Linha>(texto, params)).rows;
  }
  const resultados = await db.exec(texto);
  const ultimo = resultados[resultados.length - 1];
  return ultimo ? (ultimo.rows as Linha[]) : [];
}

function linhaDoErro(texto: string, e: ErroPg): string {
  const pos = Number(e.position);
  if (!pos) return "";
  return ` (linha ${texto.slice(0, pos).split("\n").length})`;
}

export function msgErro(e: unknown): string {
  const x = e as ErroPg;
  const base = x && x.message ? x.message : String(e);
  const extra: string[] = [];
  if (x && x.code && /^[0-9A-Z]{5}$/.test(x.code)) extra.push(`sqlstate ${x.code}`);
  if (x && x.detail) extra.push(`detalhe: ${x.detail}`);
  if (x && x.hint) extra.push(`dica: ${x.hint}`);
  return (base + (extra.length ? ` [${extra.join("; ")}]` : "")).replace(/\s*\n\s*/g, " ");
}

/**
 * Aplica um arquivo SQL. comoDono = true roda com "set role dono_app" (como a migration roda no
 * Lovable). limpar = true tira os create extension e confere o PostgreSQL 17.
 */
export async function aplicarArquivo(db: PGlite, arquivo: string, limpar = true, comoDono = false): Promise<void> {
  const bruto = await readFile(arquivo, "utf8");
  const texto = limpar ? limparSql(bruto) : bruto;
  if (limpar) conferirPg17(texto);
  if (comoDono) await db.exec("set role dono_app");
  try {
    await db.exec(texto);
  } catch (e) {
    const x = e as ErroPg;
    x.message = `${x.message}${linhaDoErro(texto, x)}`;
    if (comoDono) {
      try {
        await db.exec("rollback");
      } catch {
        /* sem transação */
      }
    }
    throw x;
  } finally {
    if (comoDono) await db.exec("reset role");
  }
}

async function sqlDaPasta(pasta: string): Promise<string[]> {
  if (!existsSync(pasta)) return [];
  return (await readdir(pasta))
    .filter((f) => /^[0-9]{4}_.*\.sql$/.test(f))
    .sort()
    .map((f) => join(pasta, f));
}

// Igual para a comparação: o mesmo texto, sem contar o fim de linha do Windows nem o espaço do fim.
async function textoDe(arquivo: string): Promise<string> {
  return (await readFile(arquivo, "utf8")).replace(/\r\n/g, "\n").trimEnd();
}

/** A base (src/test/banco/base), em ordem de nome. */
export async function arquivosBase(): Promise<string[]> {
  return sqlDaPasta(PASTA_BASE);
}

/** As migrations do Lovable (drizzle/migrations) que ainda não têm cópia igual na base. */
export async function migrationsSemCopia(): Promise<string[]> {
  const naBase = new Set(await Promise.all((await arquivosBase()).map(textoDe)));
  const fora: string[] = [];
  for (const arq of await sqlDaPasta(PASTA_MIGRATIONS)) {
    if (!naBase.has(await textoDe(arq))) fora.push(arq);
  }
  return fora;
}

/** O SQL do banco, em ordem: a base e, depois, as migrations do Lovable ainda sem cópia nela. */
export async function arquivosMigrations(): Promise<string[]> {
  const lista = [...(await arquivosBase()), ...(await migrationsSemCopia())];
  if (lista.length === 0) throw new Error(`nenhum SQL em ${PASTA_BASE} nem em ${PASTA_MIGRATIONS}`);
  return lista;
}

/** Os arquivos de NINA_SQL_EXTRA (caminhos absolutos, separados por vírgula), na ordem dada. */
export function arquivosExtra(valor = process.env["NINA_SQL_EXTRA"]): string[] {
  const lista = (valor ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const arq of lista) {
    if (!isAbsolute(arq)) throw new Error(`NINA_SQL_EXTRA: o caminho precisa ser absoluto: ${arq}`);
    if (!existsSync(arq)) throw new Error(`NINA_SQL_EXTRA: arquivo não existe: ${arq}`);
  }
  return lista;
}

// ---------------------------------------------------------------------------
// Banco-base
// ---------------------------------------------------------------------------

export interface Base {
  /** A cópia do banco montado (dumpDataDir), carregada em cada teste. */
  dump: Blob;
  /** Os nomes dos arquivos aplicados depois da imitação, em ordem. */
  aplicados: string[];
  /** Os valores de cada enum do schema public no banco montado. */
  enums: Record<string, string[]>;
  /** Os nomes das funções do schema public no banco montado (sem repetir, em ordem). */
  funcoes: string[];
}

export interface OpcoesBase {
  /** "imitacao": só a imitação; "completo" (padrão): imitação + migrations + NINA_SQL_EXTRA. */
  modo?: "imitacao" | "completo";
  /**
   * Para parar antes de uma migration: só os arquivos da base que o filtro aceitar (pelo nome).
   * As migrations do Lovable ainda sem cópia na base são mais novas que a base toda e ficam fora.
   */
  filtroMigrations?: (nome: string) => boolean;
  /** Sem os arquivos de NINA_SQL_EXTRA. */
  semExtra?: boolean;
}

/** Monta o banco-base e devolve a cópia dele. Chame uma vez por arquivo de teste. */
export async function montarBase(opcoes: OpcoesBase = {}): Promise<Base> {
  const modo = opcoes.modo ?? "completo";
  const db = novoPg();
  await db.waitReady;
  const aplicados: string[] = [];
  try {
    try {
      // a imitação instala pgcrypto e uuid-ossp de verdade, por isso não é limpa
      await aplicarArquivo(db, ARQ_IMITACAO, false);
    } catch (e) {
      throw new Error(`supabase-imitacao.sql: ${msgErro(e)}`);
    }
    if (modo === "completo") {
      let arquivos: string[];
      if (opcoes.filtroMigrations) {
        const filtro = opcoes.filtroMigrations;
        arquivos = (await arquivosBase()).filter((a) => filtro(basename(a)));
      } else {
        arquivos = await arquivosMigrations();
      }
      if (!opcoes.semExtra) arquivos = [...arquivos, ...arquivosExtra()];
      for (const arq of arquivos) {
        try {
          await aplicarArquivo(db, arq, true, true);
        } catch (e) {
          throw new Error(`${basename(arq)}: ${msgErro(e)}`);
        }
        aplicados.push(basename(arq));
      }
    }
    const enums: Record<string, string[]> = {};
    const linhas = await executar(
      db,
      `select t.typname as tipo, e.enumlabel as valor
         from pg_enum e
         join pg_type t on t.oid = e.enumtypid
         join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'public'
        order by t.typname, e.enumsortorder`,
    );
    for (const l of linhas) (enums[l.tipo] ??= []).push(l.valor);
    const funcoes = (
      await executar(
        db,
        `select distinct p.proname as nome
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
          order by 1`,
      )
    ).map((l) => l.nome as string);
    await db.exec("checkpoint");
    const dump = await db.dumpDataDir("none");
    return { dump, aplicados, enums, funcoes };
  } finally {
    await db.close();
  }
}

/** Se o enum public.<tipo> tem o valor no banco-base. */
export function temValorEnum(base: Base, tipo: string, valor: string): boolean {
  return (base.enums[tipo] ?? []).includes(valor);
}

/** Se a função public.<nome> existe no banco-base (qualquer assinatura). */
export function temFuncao(base: Base, nome: string): boolean {
  return base.funcoes.includes(nome);
}

// ---------------------------------------------------------------------------
// Ajudantes de cada teste
// ---------------------------------------------------------------------------

export type Papel = "anon" | "authenticated" | "service_role";
export type Consulta = (texto: string, params?: unknown[]) => Promise<Linha[]>;

export interface Banco {
  /** O PGlite cru do teste atual. */
  readonly db: PGlite;
  /** Como superusuário (postgres). Com params, um comando só; sem params, vários. */
  sql: Consulta;
  /**
   * Roda fn com `set role <papel>` e os claims do JWT do userId (ou sem usuário). Volta ao
   * superusuário no fim, mesmo com erro (e faz rollback se havia transação aberta).
   */
  como: <T>(papel: Papel, userId: string | null, fn: (q: Consulta) => Promise<T>) => Promise<T>;
  /** Insere em auth.users como o Supabase faz (dispara os gatilhos). Devolve o id. */
  criarUsuario: (email: string, nome?: string) => Promise<string>;
  /** Passa se a promessa falhar com mensagem, sqlstate, detalhe ou dica que contém o código. */
  erro: (promessa: Promise<unknown>, codigo: string) => Promise<Error>;
  /** Comparação profunda e estrita, com mensagem clara. */
  igual: (a: unknown, b: unknown, msg?: string) => void;
  /** Falha se a condição for falsa. */
  ok: (cond: unknown, msg?: string) => void;
  /** Aplica um arquivo SQL como dono_app (caminho absoluto ou relativo à raiz do repositório). */
  aplicar: (arquivo: string) => Promise<void>;
}

const PAPEIS = new Set<Papel>(["anon", "authenticated", "service_role"]);

function fmt(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));
  } catch {
    return String(v);
  }
}

/**
 * Liga um banco novo a cada teste (loadDataDir da cópia) e fecha no fim. Chame no corpo do
 * arquivo (ou de um describe); os ajudantes devolvidos usam sempre o banco do teste atual.
 */
export function usarBanco(base: Base): Banco {
  let atual: PGlite | null = null;

  beforeEach(async () => {
    atual = novoPg({ loadDataDir: base.dump });
    await atual.waitReady;
  }, TEMPO_TESTE);

  afterEach(async () => {
    const db = atual;
    atual = null;
    if (db) {
      try {
        await db.close();
      } catch {
        /* ignora */
      }
    }
  }, TEMPO_TESTE);

  const db = (): PGlite => {
    if (!atual) throw new Error("banco do teste não está aberto (use os ajudantes dentro de um teste)");
    return atual;
  };

  const banco: Banco = {
    get db() {
      return db();
    },

    sql: (texto, params) => executar(db(), texto, params),

    como: async (papel, userId, fn) => {
      if (!PAPEIS.has(papel)) throw new Error(`papel inválido em como: ${String(papel)}`);
      const d = db();
      const claims = JSON.stringify({
        role: papel,
        ...(userId ? { sub: String(userId), aud: "authenticated" } : {}),
      });
      let falhou = false;
      try {
        await d.query(
          `select set_config('request.jwt.claim.sub', $1, false),
                  set_config('request.jwt.claim.role', $2, false),
                  set_config('request.jwt.claims', $3, false)`,
          [userId ? String(userId) : "", papel, claims],
        );
        await d.exec(`set role ${papel}`);
        const q: Consulta = (texto, params) => executar(d, texto, params);
        return await fn(q);
      } catch (e) {
        falhou = true;
        throw e;
      } finally {
        if (falhou) {
          try {
            await d.exec("rollback");
          } catch {
            /* sem transação */
          }
        }
        await d.exec("reset role");
        await d.exec(
          `select set_config('request.jwt.claim.sub', '', false),
                  set_config('request.jwt.claim.role', '', false),
                  set_config('request.jwt.claims', '', false)`,
        );
      }
    },

    // papel supabase_auth_admin (sem privilégio no public) e search_path = auth, como o
    // cadastro do Supabase: os gatilhos de auth.users rodam como no real.
    criarUsuario: async (email, nome) => {
      const d = db();
      const meta = nome ? { nome, name: nome } : {};
      await d.exec("set role supabase_auth_admin; set search_path = auth");
      try {
        const r = await d.query<{ id: string }>(
          `insert into users (email, raw_user_meta_data, email_confirmed_at)
           values ($1, $2::jsonb, now()) returning id`,
          [email, JSON.stringify(meta)],
        );
        const id = r.rows[0]?.id;
        if (!id) throw new Error("criarUsuario: o insert não devolveu o id");
        return id;
      } finally {
        await d.exec("reset role; reset search_path");
      }
    },

    erro: async (promessa, codigo) => {
      let falha: ErroPg | null = null;
      try {
        await promessa;
      } catch (e) {
        falha = e as ErroPg;
      }
      if (!falha) throw new Error(`esperava o erro '${codigo}', mas deu certo`);
      const texto = [falha.message, falha.code, falha.detail, falha.hint].filter(Boolean).join(" | ");
      if (!texto.includes(codigo)) throw new Error(`esperava o erro '${codigo}', veio: ${msgErro(falha)}`);
      return falha;
    },

    igual: (a, b, msg) => {
      if (!isDeepStrictEqual(a, b)) {
        throw new Error(`${msg ? msg + ": " : ""}veio ${fmt(a)}, esperava ${fmt(b)}`);
      }
    },

    ok: (cond, msg) => {
      if (!cond) throw new Error(msg || "condição falsa");
    },

    aplicar: async (arquivo) => {
      const caminho = isAbsolute(arquivo) ? arquivo : join(RAIZ, arquivo);
      if (!existsSync(caminho)) throw new Error(`arquivo não existe: ${arquivo}`);
      await aplicarArquivo(db(), caminho, true, true);
    },
  };
  return banco;
}
