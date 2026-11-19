// @vitest-environment node
// A cópia do remix se prepara sozinha (seção 2, envio M2
// nina_copia_sozinha): preparar_copia() e o relógio manutencao_nina(), sobre a imitação do pg_cron
// de supabase-imitacao.sql (cron.schedule grava em cron.job; nada roda sozinho). Troca o teste do
// pacote manual que preparar_copia substitui.
// No remix de teste de 03/11/2026 a cópia recebeu só a estrutura do banco: nenhuma linha nas
// tabelas, nenhum gatilho em auth.users, a publicação do tempo real vazia e nenhum agendamento. A
// cópia imitada é o banco das migrations com esses quatro apagados. Depois de preparar_copia, ela
// tem de ficar igual ao original depois da mesma chamada: as mesmas linhas em cada tabela de public
// (sem as colunas que o banco preenche sozinho), os mesmos gatilhos em auth.users, as mesmas tabelas
// no tempo real e o mesmo relógio. Migration nova com dado inicial que preparar_copia não semear
// faz este teste falhar dizendo a tabela.
// Até os envios M1 (nina_motor_acordado) e M2 virarem migrations, os testes pulam, salvo com os
// arquivos em NINA_SQL_EXTRA.
import { basename, join } from "node:path";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";
import {
  arquivosExtra,
  arquivosMigrations,
  montarBase,
  PASTA_BASE,
  temFuncao,
  TEMPO_TESTE,
  usarBanco,
  type Banco,
  type Linha,
} from "./montar";

const base = await montarBase();

const migrations = await arquivosMigrations();
const extras = arquivosExtra();
const acharArquivo = (parte: string) =>
  migrations.find((a) => basename(a).includes(parte)) ??
  extras.find((a) => basename(a).includes(parte));
const arqM1 = acharArquivo("nina_motor_acordado");
const arqM2 = acharArquivo("nina_copia_sozinha");
const comEnvios = !!arqM1 && !!arqM2;

const RELOGIO = {
  jobname: "nina-relogio",
  schedule: "17 * * * *",
  command: "select public.manutencao_nina()",
};
// O relógio dos retornos (nina_retornos_relogio): o 2º job, que a
// preparar_copia instala junto do nina-relogio depois desse envio.
const RELOGIO_RETORNOS = {
  jobname: "nina-retornos",
  schedule: "* * * * *",
  command: "select public.relogio_retornos()",
};

// ---------------------------------------------------------------------------
// ajudantes
// ---------------------------------------------------------------------------

async function preparar(t: Banco): Promise<string> {
  const [r] = await t.como("service_role", null, (q) =>
    q("select public.preparar_copia() as r", []),
  );
  return r.r as string;
}

/** Roda um SQL como o dono das funções do app (o "postgres" do real, como o cron roda). */
async function comoDono(t: Banco, texto: string) {
  await t.sql("set role dono_app");
  try {
    return await t.sql(texto);
  } finally {
    await t.sql("reset role");
  }
}

async function relogios(t: Banco) {
  return t.sql("select jobname, schedule, command, username, active from cron.job order by jobid");
}

/**
 * Os jobs que a preparar_copia em vigor instala, ativos e do dono: o nina-relogio e, com o
 * nina_retornos_relogio, também o nina-retornos. Decide pelo texto da função em vigor (e não pela
 * relogio_retornos, que chega no nina_retornos_funcoes): entre o nina_retornos_funcoes e o
 * nina_retornos_relogio, a preparar_copia ainda instala um job só, e o teste continua verde nos
 * dois estados.
 */
async function jobsEsperados(t: Banco): Promise<Linha[]> {
  const [{ tem }] = await t.sql(
    `select position('nina-retornos' in p.prosrc) > 0 as tem
       from pg_catalog.pg_proc p where p.oid = 'public.preparar_copia()'::regprocedure`,
  );
  return (tem ? [RELOGIO, RELOGIO_RETORNOS] : [RELOGIO]).map((j) => ({
    ...j,
    username: "dono_app",
    active: true,
  }));
}

async function linhaMotor(t: Banco) {
  return t.sql("select url, preparada_em, relogio_em from public.motor");
}

async function etapas(t: Banco): Promise<string[]> {
  return (await t.sql("select chave from public.etapas order by ordem")).map(
    (l: Linha) => l.chave as string,
  );
}

