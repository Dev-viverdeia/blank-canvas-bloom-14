// @vitest-environment node
// O motor acordado pelos acontecimentos (seção 2, envio M1
// nina_motor_acordado): a tabela public.motor, motor_endereco, acordar_motor, motor_confere,
// motor_pendencias, pegar_eventos_pendentes e falhar_evento, sobre a imitação do pg_net de
// supabase-imitacao.sql (net.http_post só grava o pedido em net.http_request_queue). Até o envio
// virar migration, os testes pulam, salvo com o arquivo em NINA_SQL_EXTRA.
// motor_pendencias espelha as funções que pegam o trabalho: em cada caso, o teste confere também
// que a função de verdade (pegar_rodadas, pegar_envios, pegar_midias, pegar_eventos_pendentes) pega
// o item vencido e não pega o que a trava segura.
import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";
import {
  arquivosExtra,
  arquivosMigrations,
  montarBase,
  temFuncao,
  TEMPO_TESTE,
  usarBanco,
  type Banco,
  type Linha,
} from "./montar";

const base = await montarBase();

// O arquivo do envio: a migration, ou o de NINA_SQL_EXTRA enquanto não é migration.
const migrations = await arquivosMigrations();
const extras = arquivosExtra();
const acharArquivo = (parte: string) =>
  migrations.find((a) => basename(a).includes(parte)) ??
  extras.find((a) => basename(a).includes(parte));
const arqM1 = acharArquivo("nina_motor_acordado");

const URL_A = "https://nina-a.exemplo.test";
const URL_B = "https://nina-b.exemplo.test";
const ROTA = "/api/public/cron/mensageria";
const FUNCOES_M1 = [
  "motor_endereco",
  "acordar_motor",
  "motor_confere",
  "motor_pendencias",
  "pegar_eventos_pendentes",
  "falhar_evento",
];

// ---------------------------------------------------------------------------
// ajudantes
// ---------------------------------------------------------------------------

/** Um comando como o servidor (service_role). */
function servidor(t: Banco, texto: string, params?: unknown[]) {
  return t.como("service_role", null, (q) => q(texto, params));
}

async function endereco(t: Banco, url: string | null): Promise<boolean> {
  const [r] = await servidor(t, "select public.motor_endereco($1) as r", [url]);
  return r.r as boolean;
}

async function acordar(t: Banco, renovar?: boolean): Promise<string> {
  const [r] =
    renovar === undefined
      ? await servidor(t, "select public.acordar_motor() as r", [])
      : await servidor(t, "select public.acordar_motor($1) as r", [renovar]);
  return r.r as string;
}

async function confere(t: Banco, chave: string | null): Promise<boolean> {
  const [r] = await servidor(t, "select public.motor_confere($1) as r", [chave]);
  return r.r as boolean;
}

async function linha(t: Banco) {
  return t.sql("select url, chave, url_em, tocado_em, preparada_em, relogio_em from public.motor");
}

async function chamadas(t: Banco) {
  return t.sql("select method, url, headers, body from net.http_request_queue order by id");
}

interface Pendencias {
  proximo: number | null;
  vencido: number | null;
  atrasado: number | null;
}

const ms = (d: Date | null | undefined) => (d instanceof Date ? d.getTime() : null);

/** motor_pendencias como o servidor, em milissegundos. */
async function pendencias(t: Banco): Promise<Pendencias> {
  const r = await servidor(t, "select * from public.motor_pendencias()", []);
  t.igual(r.length, 1, "motor_pendencias devolve uma linha só");
  return {
    proximo: ms(r[0].proximo_em),
    vencido: ms(r[0].vencido_desde),
    atrasado: ms(r[0].atrasado_desde),
  };
}

const NADA: Pendencias = { proximo: null, vencido: null, atrasado: null };

/** Lê uma coluna de data e devolve em milissegundos (com um deslocamento opcional). */
async function momento(t: Banco, texto: string, params: unknown[], somar = 0): Promise<number> {
  const [r] = await t.sql(texto, params);
  const v = ms(r?.m);
  if (v === null) throw new Error(`momento nulo: ${texto}`);
  return v + somar;
}

const MIN = 60_000;

interface Preparo {
  cx: string;
}

// Conexão Z-API ativa (não oficial) e o onboarding concluído, os dois há 1 h: o "pronto" de uma
// conversa ou saída nunca vem antes deles, e os testes que não olham isso ficam longe dessa borda.
async function preparar(t: Banco): Promise<Preparo> {
  const [{ id: cx }] = await t.sql(
    `insert into public.conexoes (gateway, nome, id_externo, ativa, status, criado_em)
     values ('zapi', 'Conexão de teste', 'inst-teste-1', true, 'conectada', now() - interval '1 hour')
     returning id`,
  );
  await t.sql(
    "update public.configuracao set onboarding_concluido_em = now() - interval '1 hour' where id = 1",
  );
  return { cx };
}

let contador = 0;

/** Contato e conversa novos (a etapa de entrada vem do gatilho). */
async function novaConversa(t: Banco, modo: "nina" | "humano" = "nina"): Promise<string> {
  contador += 1;
  const [{ id: contato }] = await t.sql(
    "insert into public.contatos (nome, telefone) values ($1, $2) returning id",
    [`Lead ${contador}`, `55119${String(contador).padStart(8, "0")}`],
  );
  const [{ id }] = await t.sql(
    "insert into public.conversas (contato_id, modo) values ($1, $2::public.conversa_modo) returning id",
    [contato, modo],
  );
  return id as string;
}

/** Conversa da Nina armada para `quando` (expressão SQL), com o lead falando há 1 min. */
async function conversaArmada(t: Banco, quando: string): Promise<string> {
  const id = await novaConversa(t);
  await t.sql(
    `update public.conversas set responder_apos = ${quando}, ultima_do_lead_em = now() - interval '1 minute'
      where id = $1`,
    [id],
  );
  return id;
}

/** Entrada do lead (sem texto de mídia, a não ser com ref). */
async function entrada(
  t: Banco,
  conversa: string,
  cx: string,
  ref: string | null = null,
): Promise<string> {
  contador += 1;
  const [{ id }] = await t.sql(
    `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, tipo, texto, id_externo, midia_ref_externa)
     values ($1, $2, 'entrada', 'lead', $3::public.mensagem_tipo, 'oi', $4, $5) returning id`,
    [conversa, cx, ref ? "imagem" : "texto", `e-${contador}`, ref],
  );
  return id as string;
}

/** Saída na fila (pelo celular: não precisa de rodada nem de autor) para `quando` (expressão SQL). */
async function saida(
  t: Banco,
  conversa: string,
  quando = "now() - interval '1 second'",
): Promise<string> {
  const [{ id }] = await t.sql(
    `insert into public.mensagens (conversa_id, direcao, origem, texto, status, enviar_apos)
     values ($1, 'saida', 'humano_celular', 'resposta', 'na_fila', ${quando}) returning id`,
    [conversa],
  );
  return id as string;
}

async function evento(t: Banco, colunas: Record<string, string> = {}): Promise<number> {
  contador += 1;
  const c = { recebido_em: "now()", ...colunas };
  const nomes = Object.keys(c);
  const [{ id }] = await t.sql(
    `insert into public.eventos_webhook (gateway, id_evento, tipo, payload, ${nomes.join(", ")})
     values ('zapi', $1, 'mensagem', '{"teste": true}'::jsonb, ${nomes.map((n) => c[n as keyof typeof c]).join(", ")})
     returning id`,
    [`ev-${contador}`],
  );
  return Number(id);
}