interface Retrato {
  /** As linhas de cada tabela de public, sem as colunas que o banco preenche sozinho. */
  linhas: Record<string, Linha[]>;
  gatilhosAuth: string[];
  tempoReal: string[];
  relogio: Linha[];
}

// Coluna cujo padrão muda de um banco para o outro (id sorteado, chave sorteada, hora de agora,
// sequência): fica fora da comparação.
const RE_PADRAO_VARIAVEL =
  /now\(\)|gen_random_uuid|gen_random_bytes|uuid_generate|nextval|clock_timestamp|random\(\)/i;
// Os momentos da linha do motor (gravados por preparar_copia, sem padrão) também ficam fora; o
// teste confere que existem.
const MOMENTOS_DO_MOTOR = ["url_em", "tocado_em", "preparada_em", "relogio_em"];

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function retratar(t: Banco): Promise<Retrato> {
  const tabelas = (
    await t.sql(
      `select tablename as nome from pg_catalog.pg_tables where schemaname = 'public' order by 1`,
    )
  ).map((l: Linha) => l.nome as string);
  const colunas = await t.sql(
    `select table_name as tabela, column_name as coluna, column_default as padrao
       from information_schema.columns where table_schema = 'public'`,
  );
  const linhas: Record<string, Linha[]> = {};
  for (const tabela of tabelas) {
    const fora = colunas
      .filter(
        (c: Linha) =>
          c.tabela === tabela &&
          ((c.padrao && RE_PADRAO_VARIAVEL.test(c.padrao)) ||
            (tabela === "motor" && MOMENTOS_DO_MOTOR.includes(c.coluna))),
      )
      .map((c: Linha) => literal(c.coluna as string));
    const [r] = await t.sql(
      `select coalesce(jsonb_agg(x order by x::text), '[]'::jsonb) as linhas
         from (select to_jsonb(t) - array[${fora.join(", ")}]::text[] as x
                 from public.${ident(tabela)} t) s`,
    );
    linhas[tabela] = r.linhas;
  }
  const gatilhosAuth = (
    await t.sql(
      `select tgname as nome from pg_catalog.pg_trigger
        where tgrelid = 'auth.users'::regclass and not tgisinternal order by 1`,
    )
  ).map((l: Linha) => l.nome as string);
  const tempoReal = (
    await t.sql(
      `select schemaname || '.' || tablename as nome from pg_catalog.pg_publication_tables
        where pubname = 'supabase_realtime' order by 1`,
    )
  ).map((l: Linha) => l.nome as string);
  return { linhas, gatilhosAuth, tempoReal, relogio: await relogios(t) };
}

// O que o remix de teste trouxe: a estrutura, sem as linhas, sem os gatilhos em auth.users, sem as
// tabelas do tempo real e sem agendamento.
async function virarCopia(t: Banco): Promise<void> {
  await t.sql(`
    do $$
    declare
      r record;
    begin
      for r in select tablename from pg_catalog.pg_tables where schemaname = 'public' loop
        execute format('truncate table public.%I cascade', r.tablename);
      end loop;
      for r in select tgname from pg_catalog.pg_trigger
                where tgrelid = 'auth.users'::regclass and not tgisinternal loop
        execute format('drop trigger %I on auth.users', r.tgname);
      end loop;
      for r in select schemaname, tablename from pg_catalog.pg_publication_tables
                where pubname = 'supabase_realtime' loop
        execute format('alter publication supabase_realtime drop table %I.%I', r.schemaname, r.tablename);
      end loop;
      delete from cron.job;
    end;
    $$;
  `);
}

function conferirIgual(t: Banco, copia: Retrato, original: Retrato, quando: string): void {
  t.igual(Object.keys(copia.linhas), Object.keys(original.linhas), `${quando}: tabelas`);
  for (const tabela of Object.keys(original.linhas)) {
    t.igual(copia.linhas[tabela], original.linhas[tabela], `${quando}: linhas de ${tabela}`);
  }
  t.igual(copia.gatilhosAuth, original.gatilhosAuth, `${quando}: gatilhos em auth.users`);
  t.igual(copia.tempoReal, original.tempoReal, `${quando}: tabelas no tempo real`);
  t.igual(copia.relogio, original.relogio, `${quando}: relógio`);
}

/** Os comandos de dado (insert) de um arquivo SQL, sem comentários e com os espaços juntados. */
function insertsDe(texto: string): string[] {
  const limpo = texto.replace(/--[^\n]*/g, " ");
  return (limpo.match(/insert\s+into\s+public\.[a-z_]+[\s\S]*?do\s+nothing\s*;/gi) ?? []).map((s) =>
    s.replace(/\s+/g, " ").trim(),
  );
}

// asserções fora de um banco (só comparam valores)
const t0 = {
  igual: (a: unknown, b: unknown, msg: string) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${msg}: veio ${JSON.stringify(a)}, esperava ${JSON.stringify(b)}`);
  },
};

// ---------------------------------------------------------------------------

describe("banco: preparar_copia (montagem)", () => {
  it("o arquivo nina_copia_sozinha e as funções vêm juntos, ou nenhum dos dois", () => {
    const tem = ["preparar_copia", "manutencao_nina"].map((f) => temFuncao(base, f));
    if (arqM2) t0.igual(tem, [true, true], "funções da cópia");
    else t0.igual(tem, [false, false], "sem o envio, nenhuma função da cópia");
  });
});

describe.skipIf(!comEnvios)("banco: preparar_copia (o texto do envio M2)", () => {
  it("liga o pg_cron antes de tudo, não chama a internet e não lê cron.job", async () => {
    const bruto = await readFile(arqM2 ?? "", "utf8");
    const texto = bruto.replace(/--[^\n]*/g, "");
    t0.igual(
      /^\s*create\s+extension\s+if\s+not\s+exists\s+pg_cron\b[^;]*;/im.test(texto),
      true,
      "create extension if not exists pg_cron",
    );
    t0.igual(
      texto.search(/create\s+extension\s+if\s+not\s+exists\s+pg_cron/i) <
        texto.search(/create\s+or\s+replace\s+function/i),
      true,
      "a extensão vem antes das funções",
    );
    // o texto inteiro, com os comentários: a recusa de 03/11 veio com cron e net.http_post juntos
    t0.igual(/net\.http_post/i.test(bruto), false, "nenhum net.http_post no M2");
    t0.igual(/\bnet\./i.test(texto), false, "nada do pg_net no M2");
    t0.igual(/cron\.job/i.test(bruto), false, "não lê cron.job");
    t0.igual(
      (texto.match(/cron\.[a-z_]+/gi) ?? []).map((s) => s.toLowerCase()),
      ["cron.schedule"],
      "do cron, só o cron.schedule",
    );
    t0.igual(
      texto.includes(
        "cron.schedule('nina-relogio', '17 * * * *', 'select public.manutencao_nina()')",
      ),
      true,
      "o relógio só roda SQL",
    );
  });

  it("os dados iniciais são o mesmo SQL da 0001 e da 0015, sem endereço do app, segredo, id nem e-mail", async () => {
    const texto = await readFile(arqM2 ?? "", "utf8");
    const d0001 = await readFile(join(PASTA_BASE, "0001_nina_dados_iniciais.sql"), "utf8");
    const d0015 = await readFile(join(PASTA_BASE, "0015_nina_voz_uso_precos.sql"), "utf8");
    const esperados = [...insertsDe(d0001), ...insertsDe(d0015)];
    t0.igual(esperados.length, 4, "3 inserts na 0001 e 1 na 0015");
    t0.igual(
      insertsDe(texto).filter((s) => !/public\.motor\b/.test(s)),
      esperados,
      "os mesmos inserts, na mesma ordem",
    );
    // os únicos endereços são as fontes dos preços, que já estão na 0001 e na 0015
    const fontes = new Set([...(d0001 + d0015).matchAll(/https:\/\/[^'\s)]+/g)].map((m) => m[0]));
    const enderecos = [...texto.matchAll(/https?:\/\/[^'\s)]+/g)].map((m) => m[0]);
    t0.igual(
      enderecos.filter((e) => !fontes.has(e)),
      [],
      "nenhum endereço além das fontes dos preços",
    );
    t0.igual(
      /bearer|lovable\.app|sbp_|ghp_|sk-|password|[0-9a-f]{32}/i.test(texto),
      false,
      "nenhum segredo",
    );
    t0.igual(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(texto), false, "nenhum id");
    t0.igual(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/i.test(texto), false, "nenhum e-mail");
  });
});

describe.skipIf(!comEnvios)("banco: preparar_copia", { timeout: TEMPO_TESTE }, () => {
  const t = usarBanco(base);

  it("a cópia imitada fica como a do remix de teste", async () => {
    await preparar(t);
    const original = await retratar(t);
    t.ok(
      Object.values(original.linhas).some((l) => l.length > 0),
      "o banco das migrations tem dados iniciais",
    );
    t.ok(original.gatilhosAuth.length > 0, "o banco das migrations tem gatilho em auth.users");
    t.ok(original.tempoReal.length > 0, "o banco das migrations tem tabelas no tempo real");
    t.ok(original.relogio.length > 0, "o original tem o relógio");
    await virarCopia(t);
    const copia = await retratar(t);
    t.igual(
      Object.entries(copia.linhas)
        .filter(([, linhas]) => linhas.length > 0)
        .map(([tabela]) => tabela),
      [],
      "tabelas com linhas",
    );
    t.igual(copia.gatilhosAuth, [], "gatilhos em auth.users");
    t.igual(copia.tempoReal, [], "tabelas no tempo real");
    t.igual(copia.relogio, [], "relógio");
  });

  it("na cópia: preparada, fica igual ao original; a 2ª chamada dá pronta e não muda nada", async () => {
    t.igual(await preparar(t), "preparada", "o original sem relógio");
    const original = await retratar(t);
    await virarCopia(t);
    t.igual(await preparar(t), "preparada", "a cópia");
    conferirIgual(t, await retratar(t), original, "depois de preparar");
    const [l] = await linhaMotor(t);
    t.ok(
      l.preparada_em instanceof Date && l.relogio_em instanceof Date,
      "preparada_em e relogio_em",
    );
    t.igual(l.url, null, "sem endereço");
    t.igual(await preparar(t), "pronta", "a 2ª chamada");
    conferirIgual(t, await retratar(t), original, "depois da 2ª chamada");
  });

  it("na cópia: a 1ª conta criada depois de preparar vira admin", async () => {
    await virarCopia(t);
    t.igual(await preparar(t), "preparada");
    const u = await t.criarUsuario("primeira@exemplo.test", "Primeira");
    t.igual(await t.sql("select user_id, papel::text from public.membros"), [
      { user_id: u, papel: "admin" },
    ]);
  });

  it("na cópia com a linha criada pelo endereço (sem preparada_em): semeia uma vez só", async () => {
    await virarCopia(t);
    await t.como("service_role", null, (q) =>
      q("select public.motor_endereco($1)", ["https://copia.exemplo.test"]),
    );
    t.igual(await etapas(t), [], "sem etapas antes");
    t.igual(await preparar(t), "preparada");
    t.igual(
      await etapas(t),
      ["novo", "em_qualificacao", "qualificado", "em_negociacao", "ganho", "perdido"],
      "as 6 etapas",
    );
    const [{ n }] = await t.sql("select count(*)::int as n from public.ia_precos");
    t.igual(n, 31, "28 preços da 0001, 2 da 0015 e 1 da 0026");
    t.igual((await linhaMotor(t))[0].url, "https://copia.exemplo.test", "o endereço fica");
    // o admin apaga uma etapa; com o relógio vencido, preparar não a ressuscita
    await t.sql("delete from public.etapas where chave = 'em_negociacao'");
    await t.sql("update public.motor set relogio_em = now() - interval '25 hours'");
    t.igual(await preparar(t), "preparada");
    t.igual(
      await etapas(t),
      ["novo", "em_qualificacao", "qualificado", "ganho", "perdido"],
      "não volta",
    );
  });

  it("no original: não semeia (a linha nasceu preparada) e não ressuscita etapa apagada", async () => {
    const [antes] = await linhaMotor(t);
    t.ok(antes.preparada_em instanceof Date, "a migration marcou a linha como preparada");
    t.igual(antes.relogio_em, null, "sem relógio");
    await t.sql("delete from public.etapas where chave = 'em_negociacao'");
    await t.sql("delete from public.ia_precos where modelo = 'whisper-1'");
    t.igual(await preparar(t), "preparada");
    t.igual(
      await etapas(t),
      ["novo", "em_qualificacao", "qualificado", "ganho", "perdido"],
      "a etapa não volta",
    );
    const [{ n }] = await t.sql(
      "select count(*)::int as n from public.ia_precos where modelo = 'whisper-1'",
    );
    t.igual(n, 0, "o preço apagado não volta");
    const [depois] = await linhaMotor(t);
    t.igual(ms(depois.preparada_em), ms(antes.preparada_em), "preparada_em não muda");
    t.ok(depois.relogio_em instanceof Date, "relogio_em gravado");
    t.igual(await relogios(t), await jobsEsperados(t), "o relógio");
    t.igual(await preparar(t), "pronta", "a 2ª chamada");
  });

  it("relógio vencido (mais de 1 dia): refaz só o gatilho, o tempo real e o relógio", async () => {
    t.igual(await preparar(t), "preparada");
    const completo = await retratar(t);
    // estragos: o gatilho, uma tabela do tempo real, o relógio e uma etapa
    await t.sql("drop trigger membros_primeira_conta on auth.users");
    await t.sql("alter publication supabase_realtime drop table public.mensagens");
    await t.sql("delete from cron.job");
    await t.sql("delete from public.etapas where chave = 'ganho'");
    await t.sql("update public.motor set relogio_em = now() - interval '23 hours'");
    t.igual(await preparar(t), "pronta", "com menos de 1 dia não refaz");
    t.igual(await relogios(t), [], "o relógio continua faltando");
    await t.sql("update public.motor set relogio_em = now() - interval '25 hours'");
    const [{ relogio_em: velho }] = await linhaMotor(t);
    t.igual(await preparar(t), "preparada", "com mais de 1 dia refaz");
    const depois = await retratar(t);
    t.igual(depois.gatilhosAuth, completo.gatilhosAuth, "gatilho de volta");
    t.igual(depois.tempoReal, completo.tempoReal, "tempo real de volta");
    t.igual(depois.relogio, completo.relogio, "relógio de volta, sem duplicar");
    t.ok(!(await etapas(t)).includes("ganho"), "a etapa apagada não volta");
    const [{ relogio_em: novo }] = await linhaMotor(t);
    t.ok((ms(novo) ?? 0) > (ms(velho) ?? 0), "relogio_em renovado");
  });

  it("na cópia, se o cron recusar: prepara o resto, relogio_em fica nulo e a chamada seguinte instala só o relógio", async () => {
    await virarCopia(t);
    await t.sql("revoke execute on function cron.schedule(text, text, text) from dono_app");
    try {
      t.igual(await preparar(t), "preparada", "sem o cron");
      t.igual(
        await etapas(t),
        ["novo", "em_qualificacao", "qualificado", "em_negociacao", "ganho", "perdido"],
        "as 6 etapas",
      );
      const { gatilhosAuth, tempoReal } = await retratar(t);
      t.igual(gatilhosAuth, ["membros_primeira_conta"], "o gatilho da 1ª conta");
      // 8 tabelas; 9 com a de Ligações (envio 4), quando já está na base.
      const [{ tem }] = await t.sql(`select to_regclass('public.ligacoes') is not null as tem`);
      t.igual(tempoReal.length, tem ? 9 : 8, "as tabelas do tempo real");
      const [l] = await linhaMotor(t);
      t.ok(l.preparada_em instanceof Date, "preparada_em gravado");
      t.igual(l.relogio_em, null, "relogio_em nulo");
      t.igual(await relogios(t), [], "nenhum job");
    } finally {
      await t.sql("grant execute on function cron.schedule(text, text, text) to dono_app");
    }
    // o admin apaga uma etapa; a chamada seguinte instala o relógio sem semear de novo
    await t.sql("delete from public.etapas where chave = 'ganho'");
    t.igual(await preparar(t), "preparada", "com o cron de volta");
    t.igual(await relogios(t), await jobsEsperados(t), "o relógio");
    t.ok((await linhaMotor(t))[0].relogio_em instanceof Date, "relogio_em gravado");
    t.ok(!(await etapas(t)).includes("ganho"), "a etapa apagada não volta");
    t.igual(await preparar(t), "pronta", "a 3ª chamada");
  });

  it("o relógio só de SQL: um job por nome (dois com os retornos), e o comando roda como o dono", async () => {
    t.igual(await preparar(t), "preparada");
    await t.sql("update public.motor set relogio_em = now() - interval '2 days'");
    t.igual(await preparar(t), "preparada");
    const jobs = await relogios(t);
    t.igual(jobs, await jobsEsperados(t), "um job por nome, ativo, do dono");
    for (const job of jobs) {
      // o comando em si: a função chamada pode acordar o worker pela acordar_motor (a manutencao_nina,
      // na ligação presa, e a relogio_retornos, com retorno ou lembrete pronto)
      t.ok(
        /^select public\.[a-z_]+\(\)$/.test(job.command),
        `o comando de ${job.jobname} é um select de uma função do public`,
      );
      t.ok(
        !/http|net\./i.test(job.command),
        `o comando de ${job.jobname} é um select de uma função do public`,
      );
      await comoDono(t, job.command);
    }
  });

  it("manutencao_nina: apaga só os eventos com mais de 30 dias, soltando a mensagem que apontava", async () => {
    const [{ id: cx }] = await t.sql(
      `insert into public.conexoes (gateway, nome, id_externo, ativa, status)
       values ('zapi', 'Conexão de teste', 'inst-teste-1', true, 'conectada') returning id`,
    );
    const novo = async (quando: string, id: string) =>
      Number(
        (
          await t.sql(
            `insert into public.eventos_webhook (gateway, id_evento, tipo, payload, recebido_em)
             values ('zapi', $1, 'mensagem', '{}'::jsonb, ${quando}) returning id`,
            [id],
          )
        )[0].id,
      );
    const velho = await novo("now() - interval '31 days'", "velho");
    await novo("now() - interval '30 days' - interval '1 minute'", "passou");
    const ficaA = await novo("now() - interval '30 days' + interval '1 minute'", "quase");
    const ficaB = await novo("now() - interval '1 day'", "ontem");
    const [{ id: contato }] = await t.sql(
      "insert into public.contatos (nome) values ('Lead') returning id",
    );
    const [{ id: conversa }] = await t.sql(
      "insert into public.conversas (contato_id, modo) values ($1, 'humano') returning id",
      [contato],
    );
    const [{ id: msg }] = await t.sql(
      `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, texto, id_externo, evento_id)
       values ($1, $2, 'entrada', 'lead', 'oi', 'w-1', $3) returning id`,
      [conversa, cx, velho],
    );
    await comoDono(t, "select public.manutencao_nina()");
    t.igual(
      (await t.sql("select id from public.eventos_webhook order by id")).map((r: Linha) =>
        Number(r.id),
      ),
      [ficaA, ficaB],
      "ficam os de 30 dias ou menos",
    );
    t.igual(
      (await t.sql("select evento_id from public.mensagens where id = $1", [msg]))[0].evento_id,
      null,
      "a mensagem fica, sem o evento",
    );
  });

  it("permissões: preparar_copia só o servidor; manutencao_nina ninguém (só o dono, pelo cron)", async () => {
    const funcoes = ["public.preparar_copia()", "public.manutencao_nina()"];
    const exec = await t.sql(
      `select f, papel, has_function_privilege(papel, f, 'execute') as pode
         from unnest($1::text[]) with ordinality as x(f, i),
              unnest(array['anon', 'authenticated', 'service_role']) papel
        order by i, papel`,
      [funcoes],
    );
    t.igual(
      exec.map((r: Linha) => [r.f, r.papel, r.pode]),
      [
        ["public.preparar_copia()", "anon", false],
        ["public.preparar_copia()", "authenticated", false],
        ["public.preparar_copia()", "service_role", true],
        ["public.manutencao_nina()", "anon", false],
        ["public.manutencao_nina()", "authenticated", false],
        ["public.manutencao_nina()", "service_role", false],
      ],
      "execute",
    );
    const publico = await t.sql(
      `select p.proname from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where p.oid = any ($1::regprocedure[]) and a.grantee = 0`,
      [funcoes],
    );
    t.igual(publico, [], "nada para PUBLIC");
    const def = await t.sql(
      `select p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as dono, l.lanname as lingua,
              pg_get_function_result(p.oid) as res
         from pg_proc p join pg_language l on l.oid = p.prolang
        where p.oid = any ($1::regprocedure[]) order by p.proname`,
      [funcoes],
    );
    t.igual(
      def.map((r: Linha) => [r.proname, r.prosecdef, r.proconfig, r.dono, r.lingua, r.res]),
      [
        ["manutencao_nina", true, ['search_path=""'], "dono_app", "plpgsql", "void"],
        ["preparar_copia", true, ['search_path=""'], "dono_app", "plpgsql", "text"],
      ],
      "plpgsql, security definer, search_path vazio e dono",
    );
    for (const papel of ["anon", "authenticated"] as const) {
      await t.erro(
        t.como(papel, null, (q) => q("select public.preparar_copia()")),
        "permission denied",
      );
      await t.erro(
        t.como(papel, null, (q) => q("select public.manutencao_nina()")),
        "permission denied",
      );
    }
    await t.erro(
      t.como("service_role", null, (q) => q("select public.manutencao_nina()")),
      "permission denied",
    );
    t.igual(await relogios(t), [], "ninguém instalou o relógio");
  });
});

function ms(d: Date | null | undefined): number | null {
  return d instanceof Date ? d.getTime() : null;
}