const pegarRodadas = (t: Banco) => servidor(t, "select id from public.pegar_rodadas(10)", []);
const pegarEnvios = (t: Banco) => servidor(t, "select id from public.pegar_envios(10)", []);
const pegarMidias = (t: Banco) => servidor(t, "select id from public.pegar_midias(10)", []);
const pegarEventos = (t: Banco, limite: number | null = 10) =>
  servidor(t, "select * from public.pegar_eventos_pendentes($1)", [limite]);

// asserções fora de um banco (só comparam valores)
const t0 = {
  igual: (a: unknown, b: unknown, msg: string) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${msg}: veio ${JSON.stringify(a)}, esperava ${JSON.stringify(b)}`);
  },
};

// ---------------------------------------------------------------------------

describe("banco: motor acordado (montagem)", () => {
  it("o arquivo nina_motor_acordado e as funções vêm juntos, ou nenhum dos dois", () => {
    const tem = FUNCOES_M1.map((f) => temFuncao(base, f));
    if (arqM1)
      t0.igual(
        tem,
        FUNCOES_M1.map(() => true),
        "funções do motor",
      );
    else
      t0.igual(
        tem,
        FUNCOES_M1.map(() => false),
        "sem o envio, nenhuma função do motor",
      );
  });
});

describe.skipIf(!arqM1)("banco: motor acordado (o texto do envio M1)", () => {
  it("liga o pg_net antes de tudo e não tem nada do cron", async () => {
    const bruto = await readFile(arqM1 ?? "", "utf8");
    const texto = bruto.replace(/--[^\n]*/g, "");
    t0.igual(
      /^\s*create\s+extension\s+if\s+not\s+exists\s+pg_net\b[^;]*;/im.test(texto),
      true,
      "create extension if not exists pg_net",
    );
    t0.igual(
      texto.search(/create\s+extension\s+if\s+not\s+exists\s+pg_net/i) <
        texto.search(/create\s+table/i),
      true,
      "a extensão vem antes da tabela",
    );
    // o texto inteiro, com os comentários: a recusa de 03/11 veio com cron e net.http_post juntos
    t0.igual(/cron\./i.test(bruto), false, "nenhum cron. no M1");
    t0.igual(/cron\.job/i.test(bruto), false, "não lê cron.job");
    t0.igual(/net\.http_post/i.test(bruto), true, "o toque é por net.http_post");
  });

  it("não traz endereço, segredo, id de usuário nem e-mail, e grava a linha só com preparada_em", async () => {
    const texto = await readFile(arqM1 ?? "", "utf8");
    t0.igual(/https?:\/\/[A-Za-z0-9]/.test(texto), false, "nenhum endereço de verdade");
    t0.igual(
      /bearer|lovable\.app|sbp_|ghp_|sk-|password|[0-9a-f]{32}/i.test(texto),
      false,
      "nenhum segredo",
    );
    t0.igual(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(texto), false, "nenhum id");
    t0.igual(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/i.test(texto), false, "nenhum e-mail");
    const inserts = texto.match(/insert\s+into\s+public\.motor\s*\([^)]*\)/gi) ?? [];
    t0.igual(
      inserts.map((s) => s.replace(/\s+/g, " ").toLowerCase()),
      ["insert into public.motor (id, preparada_em)", "insert into public.motor (id)"],
      "inserts na tabela do motor",
    );
  });
});

describe.skipIf(!arqM1)("banco: motor acordado", { timeout: TEMPO_TESTE }, () => {
  const t = usarBanco(base);

  // -------------------------------------------------------------------------
  // a linha, o endereço e a chave
  // -------------------------------------------------------------------------

  it("a migration grava a linha marcada como preparada, sem endereço e com a chave de 32 bytes", async () => {
    const l = await linha(t);
    t.igual(l.length, 1, "uma linha");
    t.igual(l[0].url, null, "url");
    t.ok(/^[0-9a-f]{64}$/.test(l[0].chave), "chave de 32 bytes em hex");
    t.ok(l[0].preparada_em instanceof Date, "preparada_em");
    t.igual(
      [l[0].url_em, l[0].tocado_em, l[0].relogio_em],
      [null, null, null],
      "os outros momentos",
    );
    const [{ cols }] = await t.sql(
      `select string_agg(column_name || ':' || data_type, ',' order by ordinal_position) as cols
         from information_schema.columns where table_schema = 'public' and table_name = 'eventos_webhook'
          and column_name = 'pego_em'`,
    );
    t.igual(cols, "pego_em:timestamp with time zone", "eventos_webhook.pego_em");
    await t.erro(t.sql("insert into public.motor (id) values (false)"), "motor_linha_unica");
  });

  it("endereço válido: grava, devolve true só quando muda e marca url_em", async () => {
    t.igual(await endereco(t, URL_A), true, "1ª vez");
    const [l1] = await linha(t);
    t.igual(l1.url, URL_A, "url");
    t.ok(l1.url_em instanceof Date, "url_em");
    t.igual(await endereco(t, URL_A), false, "o mesmo endereço não grava");
    const [l2] = await linha(t);
    t.igual(ms(l2.url_em), ms(l1.url_em), "url_em não muda");
    t.igual(await endereco(t, URL_B), true, "outro endereço grava");
    const [l3] = await linha(t);
    t.igual([l3.url, l3.chave], [URL_B, l1.chave], "troca o endereço e mantém a chave");
    // até 261 caracteres: https:// + 253 de host
    const host253 = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    t.igual(await endereco(t, `https://${host253}`), true, "261 caracteres");
    t.igual(
      await endereco(t, "https://nina-x-1.lovable.app"),
      true,
      "subdomínio com hífen e número",
    );
  });

  it("endereço inválido: devolve false e não muda nada; o check da tabela recusa também", async () => {
    await endereco(t, URL_A);
    const [antes] = await linha(t);
    const host254 = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`;
    for (const url of [
      null,
      "",
      "http://nina.exemplo.test",
      "https://nina.exemplo.test/",
      "https://nina.exemplo.test/api",
      "https://nina.exemplo.test:8443",
      "https://NINA.exemplo.test",
      "https://localhost",
      "https://-nina.exemplo.test",
      "https://nina.exemplo.123",
      "https://nina.exemplo.test?x=1",
      " https://nina.exemplo.test",
      "https://nina.exemplo.test\n",
      `https://${host254}`,
    ]) {
      t.igual(await endereco(t, url), false, `inválido: ${JSON.stringify(url)}`);
    }
    t.igual(await linha(t), [antes], "nada mudou");
    await t.erro(
      t.sql("update public.motor set url = 'http://nina.exemplo.test'"),
      "motor_url_formato",
    );
  });

  it("motor_endereco cria a linha quando ela falta (a cópia do remix), sem preparada_em", async () => {
    await t.sql("delete from public.motor");
    t.igual(await endereco(t, null), false, "sem endereço");
    const l = await linha(t);
    t.igual(l.length, 1, "criou a linha");
    t.igual([l[0].url, l[0].preparada_em], [null, null], "sem url e sem preparada_em");
    t.ok(/^[0-9a-f]{64}$/.test(l[0].chave), "chave nova");
    t.igual(await endereco(t, URL_A), true, "grava depois");
  });

  it("motor_confere: só a chave guardada dá true", async () => {
    const [{ chave }] = await linha(t);
    t.igual(await confere(t, chave), true, "a chave certa");
    t.igual(await confere(t, chave.toUpperCase()), false, "maiúscula");
    t.igual(await confere(t, chave.slice(0, 63)), false, "cortada");
    t.igual(await confere(t, "x"), false, "outra");
    t.igual(await confere(t, ""), false, "vazia");
    t.igual(await confere(t, null), false, "nula");
    await t.sql("delete from public.motor");
    t.igual(await confere(t, chave), false, "sem a linha");
  });

  // -------------------------------------------------------------------------
  // acordar_motor
  // -------------------------------------------------------------------------

  it("acordar_motor sem endereço: sem_endereco e nenhum pedido (também sem a linha)", async () => {
    t.igual(await acordar(t), "sem_endereco");
    t.igual(await chamadas(t), [], "nenhum pedido");
    t.igual((await linha(t))[0].tocado_em, null, "tocado_em");
    await t.sql("delete from public.motor");
    t.igual(await acordar(t), "sem_endereco", "sem a linha");
    t.igual(await chamadas(t), [], "nenhum pedido");
  });

  it("acordar_motor tocado: POST na rota do worker, cabeçalho x-nina-motor com a chave e corpo {}", async () => {
    await endereco(t, URL_A);
    t.igual(await acordar(t), "tocado");
    const [l] = await linha(t);
    t.ok(l.tocado_em instanceof Date, "tocado_em gravado");
    const c = await chamadas(t);
    t.igual(
      c,
      [
        {
          method: "POST",
          url: URL_A + ROTA,
          headers: { "Content-Type": "application/json", "x-nina-motor": l.chave },
          body: {},
        },
      ],
      "o pedido",
    );
    const [{ teto }] = await t.sql(
      "select timeout_milliseconds as teto from net.http_request_queue",
    );
    t.igual(teto, 60_000, "teto do pedido acima da passada do worker");
  });

  it("acordar_motor recente: toque nos últimos 40 s não toca de novo; depois de 40 s toca", async () => {
    await endereco(t, URL_A);
    t.igual(await acordar(t), "tocado");
    t.igual(await acordar(t), "recente", "logo depois");
    await t.sql("update public.motor set tocado_em = now() - interval '39 seconds'");
    t.igual(await acordar(t), "recente", "39 s depois");
    t.igual((await chamadas(t)).length, 1, "um pedido só");
    await t.sql("update public.motor set tocado_em = now() - interval '41 seconds'");
    t.igual(await acordar(t), "tocado", "41 s depois");
    t.igual((await chamadas(t)).length, 2, "o 2º pedido");
  });

  it("acordar_motor recente: o worker rodou nos últimos 40 s (worker_visto_em)", async () => {
    await endereco(t, URL_A);
    await t.sql(
      "update public.configuracao set worker_visto_em = now() - interval '10 seconds' where id = 1",
    );
    t.igual(await acordar(t), "recente", "o worker acabou de rodar");
    t.igual(await chamadas(t), [], "nenhum pedido");
    t.igual((await linha(t))[0].tocado_em, null, "tocado_em não muda");
    await t.sql(
      "update public.configuracao set worker_visto_em = now() - interval '41 seconds' where id = 1",
    );
    t.igual(await acordar(t), "tocado", "41 s depois");
    // sem a linha de configuracao (a cópia antes de preparar), o toque não quebra
    await t.sql("delete from public.configuracao");
    await t.sql("update public.motor set tocado_em = null");
    t.igual(await acordar(t), "tocado", "sem configuracao");
  });

  it("acordar_motor(true), a renovação do fim do laço: não olha o worker; só um toque de menos de 10 s segura", async () => {
    await endereco(t, URL_A);
    // o laço aberto por um toque: o toque e o worker visto há 38 s, quando o laço acaba
    await t.sql("update public.motor set tocado_em = now() - interval '38 seconds'");
    await t.sql(
      "update public.configuracao set worker_visto_em = now() - interval '38 seconds' where id = 1",
    );
    t.igual(await acordar(t), "recente", "o toque comum segura (40 s)");
    t.igual(await acordar(t, false), "recente", "false é o toque comum");
    t.igual(await chamadas(t), [], "nenhum pedido");
    t.igual(await acordar(t, true), "tocado", "a renovação toca");
    t.igual((await chamadas(t)).length, 1, "um pedido");
    // outro toque acabou de sair (5 s): a renovação não toca de novo
    await t.sql("update public.motor set tocado_em = now() - interval '5 seconds'");
    t.igual(await acordar(t, true), "recente", "toque de 5 s atrás");
    await t.sql("update public.motor set tocado_em = now() - interval '11 seconds'");
    await t.sql("update public.configuracao set worker_visto_em = now() where id = 1");
    t.igual(await acordar(t, true), "tocado", "11 s depois, mesmo com o worker visto agora");
    t.igual((await chamadas(t)).length, 2, "o 2º pedido");
    // nulo vale como o toque comum
    await t.sql("update public.motor set tocado_em = now() - interval '20 seconds'");
    t.igual(await acordar(t, null as unknown as boolean), "recente", "nulo é o toque comum");
  });

  it("acordar_motor depois de trocar o endereço toca no novo", async () => {
    await endereco(t, URL_A);
    await endereco(t, URL_B);
    t.igual(await acordar(t), "tocado");
    t.igual(
      (await chamadas(t)).map((c: Linha) => c.url),
      [URL_B + ROTA],
      "no endereço novo",
    );
  });

  // -------------------------------------------------------------------------
  // motor_pendencias
  // -------------------------------------------------------------------------

  it("motor_pendencias sem nada: uma linha com os três nulos", async () => {
    t.igual(await pendencias(t), NADA, "banco vazio");
    await preparar(t);
    t.igual(await pendencias(t), NADA, "com conexão e onboarding");
  });

  it("conversa armada: no futuro é proximo_em; vencida é vencido_desde e atrasado_desde; pegar_rodadas pega", async () => {
    await preparar(t);
    const futura = await conversaArmada(t, "now() + interval '5 minutes'");
    const quandoF = await momento(
      t,
      "select responder_apos as m from public.conversas where id = $1",
      [futura],
    );
    t.igual(await pendencias(t), { proximo: quandoF, vencido: null, atrasado: null }, "futura");
    const vencida = await conversaArmada(t, "now() - interval '10 seconds'");
    const quandoV = await momento(
      t,
      "select responder_apos as m from public.conversas where id = $1",
      [vencida],
    );
    t.igual(
      await pendencias(t),
      { proximo: quandoF, vencido: quandoV, atrasado: quandoV },
      "vencida",
    );
    t.igual((await pegarRodadas(t)).length, 1, "pegar_rodadas pega a vencida");
    // a rodada nova (rodando) fica pronta em iniciada_em + 5 min: vira o proximo_em
    const iniciada = await momento(
      t,
      "select iniciada_em as m from public.rodadas where conversa_id = $1",
      [vencida],
      5 * MIN,
    );
    t.igual(
      await pendencias(t),
      { proximo: Math.min(quandoF, iniciada), vencido: null, atrasado: null },
      "depois de pegar",
    );
  });

  it("conversa armada: cada trava (onboarding, conexão inativa, janela oficial, modo humano) não é pendência", async () => {
    const { cx } = await preparar(t);
    const conv = await conversaArmada(t, "now() - interval '10 seconds'");
    const quando = await momento(
      t,
      "select responder_apos as m from public.conversas where id = $1",
      [conv],
    );
    const comItem = { proximo: null, vencido: quando, atrasado: quando };
    t.igual(await pendencias(t), comItem, "sem trava");

    // onboarding aberto
    await t.sql("update public.configuracao set onboarding_concluido_em = null where id = 1");
    t.igual(await pendencias(t), NADA, "onboarding aberto");
    t.igual(await pegarRodadas(t), [], "pegar_rodadas também não pega");
    await t.sql("update public.configuracao set onboarding_concluido_em = now() where id = 1");
    const concluido = await momento(
      t,
      "select onboarding_concluido_em as m from public.configuracao where id = 1",
      [],
    );
    t.igual(
      await pendencias(t),
      { proximo: null, vencido: concluido, atrasado: concluido },
      "concluído de novo: vencida desde a conclusão",
    );

    // conexão inativa (nenhuma ativa)
    await t.sql("update public.conexoes set ativa = false where id = $1", [cx]);
    t.igual(await pendencias(t), NADA, "conexão inativa");
    t.igual(await pegarRodadas(t), [], "pegar_rodadas também não pega");

    // conexão oficial com a janela de 24 h fechada
    const [{ id: meta }] = await t.sql(
      `insert into public.conexoes (gateway, nome, id_externo, ativa, status)
       values ('meta', 'Oficial', 'meta-1', true, 'conectada') returning id`,
    );
    await t.sql(
      "update public.conversas set ultima_do_lead_em = now() - interval '25 hours' where id = $1",
      [conv],
    );
    t.igual(await pendencias(t), NADA, "janela oficial fechada");
    t.igual(await pegarRodadas(t), [], "pegar_rodadas também não pega");
    await t.sql(
      "update public.conversas set ultima_do_lead_em = now() - interval '23 hours' where id = $1",
      [conv],
    );
    const meta1 = await momento(t, "select criado_em as m from public.conexoes where id = $1", [
      meta,
    ]);
    t.igual(
      await pendencias(t),
      { proximo: null, vencido: meta1, atrasado: meta1 },
      "janela oficial aberta: desde a conexão oficial",
    );
    await t.sql("update public.conversas set ultima_do_lead_em = null where id = $1", [conv]);
    t.igual(await pendencias(t), NADA, "oficial sem mensagem do lead");
    await t.sql("update public.conexoes set ativa = false where id = $1", [meta]);
    await t.sql("update public.conexoes set ativa = true where id = $1", [cx]);
    const reativada = await momento(
      t,
      "select max(criado_em) as m from public.conexao_eventos where conexao_id = $1 and ativa_para",
      [cx],
    );
    const desdeCx = { proximo: null, vencido: reativada, atrasado: reativada };
    t.igual(await pendencias(t), desdeCx, "não oficial não olha a janela (desde a reativação)");

    // modo humano
    await t.sql("update public.conversas set modo = 'humano' where id = $1", [conv]);
    t.igual(await pendencias(t), NADA, "modo humano");
    t.igual(await pegarRodadas(t), [], "pegar_rodadas também não pega");
    await t.sql("update public.conversas set modo = 'nina' where id = $1", [conv]);
    t.igual(await pendencias(t), desdeCx, "de volta à Nina");
    t.igual((await pegarRodadas(t)).length, 1, "sem trava, pegar_rodadas pega");
  });

  it("conversa armada com rodada rodando ou mídia nova pendente: pronta só depois da trava", async () => {
    const { cx } = await preparar(t);
    const conv = await conversaArmada(t, "now() - interval '10 seconds'");
    // uma rodada rodando há 1 min: a conversa e a rodada ficam prontas em iniciada_em + 5 min
    await t.sql(
      `insert into public.rodadas (conversa_id, status, iniciada_em) values ($1, 'rodando', now() - interval '1 minute')`,
      [conv],
    );
    const limpeza = await momento(
      t,
      "select iniciada_em as m from public.rodadas where conversa_id = $1",
      [conv],
      5 * MIN,
    );
    t.igual(
      await pendencias(t),
      { proximo: limpeza, vencido: null, atrasado: null },
      "rodada rodando",
    );
    t.igual(await pegarRodadas(t), [], "pegar_rodadas não pega a conversa");
    // a rodada presa há 6 min: pegar_rodadas a falha e falhar_rodada re-arma a conversa em +30 s;
    // a conversa fica pronta no responder_apos novo
    await t.sql(
      "update public.rodadas set iniciada_em = now() - interval '6 minutes' where conversa_id = $1",
      [conv],
    );
    t.igual(await pegarRodadas(t), [], "pegar_rodadas limpa a rodada e não pega a conversa");
    t.igual(
      await t.sql(
        "select count(*)::int as n from public.rodadas where conversa_id = $1 and status = 'rodando'",
        [conv],
      ),
      [{ n: 0 }],
      "a rodada presa foi fechada",
    );
    const rearmada = await momento(
      t,
      "select responder_apos as m from public.conversas where id = $1",
      [conv],
    );
    t.igual(
      await pendencias(t),
      { proximo: rearmada, vencido: null, atrasado: null },
      "re-armada depois da limpeza",
    );
    await t.sql("delete from public.rodadas where conversa_id = $1", [conv]);

    // mídia de entrada pendente criada agora: a mídia já está vencida; a conversa espera 2 min
    const m = await entrada(t, conv, cx, "ref-midia-1");
    await t.sql(
      "update public.conversas set responder_apos = now() - interval '10 seconds' where id = $1",
      [conv],
    );
    const criada = await momento(t, "select criado_em as m from public.mensagens where id = $1", [
      m,
    ]);
    t.igual(
      await pendencias(t),
      { proximo: criada + 2 * MIN, vencido: criada, atrasado: criada },
      "mídia nova pendente",
    );
    t.igual(await pegarRodadas(t), [], "pegar_rodadas não pega a conversa");

    // a mídia chegou há 3 min (e o motor a pegou agora, para ela não ser o vencido mais velho): a
    // conversa armada há 5 min fica vencida em criado_em + 2 min, e pegar_rodadas pega
    await t.sql(
      "update public.mensagens set criado_em = now() - interval '3 minutes', midia_pega_em = now() where id = $1",
      [m],
    );
    await t.sql(
      "update public.conversas set responder_apos = now() - interval '5 minutes' where id = $1",
      [conv],
    );
    const criada3 = await momento(t, "select criado_em as m from public.mensagens where id = $1", [
      m,
    ]);
    const pega = await momento(
      t,
      "select midia_pega_em as m from public.mensagens where id = $1",
      [m],
      2 * MIN,
    );
    t.igual(
      await pendencias(t),
      { proximo: pega, vencido: criada3 + 2 * MIN, atrasado: criada3 + 2 * MIN },
      "a trava da mídia venceu",
    );
    t.igual((await pegarRodadas(t)).length, 1, "pegar_rodadas pega a conversa");
  });

  it("conversa armada antes do onboarding: vencida e atrasada só desde a conclusão", async () => {
    await preparar(t);
    await t.sql("update public.configuracao set onboarding_concluido_em = null where id = 1");
    const conv = await conversaArmada(t, "now() - interval '30 minutes'");
    t.igual(await pendencias(t), NADA, "onboarding aberto");
    await t.sql("update public.configuracao set onboarding_concluido_em = now() where id = 1");
    const concluido = await momento(
      t,
      "select onboarding_concluido_em as m from public.configuracao where id = 1",
      [],
    );
    const armada = await momento(
      t,
      "select responder_apos as m from public.conversas where id = $1",
      [conv],
    );
    t.ok(armada < concluido - 29 * MIN, "armada 30 min antes");
    t.igual(
      await pendencias(t),
      { proximo: null, vencido: concluido, atrasado: concluido },
      "desde a conclusão",
    );
    t.igual((await pegarRodadas(t)).length, 1, "pegar_rodadas pega");
  });

  it("conversa armada e saída na fila sem conexão ativa: vencidas só desde a ativação", async () => {
    const { cx } = await preparar(t);
    // a saída nasce com a conexão ativa (o gatilho dela pede uma); depois a conexão cai
    await conversaArmada(t, "now() - interval '30 minutes'");
    const c2 = await novaConversa(t, "humano");
    await saida(t, c2, "now() - interval '30 minutes'");
    const c3 = await novaConversa(t, "humano");
    const futura = await saida(t, c3, "now() + interval '5 minutes'");
    await t.sql("update public.conexoes set ativa = false where id = $1", [cx]);
    t.igual(await pendencias(t), NADA, "nenhuma conexão ativa");
    await t.sql("update public.conexoes set ativa = true where id = $1", [cx]);
    const ativada = await momento(
      t,
      "select max(criado_em) as m from public.conexao_eventos where conexao_id = $1 and ativa_para",
      [cx],
    );
    // proximo_em não muda: a saída futura continua no seu enviar_apos
    const quandoF = await momento(
      t,
      "select enviar_apos as m from public.mensagens where id = $1",
      [futura],
    );
    t.igual(
      await pendencias(t),
      { proximo: quandoF, vencido: ativada, atrasado: ativada },
      "desde a ativação; a futura fica no enviar_apos",
    );
    // a conexão cai e volta só no status, com ativa = true o tempo todo: não é uma ativação nova
    await t.sql("update public.conexoes set status = 'desconectada' where id = $1", [cx]);
    await t.sql("update public.conexoes set status = 'conectada' where id = $1", [cx]);
    // as duas trocas 1 min depois, para a diferença não ser de milissegundos
    await t.sql(
      "update public.conexao_eventos set criado_em = criado_em + interval '1 minute' where conexao_id = $1 and ativa_de and ativa_para",
      [cx],
    );
    t.igual(
      await pendencias(t),
      { proximo: quandoF, vencido: ativada, atrasado: ativada },
      "a troca de status não conta como ativação",
    );
  });

  it("rodada rodando: pronta em iniciada_em + 5 min, sem depender do onboarding; pegar_rodadas limpa", async () => {
    await preparar(t);
    const conv = await novaConversa(t, "humano");
    await t.sql(
      `insert into public.rodadas (conversa_id, status, iniciada_em) values ($1, 'rodando', now() - interval '6 minutes')`,
      [conv],
    );
    const limpeza = await momento(
      t,
      "select iniciada_em as m from public.rodadas where conversa_id = $1",
      [conv],
      5 * MIN,
    );
    await t.sql("update public.configuracao set onboarding_concluido_em = null where id = 1");
    t.igual(
      await pendencias(t),
      { proximo: null, vencido: limpeza, atrasado: limpeza },
      "presa há 6 min",
    );
    await pegarRodadas(t);
    t.igual(await pendencias(t), NADA, "a limpeza fecha a rodada");
  });

  it("saída na fila: futura é proximo_em, vencida é atrasada; pegar_envios pega; só a 1ª da conversa conta", async () => {
    await preparar(t);
    const c1 = await novaConversa(t, "humano");
    const futura = await saida(t, c1, "now() + interval '5 minutes'");
    const quandoF = await momento(
      t,
      "select enviar_apos as m from public.mensagens where id = $1",
      [futura],
    );
    // a 2ª da mesma conversa já venceu, mas só sai depois da 1ª
    await saida(t, c1, "now() - interval '1 minute'");
    t.igual(
      await pendencias(t),
      { proximo: quandoF, vencido: null, atrasado: null },
      "a 2ª espera a 1ª",
    );
    t.igual(await pegarEnvios(t), [], "pegar_envios também não pega");

    const c2 = await novaConversa(t, "humano");
    const vencida = await saida(t, c2, "now() - interval '30 seconds'");
    const quandoV = await momento(
      t,
      "select enviar_apos as m from public.mensagens where id = $1",
      [vencida],
    );
    t.igual(
      await pendencias(t),
      { proximo: quandoF, vencido: quandoV, atrasado: quandoV },
      "vencida",
    );
    t.igual(
      (await pegarEnvios(t)).map((r: Linha) => r.id),
      [vencida],
      "pegar_envios pega a vencida",
    );
    // a vencida virou 'enviando': pronta para a limpeza 2 min depois
    const limpeza = await momento(
      t,
      "select status_em as m from public.mensagens where id = $1",
      [vencida],
      2 * MIN,
    );
    t.igual(
      await pendencias(t),
      { proximo: Math.min(quandoF, limpeza), vencido: null, atrasado: null },
      "enviando",
    );
  });

  it("saída na fila numa conversa com outra enviando: pronta só depois da limpeza dela", async () => {
    await preparar(t);
    const c = await novaConversa(t, "humano");
    const a = await saida(t, c, "now() - interval '1 minute'");
    t.igual((await pegarEnvios(t)).length, 1, "a 1ª sai");
    await saida(t, c, "now() - interval '1 second'");
    const limpeza = await momento(
      t,
      "select status_em as m from public.mensagens where id = $1",
      [a],
      2 * MIN,
    );
    t.igual(
      await pendencias(t),
      { proximo: limpeza, vencido: null, atrasado: null },
      "espera a enviando",
    );
    t.igual(await pegarEnvios(t), [], "pegar_envios também não pega");

    // a enviando está parada há 3 min: a limpeza dela venceu, e a de trás com ela
    await t.sql(
      "update public.mensagens set status_em = now() - interval '3 minutes' where id = $1",
      [a],
    );
    const vencida = await momento(
      t,
      "select status_em as m from public.mensagens where id = $1",
      [a],
      2 * MIN,
    );
    t.igual(
      await pendencias(t),
      { proximo: null, vencido: vencida, atrasado: vencida },
      "a limpeza venceu",
    );
    t.igual((await pegarEnvios(t)).length, 1, "pegar_envios pega");
  });

  it("saída na fila em conexão inativa: sem outra ativa não é pendência; com outra ativa é órfã", async () => {
    const { cx } = await preparar(t);
    const c = await novaConversa(t, "humano");
    const m = await saida(t, c, "now() - interval '1 minute'");
    await t.sql("update public.conexoes set ativa = false where id = $1", [cx]);
    t.igual(await pendencias(t), NADA, "nenhuma conexão ativa");
    t.igual(await pegarEnvios(t), [], "pegar_envios não pega");
    t.igual(
      (await t.sql("select status::text as s from public.mensagens where id = $1", [m]))[0].s,
      "na_fila",
    );

    // outra conexão ativa: a saída da antiga fica órfã desde a ativação da nova
    const [{ id: nova }] = await t.sql(
      `insert into public.conexoes (gateway, nome, id_externo, ativa, status)
       values ('zapi', 'Nova', 'inst-teste-2', true, 'conectada') returning id`,
    );
    const ativada = await momento(t, "select criado_em as m from public.conexoes where id = $1", [
      nova,
    ]);
    t.igual(await pendencias(t), { proximo: null, vencido: ativada, atrasado: ativada }, "órfã");
    t.igual(await pegarEnvios(t), [], "a órfã não sai");
    t.igual(
      (await t.sql("select status::text as s, erro from public.mensagens where id = $1", [m]))[0],
      { s: "falhou", erro: "conexao_inativa" },
      "pegar_envios fecha a órfã",
    );
    t.igual(await pendencias(t), NADA, "depois de fechar");
  });

  it("órfã: a ativação vem do evento da conexão quando ela foi ativada depois de criada", async () => {
    const { cx } = await preparar(t);
    const c = await novaConversa(t, "humano");
    await saida(t, c, "now() - interval '1 minute'");
    const [{ id: nova }] = await t.sql(
      `insert into public.conexoes (gateway, nome, id_externo, ativa, status, criado_em)
       values ('zapi', 'Nova', 'inst-teste-2', false, 'conectada', now() - interval '1 hour') returning id`,
    );
    await t.sql("update public.conexoes set ativa = false where id = $1", [cx]);
    await t.sql("update public.conexoes set ativa = true where id = $1", [nova]);
    const ativada = await momento(
      t,
      "select max(criado_em) as m from public.conexao_eventos where conexao_id = $1 and ativa_para",
      [nova],
    );
    t.igual(
      await pendencias(t),
      { proximo: null, vencido: ativada, atrasado: ativada },
      "desde a ativação",
    );
    // trocar o status com a conexão já ativa grava eventos (ativa de true para true), mas não é
    // uma ativação: a órfã continua vencida desde a ativação de verdade
    await t.sql("update public.conexoes set status = 'desconectada' where id = $1", [nova]);
    await t.sql("update public.conexoes set status = 'conectada' where id = $1", [nova]);
    // as duas trocas 1 min depois, para a diferença não ser de milissegundos
    t.igual(
      (
        await t.sql(
          `update public.conexao_eventos set criado_em = criado_em + interval '1 minute'
            where conexao_id = $1 and ativa_de and ativa_para returning id`,
          [nova],
        )
      ).length,
      2,
      "as trocas de status viraram eventos",
    );
    t.igual(
      await pendencias(t),
      { proximo: null, vencido: ativada, atrasado: ativada },
      "a troca de status não conta como ativação",
    );
  });

  it("enviando: pronta em status_em + 2 min; vencida é atrasada; pegar_envios limpa", async () => {
    await preparar(t);
    const c = await novaConversa(t, "humano");
    const m = await saida(t, c);
    await t.sql(
      "update public.mensagens set status = 'enviando', status_em = now() - interval '1 minute' where id = $1",
      [m],
    );
    const p1 = await momento(
      t,
      "select status_em as m from public.mensagens where id = $1",
      [m],
      2 * MIN,
    );
    t.igual(await pendencias(t), { proximo: p1, vencido: null, atrasado: null }, "há 1 min");
    await t.sql(
      "update public.mensagens set status_em = now() - interval '3 minutes' where id = $1",
      [m],
    );
    const p3 = await momento(
      t,
      "select status_em as m from public.mensagens where id = $1",
      [m],
      2 * MIN,
    );
    t.igual(await pendencias(t), { proximo: null, vencido: p3, atrasado: p3 }, "há 3 min");
    // sem status_em, conta o criado_em
    await t.sql(
      "update public.mensagens set status_em = null, criado_em = now() - interval '4 minutes' where id = $1",
      [m],
    );
    const p4 = await momento(
      t,
      "select criado_em as m from public.mensagens where id = $1",
      [m],
      2 * MIN,
    );
    t.igual(await pendencias(t), { proximo: null, vencido: p4, atrasado: p4 }, "sem status_em");
    await pegarEnvios(t);
    t.igual(
      (await t.sql("select status::text as s from public.mensagens where id = $1", [m]))[0].s,
      "enviando",
      "voltou à fila e saiu de novo na mesma passada",
    );
    const p5 = await momento(
      t,
      "select status_em as m from public.mensagens where id = $1",
      [m],
      2 * MIN,
    );
    t.igual(
      await pendencias(t),
      { proximo: p5, vencido: null, atrasado: null },
      "depois da limpeza",
    );
  });

  it("mídia pendente: com referência é pendência; a trava de 2 min adia; sem referência não é; esgotada é", async () => {
    const { cx } = await preparar(t);
    const c = await novaConversa(t, "humano");
    const m = await entrada(t, c, cx, "ref-midia-1");
    const criada = await momento(t, "select criado_em as m from public.mensagens where id = $1", [
      m,
    ]);
    t.igual(
      await pendencias(t),
      { proximo: null, vencido: criada, atrasado: criada },
      "nunca pega",
    );
    t.igual(
      (await pegarMidias(t)).map((r: Linha) => r.id),
      [m],
      "pegar_midias pega",
    );
    const trava = await momento(
      t,
      "select midia_pega_em as m from public.mensagens where id = $1",
      [m],
      2 * MIN,
    );
    t.igual(await pendencias(t), { proximo: trava, vencido: null, atrasado: null }, "com a trava");
    t.igual(await pegarMidias(t), [], "pegar_midias respeita a trava");
    await t.sql(
      "update public.mensagens set midia_pega_em = now() - interval '3 minutes' where id = $1",
      [m],
    );
    const vencida = await momento(
      t,
      "select midia_pega_em as m from public.mensagens where id = $1",
      [m],
      2 * MIN,
    );
    t.igual(
      await pendencias(t),
      { proximo: null, vencido: vencida, atrasado: vencida },
      "trava vencida",
    );

    // sem referência e com menos de 3 tentativas: o motor nunca pega
    await t.sql(
      "update public.mensagens set midia_ref_externa = null, midia_tentativas = 2, midia_pega_em = null where id = $1",
      [m],
    );
    t.igual(await pendencias(t), NADA, "sem referência");
    t.igual(await pegarMidias(t), [], "pegar_midias não pega");

    // esgotada (3 tentativas), mesmo sem referência: pegar_midias fecha como falhou
    await t.sql("update public.mensagens set midia_tentativas = 3 where id = $1", [m]);
    t.igual(await pendencias(t), { proximo: null, vencido: criada, atrasado: criada }, "esgotada");
    await pegarMidias(t);
    t.igual(
      (await t.sql("select midia_status::text as s from public.mensagens where id = $1", [m]))[0].s,
      "falhou",
      "pegar_midias fechou",
    );
    t.igual(await pendencias(t), NADA, "depois de fechar");
  });

  it("evento do webhook: entra em vencido_desde, nunca em atrasado_desde; 30 s, trava de 2 min e 5 tentativas", async () => {
    const e = await evento(t);
    const p30 = await momento(
      t,
      "select recebido_em as m from public.eventos_webhook where id = $1",
      [e],
      30_000,
    );
    t.igual(await pendencias(t), { proximo: p30, vencido: null, atrasado: null }, "recebido agora");
    await t.sql(
      "update public.eventos_webhook set recebido_em = now() - interval '1 minute' where id = $1",
      [e],
    );
    const p1 = await momento(
      t,
      "select recebido_em as m from public.eventos_webhook where id = $1",
      [e],
      30_000,
    );
    t.igual(
      await pendencias(t),
      { proximo: null, vencido: p1, atrasado: null },
      "atrasado_desde sem eventos",
    );
    t.igual(
      (await pegarEventos(t)).map((r: Linha) => Number(r.id)),
      [e],
      "pegar_eventos_pendentes pega",
    );
    const trava = await momento(
      t,
      "select pego_em as m from public.eventos_webhook where id = $1",
      [e],
      2 * MIN,
    );
    t.igual(await pendencias(t), { proximo: trava, vencido: null, atrasado: null }, "com a trava");
    await t.sql("update public.eventos_webhook set tentativas = 5, pego_em = null where id = $1", [
      e,
    ]);
    t.igual(await pendencias(t), NADA, "5 tentativas");
    t.igual(await pegarEventos(t), [], "pegar_eventos_pendentes não pega");
    await t.sql(
      "update public.eventos_webhook set tentativas = 4, processado_em = now() where id = $1",
      [e],
    );
    t.igual(await pendencias(t), NADA, "processado");
  });

  it("vários tipos juntos: o menor de cada coluna; atrasado_desde ignora o evento mais velho", async () => {
    const { cx } = await preparar(t);
    const ev = await evento(t, { recebido_em: "now() - interval '1 hour'" });
    const pEv = await momento(
      t,
      "select recebido_em as m from public.eventos_webhook where id = $1",
      [ev],
      30_000,
    );
    const conv = await conversaArmada(t, "now() - interval '5 minutes'");
    const pConv = await momento(
      t,
      "select responder_apos as m from public.conversas where id = $1",
      [conv],
    );
    const c2 = await novaConversa(t, "humano");
    const s = await saida(t, c2, "now() + interval '3 minutes'");
    const pS = await momento(t, "select enviar_apos as m from public.mensagens where id = $1", [s]);
    const m = await entrada(t, c2, cx, "ref-midia-2");
    await t.sql("update public.mensagens set midia_pega_em = now() where id = $1", [m]);
    const pM = await momento(
      t,
      "select midia_pega_em as m from public.mensagens where id = $1",
      [m],
      2 * MIN,
    );
    t.igual(
      await pendencias(t),
      { proximo: Math.min(pS, pM), vencido: pEv, atrasado: pConv },
      "o menor de cada",
    );
  });

  it("1.500 conversas armadas e 1.500 eventos: uma linha só, com o menor de cada", async () => {
    await preparar(t);
    await t.sql(`
      insert into public.contatos (nome, telefone)
      select 'Lead em massa ' || i, '5521' || lpad(i::text, 9, '0') from generate_series(1, 1500) i;
      insert into public.conversas (contato_id, responder_apos, ultima_do_lead_em)
      select c.id, now() + make_interval(mins => 1501 - row_number() over (order by c.telefone)::int),
             now()
        from public.contatos c where c.nome like 'Lead em massa %';
      insert into public.eventos_webhook (gateway, id_evento, tipo, payload, recebido_em)
      select 'zapi', 'massa-' || i, 'mensagem', '{}'::jsonb, now() - make_interval(mins => i)
        from generate_series(1, 1500) i;
    `);
    const [{ n }] = await t.sql(
      "select count(*)::int as n from public.conversas where responder_apos is not null",
    );
    t.igual(n, 1500, "1.500 conversas armadas");
    const proximo = await momento(t, "select min(responder_apos) as m from public.conversas", []);
    const vencido = await momento(
      t,
      "select min(recebido_em) as m from public.eventos_webhook",
      [],
      30_000,
    );
    t.igual(await pendencias(t), { proximo, vencido, atrasado: null }, "com 1.500 de cada");
  });

  // -------------------------------------------------------------------------
  // pegar_eventos_pendentes e falhar_evento
  // -------------------------------------------------------------------------

  it("pegar_eventos_pendentes: só os não processados, com menos de 5 tentativas, há mais de 30 s e sem trava", async () => {
    const sim1 = await evento(t, { recebido_em: "now() - interval '1 minute'" });
    await evento(t, { recebido_em: "now() - interval '10 seconds'" });
    await evento(t, { recebido_em: "now() - interval '1 minute'", processado_em: "now()" });
    await evento(t, { recebido_em: "now() - interval '1 minute'", tentativas: "5" });
    const sim2 = await evento(t, { recebido_em: "now() - interval '1 minute'", tentativas: "4" });
    await evento(t, {
      recebido_em: "now() - interval '1 minute'",
      pego_em: "now() - interval '119 seconds'",
    });
    const sim3 = await evento(t, {
      recebido_em: "now() - interval '1 minute'",
      pego_em: "now() - interval '121 seconds'",
    });
    const pegos = await pegarEventos(t);
    t.igual(
      pegos.map((r: Linha) => [Number(r.id), r.gateway, r.conexao_id, r.payload, r.tentativas]),
      [
        [sim1, "zapi", null, { teste: true }, 0],
        [sim2, "zapi", null, { teste: true }, 4],
        [sim3, "zapi", null, { teste: true }, 0],
      ],
      "os pegos, em ordem de id",
    );
    const travados = await t.sql(
      "select id from public.eventos_webhook where pego_em > now() - interval '1 second' order by id",
    );
    t.igual(
      travados.map((r: Linha) => Number(r.id)),
      [sim1, sim2, sim3],
      "pego_em gravado",
    );
    t.igual(await pegarEventos(t), [], "a 2ª passada não pega os mesmos");
    // a trava vence em 2 min
    await t.sql(
      "update public.eventos_webhook set pego_em = now() - interval '121 seconds' where id = $1",
      [sim2],
    );
    t.igual(
      (await pegarEventos(t)).map((r: Linha) => Number(r.id)),
      [sim2],
      "trava vencida",
    );
  });

  it("pegar_eventos_pendentes: o limite pega os de menor id; 0 e nulo não pegam nada", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 3; i++)
      ids.push(await evento(t, { recebido_em: "now() - interval '1 minute'" }));
    t.igual(await pegarEventos(t, 0), [], "limite 0");
    t.igual(await pegarEventos(t, null), [], "limite nulo");
    t.igual(await pegarEventos(t, -1), [], "limite negativo");
    t.igual(
      (await pegarEventos(t, 2)).map((r: Linha) => Number(r.id)),
      ids.slice(0, 2),
      "limite 2",
    );
    t.igual(
      (await pegarEventos(t, 2)).map((r: Linha) => Number(r.id)),
      ids.slice(2),
      "o que sobrou",
    );
  });

  it("pegar_eventos_pendentes trava com SKIP LOCKED e devolve os tipos do contrato", async () => {
    const [f] = await t.sql(
      `select p.prosrc ilike '%for update of e skip locked%' as trava,
              pg_get_function_result(p.oid) as res
         from pg_proc p where p.oid = 'public.pegar_eventos_pendentes(int)'::regprocedure`,
    );
    t.igual(f.trava, true, "for update skip locked");
    t.igual(
      f.res,
      "TABLE(id bigint, gateway gateway, conexao_id uuid, payload jsonb, tentativas smallint)",
      "colunas",
    );
  });

  it("falhar_evento: soma 1 tentativa, grava o erro (até 200) e solta a trava; processado não muda", async () => {
    const e = await evento(t, { recebido_em: "now() - interval '1 minute'" });
    await pegarEventos(t);
    await servidor(t, "select public.falhar_evento($1, $2)", [e, "x".repeat(250)]);
    const [a] = await t.sql(
      "select tentativas, erro, pego_em from public.eventos_webhook where id = $1",
      [e],
    );
    t.igual([a.tentativas, a.erro, a.pego_em], [1, "x".repeat(200), null], "1ª falha");
    t.igual(
      (await pegarEventos(t)).map((r: Linha) => Number(r.id)),
      [e],
      "sem trava, volta a ser pego",
    );
    await servidor(t, "select public.falhar_evento($1, $2)", [e, "status_sem_mensagem"]);
    const [b] = await t.sql("select tentativas, erro from public.eventos_webhook where id = $1", [
      e,
    ]);
    t.igual([b.tentativas, b.erro], [2, "status_sem_mensagem"], "2ª falha");
    for (let i = 0; i < 3; i++) await servidor(t, "select public.falhar_evento($1, 'x')", [e]);
    t.igual(await pegarEventos(t), [], "com 5 tentativas, não é mais pego");

    const p = await evento(t, { processado_em: "now()" });
    await servidor(t, "select public.falhar_evento($1, 'x')", [p]);
    const [c] = await t.sql("select tentativas, erro from public.eventos_webhook where id = $1", [
      p,
    ]);
    t.igual([c.tentativas, c.erro], [0, null], "o processado não muda");
    await servidor(t, "select public.falhar_evento($1, 'x')", [999_999]);
  });

  // -------------------------------------------------------------------------
  // permissões
  // -------------------------------------------------------------------------

  it("permissões: só o servidor executa, menos motor_pendencias (membro também); ninguém lê a tabela", async () => {
    const funcoes = [
      "public.motor_endereco(text)",
      "public.acordar_motor(boolean)",
      "public.motor_confere(text)",
      "public.motor_pendencias()",
      "public.pegar_eventos_pendentes(int)",
      "public.falhar_evento(bigint, text)",
    ];
    const exec = await t.sql(
      `select f, papel, has_function_privilege(papel, f, 'execute') as pode
         from unnest($1::text[]) with ordinality as x(f, i),
              unnest(array['anon', 'authenticated', 'service_role']) papel
        order by i, papel`,
      [funcoes],
    );
    t.igual(
      exec.map((r: Linha) => [r.f, r.papel, r.pode]),
      funcoes.flatMap((f) => [
        [f, "anon", false],
        [f, "authenticated", f === "public.motor_pendencias()"],
        [f, "service_role", true],
      ]),
      "execute",
    );
    const publico = await t.sql(
      `select p.proname from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where p.oid = any ($1::regprocedure[]) and a.grantee = 0`,
      [funcoes],
    );
    t.igual(publico, [], "nada para PUBLIC");

    const tab = await t.sql(
      `select papel, string_agg(p, ',' order by p) as ps
         from unnest(array['anon', 'authenticated', 'service_role']) papel,
              unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p
        where has_table_privilege(papel, 'public.motor', p)
        group by 1`,
    );
    t.igual(tab, [], "nenhum privilégio na tabela");
    const [rls] = await t.sql(
      `select relrowsecurity as r from pg_class where oid = 'public.motor'::regclass`,
    );
    t.igual(rls.r, true, "RLS ligada");
    const [{ n }] = await t.sql(
      `select count(*)::int as n from pg_policies where schemaname = 'public' and tablename = 'motor'`,
    );
    t.igual(n, 0, "sem policy");

    const def = await t.sql(
      `select p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as dono, l.lanname as lingua
         from pg_proc p join pg_language l on l.oid = p.prolang
        where p.oid = any ($1::regprocedure[]) order by p.proname`,
      [funcoes],
    );
    t.igual(
      def.map((r: Linha) => [r.proname, r.prosecdef, r.proconfig, r.dono, r.lingua]),
      [...FUNCOES_M1].sort().map((f) => [f, true, ['search_path=""'], "dono_app", "plpgsql"]),
      "plpgsql, security definer, search_path vazio e dono",
    );

    // chamadas de verdade
    await endereco(t, URL_A);
    for (const papel of ["anon", "authenticated"] as const) {
      for (const sql of [
        "select public.motor_endereco('https://outro.exemplo.test')",
        "select public.acordar_motor()",
        "select public.acordar_motor(true)",
        "select public.motor_confere('x')",
        "select * from public.pegar_eventos_pendentes(10)",
        "select public.falhar_evento(1, 'x')",
        "select * from public.motor",
        "update public.motor set url = null",
      ])
        await t.erro(
          t.como(papel, null, (q) => q(sql)),
          "permission denied",
        );
    }
    await t.erro(
      t.como("anon", null, (q) => q("select * from public.motor_pendencias()")),
      "permission denied",
    );
    for (const sql of [
      "select chave from public.motor",
      "update public.motor set url = null",
      "insert into public.motor (id) values (true)",
      "delete from public.motor",
    ])
      await t.erro(
        t.como("service_role", null, (q) => q(sql)),
        "permission denied",
      );
    t.igual((await linha(t))[0].url, URL_A, "nada mudou");
    t.igual(await chamadas(t), [], "nenhum toque");
  });

  it("motor_pendencias: o servidor e o membro ativo leem; conta sem membro e membro inativo recebem sem_acesso", async () => {
    const uAdmin = await t.criarUsuario("admin@empresa.exemplo", "Admin");
    const uSem = await t.criarUsuario("sem-membro@empresa.exemplo", "Sem membro");
    const uAtend = await t.criarUsuario("atendente@empresa.exemplo", "Atendente");
    await t.sql(
      `insert into public.membros (user_id, nome, email, papel) values ($1, 'Atendente', 'atendente@empresa.exemplo', 'atendente')`,
      [uAtend],
    );
    const ler = (papel: "authenticated" | "service_role", u: string | null) =>
      t.como(papel, u, (q) => q("select * from public.motor_pendencias()"));
    t.igual((await ler("service_role", null)).length, 1, "servidor");
    t.igual((await ler("authenticated", uAdmin)).length, 1, "admin");
    t.igual((await ler("authenticated", uAtend)).length, 1, "atendente");
    await t.erro(ler("authenticated", uSem), "sem_acesso");
    await t.erro(ler("authenticated", null), "sem_acesso");
    await t.sql("update public.membros set ativo = false where user_id = $1", [uAtend]);
    await t.erro(ler("authenticated", uAtend), "sem_acesso");
  });

  it("a chave nunca sai do banco: só acordar_motor e motor_confere a leem, e nenhuma devolve", async () => {
    const leem = await t.sql(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosrc ~* '\\.chave\\M' and p.prosrc ~* 'public\\.motor\\M'
        order by 1`,
    );
    t.igual(
      leem.map((r: Linha) => r.proname),
      ["acordar_motor", "motor_confere"],
      "as funções que leem a chave",
    );
    const res = await t.sql(
      `select p.proname, pg_get_function_result(p.oid) as res from pg_proc p
        where p.oid = any (array['public.acordar_motor(boolean)', 'public.motor_confere(text)']::regprocedure[])
        order by 1`,
    );
    t.igual(
      res.map((r: Linha) => [r.proname, r.res]),
      [
        ["acordar_motor", "text"],
        ["motor_confere", "boolean"],
      ],
      "devolvem só texto fixo e sim ou não",
    );
    const [{ chave }] = await linha(t);
    await endereco(t, URL_A);
    const saidas = [
      await acordar(t),
      await acordar(t),
      await confere(t, chave),
      await pendencias(t),
      await pegarEventos(t),
    ];
    t.ok(!JSON.stringify(saidas).includes(chave), "nenhuma saída tem a chave");
  });
});
