// @vitest-environment node
// Retornos da Nina no banco (o que o Davi aprovou: a spec):
// a tabela retornos e a marca rodadas.retorno_id, o ajuste do lembrete, a irmã
// pegar_rodadas_com_retornos (faixas 0, 1 e 2 e o "levar junto"), as ferramentas da Nina
// (nina_marcar_retorno, nina_cancelar_retorno, nina_retorno_da_rodada), o Cancelar da equipe, o fim da
// rodada (concluir_rodada e falhar_rodada recriadas), o gatilho das bolhas, a varredura, o relógio
// nina-retornos, a motor_pendencias_com_retornos e a preparar_copia com os dois jobs.
//
// Os 6 envios, na ordem em que são aplicados: nina_retornos_tabelas, nina_retornos_regras,
// nina_retornos_funcoes, nina_retornos_rodada, nina_retornos_dashboard e nina_retornos_relogio. Eles
// entram na base um por vez; o nina_retornos_tabelas já entrou (base 0042, drizzle 0020), sem a
// coluna retornos.lembrete_horas, que nasce no nina_retornos_regras (a revisão das funções a pediu
// depois de ele estar aplicado). Cada grupo de testes roda quando o banco tem os envios de que precisa
// (na base, ou em NINA_SQL_EXTRA); antes disso, fica pulado. A "montagem" não pula: com um envio
// pela metade, fora de ordem ou com o arquivo sem as funções, ela falha dizendo o que falta. Os
// envios são citados pelo nome, nunca pelo número.
//
// O banco local não controla o relógio (now() é o real). As regras de hora do dia são conferidas
// pelas funções puras, com o instante dado; os outros testes mexem nas colunas de data. Nenhum teste
// depende da hora em que a suíte roda.
//
// A volta atrás pesada (nina_retornos_desfazer.sql) nunca vai em NINA_SQL_EXTRA (que a aplicaria em
// todos os arquivos de teste). O grupo dela roda sozinho quando o arquivo está no lugar fixo
// (src/test/banco/nina_retornos_desfazer.sql, sem o prefixo NNNN_: a montagem nunca o aplica) ou
// ao lado de um envio testado de fora da base (o nina_retornos_rodada, o nina_retornos_funcoes ou um
// arquivo de NINA_SQL_EXTRA); NINA_SQL_DESFAZER (caminho absoluto) só serve para apontar outro
// caminho. Com os 6 envios no banco e o desfazer ainda não aplicado, a montagem cobra o arquivo (sem
// ele, o grupo que confere a lista de hashes dele pularia em silêncio). Quando o desfazer estiver na
// base (virou migration), os grupos do fluxo pulam.
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { describe, it } from "vitest";
import {
  arquivosBase,
  arquivosExtra,
  arquivosMigrations,
  limparSql,
  montarBase,
  PASTA_MIGRATIONS,
  RAIZ,
  temFuncao,
  temValorEnum,
  TEMPO_TESTE,
  usarBanco,
  type Banco,
  type Base,
  type Linha,
} from "./montar";

const base = await montarBase();

const migrations = await arquivosMigrations();
const extras = arquivosExtra();
const acharArquivo = (parte: string) =>
  migrations.find((a) => basename(a).includes(parte)) ??
  extras.find((a) => basename(a).includes(parte));
const arqTabelas = acharArquivo("nina_retornos_tabelas");
const arqRegras = acharArquivo("nina_retornos_regras");
const arqFuncoes = acharArquivo("nina_retornos_funcoes");
const arqRodada = acharArquivo("nina_retornos_rodada");
const arqDashboard = acharArquivo("nina_retornos_dashboard");
const arqRelogio = acharArquivo("nina_retornos_relogio");
// A volta atrás pesada: o caminho de NINA_SQL_DESFAZER; sem ela, o lugar fixo no repositório
// (src/test/banco/nina_retornos_desfazer.sql, que vai junto no remix e não some com a sessão); sem
// ele, o nina_retornos_desfazer.sql ao lado de um envio que ainda pode mudar (o nina_retornos_rodada,
// o nina_retornos_funcoes ou um arquivo de NINA_SQL_EXTRA). Assim a lista de hashes dele é conferida
// pelo comando padrão. O lugar fixo não conta como "desfeito" (só a cópia dele na base conta).
const ARQ_DESFAZER = (() => {
  const dado = (process.env["NINA_SQL_DESFAZER"] ?? "").trim();
  if (dado) return dado;
  const fixo = join(RAIZ, "src", "test", "banco", "nina_retornos_desfazer.sql");
  if (existsSync(fixo)) return fixo;
  for (const arq of [arqRodada, arqFuncoes, ...extras]) {
    if (!arq) continue;
    const c = join(dirname(arq), "nina_retornos_desfazer.sql");
    if (existsSync(c)) return c;
  }
  return "";
})();

// As funções do nina_retornos_regras (todas internas) e as do nina_retornos_funcoes (as do
// servidor, as da equipe e as internas), e a do gatilho das bolhas (nina_retornos_rodada).
const FUNCOES_REGRAS = [
  "rodada_tem_fala_do_lead",
  "retorno_instante",
  "lembrete_vence_em",
  "lembrete_expira_em",
  "whatsapp_conectado_desde",
  "retornos_no_ar",
  "retorno_conversa_livre",
  "retornos_prontos",
  "retorno_pelas_bolhas",
  "retorno_volta",
  "retornos_varrer",
];
const SERVIDOR = [
  "pegar_rodadas_com_retornos",
  "nina_retorno_da_rodada",
  "nina_marcar_retorno",
  "nina_cancelar_retorno",
];
const EQUIPE = ["cancelar_retorno", "motor_pendencias_com_retornos"];
const INTERNAS_FUNCOES = [
  "retornos_ligados",
  "lembrete_ao_concluir",
  "retorno_ao_concluir",
  "retorno_ao_falhar",
  "relogio_retornos",
];
const FUNCOES_FUNCOES = [...SERVIDOR, ...EQUIPE, ...INTERNAS_FUNCOES];
const GATILHO = "tg_mensagens_saida_do_retorno";

// O nina_retornos_relogio só se vê pela preparar_copia em vigor: ela instala o job nina-retornos.
async function preparaDoisJobs(b: Base): Promise<boolean> {
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp }, loadDataDir: b.dump });
  try {
    await db.waitReady;
    const r = await db.query<{ dois: boolean }>(
      `select coalesce((select p.prosrc ~ 'nina-retornos' from pg_proc p
                         where p.oid = to_regprocedure('public.preparar_copia()')), false) as dois`,
    );
    return r.rows[0]?.dois === true;
  } finally {
    await db.close();
  }
}

// O nina_retornos_dashboard só se vê pela dashboard_periodo em vigor: ela passa a olhar
// rodadas.retorno_id.
async function dashboardSemPuras(b: Base): Promise<boolean> {
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp }, loadDataDir: b.dump });
  try {
    await db.waitReady;
    const r = await db.query<{ tem: boolean }>(
      `select coalesce((select p.prosrc ~ 'retorno_id' from pg_proc p
                         where p.oid = to_regprocedure('public.dashboard_periodo(timestamptz, timestamptz, timestamptz)')), false) as tem`,
    );
    return r.rows[0]?.tem === true;
  } finally {
    await db.close();
  }
}

// Cada envio pela sua marca no banco montado. Os estados encadeiam: o nina_retornos_funcoes exige o
// nina_retornos_regras, que exige o nina_retornos_tabelas. A "montagem" olha as marcas cruas e
// cobra a ordem; os grupos usam os estados encadeados.
const temTabelas = temValorEnum(base, "retorno_status", "pendente");
const marcaRegras = temFuncao(base, "retornos_varrer");
const marcaFuncoes = temFuncao(base, "pegar_rodadas_com_retornos");
const temRegras = temTabelas && marcaRegras;
const temFuncoes = temRegras && marcaFuncoes;
const temRodada = temFuncao(base, GATILHO);
const temRelogio = await preparaDoisJobs(base);
const temDashboard = temTabelas && (await dashboardSemPuras(base));
// Depois da volta atrás pesada (nina_retornos_desfazer, copiada para a base), o fim da rodada, a
// irmã e o lembrete voltam ao de antes, mas as funções e o gatilho ficam: os grupos do fluxo pulam,
// como em retornos-rodada.test.ts (se o nina_retornos_funcoes e o nina_retornos_rodada forem
// reaplicados depois dela, rever esta regra). A estrutura, as regras puras e as permissões
// (temTabelas, temRegras, temFuncoes) continuam testadas.
const desfeito = !!acharArquivo("nina_retornos_desfazer");
const temFluxo = temFuncoes && temRodada && !desfeito;
const temTudo = temFluxo && temRelogio;
// A "permissão no chat" (base 0041, outra entrega): o pedido e a resposta viram mensagens.
const temPermissao =
  temFuncao(base, "ligacao_permissao_registrar") && temFuncao(base, "ligacao_permissao_responder");

// Base sem os retornos (para provar as travas): só a base (src/test/banco/base), sem NINA_SQL_EXTRA
// nem as migrations do Lovable ainda sem cópia. Com o nina_retornos_tabelas já copiado para a base
// (hoje: a 0042, que é a drizzle 0020), corta pelo nome da cópia: ela e o que vem depois ficam fora
// (a 0000 a 0041). Se ele não estivesse na base (em NINA_SQL_EXTRA, ou só em drizzle/migrations,
// com a numeração de lá), a base inteira menos qualquer arquivo dos retornos. A montagem confere que
// ela fica sem nada dos retornos (senão as provas de "sem o nina_retornos_tabelas" não provariam
// nada). Basta o nina_retornos_tabelas: cada prova pula sem o arquivo de que precisa.
const nomeR1 =
  arqTabelas && (await arquivosBase()).includes(arqTabelas) ? basename(arqTabelas) : null;
const baseSem =
  temTabelas && arqTabelas
    ? await montarBase({
        semExtra: true,
        filtroMigrations: (nome: string) => (nomeR1 ? nome < nomeR1 : !/nina_retornos_/.test(nome)),
      })
    : null;
const provaTrava = !!baseSem && !temValorEnum(baseSem, "retorno_status", "pendente");

const DOM = "empresa.exemplo";
const MIN = 60_000;
const HORA = 60 * MIN;

// ---------------------------------------------------------------------------
// ajudantes
// ---------------------------------------------------------------------------

/** Um instante (Date, texto ISO ou nulo) em milissegundos. */
const ms = (v: unknown): number | null =>
  v === null || v === undefined
    ? null
    : typeof v === "number"
      ? v
      : v instanceof Date
        ? v.getTime()
        : new Date(String(v)).getTime();

function perto(t: Banco, a: unknown, b: unknown, tolerancia: number, msg: string): void {
  const x = ms(a);
  const y = ms(b);
  t.ok(
    x !== null &&
      y !== null &&
      !Number.isNaN(x) &&
      !Number.isNaN(y) &&
      Math.abs(x - y) <= tolerancia,
    `${msg}: veio ${String(a)}, esperava perto de ${String(b)} (±${tolerancia} ms)`,
  );
}

const servidor = (t: Banco, texto: string, params: unknown[] = []) =>
  t.como("service_role", null, (q) => q(texto, params));

/** Roda um SQL como o dono das funções do app (como o pg_cron roda). */
async function comoDono(t: Banco, texto: string) {
  await t.sql("set role dono_app");
  try {
    return await t.sql(texto);
  } finally {
    await t.sql("reset role");
  }
}

interface Preparo {
  uAdmin: string;
  mAdmin: string;
  uAtend: string;
  mAtend: string;
  uSem: string;
  cx: string;
  etapas: Record<string, string>;
}

/**
 * A versão do relógio (motor.relogio_versao, do nina_retornos_tabelas): com 1, e com o gatilho das
 * bolhas do nina_retornos_rodada, os retornos ficam ligados na pegar_rodadas_com_retornos e na
 * nina_marcar_retorno. Sem a coluna (antes do nina_retornos_tabelas), nada a fazer.
 */
async function ligarRetornos(t: Banco, ligar: boolean): Promise<void> {
  await t.sql(`
    do $l$
    begin
      if exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'motor' and column_name = 'relogio_versao') then
        execute 'update public.motor set relogio_versao = ${ligar ? 1 : 0}';
      end if;
    end;
    $l$;
  `);
}

/**
 * Sem o nina_retornos_rodada, a retornos_ligados de verdade dá falso (ela confere o conteúdo dele):
 * uma de mentira que só olha a versão do relógio, só no banco de teste, para provar no estado que
 * fica dias na main o que vale com os retornos ligados.
 */
async function ligadosDeMentira(t: Banco): Promise<void> {
  await t.sql(
    `create or replace function public.retornos_ligados() returns boolean language sql stable security definer
       set search_path = '' as 'select coalesce((select mo.relogio_versao >= 1 from public.motor mo where mo.id), false)'`,
  );
}

// Admin (1ª conta), um atendente, uma conta sem convite, a conexão ativa e conectada e o onboarding
// concluído, os dois há 1 dia: o "pronto" de um retorno nunca vem antes deles. Os retornos ligados.
async function preparar(t: Banco, { gateway = "zapi" } = {}): Promise<Preparo> {
  const uAdmin = await t.criarUsuario(`admin@${DOM}`, "Admin");
  const [{ id: mAdmin }] = await t.sql("select id from public.membros where user_id = $1", [
    uAdmin,
  ]);
  const uAtend = await t.criarUsuario(`atendente@${DOM}`, "Atendente");
  const [{ id: mAtend }] = await t.sql(
    `insert into public.membros (user_id, nome, email, papel) values ($1, 'Atendente', $2, 'atendente') returning id`,
    [uAtend, `atendente@${DOM}`],
  );
  const uSem = await t.criarUsuario(`sem-convite@${DOM}`, "Sem convite");
  const oficial = gateway === "meta";
  const [{ id: cx }] = await t.sql(
    `insert into public.conexoes (gateway, nome, id_externo, ativa, status, criado_em, parametros)
     values ($1, 'Conexão de teste', $2, true, 'conectada', now() - interval '1 day', $3::jsonb) returning id`,
    [
      gateway,
      oficial ? "106540352242333" : "inst-teste-1",
      JSON.stringify(oficial ? { ligacoes: { situacao: "ativa" } } : {}),
    ],
  );
  await t.sql(
    "update public.configuracao set onboarding_concluido_em = now() - interval '1 day' where id = 1",
  );
  // o relógio da versão 1 (dado de teste): em produção, só a preparar_copia() do
  // nina_retornos_relogio o grava. Assim o fluxo também roda no banco com o nina_retornos_rodada e
  // sem o nina_retornos_relogio; o grupo "os retornos desligados" volta a versão a 0.
  await ligarRetornos(t, true);
  const etapas: Record<string, string> = {};
  for (const r of await t.sql("select chave, id from public.etapas where chave is not null"))
    etapas[r.chave as string] = r.id as string;
  return { uAdmin, mAdmin, uAtend, mAtend, uSem, cx, etapas };
}

let seq = 0;
const tel = (n: number) => `55119${String(n).padStart(8, "0")}`;

async function entrada(
  t: Banco,
  cx: string,
  telefone: string,
  extra: Record<string, unknown> = {},
) {
  seq += 1;
  const m = {
    id_externo: `w-rt-${seq}`,
    tipo: "texto",
    texto: `oi ${seq}`,
    momento: new Date().toISOString(),
    ...extra,
  };
  const [r] = await servidor(
    t,
    "select * from public.registrar_entrada($1, $2::jsonb, 'Lead de teste', $3::jsonb)",
    [cx, JSON.stringify([{ tipo: "telefone", valor: telefone }]), JSON.stringify(m)],
  );
  return r as { mensagem_id: string; conversa_id: string };
}

const vencer = (t: Banco, conversa: string) =>
  t.sql("update public.conversas set responder_apos = now() - interval '1 second' where id = $1", [
    conversa,
  ]);

/** A irmã, como o servidor novo: pegar_rodadas_com_retornos(limite, limite das puras). */
const pegar = (t: Banco, limite = 3, puras = 3) =>
  servidor(t, "select * from public.pegar_rodadas_com_retornos($1, $2)", [limite, puras]);

/** A pegar_rodadas de hoje (o servidor publicado). */
const pegarAntiga = (t: Banco, limite = 10) =>
  servidor(t, "select * from public.pegar_rodadas($1)", [limite]);

const sqlConcluir = "select public.concluir_rodada($1, $2::jsonb, $3::jsonb, $4)";
const paramsConcluir = (
  rodada: string,
  textos: string[],
  ferramentas: unknown[],
  passos: number,
) => [
  rodada,
  JSON.stringify(textos.map((texto) => ({ texto }))),
  JSON.stringify(ferramentas),
  passos,
];

async function concluir(
  t: Banco,
  rodada: string,
  textos: string[],
  ferramentas: unknown[] = [],
  passos = 1,
) {
  await servidor(t, sqlConcluir, paramsConcluir(rodada, textos, ferramentas, passos));
}

const falhar = (t: Banco, rodada: string, motivo = "erro_provedor", passageiro = true) =>
  servidor(t, "select public.falhar_rodada($1, $2::public.motivo_humano, $3)", [
    rodada,
    motivo,
    passageiro,
  ]);

/** O item do responder em p_ferramentas ({passo, ferramenta, entrada, resultado}). */
const responder = (espera?: string, aceito = true, passo = 1) => ({
  passo,
  ferramenta: "responder",
  entrada: { mensagens: ["Oi"], ...(espera === undefined ? {} : { espera_resposta: espera }) },
  resultado: aceito ? { ok: true } : { erro: "retorno_recusado" },
});
const semResposta = (motivo: string, aceito = true) => ({
  passo: 1,
  ferramenta: "sem_resposta",
  entrada: { motivo },
  resultado: aceito ? { ok: true } : { erro: "retorno_recusado" },
});

/** Leva todas as bolhas na fila até 'enviada', pela fila de verdade. */
async function enviarTudo(t: Banco): Promise<void> {
  for (let i = 0; i < 100; i++) {
    await t.sql(
      "update public.mensagens set enviar_apos = now() - interval '1 second' where direcao = 'saida' and status = 'na_fila'",
    );
    const env = await servidor(t, "select id from public.pegar_envios(50)");
    if (env.length === 0) return;
    for (const e of env) {
      seq += 1;
      await servidor(t, "select public.concluir_envio($1, $2, null)", [e.id, `ext-rt-${seq}`]);
    }
  }
  throw new Error("enviarTudo: a fila não esvaziou");
}

/** Uma conversa em que o lead falou e a rodada dele está rodando. */
async function rodadaDoLead(t: Banco, b: Preparo, telefone: string) {
  const e = await entrada(t, b.cx, telefone);
  await vencer(t, e.conversa_id);
  const rs = (await pegar(t, 10, 0)).filter((r: Linha) => r.conversa_id === e.conversa_id);
  t.igual(rs.length, 1, "a rodada do lead");
  return { conversa: e.conversa_id, rodada: rs[0] as Linha, entrada: e.mensagem_id };
}

/** Uma conversa atendida: o lead falou, a Nina respondeu e as bolhas saíram (por padrão). */
async function atendida(
  t: Banco,
  b: Preparo,
  telefone: string,
  { ferramentas = [] as unknown[], enviar = true } = {},
) {
  const r = await rodadaDoLead(t, b, telefone);
  t.igual(r.rodada.retorno_id, null, "rodada comum");
  await concluir(t, r.rodada.id, ["Oi! Posso ajudar?"], ferramentas);
  if (enviar) await enviarTudo(t);
  return { conversa: r.conversa, rodada: r.rodada.id as string, entrada: r.entrada };
}

async function marcar(
  t: Banco,
  rodada: string,
  data: string | null,
  hora: string | null,
  motivo = "Retomar a proposta",
) {
  const [r] = await servidor(
    t,
    "select public.nina_marcar_retorno($1, $2::date, $3::time, $4) as r",
    [rodada, data, hora, motivo],
  );
  return r.r as Linha;
}

async function ninaCancela(t: Banco, rodada: string, motivo: string | null) {
  const [r] = await servidor(t, "select public.nina_cancelar_retorno($1, $2) as r", [
    rodada,
    motivo,
  ]);
  return r.r as Linha;
}

const equipeCancela = (t: Banco, uid: string | null, retorno: string) =>
  t.como("authenticated", uid, (q) => q("select public.cancelar_retorno($1)", [retorno]));

async function daRodada(t: Banco, rodada: string) {
  const [r] = await servidor(t, "select public.nina_retorno_da_rodada($1) as r", [rodada]);
  return r.r as Linha;
}

const assumir = (t: Banco, uid: string, c: string) =>
  t.como("authenticated", uid, (q) => q("select public.assumir_conversa($1)", [c]));
const devolver = (t: Banco, uid: string, c: string) =>
  t.como("authenticated", uid, (q) => q("select public.devolver_para_nina($1)", [c]));

/** Data e hora de Brasília de um instante (expressão SQL), e o instante cortado no minuto. */
async function local(t: Banco, expr: string) {
  const [r] = await t.sql(
    `select to_char(x at time zone 'America/Sao_Paulo', 'YYYY-MM-DD') as data,
            to_char(x at time zone 'America/Sao_Paulo', 'HH24:MI') as hora,
            date_trunc('minute', x) as em
       from (select ${expr} as x) s`,
  );
  return r as { data: string; hora: string; em: Date };
}

/** Amanhã (no calendário de Brasília) na hora dada. */
async function amanha(t: Banco, hora = "09:00") {
  const [r] = await t.sql(
    "select to_char((now() at time zone 'America/Sao_Paulo')::date + 1, 'YYYY-MM-DD') as data",
  );
  const data = r.data as string;
  return { data, hora, em: new Date(`${data}T${hora}:00-03:00`) };
}

/** Uma conversa com um retorno marcado pela Nina (amanhã 09:00, por padrão) e a resposta enviada. */
async function comRetorno(
  t: Banco,
  b: Preparo,
  telefone: string,
  quando?: { data: string; hora: string },
) {
  const r = await rodadaDoLead(t, b, telefone);
  const q = quando ?? (await amanha(t));
  const res = await marcar(t, r.rodada.id, q.data, q.hora);
  t.igual(res.ok, true, `marcou: ${JSON.stringify(res)}`);
  await concluir(t, r.rodada.id, ["Combinado, te chamo na hora marcada."], [responder("nao")]);
  await enviarTudo(t);
  return { conversa: r.conversa, rodada: r.rodada.id as string, retorno: res.retorno_id as string };
}

/** Grava um retorno ou lembrete pendente direto (superusuário, só no banco de teste). */
async function inserir(
  t: Banco,
  conversa: string,
  {
    tipo = "retorno",
    vence = "now() - interval '1 minute'",
    expira = "now() + interval '1 hour'",
    marcado = "now()",
  } = {},
): Promise<string> {
  const [{ id }] = await t.sql(
    `insert into public.retornos (conversa_id, tipo, vence_em, expira_em, marcado_em, motivo)
     values ($1, $2::public.retorno_tipo, ${vence}, ${expira}, ${marcado}, $3) returning id`,
    [conversa, tipo, tipo === "retorno" ? "Retomar a proposta" : null],
  );
  return id as string;
}

/**
 * Desloca um retorno ou lembrete para "venceu há pouco" (dentro do prazo). No lembrete, a pergunta
 * da rodada que o armou também envelhece: as bolhas dela que já saíram ficam com o momento de
 * lembrete_horas (as do lembrete, com que ele foi armado; sem elas, as do ajuste) e mais 1 min atrás
 * (o lembrete só cobra a pergunta que saiu há essas horas). A bolha que ainda está na fila não muda.
 */
async function vencerRetorno(t: Banco, id: string, ha = "1 minute") {
  await t.sql(
    `update public.retornos set vence_em = now() - interval '${ha}', expira_em = now() + interval '1 hour' where id = $1`,
    [id],
  );
  await t.sql(
    `update public.mensagens m
        set momento = least(m.momento,
                            now() - make_interval(hours => coalesce(rt.lembrete_horas, cf.lembrete_horas)) - interval '1 minute')
       from public.retornos rt, public.configuracao cf
      where rt.id = $1 and rt.tipo = 'lembrete' and cf.id = 1
        and m.rodada_id = rt.rodada_origem_id and m.direcao = 'saida' and m.origem = 'nina'
        and m.status in ('enviada', 'entregue', 'lida')`,
    [id],
  );
}

const COLS = `id, conversa_id, tipo::text as tipo, status::text as status, vence_em, expira_em, tentar_apos,
  motivo, marcado_em, rodada_origem_id, substitui_id, rodada_id, tentativas, enviado_em, resolvido_em,
  nao_enviado_motivo, cancelado_por, fechado_por_rodada, nota_fim, atualizado_em`;

async function retorno(t: Banco, id: string): Promise<Linha> {
  const [r] = await t.sql(`select ${COLS} from public.retornos where id = $1`, [id]);
  return r;
}

const retornosDa = (t: Banco, conversa: string) =>
  t.sql(
    `select ${COLS} from public.retornos where conversa_id = $1 order by criado_em, marcado_em, id`,
    [conversa],
  );

async function estado(t: Banco, id: string): Promise<[string, string | null]> {
  const r = await retorno(t, id);
  t.ok(r, `o retorno ${id} existe`);
  return [r.status as string, (r.nao_enviado_motivo as string | null) ?? null];
}

async function conversaDe(t: Banco, id: string) {
  const [c] = await t.sql(
    `select modo::text as modo, responder_apos, motivo_humano::text as motivo_humano, ultima_do_lead_em
       from public.conversas where id = $1`,
    [id],
  );
  return c as Linha;
}

const contar = async (t: Banco, texto: string, params: unknown[] = []) =>
  (await t.sql(`select count(*)::int as n from (${texto}) x`, params))[0].n as number;

const saidasDa = (t: Banco, rodada: string) =>
  contar(t, "select 1 from public.mensagens where rodada_id = $1 and direcao = 'saida'", [rodada]);

const varrer = async (t: Banco, max = 500) =>
  (await comoDono(t, `select public.retornos_varrer(${max}) as n`))[0].n as number;

const relogio = (t: Banco) => comoDono(t, "select public.relogio_retornos()");

/** A varredura como o dono, com os avisos (raise warning) que ela deixar. */
async function varrerComAvisos(t: Banco, max = 500): Promise<{ n: number; avisos: string[] }> {
  const avisos: string[] = [];
  await t.sql("set role dono_app");
  try {
    const r = await t.db.query<{ n: number }>(`select public.retornos_varrer(${max}) as n`, [], {
      onNotice: (m) => avisos.push(String(m.message ?? "")),
    });
    return { n: r.rows[0]!.n, avisos };
  } finally {
    await t.sql("reset role");
  }
}

// A "permissão no chat" (base 0040 e 0041, outra entrega): o pedido de permissão para ligar e a
// resposta do lead viram mensagens da conversa, pelas funções de verdade.
let wamids = 0;

/** O pedido (ligacao_permissao_registrar): saída da Nina, já enviada, numa rodada concluída. */
async function pedirPermissao(t: Banco, b: Preparo, conversa: string): Promise<string> {
  wamids += 1;
  const wamid = `wamid.pedido-rt-${wamids}`;
  await servidor(t, "select public.ligacao_permissao_registrar($1, $2, $3, $4, $5, now())", [
    conversa,
    b.cx,
    wamid,
    b.mAdmin,
    "Posso te ligar pelo WhatsApp?",
  ]);
  return wamid;
}

/** A resposta do lead ao pedido (ligacao_permissao_responder): entrada do tipo permissao_ligacao. */
async function responderPermissao(
  t: Banco,
  b: Preparo,
  wamid: string,
  resposta = "aceitou",
): Promise<void> {
  const [r] = await servidor(
    t,
    "select public.ligacao_permissao_responder($1, $2, $3, $4, null, now(), $5) as n",
    [
      b.cx,
      wamid,
      resposta,
      resposta === "aceitou" ? false : null,
      resposta === "aceitou" ? "Aceito a ligação" : "Não quero ligação",
    ],
  );
  if (r?.n !== 1)
    throw new Error(`responderPermissao: o pedido ${wamid} não casou (${JSON.stringify(r)})`);
}

/** As mensagens do pedido e da resposta numa conversa: [direcao, origem, rodada_id]. */
const mensagensDaPermissao = (t: Banco, conversa: string) =>
  t.sql(
    `select direcao::text as direcao, origem::text as origem, rodada_id from public.mensagens
      where conversa_id = $1 and tipo = 'permissao_ligacao' order by criado_em, direcao`,
    [conversa],
  );

const pedidos = async (t: Banco) => contar(t, "select 1 from net.http_request_queue");

/** O motor com endereço e sem toque recente; o worker visto há `vistoHa`, com o sinal novo ou não. */
async function motorPronto(t: Banco, { sinalNovo = true, vistoHa = "2 minutes" } = {}) {
  await t.sql("update public.motor set url = 'https://nina-a.exemplo.test', tocado_em = null");
  await t.sql(
    `update public.configuracao
        set worker_visto_em = now() - interval '${vistoHa}',
            worker_retornos_em = ${sinalNovo ? `now() - interval '${vistoHa}'` : "null"}
      where id = 1`,
  );
}

interface Pendencias {
  proximo: number | null;
  vencido: number | null;
  atrasado: number | null;
}
const NADA: Pendencias = { proximo: null, vencido: null, atrasado: null };

async function pendenciasDe(t: Banco, funcao: string): Promise<Pendencias> {
  const r = await servidor(t, `select * from public.${funcao}()`);
  t.igual(r.length, 1, `${funcao} devolve uma linha só`);
  return {
    proximo: ms(r[0].proximo_em),
    vencido: ms(r[0].vencido_desde),
    atrasado: ms(r[0].atrasado_desde),
  };
}
const pendencias = (t: Banco) => pendenciasDe(t, "motor_pendencias_com_retornos");
const pendenciasHoje = (t: Banco) => pendenciasDe(t, "motor_pendencias");

const prontos = (t: Banco) =>
  t.sql(
    "select retorno_id, conversa_id, tipo::text as tipo, pronto_em from public.retornos_prontos()",
  );

/**
 * Troca a função public.<nome> (todas as versões) por uma que lança, só no banco de teste. Serve para
 * provar que um defeito numa parte nova não derruba quem a chama.
 */
async function quebrar(t: Banco, nome: string): Promise<void> {
  await t.sql(`
    do $q$
    declare f record;
    begin
      for f in select pg_get_function_arguments(p.oid) as args, pg_get_function_result(p.oid) as res
                 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = '${nome}' loop
        execute format('create or replace function public.%I(%s) returns %s language plpgsql as %L',
                       '${nome}', f.args, f.res, 'begin raise exception ''quebrada_de_proposito''; end');
      end loop;
    end;
    $q$;
  `);
}

/**
 * Faz a public.<nome>(uuid) (que devolve void) lançar só para um id, só no banco de teste: a
 * original fica com outro nome, e a nova a chama para os outros ids. Serve para provar que o defeito
 * numa linha não derruba as outras.
 */
async function quebrarPara(t: Banco, nome: string, id: string): Promise<void> {
  await t.sql(`
    alter function public.${nome}(uuid) rename to ${nome}_original;
    create function public.${nome}(p uuid) returns void language plpgsql as $q$
    begin
      if p = '${id}'::uuid then
        raise exception 'quebrada_de_proposito';
      end if;
      perform public.${nome}_original(p);
    end;
    $q$;
  `);
}

const temQuebrada = async (t: Banco, nome: string) =>
  (await contar(
    t,
    `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = $1 and p.prosrc like '%quebrada_de_proposito%'`,
    [nome],
  )) > 0;

// asserções fora de um banco (só comparam valores)
const t0 = {
  igual: (a: unknown, b: unknown, msg: string) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${msg}: veio ${JSON.stringify(a)}, esperava ${JSON.stringify(b)}`);
  },
};

// ---------------------------------------------------------------------------
// montagem (não pula)
// ---------------------------------------------------------------------------

describe("banco: retornos (montagem)", () => {
  it("cada envio vem inteiro, na ordem, e o arquivo junto com o que ele cria", () => {
    const erros: string[] = [];
    const pelaMetade = (envio: string, lista: string[]) => {
      const tem = lista.map((f) => temFuncao(base, f));
      if (tem.some(Boolean) && !tem.every(Boolean))
        erros.push(`${envio} pela metade; faltam: ${lista.filter((_, i) => !tem[i]).join(", ")}`);
    };
    pelaMetade("nina_retornos_regras", FUNCOES_REGRAS);
    pelaMetade("nina_retornos_funcoes", FUNCOES_FUNCOES);
    if (marcaRegras && !temTabelas)
      erros.push("as regras (nina_retornos_regras) sem a tabela (nina_retornos_tabelas)");
    if (marcaFuncoes && !marcaRegras)
      erros.push("as funções (nina_retornos_funcoes) sem as regras (nina_retornos_regras)");
    if (marcaFuncoes && !temTabelas)
      erros.push("as funções (nina_retornos_funcoes) sem a tabela (nina_retornos_tabelas)");
    if (temRodada && !marcaFuncoes)
      erros.push("o fim da rodada (nina_retornos_rodada) sem as funções (nina_retornos_funcoes)");
    if (temRodada && !marcaRegras)
      erros.push("o fim da rodada (nina_retornos_rodada) sem as regras (nina_retornos_regras)");
    if (temRelogio && !marcaRegras)
      erros.push(
        "a preparar_copia dos dois jobs (nina_retornos_relogio) sem as regras (nina_retornos_regras)",
      );
    if (temRelogio && !marcaFuncoes)
      erros.push(
        "a preparar_copia dos dois jobs (nina_retornos_relogio) sem a relogio_retornos (nina_retornos_funcoes)",
      );
    if (temRelogio && !temRodada)
      erros.push(
        "a preparar_copia dos dois jobs (nina_retornos_relogio) sem o fim da rodada (nina_retornos_rodada)",
      );
    if (temRelogio && !temDashboard)
      erros.push(
        "a preparar_copia dos dois jobs (nina_retornos_relogio) sem o filtro do Dashboard (nina_retornos_dashboard, obrigatório)",
      );
    if (!!arqTabelas !== temTabelas)
      erros.push(
        `arquivo nina_retornos_tabelas ${arqTabelas ? "sem" : "faltando, mas com"} o enum retorno_status`,
      );
    if (!!arqRegras !== marcaRegras)
      erros.push(
        `arquivo nina_retornos_regras ${arqRegras ? "sem" : "faltando, mas com"} as regras`,
      );
    if (!!arqFuncoes !== marcaFuncoes)
      erros.push(
        `arquivo nina_retornos_funcoes ${arqFuncoes ? "sem" : "faltando, mas com"} as funções`,
      );
    if (!!arqRodada !== temRodada)
      erros.push(
        `arquivo nina_retornos_rodada ${arqRodada ? "sem" : "faltando, mas com"} o gatilho das bolhas`,
      );
    if (!!arqDashboard !== temDashboard)
      erros.push(
        `arquivo nina_retornos_dashboard ${arqDashboard ? "sem" : "faltando, mas com"} o filtro da dashboard_periodo`,
      );
    if (!!arqRelogio !== temRelogio)
      erros.push(
        `arquivo nina_retornos_relogio ${arqRelogio ? "sem" : "faltando, mas com"} o job nina-retornos`,
      );
    if (erros.length) throw new Error(erros.join("; "));
  });

  it("cada arquivo de envio presente cria só as funções dele (a divisão entre os arquivos)", async () => {
    const deCada: [string | undefined, string[]][] = [
      [arqTabelas, []],
      [arqRegras, FUNCOES_REGRAS],
      [arqFuncoes, FUNCOES_FUNCOES],
      [arqRodada, ["concluir_rodada", "falhar_rodada", GATILHO]],
      [arqDashboard, ["dashboard_periodo"]],
      [arqRelogio, ["preparar_copia"]],
    ];
    for (const [arq, esperadas] of deCada) {
      if (!arq) continue;
      const texto = await readFile(arq, "utf8");
      const criadas = [...texto.matchAll(/create or replace function public\.([a-z_]+)\(/gi)].map(
        (m) => m[1]!,
      );
      t0.igual(
        [...criadas].sort(),
        [...esperadas].sort(),
        `${basename(arq)}: as funções do arquivo`,
      );
    }
  });

  // As provas de trava rodam sobre a base sem os retornos: se ela levasse a cópia do
  // nina_retornos_tabelas (ou qualquer coisa dos retornos), as provas de "sem o nina_retornos_tabelas"
  // não provariam nada, e o grupo delas pularia em silêncio.
  it("a base sem os retornos (a das provas de trava) é a base até logo antes do nina_retornos_tabelas, sem nada dos retornos", async () => {
    if (!temTabelas) return; // sem o nina_retornos_tabelas no banco, não há trava a provar
    t0.igual(
      !!baseSem,
      true,
      "com o nina_retornos_tabelas no banco, a base sem os retornos é montada",
    );
    const aplicados = baseSem!.aplicados;
    t0.igual(
      aplicados.filter((n) => /nina_retornos_/.test(n)),
      [],
      "nenhum arquivo dos retornos",
    );
    t0.igual(
      temValorEnum(baseSem!, "retorno_status", "pendente"),
      false,
      "sem o enum retorno_status",
    );
    t0.igual(
      [...FUNCOES_REGRAS, ...FUNCOES_FUNCOES, GATILHO].filter((f) => temFuncao(baseSem!, f)),
      [],
      "sem as funções dos retornos",
    );
    if (nomeR1) {
      const antes = (await arquivosBase()).map((a) => basename(a)).filter((n) => n < nomeR1);
      t0.igual(
        aplicados,
        antes,
        `a base inteira até logo antes da cópia do nina_retornos_tabelas (${nomeR1})`,
      );
    }
    t0.igual(provaTrava, true, "as provas de trava rodam");
  });

  it("a volta atrás pesada, se pedida em NINA_SQL_DESFAZER, existe e nunca vem em NINA_SQL_EXTRA", () => {
    t0.igual(
      extras.some((a) => basename(a).includes("nina_retornos_desfazer")),
      false,
      "o desfazer não vai em NINA_SQL_EXTRA",
    );
    if (ARQ_DESFAZER) {
      t0.igual(
        isAbsolute(ARQ_DESFAZER) && existsSync(ARQ_DESFAZER),
        true,
        "NINA_SQL_DESFAZER: caminho absoluto que existe",
      );
    }
    // sem o desfazer, o grupo dele (o único que confere a lista de hashes da trava dele) ficaria
    // pulado em silêncio: com os 6 envios no banco (na base ou em NINA_SQL_EXTRA) e o desfazer
    // ainda não aplicado, o arquivo tem de existir
    if (temTudo) {
      t0.igual(
        !!ARQ_DESFAZER,
        true,
        "com os 6 envios no banco e sem o desfazer aplicado, o nina_retornos_desfazer.sql existe (src/test/banco/, ao lado dos envios ou em NINA_SQL_DESFAZER)",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// estrutura (nina_retornos_tabelas)
// ---------------------------------------------------------------------------

describe.skipIf(!temTabelas)(
  "banco: retornos, a estrutura (nina_retornos_tabelas)",
  { timeout: TEMPO_TESTE },
  () => {
    const t = usarBanco(base);

    async function umaConversa(t: Banco, modo = "nina"): Promise<string> {
      seq += 1;
      const [{ id: contato }] = await t.sql(
        "insert into public.contatos (nome, telefone) values ($1, $2) returning id",
        [`Lead ${seq}`, tel(900000 + seq)],
      );
      const [{ id }] = await t.sql(
        "insert into public.conversas (contato_id, modo) values ($1, $2::public.conversa_modo) returning id",
        [contato, modo],
      );
      return id as string;
    }

    it("os enums, as colunas novas e os padrões (o lembrete nasce ligado com 3 h)", async () => {
      t.igual(base.enums["retorno_tipo"], ["retorno", "lembrete"], "retorno_tipo");
      t.igual(
        base.enums["retorno_status"],
        ["pendente", "em_rodada", "saindo", "enviado", "dispensado", "cancelado", "nao_enviado"],
        "retorno_status",
      );
      const cols = await t.sql(
        `select table_name as t, column_name as c, data_type as tipo, is_nullable as nulo, column_default as padrao
         from information_schema.columns
        where table_schema = 'public'
          and (table_name, column_name) in (('rodadas', 'retorno_id'), ('configuracao', 'lembrete_ligado'),
               ('configuracao', 'lembrete_horas'), ('configuracao', 'worker_retornos_em'), ('motor', 'relogio_versao'))
        order by 1, 2`,
      );
      // retornos.lembrete_horas (as horas com que o lembrete foi armado) é do nina_retornos_regras:
      // o teste dela fica no grupo "as horas do lembrete armado", logo abaixo
      t.igual(
        cols.map((c: Linha) => [c.t, c.c, c.tipo, c.nulo, c.padrao]),
        [
          ["configuracao", "lembrete_horas", "integer", "NO", "3"],
          ["configuracao", "lembrete_ligado", "boolean", "NO", "true"],
          ["configuracao", "worker_retornos_em", "timestamp with time zone", "YES", null],
          ["motor", "relogio_versao", "smallint", "NO", "0"],
          ["rodadas", "retorno_id", "uuid", "YES", null],
        ],
        "colunas",
      );
      const [cf] = await t.sql(
        "select lembrete_ligado, lembrete_horas, worker_retornos_em from public.configuracao where id = 1",
      );
      t.igual(
        cf,
        { lembrete_ligado: true, lembrete_horas: 3, worker_retornos_em: null },
        "a linha de configuracao",
      );
      const [mo] = await t.sql("select relogio_versao from public.motor");
      t.igual(mo.relogio_versao, 0, "o relógio que a migration deixou: versão 0");
      // rodadas.retorno_id e as colunas de ligação do retorno são sem FK (a cascata é a da conversa)
      const fks = await t.sql(
        `select a.attname as coluna, c.confrelid::regclass::text as alvo, c.confdeltype as del
         from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
        where c.contype = 'f' and c.conrelid in ('public.retornos'::regclass, 'public.rodadas'::regclass)
          and (c.conrelid = 'public.retornos'::regclass or a.attname = 'retorno_id')
        order by 1`,
      );
      t.igual(
        fks.map((f: Linha) => [f.coluna, f.alvo, f.del]),
        [
          ["cancelado_por", "membros", "n"],
          ["conversa_id", "conversas", "c"],
        ],
        "FKs: conversa (cascade) e membro (set null); nenhuma em rodada_id, rodada_origem_id, substitui_id, fechado_por_rodada e rodadas.retorno_id",
      );
    });

    it("o check das horas do lembrete vai de 1 a 23, e a tela não grava o ajuste", async () => {
      for (const h of [0, 24]) {
        await t.erro(
          t.sql("update public.configuracao set lembrete_horas = $1 where id = 1", [h]),
          "configuracao_lembrete_horas",
        );
      }
      for (const h of [1, 23])
        await t.sql("update public.configuracao set lembrete_horas = $1 where id = 1", [h]);
      const u = await t.criarUsuario(`admin@${DOM}`, "Admin");
      await t.erro(
        t.como("authenticated", u, (q) =>
          q("update public.configuracao set lembrete_ligado = false where id = 1"),
        ),
        "permission denied",
      );
    });

    it("os índices: um retorno pendente e um lembrete pendente por conversa (I1)", async () => {
      const idx = (
        await t.sql(
          `select indexname from pg_indexes where schemaname = 'public' and tablename = 'retornos' order by 1`,
        )
      ).map((r: Linha) => r.indexname);
      for (const nome of [
        "retornos_andamento",
        "retornos_conversa",
        "retornos_um_lembrete",
        "retornos_um_retorno",
        "retornos_vencendo",
      ])
        t.ok(idx.includes(nome), `índice ${nome}: ${idx.join(", ")}`);
      const cv = await umaConversa(t);
      await inserir(t, cv, {
        vence: "now() + interval '1 hour'",
        expira: "now() + interval '4 hours'",
      });
      await t.erro(
        inserir(t, cv, {
          vence: "now() + interval '2 hours'",
          expira: "now() + interval '5 hours'",
        }),
        "23505",
      );
      await inserir(t, cv, {
        tipo: "lembrete",
        vence: "now() + interval '1 hour'",
        expira: "now() + interval '2 hours'",
      });
      await t.erro(
        inserir(t, cv, {
          tipo: "lembrete",
          vence: "now() + interval '1 hour'",
          expira: "now() + interval '2 hours'",
        }),
        "23505",
      );
      // fora de 'pendente' não conta: o em_rodada convive com o novo pendente (caso 8 + "me chama sexta")
      const [{ id: rd }] = await t.sql(
        "insert into public.rodadas (conversa_id, status) values ($1, 'concluida') returning id",
        [cv],
      );
      await t.sql(
        `update public.retornos set status = 'em_rodada', rodada_id = $2 where conversa_id = $1 and tipo = 'retorno'`,
        [cv, rd],
      );
      await inserir(t, cv, {
        vence: "now() + interval '3 hours'",
        expira: "now() + interval '6 hours'",
      });
    });

    it("os checks da tabela", async () => {
      const cv = await umaConversa(t);
      const ins = (cols: string, vals: string) =>
        t.sql(`insert into public.retornos (conversa_id, ${cols}) values ($1, ${vals})`, [cv]);
      const base = "tipo, vence_em, expira_em, motivo";
      const ok = "'retorno', now() + interval '1 hour', now() + interval '4 hours', 'Assunto'";
      await t.erro(ins(base, "'retorno', now(), now(), 'Assunto'"), "retornos_prazo");
      await t.erro(
        ins(base, "'retorno', now(), now() + interval '1 hour', '   '"),
        "retornos_motivo",
      );
      await t.erro(
        ins(base, `'retorno', now(), now() + interval '1 hour', '${"x".repeat(301)}'`),
        "retornos_motivo",
      );
      await t.erro(
        ins(base, "'lembrete', now(), now() + interval '1 hour', 'Assunto'"),
        "retornos_motivo",
      );
      await t.erro(ins(`${base}, resolvido_em`, `${ok}, now()`), "retornos_aberto");
      await t.erro(
        ins(`${base}, status, resolvido_em`, `${ok}, 'cancelado', null`),
        "retornos_aberto",
      );
      await t.erro(ins(`${base}, status`, `${ok}, 'em_rodada'`), "retornos_na_rodada");
      await t.erro(
        ins(`${base}, status, resolvido_em`, `${ok}, 'nao_enviado', now()`),
        "retornos_nao_enviado",
      );
      await t.erro(
        ins(
          `${base}, status, resolvido_em, nao_enviado_motivo`,
          `${ok}, 'nao_enviado', now(), 'outro'`,
        ),
        "retornos_nao_enviado_motivo",
      );
      await t.erro(
        ins(`${base}, status, resolvido_em`, `${ok}, 'enviado', now()`),
        "retornos_enviado",
      );
      await t.erro(ins(`${base}, nota_fim`, `${ok}, ''`), "retornos_nota_fim");
      // o check das horas do lembrete (retornos_lembrete_horas) é do nina_retornos_regras: fica no
      // grupo "as horas do lembrete armado"
      const u = await t.criarUsuario(`admin@${DOM}`, "Admin");
      const [{ id: m }] = await t.sql("select id from public.membros where user_id = $1", [u]);
      await t.erro(ins(`${base}, cancelado_por`, `${ok}, '${m}'`), "retornos_cancelado");
      for (const motivo of [
        "com_equipe",
        "fora_24h",
        "desconectado",
        "passou_do_prazo",
        "envio_recusado",
        "nina_falhou",
      ]) {
        await ins(
          `${base}, status, resolvido_em, nao_enviado_motivo`,
          `${ok}, 'nao_enviado', now(), '${motivo}'`,
        );
      }
      await ins(base, ok);
    });

    it("a tabela: RLS ligada, anon sem nada, authenticated só lê, service_role lê e grava; fora do tempo real", async () => {
      const [{ r }] = await t.sql(
        `select relrowsecurity as r from pg_class where oid = 'public.retornos'::regclass`,
      );
      t.igual(r, true, "RLS");
      const privs = await t.sql(
        `select papel, p from unnest(array['anon', 'authenticated', 'service_role']) papel,
              unnest(array['select', 'insert', 'update', 'delete']) p
        where has_table_privilege(papel, 'public.retornos', p) order by 1, 2`,
      );
      t.igual(
        privs.map((x: Linha) => `${x.papel}:${x.p}`),
        [
          "authenticated:select",
          "service_role:delete",
          "service_role:insert",
          "service_role:select",
          "service_role:update",
        ],
        "privilégios",
      );
      const pol = await t.sql(
        `select policyname, cmd, roles::text[] as roles from pg_policies where schemaname = 'public' and tablename = 'retornos'`,
      );
      t.igual(
        pol,
        [{ policyname: "retornos_membro_le", cmd: "SELECT", roles: ["authenticated"] }],
        "a policy de leitura",
      );
      t.igual(
        await contar(
          t,
          "select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'retornos'",
        ),
        0,
        "retornos fora do tempo real (B10)",
      );
    });

    it("quem lê (caso 22): membro ativo lê; conta sem convite e membro desativado veem 0; anon e a tela não gravam", async () => {
      const uAdmin = await t.criarUsuario(`admin@${DOM}`, "Admin");
      const uAtend = await t.criarUsuario(`atendente@${DOM}`, "Atendente");
      await t.sql(
        `insert into public.membros (user_id, nome, email, papel) values ($1, 'Atendente', $2, 'atendente')`,
        [uAtend, `atendente@${DOM}`],
      );
      const uSem = await t.criarUsuario(`sem@${DOM}`, "Sem convite");
      const cv = await umaConversa(t);
      const id = await inserir(t, cv, {
        vence: "now() + interval '1 hour'",
        expira: "now() + interval '4 hours'",
      });
      const ler = (u: string | null) =>
        t.como("authenticated", u, async (q) => (await q("select id from public.retornos")).length);
      t.igual(await ler(uAdmin), 1, "admin");
      t.igual(await ler(uAtend), 1, "atendente");
      t.igual(await ler(uSem), 0, "sem convite");
      await t.erro(
        t.como("anon", null, (q) => q("select id from public.retornos")),
        "permission denied",
      );
      for (const cmd of [
        "insert into public.retornos (conversa_id, tipo, vence_em, expira_em, motivo) values ($1, 'retorno', now(), now() + interval '1 hour', 'x')",
        "update public.retornos set status = 'cancelado', resolvido_em = now() where conversa_id = $1",
        "delete from public.retornos where conversa_id = $1",
      ]) {
        await t.erro(
          t.como("authenticated", uAdmin, (q) => q(cmd, [cv])),
          "permission denied",
        );
      }
      t.igual((await retorno(t, id)).status, "pendente", "nada mudou");
      await t.sql("update public.membros set ativo = false where user_id = $1", [uAtend]);
      t.igual(await ler(uAtend), 0, "desativado");
    });

    // O nina_retornos_tabelas foi aplicado (base 0042, drizzle 0020) sem a coluna das horas do
    // lembrete armado: a revisão das funções a pediu depois, e ela nasce no nina_retornos_regras.
    it("a coluna retornos.lembrete_horas e o check retornos_lembrete_horas existem só com o nina_retornos_regras", async () => {
      const coluna = await contar(
        t,
        `select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'retornos' and column_name = 'lembrete_horas'`,
      );
      const check = await contar(
        t,
        `select 1 from pg_constraint
        where conrelid = 'public.retornos'::regclass and conname = 'retornos_lembrete_horas' and contype = 'c'`,
      );
      t.igual(
        [coluna, check],
        marcaRegras ? [1, 1] : [0, 0],
        marcaRegras
          ? "com o nina_retornos_regras, a coluna e o check"
          : "só com o nina_retornos_tabelas, nem a coluna nem o check",
      );
    });
  },
);

// ---------------------------------------------------------------------------
// as horas do lembrete armado (nina_retornos_regras): retornos.lembrete_horas e o check
// ---------------------------------------------------------------------------

// A coluna e o check nascem no começo do nina_retornos_regras, antes da retornos_prontos (que a lê),
// e não no nina_retornos_tabelas, que já estava aplicado quando a revisão das funções os pediu.
describe.skipIf(!temRegras)(
  "banco: retornos, as horas do lembrete armado (nina_retornos_regras)",
  { timeout: TEMPO_TESTE },
  () => {
    const t = usarBanco(base);

    async function umaConversa(t: Banco): Promise<string> {
      seq += 1;
      const [{ id: contato }] = await t.sql(
        "insert into public.contatos (nome, telefone) values ($1, $2) returning id",
        [`Lead ${seq}`, tel(900000 + seq)],
      );
      const [{ id }] = await t.sql(
        "insert into public.conversas (contato_id) values ($1) returning id",
        [contato],
      );
      return id as string;
    }

    it("a coluna retornos.lembrete_horas: inteira, nula e sem padrão (nula no retorno combinado)", async () => {
      const cols = await t.sql(
        `select data_type as tipo, is_nullable as nulo, column_default as padrao
         from information_schema.columns
        where table_schema = 'public' and table_name = 'retornos' and column_name = 'lembrete_horas'`,
      );
      t.igual(
        cols.map((c: Linha) => [c.tipo, c.nulo, c.padrao]),
        [["integer", "YES", null]],
        "retornos.lembrete_horas",
      );
    });

    it("o check retornos_lembrete_horas: só no lembrete, de 1 a 23 (o retorno combinado não as tem)", async () => {
      const cv = await umaConversa(t);
      const ins = (cols: string, vals: string) =>
        t.sql(`insert into public.retornos (conversa_id, ${cols}) values ($1, ${vals})`, [cv]);
      const base = "tipo, vence_em, expira_em, motivo";
      const ok = "'retorno', now() + interval '1 hour', now() + interval '4 hours', 'Assunto'";
      await t.erro(ins(`${base}, lembrete_horas`, `${ok}, 3`), "retornos_lembrete_horas");
      const lembrete = (h: number) =>
        ins(
          "tipo, vence_em, expira_em, lembrete_horas",
          `'lembrete', now() + interval '1 hour', now() + interval '2 hours', ${h}`,
        );
      for (const h of [0, 24]) await t.erro(lembrete(h), "retornos_lembrete_horas");
      await lembrete(23);
      await t.sql("delete from public.retornos where conversa_id = $1", [cv]);
      await lembrete(1);
      await t.sql("delete from public.retornos where conversa_id = $1", [cv]);
      // sem as horas (o lembrete gravado antes da coluna, ou o retorno combinado): aceito
      await ins(
        "tipo, vence_em, expira_em",
        "'lembrete', now() + interval '1 hour', now() + interval '2 hours'",
      );
      await ins(base, ok);
      t.igual(
        await contar(
          t,
          "select 1 from public.retornos where conversa_id = $1 and lembrete_horas is null",
          [cv],
        ),
        2,
        "as duas linhas sem as horas",
      );
    });
  },
);

// ---------------------------------------------------------------------------
// funções puras de hora (nina_retornos_regras)
// ---------------------------------------------------------------------------

describe.skipIf(!temRegras)(
  "banco: retornos, as regras de hora (funções puras)",
  { timeout: TEMPO_TESTE },
  () => {
    const t = usarBanco(base);
    const CONV = "00000000-0000-4000-8000-000000000001";

    const instante = async (d: string, h: string) =>
      (
        (await t.sql("select public.retorno_instante($1::date, $2::time) as v", [d, h]))[0]
          .v as Date
      ).toISOString();
    const vence = async (baseIso: string, horas: number, conv = CONV) =>
      (
        (
          await t.sql("select public.lembrete_vence_em($1::timestamptz, $2, $3::uuid) as v", [
            baseIso,
            horas,
            conv,
          ])
        )[0].v as Date
      ).toISOString();
    const expira = async (venceIso: string) =>
      (
        (await t.sql("select public.lembrete_expira_em($1::timestamptz) as v", [venceIso]))[0]
          .v as Date
      ).toISOString();

    function entre(t: Banco, iso: string, de: string, ate: string, msg: string) {
      t.ok(iso >= de && iso < ate, `${msg}: ${iso} fora de [${de}, ${ate})`);
    }

    it("retorno_instante: a data e a hora de Brasília (casos 2 e 11)", async () => {
      const casos: [string, string, string][] = [
        ["2026-11-19", "09:00", "2026-11-19T12:00:00.000Z"], // caso 1: qui 19/11 09:00
        ["2026-11-19", "14:00", "2026-11-19T17:00:00.000Z"], // caso 2: tarde
        ["2026-11-19", "19:00", "2026-11-19T22:00:00.000Z"], // caso 2: noite
        ["2026-11-19", "00:10", "2026-11-19T03:10:00.000Z"], // caso 11: logo depois da meia-noite
        ["2026-11-18", "23:50", "2026-11-19T02:50:00.000Z"], // o dia de Brasília vira o seguinte em UTC
        ["2026-12-31", "22:00", "2027-01-01T01:00:00.000Z"], // virada de ano
      ];
      for (const [d, h, esperado] of casos) t.igual(await instante(d, h), esperado, `${d} ${h}`);
    });

    it("lembrete_vence_em: dentro de 8h-20h, na hora; fora, nas 08:00 seguintes com 0 a 30 min (casos 15 e 18)", async () => {
      // 09:00 + 3 h = 12:00 (caso 15)
      t.igual(await vence("2026-11-18T12:00:00Z", 3), "2026-11-18T15:00:00.000Z", "09:00 + 3 h");
      t.igual(await vence("2026-11-18T13:00:00Z", 3), "2026-11-18T16:00:00.000Z", "10:00 + 3 h");
      // 05:00 + 3 h = 08:00 em ponto: dentro
      t.igual(
        await vence("2026-11-18T08:00:00Z", 3),
        "2026-11-18T11:00:00.000Z",
        "05:00 + 3 h = 08:00",
      );
      // 16:59 + 3 h = 19:59: dentro
      t.igual(
        await vence("2026-11-18T19:59:00Z", 3),
        "2026-11-18T22:59:00.000Z",
        "16:59 + 3 h = 19:59",
      );
      // 09:00 + 23 h = 08:00 do dia seguinte: dentro
      t.igual(await vence("2026-11-18T12:00:00Z", 23), "2026-11-19T11:00:00.000Z", "09:00 + 23 h");
      // 18:30 + 3 h = 21:30, fora: o dia seguinte entre 08:00 e 08:30 (caso 18)
      entre(
        t,
        await vence("2026-11-18T21:30:00Z", 3),
        "2026-11-19T11:00:00.000Z",
        "2026-11-19T11:30:00.000Z",
        "18:30 + 3 h",
      );
      // 17:00 + 3 h = 20:00 em ponto: fora
      entre(
        t,
        await vence("2026-11-18T20:00:00Z", 3),
        "2026-11-19T11:00:00.000Z",
        "2026-11-19T11:30:00.000Z",
        "17:00 + 3 h = 20:00",
      );
      // 05:00 + 1 h = 06:00: o mesmo dia, entre 08:00 e 08:30
      entre(
        t,
        await vence("2026-11-18T08:00:00Z", 1),
        "2026-11-18T11:00:00.000Z",
        "2026-11-18T11:30:00.000Z",
        "05:00 + 1 h",
      );
      // 23:00 de 18/11 + 1 h = 00:00 de 19/11: 19/11 entre 08:00 e 08:30
      entre(
        t,
        await vence("2026-11-19T02:00:00Z", 1),
        "2026-11-19T11:00:00.000Z",
        "2026-11-19T11:30:00.000Z",
        "23:00 + 1 h",
      );
    });

    it("lembrete_vence_em: a mesma conversa dá sempre o mesmo instante; conversas diferentes se espalham", async () => {
      const a = await vence("2026-11-18T21:30:00Z", 3);
      t.igual(await vence("2026-11-18T21:30:00Z", 3), a, "determinístico");
      const [{ lista }] = await t.sql(
        `select array_agg(public.lembrete_vence_em('2026-11-18T21:30:00Z'::timestamptz, 3, gen_random_uuid())) as lista
         from generate_series(1, 40)`,
      );
      const isos = (lista as Date[]).map((d) => new Date(d).toISOString());
      for (const iso of isos)
        entre(t, iso, "2026-11-19T11:00:00.000Z", "2026-11-19T11:30:00.000Z", "espalhado");
      t.ok(
        new Set(isos).size >= 5,
        `40 conversas com pelo menos 5 instantes diferentes: ${new Set(isos).size}`,
      );
    });

    it("lembrete_expira_em: 3 h depois, nunca depois das 20:00 do dia; sempre depois do vence_em", async () => {
      t.igual(await expira("2026-11-18T15:00:00Z"), "2026-11-18T18:00:00.000Z", "12:00 → 15:00");
      t.igual(await expira("2026-11-18T11:10:00Z"), "2026-11-18T14:10:00.000Z", "08:10 → 11:10");
      t.igual(await expira("2026-11-18T20:30:00Z"), "2026-11-18T23:00:00.000Z", "17:30 → 20:00");
      t.igual(await expira("2026-11-18T22:59:00Z"), "2026-11-18T23:00:00.000Z", "19:59 → 20:00");
      const [{ ok }] = await t.sql(
        `select bool_and(public.lembrete_expira_em(v) > v) as ok
         from (select public.lembrete_vence_em(b, h, gen_random_uuid()) as v
                 from generate_series('2026-11-18T00:00:00Z'::timestamptz, '2026-11-19T23:30:00Z', interval '30 minutes') b,
                      generate_series(1, 23) h) s`,
      );
      t.igual(ok, true, "expira_em > vence_em em todo o dia, para 1 a 23 h");
    });

    it("as regras de hora não dependem do fuso da sessão", async () => {
      const [r] = await t.sql(`
      set time zone 'Asia/Tokyo';
      select public.retorno_instante('2026-11-19'::date, '09:00'::time) as i,
             public.lembrete_vence_em('2026-11-18T12:00:00Z'::timestamptz, 3, '${CONV}'::uuid) as v,
             public.lembrete_expira_em('2026-11-18T22:59:00Z'::timestamptz) as e`);
      await t.sql("reset time zone");
      t.igual(
        [r.i.toISOString(), r.v.toISOString(), r.e.toISOString()],
        ["2026-11-19T12:00:00.000Z", "2026-11-18T15:00:00.000Z", "2026-11-18T23:00:00.000Z"],
      );
    });
  },
);

// ---------------------------------------------------------------------------
// permissões e forma (nina_retornos_regras, nina_retornos_funcoes e o gatilho do
// nina_retornos_rodada): o grupo roda já com as regras; o que pede as funções do servidor espera o
// nina_retornos_funcoes
// ---------------------------------------------------------------------------

describe.skipIf(!temRegras)(
  "banco: retornos, permissões e forma das funções",
  { timeout: TEMPO_TESTE },
  () => {
    const t = usarBanco(base);

    const novas = () => [
      ...FUNCOES_REGRAS,
      ...(temFuncoes ? FUNCOES_FUNCOES : []),
      ...(temRodada ? [GATILHO] : []),
    ];

    it("cada função nova: uma versão só, security definer, search_path vazio, dono dono_app", async () => {
      const linhas = await t.sql(
        `select p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as dono
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any ($1::text[]) order by 1`,
        [novas()],
      );
      t.igual(
        linhas.map((l: Linha) => l.proname),
        [...novas()].sort(),
        "uma versão de cada",
      );
      for (const l of linhas)
        t.igual(
          [l.prosecdef, l.proconfig, l.dono],
          [true, ['search_path=""'], "dono_app"],
          l.proname,
        );
    });

    it("cada função que os envios recriam (concluir_rodada, falhar_rodada, dashboard_periodo, preparar_copia): uma versão só, security definer, search_path vazio, dono dono_app", async () => {
      const recriadas = ["concluir_rodada", "dashboard_periodo", "falhar_rodada", "preparar_copia"];
      const linhas = await t.sql(
        `select p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as dono
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any ($1::text[]) order by 1`,
        [recriadas],
      );
      t.igual(
        linhas.map((l: Linha) => l.proname),
        recriadas,
        "uma versão de cada",
      );
      for (const l of linhas)
        t.igual(
          [l.prosecdef, l.proconfig, l.dono],
          [true, ['search_path=""'], "dono_app"],
          l.proname,
        );
    });

    // O banco de teste tem uma conexão só: um impasse entre duas transações não se reproduz aqui, e a
    // ordem das travas é conferida no texto das funções em vigor.
    const src = async (f: string) =>
      (await t.sql("select prosrc as s from pg_proc where oid = to_regprocedure($1)", [f]))[0]
        .s as string;

    it("a ordem das travas (nina_retornos_regras): a varredura, conversa antes do retorno; a volta a pendente pelas bolhas, a conversa (nowait) antes", async () => {
      const varredura = await src("public.retornos_varrer(integer)");
      t.igual(
        /for update of rt, c\b/i.test(varredura),
        false,
        "nenhum passo trava o retorno antes da conversa",
      );
      t.igual(
        (varredura.match(/for update of c, rt skip locked/gi) ?? []).length,
        8,
        "os oito passos (A a G)",
      );
      // quem grava um retorno pendente segura a conversa: a volta a pendente pelo gatilho das bolhas
      // não disputa com a nina_marcar_retorno o índice de um pendente por conversa (e, com a conversa
      // ocupada, o gatilho adia em vez de esperar)
      const bolhas = await src("public.retorno_pelas_bolhas(uuid)");
      const trava = bolhas.search(
        /from public\.conversas c where c\.id = v_rt\.conversa_id for update nowait/,
      );
      const volta = bolhas.search(/public\.retorno_volta\(/);
      t.ok(
        trava >= 0 && volta > trava,
        "retorno_pelas_bolhas: a conversa travada (nowait) antes da volta a pendente",
      );
    });

    // o gatilho das bolhas roda no caminho de toda bolha (o envio, o webhook, o Assumir): ele nunca
    // espera trava, só tenta (nowait) e adia. Depois da volta atrás pesada, a função dele não faz nada.
    it.skipIf(!temRodada || desfeito)(
      "a ordem das travas (nina_retornos_rodada): o gatilho das bolhas só trava com nowait e trata a trava ocupada",
      async () => {
        const g = await src("public.tg_mensagens_saida_do_retorno()");
        t.igual(
          (g.match(/from public\.retornos rt[^;]*for update nowait\s*;/gi) ?? []).length,
          2,
          "as duas travas em retornos, com nowait",
        );
        t.igual(/for update(?!\s+nowait)/i.test(g), false, "nenhuma trava sem nowait");
        t.ok(
          /when\s+lock_not_available\b/i.test(g),
          "a trava ocupada é tratada (lock_not_available)",
        );
      },
    );

    it.skipIf(!temFuncoes)(
      "a ordem das travas (nina_retornos_funcoes): as ferramentas da Nina, a conversa antes da rodada (a do Assumir)",
      async () => {
        for (const f of [
          "public.nina_marcar_retorno(uuid, date, time, text)",
          "public.nina_cancelar_retorno(uuid, text)",
        ]) {
          const s = await src(f);
          const conversa = s.search(/from public\.conversas c where c\.id = v_conv for update/);
          const rodada = s.search(/public\.rodada_rodando\(p_rodada\)/);
          t.ok(conversa >= 0 && rodada > conversa, `${f}: a conversa travada antes da rodada`);
        }
      },
    );

    it.skipIf(!temFuncoes)("as assinaturas das públicas e das recriadas", async () => {
      const esperadas: [string, string, string][] = [
        ["pegar_rodadas_com_retornos", "p_limite integer, p_limite_puras integer", "SETOF rodadas"],
        ["nina_retorno_da_rodada", "p_rodada uuid", "jsonb"],
        [
          "nina_marcar_retorno",
          "p_rodada uuid, p_data date, p_hora time without time zone, p_motivo text",
          "jsonb",
        ],
        ["nina_cancelar_retorno", "p_rodada uuid, p_motivo text", "jsonb"],
        ["cancelar_retorno", "p_retorno uuid", "void"],
        [
          "motor_pendencias_com_retornos",
          "",
          "TABLE(proximo_em timestamp with time zone, vencido_desde timestamp with time zone, atrasado_desde timestamp with time zone)",
        ],
        // as de hoje, intocadas (a volta atrás e o servidor publicado)
        ["pegar_rodadas", "p_limite integer", "SETOF rodadas"],
        [
          "motor_pendencias",
          "",
          "TABLE(proximo_em timestamp with time zone, vencido_desde timestamp with time zone, atrasado_desde timestamp with time zone)",
        ],
        [
          "concluir_rodada",
          "p_rodada uuid, p_respostas jsonb, p_ferramentas jsonb, p_passos integer",
          "void",
        ],
        ["falhar_rodada", "p_rodada uuid, p_motivo motivo_humano, p_passageiro boolean", "void"],
        ["preparar_copia", "", "text"],
      ];
      for (const [nome, args, ret] of esperadas) {
        const linhas = await t.sql(
          `select pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as ret
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1`,
          [nome],
        );
        t.igual(linhas.length, 1, `${nome}: uma só versão`);
        t.igual(
          [linhas[0].args.replace(/public\./g, ""), linhas[0].ret.replace(/public\./g, "")],
          [args, ret],
          `${nome}: assinatura`,
        );
      }
    });

    it("execute por papel: as do servidor só o service_role; as da equipe, authenticated e service_role; as internas, ninguém", async () => {
      const linhas = await t.sql(
        `select p.proname,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as srv
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any ($1::text[])`,
        [novas()],
      );
      const esperado = (nome: string) =>
        SERVIDOR.includes(nome)
          ? [false, false, true]
          : EQUIPE.includes(nome)
            ? [false, true, true]
            : [false, false, false];
      for (const l of linhas) t.igual([l.anon, l.auth, l.srv], esperado(l.proname), l.proname);
      const publico = await t.sql(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
              aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where n.nspname = 'public' and p.proname = any ($1::text[]) and a.grantee = 0`,
        [novas()],
      );
      t.igual(publico, [], "nada para PUBLIC");
    });

    it.skipIf(!temFuncoes)(
      "anon e a tela não chamam as funções do servidor; o anon não cancela nem vê o atraso",
      async () => {
        const u = await t.criarUsuario(`admin@${DOM}`, "Admin");
        const chamadas = [
          "select * from public.pegar_rodadas_com_retornos(3, 3)",
          "select public.nina_retorno_da_rodada(gen_random_uuid())",
          "select public.nina_marcar_retorno(gen_random_uuid(), current_date, '09:00'::time, 'x')",
          "select public.nina_cancelar_retorno(gen_random_uuid(), 'x')",
        ];
        for (const sql of chamadas) {
          await t.erro(
            t.como("authenticated", u, (q) => q(sql)),
            "permission denied",
          );
          await t.erro(
            t.como("anon", null, (q) => q(sql)),
            "permission denied",
          );
        }
        await t.erro(
          t.como("anon", null, (q) => q("select public.cancelar_retorno(gen_random_uuid())")),
          "permission denied",
        );
        await t.erro(
          t.como("anon", null, (q) => q("select * from public.motor_pendencias_com_retornos()")),
          "permission denied",
        );
        for (const f of ["retornos_varrer(500)", "relogio_retornos()", "retornos_prontos()"]) {
          await t.erro(
            t.como("service_role", null, (q) => q(`select public.${f}`)),
            "permission denied",
          );
        }
      },
    );
  },
);

// ---------------------------------------------------------------------------
// o comportamento (nina_retornos_regras, nina_retornos_funcoes e nina_retornos_rodada)
// ---------------------------------------------------------------------------

// Com o nina_retornos_funcoes já basta (o estado que vai primeiro ao Lovable): a irmã e as
// pendências não dependem do fim da rodada nem do relógio.
describe.skipIf(!temFuncoes)(
  "banco: retornos, sem retorno gravado tudo como hoje (a irmã e as pendências)",
  { timeout: TEMPO_TESTE },
  () => {
    const t = usarBanco(base);

    it("a irmã devolve as mesmas rodadas que a pegar_rodadas de hoje (equivalência)", async () => {
      const b = await preparar(t);
      const armadas: string[] = [];
      for (const n of [1, 2, 3]) {
        const e = await entrada(t, b.cx, tel(n));
        await vencer(t, e.conversa_id);
        armadas.push(e.conversa_id);
      }
      await entrada(t, b.cx, tel(4)); // armada no futuro (os 8 s do lote)
      const h = await entrada(t, b.cx, tel(5));
      await t.sql(
        "update public.conversas set modo = 'humano', responder_apos = now() - interval '1 second' where id = $1",
        [h.conversa_id],
      );
      const rod = await entrada(t, b.cx, tel(6));
      await vencer(t, rod.conversa_id);
      await t.sql("insert into public.rodadas (conversa_id, status) values ($1, 'rodando')", [
        rod.conversa_id,
      ]);
      for (const limite of [2, 10]) {
        const resumo = (sql: string) =>
          t.como("service_role", null, async (q) => {
            await q("begin");
            try {
              const rs = await q(sql, [limite]);
              const ent = await q(
                `select m.conversa_id, r.conversa_id as da_rodada from public.mensagens m
                 left join public.rodadas r on r.id = m.rodada_id
                where m.direcao = 'entrada' order by m.conversa_id, m.criado_em`,
              );
              const cvs = await q("select id, responder_apos from public.conversas order by id");
              return {
                rodadas: rs
                  .map((r: Linha) =>
                    JSON.stringify([
                      r.conversa_id,
                      r.status,
                      r.tentativa,
                      r.passos,
                      r.retorno_id ?? null,
                    ]),
                  )
                  .sort(),
                entradas: ent.map((x: Linha) => [x.conversa_id, x.da_rodada]),
                conversas: cvs.map((c: Linha) => [c.id, ms(c.responder_apos)]),
              };
            } finally {
              await q("rollback");
            }
          });
        const hoje = await resumo("select * from public.pegar_rodadas($1)");
        const irma = await resumo("select * from public.pegar_rodadas_com_retornos($1, $1)");
        t.igual(irma, hoje, `limite ${limite}`);
        t.igual(hoje.rodadas.length, Math.min(limite, 3), `limite ${limite}: as armadas vencidas`);
      }
    });

    it("motor_pendencias_com_retornos = motor_pendencias (nada, armada no futuro, vencida)", async () => {
      const b = await preparar(t);
      t.igual(await pendencias(t), NADA, "nada");
      t.igual(await pendencias(t), await pendenciasHoje(t), "nada nas duas");
      const e = await entrada(t, b.cx, tel(1));
      t.igual(await pendencias(t), await pendenciasHoje(t), "armada no futuro");
      await vencer(t, e.conversa_id);
      const hoje = await pendenciasHoje(t);
      t.ok(hoje.vencido !== null, "vencida");
      t.igual(await pendencias(t), hoje, "vencida nas duas");
    });

    // B1 na motor_pendencias_com_retornos: a parte nova (retornos_ligados e retornos_prontos) é
    // protegida. Com os retornos ligados (de mentira no estado que fica dias na main) e um retorno
    // pronto, a retornos_prontos quebrada não derruba o bastão nem o "atrasada" da tela.
    it("um defeito na parte nova da motor_pendencias_com_retornos não derruba as pendências de hoje", async () => {
      const b = await preparar(t);
      if (!temRodada) await ligadosDeMentira(t);
      const c = await atendida(t, b, tel(1));
      await inserir(t, c.conversa, { vence: "now() - interval '2 minutes'" });
      const e = await entrada(t, b.cx, tel(2));
      await vencer(t, e.conversa_id);
      const hoje = await pendenciasHoje(t);
      t.ok(hoje.vencido !== null, "a conversa vencida");
      t.ok(
        (await pendencias(t)).atrasado !== hoje.atrasado,
        "antes de quebrar, o retorno pronto conta",
      );
      await quebrar(t, "retornos_prontos");
      t.igual(await pendencias(t), hoje, "com a retornos_prontos quebrada: só as de hoje");
    });
  },
);

// Os retornos desligados (o servidor novo publicado antes do nina_retornos_rodada ou do
// nina_retornos_relogio): sem o relógio da versão 1 ou sem o gatilho das bolhas, a irmã só faz a
// faixa 0 e a Nina não marca. Roda em todo estado com o nina_retornos_funcoes, até com os 6 envios.
describe.skipIf(!temFuncoes)(
  "banco: retornos, os retornos desligados (sem o relógio da versão 1)",
  { timeout: TEMPO_TESTE },
  () => {
    const t = usarBanco(base);

    /**
     * Um retorno pendente vencido numa conversa livre e uma conversa armada (o lead escreveu). Com
     * naArmada: também um retorno vencido na conversa armada, marcado há 1 dia (cabe no "levar
     * junto"), e um retorno com o prazo vencido numa terceira conversa atendida (cabe na varredura
     * curta).
     */
    async function cena({ naArmada = false } = {}) {
      const b = await preparar(t);
      const livre = await atendida(t, b, tel(1));
      // antes da entrada da conversa armada: a pegada da atendida não pode levar a rodada dela
      const terceira = naArmada ? await atendida(t, b, tel(3)) : null;
      const rt = await inserir(t, livre.conversa);
      const e = await entrada(t, b.cx, tel(2));
      await vencer(t, e.conversa_id);
      const rtArmada = naArmada
        ? await inserir(t, e.conversa_id, { marcado: "now() - interval '1 day'" })
        : null;
      const rtExpirado = terceira
        ? await inserir(t, terceira.conversa, {
            vence: "now() - interval '4 hours'",
            expira: "now() - interval '1 second'",
          })
        : null;
      return { b, livre: livre.conversa, retorno: rt, armada: e.conversa_id, rtArmada, rtExpirado };
    }

    /** Desligados: a rodada da faixa 0 não leva o retorno vencido da conversa e a varredura curta não roda. */
    async function semLevarNemVarrer(c: Awaited<ReturnType<typeof cena>>, rs: Linha[]) {
      t.igual(await estado(t, c.rtArmada!), ["pendente", null], "desligados: não vai junto");
      t.igual((await retorno(t, c.rtArmada!)).rodada_id, null, "desligados: sem rodada");
      t.igual(
        await estado(t, c.rtExpirado!),
        ["pendente", null],
        "desligados: a varredura curta não roda",
      );
      const lido = await daRodada(t, rs[0].id);
      t.igual(
        [lido?.da_rodada, lido?.retorno_id, lido?.vencido],
        [false, c.rtArmada, true],
        "a rodada comum só lê o pendente",
      );
    }

    it("com o relógio na versão 0: a irmã devolve só a faixa 0, nenhuma rodada leva retorno, o retorno fica pendente e a Nina não marca (retornos_desligados)", async () => {
      const c = await cena({ naArmada: true });
      await ligarRetornos(t, false);
      t.ok(
        (await prontos(t)).some((p: Linha) => p.retorno_id === c.retorno),
        "o retorno está pronto (a regra do 'pode sair' não muda)",
      );
      const rs = await pegar(t, 3, 3);
      t.igual(
        rs.map((r: Linha) => [r.conversa_id, r.retorno_id ?? null]),
        [[c.armada, null]],
        "só a rodada da faixa 0 (a conversa armada), sem retorno_id",
      );
      t.igual(await estado(t, c.retorno), ["pendente", null], "o retorno continua pendente");
      t.igual(
        await contar(t, "select 1 from public.rodadas where retorno_id is not null"),
        0,
        "nenhuma rodada pura",
      );
      await semLevarNemVarrer(c, rs);
      const q = await amanha(t);
      await t.erro(marcar(t, rs[0].id, q.data, q.hora), "retornos_desligados");
      t.igual(
        await contar(t, "select 1 from public.retornos where conversa_id = $1 and id <> $2", [
          c.armada,
          c.rtArmada,
        ]),
        0,
        "nada gravado",
      );
      // a ordem das recusas: as da rodada vêm antes do retornos_desligados. Uma rodada pura montada à
      // mão (sem fala do lead) dá rodada_sem_lead; a rodada já concluída, rodada_nao_rodando
      const [{ id: pura }] = await t.sql(
        "insert into public.rodadas (conversa_id, status, retorno_id) values ($1, 'rodando', $2) returning id",
        [c.livre, c.retorno],
      );
      await t.erro(marcar(t, pura as string, q.data, q.hora), "rodada_sem_lead");
      await concluir(t, rs[0].id, ["Oi!"]);
      await t.erro(marcar(t, rs[0].id, q.data, q.hora), "rodada_nao_rodando");
    });

    // o estado que fica dias na main (nina_retornos_tabelas, nina_retornos_regras e
    // nina_retornos_funcoes): a versão 1 sozinha não liga, e uma função de mentira com o nome do
    // gatilho também não (a retornos_ligados confere o conteúdo do nina_retornos_rodada)
    it.skipIf(temRodada)(
      "com o relógio na versão 1 e sem o nina_retornos_rodada: a irmã devolve só a faixa 0, o retorno fica pendente e a Nina não marca (retornos_desligados); só o nome do gatilho não liga",
      async () => {
        const c = await cena({ naArmada: true });
        await ligarRetornos(t, true);
        const ligados = async () =>
          (await comoDono(t, "select public.retornos_ligados() as l"))[0].l as boolean;
        t.igual(await ligados(), false, "versão 1, sem o nina_retornos_rodada: desligados");
        const rs = await pegar(t, 3, 3);
        t.igual(
          rs.map((r: Linha) => [r.conversa_id, r.retorno_id ?? null]),
          [[c.armada, null]],
          "só a faixa 0",
        );
        t.igual(await estado(t, c.retorno), ["pendente", null], "o retorno continua pendente");
        t.igual(
          await contar(t, "select 1 from public.rodadas where retorno_id is not null"),
          0,
          "nenhuma rodada pura",
        );
        await semLevarNemVarrer(c, rs);
        const q = await amanha(t);
        await t.erro(marcar(t, rs[0].id, q.data, q.hora), "retornos_desligados");
        // a função de mentira com o nome do gatilho das bolhas (sem o gatilho e sem a concluir_rodada
        // nova): continua desligado
        await t.sql(
          "create function public.tg_mensagens_saida_do_retorno() returns trigger language plpgsql as 'begin return null; end'",
        );
        t.igual(await ligados(), false, "só o nome do gatilho não liga");
      },
    );

    it.skipIf(!temFluxo)(
      "com o nina_retornos_rodada, a retornos_ligados confere o conteúdo: o gatilho desligado, a função do gatilho sem efeito ou a concluir_rodada de antes desligam",
      async () => {
        await preparar(t);
        const ligados = async () =>
          (await comoDono(t, "select public.retornos_ligados() as l"))[0].l as boolean;
        t.igual(await ligados(), true, "o conjunto inteiro: ligados");
        await t.sql("alter table public.mensagens disable trigger mensagens_saida_do_retorno");
        t.igual(await ligados(), false, "o gatilho desligado");
        await t.sql("alter table public.mensagens enable trigger mensagens_saida_do_retorno");
        t.igual(await ligados(), true, "o gatilho ligado de novo");
        // só neste banco de teste: a concluir_rodada que não fecha o retorno
        await t.sql(`
      alter function public.concluir_rodada(uuid, jsonb, jsonb, integer) rename to concluir_rodada_original;
      create function public.concluir_rodada(p_rodada uuid, p_respostas jsonb, p_ferramentas jsonb, p_passos int)
      returns void language plpgsql as $q$
      begin
        perform public.concluir_rodada_original(p_rodada, p_respostas, p_ferramentas, p_passos);
      end;
      $q$;
    `);
        t.igual(await ligados(), false, "a concluir_rodada que não fecha o retorno");
        await t.sql(`
      drop function public.concluir_rodada(uuid, jsonb, jsonb, integer);
      alter function public.concluir_rodada_original(uuid, jsonb, jsonb, integer) rename to concluir_rodada;
    `);
        t.igual(await ligados(), true, "a concluir_rodada de volta");
        // a função do gatilho sem efeito (como a volta atrás pesada a deixa)
        await t.sql(
          "create or replace function public.tg_mensagens_saida_do_retorno() returns trigger language plpgsql security definer set search_path = '' as 'begin return null; end'",
        );
        t.igual(await ligados(), false, "a função do gatilho sem efeito");
      },
    );

    it.skipIf(!temTudo)(
      "com o relógio na versão 1 (e os 6 envios): a mesma cena cria a rodada pura de retorno",
      async () => {
        const c = await cena();
        await ligarRetornos(t, true);
        const rs = await pegar(t, 3, 3);
        t.igual(rs.length, 2, "a faixa 0 e a faixa 1");
        const pura = rs.find((r: Linha) => r.conversa_id === c.livre);
        t.igual(pura?.retorno_id, c.retorno, "a rodada pura leva o retorno");
        t.igual(await estado(t, c.retorno), ["em_rodada", null]);
        const comum = rs.find((r: Linha) => r.conversa_id === c.armada)!;
        const q = await amanha(t);
        t.igual((await marcar(t, comum.id, q.data, q.hora)).ok, true, "a Nina marca");
      },
    );

    it.skipIf(!temTudo)(
      "com o relógio na versão 1 (e os 6 envios): a rodada da faixa 0 leva junto o retorno vencido da conversa e a varredura curta fecha o de prazo vencido (o contrário dos desligados)",
      async () => {
        const c = await cena({ naArmada: true });
        await ligarRetornos(t, true);
        const rs = await pegar(t, 3, 3);
        const mista = rs.find((r: Linha) => r.conversa_id === c.armada);
        t.igual(mista?.retorno_id, c.rtArmada, "a faixa 0 leva o retorno junto");
        const rt = await retorno(t, c.rtArmada!);
        t.igual([rt.status, rt.rodada_id], ["em_rodada", mista?.id], "em_rodada na mista");
        t.igual(
          await estado(t, c.rtExpirado!),
          ["nao_enviado", "passou_do_prazo"],
          "a varredura curta fecha o de prazo vencido",
        );
      },
    );

    // I8: a lembrete_ao_concluir chamada direto (como a concluir_rodada do nina_retornos_rodada a
    // chama), para valer também no estado sem ele. Depois da volta atrás pesada ela não faz nada.
    it.skipIf(desfeito)(
      "I8: desligados, a lembrete_ao_concluir não arma, mas apaga o pendente quando o lead fala ou a Nina escreve de novo; ligados, arma",
      async () => {
        const b = await preparar(t);
        // ligados exige também o nina_retornos_rodada em vigor (a função do gatilho das bolhas, o
        // gatilho e a concluir_rodada que fecha o retorno: a retornos_ligados confere o conteúdo); sem
        // ele, uma retornos_ligados de mentira que só olha a versão, só neste banco de teste (o grupo
        // tem o teste da de verdade sem o nina_retornos_rodada)
        if (!temRodada)
          await t.sql(
            `create or replace function public.retornos_ligados() returns boolean language sql stable security definer
           set search_path = '' as 'select coalesce((select mo.relogio_versao >= 1 from public.motor mo where mo.id), false)'`,
          );
        const r = await rodadaDoLead(t, b, tel(1));
        const sim = JSON.stringify([responder("sim")]);
        const fim = (rodada: string, ferramentas: string) =>
          comoDono(
            t,
            `select public.lembrete_ao_concluir('${rodada}', 'na_fila', 1, '${ferramentas}'::jsonb)`,
          );
        const pendentes = () =>
          contar(
            t,
            "select 1 from public.retornos where conversa_id = $1 and tipo = 'lembrete' and status = 'pendente'",
            [r.conversa],
          );
        const lembreteAntigo = () =>
          inserir(t, r.conversa, {
            tipo: "lembrete",
            vence: "now() + interval '1 hour'",
            expira: "now() + interval '2 hours'",
          });

        await ligarRetornos(t, false);
        await fim(r.rodada.id, sim);
        t.igual(await pendentes(), 0, "desligados: a resposta que espera o lead não arma");
        await lembreteAntigo();
        await fim(r.rodada.id, sim);
        t.igual(await pendentes(), 0, "desligados: o lead falou nesta rodada, e o pendente some");
        await lembreteAntigo();
        const [{ id: semLead }] = await t.sql(
          "insert into public.rodadas (conversa_id, status, iniciada_em, terminada_em) values ($1, 'concluida', now(), now()) returning id",
          [r.conversa],
        );
        await fim(semLead as string, "[]");
        t.igual(await pendentes(), 0, "desligados: a Nina escreveu de novo, e o pendente some");

        await ligarRetornos(t, true);
        await fim(r.rodada.id, sim);
        const [lb] = await t.sql(
          "select rodada_origem_id from public.retornos where conversa_id = $1 and tipo = 'lembrete'",
          [r.conversa],
        );
        t.igual(lb?.rodada_origem_id, r.rodada.id, "ligados: arma, com a rodada de origem");
      },
    );

    it.skipIf(!temFluxo)(
      "I8 pelo fim da rodada: desligados, a resposta com espera_resposta 'sim' sai como hoje e não arma o lembrete; ligados, arma",
      async () => {
        const b = await preparar(t);
        await ligarRetornos(t, false);
        const r1 = await rodadaDoLead(t, b, tel(1));
        await concluir(t, r1.rodada.id, ["Pode me confirmar o horário?"], [responder("sim")]);
        t.igual(await saidasDa(t, r1.rodada.id), 1, "a resposta sai como hoje");
        t.igual(await contar(t, "select 1 from public.retornos"), 0, "desligados: nenhum lembrete");
        await ligarRetornos(t, true);
        const r2 = await rodadaDoLead(t, b, tel(2));
        await concluir(t, r2.rodada.id, ["Pode me confirmar o horário?"], [responder("sim")]);
        t.igual(
          (await retornosDa(t, r2.conversa)).map((l: Linha) => [l.tipo, l.status]),
          [["lembrete", "pendente"]],
          "ligados: arma",
        );
        t.igual(
          await contar(t, "select 1 from public.retornos where conversa_id = $1", [r1.conversa]),
          0,
          "a conversa de antes continua sem",
        );
      },
    );

    // Depois da volta atrás pesada, o relógio só varre e as pendências são as de hoje: pula.
    it.skipIf(desfeito)(
      "desligados, com um retorno pronto: o relógio não acorda o worker e as pendências são as de hoje; ligados, acorda e o retorno soma ao atraso",
      async () => {
        const b = await preparar(t);
        const c = await atendida(t, b, tel(1));
        const rt = await inserir(t, c.conversa);
        // o worker não é visto há 20 min: com os retornos ligados, o item pronto acorda já
        await motorPronto(t, { vistoHa: "20 minutes" });
        await ligarRetornos(t, false);
        t.ok(
          (await prontos(t)).some((p: Linha) => p.retorno_id === rt),
          "o retorno está pronto (a regra do 'pode sair' não muda)",
        );
        const antes = await pedidos(t);
        await relogio(t);
        t.igual(await pedidos(t), antes, "desligados: nenhum toque à toa");
        t.igual(await pendencias(t), await pendenciasHoje(t), "desligados: as pendências de hoje");
        t.igual(await estado(t, rt), ["pendente", null], "o retorno continua pendente");
        // ligados (sem o nina_retornos_rodada, pela retornos_ligados de mentira)
        await ligarRetornos(t, true);
        if (!temRodada) await ligadosDeMentira(t);
        const { vence_em } = await retorno(t, rt);
        t.igual((await pendencias(t)).atrasado, ms(vence_em), "ligados: o retorno soma ao atraso");
        await relogio(t);
        t.igual(await pedidos(t), antes + 1, "ligados: um toque");
      },
    );
  },
);

describe.skipIf(!temFluxo)(
  "banco: retornos, sem retorno gravado tudo como hoje",
  { timeout: TEMPO_TESTE },
  () => {
    const t = usarBanco(base);

    it("a rodada sem retorno_id conclui e falha como hoje; o relógio e a varredura não fazem nada", async () => {
      const b = await preparar(t);
      // concluir: as bolhas na fila, com a rodada; sem espera_resposta (o servidor antigo) nada arma
      const a = await rodadaDoLead(t, b, tel(1));
      await concluir(t, a.rodada.id, ["Oi!", "Tudo bem?"]);
      t.igual(await saidasDa(t, a.rodada.id), 2, "duas bolhas");
      t.igual(await contar(t, "select 1 from public.retornos"), 0, "nenhum lembrete");
      // falha passageira: a conversa volta a ser armada em 30 s, como hoje
      const c = await rodadaDoLead(t, b, tel(2));
      await falhar(t, c.rodada.id, "erro_provedor", true);
      const cv = await conversaDe(t, c.conversa);
      t.igual(cv.modo, "nina");
      perto(t, cv.responder_apos, Date.now() + 30_000, 5_000, "responder_apos de +30 s");
      // o erro do insert sobe igual para a rodada comum
      const d = await rodadaDoLead(t, b, tel(3));
      await t.sql("update public.conexoes set ativa = false");
      await t.erro(concluir(t, d.rodada.id, ["Oi!"]), "sem_conexao_ativa");
      await t.sql("update public.conexoes set ativa = true");
      // o relógio e a varredura, sem retorno: nada
      await motorPronto(t);
      const antes = await pedidos(t);
      await relogio(t);
      t.igual(await pedidos(t), antes, "nenhum toque");
      t.igual(await varrer(t), 0, "nada a varrer");
    });

    // A janela de 24 h só vale na conexão oficial (o preparar padrão usa a zapi): o janela_fechada do
    // gatilho do insert sobe igual na rodada comum, e o servidor publicado passa a conversa à equipe.
    it("a rodada sem retorno_id na oficial com a janela fechada: janela_fechada sobe como hoje, sem bolha e sem retorno", async () => {
      const b = await preparar(t, { gateway: "meta" });
      const d = await rodadaDoLead(t, b, tel(1));
      t.igual(d.rodada.retorno_id, null, "rodada comum");
      await t.sql(
        "update public.conversas set ultima_do_lead_em = now() - interval '25 hours' where id = $1",
        [d.conversa],
      );
      await t.erro(concluir(t, d.rodada.id, ["Oi!"]), "janela_fechada");
      const [{ s }] = await t.sql("select status::text as s from public.rodadas where id = $1", [
        d.rodada.id,
      ]);
      t.igual(s, "rodando", "a rodada continua rodando (o servidor a falha)");
      t.igual(await saidasDa(t, d.rodada.id), 0, "nenhuma bolha");
      t.igual(await contar(t, "select 1 from public.retornos"), 0, "nenhum retorno nem lembrete");
    });
  },
);

describe.skipIf(!temFluxo)("banco: retornos, o retorno combinado", { timeout: TEMPO_TESTE }, () => {
  const t = usarBanco(base);

  it("caso 1: marca, vence, a irmã pega pela faixa 1 uma vez só, conclui (saindo) e a bolha sai (enviado)", async () => {
    const b = await preparar(t);
    const r = await rodadaDoLead(t, b, tel(1));
    const q = await amanha(t);
    const res = await marcar(
      t,
      r.rodada.id,
      q.data,
      q.hora,
      "  Retomar a proposta do plano anual  ",
    );
    t.igual(
      Object.keys(res).sort(),
      ["igual", "ok", "retorno_id", "substituido_vence_em", "vence_em"],
      "o formato do ok",
    );
    t.igual([res.ok, res.igual, res.substituido_vence_em], [true, false, null]);
    t.igual(ms(res.vence_em), q.em.getTime(), "vence_em = amanhã 09:00 de Brasília");
    const rt = await retorno(t, res.retorno_id);
    t.igual(
      [
        rt.tipo,
        rt.status,
        rt.motivo,
        rt.rodada_origem_id,
        rt.rodada_id,
        rt.substitui_id,
        rt.tentativas,
      ],
      ["retorno", "pendente", "Retomar a proposta do plano anual", r.rodada.id, null, null, 0],
    );
    t.igual(ms(rt.expira_em), q.em.getTime() + 3 * HORA, "expira 3 h depois");
    perto(t, rt.marcado_em, Date.now(), 10_000, "marcado agora");
    await concluir(t, r.rodada.id, ["Combinado! Te chamo amanhã às 9h."], [responder("nao")]);
    await enviarTudo(t);

    // na hora
    await vencerRetorno(t, rt.id);
    const rs = await pegar(t);
    t.igual(rs.length, 1, "uma rodada");
    const pura = rs[0];
    t.igual(
      [pura.conversa_id, pura.retorno_id, pura.status, pura.passos],
      [r.conversa, rt.id, "rodando", 0],
    );
    t.igual(
      await contar(t, "select 1 from public.mensagens where rodada_id = $1", [pura.id]),
      0,
      "nenhuma entrada ligada",
    );
    const levado = await retorno(t, rt.id);
    t.igual([levado.status, levado.rodada_id, levado.tentativas], ["em_rodada", pura.id, 1]);
    t.igual(await pegar(t), [], "a 2ª chamada não repete");
    const lido = await daRodada(t, pura.id);
    t.igual(Object.keys(lido).sort(), [
      "da_rodada",
      "marcado_em",
      "motivo",
      "retorno_id",
      "tipo",
      "vence_em",
      "vencido",
    ]);
    t.igual(
      [lido.da_rodada, lido.retorno_id, lido.tipo, lido.motivo, lido.vencido],
      [true, rt.id, "retorno", "Retomar a proposta do plano anual", true],
    );
    t.igual(ms(lido.vence_em), ms(levado.vence_em), "vence_em");

    await concluir(
      t,
      pura.id,
      ["Oi! Como combinamos, voltei para falar do plano anual."],
      [responder("nao")],
    );
    t.igual(await estado(t, rt.id), ["saindo", null], "saindo");
    t.igual(await saidasDa(t, pura.id), 1, "a bolha da rodada pura");
    await enviarTudo(t);
    const fim = await retorno(t, rt.id);
    t.igual([fim.status, fim.nao_enviado_motivo], ["enviado", null], "enviado");
    const [{ m }] = await t.sql(
      "select min(momento) as m from public.mensagens where rodada_id = $1 and direcao = 'saida'",
      [pura.id],
    );
    t.igual(ms(fim.enviado_em), ms(m), "enviado_em = o momento da bolha");
    t.ok(fim.resolvido_em instanceof Date, "resolvido_em");
    t.igual((await conversaDe(t, r.conversa)).modo, "nina", "a conversa continua com a Nina");
  });

  it("quadro 2: na rodada do retorno, o lembrete arma depois (o retorno já está saindo)", async () => {
    const b = await preparar(t);
    const c = await comRetorno(t, b, tel(1));
    await vencerRetorno(t, c.retorno);
    const [pura] = await pegar(t);
    await concluir(t, pura.id, ["Oi! Conseguiu ver a proposta?"], [responder("sim")]);
    const linhas = await retornosDa(t, c.conversa);
    t.igual(
      linhas.map((l: Linha) => [l.tipo, l.status]),
      [
        ["retorno", "saindo"],
        ["lembrete", "pendente"],
      ],
    );
    t.igual(linhas[1].rodada_origem_id, pura.id, "o lembrete nasce da rodada do retorno");
  });

  it("relógio: acorda o worker certo; com o sinal antigo, só depois de 10 min sem worker (caso 1, A6)", async () => {
    const b = await preparar(t);
    const c = await atendida(t, b, tel(1));
    const rt = await inserir(t, c.conversa);
    const toques = async (opcoes: { sinalNovo?: boolean; vistoHa?: string }) => {
      await motorPronto(t, opcoes);
      const antes = await pedidos(t);
      await relogio(t);
      return (await pedidos(t)) - antes;
    };
    t.igual(await toques({ sinalNovo: true }), 1, "sinal novo: um toque");
    t.igual(
      await toques({ sinalNovo: false, vistoHa: "2 minutes" }),
      0,
      "worker antigo visto há 2 min: nenhum",
    );
    t.igual(
      await toques({ sinalNovo: false, vistoHa: "11 minutes" }),
      1,
      "worker sumido há 11 min: um toque",
    );
    t.igual(await estado(t, rt), ["pendente", null], "o relógio não pega o retorno");
    const [{ url }] = await t.sql(
      "select url from net.http_request_queue order by id desc limit 1",
    );
    t.igual(url, "https://nina-a.exemplo.test/api/public/cron/mensageria", "o toque é o do motor");
    // A6: o item pronto há mais de 10 min só toca pela regra dos 10 min sem worker ou pela pilha
    // andando. As rodadas das conversas atendidas terminaram agora: ficam 4 min para trás.
    await vencerRetorno(t, rt, "12 minutes");
    const terminadas = (ha: string, id?: string) =>
      id
        ? t.sql(`update public.rodadas set terminada_em = now() - interval '${ha}' where id = $1`, [
            id,
          ])
        : t.sql(
            `update public.rodadas set terminada_em = now() - interval '${ha}' where terminada_em is not null`,
          );
    await terminadas("4 minutes");
    t.igual(
      await toques({ sinalNovo: true, vistoHa: "2 minutes" }),
      0,
      "pronto há 12 min, worker vivo, nenhuma rodada terminada há menos de 3 min: nenhum",
    );
    // a pilha andando (caso 21 e I11b): QUALQUER rodada terminada há menos de 3 min, até a comum de
    // outra conversa (sem retorno_id). Sem isso, depois de 10 min da hora o worker não se renova (o
    // retorno velho sai do vencido_desde, A4), nem depois de uma rajada de leads que ocupou as vagas.
    const c2 = await atendida(t, b, tel(3));
    t.igual(
      (await t.sql("select retorno_id from public.rodadas where id = $1", [c2.rodada]))[0]
        .retorno_id,
      null,
      "a rodada comum",
    );
    await terminadas("4 minutes");
    await terminadas("1 minute", c2.rodada);
    t.igual(
      await toques({ sinalNovo: true, vistoHa: "2 minutes" }),
      1,
      "pronto há 12 min, worker novo visto há 2 min, uma rodada comum terminada há 1 min: um toque",
    );
    t.igual(
      await toques({ sinalNovo: false, vistoHa: "2 minutes" }),
      0,
      "pilha andando, mas o servidor antigo no ar (retornos_no_ar falso): nenhum",
    );
    // a rodada comum que falhou também conta; a cancelada, não
    const f = await rodadaDoLead(t, b, tel(4));
    await falhar(t, f.rodada.id, "erro_provedor", true);
    await terminadas("4 minutes");
    await terminadas("1 minute", f.rodada.id);
    t.igual(
      await toques({ sinalNovo: true, vistoHa: "2 minutes" }),
      1,
      "uma rodada comum que falhou há 1 min: um toque",
    );
    await terminadas("4 minutes");
    await t.sql(
      `insert into public.rodadas (conversa_id, status, iniciada_em, terminada_em)
       values ($1, 'cancelada', now() - interval '2 minutes', now() - interval '1 minute')`,
      [c2.conversa],
    );
    t.igual(
      await toques({ sinalNovo: true, vistoHa: "2 minutes" }),
      0,
      "só uma rodada cancelada há 1 min: nenhum",
    );
    t.igual(
      await toques({ sinalNovo: true, vistoHa: "2 minutes" }),
      0,
      "pilha parada há mais de 3 min: nenhum",
    );
    t.igual(
      await toques({ sinalNovo: true, vistoHa: "11 minutes" }),
      1,
      "pronto há 12 min, worker sumido: um toque",
    );
    // nada pronto: nenhum toque
    await t.sql(
      "update public.retornos set vence_em = now() + interval '1 hour', expira_em = now() + interval '4 hours'",
    );
    t.igual(await toques({ sinalNovo: true }), 0, "nada pronto");
    // sem endereço: não falha
    await inserir(t, (await atendida(t, b, tel(2))).conversa);
    await t.sql("update public.motor set url = null, tocado_em = null");
    await relogio(t);
  });

  it("relógio: o lembrete pronto também acorda; o desligado, não", async () => {
    const b = await preparar(t);
    const c = await atendida(t, b, tel(1));
    const lb = await inserir(t, c.conversa, { tipo: "lembrete" });
    await motorPronto(t);
    let antes = await pedidos(t);
    await relogio(t);
    t.igual((await pedidos(t)) - antes, 1, "lembrete pronto: um toque");
    await t.sql("update public.configuracao set lembrete_ligado = false where id = 1");
    await motorPronto(t);
    antes = await pedidos(t);
    await relogio(t);
    t.igual((await pedidos(t)) - antes, 0, "desligado: nenhum");
    t.igual(await retorno(t, lb), undefined, "e a varredura do relógio apaga o lembrete");
  });

  /** Quantos toques o relógio dá, com o worker (que conhece retornos) visto há 2 min. */
  const toquesDoRelogio = async () => {
    await motorPronto(t);
    const antes = await pedidos(t);
    await relogio(t);
    return (await pedidos(t)) - antes;
  };

  it("relógio: acorda pela rodada de retorno presa (a limpeza de presas é do worker), não pela que roda há pouco", async () => {
    const b = await preparar(t);
    const c = await atendida(t, b, tel(1));
    const rt = await inserir(t, c.conversa);
    const [pura] = await pegar(t);
    t.igual(pura.retorno_id, rt);
    t.igual(await estado(t, rt), ["em_rodada", null]);
    t.igual(await prontos(t), [], "nada pronto: só o item preso pode acordar");
    await t.sql(
      "update public.rodadas set iniciada_em = now() - interval '1 minute' where id = $1",
      [pura.id],
    );
    t.igual(await toquesDoRelogio(), 0, "rodando há 1 min: nenhum");
    await t.sql(
      "update public.rodadas set iniciada_em = now() - interval '6 minutes' where id = $1",
      [pura.id],
    );
    t.igual(await toquesDoRelogio(), 1, "rodando há 6 min: um toque");
    t.igual(
      await estado(t, rt),
      ["em_rodada", null],
      "o relógio não mexe na rodada (quem limpa é a pegar_rodadas do worker)",
    );
    // o toque pelo item preso independe dos retornos desligados: só a limpeza de presas do worker
    // solta a rodada
    await ligarRetornos(t, false);
    t.igual(await toquesDoRelogio(), 1, "desligados: o preso ainda dá um toque");
  });

  it("relógio: acorda pela bolha do retorno parada na fila, com o WhatsApp conectado e dentro do prazo", async () => {
    const b = await preparar(t);
    const c = await atendida(t, b, tel(1));
    const rt = await inserir(t, c.conversa);
    const [pura] = await pegar(t);
    await concluir(t, pura.id, ["Oi! Como combinamos..."], [responder("nao")]);
    t.igual(await estado(t, rt), ["saindo", null]);
    const bolhaHa = (expr: string) =>
      t.sql(
        `update public.mensagens set criado_em = ${expr}, enviar_apos = ${expr} where rodada_id = $1 and direcao = 'saida'`,
        [pura.id],
      );
    await bolhaHa("now()");
    t.igual(await toquesDoRelogio(), 0, "a bolha criada agora: nenhum");
    await bolhaHa("now() - interval '2 minutes'");
    t.igual(await toquesDoRelogio(), 1, "a bolha parada há 2 min: um toque");
    // enviando: só a presa há mais de 2 min (o corte da pegar_envios)
    t.igual(
      (await servidor(t, "select id from public.pegar_envios(10)")).length,
      1,
      "o envio pega a bolha",
    );
    t.igual(await toquesDoRelogio(), 0, "enviando agora: nenhum");
    await t.sql(
      "update public.mensagens set status_em = now() - interval '3 minutes' where rodada_id = $1 and direcao = 'saida'",
      [pura.id],
    );
    t.igual(await toquesDoRelogio(), 1, "enviando há 3 min: um toque");
    // sem WhatsApp, a bolha não sai: nenhum toque
    await t.sql("update public.conexoes set status = 'desconectada' where id = $1", [b.cx]);
    t.igual(await toquesDoRelogio(), 0, "WhatsApp fora: nenhum");
    await t.sql("update public.conexoes set status = 'conectada' where id = $1", [b.cx]);
    t.igual(await toquesDoRelogio(), 1, "WhatsApp de volta: um toque");
    // passado o prazo, nenhum (a varredura G e o acontecimento seguinte cuidam do resto)
    await t.sql(
      "update public.retornos set vence_em = now() - interval '4 hours', expira_em = now() - interval '1 minute' where id = $1",
      [rt],
    );
    t.igual(await toquesDoRelogio(), 0, "passado o prazo: nenhum");
    t.igual(await estado(t, rt), ["saindo", null], "a bolha ainda pode sair");
  });

  it("relógio (regra de ouro): a rodada comum presa e a bolha comum parada na fila, sem retorno, não acordam", async () => {
    const b = await preparar(t);
    const c = await atendida(t, b, tel(2), { enviar: false });
    await t.sql(
      "update public.mensagens set criado_em = now() - interval '2 minutes', enviar_apos = now() - interval '2 minutes' where rodada_id = $1 and direcao = 'saida'",
      [c.rodada],
    );
    const r = await rodadaDoLead(t, b, tel(1));
    await t.sql(
      "update public.rodadas set iniciada_em = now() - interval '6 minutes' where id = $1",
      [r.rodada.id],
    );
    t.igual(await contar(t, "select 1 from public.retornos"), 0, "nenhum retorno");
    t.igual(await toquesDoRelogio(), 0, "nenhum toque");
  });

  it("caso 3: o lead responde antes; a rodada dele não leva o retorno, que continua pendente", async () => {
    const b = await preparar(t);
    const q = await local(t, "now() + interval '1 hour'");
    const c = await comRetorno(t, b, tel(1), q);
    const e = await entrada(t, b.cx, tel(1), { texto: "valeu, até amanhã" });
    t.igual(e.conversa_id, c.conversa);
    await vencer(t, c.conversa);
    const [rd] = await pegar(t);
    t.igual(rd.retorno_id, null, "rodada comum");
    t.igual(await estado(t, c.retorno), ["pendente", null]);
    const lido = await daRodada(t, rd.id);
    t.igual(
      [lido.da_rodada, lido.retorno_id, lido.tipo, lido.motivo, lido.vencido],
      [false, c.retorno, "retorno", "Retomar a proposta", false],
    );
    t.igual(ms(lido.vence_em), q.em.getTime(), "a hora marcada");
  });

  it("caso 4: o lead muda o horário; o novo substitui o pendente; a mesma hora é 'igual' e não grava nada", async () => {
    const b = await preparar(t);
    const c = await comRetorno(t, b, tel(1));
    const r2 = await rodadaDoLead(t, b, tel(1));
    const q9 = await amanha(t, "09:00");
    const q10 = await amanha(t, "10:00");
    const res = await marcar(t, r2.rodada.id, q10.data, q10.hora);
    t.igual([res.ok, res.igual], [true, false]);
    t.igual(ms(res.substituido_vence_em), q9.em.getTime(), "o horário substituído");
    t.igual(ms(res.vence_em), q10.em.getTime());
    const [velho, novo] = await retornosDa(t, c.conversa);
    t.igual(
      [
        velho.id,
        velho.status,
        velho.fechado_por_rodada,
        velho.cancelado_por,
        velho.resolvido_em instanceof Date,
      ],
      [c.retorno, "cancelado", r2.rodada.id, null, true],
      "o antigo",
    );
    t.igual(
      [novo.id, novo.status, novo.substitui_id, novo.rodada_origem_id],
      [res.retorno_id, "pendente", c.retorno, r2.rodada.id],
      "o novo",
    );
    // a mesma hora de novo: igual, sem gravar
    const de_novo = await marcar(t, r2.rodada.id, q10.data, q10.hora, "Outro assunto");
    t.igual(
      [de_novo.ok, de_novo.igual, de_novo.retorno_id, de_novo.substituido_vence_em],
      [true, true, res.retorno_id, null],
      "igual",
    );
    t.igual(ms(de_novo.vence_em), q10.em.getTime());
    const depois = await retornosDa(t, c.conversa);
    t.igual(depois.length, 2, "nenhuma linha nova");
    t.igual(depois[1], novo, "o pendente não mudou");
  });

  it("caso 4 (igual): o pendente com o prazo vencido, que a varredura C ainda não fechou, não é 'igual': a mesma hora dá no_passado", async () => {
    const b = await preparar(t);
    const r = await rodadaDoLead(t, b, tel(1));
    const q = await local(t, "now() - interval '4 hours'");
    const em = `'${q.em.toISOString()}'::timestamptz`;
    const rt = await inserir(t, r.conversa, { vence: em, expira: `${em} + interval '3 hours'` });
    t.igual(await estado(t, rt), ["pendente", null], "ainda pendente (a varredura C não passou)");
    t.igual(
      await marcar(t, r.rodada.id, q.data, q.hora),
      { ok: false, erro: "no_passado", limite: null },
      "no_passado, e não igual",
    );
    t.igual(await estado(t, rt), ["pendente", null], "nada muda");
    // contraprova: dentro do prazo, a mesma hora é igual
    await t.sql("update public.retornos set expira_em = now() + interval '1 hour' where id = $1", [
      rt,
    ]);
    const res = await marcar(t, r.rodada.id, q.data, q.hora);
    t.igual([res.ok, res.igual, res.retorno_id], [true, true, rt], "dentro do prazo: igual");
  });

  it("caso 5a: a Nina cancela (nota_fim); de novo dá sem_retorno; o porquê é cortado em 300", async () => {
    const b = await preparar(t);
    const c = await comRetorno(t, b, tel(1));
    const r2 = await rodadaDoLead(t, b, tel(1));
    const res = await ninaCancela(t, r2.rodada.id, "  O lead fechou pelo site  ");
    t.igual(Object.keys(res).sort(), ["ok", "retorno_id", "vence_em"], "o formato do ok");
    t.igual([res.ok, res.retorno_id], [true, c.retorno]);
    t.igual(ms(res.vence_em), (await amanha(t)).em.getTime());
    const rt = await retorno(t, c.retorno);
    t.igual(
      [
        rt.status,
        rt.fechado_por_rodada,
        rt.nota_fim,
        rt.cancelado_por,
        rt.resolvido_em instanceof Date,
      ],
      ["cancelado", r2.rodada.id, "O lead fechou pelo site", null, true],
    );
    const de_novo = await ninaCancela(t, r2.rodada.id, "x");
    t.igual(de_novo, { ok: false, erro: "sem_retorno" }, "sem retorno");
    const q = await amanha(t, "11:00");
    t.igual((await marcar(t, r2.rodada.id, q.data, q.hora)).ok, true);
    const longo = await ninaCancela(t, r2.rodada.id, "y".repeat(400));
    t.igual((await retorno(t, longo.retorno_id)).nota_fim, "y".repeat(300), "300 caracteres");
    t.igual((await marcar(t, r2.rodada.id, q.data, "12:00")).ok, true);
    const vazio = await ninaCancela(t, r2.rodada.id, "   ");
    t.igual((await retorno(t, vazio.retorno_id)).nota_fim, null, "sem porquê");
  });

  it("caso 5b (quadro 8): na hora, a Nina relê e não manda: dispensado com o porquê do sem_resposta aceito", async () => {
    const b = await preparar(t);
    for (const [n, aceito, nota] of [
      [1, true, "O lead já fechou"],
      [2, false, null],
    ] as const) {
      const c = await comRetorno(t, b, tel(n));
      await vencerRetorno(t, c.retorno);
      const [pura] = await pegar(t);
      await concluir(t, pura.id, [], [semResposta("O lead já fechou", aceito)], 1);
      const rt = await retorno(t, c.retorno);
      t.igual(
        [rt.status, rt.nota_fim, rt.resolvido_em instanceof Date],
        ["dispensado", nota, true],
        `aceito=${aceito}`,
      );
      t.igual(await saidasDa(t, pura.id), 0, "nenhuma bolha");
      const [{ status }] = await t.sql("select status::text from public.rodadas where id = $1", [
        pura.id,
      ]);
      t.igual(status, "concluida");
    }
  });

  it("caso 6: atendente e admin cancelam; o que já saiu, o inexistente e o torto são recusados (quadro 13)", async () => {
    const b = await preparar(t);
    const c1 = await comRetorno(t, b, tel(1));
    await equipeCancela(t, b.uAtend, c1.retorno);
    const r1 = await retorno(t, c1.retorno);
    t.igual(
      [r1.status, r1.cancelado_por, r1.fechado_por_rodada, r1.resolvido_em instanceof Date],
      ["cancelado", b.mAtend, null, true],
    );
    await t.erro(equipeCancela(t, b.uAtend, c1.retorno), "retorno_nao_pendente");
    const c2 = await comRetorno(t, b, tel(2));
    await equipeCancela(t, b.uAdmin, c2.retorno);
    t.igual((await retorno(t, c2.retorno)).cancelado_por, b.mAdmin, "o admin");
    // depois da irmã pegar: já saiu
    const c3 = await comRetorno(t, b, tel(3));
    await vencerRetorno(t, c3.retorno);
    t.igual((await pegar(t)).length, 1);
    await t.erro(equipeCancela(t, b.uAtend, c3.retorno), "retorno_nao_pendente");
    t.igual((await retorno(t, c3.retorno)).status, "em_rodada", "continua na rodada");
    await t.erro(
      equipeCancela(t, b.uAtend, "00000000-0000-4000-8000-000000000000"),
      "retorno_nao_pendente",
    );
    await t.erro(equipeCancela(t, b.uAtend, "torto"), "22P02");
    // o vencido que ainda espera (conversa armada) pode ser cancelado: ele não saiu
    const c4 = await comRetorno(t, b, tel(4));
    await vencerRetorno(t, c4.retorno);
    await entrada(t, b.cx, tel(4));
    await equipeCancela(t, b.uAtend, c4.retorno);
    t.igual((await retorno(t, c4.retorno)).status, "cancelado");
    // o lembrete também
    const c5 = await atendida(t, b, tel(5), { ferramentas: [responder("sim")] });
    const [lb] = await retornosDa(t, c5.conversa);
    t.igual(lb.tipo, "lembrete");
    await equipeCancela(t, b.uAtend, lb.id);
    t.igual(
      [(await retorno(t, lb.id)).status, (await retorno(t, lb.id)).cancelado_por],
      ["cancelado", b.mAtend],
    );
  });

  it("caso 6 e 22: a conta sem convite e o membro desativado não cancelam (sem_acesso)", async () => {
    const b = await preparar(t);
    const c = await comRetorno(t, b, tel(1));
    await t.erro(equipeCancela(t, b.uSem, c.retorno), "sem_acesso");
    await t.erro(equipeCancela(t, null, c.retorno), "sem_acesso");
    await t.sql("update public.membros set ativo = false where id = $1", [b.mAtend]);
    await t.erro(equipeCancela(t, b.uAtend, c.retorno), "sem_acesso");
    t.igual(await estado(t, c.retorno), ["pendente", null]);
    // o servidor também cancela (service_role), sem membro
    await t.erro(
      t.como("service_role", null, (q) => q("select public.cancelar_retorno($1)", [c.retorno])),
      "sem_acesso",
    );
  });

  it("caso 7a: com a equipe na hora, o retorno vira não enviado (com_equipe) na hora e a irmã não pega", async () => {
    const b = await preparar(t);
    const c = await comRetorno(t, b, tel(1));
    await assumir(t, b.uAtend, c.conversa);
    await vencerRetorno(t, c.retorno);
    t.igual(await prontos(t), [], "não está pronto");
    t.igual(await pendencias(t), NADA, "não conta para o atraso");
    t.igual(await varrer(t), 1, "a varredura muda uma linha");
    const rt = await retorno(t, c.retorno);
    t.igual([rt.status, rt.nao_enviado_motivo, rt.rodada_id], ["nao_enviado", "com_equipe", null]);
    t.ok(ms(rt.resolvido_em)! >= ms(rt.vence_em)!, "resolvido na hora");
    t.igual(await pegar(t), [], "nenhuma rodada");
    // pelo relógio também
    const c2 = await comRetorno(t, b, tel(2));
    await assumir(t, b.uAtend, c2.conversa);
    await vencerRetorno(t, c2.retorno);
    await relogio(t);
    t.igual(await estado(t, c2.retorno), ["nao_enviado", "com_equipe"], "pelo relógio");
    // e pela própria irmã (a varredura curta)
    const c3 = await comRetorno(t, b, tel(3));
    await assumir(t, b.uAtend, c3.conversa);
    await vencerRetorno(t, c3.retorno);
    t.igual(await pegar(t), []);
    t.igual(await estado(t, c3.retorno), ["nao_enviado", "com_equipe"], "pela irmã");
  });

  it("caso 7b: assumiu e devolveu antes da hora: vale, a irmã pega", async () => {
    const b = await preparar(t);
    const c = await comRetorno(t, b, tel(1));
    await assumir(t, b.uAtend, c.conversa);
    await devolver(t, b.uAtend, c.conversa);
    t.igual(
      (await conversaDe(t, c.conversa)).responder_apos,
      null,
      "a devolução não armou (a Nina já tinha respondido)",
    );
    await vencerRetorno(t, c.retorno);
    const [pura] = await pegar(t);
    t.igual([pura.conversa_id, pura.retorno_id], [c.conversa, c.retorno]);
  });

  it("caso 9: na oficial, fora das 24 h: recusa com o limite (última do lead + 23 h 50) e não grava nada", async () => {
    const b = await preparar(t, { gateway: "meta" });
    const e = await entrada(t, b.cx, tel(1), {
      momento: new Date(Date.now() - HORA).toISOString(),
    });
    await vencer(t, e.conversa_id);
    const [rd] = await pegar(t);
    const { ultima_do_lead_em: ultima } = await conversaDe(t, e.conversa_id);
    const fora = await local(t, "now() + interval '24 hours'");
    const res = await marcar(t, rd.id, fora.data, fora.hora);
    t.igual(Object.keys(res).sort(), ["erro", "limite", "ok"], "o formato da recusa");
    t.igual([res.ok, res.erro], [false, "fora_das_24h"]);
    perto(t, res.limite, ms(ultima)! + 23 * HORA + 50 * MIN, 1, "o limite");
    t.igual(await contar(t, "select 1 from public.retornos"), 0, "nada gravado");
    const dentro = await local(t, "now() + interval '22 hours'");
    t.igual((await marcar(t, rd.id, dentro.data, dentro.hora)).ok, true, "dentro do limite");
  });

  it("caso 10: no passado, longe demais, motivo e data inválidos; rodada que já acabou", async () => {
    const b = await preparar(t);
    const r = await rodadaDoLead(t, b, tel(1));
    for (const expr of ["now() - interval '1 day'", "now() - interval '1 minute'"]) {
      const q = await local(t, expr);
      t.igual(
        await marcar(t, r.rodada.id, q.data, q.hora),
        { ok: false, erro: "no_passado", limite: null },
        expr,
      );
    }
    const longe = await local(t, "now() + interval '31 days'");
    const res = await marcar(t, r.rodada.id, longe.data, longe.hora);
    t.igual([res.ok, res.erro], [false, "longe_demais"]);
    const [{ l }] = await t.sql("select now() + interval '30 days' as l");
    perto(t, res.limite, l, 30_000, "o limite de 30 dias");
    const q = await amanha(t);
    await t.erro(marcar(t, r.rodada.id, q.data, q.hora, "   "), "motivo_invalido");
    await t.erro(marcar(t, r.rodada.id, q.data, q.hora, "m".repeat(301)), "motivo_invalido");
    await t.erro(marcar(t, r.rodada.id, null, q.hora), "data_invalida");
    await t.erro(marcar(t, r.rodada.id, q.data, null), "data_invalida");
    t.igual(await contar(t, "select 1 from public.retornos"), 0, "nada gravado");
    t.igual(
      (await marcar(t, r.rodada.id, q.data, q.hora, "m".repeat(300))).ok,
      true,
      "300 caracteres cabem",
    );
    await concluir(t, r.rodada.id, ["Combinado"]);
    await t.erro(marcar(t, r.rodada.id, q.data, "10:00"), "rodada_nao_rodando");
    await t.erro(ninaCancela(t, r.rodada.id, "x"), "rodada_nao_rodando");
    await t.erro(daRodada(t, r.rodada.id), "rodada_nao_rodando");
    await t.erro(
      marcar(t, "00000000-0000-4000-8000-000000000000", q.data, q.hora),
      "rodada_nao_rodando",
    );
  });

  it("D9: na rodada pura (sem fala do lead) a Nina não marca nem cancela; a marcação some o lembrete pendente", async () => {
    const b = await preparar(t);
    const c = await comRetorno(t, b, tel(1));
    await vencerRetorno(t, c.retorno);
    const [pura] = await pegar(t);
    const q = await amanha(t, "15:00");
    await t.erro(marcar(t, pura.id, q.data, q.hora), "rodada_sem_lead");
    await t.erro(ninaCancela(t, pura.id, "x"), "rodada_sem_lead");
    // marcar cancela o lembrete pendente (o contrato)
    const c2 = await atendida(t, b, tel(2), { ferramentas: [responder("sim")] });
    t.igual(
      (await retornosDa(t, c2.conversa)).map((l: Linha) => l.tipo),
      ["lembrete"],
    );
    const r2 = await rodadaDoLead(t, b, tel(2));
    t.igual((await marcar(t, r2.rodada.id, q.data, q.hora)).ok, true);
    t.igual(
      (await retornosDa(t, c2.conversa)).map((l: Linha) => [l.tipo, l.status]),
      [["retorno", "pendente"]],
      "o lembrete sumiu",
    );
    // a rodada que marcou falha depois: o retorno fica (a equipe vê e a nova tentativa confirma)
    await falhar(t, r2.rodada.id, "erro_provedor", true);
    t.igual(
      (await retornosDa(t, c2.conversa)).map((l: Linha) => l.status),
      ["pendente"],
    );
  });
});

describe.skipIf(!temFluxo)(
  "banco: retornos, o lead escreve bem na hora (caso 8, A1 a A3)",
  { timeout: TEMPO_TESTE },
  () => {
    const t = usarBanco(base);

    /** Uma conversa atendida com um retorno marcado há 1 dia para `vence` (expressão SQL). */
    async function comRetornoPara(b: Preparo, n: number, vence: string) {
      const c = await atendida(t, b, tel(n));
      const rt = await inserir(t, c.conversa, {
        vence,
        expira: `${vence} + interval '3 hours'`,
        marcado: "now() - interval '1 day'",
      });
      return { ...c, retorno: rt };
    }

    /** O lead escreve e a irmã pega a rodada dele (mista, se o retorno for levado junto). */
    async function leadEscreve(b: Preparo, n: number, conversa: string) {
      const e = await entrada(t, b.cx, tel(n), { texto: "ok" });
      await vencer(t, conversa);
      const rs = (await pegar(t)).filter((r: Linha) => r.conversa_id === conversa);
      t.igual(rs.length, 1, "uma rodada do lead");
      return { rodada: rs[0] as Linha, entrada: e.mensagem_id };
    }

    it("8a: o retorno vencido espera o lote do lead; depois, UMA rodada com as entradas e o retorno (mista)", async () => {
      const b = await preparar(t);
      const c = await comRetornoPara(b, 1, "now() - interval '1 minute'");
      const e = await entrada(t, b.cx, tel(1));
      t.igual(await pegar(t), [], "a conversa armada espera (o lote do lead não é cortado)");
      t.igual(await estado(t, c.retorno), ["pendente", null]);
      await vencer(t, c.conversa);
      const rs = await pegar(t);
      t.igual(rs.length, 1, "uma rodada só");
      t.igual(rs[0].retorno_id, c.retorno, "leva o retorno junto");
      const ent = (
        await t.sql(
          "select id from public.mensagens where rodada_id = $1 and direcao = 'entrada'",
          [rs[0].id],
        )
      ).map((m: Linha) => m.id);
      t.igual(ent, [e.mensagem_id], "com a entrada do lead");
      const rt = await retorno(t, c.retorno);
      t.igual([rt.status, rt.rodada_id, rt.tentativas], ["em_rodada", rs[0].id, 1]);
      const lido = await daRodada(t, rs[0].id);
      t.igual([lido.da_rodada, lido.tipo, lido.retorno_id], [true, "retorno", c.retorno]);
      await t.erro(equipeCancela(t, b.uAtend, c.retorno), "retorno_nao_pendente");
    });

    it("8a (margem): retorno a 5 min, marcado há tempo, vai junto; a 11 min, não", async () => {
      const b = await preparar(t);
      const c5 = await comRetornoPara(b, 1, "now() + interval '5 minutes'");
      t.igual((await leadEscreve(b, 1, c5.conversa)).rodada.retorno_id, c5.retorno, "5 min: junto");
      const c11 = await comRetornoPara(b, 2, "now() + interval '11 minutes'");
      t.igual((await leadEscreve(b, 2, c11.conversa)).rodada.retorno_id, null, "11 min: não");
      t.igual(await estado(t, c11.retorno), ["pendente", null]);
    });

    it("A3: o retorno curto (marcado há menos de 30 min da hora) não é gasto pelo 'ok' do lead", async () => {
      const b = await preparar(t);
      const q = await local(t, "now() + interval '6 minutes'");
      const c = await comRetorno(t, b, tel(1), q);
      const { rodada } = await leadEscreve(b, 1, c.conversa);
      t.igual(rodada.retorno_id, null, "o 'ok' não leva o retorno de daqui a 5 min");
      t.igual(await estado(t, c.retorno), ["pendente", null]);
      await concluir(t, rodada.id, ["Perfeito!"]);
      await enviarTudo(t);
      await vencerRetorno(t, c.retorno);
      const [pura] = await pegar(t);
      t.igual(pura.retorno_id, c.retorno, "na hora, a faixa 1 pega");
    });

    it("A3: antes da hora, remarcar a mesma hora do levado grava um pendente novo e a promessa é cumprida", async () => {
      const b = await preparar(t);
      // às 08:52, "me chama às 9 como combinado": o retorno das 9 (marcado ontem) vai junto da resposta
      const q = await local(t, "now() + interval '6 minutes'");
      const c = await atendida(t, b, tel(1));
      const rt = await inserir(t, c.conversa, {
        vence: `'${q.em.toISOString()}'::timestamptz`,
        expira: `'${q.em.toISOString()}'::timestamptz + interval '3 hours'`,
        marcado: "now() - interval '1 day'",
      });
      const { rodada } = await leadEscreve(b, 1, c.conversa);
      t.igual(rodada.retorno_id, rt, "levado");
      const res = await marcar(t, rodada.id, q.data, q.hora);
      t.igual(
        [res.ok, res.igual, res.substituido_vence_em],
        [true, false, null],
        "não é igual: grava um pendente novo",
      );
      t.ok(res.retorno_id && res.retorno_id !== rt, "o id do pendente novo");
      await concluir(t, rodada.id, ["Combinado, às 9h te chamo."]);
      await enviarTudo(t);
      t.igual(await estado(t, rt), ["enviado", null], "o levado sai pelas bolhas desta rodada");
      t.igual(
        await estado(t, res.retorno_id as string),
        ["pendente", null],
        "o novo fica para a hora",
      );
      t.igual(
        (await retorno(t, res.retorno_id as string)).substitui_id,
        null,
        "o levado não foi substituído",
      );
      await vencerRetorno(t, res.retorno_id as string);
      const [pura] = await pegar(t);
      t.igual(pura?.retorno_id, res.retorno_id, "na hora, a faixa 1 cumpre a promessa");
    });

    it("A3: antes da hora, remarcar a mesma hora do levado e depois cancelar: só o levado é cancelado, e o novo sai na hora", async () => {
      const b = await preparar(t);
      const q = await local(t, "now() + interval '6 minutes'");
      const c = await atendida(t, b, tel(1));
      const rt = await inserir(t, c.conversa, {
        vence: `'${q.em.toISOString()}'::timestamptz`,
        expira: `'${q.em.toISOString()}'::timestamptz + interval '3 hours'`,
        marcado: "now() - interval '1 day'",
      });
      const { rodada } = await leadEscreve(b, 1, c.conversa);
      t.igual(rodada.retorno_id, rt, "levado");
      const res = await marcar(t, rodada.id, q.data, q.hora);
      t.igual([res.ok, res.igual], [true, false], "grava um pendente novo");
      const can = await ninaCancela(t, rodada.id, "O lead adiou para a mesma hora");
      t.igual([can.ok, can.retorno_id], [true, rt], "cancela o levado");
      await concluir(t, rodada.id, ["Combinado, às 9h te chamo."]);
      await enviarTudo(t);
      t.igual(await estado(t, rt), ["cancelado", null], "o levado cancelado");
      t.igual(
        await estado(t, res.retorno_id as string),
        ["pendente", null],
        "o novo continua pendente",
      );
      await vencerRetorno(t, res.retorno_id as string);
      const [pura] = await pegar(t);
      t.igual(pura?.retorno_id, res.retorno_id, "na hora, a faixa 1 pega o novo");
    });

    it("8b (B2): a devolução sem entrada nova não leva o retorno junto; a rodada dela sai sem retorno", async () => {
      const b = await preparar(t);
      const c = await atendida(t, b, tel(1), { enviar: false });
      await assumir(t, b.uAtend, c.conversa); // cancela as bolhas na fila
      await devolver(t, b.uAtend, c.conversa); // arma: a entrada é mais nova que a última saída válida
      t.ok((await conversaDe(t, c.conversa)).responder_apos, "a devolução armou");
      const rt = await inserir(t, c.conversa);
      const rs = await pegar(t);
      t.igual(rs.length, 1);
      t.igual(rs[0].retorno_id, null, "sem fala do lead: sem levar junto");
      t.igual(
        await contar(t, "select 1 from public.mensagens where rodada_id = $1", [rs[0].id]),
        0,
        "sem entradas",
      );
      t.igual(await estado(t, rt), ["pendente", null]);
      await concluir(t, rs[0].id, ["Voltei! Posso ajudar?"]);
      const [pura] = await pegar(t);
      t.igual(pura.retorno_id, rt, "depois, a faixa 1 pega");
    });

    it("8e: o lead escreve durante a rodada pura: as bolhas são descartadas e o retorno volta, levado junto depois", async () => {
      const b = await preparar(t);
      const c = await comRetorno(t, b, tel(1));
      await vencerRetorno(t, c.retorno);
      const [pura] = await pegar(t);
      const e = await entrada(t, b.cx, tel(1), { texto: "oi, tô aqui" });
      await concluir(t, pura.id, ["Oi! Como combinamos..."], [responder("sim")]);
      t.igual(await saidasDa(t, pura.id), 0, "nenhuma bolha inserida");
      const rt = await retorno(t, c.retorno);
      t.igual([rt.status, rt.rodada_id], ["pendente", null], "voltou");
      perto(t, rt.tentar_apos, Date.now(), 10_000, "tentar_apos agora");
      t.igual(
        await contar(t, "select 1 from public.retornos where tipo = 'lembrete'"),
        0,
        "nenhum lembrete",
      );
      await vencer(t, c.conversa);
      const [mista] = await pegar(t);
      t.igual(mista.retorno_id, c.retorno, "uma resposta só, que trata do retorno");
      t.igual(
        (
          await t.sql(
            "select id from public.mensagens where rodada_id = $1 and direcao = 'entrada'",
            [mista.id],
          )
        ).map((m: Linha) => m.id),
        [e.mensagem_id],
      );
    });

    it("8i: na mista, o lead escreve de novo enquanto a Nina responde: a resposta sai (sem descarte), o retorno fica saindo e a próxima rodada lê só a 2ª entrada", async () => {
      const b = await preparar(t);
      const c = await comRetornoPara(b, 1, "now() - interval '1 minute'");
      const { rodada } = await leadEscreve(b, 1, c.conversa);
      t.igual(rodada.retorno_id, c.retorno, "a mista leva o retorno");
      const e2 = await entrada(t, b.cx, tel(1), { texto: "e mais uma coisa" });
      t.ok(
        (await conversaDe(t, c.conversa)).responder_apos instanceof Date,
        "a 2ª entrada armou a conversa",
      );
      await concluir(t, rodada.id, ["Oi! Sobre o que combinamos..."], [responder("nao")]);
      t.igual(
        await contar(
          t,
          "select 1 from public.mensagens where rodada_id = $1 and direcao = 'saida' and status = 'na_fila'",
          [rodada.id],
        ),
        1,
        "a resposta ao lead entra na fila (a mista não descarta)",
      );
      t.igual(await estado(t, c.retorno), ["saindo", null], "o retorno sai junto");
      t.ok(
        (await conversaDe(t, c.conversa)).responder_apos instanceof Date,
        "a conversa segue armada",
      );
      await vencer(t, c.conversa);
      const rs = (await pegar(t)).filter((r: Linha) => r.conversa_id === c.conversa);
      t.igual(rs.length, 1, "uma rodada");
      t.igual(rs[0].retorno_id, null, "rodada comum: o retorno já está saindo");
      t.igual(
        (
          await t.sql(
            "select id from public.mensagens where rodada_id = $1 and direcao = 'entrada'",
            [rs[0].id],
          )
        ).map((m: Linha) => m.id),
        [e2.mensagem_id],
        "só a 2ª entrada",
      );
    });

    it("A1 (a Nina passa para a equipe e não escreve, depois da hora): na mista e na pura, com_equipe logo no fim da rodada, sem esperar a varredura", async () => {
      const b = await preparar(t);
      // a mista: a Nina chama passar_para_humano e conclui sem bolha
      const c = await comRetornoPara(b, 1, "now() - interval '1 minute'");
      const { rodada } = await leadEscreve(b, 1, c.conversa);
      t.igual(rodada.retorno_id, c.retorno, "a mista leva o retorno");
      await servidor(t, "select public.nina_passar_para_humano($1)", [rodada.id]);
      await concluir(t, rodada.id, [], [], 1);
      t.igual(
        await estado(t, c.retorno),
        ["nao_enviado", "com_equipe"],
        "mista: com_equipe sem varrer (e não pendente)",
      );
      t.igual((await conversaDe(t, c.conversa)).modo, "humano");
      t.igual(await saidasDa(t, rodada.id), 0, "mista: nenhuma bolha");
      // a pura (defesa: o banco não recusa o passar_para_humano nela)
      const c2 = await comRetornoPara(b, 2, "now() - interval '1 minute'");
      const [pura] = (await pegar(t)).filter((r: Linha) => r.conversa_id === c2.conversa);
      t.igual(pura?.retorno_id, c2.retorno, "a pura leva o retorno");
      await servidor(t, "select public.nina_passar_para_humano($1)", [pura.id]);
      await concluir(t, pura.id, [], [], 1);
      t.igual(
        await estado(t, c2.retorno),
        ["nao_enviado", "com_equipe"],
        "pura: com_equipe (e não dispensado)",
      );
      t.igual(await saidasDa(t, pura.id), 0, "pura: nenhuma bolha");
    });

    it("8g com o eco: a mista sem IA cancelada pelo eco, revivida e concluída com a bolha fixa: o retorno não é retomado por ela e sai depois, pela faixa 1", async () => {
      const b = await preparar(t);
      const c = await comRetornoPara(b, 1, "now() + interval '8 minutes'");
      const { rodada } = await leadEscreve(b, 1, c.conversa);
      t.igual(rodada.retorno_id, c.retorno, "levado antes da hora");
      // o eco do celular cancela a rodada; a varredura F devolve o órfão antes da hora
      const [{ id: eco }] = await t.sql(
        `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, texto, status)
       values ($1, $2, 'saida', 'humano_celular', 'Recebi seu áudio', 'enviada') returning id`,
        [c.conversa, b.cx],
      );
      await varrer(t);
      t.igual(await estado(t, c.retorno), ["pendente", null], "a varredura F devolve o órfão");
      // o concluir_envio acha a duplicata e revive a rodada (como no teste do eco acima)
      await t.sql("delete from public.mensagens where id = $1", [eco]);
      await t.sql("update public.conversas set modo = 'nina', motivo_humano = null where id = $1", [
        c.conversa,
      ]);
      await t.sql(
        "update public.rodadas set status = 'rodando', terminada_em = null where id = $1",
        [rodada.id],
      );
      await t.sql(
        `update public.mensagens set rodada_id = $1
        where conversa_id = $2 and direcao = 'entrada' and rodada_id is null and criado_em <= $3`,
        [rodada.id, c.conversa, rodada.iniciada_em],
      );
      // a revivida conclui sem IA (a bolha fixa do áudio)
      await concluir(t, rodada.id, ["Recebi seu áudio, mas não consegui ouvir."], [], 0);
      const rt = await retorno(t, c.retorno);
      t.igual([rt.status, rt.rodada_id], ["pendente", null], "a bolha fixa não retoma o retorno");
      await enviarTudo(t);
      t.igual(await saidasDa(t, rodada.id), 1, "a bolha fixa saiu");
      t.igual(await estado(t, c.retorno), ["pendente", null], "e não vira o retorno enviado");
      await vencerRetorno(t, c.retorno);
      const [pura] = (await pegar(t)).filter((r: Linha) => r.conversa_id === c.conversa);
      t.igual(pura?.retorno_id, c.retorno, "na hora, a faixa 1 manda o retorno");
    });

    // Depois da hora, na janela do eco (a conversa saiu da Nina só pelo celular, sem responsável, há
    // menos de 60 s), o fim da rodada cancelada e a varredura F devolvem o retorno a pendente, em vez
    // de fechá-lo com a equipe: o passo A espera a janela e decide (com a equipe se o eco não for
    // desfeito; desfeito, a faixa 1 o manda). Antes, com a bolha fixa ou sem bolha, ele ficava com a
    // equipe para sempre, sem a equipe ter assumido.
    it("8g com o eco, depois da hora: a mista sem IA cancelada pelo eco devolve o retorno a pendente (a janela do eco); a bolha fixa que o eco devolve não o reabre, e a faixa 1 o manda", async () => {
      const b = await preparar(t);
      const c = await comRetornoPara(b, 1, "now() - interval '1 minute'");
      const { rodada } = await leadEscreve(b, 1, c.conversa);
      t.igual(rodada.retorno_id, c.retorno, "a mista");
      const [{ id: eco }] = await t.sql(
        `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, texto, status)
       values ($1, $2, 'saida', 'humano_celular', 'Recebi seu áudio', 'enviada') returning id`,
        [c.conversa, b.cx],
      );
      // o servidor conclui a rodada já cancelada, sem IA: a bolha fixa nasce cancelada (caso 1)
      await concluir(t, rodada.id, ["Recebi seu áudio, mas não consegui ouvir."], [], 0);
      const rt = await retorno(t, c.retorno);
      t.igual(
        [rt.status, rt.nao_enviado_motivo, rt.rodada_id],
        ["pendente", null, null],
        "na janela do eco: volta a pendente, solto da rodada",
      );
      // o concluir_envio acha a duplicata: apaga o eco, devolve a conversa à Nina e as bolhas
      // canceladas à fila (base 0006)
      await t.sql("delete from public.mensagens where id = $1", [eco]);
      await t.sql("update public.conversas set modo = 'nina', motivo_humano = null where id = $1", [
        c.conversa,
      ]);
      await t.sql(
        "update public.mensagens set status = 'na_fila', status_em = now() where rodada_id = $1 and direcao = 'saida' and status = 'cancelada'",
        [rodada.id],
      );
      await enviarTudo(t);
      t.igual(await saidasDa(t, rodada.id), 1, "a bolha fixa saiu");
      const fim = await retorno(t, c.retorno);
      t.igual(
        [fim.status, fim.nao_enviado_motivo, fim.enviado_em],
        ["pendente", null, null],
        "nunca enviado pela bolha fixa",
      );
      const [pura] = (await pegar(t)).filter((r: Linha) => r.conversa_id === c.conversa);
      t.igual(pura?.retorno_id, c.retorno, "a faixa 1 manda o retorno");
    });

    it("8g com o eco, depois da hora, pela varredura F: na janela do eco o retorno volta a pendente; a revivida sem IA não o retoma, a bolha fixa sai e a faixa 1 manda o retorno", async () => {
      const b = await preparar(t);
      const c = await comRetornoPara(b, 1, "now() - interval '1 minute'");
      const { rodada } = await leadEscreve(b, 1, c.conversa);
      t.igual(rodada.retorno_id, c.retorno, "a mista");
      const [{ id: eco }] = await t.sql(
        `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, texto, status)
       values ($1, $2, 'saida', 'humano_celular', 'Recebi seu áudio', 'enviada') returning id`,
        [c.conversa, b.cx],
      );
      await varrer(t);
      const f = await retorno(t, c.retorno);
      t.igual(
        [f.status, f.nao_enviado_motivo, f.rodada_id],
        ["pendente", null, null],
        "a varredura F, na janela do eco: volta a pendente",
      );
      // o concluir_envio acha a duplicata e revive a rodada (o worker ainda estava com ela)
      await t.sql("delete from public.mensagens where id = $1", [eco]);
      await t.sql("update public.conversas set modo = 'nina', motivo_humano = null where id = $1", [
        c.conversa,
      ]);
      await t.sql(
        "update public.rodadas set status = 'rodando', terminada_em = null where id = $1",
        [rodada.id],
      );
      await t.sql(
        `update public.mensagens set rodada_id = $1
        where conversa_id = $2 and direcao = 'entrada' and rodada_id is null and criado_em <= $3`,
        [rodada.id, c.conversa, rodada.iniciada_em],
      );
      await concluir(t, rodada.id, ["Recebi seu áudio, mas não consegui ouvir."], [], 0);
      const r = await retorno(t, c.retorno);
      t.igual([r.status, r.rodada_id], ["pendente", null], "a revivida sem IA não o retoma");
      await enviarTudo(t);
      t.igual(await saidasDa(t, rodada.id), 1, "a bolha fixa saiu");
      const fim = await retorno(t, c.retorno);
      t.igual(
        [fim.status, fim.nao_enviado_motivo, fim.enviado_em],
        ["pendente", null, null],
        "nunca enviado pela bolha fixa",
      );
      const [pura] = (await pegar(t)).filter((x: Linha) => x.conversa_id === c.conversa);
      t.igual(pura?.retorno_id, c.retorno, "a faixa 1 manda o retorno");
    });

    it("8g com o eco, depois da hora (contraprova): sem desfazer o eco, passados os 60 s, a varredura A fecha com a equipe (pelo fim da rodada e pela varredura F)", async () => {
      const b = await preparar(t);
      const ecoEm = async (conversa: string) =>
        (
          await t.sql(
            `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, texto, status)
           values ($1, $2, 'saida', 'humano_celular', 'Oi, aqui é do celular', 'enviada') returning id`,
            [conversa, b.cx],
          )
        )[0].id as string;
      // pelo fim da rodada (a bolha fixa nasce cancelada)
      const c1 = await comRetornoPara(b, 1, "now() - interval '1 minute'");
      const { rodada: m1 } = await leadEscreve(b, 1, c1.conversa);
      t.igual(m1.retorno_id, c1.retorno, "a mista 1");
      const e1 = await ecoEm(c1.conversa);
      await concluir(t, m1.id, ["Recebi seu áudio, mas não consegui ouvir."], [], 0);
      t.igual(await estado(t, c1.retorno), ["pendente", null], "na janela do eco: pendente");
      // pela varredura F (a mista que ninguém concluiu)
      const c2 = await comRetornoPara(b, 2, "now() - interval '1 minute'");
      const { rodada: m2 } = await leadEscreve(b, 2, c2.conversa);
      t.igual(m2.retorno_id, c2.retorno, "a mista 2");
      const e2 = await ecoEm(c2.conversa);
      await varrer(t);
      t.igual(
        await estado(t, c2.retorno),
        ["pendente", null],
        "a varredura F, na janela do eco: pendente",
      );
      await varrer(t);
      t.igual(
        [await estado(t, c1.retorno), await estado(t, c2.retorno)],
        [
          ["pendente", null],
          ["pendente", null],
        ],
        "a varredura A espera a janela",
      );
      t.igual(
        (await pegar(t)).filter((r: Linha) =>
          [c1.conversa, c2.conversa].includes(r.conversa_id as string),
        ),
        [],
        "fora da Nina: ninguém pega",
      );
      await t.sql(
        "update public.mensagens set criado_em = now() - interval '61 seconds' where id = any ($1::uuid[])",
        [[e1, e2]],
      );
      await varrer(t);
      t.igual(
        await estado(t, c1.retorno),
        ["nao_enviado", "com_equipe"],
        "o celular de verdade (fim da rodada): com a equipe",
      );
      t.igual(
        await estado(t, c2.retorno),
        ["nao_enviado", "com_equipe"],
        "o celular de verdade (varredura F): com a equipe",
      );
    });

    it("o eco duplicado revive a mista vencida que a varredura F esvaziou; ela conclui com IA e sem bolha: o retorno fica pendente e sai pela faixa 1", async () => {
      const b = await preparar(t);
      const c = await comRetornoPara(b, 1, "now() - interval '1 minute'");
      const { rodada } = await leadEscreve(b, 1, c.conversa);
      t.igual(rodada.retorno_id, c.retorno, "a mista");
      const [{ id: eco }] = await t.sql(
        `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, texto, status)
       values ($1, $2, 'saida', 'humano_celular', 'Oi! Como combinamos...', 'enviada') returning id`,
        [c.conversa, b.cx],
      );
      await varrer(t);
      t.igual(
        await estado(t, c.retorno),
        ["pendente", null],
        "a varredura F, na janela do eco: volta a pendente",
      );
      await t.sql("delete from public.mensagens where id = $1", [eco]);
      await t.sql("update public.conversas set modo = 'nina', motivo_humano = null where id = $1", [
        c.conversa,
      ]);
      await t.sql(
        "update public.rodadas set status = 'rodando', terminada_em = null where id = $1",
        [rodada.id],
      );
      await t.sql(
        `update public.mensagens set rodada_id = $1
        where conversa_id = $2 and direcao = 'entrada' and rodada_id is null and criado_em <= $3`,
        [rodada.id, c.conversa, rodada.iniciada_em],
      );
      const lido = await daRodada(t, rodada.id);
      t.igual(
        [lido?.da_rodada, lido?.retorno_id, lido?.vencido],
        [true, c.retorno, true],
        "a leitura da revivida ainda vê o retorno",
      );
      await concluir(t, rodada.id, [], [semResposta("O lead só agradeceu")], 1);
      const r = await retorno(t, c.retorno);
      t.igual([r.status, r.rodada_id], ["pendente", null], "sem bolha: continua pendente");
      const [pura] = (await pegar(t)).filter((x: Linha) => x.conversa_id === c.conversa);
      t.igual(pura?.retorno_id, c.retorno, "a faixa 1 manda o retorno");
    });

    it("o eco do celular cancela a pura vencida antes da leitura e a varredura F a esvazia: a leitura ainda vê o retorno; revivida, a Nina escreve e ele sai como enviado, uma vez só", async () => {
      const b = await preparar(t);
      const c = await comRetornoPara(b, 1, "now() - interval '1 minute'");
      const [pura] = (await pegar(t)).filter((x: Linha) => x.conversa_id === c.conversa);
      t.igual(pura?.retorno_id, c.retorno, "a pura");
      const [{ id: eco }] = await t.sql(
        `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, texto, status)
       values ($1, $2, 'saida', 'humano_celular', 'Oi! Tudo bem?', 'enviada') returning id`,
        [c.conversa, b.cx],
      );
      t.igual(
        (await t.sql("select status::text as s from public.rodadas where id = $1", [pura.id]))[0].s,
        "cancelada",
      );
      await varrer(t);
      t.igual(
        await estado(t, c.retorno),
        ["pendente", null],
        "a varredura F, na janela do eco: volta a pendente",
      );
      // o concluir_envio acha a duplicata e revive a pura (o worker ainda estava com ela)
      await t.sql("delete from public.mensagens where id = $1", [eco]);
      await t.sql("update public.conversas set modo = 'nina', motivo_humano = null where id = $1", [
        c.conversa,
      ]);
      await t.sql(
        "update public.rodadas set status = 'rodando', terminada_em = null where id = $1",
        [pura.id],
      );
      const lido = await daRodada(t, pura.id);
      t.igual(
        [lido?.da_rodada, lido?.retorno_id, lido?.tipo],
        [true, c.retorno, "retorno"],
        "a leitura da revivida ainda vê o retorno",
      );
      await concluir(t, pura.id, ["Oi! Como combinamos..."], [responder("nao")]);
      const rt = await retorno(t, c.retorno);
      t.igual([rt.status, rt.rodada_id], ["saindo", pura.id], "retomado pela pura revivida");
      await enviarTudo(t);
      t.igual(await estado(t, c.retorno), ["enviado", null], "enviado");
      t.igual(await pegar(t), [], "a faixa 1 não manda de novo");
      t.igual(await saidasDa(t, pura.id), 1, "uma bolha só");
    });

    it("8f: na mista, 'me chama sexta': o levado sai (enviado) e o novo fica pendente", async () => {
      const b = await preparar(t);
      const c = await comRetornoPara(b, 1, "now() - interval '1 minute'");
      const { rodada } = await leadEscreve(b, 1, c.conversa);
      t.igual(rodada.retorno_id, c.retorno);
      const q = await amanha(t, "10:00");
      const res = await marcar(t, rodada.id, q.data, q.hora, "Ligar na sexta");
      t.igual(
        [res.ok, res.igual, res.substituido_vence_em],
        [true, false, null],
        "o levado não é substituído",
      );
      await concluir(t, rodada.id, ["Claro! Te chamo amanhã às 10h."], [responder("nao")]);
      t.igual(await estado(t, c.retorno), ["saindo", null]);
      await enviarTudo(t);
      t.igual(await estado(t, c.retorno), ["enviado", null]);
      t.igual(await estado(t, res.retorno_id), ["pendente", null]);
      t.igual((await retorno(t, res.retorno_id)).substitui_id, null);
    });

    it("8g: na mista sem IA (p_passos = 0, a bolha fixa do áudio) o retorno volta a pendente", async () => {
      const b = await preparar(t);
      const c = await comRetornoPara(b, 1, "now() - interval '1 minute'");
      const { rodada } = await leadEscreve(b, 1, c.conversa);
      await concluir(t, rodada.id, ["Recebi seu áudio, mas não consegui ouvir."], [], 0);
      t.igual(await saidasDa(t, rodada.id), 1, "a bolha do lead sai");
      const rt = await retorno(t, c.retorno);
      t.igual([rt.status, rt.rodada_id, rt.nao_enviado_motivo], ["pendente", null, null]);
      perto(t, rt.tentar_apos, Date.now() + 30_000, 10_000, "tentar_apos de +30 s");
      // a bolha fixa sai (o gatilho das bolhas roda): o retorno continua pendente, e a faixa 1 o manda
      await enviarTudo(t);
      t.igual(
        await estado(t, c.retorno),
        ["pendente", null],
        "a bolha fixa não vira o retorno enviado",
      );
      t.igual((await retorno(t, c.retorno)).rodada_id, null);
      await t.sql(
        "update public.retornos set tentar_apos = now() - interval '1 second' where id = $1",
        [c.retorno],
      );
      const [pura] = await pegar(t);
      t.igual(pura.retorno_id, c.retorno, "a faixa 1 manda o retorno depois da bolha fixa");
    });

    it("8g (gatilho): a bolha fixa da mista sem IA, cancelada pelo eco e devolvida à fila, não retoma o retorno", async () => {
      const b = await preparar(t);
      const c = await comRetornoPara(b, 1, "now() - interval '1 minute'");
      const { rodada } = await leadEscreve(b, 1, c.conversa);
      await concluir(t, rodada.id, ["Recebi seu áudio, mas não consegui ouvir."], [], 0);
      t.igual(await estado(t, c.retorno), ["pendente", null], "o caso 5: volta");
      // o eco cancela a bolha fixa na fila e o concluir_envio a devolve (base 0006)
      await t.sql(
        "update public.mensagens set status = 'cancelada', status_em = now() where rodada_id = $1 and direcao = 'saida'",
        [rodada.id],
      );
      await t.sql(
        "update public.mensagens set status = 'na_fila', status_em = now() where rodada_id = $1 and direcao = 'saida'",
        [rodada.id],
      );
      const rt = await retorno(t, c.retorno);
      t.igual([rt.status, rt.rodada_id], ["pendente", null], "a bolha fixa devolvida não retoma");
      await enviarTudo(t);
      t.igual(await estado(t, c.retorno), ["pendente", null], "a bolha fixa saiu e o retorno não");
      await t.sql(
        "update public.retornos set tentar_apos = now() - interval '1 second' where id = $1",
        [c.retorno],
      );
      const [pura] = (await pegar(t)).filter((r: Linha) => r.conversa_id === c.conversa);
      t.igual(pura?.retorno_id, c.retorno, "a faixa 1 manda o retorno depois");
    });

    it("8g (perto do prazo): na mista sem IA a 15 s do prazo, o retorno fecha como passou_do_prazo e a bolha fixa não o reabre como enviado", async () => {
      const b = await preparar(t);
      // vence há 2 h 59 min 45 s: o prazo (3 h depois da hora) acaba em 15 s, antes dos 30 s da volta
      const c = await comRetornoPara(b, 1, "now() - interval '2 hours 59 minutes 45 seconds'");
      const { rodada } = await leadEscreve(b, 1, c.conversa);
      t.igual(rodada.retorno_id, c.retorno, "a mista leva o retorno");
      await concluir(t, rodada.id, ["Recebi seu áudio, mas não consegui ouvir."], [], 0);
      t.igual(
        await estado(t, c.retorno),
        ["nao_enviado", "passou_do_prazo"],
        "a volta cairia depois do prazo",
      );
      await enviarTudo(t);
      t.igual(await saidasDa(t, rodada.id), 1, "a bolha fixa saiu");
      const rt = await retorno(t, c.retorno);
      t.igual(
        [rt.status, rt.nao_enviado_motivo, rt.enviado_em],
        ["nao_enviado", "passou_do_prazo", null],
        "a bolha fixa nunca é o retorno",
      );
    });

    it("8g (varredura F): na mista sem IA com a retorno_ao_concluir quebrada, a varredura não segue a bolha fixa: o retorno volta em 30 s (perto do prazo, passou_do_prazo solto da rodada) e a bolha fixa que sai não o reabre como enviado", async () => {
      const b = await preparar(t);
      const c = await comRetornoPara(b, 1, "now() - interval '1 minute'");
      const { rodada } = await leadEscreve(b, 1, c.conversa);
      // vence há 2 h 59 min 45 s: o prazo acaba em 15 s, antes dos 30 s da volta (gravado depois da
      // 1ª pegada, para a faixa 1 não o levar antes)
      const c2 = await comRetornoPara(b, 2, "now() - interval '2 hours 59 minutes 45 seconds'");
      const { rodada: r2 } = await leadEscreve(b, 2, c2.conversa);
      t.igual([rodada.retorno_id, r2.retorno_id], [c.retorno, c2.retorno], "as duas mistas");
      await quebrar(t, "retorno_ao_concluir");
      for (const rd of [rodada, r2])
        await concluir(t, rd.id, ["Recebi seu áudio, mas não consegui ouvir."], [], 0);
      t.igual(
        [await estado(t, c.retorno), await estado(t, c2.retorno)],
        [
          ["em_rodada", null],
          ["em_rodada", null],
        ],
        "o defeito deixa os dois na rodada",
      );
      await varrer(t);
      const rt = await retorno(t, c.retorno);
      t.igual(
        [rt.status, rt.rodada_id],
        ["pendente", null],
        "a varredura F: volta, solto da rodada",
      );
      perto(t, rt.tentar_apos, Date.now() + 30_000, 10_000, "tentar_apos de +30 s (o caso 5)");
      const rt2 = await retorno(t, c2.retorno);
      t.igual(
        [rt2.status, rt2.nao_enviado_motivo, rt2.rodada_id],
        ["nao_enviado", "passou_do_prazo", null],
        "perto do prazo: fecha, solto da rodada",
      );
      await enviarTudo(t);
      t.igual(
        [await saidasDa(t, rodada.id), await saidasDa(t, r2.id)],
        [1, 1],
        "as bolhas fixas saíram",
      );
      t.igual(
        await estado(t, c.retorno),
        ["pendente", null],
        "a bolha fixa não vira o retorno enviado",
      );
      t.igual(
        await estado(t, c2.retorno),
        ["nao_enviado", "passou_do_prazo"],
        "nem reabre o fechado",
      );
    });

    it("8h (posição e): na mista com IA e sem bolha o retorno volta (não é dispensado) e a faixa 1 pega logo", async () => {
      const b = await preparar(t);
      const c = await comRetornoPara(b, 1, "now() - interval '1 minute'");
      const { rodada } = await leadEscreve(b, 1, c.conversa);
      await concluir(t, rodada.id, [], [semResposta("despedida")], 1);
      const rt = await retorno(t, c.retorno);
      t.igual([rt.status, rt.rodada_id], ["pendente", null]);
      perto(t, rt.tentar_apos, Date.now(), 10_000, "tentar_apos agora");
      const [pura] = await pegar(t);
      t.igual(pura.retorno_id, c.retorno, "a faixa 1 pega logo depois");
    });

    it("A1: mista antes da hora, a equipe assume e a rodada conclui → volta a pendente; sem devolução, com_equipe na hora", async () => {
      const b = await preparar(t);
      const c = await comRetornoPara(b, 1, "now() + interval '8 minutes'");
      const { rodada } = await leadEscreve(b, 1, c.conversa);
      t.igual(rodada.retorno_id, c.retorno, "levado antes da hora");
      await assumir(t, b.uAtend, c.conversa);
      await concluir(t, rodada.id, ["Oi!"], [responder("nao")]);
      const rt = await retorno(t, c.retorno);
      t.igual(
        [rt.status, rt.rodada_id, rt.nao_enviado_motivo],
        ["pendente", null, null],
        "volta a pendente",
      );
      await vencerRetorno(t, c.retorno);
      await varrer(t);
      const fim = await retorno(t, c.retorno);
      t.igual([fim.status, fim.nao_enviado_motivo], ["nao_enviado", "com_equipe"]);
      t.ok(ms(fim.resolvido_em)! >= ms(fim.vence_em)!, "resolvido_em >= vence_em");
    });

    it("A1: mista antes da hora, a equipe assume e devolve; venceu → é pego de novo", async () => {
      const b = await preparar(t);
      const c = await comRetornoPara(b, 1, "now() + interval '8 minutes'");
      const { rodada } = await leadEscreve(b, 1, c.conversa);
      await assumir(t, b.uAtend, c.conversa);
      await concluir(t, rodada.id, ["Oi!"], [responder("nao")]);
      t.igual(await estado(t, c.retorno), ["pendente", null]);
      await devolver(t, b.uAtend, c.conversa);
      await vencerRetorno(t, c.retorno);
      const rs = (await pegar(t)).filter((r: Linha) => r.conversa_id === c.conversa);
      t.igual(rs.length, 1);
      t.igual(rs[0].retorno_id, c.retorno, "a rodada seguinte leva o retorno");
      t.igual(await estado(t, c.retorno), ["em_rodada", null]);
    });

    it("A1: o órfão da mista antes da hora (assumida, sem concluir) e a falha com a conversa fora da Nina voltam a pendente", async () => {
      const b = await preparar(t);
      // varredura F: a rodada foi cancelada pelo assumir e ninguém concluiu
      const c = await comRetornoPara(b, 1, "now() + interval '8 minutes'");
      await leadEscreve(b, 1, c.conversa);
      await assumir(t, b.uAtend, c.conversa);
      await varrer(t);
      t.igual(await estado(t, c.retorno), ["pendente", null], "órfão antes da hora: volta");
      // o mesmo depois da hora: com_equipe
      const c2 = await comRetornoPara(b, 2, "now() - interval '1 minute'");
      await leadEscreve(b, 2, c2.conversa);
      await assumir(t, b.uAtend, c2.conversa);
      await varrer(t);
      t.igual(await estado(t, c2.retorno), ["nao_enviado", "com_equipe"], "órfão depois da hora");
      // retorno_ao_falhar: a Nina passou para a equipe e a rodada falhou
      const c3 = await comRetornoPara(b, 3, "now() + interval '8 minutes'");
      const r3 = await leadEscreve(b, 3, c3.conversa);
      await servidor(t, "select public.nina_passar_para_humano($1)", [r3.rodada.id]);
      await falhar(t, r3.rodada.id, "erro_provedor", true);
      t.igual(await estado(t, c3.retorno), ["pendente", null], "falha antes da hora: volta");
      const c4 = await comRetornoPara(b, 4, "now() - interval '1 minute'");
      const r4 = await leadEscreve(b, 4, c4.conversa);
      await servidor(t, "select public.nina_passar_para_humano($1)", [r4.rodada.id]);
      await falhar(t, r4.rodada.id, "erro_provedor", true);
      t.igual(await estado(t, c4.retorno), ["nao_enviado", "com_equipe"], "falha depois da hora");
    });

    it("o eco duplicado revive a mista que a varredura F já tinha esvaziado: o fim dela retoma o retorno, que sai uma vez só", async () => {
      const b = await preparar(t);
      const c = await comRetornoPara(b, 1, "now() + interval '8 minutes'");
      const { rodada } = await leadEscreve(b, 1, c.conversa);
      t.igual(rodada.retorno_id, c.retorno, "levado antes da hora");
      // o eco do celular (ainda sem saber que é duplicata) cancela a rodada e solta as entradas
      const [{ id: eco }] = await t.sql(
        `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, texto, status)
       values ($1, $2, 'saida', 'humano_celular', 'Oi! Como combinamos...', 'enviada') returning id`,
        [c.conversa, b.cx],
      );
      t.igual(
        (await t.sql("select status::text as s from public.rodadas where id = $1", [rodada.id]))[0]
          .s,
        "cancelada",
      );
      await varrer(t);
      t.igual(
        await estado(t, c.retorno),
        ["pendente", null],
        "a varredura F devolve o órfão antes da hora",
      );
      // o concluir_envio acha a duplicata (base 0006): apaga o eco, devolve a conversa à Nina e revive
      // a rodada (o worker ainda estava com ela), religando as entradas
      await t.sql("delete from public.mensagens where id = $1", [eco]);
      await t.sql("update public.conversas set modo = 'nina', motivo_humano = null where id = $1", [
        c.conversa,
      ]);
      await t.sql(
        "update public.rodadas set status = 'rodando', terminada_em = null where id = $1",
        [rodada.id],
      );
      await t.sql(
        `update public.mensagens set rodada_id = $1
        where conversa_id = $2 and direcao = 'entrada' and rodada_id is null and criado_em <= $3`,
        [rodada.id, c.conversa, rodada.iniciada_em],
      );
      // a leitura da revivida (o servidor que lê depois da varredura F) ainda vê o retorno que o fim
      // dela retoma: a Nina trata dele, e não sai "enviado" sem ela saber
      const lido = await daRodada(t, rodada.id);
      t.igual(
        [lido?.da_rodada, lido?.retorno_id, lido?.vencido],
        [true, c.retorno, false],
        "a leitura da revivida vê o retorno",
      );
      await concluir(
        t,
        rodada.id,
        ["Oi! E sobre a proposta que combinamos..."],
        [responder("nao")],
      );
      const rt = await retorno(t, c.retorno);
      t.igual(
        [rt.status, rt.rodada_id, rt.tentar_apos],
        ["saindo", rodada.id, null],
        "retomado pela rodada revivida",
      );
      await enviarTudo(t);
      t.igual(await estado(t, c.retorno), ["enviado", null], "enviado");
      // na hora, a faixa 1 não manda de novo
      await t.sql(
        "update public.retornos set vence_em = now() - interval '1 minute' where id = $1",
        [c.retorno],
      );
      t.igual(await pegar(t), [], "a faixa 1 não pega nada");
      t.igual(await saidasDa(t, rodada.id), 1, "uma bolha só");
    });

    it("o eco duplicado devolve as bolhas da mista depois de a hora chegar dentro da janela do eco: a varredura A espera, e a bolha que volta retoma o retorno, que sai como enviado, uma vez só", async () => {
      const b = await preparar(t);
      const c = await comRetornoPara(b, 1, "now() + interval '8 minutes'");
      const { rodada } = await leadEscreve(b, 1, c.conversa);
      t.igual(rodada.retorno_id, c.retorno, "levado antes da hora");
      await concluir(
        t,
        rodada.id,
        ["Oi! E sobre a proposta que combinamos..."],
        [responder("nao")],
      );
      t.igual(await estado(t, c.retorno), ["saindo", null]);
      // o eco do celular (ainda sem saber que é duplicata) cancela as bolhas da Nina na fila e tira a
      // conversa da Nina: antes da hora, o retorno volta
      const [{ id: eco }] = await t.sql(
        `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, texto, status)
       values ($1, $2, 'saida', 'humano_celular', 'Oi! E sobre a proposta...', 'enviada') returning id`,
        [c.conversa, b.cx],
      );
      t.igual(await estado(t, c.retorno), ["pendente", null], "antes da hora: volta");
      // a hora chega dentro da janela do eco (60 s): a varredura A espera (o eco ainda pode devolver a
      // conversa à Nina)
      await vencerRetorno(t, c.retorno);
      await varrer(t);
      const a = await retorno(t, c.retorno);
      t.igual(
        [a.status, a.nao_enviado_motivo, a.rodada_id],
        ["pendente", null, null],
        "a varredura A espera a janela do eco",
      );
      // o concluir_envio acha a duplicata (base 0006): apaga o eco, devolve a conversa à Nina e as
      // bolhas canceladas à fila
      await t.sql("delete from public.mensagens where id = $1", [eco]);
      await t.sql("update public.conversas set modo = 'nina', motivo_humano = null where id = $1", [
        c.conversa,
      ]);
      await t.sql(
        "update public.mensagens set status = 'na_fila', status_em = now() where rodada_id = $1 and direcao = 'saida' and status = 'cancelada'",
        [rodada.id],
      );
      const rt = await retorno(t, c.retorno);
      t.igual(
        [rt.status, rt.rodada_id, rt.nao_enviado_motivo, rt.resolvido_em],
        ["saindo", rodada.id, null, null],
        "retomado pela bolha que voltou",
      );
      await enviarTudo(t);
      t.igual(await estado(t, c.retorno), ["enviado", null], "enviado");
      t.igual(await pegar(t), [], "a faixa 1 não manda de novo");
      t.igual(
        await contar(t, "select 1 from public.rodadas where retorno_id = $1", [c.retorno]),
        1,
        "uma rodada só levou o retorno",
      );
    });

    it("o eco duplicado revive a mista depois de a varredura F a esvaziar e de a varredura A fechar o retorno com a equipe na hora (a corrida do fim da janela do eco): o fim dela retoma o retorno, que sai uma vez só", async () => {
      const b = await preparar(t);
      const c = await comRetornoPara(b, 1, "now() + interval '8 minutes'");
      const { rodada } = await leadEscreve(b, 1, c.conversa);
      t.igual(rodada.retorno_id, c.retorno, "levado antes da hora");
      const [{ id: eco }] = await t.sql(
        `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, texto, status)
       values ($1, $2, 'saida', 'humano_celular', 'Oi! Como combinamos...', 'enviada') returning id`,
        [c.conversa, b.cx],
      );
      await varrer(t);
      t.igual(
        await estado(t, c.retorno),
        ["pendente", null],
        "a varredura F devolve o órfão antes da hora",
      );
      await vencerRetorno(t, c.retorno);
      await varrer(t);
      t.igual(
        await estado(t, c.retorno),
        ["pendente", null],
        "na hora, dentro da janela do eco, a varredura A espera",
      );
      // a corrida do fim da janela: a varredura já vê o eco com mais de 60 s, mas a concluir_envio que
      // começou antes ainda o reconhece como duplicata
      await t.sql(
        "update public.mensagens set criado_em = now() - interval '61 seconds' where id = $1",
        [eco],
      );
      await varrer(t);
      t.igual(
        await estado(t, c.retorno),
        ["nao_enviado", "com_equipe"],
        "depois da janela, a varredura A",
      );
      // o concluir_envio acha a duplicata e revive a rodada (o worker ainda estava com ela)
      await t.sql("delete from public.mensagens where id = $1", [eco]);
      await t.sql("update public.conversas set modo = 'nina', motivo_humano = null where id = $1", [
        c.conversa,
      ]);
      await t.sql(
        "update public.rodadas set status = 'rodando', terminada_em = null where id = $1",
        [rodada.id],
      );
      await t.sql(
        `update public.mensagens set rodada_id = $1
        where conversa_id = $2 and direcao = 'entrada' and rodada_id is null and criado_em <= $3`,
        [rodada.id, c.conversa, rodada.iniciada_em],
      );
      // a leitura da revivida também vê o com_equipe solto que o fim dela retoma
      const lido = await daRodada(t, rodada.id);
      t.igual(
        [lido?.da_rodada, lido?.retorno_id, lido?.vencido],
        [true, c.retorno, true],
        "a leitura da revivida vê o retorno",
      );
      await concluir(
        t,
        rodada.id,
        ["Oi! E sobre a proposta que combinamos..."],
        [responder("nao")],
      );
      const rt = await retorno(t, c.retorno);
      t.igual(
        [rt.status, rt.rodada_id, rt.nao_enviado_motivo, rt.resolvido_em],
        ["saindo", rodada.id, null, null],
        "retomado pela rodada revivida",
      );
      await enviarTudo(t);
      t.igual(await estado(t, c.retorno), ["enviado", null], "enviado");
      t.igual(await pegar(t), [], "a faixa 1 não manda de novo");
      t.igual(await saidasDa(t, rodada.id), 1, "uma bolha só");
    });

    it("o eco duplicado na corrida do fim da janela: a varredura A já fechou o retorno com a equipe, e a bolha que volta o retoma; ele sai como enviado, uma vez só", async () => {
      const b = await preparar(t);
      const c = await comRetornoPara(b, 1, "now() + interval '8 minutes'");
      const { rodada } = await leadEscreve(b, 1, c.conversa);
      t.igual(rodada.retorno_id, c.retorno, "levado antes da hora");
      await concluir(
        t,
        rodada.id,
        ["Oi! E sobre a proposta que combinamos..."],
        [responder("nao")],
      );
      const [{ id: eco }] = await t.sql(
        `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, texto, status)
       values ($1, $2, 'saida', 'humano_celular', 'Oi! E sobre a proposta...', 'enviada') returning id`,
        [c.conversa, b.cx],
      );
      t.igual(await estado(t, c.retorno), ["pendente", null], "antes da hora: volta");
      // a varredura já vê o eco com mais de 60 s, mas a concluir_envio que começou antes ainda o
      // reconhece como duplicata
      await vencerRetorno(t, c.retorno);
      await t.sql(
        "update public.mensagens set criado_em = now() - interval '61 seconds' where id = $1",
        [eco],
      );
      await varrer(t);
      const a = await retorno(t, c.retorno);
      t.igual(
        [a.status, a.nao_enviado_motivo, a.rodada_id],
        ["nao_enviado", "com_equipe", null],
        "a varredura A, depois da janela",
      );
      await t.sql("delete from public.mensagens where id = $1", [eco]);
      await t.sql("update public.conversas set modo = 'nina', motivo_humano = null where id = $1", [
        c.conversa,
      ]);
      await t.sql(
        "update public.mensagens set status = 'na_fila', status_em = now() where rodada_id = $1 and direcao = 'saida' and status = 'cancelada'",
        [rodada.id],
      );
      const rt = await retorno(t, c.retorno);
      t.igual(
        [rt.status, rt.rodada_id, rt.nao_enviado_motivo, rt.resolvido_em],
        ["saindo", rodada.id, null, null],
        "retomado pela bolha que voltou",
      );
      await enviarTudo(t);
      t.igual(await estado(t, c.retorno), ["enviado", null], "enviado");
      t.igual(await pegar(t), [], "a faixa 1 não manda de novo");
      t.igual(await saidasDa(t, rodada.id), 1, "uma bolha só");
    });

    /** O eco do celular (a cópia da própria mensagem da Nina, ainda sem saber que é duplicata). */
    const eco = async (b: Preparo, conversa: string, idade?: string) => {
      const [{ id }] = await t.sql(
        `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, texto, status)
       values ($1, $2, 'saida', 'humano_celular', 'Oi! Como combinamos...', 'enviada') returning id`,
        [conversa, b.cx],
      );
      if (idade)
        await t.sql(
          `update public.mensagens set criado_em = now() - interval '${idade}' where id = $1`,
          [id],
        );
      return id as string;
    };

    it("varredura A (a janela do eco): o retorno pendente vencido, sem rodada, numa conversa tirada da Nina por um eco de menos de 60 s, espera; o eco desfeito, a faixa 1 o leva", async () => {
      const b = await preparar(t);
      const c = await comRetornoPara(b, 1, "now() + interval '1 hour'");
      const e = await eco(b, c.conversa);
      t.igual(
        (await conversaDe(t, c.conversa)).motivo_humano,
        "humano_celular",
        "o eco tirou a conversa da Nina",
      );
      await vencerRetorno(t, c.retorno);
      await varrer(t);
      t.igual(
        await estado(t, c.retorno),
        ["pendente", null],
        "a varredura A espera a janela do eco",
      );
      t.igual(
        await pegar(t),
        [],
        "a conversa fora da Nina: ninguém pega (e a varredura curta também espera)",
      );
      t.igual(await estado(t, c.retorno), ["pendente", null]);
      // o concluir_envio acha a duplicata (base 0006): apaga o eco e devolve a conversa à Nina
      await t.sql("delete from public.mensagens where id = $1", [e]);
      await t.sql("update public.conversas set modo = 'nina', motivo_humano = null where id = $1", [
        c.conversa,
      ]);
      const [pura] = await pegar(t);
      t.igual(pura?.retorno_id, c.retorno, "a faixa 1 leva o retorno");
    });

    it("varredura A (contraprova): o eco de mais de 60 s não é mais duplicata; a conversa assumida pela tela, ou com responsável, fecha na hora", async () => {
      const b = await preparar(t);
      // a mensagem do celular com mais de 60 s: com a equipe
      const c1 = await comRetornoPara(b, 1, "now() + interval '1 hour'");
      await eco(b, c1.conversa, "61 seconds");
      await vencerRetorno(t, c1.retorno);
      await varrer(t);
      t.igual(await estado(t, c1.retorno), ["nao_enviado", "com_equipe"], "o celular de verdade");
      // assumida pela tela (humano_tela com autor: grava o responsável): sem esperar
      const c2 = await comRetornoPara(b, 2, "now() + interval '1 hour'");
      await t.sql(
        `insert into public.mensagens (conversa_id, direcao, origem, texto, status, autor_membro_id)
       values ($1, 'saida', 'humano_tela', 'Oi, aqui é a equipe', 'na_fila', $2)`,
        [c2.conversa, b.mAtend],
      );
      await vencerRetorno(t, c2.retorno);
      await varrer(t);
      t.igual(await estado(t, c2.retorno), ["nao_enviado", "com_equipe"], "pela tela");
      // o eco de menos de 60 s, mas a equipe escreveu pela tela depois (a conversa ganhou responsável):
      // a concluir_envio não a devolveria à Nina, e o retorno fecha na hora
      const c3 = await comRetornoPara(b, 3, "now() + interval '1 hour'");
      await eco(b, c3.conversa);
      await t.sql(
        `insert into public.mensagens (conversa_id, direcao, origem, texto, status, autor_membro_id)
       values ($1, 'saida', 'humano_tela', 'Oi, aqui é a equipe', 'na_fila', $2)`,
        [c3.conversa, b.mAtend],
      );
      const cv3 = await t.sql(
        "select motivo_humano::text as m, responsavel_id from public.conversas where id = $1",
        [c3.conversa],
      );
      t.igual(
        [cv3[0].m, cv3[0].responsavel_id],
        ["humano_celular", b.mAtend],
        "o motivo do celular, com responsável",
      );
      await vencerRetorno(t, c3.retorno);
      await varrer(t);
      t.igual(
        await estado(t, c3.retorno),
        ["nao_enviado", "com_equipe"],
        "com responsável: na hora",
      );
    });

    it("varredura D (a janela do eco): o lembrete pendente a menos de 5 min da hora, numa conversa tirada da Nina por um eco de menos de 60 s, fica; com o eco de mais de 60 s, some", async () => {
      const b = await preparar(t);
      const lembretes = (conversa: string) =>
        contar(t, "select 1 from public.retornos where conversa_id = $1 and tipo = 'lembrete'", [
          conversa,
        ]);
      const c = await atendida(t, b, tel(1));
      await inserir(t, c.conversa, {
        tipo: "lembrete",
        vence: "now() + interval '2 minutes'",
        expira: "now() + interval '1 hour'",
      });
      const e = await eco(b, c.conversa);
      await varrer(t);
      t.igual(await lembretes(c.conversa), 1, "dentro da janela do eco: fica");
      await t.sql(
        "update public.mensagens set criado_em = now() - interval '61 seconds' where id = $1",
        [e],
      );
      await varrer(t);
      t.igual(await lembretes(c.conversa), 0, "depois da janela: a varredura D o apaga");
    });

    it("o eco do celular cancela a mista enquanto o servidor lê o retorno: a leitura vale na rodada cancelada; revivida, o fim dela decide e o retorno sai uma vez só", async () => {
      const b = await preparar(t);
      const c = await comRetornoPara(b, 1, "now() - interval '1 minute'");
      const { rodada } = await leadEscreve(b, 1, c.conversa);
      t.igual(rodada.retorno_id, c.retorno, "a mista");
      const [{ id: eco }] = await t.sql(
        `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, texto, status)
       values ($1, $2, 'saida', 'humano_celular', 'Oi! Como combinamos...', 'enviada') returning id`,
        [c.conversa, b.cx],
      );
      t.igual(
        (await t.sql("select status::text as s from public.rodadas where id = $1", [rodada.id]))[0]
          .s,
        "cancelada",
      );
      // o servidor lê o retorno da rodada cancelada (o mesmo par de status da concluir_rodada)
      const lido = await daRodada(t, rodada.id);
      t.igual(
        [lido?.da_rodada, lido?.retorno_id],
        [true, c.retorno],
        "a leitura vale na rodada cancelada",
      );
      // o concluir_envio acha a duplicata e revive a rodada (como no teste do eco acima)
      await t.sql("delete from public.mensagens where id = $1", [eco]);
      await t.sql("update public.conversas set modo = 'nina', motivo_humano = null where id = $1", [
        c.conversa,
      ]);
      await t.sql(
        "update public.rodadas set status = 'rodando', terminada_em = null where id = $1",
        [rodada.id],
      );
      await t.sql(
        `update public.mensagens set rodada_id = $1
        where conversa_id = $2 and direcao = 'entrada' and rodada_id is null and criado_em <= $3`,
        [rodada.id, c.conversa, rodada.iniciada_em],
      );
      await concluir(
        t,
        rodada.id,
        ["Oi! E sobre a proposta que combinamos..."],
        [responder("nao")],
      );
      t.igual(await estado(t, c.retorno), ["saindo", null], "o fim da rodada revivida decide");
      await enviarTudo(t);
      t.igual(await estado(t, c.retorno), ["enviado", null]);
      t.igual(await pegar(t), [], "a faixa 1 não manda de novo");
      t.igual(await saidasDa(t, rodada.id), 1, "uma bolha só");
      // a rodada que já acabou continua recusada (caso 10)
      await t.erro(daRodada(t, rodada.id), "rodada_nao_rodando");
    });

    it("A1 (falha definitiva): a mista antes da hora falha de vez → o retorno volta a pendente; na hora, com a conversa ainda com a equipe, com_equipe", async () => {
      const b = await preparar(t);
      const c = await comRetornoPara(b, 1, "now() + interval '8 minutes'");
      const { rodada } = await leadEscreve(b, 1, c.conversa);
      t.igual(rodada.retorno_id, c.retorno, "levado antes da hora");
      await falhar(t, rodada.id, "erro_provedor", false);
      t.igual(
        (await conversaDe(t, c.conversa)).modo,
        "humano",
        "a falha definitiva leva a conversa à equipe (regra de hoje)",
      );
      const rt = await retorno(t, c.retorno);
      t.igual(
        [rt.status, rt.rodada_id, rt.nao_enviado_motivo],
        ["pendente", null, null],
        "volta a pendente, e não nina_falhou antes da hora",
      );
      await vencerRetorno(t, c.retorno);
      await varrer(t);
      t.igual(
        await estado(t, c.retorno),
        ["nao_enviado", "com_equipe"],
        "na hora, pela varredura A",
      );
    });

    it("a rodada cancelada depois da hora, com a conversa já devolvida: com_equipe pela varredura F e pelo fim da rodada (quem chegar primeiro decide igual)", async () => {
      const b = await preparar(t);
      // pela varredura F: ninguém concluiu a rodada cancelada
      const c1 = await comRetornoPara(b, 1, "now() - interval '1 minute'");
      const r1 = await leadEscreve(b, 1, c1.conversa);
      t.igual(r1.rodada.retorno_id, c1.retorno, "levado depois da hora");
      await assumir(t, b.uAtend, c1.conversa);
      await devolver(t, b.uAtend, c1.conversa);
      await varrer(t);
      t.igual(await estado(t, c1.retorno), ["nao_enviado", "com_equipe"], "pela varredura F");
      // pelo fim da rodada: o servidor conclui a rodada cancelada
      const c2 = await comRetornoPara(b, 2, "now() - interval '1 minute'");
      const r2 = await leadEscreve(b, 2, c2.conversa);
      t.igual(r2.rodada.retorno_id, c2.retorno);
      await assumir(t, b.uAtend, c2.conversa);
      await devolver(t, b.uAtend, c2.conversa);
      await concluir(t, r2.rodada.id, ["Oi!"], [responder("nao")]);
      t.igual(await estado(t, c2.retorno), ["nao_enviado", "com_equipe"], "pelo fim da rodada");
    });

    it("o órfão da conversa que a faixa 0 acaba de pegar volta e vai junto da resposta ao lead (a varredura curta vem antes do levar junto)", async () => {
      const b = await preparar(t);
      const c = await comRetornoPara(b, 1, "now() + interval '8 minutes'");
      const r1 = await leadEscreve(b, 1, c.conversa);
      t.igual(r1.rodada.retorno_id, c.retorno, "a 1ª mista leva o retorno");
      await assumir(t, b.uAtend, c.conversa); // cancela a rodada, que ninguém conclui
      await devolver(t, b.uAtend, c.conversa);
      t.igual(await estado(t, c.retorno), ["em_rodada", null], "órfão");
      const r2 = await leadEscreve(b, 1, c.conversa);
      t.igual(r2.rodada.retorno_id, c.retorno, "a rodada do lead leva o retorno, numa resposta só");
      const rt = await retorno(t, c.retorno);
      t.igual([rt.status, rt.rodada_id], ["em_rodada", r2.rodada.id]);
    });

    it("A3: o 'igual' vale contra o levado já vencido (a hora passou há pouco), em vez de no_passado", async () => {
      const b = await preparar(t);
      const q = await local(t, "now() - interval '1 minute'");
      const c = await atendida(t, b, tel(1));
      const rt = await inserir(t, c.conversa, {
        vence: `'${q.em.toISOString()}'::timestamptz`,
        expira: `'${q.em.toISOString()}'::timestamptz + interval '3 hours'`,
        marcado: "now() - interval '1 day'",
      });
      const { rodada } = await leadEscreve(b, 1, c.conversa);
      t.igual(rodada.retorno_id, rt, "levado");
      const res = await marcar(t, rodada.id, q.data, q.hora);
      t.igual(
        [res.ok, res.igual, res.retorno_id, res.substituido_vence_em],
        [true, true, rt, null],
      );
      t.igual(
        await contar(t, "select 1 from public.retornos where conversa_id = $1", [c.conversa]),
        1,
        "nada gravado",
      );
      const p = await local(t, "now() - interval '2 hours'");
      t.igual(
        (await marcar(t, rodada.id, p.data, p.hora)).erro,
        "no_passado",
        "outra hora no passado continua recusada",
      );
    });

    it("na mista, um defeito na retorno_ao_concluir não derruba a resposta ao lead (a varredura fecha o retorno pelas bolhas); na pura, a rodada falha", async () => {
      const b = await preparar(t);
      const c = await comRetornoPara(b, 1, "now() - interval '1 minute'");
      const { rodada } = await leadEscreve(b, 1, c.conversa);
      t.igual(rodada.retorno_id, c.retorno, "a mista");
      const c2 = await atendida(t, b, tel(2));
      const rt2 = await inserir(t, c2.conversa);
      const [pura] = (await pegar(t)).filter((r: Linha) => r.conversa_id === c2.conversa);
      t.igual(pura?.retorno_id, rt2, "a pura");
      await quebrar(t, "retorno_ao_concluir");
      await concluir(t, rodada.id, ["Oi! Sobre o que combinamos..."], [responder("nao")]);
      t.igual(await saidasDa(t, rodada.id), 1, "a resposta ao lead entra na fila");
      t.igual(await estado(t, c.retorno), ["em_rodada", null], "o retorno fica para a varredura");
      await t.erro(
        concluir(t, pura.id, ["Oi! Como combinamos..."], [responder("nao")]),
        "quebrada_de_proposito",
      );
      t.igual(await saidasDa(t, pura.id), 0, "a rodada pura não grava nada");
      await t.aplicar(arqFuncoes!);
      t.ok(
        !(await temQuebrada(t, "retorno_ao_concluir")),
        "a função de volta (do nina_retornos_funcoes)",
      );
      await varrer(t);
      t.igual(await estado(t, c.retorno), ["saindo", null], "a varredura F: pelas bolhas");
      await enviarTudo(t);
      t.igual(await estado(t, c.retorno), ["enviado", null]);
    });

    it("um defeito na lembrete_ao_concluir não derruba o fim de nenhuma rodada (comum, mista e pura)", async () => {
      const b = await preparar(t);
      // as três rodadas rodando, antes de quebrar
      const r = await rodadaDoLead(t, b, tel(1));
      t.igual(r.rodada.retorno_id, null, "a rodada comum");
      const cm = await comRetornoPara(b, 2, "now() - interval '1 minute'");
      const { rodada: mista } = await leadEscreve(b, 2, cm.conversa);
      t.igual(mista.retorno_id, cm.retorno, "a mista");
      const c3 = await atendida(t, b, tel(3));
      const rt3 = await inserir(t, c3.conversa);
      const [pura] = (await pegar(t)).filter((x: Linha) => x.conversa_id === c3.conversa);
      t.igual(pura?.retorno_id, rt3, "a pura");
      await quebrar(t, "lembrete_ao_concluir");
      const fimDa = async (rodada: string) => {
        const [rd] = await t.sql("select status::text as s from public.rodadas where id = $1", [
          rodada,
        ]);
        const bolhas = await t.sql(
          "select status::text as s from public.mensagens where rodada_id = $1 and direcao = 'saida'",
          [rodada],
        );
        return [rd.s, bolhas.map((m: Linha) => m.s)];
      };
      // a comum com espera_resposta 'sim': o caminho que arma o lembrete (a lembrete_ao_concluir roda
      // em toda rodada, também nas do servidor publicado hoje)
      await concluir(t, r.rodada.id, ["Oi! Posso ajudar?"], [responder("sim")]);
      t.igual(
        await fimDa(r.rodada.id),
        ["concluida", ["na_fila"]],
        "a comum conclui e a resposta entra na fila",
      );
      await concluir(t, mista.id, ["Oi! Sobre o que combinamos..."], [responder("sim")]);
      t.igual(await fimDa(mista.id), ["concluida", ["na_fila"]], "a mista conclui");
      t.igual(
        await estado(t, cm.retorno),
        ["saindo", null],
        "o retorno da mista sai (a retorno_ao_concluir roda antes)",
      );
      await concluir(t, pura.id, ["Oi! Como combinamos..."], [responder("sim")]);
      t.igual(await fimDa(pura.id), ["concluida", ["na_fila"]], "a pura conclui");
      t.igual(await estado(t, rt3), ["saindo", null], "o retorno da pura sai");
      t.igual(
        await contar(t, "select 1 from public.retornos where tipo = 'lembrete'"),
        0,
        "nenhum lembrete gravado",
      );
      await t.aplicar(arqFuncoes!);
      t.ok(
        !(await temQuebrada(t, "lembrete_ao_concluir")),
        "a função de volta (do nina_retornos_funcoes)",
      );
    });

    /** A mista antes da hora (retorno das +8 min, marcado há 1 dia) concluída com 1 bolha na fila. */
    async function mistaSaindo(b: Preparo, n: number) {
      const c = await comRetornoPara(b, n, "now() + interval '8 minutes'");
      const { rodada } = await leadEscreve(b, n, c.conversa);
      t.igual(rodada.retorno_id, c.retorno, "levado antes da hora");
      await concluir(t, rodada.id, ["Oi! Já te chamo no horário combinado."], [responder("nao")]);
      t.igual(await estado(t, c.retorno), ["saindo", null], "saindo");
      const [{ id: bolha }] = await t.sql(
        "select id from public.mensagens where rodada_id = $1 and direcao = 'saida'",
        [rodada.id],
      );
      return { ...c, mista: rodada.id as string, bolha: bolha as string };
    }

    const statusDa = async (msg: string) =>
      (await t.sql("select status::text as s from public.mensagens where id = $1", [msg]))[0]
        .s as string;

    it("A1 (bolhas): mista antes da hora saindo; a equipe assume antes de a bolha sair → pendente; devolveu e venceu → a faixa 1 pega", async () => {
      const b = await preparar(t);
      const s = await mistaSaindo(b, 1);
      await assumir(t, b.uAtend, s.conversa); // cancela a bolha na fila
      t.igual(await statusDa(s.bolha), "cancelada", "a bolha foi cancelada");
      const rt = await retorno(t, s.retorno);
      t.igual(
        [rt.status, rt.rodada_id, rt.nao_enviado_motivo, rt.resolvido_em],
        ["pendente", null, null, null],
        "volta a pendente, sem motivo",
      );
      await devolver(t, b.uAtend, s.conversa);
      await vencerRetorno(t, s.retorno);
      // a devolução arma a conversa (o "ok" do lead é mais novo que a última saída válida): a rodada
      // dela sai antes, sem a fala do lead e sem o retorno (8b); depois, a faixa 1 pega
      const [dev] = (await pegar(t)).filter((r: Linha) => r.conversa_id === s.conversa);
      t.igual(dev.retorno_id, null, "a rodada da devolução não leva o retorno");
      await concluir(t, dev.id, ["Voltei! Posso ajudar?"]);
      const [pura] = (await pegar(t)).filter((r: Linha) => r.conversa_id === s.conversa);
      t.igual(pura.retorno_id, s.retorno, "a faixa 1 pega");
      t.igual(await estado(t, s.retorno), ["em_rodada", null]);
    });

    it("A1 (bolhas): mista antes da hora saindo; a bolha cancelada com a conversa ainda com a Nina (Desconectar) → pendente, não desconectado", async () => {
      const b = await preparar(t);
      const s = await mistaSaindo(b, 1);
      await t.sql(
        "update public.mensagens set status = 'cancelada', status_em = now() where id = $1",
        [s.bolha],
      );
      t.igual((await conversaDe(t, s.conversa)).modo, "nina");
      const rt = await retorno(t, s.retorno);
      t.igual(
        [rt.status, rt.rodada_id, rt.nao_enviado_motivo, rt.resolvido_em],
        ["pendente", null, null, null],
      );
      // na hora, sem conexão de volta até o prazo, quem decide é a varredura C (desconectado)
      await t.sql("update public.conexoes set status = 'desconectada' where id = $1", [b.cx]);
      await t.sql(
        "update public.retornos set vence_em = now() - interval '4 hours', expira_em = now() - interval '1 hour' where id = $1",
        [s.retorno],
      );
      await varrer(t);
      t.igual(
        await estado(t, s.retorno),
        ["nao_enviado", "desconectado"],
        "na hora, pela varredura C",
      );
    });

    it("A1 (bolhas): a equipe escreve pela tela antes de a bolha da mista sair → pendente; na hora, com_equipe pela varredura A", async () => {
      const b = await preparar(t);
      const s = await mistaSaindo(b, 1);
      await t.sql(
        `insert into public.mensagens (conversa_id, direcao, origem, texto, status, autor_membro_id)
       values ($1, 'saida', 'humano_tela', 'Oi, aqui é a equipe', 'na_fila', $2)`,
        [s.conversa, b.mAtend],
      );
      t.igual(await statusDa(s.bolha), "cancelada");
      t.igual(await estado(t, s.retorno), ["pendente", null], "antes da hora: volta");
      await vencerRetorno(t, s.retorno);
      await varrer(t);
      const fim = await retorno(t, s.retorno);
      t.igual([fim.status, fim.nao_enviado_motivo], ["nao_enviado", "com_equipe"]);
      t.ok(ms(fim.resolvido_em)! >= ms(fim.vence_em)!, "resolvido_em >= vence_em");
    });

    /** A mista antes da hora (R1 das +8 min) em que o lead remarcou: a Nina marcou R2 nela. */
    async function mistaRemarcada(b: Preparo, n: number) {
      const c = await comRetornoPara(b, n, "now() + interval '8 minutes'");
      const { rodada } = await leadEscreve(b, n, c.conversa);
      t.igual(rodada.retorno_id, c.retorno, "levado antes da hora");
      const q = await amanha(t, "10:00");
      const res = await marcar(t, rodada.id, q.data, q.hora, "Ligar na sexta");
      t.igual(
        [res.ok, res.substituido_vence_em],
        [true, null],
        "R2 marcado; o levado não é substituído",
      );
      return { ...c, mista: rodada.id as string, r2: res.retorno_id as string };
    }

    async function confereRemarcacao(
      s: { retorno: string; mista: string; r2: string },
      msg: string,
    ) {
      const r1 = await retorno(t, s.retorno);
      t.igual(
        [r1.status, r1.fechado_por_rodada, r1.resolvido_em instanceof Date, r1.enviado_em],
        ["cancelado", s.mista, true, null],
        `${msg}: R1 cancelado pela remarcação, fechado pela mista`,
      );
      const r2 = await retorno(t, s.r2);
      t.igual(
        [r2.status, r2.substitui_id],
        ["pendente", s.retorno],
        `${msg}: R2 pendente, como a remarcação de R1`,
      );
    }

    it("A1 (bolhas) com remarcação: mista antes da hora com R2 marcado; a equipe assume antes de a bolha sair → R1 cancelado e R2 com substitui_id = R1; a varredura não fica presa", async () => {
      const b = await preparar(t);
      const s = await mistaRemarcada(b, 1);
      await concluir(t, s.mista, ["Claro! Te chamo amanhã às 10h."], [responder("nao")]);
      t.igual(await estado(t, s.retorno), ["saindo", null], "saindo");
      await assumir(t, b.uAtend, s.conversa); // cancela a bolha na fila; o gatilho das bolhas devolve R1
      await confereRemarcacao(s, "pelo gatilho das bolhas");
      await varrer(t);
      await confereRemarcacao(s, "depois da varredura (nada estoura e nada muda)");
    });

    it("A1 (varredura F) com remarcação: a mista antes da hora com R2 marcado, assumida sem concluir → R1 cancelado (fechado pela mista) e R2 com substitui_id = R1", async () => {
      const b = await preparar(t);
      const s = await mistaRemarcada(b, 1);
      await assumir(t, b.uAtend, s.conversa); // cancela a mista, que ninguém conclui
      t.igual(await estado(t, s.retorno), ["em_rodada", null], "o órfão espera a varredura");
      await varrer(t);
      await confereRemarcacao(s, "pela varredura F");
      await varrer(t);
      await confereRemarcacao(s, "a 2ª varredura não muda nada");
    });

    it("A2: a Nina cancela o retorno da própria mista: cancelado, nunca enviado", async () => {
      const b = await preparar(t);
      const c = await comRetornoPara(b, 1, "now() - interval '1 minute'");
      const { rodada } = await leadEscreve(b, 1, c.conversa);
      const res = await ninaCancela(t, rodada.id, "O lead já resolveu");
      t.igual([res.ok, res.retorno_id], [true, c.retorno]);
      t.igual(await daRodada(t, rodada.id), null, "a rodada já não tem retorno aberto");
      await concluir(t, rodada.id, ["Que bom que deu certo!"], [responder("nao")]);
      await enviarTudo(t);
      const rt = await retorno(t, c.retorno);
      t.igual(
        [
          rt.status,
          rt.fechado_por_rodada,
          rt.nota_fim,
          rt.enviado_em,
          rt.resolvido_em instanceof Date,
        ],
        ["cancelado", rodada.id, "O lead já resolveu", null, true],
      );
    });

    it("A2b: na mista, o lead remarca; marcar e cancelar, em qualquer ordem, cancelam só o levado e deixam o novo pendente", async () => {
      const b = await preparar(t);
      const fins: unknown[] = [];
      for (const [n, ordem] of [
        [1, "marcar e depois cancelar"],
        [2, "cancelar e depois marcar"],
      ] as const) {
        const c = await comRetornoPara(b, n, "now() - interval '1 minute'");
        const { rodada } = await leadEscreve(b, n, c.conversa);
        t.igual(rodada.retorno_id, c.retorno, `${ordem}: a mista`);
        const venceLevado = ms((await retorno(t, c.retorno)).vence_em);
        const q = await amanha(t, "15:00");
        const marca = async () => {
          const m = await marcar(t, rodada.id, q.data, q.hora, "O lead pediu amanhã às 15h");
          t.igual(
            [m.ok, m.igual, m.substituido_vence_em],
            [true, false, null],
            `${ordem}: o novo, sem substituir o levado`,
          );
          return m.retorno_id as string;
        };
        const cancela = async () => {
          const res = await ninaCancela(t, rodada.id, "O lead pediu outro horário");
          t.igual([res.ok, res.retorno_id], [true, c.retorno], `${ordem}: cancela o levado`);
          t.igual(ms(res.vence_em), venceLevado, `${ordem}: a resposta é a hora do levado`);
        };
        let novo: string;
        if (n === 1) {
          novo = await marca();
          await cancela();
        } else {
          await cancela();
          novo = await marca();
        }
        await concluir(t, rodada.id, ["Combinado, te chamo amanhã às 15h."], [responder("nao")]);
        await enviarTudo(t);
        const lv = await retorno(t, c.retorno);
        t.igual(
          [lv.status, lv.fechado_por_rodada, lv.nota_fim, lv.enviado_em],
          ["cancelado", rodada.id, "O lead pediu outro horário", null],
          `${ordem}: o levado cancelado, nunca enviado`,
        );
        const r2 = await retorno(t, novo);
        t.igual(
          [r2.status, ms(r2.vence_em), r2.rodada_origem_id],
          ["pendente", q.em.getTime(), rodada.id],
          `${ordem}: o novo pendente, amanhã às 15:00`,
        );
        fins.push([lv.status, lv.enviado_em, r2.status, r2.substitui_id, r2.nao_enviado_motivo]);
      }
      t.igual(fins[0], fins[1], "as duas ordens chegam ao mesmo estado");
    });

    it("8d e caso 14: a ligação não concluída não conta como fala do lead; a concluída leva o retorno e deixa marcar (D4)", async () => {
      const b = await preparar(t, { gateway: "meta" });
      const quem = (n: number) => JSON.stringify([{ tipo: "telefone", valor: tel(n) }]);
      const ligar = async (n: number, ext: string) =>
        servidor(
          t,
          "select * from public.ligacao_iniciar($1, $2::jsonb, 'Ana Lima', $3, null, 'entrada', now())",
          [b.cx, quem(n), ext],
        );
      const encerrar = (ext: string, status: string) =>
        servidor(
          t,
          "select * from public.ligacao_encerrar($1, $2::public.ligacao_status, now(), 60, 'end_call', null, '[]'::jsonb, null)",
          [ext, status],
        );
      for (const [n, status, levado] of [
        [1, "nao_completada", false],
        [2, "concluida", true],
      ] as const) {
        const c = await atendida(t, b, tel(n));
        const rt = await inserir(t, c.conversa);
        const ext = `lig-rt-${n}`;
        await ligar(n, ext);
        t.igual(await pegar(t), [], "com a ligação em andamento, ninguém pega");
        await encerrar(ext, status);
        await vencer(t, c.conversa);
        const rs = (await pegar(t)).filter((r: Linha) => r.conversa_id === c.conversa);
        t.igual(rs.length, 1, `${status}: a rodada depois da ligação`);
        const [{ fala }] = await t.sql("select public.rodada_tem_fala_do_lead($1) as fala", [
          rs[0].id,
        ]);
        t.igual(fala, levado, `${status}: fala do lead`);
        t.igual(rs[0].retorno_id, levado ? rt : null, `${status}: levar junto`);
        const q = await local(t, "now() + interval '2 hours'"); // na oficial, dentro das 24 h
        if (levado)
          t.igual((await marcar(t, rs[0].id, q.data, q.hora)).ok, true, "marca depois da ligação");
        else await t.erro(marcar(t, rs[0].id, q.data, q.hora), "rodada_sem_lead");
      }
    });
  },
);

describe.skipIf(!temFluxo)(
  "banco: retornos, WhatsApp, falhas e ligação (casos 12 a 14)",
  { timeout: TEMPO_TESTE },
  () => {
    const t = usarBanco(base);

    it("caso 12: WhatsApp ativo mas desconectado: ninguém pega e não conta; volta a conectar: pronto desde a volta", async () => {
      const b = await preparar(t);
      const c = await atendida(t, b, tel(1));
      const rt = await inserir(t, c.conversa);
      await t.sql("update public.conexoes set status = 'desconectada' where id = $1", [b.cx]);
      t.igual(await prontos(t), [], "não está pronto");
      t.igual(await pendencias(t), NADA, "não conta para o atraso");
      t.igual(await pegar(t), [], "ninguém pega");
      t.igual(await estado(t, rt), ["pendente", null], "espera (até 3 h)");
      await t.sql("update public.conexoes set status = 'conectada' where id = $1", [b.cx]);
      const [{ volta }] = await t.sql(
        "select max(criado_em) as volta from public.conexao_eventos where conexao_id = $1 and status_para = 'conectada'",
        [b.cx],
      );
      const [p] = await prontos(t);
      t.igual(ms(p.pronto_em), ms(volta), "pronto desde a volta");
      t.igual(
        await pendencias(t),
        { proximo: null, vencido: ms(volta), atrasado: ms(volta) },
        "atrasado desde a volta",
      );
      t.igual((await pegar(t))[0]?.retorno_id, rt, "pega");
    });

    it("caso 12 (reativação): o WhatsApp desativado e ativado de novo: pronto desde a reativação (o evento ativa_para)", async () => {
      const b = await preparar(t);
      const c = await atendida(t, b, tel(1));
      const rt = await inserir(t, c.conversa);
      await t.sql("update public.conexoes set ativa = false where id = $1", [b.cx]);
      t.igual(await prontos(t), [], "desativado: não está pronto");
      await t.sql("update public.conexoes set ativa = true where id = $1", [b.cx]);
      const [{ volta }] = await t.sql(
        "select max(criado_em) as volta from public.conexao_eventos where conexao_id = $1 and ativa_para and ativa_de is distinct from true",
        [b.cx],
      );
      t.ok(volta instanceof Date, "o evento da reativação");
      const [p] = await prontos(t);
      t.igual([p?.retorno_id, ms(p?.pronto_em)], [rt, ms(volta)], "pronto desde a reativação");
      t.igual((await pegar(t))[0]?.retorno_id, rt, "pega");
    });

    it("caso 12: passou de 3 h: desconectado (caído agora ou depois da hora) ou passou_do_prazo", async () => {
      const b = await preparar(t);
      const velho = { vence: "now() - interval '4 hours'", expira: "now() - interval '1 hour'" };
      const c1 = await atendida(t, b, tel(1));
      const r1 = await inserir(t, c1.conversa, velho);
      await varrer(t);
      t.igual(
        await estado(t, r1),
        ["nao_enviado", "passou_do_prazo"],
        "conectado desde antes da hora",
      );
      const c2 = await atendida(t, b, tel(2));
      const r2 = await inserir(t, c2.conversa, velho);
      await t.sql("update public.conexoes set status = 'desconectada' where id = $1", [b.cx]);
      await t.sql("update public.conexoes set status = 'conectada' where id = $1", [b.cx]);
      await varrer(t);
      t.igual(await estado(t, r2), ["nao_enviado", "desconectado"], "caiu e voltou depois da hora");
      const c3 = await atendida(t, b, tel(3));
      const r3 = await inserir(t, c3.conversa, velho);
      await t.sql("update public.conexoes set status = 'desconectada' where id = $1", [b.cx]);
      await varrer(t);
      t.igual(await estado(t, r3), ["nao_enviado", "desconectado"], "desconectado agora");
      t.ok((await retorno(t, r3)).resolvido_em instanceof Date, "resolvido_em");
    });

    // O lembrete do lead que ficou calado: ele falou há 6 h, o lembrete foi armado há 5 h, venceu há
    // 4 h e o prazo passou há 1 min (o WhatsApp ou o worker ficaram fora na hora). Assim a varredura D
    // não o apaga por "o lead falou" e quem decide é a E.
    const lembreteExpirado = {
      tipo: "lembrete",
      vence: "now() - interval '4 hours'",
      expira: "now() - interval '1 minute'",
      marcado: "now() - interval '5 hours'",
    };
    const calado = (t: Banco, conversa: string) =>
      t.sql(
        "update public.conversas set ultima_do_lead_em = now() - interval '6 hours' where id = $1",
        [conversa],
      );

    it("caso 12 (lembrete): expirado, a varredura E fecha em silêncio: passou_do_prazo com o WhatsApp no ar; desconectado caído agora ou depois da hora", async () => {
      const b = await preparar(t);
      // passou do prazo, com o WhatsApp no ar
      const c1 = await atendida(t, b, tel(1));
      await calado(t, c1.conversa);
      const l1 = await inserir(t, c1.conversa, lembreteExpirado);
      // antes de varrer: o corte do prazo dos prontos (sem ele, a faixa 2 mandaria o lembrete vencido)
      t.igual(await prontos(t), [], "expirado: não está pronto");
      t.igual(await pendencias(t), NADA, "expirado: não conta");
      await varrer(t);
      t.igual(
        await estado(t, l1),
        ["nao_enviado", "passou_do_prazo"],
        "conectado desde antes da hora",
      );
      t.ok((await retorno(t, l1)).resolvido_em instanceof Date, "resolvido_em");
      // caiu e voltou depois da hora
      const c2 = await atendida(t, b, tel(2));
      await calado(t, c2.conversa);
      const l2 = await inserir(t, c2.conversa, lembreteExpirado);
      await t.sql("update public.conexoes set status = 'desconectada' where id = $1", [b.cx]);
      await t.sql("update public.conexoes set status = 'conectada' where id = $1", [b.cx]);
      await varrer(t);
      t.igual(await estado(t, l2), ["nao_enviado", "desconectado"], "caiu e voltou depois da hora");
      // caído agora
      const c3 = await atendida(t, b, tel(3));
      await calado(t, c3.conversa);
      const l3 = await inserir(t, c3.conversa, lembreteExpirado);
      await t.sql("update public.conexoes set status = 'desconectada' where id = $1", [b.cx]);
      await varrer(t);
      t.igual(await estado(t, l3), ["nao_enviado", "desconectado"], "desconectado agora");
      t.igual(
        await contar(t, "select 1 from public.rodadas where retorno_id = any ($1::uuid[])", [
          [l1, l2, l3],
        ]),
        0,
        "nenhum saiu",
      );
    });

    it("caso 12 (lembrete, oficial): vencido dentro do prazo com a janela de 24 h fechada: a 2ª varredura E fecha como fora_24h", async () => {
      // Estado montado à mão: no fluxo normal da oficial, o prazo do lembrete é cortado em
      // ultima_do_lead_em + 23 h 50 (lembrete_ao_concluir) e a 1ª varredura E chega antes. A 2ª cobre
      // a conexão trocada para a oficial depois de armar.
      const b = await preparar(t, { gateway: "meta" });
      const c = await atendida(t, b, tel(1));
      const l = await inserir(t, c.conversa, {
        tipo: "lembrete",
        vence: "now() - interval '1 minute'",
        expira: "now() + interval '1 hour'",
        marcado: "now() - interval '2 hours'",
      });
      await t.sql(
        "update public.conversas set ultima_do_lead_em = now() - interval '25 hours' where id = $1",
        [c.conversa],
      );
      t.igual(await prontos(t), [], "janela fechada: não está pronto");
      await varrer(t);
      t.igual(await estado(t, l), ["nao_enviado", "fora_24h"], "fora das 24 h, em silêncio");
      t.ok((await retorno(t, l)).resolvido_em instanceof Date, "resolvido_em");
    });

    it("caso 12 (B6): a rodada pura sem conexão no insert não sobe erro e volta; a mista sobe o erro de hoje", async () => {
      const b = await preparar(t);
      const c = await atendida(t, b, tel(1));
      const rt = await inserir(t, c.conversa);
      const [pura] = await pegar(t);
      await t.sql("update public.conexoes set ativa = false where id = $1", [b.cx]);
      await concluir(t, pura.id, ["Oi! Como combinamos..."], [responder("nao")]);
      const r = await retorno(t, rt);
      t.igual([r.status, r.rodada_id], ["pendente", null]);
      perto(t, r.tentar_apos, Date.now() + 30_000, 10_000, "tentar_apos de +30 s");
      const [{ status }] = await t.sql("select status::text from public.rodadas where id = $1", [
        pura.id,
      ]);
      t.igual(status, "concluida", "a rodada conclui vazia");
      t.igual(await saidasDa(t, pura.id), 0);
      const cv = await conversaDe(t, c.conversa);
      t.igual(
        [cv.modo, cv.responder_apos],
        ["nina", null],
        "a conversa não vai para a equipe nem é armada",
      );
      // a mista: o lead que falou recebe o tratamento de hoje
      await t.sql("update public.conexoes set ativa = true where id = $1", [b.cx]);
      const c2 = await atendida(t, b, tel(2));
      const rt2 = await inserir(t, c2.conversa);
      await entrada(t, b.cx, tel(2));
      await vencer(t, c2.conversa);
      const [mista] = (await pegar(t)).filter((x: Linha) => x.conversa_id === c2.conversa);
      t.igual(mista.retorno_id, rt2);
      await t.sql("update public.conexoes set ativa = false where id = $1", [b.cx]);
      await t.erro(concluir(t, mista.id, ["Oi!"], [responder("nao")]), "sem_conexao_ativa");
    });

    // A mista na oficial com a janela fechada durante a rodada: o janela_fechada do insert sobe como
    // hoje (o servidor publicado passa a conversa à equipe), e o retorno levado junto não muda.
    it("caso 12 (B6, oficial): a mista com a janela fechada no insert sobe janela_fechada; nada muda", async () => {
      const b = await preparar(t, { gateway: "meta" });
      const c = await atendida(t, b, tel(1));
      const rt = await inserir(t, c.conversa);
      await entrada(t, b.cx, tel(1));
      await vencer(t, c.conversa);
      const [mista] = (await pegar(t)).filter((x: Linha) => x.conversa_id === c.conversa);
      t.igual(mista?.retorno_id, rt, "a mista leva o retorno");
      await t.sql(
        "update public.conversas set ultima_do_lead_em = now() - interval '25 hours' where id = $1",
        [c.conversa],
      );
      await t.erro(concluir(t, mista.id, ["Oi!"], [responder("nao")]), "janela_fechada");
      const [{ s }] = await t.sql("select status::text as s from public.rodadas where id = $1", [
        mista.id,
      ]);
      t.igual(s, "rodando", "a rodada continua rodando");
      const r = await retorno(t, rt);
      t.igual([r.status, r.rodada_id], ["em_rodada", mista.id], "o retorno continua na mista");
      t.igual(await saidasDa(t, mista.id), 0, "nenhuma bolha");
    });

    it("caso 12 (B6, no fim do prazo): sem conexão no insert a menos de 30 s do prazo: desconectado; a falha passageira com o WhatsApp no ar: passou_do_prazo", async () => {
      const b = await preparar(t);
      const perto = {
        vence: "now() - interval '3 hours'",
        expira: "now() + interval '20 seconds'",
      };
      // conectado desde antes da hora, falha passageira: a nova tentativa cairia depois do prazo
      const c1 = await atendida(t, b, tel(1));
      const r1 = await inserir(t, c1.conversa, perto);
      const [p1] = await pegar(t);
      t.igual(p1.retorno_id, r1);
      await falhar(t, p1.id, "erro_provedor", true);
      t.igual(await estado(t, r1), ["nao_enviado", "passou_do_prazo"], "com o WhatsApp no ar");
      // o insert recusado por falta de conexão ativa: a causa é a conexão, não o prazo
      const c2 = await atendida(t, b, tel(2));
      const r2 = await inserir(t, c2.conversa, perto);
      const [p2] = await pegar(t);
      t.igual(p2.retorno_id, r2);
      await t.sql("update public.conexoes set ativa = false where id = $1", [b.cx]);
      await concluir(t, p2.id, ["Oi! Como combinamos..."], [responder("nao")]);
      t.igual(await estado(t, r2), ["nao_enviado", "desconectado"], "sem conexão ativa");
    });

    it("caso 12 (oficial): janela fechada na hora → fora_24h, pela varredura e pela rodada pura", async () => {
      const b = await preparar(t, { gateway: "meta" });
      const c1 = await atendida(t, b, tel(1));
      const r1 = await inserir(t, c1.conversa);
      await t.sql(
        "update public.conversas set ultima_do_lead_em = now() - interval '25 hours' where id = $1",
        [c1.conversa],
      );
      t.igual(await prontos(t), [], "não está pronto");
      await varrer(t);
      t.igual(await estado(t, r1), ["nao_enviado", "fora_24h"], "pela varredura");
      const c2 = await atendida(t, b, tel(2));
      const r2 = await inserir(t, c2.conversa);
      const [pura] = await pegar(t);
      t.igual(pura.retorno_id, r2);
      await t.sql(
        "update public.conversas set ultima_do_lead_em = now() - interval '25 hours' where id = $1",
        [c2.conversa],
      );
      await concluir(t, pura.id, ["Oi!"], [responder("nao")]);
      t.igual(
        await estado(t, r2),
        ["nao_enviado", "fora_24h"],
        "pela rodada pura (janela_fechada no insert)",
      );
    });

    it("caso 13: falha passageira da pura: volta 2 vezes sem armar a conversa; a 3ª vai para a equipe (nina_falhou)", async () => {
      const b = await preparar(t);
      const c = await atendida(t, b, tel(1));
      const rt = await inserir(t, c.conversa);
      const tentativas: number[] = [];
      for (let i = 1; i <= 3; i++) {
        await t.sql(
          "update public.retornos set tentar_apos = now() - interval '1 second' where id = $1 and tentar_apos is not null",
          [rt],
        );
        const [pura] = await pegar(t);
        t.igual(pura?.retorno_id, rt, `tentativa ${i}: pega`);
        tentativas.push(pura.tentativa as number);
        await falhar(t, pura.id, "erro_provedor", true);
        const r = await retorno(t, rt);
        const cv = await conversaDe(t, c.conversa);
        if (i < 3) {
          t.igual([r.status, r.rodada_id], ["pendente", null], `tentativa ${i}: volta`);
          perto(t, r.tentar_apos, Date.now() + 30_000, 10_000, "tentar_apos de +30 s");
          t.igual([cv.modo, cv.responder_apos], ["nina", null], "a conversa não é armada (D5)");
          // a espera de 30 s vale: a faixa não pega o retorno de novo e o relógio não acorda o worker
          // por ele (sem ela, as 3 tentativas se gastariam em segundos)
          t.igual(await pegar(t), [], `tentativa ${i}: antes dos 30 s, a faixa não pega`);
          await motorPronto(t); // worker que conhece retornos, visto há 2 min, sem toque recente
          const antes = await pedidos(t);
          await relogio(t);
          t.igual(
            (await pedidos(t)) - antes,
            0,
            `tentativa ${i}: antes dos 30 s, o relógio não toca`,
          );
        } else {
          t.igual([r.status, r.nao_enviado_motivo], ["nao_enviado", "nina_falhou"], "a 3ª");
          t.igual(
            [cv.modo, cv.motivo_humano],
            ["humano", "erro_provedor"],
            "Precisam de você (regra de hoje)",
          );
        }
      }
      t.igual(tentativas, [1, 2, 3], "as tentativas da conversa");
      t.igual(
        await contar(
          t,
          "select 1 from public.conversa_eventos where conversa_id = $1 and tipo = 'passou'",
          [c.conversa],
        ),
        1,
      );
    });

    /** Duas rodadas 'falhou' antigas na conversa, com o criado_em dado (expressão SQL). */
    async function duasFalhas(conversa: string, quando: string) {
      for (let k = 0; k < 2; k++)
        await t.sql(
          `insert into public.rodadas (conversa_id, status, iniciada_em, terminada_em, criado_em)
         values ($1, 'falhou', ${quando}, ${quando}, ${quando})`,
          [conversa],
        );
    }

    /** A pura do retorno falha uma vez, de forma passageira: volta em 30 s e a conversa fica com a Nina. */
    async function umaFalhaPassageira(conversa: string, rt: string, msg: string) {
      const [pura] = await pegar(t);
      t.igual([pura?.retorno_id, pura?.tentativa], [rt, 1], `${msg}: a 1ª tentativa`);
      await falhar(t, pura.id, "erro_provedor", true);
      const r = await retorno(t, rt);
      t.igual(
        [r.status, r.nao_enviado_motivo, r.rodada_id],
        ["pendente", null, null],
        `${msg}: o retorno volta`,
      );
      perto(t, r.tentar_apos, Date.now() + 30_000, 10_000, `${msg}: tentar_apos de +30 s`);
      const cv = await conversaDe(t, conversa);
      t.igual(
        [cv.modo, cv.responder_apos],
        ["nina", null],
        `${msg}: a conversa fica com a Nina, sem armar`,
      );
      t.igual(
        await contar(
          t,
          "select 1 from public.conversa_eventos where conversa_id = $1 and tipo = 'passou'",
          [conversa],
        ),
        0,
        `${msg}: sem 'Precisam de você'`,
      );
    }

    it("caso 13: as falhas de antes da última rodada concluída não contam na tentativa da pura", async () => {
      const b = await preparar(t);
      const c = await atendida(t, b, tel(1));
      await duasFalhas(c.conversa, "now() - interval '7 days'"); // antes da rodada concluída de atendida
      const rt = await inserir(t, c.conversa);
      await umaFalhaPassageira(c.conversa, rt, "zerada pela concluída");
    });

    it("caso 13: as falhas de antes da devolução à Nina não contam na tentativa da pura", async () => {
      const b = await preparar(t);
      const c = await atendida(t, b, tel(1));
      // a concluída de atendida há 1 h; as duas falhas depois dela e antes da devolução
      await t.sql(
        "update public.rodadas set criado_em = now() - interval '1 hour' where conversa_id = $1 and status = 'concluida'",
        [c.conversa],
      );
      await duasFalhas(c.conversa, "now() - interval '1 minute'");
      await assumir(t, b.uAtend, c.conversa);
      await devolver(t, b.uAtend, c.conversa);
      const rt = await inserir(t, c.conversa);
      await umaFalhaPassageira(c.conversa, rt, "zerada pela devolução");
    });

    it("caso 13: falha definitiva da pura na 1ª: nao_enviado/nina_falhou e equipe; o lembrete nunca vai à equipe", async () => {
      const b = await preparar(t);
      const c = await atendida(t, b, tel(1));
      const rt = await inserir(t, c.conversa);
      const [pura] = await pegar(t);
      await falhar(t, pura.id, "chave_invalida", false);
      t.igual(await estado(t, rt), ["nao_enviado", "nina_falhou"]);
      t.igual((await conversaDe(t, c.conversa)).modo, "humano");
      for (const [n, motivo, passageiro] of [
        [2, "erro_provedor", true],
        [3, "chave_invalida", false],
      ] as const) {
        const cl = await atendida(t, b, tel(n));
        const lb = await inserir(t, cl.conversa, { tipo: "lembrete" });
        const [rodada] = await pegar(t);
        t.igual(rodada.retorno_id, lb, "pega o lembrete");
        await falhar(t, rodada.id, motivo, passageiro);
        t.igual(await estado(t, lb), ["nao_enviado", "nina_falhou"], `lembrete, ${motivo}`);
        const cv = await conversaDe(t, cl.conversa);
        t.igual(
          [cv.modo, cv.responder_apos],
          ["nina", null],
          `lembrete, ${motivo}: a conversa não muda`,
        );
        t.igual(
          await contar(t, "select 1 from public.conversa_eventos where conversa_id = $1", [
            cl.conversa,
          ]),
          0,
          "sem evento",
        );
      }
    });

    it("caso 13 (lembrete): a conversa sai da Nina durante a rodada de lembrete e a rodada falha: com_equipe (não nina_falhou), sem armar e sem outro 'passou'", async () => {
      const b = await preparar(t);
      const cl = await atendida(t, b, tel(1));
      const lb = await inserir(t, cl.conversa, { tipo: "lembrete" });
      const [rodada] = await pegar(t);
      t.igual(rodada.retorno_id, lb, "pega o lembrete");
      // tira a conversa da Nina com a rodada ainda rodando (o papel da ligacao_passar_para_equipe,
      // base 0024, ou do envio_falhou, os caminhos reais na pura)
      await servidor(t, "select public.nina_passar_para_humano($1)", [rodada.id]);
      await falhar(t, rodada.id, "erro_provedor", true);
      t.igual(await estado(t, lb), ["nao_enviado", "com_equipe"]);
      const cv = await conversaDe(t, cl.conversa);
      t.igual([cv.modo, cv.responder_apos], ["humano", null], "com a equipe, sem armar");
      t.igual(
        await contar(
          t,
          "select 1 from public.conversa_eventos where conversa_id = $1 and tipo = 'passou'",
          [cl.conversa],
        ),
        1,
        "só o 'passou' da passagem",
      );
    });

    it("D5: a rodada pura presa é falhada pela pegar_rodadas de hoje sem armar a conversa; com a parte nova quebrada, a varredura fecha", async () => {
      const b = await preparar(t);
      const c = await atendida(t, b, tel(1));
      const rt = await inserir(t, c.conversa);
      const [pura] = await pegar(t);
      await t.sql(
        "update public.rodadas set iniciada_em = now() - interval '6 minutes' where id = $1",
        [pura.id],
      );
      t.igual(await pegarAntiga(t), [], "o servidor antigo não cria rodada");
      const [{ status }] = await t.sql("select status::text from public.rodadas where id = $1", [
        pura.id,
      ]);
      t.igual(status, "falhou");
      t.igual(await estado(t, rt), ["pendente", null]);
      t.igual((await conversaDe(t, c.conversa)).responder_apos, null, "a conversa não é armada");
      t.igual(await pegarAntiga(t), [], "a 2ª também não");
      // a parte nova quebrada: a pegada antiga não cai, e a varredura F fecha o órfão
      const c2 = await atendida(t, b, tel(2));
      await t.sql(
        "update public.retornos set tentar_apos = now() + interval '1 hour' where id = $1",
        [rt],
      );
      const rt2 = await inserir(t, c2.conversa);
      const rs = await pegar(t);
      t.igual(
        rs.map((r: Linha) => r.retorno_id),
        [rt2],
        "o retorno com tentar_apos no futuro não é pego",
      );
      const [pura2] = rs;
      await quebrar(t, "retorno_ao_falhar");
      await t.sql(
        "update public.rodadas set iniciada_em = now() - interval '6 minutes' where id = $1",
        [pura2.id],
      );
      t.igual(await pegarAntiga(t), [], "não lança");
      t.igual(await estado(t, rt2), ["em_rodada", null], "o órfão espera a varredura");
      await varrer(t);
      t.igual(await estado(t, rt2), ["pendente", null], "a varredura F devolve");
      t.igual((await conversaDe(t, c2.conversa)).responder_apos, null);
    });

    it("caso 14: com a ligação em andamento dentro do teto, a conversa espera; passado o teto, pega", async () => {
      const b = await preparar(t);
      const c = await atendida(t, b, tel(1));
      const rt = await inserir(t, c.conversa);
      await t.sql(
        `insert into public.ligacoes (conversa_id, conexao_id, direcao, id_externo, iniciada_em)
       values ($1, $2, 'entrada', 'lig-andamento-1', now() - interval '1 minute')`,
        [c.conversa, b.cx],
      );
      const [{ livre }] = await t.sql("select public.retorno_conversa_livre($1) as livre", [
        c.conversa,
      ]);
      t.igual(livre, false, "não está livre");
      t.igual(await pegar(t), [], "espera a ligação");
      t.igual(await pendencias(t), NADA, "e não conta para o atraso");
      await t.sql(
        "update public.ligacoes set iniciada_em = now() - interval '2 hours' where id_externo = 'lig-andamento-1'",
      );
      t.igual((await pegar(t))[0]?.retorno_id, rt, "passado o teto, pega");
    });

    it("caso 14 (B T16): ligação de saída não atendida não deixa marcar; atendida, deixa", async () => {
      const b = await preparar(t, { gateway: "meta" });
      const [{ id: ag }] = await t.sql(
        "insert into public.ligacao_agentes (nome, atende, duracao_max_s) values ('Nina', true, 600) returning id",
      );
      for (const [n, status, aceita] of [
        [1, "nao_completada", false],
        [2, "concluida", true],
      ] as const) {
        const c = await atendida(t, b, tel(n));
        const [s] = await servidor(t, "select * from public.ligacao_iniciar_saida($1, $2, now())", [
          c.conversa,
          ag,
        ]);
        t.igual(s.permitida, true, "ligação de saída permitida");
        await servidor(
          t,
          "select * from public.ligacao_encerrar($1, $2::public.ligacao_status, now(), 60, 'end_call', null, '[]'::jsonb, null)",
          [s.id_externo, status],
        );
        await vencer(t, c.conversa);
        const [rd] = (await pegar(t)).filter((x: Linha) => x.conversa_id === c.conversa);
        t.ok(rd, `${status}: a rodada depois da ligação`);
        const q = await local(t, "now() + interval '2 hours'"); // na oficial, dentro das 24 h
        if (aceita) t.igual((await marcar(t, rd.id, q.data, q.hora)).ok, true, "atendida: marca");
        else {
          await t.erro(marcar(t, rd.id, q.data, q.hora), "rodada_sem_lead");
          await t.erro(ninaCancela(t, rd.id, "x"), "rodada_sem_lead");
        }
      }
    });

    it("espelho das travas da faixa 0: retorno_conversa_livre barra igual, e quem é barrado não ganha rodada", async () => {
      const b = await preparar(t);
      const casos: Record<string, { conversa: string; retorno: string }> = {};
      const novo = async (nome: string, n: number) => {
        const c = await atendida(t, b, tel(n));
        casos[nome] = { conversa: c.conversa, retorno: await inserir(t, c.conversa) };
        return c.conversa;
      };
      await novo("livre", 1);
      const rodando = await novo("rodada rodando", 2);
      await t.sql("insert into public.rodadas (conversa_id, status) values ($1, 'rodando')", [
        rodando,
      ]);
      const midia = await novo("mídia pendente", 3);
      await entrada(t, b.cx, tel(3), {
        tipo: "audio",
        texto: null,
        midia_ref_externa: "ref-audio-1",
      });
      await t.sql("update public.conversas set responder_apos = null where id = $1", [midia]);
      const [{ ms: midiaPendente }] = await t.sql(
        "select count(*)::int as ms from public.mensagens where conversa_id = $1 and midia_status = 'pendente'",
        [midia],
      );
      t.igual(midiaPendente, 1, "a entrada de mídia está pendente");
      const armada = await novo("conversa armada", 4);
      await t.sql(
        "update public.conversas set responder_apos = now() + interval '1 minute' where id = $1",
        [armada],
      );
      const humano = await novo("modo humano", 5);
      await t.sql("update public.conversas set modo = 'humano' where id = $1", [humano]);
      const ligacao = await novo("ligação em andamento", 6);
      await t.sql(
        `insert into public.ligacoes (conversa_id, conexao_id, direcao, id_externo, iniciada_em)
       values ($1, $2, 'entrada', 'lig-espelho', now())`,
        [ligacao, b.cx],
      );
      const orfao = await novo("retorno em_rodada órfão", 7);
      const [{ id: velha }] = await t.sql("select id from public.rodadas where conversa_id = $1", [
        orfao,
      ]);
      await t.sql(
        `insert into public.retornos (conversa_id, tipo, status, vence_em, expira_em, motivo, rodada_id)
       values ($1, 'retorno', 'em_rodada', now() - interval '2 hours', now() + interval '1 hour', 'Outro', $2)`,
        [orfao, velha],
      );
      for (const [nome, { conversa }] of Object.entries(casos)) {
        const [{ livre }] = await t.sql("select public.retorno_conversa_livre($1) as livre", [
          conversa,
        ]);
        t.igual(livre, nome === "livre", `retorno_conversa_livre: ${nome}`);
      }
      t.igual(
        (await prontos(t)).map((p: Linha) => p.retorno_id),
        [casos["livre"]!.retorno],
        "só o livre está pronto",
      );
      const [p] = await t.sql("select vence_em from public.retornos where id = $1", [
        casos["livre"]!.retorno,
      ]);
      const hoje = await pendenciasHoje(t);
      const menor = (a: number | null, b: number | null) =>
        a === null ? b : b === null ? a : Math.min(a, b);
      t.igual(
        await pendencias(t),
        {
          proximo: hoje.proximo,
          vencido: menor(hoje.vencido, ms(p.vence_em)),
          atrasado: menor(hoje.atrasado, ms(p.vence_em)),
        },
        "só o retorno livre soma ao que a faixa 0 já conta",
      );
      const rs = await pegar(t, 10, 10);
      const comRetornoDe = rs.filter((r: Linha) => r.retorno_id).map((r: Linha) => r.conversa_id);
      t.ok(comRetornoDe.includes(casos["livre"]!.conversa), "o livre ganha rodada");
      for (const nome of [
        "rodada rodando",
        "mídia pendente",
        "conversa armada",
        "modo humano",
        "ligação em andamento",
      ])
        t.ok(!comRetornoDe.includes(casos[nome]!.conversa), `${nome}: sem rodada de retorno`);
    });

    it("D2: sem conexão ativa, nada fica pronto, nada conta e ninguém pega", async () => {
      const b = await preparar(t);
      const c = await atendida(t, b, tel(1));
      await inserir(t, c.conversa);
      await t.sql("update public.conexoes set ativa = false where id = $1", [b.cx]);
      t.igual(await prontos(t), []);
      t.igual(await pendencias(t), NADA);
      t.igual(await pegar(t), []);
    });

    it("espelho das travas da faixa 0 (o onboarding): sem ele concluído, nada fica pronto, nada conta e ninguém pega; concluído agora, pronto desde a conclusão", async () => {
      const b = await preparar(t);
      const c = await atendida(t, b, tel(1));
      const rt = await inserir(t, c.conversa, {
        vence: "now() - interval '1 hour'",
        expira: "now() + interval '2 hours'",
      });
      await t.sql("update public.configuracao set onboarding_concluido_em = null where id = 1");
      t.igual(await prontos(t), [], "sem o onboarding: nada pronto");
      t.igual(await pendencias(t), await pendenciasHoje(t), "o retorno não soma ao atraso");
      t.igual(
        (await pegar(t)).filter((r: Linha) => r.retorno_id),
        [],
        "nenhuma rodada com retorno",
      );
      t.igual(await estado(t, rt), ["pendente", null], "o retorno espera");
      await t.sql("update public.configuracao set onboarding_concluido_em = now() where id = 1");
      const [{ em }] = await t.sql(
        "select onboarding_concluido_em as em from public.configuracao where id = 1",
      );
      const ps = await prontos(t);
      t.igual(
        ps.map((p: Linha) => p.retorno_id),
        [rt],
        "concluído: pronto",
      );
      t.igual(
        ms(ps[0]?.pronto_em),
        ms(em),
        "pronto desde a conclusão do onboarding (e não desde a hora marcada)",
      );
    });

    // O caso mais comum ("me chama semana que vem" na Z-API): o lead calado há dias. Nenhuma parte
    // depende da hora em que a suíte roda (os prazos são de dias ou de horas fixas).
    it("na conexão não oficial (Z-API) as regras das 24 h não valem", async () => {
      const b = await preparar(t);
      const calada = (conversa: string) =>
        t.sql(
          "update public.conversas set ultima_do_lead_em = now() - interval '3 days' where id = $1",
          [conversa],
        );
      // 1. o retorno vencido com o lead calado há 3 dias: pronto, a varredura não o fecha e a faixa 1 pega
      const c = await atendida(t, b, tel(1));
      await calada(c.conversa);
      const r = await inserir(t, c.conversa);
      t.ok(
        (await prontos(t)).some((p: Linha) => p.retorno_id === r),
        "o retorno fica pronto (sem a janela de 24 h)",
      );
      await varrer(t);
      t.igual(await estado(t, r), ["pendente", null], "a varredura não o fecha (nada de fora_24h)");
      const [pura] = (await pegar(t)).filter((x: Linha) => x.conversa_id === c.conversa);
      t.igual(pura?.retorno_id, r, "a faixa 1 cria a rodada do retorno");
      t.igual(await estado(t, r), ["em_rodada", null]);
      // 2. o lembrete vencido com o lead calado há 3 dias: a varredura não o fecha e ele fica pronto
      const c2 = await atendida(t, b, tel(2));
      await calada(c2.conversa);
      const lb = await inserir(t, c2.conversa, {
        tipo: "lembrete",
        vence: "now() - interval '1 minute'",
        expira: "now() + interval '1 hour'",
        marcado: "now() - interval '1 hour'",
      });
      await varrer(t);
      t.igual(
        await estado(t, lb),
        ["pendente", null],
        "a varredura não o fecha (nada de fora_24h)",
      );
      t.ok(
        (await prontos(t)).some((p: Linha) => p.retorno_id === lb),
        "o lembrete fica pronto",
      );
      // 3. a marcação além das 23 h 50 da última mensagem do lead: aceita
      const r3 = await rodadaDoLead(t, b, tel(3));
      const q = await local(t, "now() + interval '2 days'");
      const res = await marcar(t, r3.rodada.id, q.data, q.hora);
      t.igual(
        [res.ok, res.erro ?? null],
        [true, null],
        `marca daqui a 2 dias: ${JSON.stringify(res)}`,
      );
      // 4. o lembrete armado com a última do lead há 23 h: o prazo sem o corte de ultima + 23 h 50
      const r4 = await rodadaDoLead(t, b, tel(4));
      await t.sql(
        "update public.conversas set ultima_do_lead_em = now() - interval '23 hours' where id = $1",
        [r4.conversa],
      );
      await concluir(t, r4.rodada.id, ["Pode me confirmar o horário?"], [responder("sim")]);
      const [l4] = await retornosDa(t, r4.conversa);
      t.igual([l4?.tipo, l4?.status], ["lembrete", "pendente"], "arma");
      const [{ e }] = await t.sql(
        "select expira_em = public.lembrete_expira_em(vence_em) as e from public.retornos where id = $1",
        [l4.id],
      );
      t.igual(e, true, "o prazo do lembrete, sem o corte das 24 h");
    });
  },
);

describe.skipIf(!temFluxo)(
  "banco: retornos, o lembrete automático (casos 15 a 20, A5)",
  { timeout: TEMPO_TESTE },
  () => {
    const t = usarBanco(base);

    it("caso 15: a resposta com espera_resposta 'sim' arma um lembrete; na hora, a faixa 2 pega e ele sai", async () => {
      const b = await preparar(t);
      const r = await rodadaDoLead(t, b, tel(1));
      await concluir(t, r.rodada.id, ["Qual o melhor horário para você?"], [responder("sim")]);
      const linhas = await retornosDa(t, r.conversa);
      t.igual(linhas.length, 1, "um lembrete");
      const lb = linhas[0];
      t.igual(
        [lb.tipo, lb.status, lb.motivo, lb.rodada_origem_id, lb.rodada_id],
        ["lembrete", "pendente", null, r.rodada.id, null],
      );
      const [conta] = await t.sql(
        `select vence_em = public.lembrete_vence_em(marcado_em, 3, conversa_id) as v,
              expira_em = public.lembrete_expira_em(vence_em) as e,
              marcado_em > now() - interval '1 minute' as m
         from public.retornos where id = $1`,
        [lb.id],
      );
      t.igual(
        conta,
        { v: true, e: true, m: true },
        "vence_em e expira_em pelas funções puras, com 3 h",
      );
      await enviarTudo(t);
      await vencerRetorno(t, lb.id);
      t.igual(await pendencias(t), NADA, "o lembrete nunca conta para o atraso");
      const [pura] = await pegar(t);
      t.igual(pura.retorno_id, lb.id, "a faixa 2 pega");
      const lido = await daRodada(t, pura.id);
      t.igual(
        [lido.da_rodada, lido.tipo, lido.retorno_id, lido.motivo],
        [true, "lembrete", lb.id, null],
      );
      t.igual(ms(lido.marcado_em), ms(lb.marcado_em), "marcado_em");
      const q = await amanha(t);
      await t.erro(marcar(t, pura.id, q.data, q.hora), "rodada_sem_lead");
      await concluir(t, pura.id, ["Oi! Conseguiu ver?"], [responder("sim")]);
      t.igual(await estado(t, lb.id), ["saindo", null]);
      t.igual(
        await contar(t, "select 1 from public.retornos where conversa_id = $1", [r.conversa]),
        1,
        "a rodada de lembrete não arma outro",
      );
      await enviarTudo(t);
      t.igual(await estado(t, lb.id), ["enviado", null]);
    });

    it("caso 15: o lembrete segue o ajuste das horas", async () => {
      const b = await preparar(t);
      await t.sql("update public.configuracao set lembrete_horas = 5 where id = 1");
      const c = await atendida(t, b, tel(1), { ferramentas: [responder("sim")] });
      const [{ v }] = await t.sql(
        "select vence_em = public.lembrete_vence_em(marcado_em, 5, conversa_id) as v from public.retornos where conversa_id = $1",
        [c.conversa],
      );
      t.igual(v, true);
    });

    // Lente (g): o worker parado com a pergunta na fila. O lembrete não cobra a pergunta que o lead
    // ainda não recebeu, e as horas do ajuste contam de quando ela saiu.
    it("caso 15 (a pergunta parada na fila): o lembrete não cobra a pergunta que ainda não saiu; as horas do ajuste contam de quando ela saiu", async () => {
      const b = await preparar(t);
      const c = await atendida(t, b, tel(1), { ferramentas: [responder("sim")], enviar: false });
      const [lb] = await retornosDa(t, c.conversa);
      t.igual(
        [lb?.tipo, lb?.status, lb?.rodada_origem_id],
        ["lembrete", "pendente", c.rodada],
        "o lembrete armado",
      );
      await vencerRetorno(t, lb.id, "10 minutes");
      const pronto = async () => (await prontos(t)).find((p: Linha) => p.retorno_id === lb.id);
      t.igual(await pronto(), undefined, "a pergunta ainda na fila: não cobra");
      t.igual(
        (await pegar(t)).filter((r: Linha) => r.conversa_id === c.conversa),
        [],
        "ninguém pega",
      );
      t.igual(await estado(t, lb.id), ["pendente", null], "e a varredura não o apaga");
      await enviarTudo(t);
      t.igual(await pronto(), undefined, "a pergunta acabou de sair: ainda não");
      // 3 h e 1 min depois de a pergunta sair (o ajuste é de 3 h)
      await t.sql(
        "update public.mensagens set momento = now() - interval '3 hours 1 minute' where rodada_id = $1 and direcao = 'saida' and status = 'enviada'",
        [c.rodada],
      );
      t.ok(await pronto(), "3 h depois de a pergunta sair: pronto");
      const [{ ok }] = await t.sql(
        `select p.pronto_em = (select max(m.momento) + interval '3 hours' from public.mensagens m
                              where m.rodada_id = $2 and m.direcao = 'saida' and m.status = 'enviada')
              and p.pronto_em > rt.vence_em as ok
         from public.retornos_prontos() p join public.retornos rt on rt.id = p.retorno_id
        where p.retorno_id = $1`,
        [lb.id, c.rodada],
      );
      t.igual(ok, true, "pronto_em = a saída da pergunta + 3 h, depois da hora do lembrete");
    });

    // O ajuste mudado com o lembrete já pendente: ele conta as horas com que foi armado
    // (retornos.lembrete_horas), nos dois sentidos. Antes, subir o ajuste em 3 h ou mais deixava o
    // pendente sem nunca ficar pronto, e a varredura E o fechava em silêncio no prazo.
    it("o lembrete pendente conta as horas de quando foi armado", async () => {
      const b = await preparar(t);
      // (a) armado com o ajuste padrão de 3 h; o ajuste sobe para 8 h depois
      const c = await atendida(t, b, tel(1), { ferramentas: [responder("sim")] });
      const [lb] = await retornosDa(t, c.conversa);
      t.igual([lb?.tipo, lb?.status], ["lembrete", "pendente"], "o lembrete armado");
      const horasDe = async (id: string) =>
        (await t.sql("select lembrete_horas as h from public.retornos where id = $1", [id]))[0]
          .h as number | null;
      t.igual(await horasDe(lb.id), 3, "guarda as horas do ajuste de quando foi armado");
      await vencerRetorno(t, lb.id);
      await t.sql("update public.configuracao set lembrete_horas = 8 where id = 1");
      t.ok(
        (await prontos(t)).some((p: Linha) => p.retorno_id === lb.id),
        "pronto: as 3 h de quando foi armado",
      );
      const [rd] = (await pegar(t)).filter((r: Linha) => r.conversa_id === c.conversa);
      t.igual(rd?.retorno_id, lb.id, "a faixa 2 o leva");
      await varrer(t);
      t.igual(
        await estado(t, lb.id),
        ["em_rodada", null],
        "a varredura não o fecha (não fica nao_enviado)",
      );
      await concluir(t, rd.id, ["Oi! Conseguiu ver?"], [responder("nao")]);
      await enviarTudo(t);
      t.igual(await estado(t, lb.id), ["enviado", null], "enviado");
      // (b) armado com 8 h; o ajuste desce para 3 h depois: a pergunta que saiu há 3 h 1 min ainda
      // não é cobrada (o ajuste novo só vale para o lembrete armado depois dele)
      const c2 = await atendida(t, b, tel(2), { ferramentas: [responder("sim")] });
      const [lb2] = await retornosDa(t, c2.conversa);
      t.igual(await horasDe(lb2.id), 8, "armado com 8 h");
      await t.sql("update public.configuracao set lembrete_horas = 3 where id = 1");
      await t.sql(
        "update public.retornos set vence_em = now() - interval '1 minute', expira_em = now() + interval '6 hours' where id = $1",
        [lb2.id],
      );
      await t.sql(
        "update public.mensagens set momento = now() - interval '3 hours 1 minute' where rodada_id = $1 and direcao = 'saida' and status = 'enviada'",
        [c2.rodada],
      );
      t.igual(
        (await prontos(t)).some((p: Linha) => p.retorno_id === lb2.id),
        false,
        "3 h depois da pergunta: ainda não",
      );
      await t.sql(
        "update public.mensagens set momento = now() - interval '8 hours 1 minute' where rodada_id = $1 and direcao = 'saida' and status = 'enviada'",
        [c2.rodada],
      );
      t.ok(
        (await prontos(t)).some((p: Linha) => p.retorno_id === lb2.id),
        "8 h depois da pergunta: pronto",
      );
      // o lembrete armado depois da mudança segue o ajuste novo
      const c3 = await atendida(t, b, tel(3), { ferramentas: [responder("sim")] });
      const [lb3] = await retornosDa(t, c3.conversa);
      t.igual(await horasDe(lb3.id), 3, "o armado depois da mudança: 3 h");
    });

    it("o lembrete pendente conta as horas de quando foi armado: com o prazo a 1 min e o ajuste subido para 8 h, fica pronto antes do prazo e sai (não fecha como passou_do_prazo)", async () => {
      const b = await preparar(t);
      const c = await atendida(t, b, tel(1), { ferramentas: [responder("sim")] });
      const [lb] = await retornosDa(t, c.conversa);
      await vencerRetorno(t, lb.id);
      await t.sql(
        "update public.retornos set expira_em = now() + interval '1 minute' where id = $1",
        [lb.id],
      );
      await t.sql("update public.configuracao set lembrete_horas = 8 where id = 1");
      const p = (await prontos(t)).find((x: Linha) => x.retorno_id === lb.id);
      t.ok(p, "pronto antes do prazo");
      t.ok(
        (ms(p?.pronto_em) ?? Infinity) < (ms((await retorno(t, lb.id)).expira_em) ?? -Infinity),
        "pronto_em antes do expira_em",
      );
      await varrer(t);
      t.igual(await estado(t, lb.id), ["pendente", null], "a varredura não o fecha");
      const [rd] = (await pegar(t)).filter((r: Linha) => r.conversa_id === c.conversa);
      t.igual(rd?.retorno_id, lb.id, "a faixa 2 o leva antes do prazo");
      await concluir(t, rd.id, ["Oi! Conseguiu ver?"], [responder("nao")]);
      await enviarTudo(t);
      t.igual(
        await estado(t, lb.id),
        ["enviado", null],
        "enviado, e não nao_enviado/passou_do_prazo",
      );
    });

    it("caso 16: o lead responde antes: o lembrete some (prontos, varredura e fim da rodada; também com o servidor antigo)", async () => {
      const b = await preparar(t);
      // (a) pela varredura, perto da hora
      const c1 = await atendida(t, b, tel(1), { ferramentas: [responder("sim")] });
      const [lb1] = await retornosDa(t, c1.conversa);
      await entrada(t, b.cx, tel(1), { texto: "oi, vi agora" });
      await vencerRetorno(t, lb1.id);
      t.igual(await prontos(t), [], "não está pronto");
      await varrer(t);
      t.igual(await retorno(t, lb1.id), undefined, "apagado pela varredura");
      // (b) pela rodada do lead (longe da hora)
      const c2 = await atendida(t, b, tel(2), { ferramentas: [responder("sim")] });
      const [lb2] = await retornosDa(t, c2.conversa);
      const r2 = await rodadaDoLead(t, b, tel(2));
      t.igual(r2.rodada.retorno_id, null, "o lembrete nunca vai junto");
      t.ok(await retorno(t, lb2.id), "ainda está lá, longe da hora");
      await concluir(t, r2.rodada.id, ["Que bom!"], [responder("nao")]);
      t.igual(await retorno(t, lb2.id), undefined, "apagado no fim da rodada do lead");
      // (c) com o servidor antigo (pegar_rodadas e concluir sem espera_resposta)
      const c3 = await atendida(t, b, tel(3), { ferramentas: [responder("sim")] });
      const [lb3] = await retornosDa(t, c3.conversa);
      await entrada(t, b.cx, tel(3));
      await vencer(t, c3.conversa);
      const [r3] = await pegarAntiga(t);
      await concluir(t, r3.id, ["Oi!"]);
      t.igual(await retorno(t, lb3.id), undefined, "apagado também com o servidor antigo");
    });

    it("caso 17: depois do lembrete, nada até o lead escrever; respondeu e sumiu de novo → 1 lembrete novo", async () => {
      const b = await preparar(t);
      const c = await atendida(t, b, tel(1), { ferramentas: [responder("sim")] });
      const [lb] = await retornosDa(t, c.conversa);
      await vencerRetorno(t, lb.id);
      const [pura] = await pegar(t);
      await concluir(t, pura.id, ["Oi! Conseguiu ver?"], [responder("sim")]);
      await enviarTudo(t);
      t.igual(await estado(t, lb.id), ["enviado", null]);
      // uma rodada sem fala do lead (uma nova tentativa, uma devolução) não arma outro no mesmo silêncio
      await vencer(t, c.conversa);
      const [rd] = (await pegar(t)).filter((x: Linha) => x.conversa_id === c.conversa);
      await concluir(t, rd.id, ["Estou por aqui."], [responder("sim")]);
      await enviarTudo(t);
      t.igual(
        await contar(
          t,
          "select 1 from public.retornos where conversa_id = $1 and status = 'pendente'",
          [c.conversa],
        ),
        0,
      );
      // o lead escreve dias depois e some de novo: 1 lembrete novo
      const r2 = await rodadaDoLead(t, b, tel(1));
      await concluir(t, r2.rodada.id, ["E aí, fechamos?"], [responder("sim")]);
      t.igual(
        (await retornosDa(t, c.conversa)).map((l: Linha) => [l.tipo, l.status]),
        [
          ["lembrete", "enviado"],
          ["lembrete", "pendente"],
        ],
      );
    });

    it("caso 17 (B8): o lembrete cancelado pela equipe não volta no mesmo silêncio", async () => {
      const b = await preparar(t);
      const c = await atendida(t, b, tel(1), { ferramentas: [responder("sim")] });
      const [lb] = await retornosDa(t, c.conversa);
      await equipeCancela(t, b.uAtend, lb.id);
      await vencer(t, c.conversa);
      const [rd] = (await pegar(t)).filter((x: Linha) => x.conversa_id === c.conversa);
      await concluir(t, rd.id, ["Estou por aqui."], [responder("sim")]);
      t.igual(
        await contar(
          t,
          "select 1 from public.retornos where conversa_id = $1 and status = 'pendente'",
          [c.conversa],
        ),
        0,
      );
      await enviarTudo(t);
      const r2 = await rodadaDoLead(t, b, tel(1));
      await concluir(t, r2.rodada.id, ["E aí?"], [responder("sim")]);
      t.igual(
        await contar(
          t,
          "select 1 from public.retornos where conversa_id = $1 and status = 'pendente'",
          [c.conversa],
        ),
        1,
      );
    });

    it("caso 17 (B8): o cancelado pela equipe continua contando depois de o membro que cancelou ser apagado", async () => {
      const b = await preparar(t);
      const c = await atendida(t, b, tel(1), { ferramentas: [responder("sim")] });
      const [lb] = await retornosDa(t, c.conversa);
      await equipeCancela(t, b.uAtend, lb.id);
      await t.sql("delete from public.membros where id = $1", [b.mAtend]);
      t.igual(
        [(await retorno(t, lb.id)).status, (await retorno(t, lb.id)).cancelado_por],
        ["cancelado", null],
        "on delete set null",
      );
      await vencer(t, c.conversa);
      const [rd] = (await pegar(t)).filter((x: Linha) => x.conversa_id === c.conversa);
      await concluir(t, rd.id, ["Estou por aqui."], [responder("sim")]);
      t.igual(
        await contar(
          t,
          "select 1 from public.retornos where conversa_id = $1 and status = 'pendente'",
          [c.conversa],
        ),
        0,
        "não volta no mesmo silêncio",
      );
    });

    it("caso 18: na oficial, o prazo do lembrete respeita as 24 h; a 5 min do fim da janela, não arma", async () => {
      const b = await preparar(t, { gateway: "meta" });
      const e = await entrada(t, b.cx, tel(1), {
        momento: new Date(Date.now() - (23 * HORA + 55 * MIN)).toISOString(),
      });
      await vencer(t, e.conversa_id);
      const [rd] = await pegar(t);
      await concluir(t, rd.id, ["Pode me confirmar?"], [responder("sim")]);
      t.igual(await contar(t, "select 1 from public.retornos"), 0, "não arma");
      // O fim da janela (ultima_do_lead_em + 23 h 50) posto em relação à hora do lembrete que o concluir
      // vai calcular (v), a qualquer hora em que a suíte rode: 1 h depois de v (arma, com o prazo
      // cortado pela janela) ou 1 min antes de v (não arma). A hora é medida antes e depois do
      // concluir: a função só salta às 20:00 e às 08:00, e o salto nesse intervalo de milissegundos
      // é o único caso em que o teste não decide.
      const comFimDaJanela = async (n: number, relativoAV: number) => {
        const e2 = await entrada(t, b.cx, tel(n), {
          momento: new Date(Date.now() - 20 * HORA).toISOString(),
        });
        await vencer(t, e2.conversa_id);
        const [rd2] = (await pegar(t)).filter((x: Linha) => x.conversa_id === e2.conversa_id);
        const hora = async () =>
          ms(
            (
              await t.sql("select public.lembrete_vence_em(now(), 3, $1::uuid) as v", [
                e2.conversa_id,
              ])
            )[0].v,
          )!;
        const v = await hora();
        await t.sql(
          "update public.conversas set ultima_do_lead_em = $2::timestamptz - interval '23 hours 50 minutes' where id = $1",
          [e2.conversa_id, new Date(v + relativoAV).toISOString()],
        );
        await concluir(t, rd2.id, ["Pode me confirmar?"], [responder("sim")]);
        const depois = await hora();
        return {
          linhas: await retornosDa(t, e2.conversa_id),
          semSalto: depois >= v && depois - v < 60_000,
          limite: v + relativoAV,
        };
      };
      const arma = await comFimDaJanela(2, HORA);
      if (arma.semSalto) {
        t.igual(arma.linhas.length, 1, "o fim da janela 1 h depois da hora: arma");
        const [{ e }] = await t.sql(
          `select rt.expira_em = least(public.lembrete_expira_em(rt.vence_em), c.ultima_do_lead_em + interval '23 hours 50 minutes') as e
           from public.retornos rt join public.conversas c on c.id = rt.conversa_id where rt.id = $1`,
          [arma.linhas[0].id],
        );
        t.igual(e, true, "expira_em cortado pela janela");
        t.ok(ms(arma.linhas[0].expira_em)! <= arma.limite, "o prazo nunca passa do fim da janela");
      }
      const naoArma = await comFimDaJanela(3, -MIN);
      if (naoArma.semSalto)
        t.igual(naoArma.linhas.length, 0, "o fim da janela 1 min antes da hora: não arma");
    });

    it("caso 19: não arma (espera ausente ou 'nao', resposta recusada, retorno pendente, Ganho, Perdido, equipe, desligado, sem bolha, cancelada, lead escrevendo)", async () => {
      const b = await preparar(t);
      const semLembrete = async (nome: string, conversa: string) =>
        t.igual(
          await contar(
            t,
            "select 1 from public.retornos where conversa_id = $1 and tipo = 'lembrete'",
            [conversa],
          ),
          0,
          nome,
        );
      let n = 0;
      const caso = async (
        nome: string,
        antes: (r: { conversa: string; rodada: Linha }) => Promise<void>,
        textos: string[],
        ferramentas: unknown[],
      ) => {
        n += 1;
        const r = await rodadaDoLead(t, b, tel(n));
        await antes(r);
        await concluir(t, r.rodada.id, textos, ferramentas);
        await semLembrete(nome, r.conversa);
      };
      const nada = async () => {};
      await caso("espera ausente (servidor antigo)", nada, ["Oi"], [responder()]);
      await caso("espera 'nao'", nada, ["Oi"], [responder("nao")]);
      await caso("responder recusado (retorno_recusado)", nada, ["Oi"], [responder("sim", false)]);
      await caso(
        "o último responder é 'nao'",
        nada,
        ["Oi"],
        [responder("sim", true, 1), responder("nao", true, 2)],
      );
      await caso("sem bolha", nada, [], [responder("sim")]);
      await caso(
        "retorno combinado marcado",
        async (r) => {
          const q = await amanha(t);
          t.igual((await marcar(t, r.rodada.id, q.data, q.hora)).ok, true);
        },
        ["Combinado"],
        [responder("sim")],
      );
      for (const etapa of ["ganho", "perdido"]) {
        await caso(
          `etapa ${etapa}`,
          async (r) => {
            await t.sql(
              "update public.contatos set etapa_id = $1 where id = (select contato_id from public.conversas where id = $2)",
              [b.etapas[etapa], r.conversa],
            );
          },
          ["Obrigada, tchau"],
          [responder("sim")],
        );
      }
      await caso(
        "a Nina passou para a equipe",
        async (r) => {
          await servidor(t, "select public.nina_passar_para_humano($1)", [r.rodada.id]);
        },
        ["Vou passar para a equipe"],
        [responder("sim")],
      );
      await caso(
        "a equipe assumiu (rodada cancelada)",
        async (r) => {
          await assumir(t, b.uAtend, r.conversa);
        },
        ["Oi"],
        [responder("sim")],
      );
      await t.sql("update public.configuracao set lembrete_ligado = false where id = 1");
      await caso("lembrete desligado", nada, ["Oi"], [responder("sim")]);
      await t.sql("update public.configuracao set lembrete_ligado = true where id = 1");
      await caso(
        "o lead escreveu durante a rodada (responder_apos armado)",
        async () => {
          await entrada(t, b.cx, tel(n));
        },
        ["Oi"],
        [responder("sim")],
      );
    });

    it("caso 20: desligado com o lembrete pendente: não fica pronto, não toca e a varredura apaga (mesmo longe da hora)", async () => {
      const b = await preparar(t);
      const c1 = await atendida(t, b, tel(1), { ferramentas: [responder("sim")] });
      const c2 = await atendida(t, b, tel(2), { ferramentas: [responder("sim")] });
      const [lb1] = await retornosDa(t, c1.conversa);
      const [lb2] = await retornosDa(t, c2.conversa);
      await vencerRetorno(t, lb1.id);
      t.igual(
        (await prontos(t)).map((p: Linha) => p.retorno_id),
        [lb1.id],
        "ligado: pronto",
      );
      await t.sql("update public.configuracao set lembrete_ligado = false where id = 1");
      t.igual(await prontos(t), [], "desligado: nada pronto");
      t.igual(await pegar(t), [], "ninguém pega");
      t.igual(await retorno(t, lb1.id), undefined, "o vencido foi apagado pela varredura da irmã");
      await varrer(t);
      t.igual(await retorno(t, lb2.id), undefined, "o longe da hora também");
    });

    it("caso 19 (depois de armar): o lead vai para Ganho ou Perdido com o lembrete pendente: perto da hora some e não sai; longe da hora espera, e se o cartão voltar a uma etapa aberta ele sai", async () => {
      const b = await preparar(t);
      const moverPara = (conversa: string, chave: string) =>
        t.sql(
          "update public.contatos set etapa_id = $1 where id = (select contato_id from public.conversas where id = $2)",
          [b.etapas[chave], conversa],
        );
      // (a) Ganho e Perdido, perto da hora: barrado nos prontos (antes de varrer) e apagado pela
      // varredura da irmã (D)
      let n = 0;
      for (const etapa of ["ganho", "perdido"]) {
        n += 1;
        const c = await atendida(t, b, tel(n), { ferramentas: [responder("sim")] });
        const [lb] = await retornosDa(t, c.conversa);
        t.igual(
          [lb?.tipo, lb?.status],
          ["lembrete", "pendente"],
          `${etapa}: armado com a etapa aberta`,
        );
        await moverPara(c.conversa, etapa);
        await vencerRetorno(t, lb.id);
        t.igual(await prontos(t), [], `${etapa}: não está pronto`);
        t.igual(await pegar(t), [], `${etapa}: ninguém pega`);
        t.igual(await retorno(t, lb.id), undefined, `${etapa}: apagado pela varredura`);
      }
      // (b) contraprova, longe da hora: a varredura não apaga e os prontos não listam
      const c3 = await atendida(t, b, tel(3), { ferramentas: [responder("sim")] });
      const [lb3] = await retornosDa(t, c3.conversa);
      await moverPara(c3.conversa, "ganho");
      await t.sql(
        "update public.retornos set vence_em = now() + interval '2 hours', expira_em = now() + interval '5 hours' where id = $1",
        [lb3.id],
      );
      await varrer(t);
      t.ok(await retorno(t, lb3.id), "longe da hora: continua pendente");
      t.igual(await prontos(t), [], "longe da hora: não está pronto");
      // (c) a equipe volta o cartão para uma etapa aberta antes da hora: o lembrete vale de novo
      await moverPara(c3.conversa, "novo");
      await vencerRetorno(t, lb3.id);
      t.igual(
        (await prontos(t)).map((p: Linha) => p.retorno_id),
        [lb3.id],
        "de volta a uma etapa aberta: pronto",
      );
    });

    it("A5: lembrete armado, a equipe assume e devolve: ele some e não sai", async () => {
      const b = await preparar(t);
      const c = await atendida(t, b, tel(1), { ferramentas: [responder("sim")] });
      const [lb] = await retornosDa(t, c.conversa);
      await assumir(t, b.uAtend, c.conversa);
      await devolver(t, b.uAtend, c.conversa);
      await vencerRetorno(t, lb.id);
      t.igual(await prontos(t), [], "não está pronto");
      t.igual(await pegar(t), [], "não sai");
      t.igual(await retorno(t, lb.id), undefined, "apagado");
    });

    it("A5: o lembrete longe da hora também some na varredura, sem esperar a hora", async () => {
      const b = await preparar(t);
      const c = await atendida(t, b, tel(1), { ferramentas: [responder("sim")] });
      const [lb] = await retornosDa(t, c.conversa);
      await assumir(t, b.uAtend, c.conversa);
      await devolver(t, b.uAtend, c.conversa);
      await varrer(t);
      t.igual(await retorno(t, lb.id), undefined, "apagado");
    });

    it("a pergunta que armou o lembrete foi cancelada pelo Desconectar ou pelo Trocar de WhatsApp: ele não fica pronto e a varredura o apaga, sem esperar a hora", async () => {
      const b = await preparar(t);
      // a rodada comum pergunta e a bolha fica na fila
      const c = await atendida(t, b, tel(1), { ferramentas: [responder("sim")], enviar: false });
      const [lb] = await retornosDa(t, c.conversa);
      t.igual(
        [lb.tipo, lb.status, lb.rodada_origem_id],
        ["lembrete", "pendente", c.rodada],
        "o lembrete armado",
      );
      // como o servidor faz (configuracao/banco.server.ts, cancelarBolhasDaNinaNaFila)
      await t.sql(
        `update public.mensagens set status = 'cancelada', status_em = now()
        where conexao_id = $1 and direcao = 'saida' and origem = 'nina' and status = 'na_fila'`,
        [b.cx],
      );
      t.igual(await saidasDa(t, c.rodada), 1, "a pergunta continua gravada, cancelada");
      // com a conexão ativa e a hora vencida, antes da varredura: não fica pronto
      await vencerRetorno(t, lb.id);
      t.igual(
        (await prontos(t)).some((p: Linha) => p.retorno_id === lb.id),
        false,
        "a pergunta que o lead nunca recebeu não é cobrada",
      );
      // longe da hora, a varredura o apaga, passada a janela do eco duplicado (2 min)
      await t.sql(
        "update public.retornos set vence_em = now() + interval '2 hours', expira_em = now() + interval '3 hours' where id = $1",
        [lb.id],
      );
      await varrer(t);
      t.igual(
        await estado(t, lb.id),
        ["pendente", null],
        "cancelada há menos de 2 min (o eco duplicado ainda pode devolvê-la): fica",
      );
      await t.sql(
        "update public.mensagens set status_em = now() - interval '3 minutes' where rodada_id = $1 and status = 'cancelada'",
        [c.rodada],
      );
      await varrer(t);
      t.igual(await retorno(t, lb.id), undefined, "apagado, sem esperar a hora");
      // o eco duplicado: a pergunta cancelada pelo eco volta à fila em menos de 1 min; o lembrete fica
      const c3 = await atendida(t, b, tel(3), { ferramentas: [responder("sim")], enviar: false });
      const [lb3] = await retornosDa(t, c3.conversa);
      await t.sql(
        "update public.mensagens set status = 'cancelada', status_em = now() where rodada_id = $1 and direcao = 'saida'",
        [c3.rodada],
      );
      await varrer(t);
      t.igual(await estado(t, lb3.id), ["pendente", null], "a varredura espera a janela do eco");
      await t.sql(
        "update public.mensagens set status = 'na_fila', status_em = now() where rodada_id = $1 and direcao = 'saida'",
        [c3.rodada],
      );
      await enviarTudo(t);
      await vencerRetorno(t, lb3.id);
      await varrer(t);
      t.igual(await estado(t, lb3.id), ["pendente", null], "a pergunta saiu: o lembrete continua");
      t.ok(
        (await prontos(t)).some((p: Linha) => p.retorno_id === lb3.id),
        "e fica pronto na hora",
      );
      // contraprova: com a pergunta enviada, o lembrete fica e, na hora, fica pronto
      const c2 = await atendida(t, b, tel(2), { ferramentas: [responder("sim")] });
      const [lb2] = await retornosDa(t, c2.conversa);
      t.igual(
        await contar(
          t,
          "select 1 from public.mensagens where rodada_id = $1 and status = 'enviada'",
          [c2.rodada],
        ),
        1,
        "a pergunta saiu",
      );
      await vencerRetorno(t, lb2.id);
      await varrer(t);
      t.igual(await estado(t, lb2.id), ["pendente", null], "a varredura não o apaga");
      t.ok(
        (await prontos(t)).some((p: Linha) => p.retorno_id === lb2.id),
        "pronto",
      );
    });

    it("a entrada solta de antes da rodada que armou o lembrete não o prende; a que chega depois, sim", async () => {
      const b = await preparar(t);
      // Com a equipe, o lead escreve (a entrada fica solta) e a equipe responde depois; a devolução não
      // arma (a última saída é mais nova). O retorno vencido sai pela rodada pura, que arma o lembrete.
      const armar = async (n: number) => {
        const c = await atendida(t, b, tel(n));
        await assumir(t, b.uAtend, c.conversa);
        const e = await entrada(t, b.cx, tel(n), { texto: "vi agora" });
        await t.sql(
          `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, texto, status)
         values ($1, $2, 'saida', 'humano_celular', 'Já te respondo', 'enviada')`,
          [c.conversa, b.cx],
        );
        await devolver(t, b.uAtend, c.conversa);
        t.igual((await conversaDe(t, c.conversa)).responder_apos, null, "a devolução não armou");
        const [{ rodada_id }] = await t.sql(
          "select rodada_id from public.mensagens where id = $1",
          [e.mensagem_id],
        );
        t.igual(rodada_id, null, "a entrada continua solta");
        const rt = await inserir(t, c.conversa);
        const [pura] = (await pegar(t)).filter((r: Linha) => r.conversa_id === c.conversa);
        t.igual(pura?.retorno_id, rt, "a rodada pura do retorno");
        await concluir(
          t,
          pura.id,
          ["Oi! Como combinamos, te mando a proposta?"],
          [responder("sim")],
        );
        await enviarTudo(t);
        t.igual(await estado(t, rt), ["enviado", null]);
        const lb = (await retornosDa(t, c.conversa)).find((l: Linha) => l.tipo === "lembrete");
        t.ok(lb, "a rodada pura armou o lembrete");
        t.igual([lb.status, lb.rodada_origem_id], ["pendente", pura.id]);
        await vencerRetorno(t, lb.id);
        return { conversa: c.conversa, lembrete: lb.id as string };
      };
      const l1 = await armar(1);
      t.igual(
        (await prontos(t)).map((p: Linha) => p.retorno_id),
        [l1.lembrete],
        "a solta mais velha não prende",
      );
      const [rd] = (await pegar(t)).filter((r: Linha) => r.conversa_id === l1.conversa);
      t.igual(rd?.retorno_id, l1.lembrete, "a faixa 2 cria a rodada do lembrete");
      // e o fim da rodada do lembrete usa a mesma âncora: a solta de antes da rodada de origem não
      // descarta a bolha (a âncora presa dos dois lados, com o caso (b) da convivência com a permissão)
      const [solta] = await t.sql(
        `select e.rodada_id, e.criado_em < ro.iniciada_em as antes
         from public.mensagens e, public.retornos rt, public.rodadas ro
        where e.conversa_id = $1 and e.direcao = 'entrada' and e.texto = 'vi agora'
          and rt.id = $2 and ro.id = rt.rodada_origem_id`,
        [l1.conversa, l1.lembrete],
      );
      t.igual(
        [solta?.rodada_id, solta?.antes],
        [null, true],
        "a entrada 'vi agora' continua solta e é de antes da pura de origem",
      );
      await concluir(t, rd.id, ["Oi! Conseguiu ver?"], [responder("nao")]);
      t.igual(await saidasDa(t, rd.id), 1, "a solta de antes da âncora não descarta o lembrete");
      t.igual(await estado(t, l1.lembrete), ["saindo", null], "saindo");
      await enviarTudo(t);
      t.igual(await estado(t, l1.lembrete), ["enviado", null], "enviado");
      // contraprova: uma entrada solta nova, que não arma a conversa (como a da ligação que não arma)
      // e não muda a última do lead (momento antigo): só ela prende o lembrete
      const l2 = await armar(2);
      t.ok(
        (await prontos(t)).some((p: Linha) => p.retorno_id === l2.lembrete),
        "pronto antes da entrada",
      );
      const { ultima_do_lead_em: ultima } = await conversaDe(t, l2.conversa);
      await entrada(t, b.cx, tel(2), { momento: new Date(Date.now() - 2 * HORA).toISOString() });
      await t.sql("update public.conversas set responder_apos = null where id = $1", [l2.conversa]);
      t.igual(
        ms((await conversaDe(t, l2.conversa)).ultima_do_lead_em),
        ms(ultima),
        "a última do lead não mudou",
      );
      t.igual(
        (await prontos(t)).some((p: Linha) => p.retorno_id === l2.lembrete),
        false,
        "a entrada solta depois do começo da rodada prende o lembrete",
      );
    });

    it("I2: retorno aberto e lembrete pendente não convivem (a varredura apaga o que sobrar)", async () => {
      const b = await preparar(t);
      const c = await atendida(t, b, tel(1));
      const lb = await inserir(t, c.conversa, { tipo: "lembrete" });
      await inserir(t, c.conversa, {
        vence: "now() + interval '1 hour'",
        expira: "now() + interval '4 hours'",
      });
      t.igual(await prontos(t), [], "o lembrete não fica pronto com retorno aberto");
      await varrer(t);
      t.igual(await retorno(t, lb), undefined, "apagado");
    });

    /** Uma conversa atendida com um lembrete vencido, já numa rodada de lembrete (faixa 2). */
    async function rodadaDeLembrete(b: Preparo, n: number) {
      const cl = await atendida(t, b, tel(n));
      const lb = await inserir(t, cl.conversa, { tipo: "lembrete" });
      const rs = (await pegar(t)).filter((r: Linha) => r.conversa_id === cl.conversa);
      t.igual(rs[0]?.retorno_id, lb, `lembrete ${n}: a faixa 2 pega`);
      return { conversa: cl.conversa, lembrete: lb, rodada: rs[0]!.id as string };
    }

    it("os desfechos do lembrete no fim da rodada e na varredura F (cancelada, sem conexão, sem IA, sem resposta, órfão)", async () => {
      const b = await preparar(t);
      // 1. a equipe assume durante a rodada: cancelada → com_equipe
      const r1 = await rodadaDeLembrete(b, 1);
      await assumir(t, b.uAtend, r1.conversa);
      await concluir(t, r1.rodada, ["Oi! Conseguiu ver?"], [responder("nao")]);
      t.igual(await estado(t, r1.lembrete), ["nao_enviado", "com_equipe"], "cancelada");
      // 2. a conexão desligada antes do concluir: sem_conexao_ativa no insert não sobe → desconectado
      const r2 = await rodadaDeLembrete(b, 2);
      await t.sql("update public.conexoes set ativa = false where id = $1", [b.cx]);
      await concluir(t, r2.rodada, ["Oi! Conseguiu ver?"], [responder("nao")]);
      t.igual(
        await estado(t, r2.lembrete),
        ["nao_enviado", "desconectado"],
        "sem conexão no insert",
      );
      t.igual(await saidasDa(t, r2.rodada), 0, "nenhuma bolha");
      await t.sql("update public.conexoes set ativa = true where id = $1", [b.cx]);
      // 3. sem IA (p_passos = 0): a Nina não conseguiu
      const r3 = await rodadaDeLembrete(b, 3);
      await concluir(t, r3.rodada, [], [], 0);
      t.igual(await estado(t, r3.lembrete), ["nao_enviado", "nina_falhou"], "sem IA");
      // 4. a IA leu e não escreveu (sem_resposta aceito): dispensado, sem nota (só o retorno guarda o porquê)
      const r4 = await rodadaDeLembrete(b, 4);
      await concluir(t, r4.rodada, [], [semResposta("já respondeu por e-mail")], 1);
      t.igual(await estado(t, r4.lembrete), ["dispensado", null], "sem resposta");
      t.igual(
        (await retorno(t, r4.lembrete)).nota_fim,
        null,
        "o lembrete dispensado não guarda o porquê",
      );
      // 5. órfão: a equipe assumiu e ninguém concluiu → com_equipe pela varredura F
      const r5 = await rodadaDeLembrete(b, 5);
      await assumir(t, b.uAtend, r5.conversa);
      await varrer(t);
      t.igual(await estado(t, r5.lembrete), ["nao_enviado", "com_equipe"], "órfão fora da Nina");
      // 6. órfão concluído por fora, com IA e sem bolha → dispensado pela varredura F
      const r6 = await rodadaDeLembrete(b, 6);
      await t.sql(
        "update public.rodadas set status = 'concluida', passos = 1, terminada_em = now() where id = $1",
        [r6.rodada],
      );
      await varrer(t);
      t.igual(
        await estado(t, r6.lembrete),
        ["dispensado", null],
        "órfão concluído pela IA sem bolha",
      );
      // 7. órfão de uma rodada que falhou sem passar pela retorno_ao_falhar (o erro dela engolido),
      // com a conversa ainda com a Nina → a Nina não conseguiu, pela varredura F
      const r7 = await rodadaDeLembrete(b, 7);
      await t.sql(
        "update public.rodadas set status = 'falhou', terminada_em = now() where id = $1",
        [r7.rodada],
      );
      await varrer(t);
      t.igual(
        await estado(t, r7.lembrete),
        ["nao_enviado", "nina_falhou"],
        "órfão de rodada que falhou",
      );
    });

    it("o desfecho do lembrete na oficial: a janela fecha durante a rodada (janela_fechada no insert) → fora_24h", async () => {
      const b = await preparar(t, { gateway: "meta" });
      const r = await rodadaDeLembrete(b, 1);
      await t.sql(
        "update public.conversas set ultima_do_lead_em = now() - interval '25 hours' where id = $1",
        [r.conversa],
      );
      await concluir(t, r.rodada, ["Oi! Conseguiu ver?"], [responder("nao")]);
      t.igual(await estado(t, r.lembrete), ["nao_enviado", "fora_24h"]);
      t.igual(
        (await conversaDe(t, r.conversa)).modo,
        "nina",
        "a conversa não vai para a equipe por isso",
      );
    });

    it("varredura F, a rodada concluída por fora sem bolha: a pura do retorno (sem fala do lead) é dispensada; a mista (com fala) volta a pendente; o lembrete sem IA (passos = 0), a Nina não conseguiu", async () => {
      const b = await preparar(t);
      const [c1, c2, c3] = [
        (await atendida(t, b, tel(1))).conversa,
        (await atendida(t, b, tel(2))).conversa,
        (await atendida(t, b, tel(3))).conversa,
      ];
      const r1 = await inserir(t, c1);
      const r2 = await inserir(t, c2, { marcado: "now() - interval '1 day'" });
      const l3 = await inserir(t, c3, { tipo: "lembrete" });
      await entrada(t, b.cx, tel(2), { texto: "ok" });
      await vencer(t, c2);
      const rs = await pegar(t, 3, 3);
      const de = (c: string) => rs.find((r: Linha) => r.conversa_id === c) as Linha;
      t.igual(
        [de(c1)?.retorno_id, de(c2)?.retorno_id, de(c3)?.retorno_id],
        [r1, r2, l3],
        "a pura, a mista e a do lembrete",
      );
      // as três concluídas por fora, sem bolha (o fim da rodada não passou pela retorno_ao_concluir)
      for (const [c, passos] of [
        [c1, 1],
        [c2, 1],
        [c3, 0],
      ] as const)
        await t.sql(
          "update public.rodadas set status = 'concluida', passos = $2, terminada_em = now() where id = $1",
          [de(c).id, passos],
        );
      await varrer(t);
      t.igual(await estado(t, r1), ["dispensado", null], "a pura sem fala: dispensado");
      const x2 = await retorno(t, r2);
      t.igual([x2.status, x2.rodada_id], ["pendente", null], "a mista com fala: volta");
      t.igual(
        await estado(t, l3),
        ["nao_enviado", "nina_falhou"],
        "o lembrete sem IA: a Nina não conseguiu",
      );
    });

    it("varredura D: com a conversa com a equipe (assumida, sem devolver), o lembrete espera longe da hora e some perto dela", async () => {
      const b = await preparar(t);
      const c = await atendida(t, b, tel(1), { ferramentas: [responder("sim")] });
      const [lb] = await retornosDa(t, c.conversa);
      t.igual([lb?.tipo, lb?.status], ["lembrete", "pendente"], "o lembrete armado");
      await assumir(t, b.uAtend, c.conversa);
      await varrer(t);
      t.igual(await estado(t, lb.id), ["pendente", null], "longe da hora, espera");
      await vencerRetorno(t, lb.id);
      t.igual(await prontos(t), [], "com a equipe, não fica pronto");
      await varrer(t);
      t.igual(await retorno(t, lb.id), undefined, "perto da hora, apagado");
    });
  },
);

describe.skipIf(!temFluxo)(
  "banco: retornos, o gatilho das bolhas",
  { timeout: TEMPO_TESTE },
  () => {
    const t = usarBanco(base);

    /** Um retorno saindo: a rodada pura concluiu com uma bolha na fila. */
    async function saindo(b: Preparo, n: number, tipo = "retorno") {
      const c = await atendida(t, b, tel(n));
      const rt = await inserir(t, c.conversa, { tipo });
      const [pura] = await pegar(t);
      await concluir(t, pura.id, ["Oi! Como combinamos..."], [responder("nao")]);
      t.igual(await estado(t, rt), ["saindo", null]);
      const [{ id: bolha }] = await t.sql(
        "select id from public.mensagens where rodada_id = $1 and direcao = 'saida'",
        [pura.id],
      );
      await t.sql(
        "update public.mensagens set enviar_apos = now() - interval '1 second' where id = $1",
        [bolha],
      );
      return { ...c, retorno: rt, pura: pura.id as string, bolha: bolha as string };
    }

    it("D7: a bolha recusada pelo WhatsApp: envio_recusado, e a conversa vai para a equipe pela regra de hoje", async () => {
      const b = await preparar(t);
      const s = await saindo(b, 1);
      const env = await servidor(t, "select id from public.pegar_envios(10)");
      t.ok(
        env.some((e: Linha) => e.id === s.bolha),
        "pega a bolha",
      );
      t.igual(await estado(t, s.retorno), ["saindo", null], "enviando não muda nada");
      await servidor(t, "select public.falhar_envio($1, 'numero_invalido', true)", [s.bolha]);
      t.igual(await estado(t, s.retorno), ["nao_enviado", "envio_recusado"]);
      t.igual((await conversaDe(t, s.conversa)).modo, "humano", "regra de hoje");
    });

    it("o retorno enviado volta a não enviado (envio_recusado) quando o gateway avisa depois que a entrega falhou (atualizar_status 'falhou')", async () => {
      const b = await preparar(t);
      const s = await saindo(b, 1);
      await enviarTudo(t);
      t.igual(await estado(t, s.retorno), ["enviado", null], "a bolha saiu");
      const [{ id_externo }] = await t.sql(
        "select id_externo from public.mensagens where id = $1",
        [s.bolha],
      );
      const [{ n }] = await servidor(
        t,
        "select public.atualizar_status($1, $2, 'falhou', now()) as n",
        [b.cx, id_externo],
      );
      t.igual(n, 1, "o aviso do gateway casou com a bolha (falha_no_gateway)");
      const rt = await retorno(t, s.retorno);
      t.igual(
        [rt.status, rt.nao_enviado_motivo, rt.enviado_em],
        ["nao_enviado", "envio_recusado", null],
        "o lead não recebeu",
      );
    });

    it("o caminho sem_resposta_do_envio também vira envio_recusado; o lembrete recusado também", async () => {
      const b = await preparar(t);
      const s = await saindo(b, 1);
      await servidor(t, "select id from public.pegar_envios(10)");
      await t.sql(
        "update public.mensagens set tentativas = 3, status_em = now() - interval '3 minutes' where id = $1",
        [s.bolha],
      );
      await servidor(t, "select id from public.pegar_envios(10)");
      t.igual(await estado(t, s.retorno), ["nao_enviado", "envio_recusado"]);
      const s2 = await saindo(b, 2, "lembrete");
      await servidor(t, "select id from public.pegar_envios(10)");
      await servidor(t, "select public.falhar_envio($1, 'numero_invalido', true)", [s2.bolha]);
      t.igual(await estado(t, s2.retorno), ["nao_enviado", "envio_recusado"], "lembrete");
    });

    it("a equipe assume depois do concluir: com_equipe, e a bolha que volta à fila reabre e sai; com a Nina e as bolhas canceladas depois da hora (Desconectar): o retorno volta (caso 12)", async () => {
      const b = await preparar(t);
      const s1 = await saindo(b, 1);
      await assumir(t, b.uAtend, s1.conversa);
      t.igual(await estado(t, s1.retorno), ["nao_enviado", "com_equipe"]);
      t.igual((await retorno(t, s1.retorno)).rodada_id, s1.pura, "com_equipe mantém o rodada_id");
      await t.sql(
        "update public.mensagens set status = 'na_fila', status_em = now() where id = $1",
        [s1.bolha],
      );
      t.igual(await estado(t, s1.retorno), ["saindo", null], "reaberto");
      await enviarTudo(t);
      const fim = await retorno(t, s1.retorno);
      t.igual([fim.status, fim.nao_enviado_motivo], ["enviado", null]);
      t.ok(fim.enviado_em instanceof Date, "enviado_em");
      const s2 = await saindo(b, 2);
      await t.sql(
        "update public.mensagens set status = 'cancelada', status_em = now() where id = $1",
        [s2.bolha],
      );
      const r2 = await retorno(t, s2.retorno);
      t.igual(
        [r2.status, r2.nao_enviado_motivo, r2.rodada_id, r2.resolvido_em],
        ["pendente", null, null, null],
        "depois da hora, dentro do prazo: volta a pendente, não desconectado",
      );
    });

    it("o eco duplicado devolve a bolha cancelada à fila depois de o retorno voltar a pendente: ele é retomado por ela e não sai em dobro", async () => {
      const b = await preparar(t);
      const s = await saindo(b, 1);
      await t.sql(
        "update public.mensagens set status = 'cancelada', status_em = now() where id = $1",
        [s.bolha],
      );
      t.igual(await estado(t, s.retorno), ["pendente", null], "voltou");
      // o concluir_envio (base 0006) devolve à fila as bolhas que o eco cancelou
      await t.sql(
        "update public.mensagens set status = 'na_fila', status_em = now() where id = $1",
        [s.bolha],
      );
      const rt = await retorno(t, s.retorno);
      t.igual(
        [rt.status, rt.rodada_id, rt.tentar_apos],
        ["saindo", s.pura, null],
        "retomado pela rodada da bolha",
      );
      t.igual(await pegar(t), [], "a faixa 1 não manda de novo");
      await enviarTudo(t);
      t.igual(await estado(t, s.retorno), ["enviado", null]);
      t.igual(
        await contar(t, "select 1 from public.rodadas where retorno_id = $1", [s.retorno]),
        1,
        "uma rodada só levou o retorno",
      );
    });

    it("caso 12: o Desconectar ou o Trocar de WhatsApp depois da hora (a conexão desligada, depois as bolhas canceladas): o retorno volta e sai quando o WhatsApp volta; passado o prazo, desconectado; o lembrete, desconectado", async () => {
      const b = await preparar(t);
      // três saindo ao mesmo tempo (o saindo() de cima envia a fila inteira ao montar o seguinte)
      const c1 = (await atendida(t, b, tel(1))).conversa;
      const c2 = (await atendida(t, b, tel(2))).conversa;
      const c3 = (await atendida(t, b, tel(3))).conversa;
      const [s1, s2, s3] = [
        { retorno: await inserir(t, c1) },
        { retorno: await inserir(t, c2) },
        { retorno: await inserir(t, c3, { tipo: "lembrete" }) },
      ];
      const puras = await pegar(t, 3, 3);
      t.igual(puras.length, 3, "três rodadas puras");
      for (const p of puras)
        await concluir(t, p.id, ["Oi! Como combinamos..."], [responder("nao")]);
      for (const s of [s1, s2, s3]) t.igual(await estado(t, s.retorno), ["saindo", null]);
      await t.sql(
        "update public.retornos set vence_em = now() - interval '4 hours', expira_em = now() - interval '1 minute' where id = $1",
        [s2.retorno],
      );
      // como o servidor faz (configuracao/banco.server.ts): desliga a conexão, depois cancela as
      // bolhas da Nina na fila dela
      await t.sql(
        "update public.conexoes set ativa = false, status = 'desconectada' where id = $1",
        [b.cx],
      );
      await t.sql(
        `update public.mensagens set status = 'cancelada', status_em = now()
        where conexao_id = $1 and direcao = 'saida' and origem = 'nina' and status = 'na_fila'`,
        [b.cx],
      );
      const r1 = await retorno(t, s1.retorno);
      t.igual(
        [r1.status, r1.rodada_id, r1.nao_enviado_motivo, r1.resolvido_em],
        ["pendente", null, null, null],
        "dentro do prazo: volta",
      );
      t.igual(
        await estado(t, s2.retorno),
        ["nao_enviado", "desconectado"],
        "passado o prazo: desconectado",
      );
      t.igual(await estado(t, s3.retorno), ["nao_enviado", "desconectado"], "o lembrete não volta");
      t.igual(await prontos(t), [], "sem WhatsApp, nada pronto");
      t.igual(await pegar(t), [], "ninguém pega");
      await varrer(t);
      t.igual(
        await estado(t, s1.retorno),
        ["pendente", null],
        "a varredura espera o WhatsApp até o prazo",
      );
      // o número novo conecta (Trocar de WhatsApp): o retorno sai
      await t.sql(
        `insert into public.conexoes (gateway, nome, id_externo, ativa, status, parametros)
       values ('zapi', 'Número novo', 'inst-teste-2', true, 'conectada', '{}'::jsonb)`,
      );
      t.igual(
        (await prontos(t)).map((p: Linha) => p.retorno_id),
        [s1.retorno],
        "pronto quando o WhatsApp volta",
      );
      const [pura] = await pegar(t);
      t.igual(pura?.retorno_id, s1.retorno, "a faixa 1 pega");
    });

    it("a equipe escreve pela tela ou pelo celular com a bolha do retorno na fila: com_equipe, não desconectado", async () => {
      // a mensagem humana cancela as bolhas da Nina antes de gravar o modo humano na conversa
      // (base 0006, tg_mensagens_apos_inserir): o retorno não pode ler "a conversa ainda é da Nina"
      const b = await preparar(t);
      const s1 = await saindo(b, 1);
      await t.sql(
        `insert into public.mensagens (conversa_id, direcao, origem, texto, status, autor_membro_id)
       values ($1, 'saida', 'humano_tela', 'Oi, aqui é a equipe', 'na_fila', $2)`,
        [s1.conversa, b.mAtend],
      );
      t.igual(await estado(t, s1.retorno), ["nao_enviado", "com_equipe"], "pela tela");
      t.igual((await conversaDe(t, s1.conversa)).modo, "humano");
      const s2 = await saindo(b, 2);
      await t.sql(
        `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, texto, status)
       values ($1, $2, 'saida', 'humano_celular', 'Oi, pelo celular', 'enviada')`,
        [s2.conversa, b.cx],
      );
      t.igual(await estado(t, s2.retorno), ["nao_enviado", "com_equipe"], "pelo celular");
      t.igual((await conversaDe(t, s2.conversa)).modo, "humano");
      // sem mensagem humana, a bolha cancelada com a conversa ainda com a Nina é o Desconectar: dentro
      // do prazo, o retorno volta (caso 12)
      const s3 = await saindo(b, 3);
      await t.sql(
        "update public.mensagens set status = 'cancelada', status_em = now() where id = $1",
        [s3.bolha],
      );
      t.igual(await estado(t, s3.retorno), ["pendente", null]);
    });

    it("na_fila → enviando e enviada → entregue não mexem no retorno", async () => {
      const b = await preparar(t);
      const s = await saindo(b, 1);
      const antes = await retorno(t, s.retorno);
      await servidor(t, "select id from public.pegar_envios(10)");
      t.igual(await retorno(t, s.retorno), antes, "enviando");
      await servidor(t, "select public.concluir_envio($1, 'ext-entregue-1', null)", [s.bolha]);
      const enviado = await retorno(t, s.retorno);
      t.igual(enviado.status, "enviado");
      await t.sql("update public.mensagens set status = 'entregue' where id = $1", [s.bolha]);
      t.igual(await retorno(t, s.retorno), enviado, "entregue");
    });

    it("a bolha da rodada comum que falha não mexe em retorno nenhum (vai para a equipe como hoje)", async () => {
      const b = await preparar(t);
      const c = await comRetorno(t, b, tel(1), await amanha(t));
      const antes = await retorno(t, c.retorno);
      const r = await rodadaDoLead(t, b, tel(1));
      await concluir(t, r.rodada.id, ["Oi!"]);
      const [{ id: bolha }] = await t.sql(
        "select id from public.mensagens where rodada_id = $1 and direcao = 'saida'",
        [r.rodada.id],
      );
      await t.sql(
        "update public.mensagens set enviar_apos = now() - interval '1 second' where id = $1",
        [bolha],
      );
      await servidor(t, "select id from public.pegar_envios(10)");
      await servidor(t, "select public.falhar_envio($1, 'numero_invalido', true)", [bolha]);
      t.igual((await conversaDe(t, c.conversa)).modo, "humano", "regra de hoje");
      t.igual(await retorno(t, c.retorno), antes, "o retorno pendente não muda");
    });

    it("um erro dentro do retorno_pelas_bolhas não derruba o envio; a varredura G corrige depois", async () => {
      const b = await preparar(t);
      const s = await saindo(b, 1);
      await quebrar(t, "retorno_pelas_bolhas");
      await enviarTudo(t);
      const [{ status }] = await t.sql("select status::text from public.mensagens where id = $1", [
        s.bolha,
      ]);
      t.igual(status, "enviada", "a bolha saiu");
      t.igual(await estado(t, s.retorno), ["saindo", null], "o gatilho engoliu o erro");
      await t.aplicar(arqRegras!);
      t.ok(
        !(await temQuebrada(t, "retorno_pelas_bolhas")),
        "a função de volta (do nina_retornos_regras)",
      );
      await varrer(t);
      t.igual(await estado(t, s.retorno), ["enviado", null], "a varredura G corrige");
    });

    it("varredura G: saindo depois do prazo com o WhatsApp fora: com a bolha em envio há menos de 2 min, espera; com o envio preso, desconectado", async () => {
      const b = await preparar(t);
      // dois saindo ao mesmo tempo (o saindo() de cima envia a fila inteira ao montar o seguinte)
      const c1 = (await atendida(t, b, tel(1))).conversa;
      const c2 = (await atendida(t, b, tel(2))).conversa;
      const r1 = await inserir(t, c1);
      const r2 = await inserir(t, c2);
      const puras = await pegar(t, 3, 3);
      t.igual(puras.length, 2, "duas rodadas puras");
      for (const p of puras)
        await concluir(t, p.id, ["Oi! Como combinamos..."], [responder("nao")]);
      const bolhaDe = async (conversa: string) =>
        (
          await t.sql(
            `select m.id from public.mensagens m join public.rodadas rd on rd.id = m.rodada_id
            where rd.conversa_id = $1 and rd.retorno_id is not null and m.direcao = 'saida'`,
            [conversa],
          )
        )[0].id as string;
      const [b1, b2] = [await bolhaDe(c1), await bolhaDe(c2)];
      await t.sql(
        "update public.mensagens set enviar_apos = now() - interval '1 second' where id = any ($1::uuid[])",
        [[b1, b2]],
      );
      const env = (await servidor(t, "select id from public.pegar_envios(10)"))
        .map((e: Linha) => e.id as string)
        .sort();
      t.igual(env, [b1, b2].sort(), "as duas em envio");
      // o envio da 2ª está preso há 3 min (o corte da pegar_envios é 2 min)
      await t.sql(
        "update public.mensagens set status_em = now() - interval '3 minutes' where id = $1",
        [b2],
      );
      await t.sql(
        "update public.retornos set vence_em = now() - interval '4 hours', expira_em = now() - interval '1 minute' where id = any ($1::uuid[])",
        [[r1, r2]],
      );
      await t.sql("update public.conexoes set status = 'desconectada' where id = $1", [b.cx]);
      await varrer(t);
      t.igual(
        await estado(t, r1),
        ["saindo", null],
        "com a bolha em envio há pouco, a varredura espera",
      );
      t.igual(
        await estado(t, r2),
        ["nao_enviado", "desconectado"],
        "com o envio preso, desconectado",
      );
      // o envio da 1ª termina: enviado
      await servidor(t, "select public.concluir_envio($1, 'ext-g-1', null)", [b1]);
      t.igual(await estado(t, r1), ["enviado", null], "a bolha saiu");
      // o envio preso da 2ª termina depois: o gatilho reabre o não enviado, resolvido agora (nunca
      // antes do envio)
      await servidor(t, "select public.concluir_envio($1, 'ext-g-2', null)", [b2]);
      const fim2 = await retorno(t, r2);
      t.igual(
        [fim2.status, fim2.nao_enviado_motivo],
        ["enviado", null],
        "a bolha presa saiu: reabre",
      );
      t.ok(
        ms(fim2.resolvido_em)! >= ms(fim2.enviado_em)!,
        `resolvido_em (${String(fim2.resolvido_em)}) >= enviado_em (${String(fim2.enviado_em)})`,
      );
    });

    it("varredura G: a bolha que saiu depois do recálculo (o gatilho dela adiado pela trava da varredura) não deixa o retorno como desconectado; a passada seguinte grava enviado", async () => {
      const b = await preparar(t);
      const s = await saindo(b, 1);
      await servidor(t, "select id from public.pegar_envios(10)");
      // a bolha sai com o gatilho dela adiado (a varredura segurava o retorno): o retorno fica saindo
      await t.sql("alter table public.mensagens disable trigger mensagens_saida_do_retorno");
      try {
        await servidor(t, "select public.concluir_envio($1, 'ext-g-3', null)", [s.bolha]);
      } finally {
        await t.sql("alter table public.mensagens enable trigger mensagens_saida_do_retorno");
      }
      t.igual(await estado(t, s.retorno), ["saindo", null], "o gatilho não recalculou");
      await t.sql(
        "update public.retornos set vence_em = now() - interval '4 hours', expira_em = now() - interval '1 minute' where id = $1",
        [s.retorno],
      );
      await t.sql("update public.conexoes set status = 'desconectada' where id = $1", [b.cx]);
      // o recálculo da varredura viu a bolha ainda em envio (só no banco de teste: a função não faz nada)
      await t.sql(
        "create or replace function public.retorno_pelas_bolhas(p_retorno uuid) returns void language plpgsql as 'begin null; end'",
      );
      await varrer(t);
      t.igual(
        await estado(t, s.retorno),
        ["saindo", null],
        "com uma bolha que já saiu, não fecha como desconectado",
      );
      await t.aplicar(arqRegras!);
      await varrer(t);
      t.igual(
        await estado(t, s.retorno),
        ["enviado", null],
        "a passada seguinte recalcula pelas bolhas: enviado",
      );
    });

    it("o gatilho: depois de update of status em mensagens, com a forma combinada", async () => {
      const [g] = await t.sql(
        `select pg_get_triggerdef(tg.oid) as def from pg_trigger tg
        where tg.tgname = 'mensagens_saida_do_retorno' and tg.tgrelid = 'public.mensagens'::regclass`,
      );
      t.ok(g, "o gatilho existe");
      t.ok(
        /AFTER UPDATE OF status ON public\.mensagens FOR EACH ROW WHEN/i.test(g.def),
        `definição: ${g.def}`,
      );
      t.ok(g.def.includes("tg_mensagens_saida_do_retorno()"), "chama a função");
      const nomes = (
        await t.sql(
          `select tgname from pg_trigger where tgrelid = 'public.mensagens'::regclass and not tgisinternal
           and tgtype & 16 = 16 order by tgname`,
        )
      ).map((r: Linha) => r.tgname as string);
      t.ok(
        nomes.indexOf("mensagens_envio_falhou") < nomes.indexOf("mensagens_saida_do_retorno"),
        `ordem alfabética dos AFTER UPDATE: ${nomes.join(", ")}`,
      );
    });
  },
);

// O retorno vencido e pronto (D8) roda também sem o nina_retornos_rodada: está no grupo "sem o fim
// da rodada novo", logo abaixo.
describe.skipIf(!temFluxo)(
  "banco: retornos, o atraso (motor_pendencias_com_retornos, D8 e A4)",
  { timeout: TEMPO_TESTE },
  () => {
    const t = usarBanco(base);

    it("depois de uma falha passageira, o tentar_apos entra em proximo_em", async () => {
      const b = await preparar(t);
      const c = await atendida(t, b, tel(1));
      const rt = await inserir(t, c.conversa);
      const [pura] = await pegar(t);
      await falhar(t, pura.id, "erro_provedor", true);
      const { tentar_apos } = await retorno(t, rt);
      t.igual(await pendencias(t), { proximo: ms(tentar_apos), vencido: null, atrasado: null });
    });
  },
);

// Os que só precisam do nina_retornos_funcoes (e do nina_retornos_regras): rodam também no estado
// que fica dias na main (os três primeiros envios), sem o nina_retornos_rodada. Depois da volta
// atrás pesada na base, a motor_pendencias_com_retornos volta a ser a de hoje: pulam.
describe.skipIf(!temFuncoes || desfeito)(
  "banco: retornos, o atraso e o Cancelar da equipe sem o fim da rodada novo (nina_retornos_funcoes)",
  { timeout: TEMPO_TESTE },
  () => {
    const t = usarBanco(base);

    it("D8: o retorno vencido e pronto conta; o futuro, o lembrete e o de hoje (motor_pendencias) não", async () => {
      const b = await preparar(t);
      // desligados (sem o nina_retornos_rodada), as pendências não somam retorno e a irmã não pega:
      // os retornos ligados, pela retornos_ligados de mentira
      if (!temRodada) await ligadosDeMentira(t);
      const c = await atendida(t, b, tel(1));
      const rt = await inserir(t, c.conversa, {
        vence: "now() + interval '1 hour'",
        expira: "now() + interval '4 hours'",
      });
      t.igual(await pendencias(t), NADA, "o futuro não entra em proximo_em");
      await vencerRetorno(t, rt);
      const { vence_em } = await retorno(t, rt);
      t.igual(
        await pendencias(t),
        { proximo: null, vencido: ms(vence_em), atrasado: ms(vence_em) },
        "vencido e pronto",
      );
      t.igual(await pendenciasHoje(t), NADA, "a motor_pendencias de hoje não conta retorno");
      t.igual(
        (await pegar(t))[0]?.retorno_id,
        rt,
        "e a irmã pega (pendência e quem pega concordam)",
      );
      const c2 = await atendida(t, b, tel(2));
      const semLembrete = await pendencias(t);
      await inserir(t, c2.conversa, { tipo: "lembrete" });
      t.igual(await pendencias(t), semLembrete, "o lembrete nunca conta");
      t.igual(
        await pendencias(t),
        await pendenciasHoje(t),
        "só a faixa 0 (a rodada pura rodando conta como hoje)",
      );
    });

    it("nina_retorno_da_rodada (I11c): na rodada comum, o pendente com a hora passada e dentro do prazo vem com vencido; o de prazo vencido não vem", async () => {
      const b = await preparar(t);
      // a rodada comum do lead, e o retorno gravado depois de ela começar (não foi levado junto)
      const r = await rodadaDoLead(t, b, tel(1));
      const rt = await inserir(t, r.conversa, {
        vence: "now() - interval '5 minutes'",
        expira: "now() + interval '1 hour'",
      });
      const lido = await daRodada(t, r.rodada.id);
      t.igual(
        [lido?.da_rodada, lido?.retorno_id, lido?.tipo, lido?.vencido],
        [false, rt, "retorno", true],
        "a hora passou, dentro do prazo: vencido",
      );
      await t.sql(
        "update public.retornos set vence_em = now() - interval '4 hours', expira_em = now() - interval '1 second' where id = $1",
        [rt],
      );
      t.igual(await estado(t, rt), ["pendente", null], "ainda pendente (a varredura C não passou)");
      t.igual(await daRodada(t, r.rodada.id), null, "o de prazo vencido não vem");
      await concluir(t, r.rodada.id, ["Oi!"]);
      await enviarTudo(t);
      await varrer(t);
      t.igual(await estado(t, rt), ["nao_enviado", "passou_do_prazo"], "a varredura C o fecha");
    });

    it("caso 6 (com o retorno gravado direto): atendente e admin cancelam o retorno e o lembrete; o que já foi cancelado, o que está numa rodada, o inexistente e o torto são recusados; a conta sem convite, o desativado e o servidor, sem_acesso", async () => {
      const b = await preparar(t);
      const futuro = {
        vence: "now() + interval '1 day'",
        expira: "now() + interval '1 day 3 hours'",
      };
      const c1 = await atendida(t, b, tel(1));
      const r1 = await inserir(t, c1.conversa, futuro);
      await equipeCancela(t, b.uAtend, r1);
      const x1 = await retorno(t, r1);
      t.igual(
        [x1.status, x1.cancelado_por, x1.fechado_por_rodada, x1.resolvido_em instanceof Date],
        ["cancelado", b.mAtend, null, true],
      );
      await t.erro(equipeCancela(t, b.uAtend, r1), "retorno_nao_pendente");
      const c2 = await atendida(t, b, tel(2));
      const r2 = await inserir(t, c2.conversa, futuro);
      await equipeCancela(t, b.uAdmin, r2);
      t.igual((await retorno(t, r2)).cancelado_por, b.mAdmin, "o admin");
      // o que já entrou numa rodada (em_rodada) não é cancelado
      const c3 = await atendida(t, b, tel(3));
      const r3 = await inserir(t, c3.conversa);
      const [{ id: rd3 }] = await t.sql(
        "insert into public.rodadas (conversa_id, status, retorno_id) values ($1, 'rodando', $2) returning id",
        [c3.conversa, r3],
      );
      await t.sql(
        "update public.retornos set status = 'em_rodada', rodada_id = $2, tentativas = 1 where id = $1",
        [r3, rd3],
      );
      await t.erro(equipeCancela(t, b.uAtend, r3), "retorno_nao_pendente");
      t.igual((await retorno(t, r3)).status, "em_rodada", "continua na rodada");
      await t.erro(
        equipeCancela(t, b.uAtend, "00000000-0000-4000-8000-000000000000"),
        "retorno_nao_pendente",
      );
      await t.erro(equipeCancela(t, b.uAtend, "torto"), "22P02");
      // o lembrete também
      const c4 = await atendida(t, b, tel(4));
      const l4 = await inserir(t, c4.conversa, { tipo: "lembrete", ...futuro });
      await equipeCancela(t, b.uAtend, l4);
      t.igual(
        [(await retorno(t, l4)).status, (await retorno(t, l4)).cancelado_por],
        ["cancelado", b.mAtend],
      );
      // sem acesso
      const c5 = await atendida(t, b, tel(5));
      const r5 = await inserir(t, c5.conversa, futuro);
      await t.erro(equipeCancela(t, b.uSem, r5), "sem_acesso");
      await t.erro(equipeCancela(t, null, r5), "sem_acesso");
      await t.erro(
        t.como("service_role", null, (q) => q("select public.cancelar_retorno($1)", [r5])),
        "sem_acesso",
      );
      await t.sql("update public.membros set ativo = false where id = $1", [b.mAtend]);
      await t.erro(equipeCancela(t, b.uAtend, r5), "sem_acesso");
      t.igual(await estado(t, r5), ["pendente", null], "nada muda");
    });

    it("A4: o retorno pronto há mais de 10 min não esconde o lead (vencido_desde), mas continua em atrasado_desde", async () => {
      const b = await preparar(t);
      // desligados (sem o nina_retornos_rodada), as pendências não somam retorno: o atraso dos
      // retornos ligados, pela retornos_ligados de mentira
      if (!temRodada) await ligadosDeMentira(t);
      const c = await atendida(t, b, tel(1));
      const rt = await inserir(t, c.conversa, { vence: "now() - interval '12 minutes'" });
      const e = await entrada(t, b.cx, tel(2));
      await t.sql(
        "update public.conversas set responder_apos = now() - interval '1 second' where id = $1",
        [e.conversa_id],
      );
      const { responder_apos } = await conversaDe(t, e.conversa_id);
      const { vence_em } = await retorno(t, rt);
      t.igual(
        await pendencias(t),
        { proximo: null, vencido: ms(responder_apos), atrasado: ms(vence_em) },
        "12 min",
      );
      await vencerRetorno(t, rt, "5 minutes");
      const { vence_em: v5 } = await retorno(t, rt);
      t.igual(await pendencias(t), { proximo: null, vencido: ms(v5), atrasado: ms(v5) }, "5 min");
    });

    it("quem chama: o servidor, o membro ativo; a conta sem convite e o desativado, sem_acesso", async () => {
      const b = await preparar(t);
      const ler = (u: string | null) =>
        t.como("authenticated", u, (q) =>
          q("select * from public.motor_pendencias_com_retornos()"),
        );
      t.igual((await ler(b.uAtend)).length, 1, "atendente");
      t.igual((await ler(b.uAdmin)).length, 1, "admin");
      await t.erro(ler(b.uSem), "sem_acesso");
      await t.erro(ler(null), "sem_acesso");
      await t.sql("update public.membros set ativo = false where id = $1", [b.mAtend]);
      await t.erro(ler(b.uAtend), "sem_acesso");
    });

    it("a trava de acesso fica na própria função, e não só na motor_pendencias que ela chama", async () => {
      const b = await preparar(t);
      // a motor_pendencias sem a trava (só no banco de teste)
      await t.sql(`
      create or replace function public.motor_pendencias()
      returns table (proximo_em timestamptz, vencido_desde timestamptz, atrasado_desde timestamptz)
      language sql stable security definer set search_path = ''
      as $f$ select null::timestamptz, null::timestamptz, null::timestamptz $f$`);
      const ler = (u: string | null) =>
        t.como("authenticated", u, (q) =>
          q("select * from public.motor_pendencias_com_retornos()"),
        );
      await t.erro(ler(b.uSem), "sem_acesso");
      await t.erro(ler(null), "sem_acesso");
      t.igual((await ler(b.uAtend)).length, 1, "o membro ativo lê");
      t.igual(
        (await servidor(t, "select * from public.motor_pendencias_com_retornos()")).length,
        1,
        "o servidor lê",
      );
    });
  },
);

describe.skipIf(!temFluxo)("banco: retornos, leituras e cascata", { timeout: TEMPO_TESTE }, () => {
  const t = usarBanco(base);

  it("nina_retorno_da_rodada: sem retorno, null; nunca devolve o lembrete pendente", async () => {
    const b = await preparar(t);
    const r = await rodadaDoLead(t, b, tel(1));
    t.igual(await daRodada(t, r.rodada.id), null, "nada marcado");
    await concluir(t, r.rodada.id, ["Pode me confirmar?"], [responder("sim")]);
    t.igual(
      (await retornosDa(t, r.conversa)).map((l: Linha) => l.tipo),
      ["lembrete"],
    );
    await vencer(t, r.conversa);
    const [rd] = (await pegar(t, 3, 0)).filter((x: Linha) => x.conversa_id === r.conversa);
    t.igual(await daRodada(t, rd.id), null, "o lembrete pendente não aparece");
  });

  // A parte da rodada comum (vencido; o de prazo vencido não vem) está no grupo "sem o fim da rodada
  // novo", que roda também sem o nina_retornos_rodada.
  it("nina_retorno_da_rodada (I11c): o levado antes da hora vem com vencido falso; na mesma rodada, já com a hora passada, com vencido", async () => {
    const b = await preparar(t);
    const r = await rodadaDoLead(t, b, tel(1));
    await concluir(t, r.rodada.id, ["Oi!"]);
    await enviarTudo(t);
    // o levado junto antes da hora (a 5 min, marcado há 1 dia): da rodada, vencido falso
    const rt2 = await inserir(t, r.conversa, {
      vence: "now() + interval '5 minutes'",
      expira: "now() + interval '3 hours 5 minutes'",
      marcado: "now() - interval '1 day'",
    });
    await entrada(t, b.cx, tel(1), { texto: "ok" });
    await vencer(t, r.conversa);
    const [mista] = (await pegar(t)).filter((x: Linha) => x.conversa_id === r.conversa);
    t.igual(mista?.retorno_id, rt2, "levado junto");
    const lido2 = await daRodada(t, mista.id);
    t.igual(
      [lido2?.da_rodada, lido2?.retorno_id, lido2?.vencido],
      [true, rt2, false],
      "levado antes da hora: vencido falso",
    );
    // na mesma rodada, já com a hora passada: vencido
    await t.sql("update public.retornos set vence_em = now() - interval '1 minute' where id = $1", [
      rt2,
    ]);
    t.igual((await daRodada(t, mista.id))?.vencido, true, "levado e já vencido: vencido");
  });

  it("rodada_tem_fala_do_lead: a entrada de texto conta; a rodada pura, não", async () => {
    const b = await preparar(t);
    const r = await rodadaDoLead(t, b, tel(1));
    const [{ f }] = await t.sql("select public.rodada_tem_fala_do_lead($1) as f", [r.rodada.id]);
    t.igual(f, true, "com a entrada");
    await concluir(t, r.rodada.id, ["Oi"]);
    const rt = await inserir(t, r.conversa);
    await enviarTudo(t);
    const [pura] = await pegar(t);
    t.igual(pura.retorno_id, rt);
    const [{ f: g }] = await t.sql("select public.rodada_tem_fala_do_lead($1) as f", [pura.id]);
    t.igual(g, false, "a pura");
  });

  it("apagar o contato leva os retornos, os lembretes e as rodadas de retorno junto", async () => {
    const b = await preparar(t);
    const c = await comRetorno(t, b, tel(1));
    await vencerRetorno(t, c.retorno);
    await pegar(t);
    await inserir(t, c.conversa, {
      vence: "now() + interval '1 day'",
      expira: "now() + interval '1 day 3 hours'",
    });
    const [{ contato }] = await t.sql(
      "select contato_id as contato from public.conversas where id = $1",
      [c.conversa],
    );
    await t.sql("delete from public.contatos where id = $1", [contato]);
    t.igual(await contar(t, "select 1 from public.retornos"), 0, "retornos");
    t.igual(
      await contar(t, "select 1 from public.rodadas where conversa_id = $1", [c.conversa]),
      0,
      "rodadas",
    );
  });
});

// ---------------------------------------------------------------------------
// a convivência com a "permissão no chat" (I7; base 0040 e 0041, outra entrega)
// ---------------------------------------------------------------------------

// O pedido de permissão para ligar é uma saída da Nina, já enviada, numa rodada concluída sem
// passos e sem retorno_id (ligacao_permissao_registrar). A resposta do lead é uma entrada do tipo
// permissao_ligacao que conta como não lida e abre a janela de 24 h, mas não arma a Nina
// (ligacao_permissao_responder): fica solta até o lead escrever de verdade. Para os retornos, a
// resposta é mensagem do lead como qualquer outra; o pedido não é bolha de rodada de retorno. Na
// conexão oficial (a Meta), onde o pedido existe.
describe.skipIf(!temFluxo || !temPermissao)(
  "banco: retornos, a convivência com a permissão no chat (I7)",
  { timeout: TEMPO_TESTE },
  () => {
    const t = usarBanco(base);

    it("(i) lembrete armado; o lead responde ao pedido de permissão: a conversa não fica armada, o lembrete sai dos prontos, a varredura o apaga perto da hora e ele nunca sai", async () => {
      const b = await preparar(t, { gateway: "meta" });
      const r = await rodadaDoLead(t, b, tel(1));
      await concluir(t, r.rodada.id, ["Consegue ver a proposta hoje?"], [responder("sim")]);
      await enviarTudo(t);
      const [lb] = await retornosDa(t, r.conversa);
      t.igual([lb?.tipo, lb?.status], ["lembrete", "pendente"], "o lembrete armado");
      const wamid = await pedirPermissao(t, b, r.conversa);
      await responderPermissao(t, b, wamid);
      t.igual(
        (await mensagensDaPermissao(t, r.conversa)).map((m: Linha) => [
          m.direcao,
          m.origem,
          m.rodada_id === null,
        ]),
        [
          ["saida", "nina", false],
          ["entrada", "lead", true],
        ],
        "o pedido (numa rodada concluída) e a resposta, solta",
      );
      const cv = await conversaDe(t, r.conversa);
      t.igual([cv.modo, cv.responder_apos], ["nina", null], "a conversa não fica armada");
      // longe da hora, ele espera (como com qualquer mensagem do lead: só perto da hora a varredura o apaga)
      await varrer(t);
      t.igual(await estado(t, lb.id), ["pendente", null], "longe da hora, continua pendente");
      // na hora, não está entre os prontos: o lead falou depois de armar
      await vencerRetorno(t, lb.id);
      t.igual(
        (await prontos(t)).filter((p: Linha) => p.retorno_id === lb.id),
        [],
        "não está entre os prontos",
      );
      // a função que pega as rodadas não cria rodada, e a varredura dela o apaga
      t.igual(await pegar(t), [], "nenhuma rodada");
      t.igual(await retorno(t, lb.id), undefined, "a varredura o apaga");
      t.igual(
        await contar(t, "select 1 from public.rodadas where retorno_id is not null"),
        0,
        "ele nunca sai",
      );
      t.igual(
        (await conversaDe(t, r.conversa)).responder_apos,
        null,
        "e a conversa continua sem armar",
      );
    });

    it("(ii) retorno combinado pendente; o lead responde ao pedido antes da hora: na hora a rodada pura nasce, a resposta continua solta, e a bolha sai (saindo, depois enviado), sem descarte", async () => {
      const b = await preparar(t, { gateway: "meta" });
      const c = await comRetorno(t, b, tel(1), await local(t, "now() + interval '1 hour'"));
      const wamid = await pedirPermissao(t, b, c.conversa);
      await responderPermissao(t, b, wamid);
      t.igual((await conversaDe(t, c.conversa)).responder_apos, null, "a conversa não fica armada");
      t.igual(await pegar(t), [], "antes da hora, nada");
      t.igual(
        await estado(t, c.retorno),
        ["pendente", null],
        "o retorno continua pendente (a resposta não o trava)",
      );
      await vencerRetorno(t, c.retorno);
      t.ok(
        (await prontos(t)).some((p: Linha) => p.retorno_id === c.retorno),
        "na hora, pronto",
      );
      const rs = await pegar(t);
      t.igual(
        rs.map((r: Linha) => [r.conversa_id, r.retorno_id]),
        [[c.conversa, c.retorno]],
        "a rodada pura do retorno",
      );
      const pura = rs[0] as Linha;
      t.igual(
        await contar(
          t,
          "select 1 from public.mensagens where rodada_id = $1 and direcao = 'entrada'",
          [pura.id],
        ),
        0,
        "a rodada pura não lê a resposta ao pedido",
      );
      await concluir(
        t,
        pura.id,
        ["Oi! Como combinamos, voltei para falar da proposta."],
        [responder("nao")],
      );
      t.igual(await saidasDa(t, pura.id), 1, "a bolha, sem descarte");
      t.igual(await estado(t, c.retorno), ["saindo", null], "saindo");
      const solta = async () =>
        (await mensagensDaPermissao(t, c.conversa)).find((m: Linha) => m.direcao === "entrada")
          ?.rodada_id;
      t.igual(await solta(), null, "a resposta ao pedido continua solta");
      await enviarTudo(t);
      t.igual(await estado(t, c.retorno), ["enviado", null], "enviado");
      t.igual(await solta(), null, "e continua solta depois");
    });

    it("(iii) o pedido de permissão gravado com um retorno saindo e um lembrete pendente: nada muda nos retornos", async () => {
      const b = await preparar(t, { gateway: "meta" });
      const c = await comRetorno(t, b, tel(1), await local(t, "now() + interval '1 hour'"));
      await vencerRetorno(t, c.retorno);
      const [pura] = await pegar(t);
      t.igual(pura?.retorno_id, c.retorno, "a rodada pura");
      await concluir(t, pura.id, ["Oi! Conseguiu ver a proposta?"], [responder("sim")]);
      const antes = await retornosDa(t, c.conversa);
      t.igual(
        antes.map((l: Linha) => [l.tipo, l.status]),
        [
          ["retorno", "saindo"],
          ["lembrete", "pendente"],
        ],
        "o retorno saindo e o lembrete pendente",
      );
      const wamid = await pedirPermissao(t, b, c.conversa);
      // os status da Meta no pedido (entregue, lida) também não mexem
      await servidor(t, "select public.atualizar_status($1, $2, 'entregue', now())", [b.cx, wamid]);
      await servidor(t, "select public.atualizar_status($1, $2, 'lida', now())", [b.cx, wamid]);
      t.igual(
        await retornosDa(t, c.conversa),
        antes,
        "nada muda nos retornos (nem o atualizado_em)",
      );
      const [rp] = await t.sql(
        `select r.retorno_id, r.status::text as status, r.passos, m.status::text as msg
         from public.mensagens m join public.rodadas r on r.id = m.rodada_id
        where m.conversa_id = $1 and m.tipo = 'permissao_ligacao' and m.direcao = 'saida'`,
        [c.conversa],
      );
      t.igual(
        [rp?.retorno_id, rp?.status, rp?.passos, rp?.msg],
        [null, "concluida", 0, "lida"],
        "o pedido: rodada concluída, sem passos e sem retorno",
      );
      await varrer(t);
      t.igual(
        await retornosDa(t, c.conversa),
        antes,
        "nem a varredura (o pedido não é fala do lead nem bolha do retorno)",
      );
      // a bolha do retorno sai (enviado) e o lembrete continua
      await enviarTudo(t);
      const depois = await retornosDa(t, c.conversa);
      t.igual(
        depois.map((l: Linha) => [l.tipo, l.status]),
        [
          ["retorno", "enviado"],
          ["lembrete", "pendente"],
        ],
        "o retorno enviado e o lembrete pendente",
      );
      // na hora, o lembrete fica pronto: o pedido não é fala do lead
      await vencerRetorno(t, depois[1].id);
      t.ok(
        (await prontos(t)).some((p: Linha) => p.retorno_id === depois[1].id),
        "o lembrete pronto na hora",
      );
      // o 'falhou' da Meta no pedido também não chega ao gatilho das bolhas (a rodada do pedido não
      // tem retorno_id): o retorno enviado continua enviado (nem envio_recusado) e o lembrete,
      // pendente. A atualizar_status só aplica o falhou sobre o enviado (depois do 'lida' não muda
      // nada): aqui o pedido volta a enviado só no banco de teste. A regra de hoje da bolha da Nina que
      // falha vale: a conversa vai para a equipe (envio_falhou)
      const pedido = async () =>
        (
          await t.sql(
            "select status::text as s from public.mensagens where conversa_id = $1 and tipo = 'permissao_ligacao' and direcao = 'saida'",
            [c.conversa],
          )
        )[0]?.s as string | undefined;
      await t.sql(
        "update public.mensagens set status = 'enviada' where conversa_id = $1 and tipo = 'permissao_ligacao' and direcao = 'saida'",
        [c.conversa],
      );
      const antesDoFalhou = await retornosDa(t, c.conversa);
      await servidor(t, "select public.atualizar_status($1, $2, 'falhou', now())", [b.cx, wamid]);
      t.igual(await pedido(), "falhou", "o pedido falhou");
      t.igual(
        await retornosDa(t, c.conversa),
        antesDoFalhou,
        "o falhou no pedido não mexe nos retornos",
      );
      const cv = await conversaDe(t, c.conversa);
      t.igual(
        [cv.modo, cv.motivo_humano],
        ["humano", "envio_falhou"],
        "a regra de hoje: a conversa vai para a equipe",
      );
    });

    it("(iv) a rodada comum que lê a resposta ao pedido junto com uma mensagem de verdade do lead: tem fala do lead e a Nina marca", async () => {
      const b = await preparar(t, { gateway: "meta" });
      const c = await atendida(t, b, tel(1));
      const wamid = await pedirPermissao(t, b, c.conversa);
      await responderPermissao(t, b, wamid);
      t.igual(await pegar(t), [], "a resposta sozinha não arma a Nina");
      await entrada(t, b.cx, tel(1), { texto: "Pode me ligar amanhã à tarde" });
      await vencer(t, c.conversa);
      const [rd] = (await pegar(t)).filter((r: Linha) => r.conversa_id === c.conversa);
      t.igual(rd?.retorno_id, null, "a rodada comum");
      const lidas = await t.sql(
        "select tipo::text as tipo from public.mensagens where rodada_id = $1 and direcao = 'entrada' order by criado_em",
        [rd.id],
      );
      t.igual(
        lidas.map((m: Linha) => m.tipo),
        ["permissao_ligacao", "texto"],
        "a rodada lê a resposta ao pedido e a mensagem",
      );
      const [{ f }] = await t.sql("select public.rodada_tem_fala_do_lead($1) as f", [rd.id]);
      t.igual(f, true, "tem fala do lead");
      const q = await local(t, "now() + interval '2 hours'");
      const res = await marcar(t, rd.id, q.data, q.hora, "Ligar para o lead à tarde");
      t.igual([res.ok, res.igual], [true, false], `a Nina marca: ${JSON.stringify(res)}`);
      t.igual(await estado(t, res.retorno_id as string), ["pendente", null]);
    });

    /** O lembrete armado por uma pergunta, o pedido registrado e a faixa 2 pegando o lembrete. */
    async function lembreteNaRodada(b: Preparo, n: number) {
      const r = await rodadaDoLead(t, b, tel(n));
      await concluir(t, r.rodada.id, ["Consegue ver a proposta hoje?"], [responder("sim")]);
      await enviarTudo(t);
      const [lb] = await retornosDa(t, r.conversa);
      t.igual([lb?.tipo, lb?.status], ["lembrete", "pendente"], `${n}: o lembrete armado`);
      // a rodada que armou o lembrete começou há 10 min (a âncora do lembrete fica bem para trás)
      await t.sql(
        "update public.rodadas set iniciada_em = iniciada_em - interval '10 minutes' where id = $1",
        [r.rodada.id],
      );
      const wamid = await pedirPermissao(t, b, r.conversa);
      await vencerRetorno(t, lb.id);
      const [pura] = (await pegar(t)).filter((x: Linha) => x.conversa_id === r.conversa);
      t.igual(pura?.retorno_id, lb.id, `${n}: a faixa 2 pega o lembrete`);
      t.igual(await estado(t, lb.id), ["em_rodada", null], `${n}: o lembrete na rodada`);
      return {
        conversa: r.conversa,
        origem: r.rodada.id as string,
        lembrete: lb.id as string,
        pura: pura.id as string,
        wamid,
      };
    }

    it("(v) lembrete numa rodada pura; o lead responde ao pedido de permissão durante ela: nenhuma bolha, o lembrete dispensado, a resposta continua solta e a conversa sem armar (também com a resposta gravada logo antes do começo da rodada)", async () => {
      const b = await preparar(t, { gateway: "meta" });
      const confere = async (x: Awaited<ReturnType<typeof lembreteNaRodada>>, nome: string) => {
        t.igual(await saidasDa(t, x.pura), 0, `${nome}: nenhuma bolha da Nina`);
        t.igual(
          await estado(t, x.lembrete),
          ["dispensado", null],
          `${nome}: o lembrete dispensado`,
        );
        const resp = (await mensagensDaPermissao(t, x.conversa)).find(
          (m: Linha) => m.direcao === "entrada",
        );
        t.ok(resp, `${nome}: a resposta gravada`);
        t.igual(resp.rodada_id, null, `${nome}: a resposta continua solta`);
        t.igual(
          (await conversaDe(t, x.conversa)).responder_apos,
          null,
          `${nome}: a conversa sem armar`,
        );
      };
      // (a) a resposta chega enquanto a IA escreve o lembrete
      const a = await lembreteNaRodada(b, 1);
      await responderPermissao(t, b, a.wamid);
      await concluir(t, a.pura, ["Oi! Conseguiu ver minha pergunta?"], [responder("nao")]);
      await confere(a, "durante a rodada");
      // (b) a resposta gravada 1 s antes do começo da rodada do lembrete (entre a leitura dos prontos e
      // a trava da faixa 2) e depois da âncora (o começo da rodada que armou o lembrete)
      const c = await lembreteNaRodada(b, 2);
      await responderPermissao(t, b, c.wamid);
      await t.sql(
        `update public.mensagens set criado_em = (select iniciada_em from public.rodadas where id = $2) - interval '1 second'
        where conversa_id = $1 and direcao = 'entrada' and tipo = 'permissao_ligacao'`,
        [c.conversa, c.pura],
      );
      const [{ entre }] = await t.sql(
        `select m.criado_em >= o.iniciada_em and m.criado_em < p.iniciada_em as entre
         from public.mensagens m, public.rodadas o, public.rodadas p
        where m.conversa_id = $1 and m.direcao = 'entrada' and m.tipo = 'permissao_ligacao' and o.id = $2 and p.id = $3`,
        [c.conversa, c.origem, c.pura],
      );
      t.igual(entre, true, "a resposta entre a âncora e o começo da rodada do lembrete");
      await concluir(t, c.pura, ["Oi! Conseguiu ver minha pergunta?"], [responder("nao")]);
      await confere(c, "logo antes da rodada");
    });

    it("(vi) retorno combinado numa rodada pura; o lead responde ao pedido durante ela: a bolha sai (sem descarte), o retorno fica saindo e o lembrete não arma", async () => {
      const b = await preparar(t, { gateway: "meta" });
      const c = await comRetorno(t, b, tel(1), await local(t, "now() + interval '1 hour'"));
      const wamid = await pedirPermissao(t, b, c.conversa);
      await vencerRetorno(t, c.retorno);
      const [pura] = await pegar(t);
      t.igual(pura?.retorno_id, c.retorno, "a rodada pura do retorno");
      await responderPermissao(t, b, wamid);
      await concluir(
        t,
        pura.id,
        ["Oi! Como combinamos, voltei para falar da proposta. Pode ser agora?"],
        [responder("sim")],
      );
      t.igual(
        await saidasDa(t, pura.id),
        1,
        "a bolha, sem descarte (a resposta ao pedido não trava o retorno)",
      );
      t.igual(await estado(t, c.retorno), ["saindo", null], "saindo");
      t.igual(
        await contar(
          t,
          "select 1 from public.retornos where conversa_id = $1 and tipo = 'lembrete'",
          [c.conversa],
        ),
        0,
        "o lembrete não arma: o lead respondeu durante a rodada",
      );
      await enviarTudo(t);
      t.igual(await estado(t, c.retorno), ["enviado", null], "enviado");
      t.igual(
        (await pegar(t)).filter((r: Linha) => r.conversa_id === c.conversa),
        [],
        "nenhuma rodada de lembrete",
      );
    });

    it("(vii) a resposta ao pedido chega durante a rodada do lead em que a Nina pergunta (espera_resposta 'sim'): o lembrete não arma; sem ela, a mesma pergunta arma", async () => {
      const b = await preparar(t, { gateway: "meta" });
      const c = await atendida(t, b, tel(1));
      const wamid = await pedirPermissao(t, b, c.conversa);
      const r = await rodadaDoLead(t, b, tel(1));
      await responderPermissao(t, b, wamid);
      t.igual(
        (await conversaDe(t, c.conversa)).responder_apos,
        null,
        "a resposta não arma a conversa",
      );
      await concluir(t, r.rodada.id, ["Prefere o plano mensal ou o anual?"], [responder("sim")]);
      t.igual(await saidasDa(t, r.rodada.id), 1, "a resposta da Nina sai");
      t.igual(
        await contar(t, "select 1 from public.retornos where conversa_id = $1", [c.conversa]),
        0,
        "nenhum lembrete",
      );
      // contraprova: a rodada seguinte lê a resposta ao pedido, e a mesma pergunta arma
      const r2 = await rodadaDoLead(t, b, tel(1));
      await concluir(t, r2.rodada.id, ["Prefere o plano mensal ou o anual?"], [responder("sim")]);
      t.igual(
        (await retornosDa(t, c.conversa)).map((l: Linha) => [l.tipo, l.status]),
        [["lembrete", "pendente"]],
        "sem resposta solta durante a rodada: arma",
      );
    });

    it("(viii) lembrete armado; a resposta ao pedido chega com o horário da Meta de antes de armar: não fica pronto e, perto da hora, a varredura o apaga (não fica preso até expirar)", async () => {
      const b = await preparar(t, { gateway: "meta" });
      const c = await atendida(t, b, tel(1), { ferramentas: [responder("sim")] });
      const [lb] = await retornosDa(t, c.conversa);
      t.igual([lb?.tipo, lb?.status], ["lembrete", "pendente"], "o lembrete armado");
      const wamid = await pedirPermissao(t, b, c.conversa);
      const { ultima_do_lead_em: ultima } = await conversaDe(t, c.conversa);
      const [rr] = await servidor(
        t,
        "select public.ligacao_permissao_responder($1, $2, 'aceitou', false, null, now() - interval '2 hours', 'Aceito a ligação') as n",
        [b.cx, wamid],
      );
      t.igual(rr?.n, 1, "a resposta casou com o pedido");
      t.igual(
        ms((await conversaDe(t, c.conversa)).ultima_do_lead_em),
        ms(ultima),
        "a última do lead não muda (o horário da Meta é de antes)",
      );
      await varrer(t);
      t.igual(await estado(t, lb.id), ["pendente", null], "longe da hora, espera");
      await vencerRetorno(t, lb.id);
      t.igual(
        (await prontos(t)).filter((p: Linha) => p.retorno_id === lb.id),
        [],
        "não está pronto",
      );
      await varrer(t);
      t.igual(await retorno(t, lb.id), undefined, "perto da hora, a varredura o apaga");
    });

    it("(ix) a rodada que lê só a resposta ao pedido (a devolução arma sem entrada nova): tem fala do lead e leva o retorno vencido junto", async () => {
      const b = await preparar(t, { gateway: "meta" });
      const c = await comRetorno(t, b, tel(1), await local(t, "now() + interval '1 hour'"));
      const wamid = await pedirPermissao(t, b, c.conversa);
      await responderPermissao(t, b, wamid);
      t.igual(await pegar(t), [], "a resposta sozinha não arma a Nina");
      await assumir(t, b.uAtend, c.conversa);
      await devolver(t, b.uAtend, c.conversa);
      t.ok(
        (await conversaDe(t, c.conversa)).responder_apos,
        "a devolução arma: a resposta ao pedido é a mensagem mais nova",
      );
      await vencerRetorno(t, c.retorno);
      await vencer(t, c.conversa);
      const [rd] = (await pegar(t)).filter((r: Linha) => r.conversa_id === c.conversa);
      t.igual(rd?.retorno_id, c.retorno, "a rodada leva o retorno junto");
      t.igual(
        (
          await t.sql(
            "select tipo::text as tipo from public.mensagens where rodada_id = $1 and direcao = 'entrada'",
            [rd.id],
          )
        ).map((m: Linha) => m.tipo),
        ["permissao_ligacao"],
        "lê só a resposta ao pedido",
      );
      const [{ f }] = await t.sql("select public.rodada_tem_fala_do_lead($1) as f", [rd.id]);
      t.igual(f, true, "tem fala do lead");
      t.igual(await estado(t, c.retorno), ["em_rodada", null]);
    });
  },
);

describe.skipIf(!temFluxo)(
  "banco: retornos, volume e limites da fila (caso 21)",
  { timeout: TEMPO_TESTE },
  () => {
    const t = usarBanco(base);

    /** n conversas da Nina (sem mensagem), com o lead falando há 2 h. */
    async function conversas(n: number, modo = "nina"): Promise<string[]> {
      const linhas = await t.sql(
        `with c as (
         insert into public.contatos (nome, telefone)
         select 'Volume ' || g, '5521' || lpad((g + ${seq * 1000})::text, 9, '0') from generate_series(1, ${n}) g
         returning id)
       insert into public.conversas (contato_id, modo, ultima_do_lead_em)
       select id, '${modo}'::public.conversa_modo, now() - interval '2 hours' from c
       returning id`,
      );
      seq += 1;
      return linhas.map((l: Linha) => l.id as string);
    }

    it(
      "200 retornos e 50 lembretes vencidos: cada um sai uma vez, os retornos antes dos lembretes, e o lead que escreve no meio passa na frente",
      { timeout: 300_000 },
      async () => {
        const b = await preparar(t);
        const cvs = await conversas(250);
        await t.sql(
          `insert into public.retornos (conversa_id, tipo, vence_em, expira_em, marcado_em, motivo)
       select id, case when i <= 200 then 'retorno' else 'lembrete' end::public.retorno_tipo,
              now() - make_interval(secs => i), now() + interval '2 hours', now() - interval '1 hour',
              case when i <= 200 then 'Volume ' || i end
         from unnest($1::uuid[]) with ordinality as x(id, i)`,
          [cvs],
        );
        const ordem: string[] = [];
        let lead: string | null = null;
        let leadNaPegada = -1;
        for (let i = 0; i < 200; i++) {
          const rs = await pegar(t);
          if (rs.length === 0) break;
          t.ok(rs.length <= 3, "no máximo 3 por pegada");
          if (lead && rs.some((r: Linha) => r.conversa_id === lead)) leadNaPegada = i;
          for (const r of rs) ordem.push(r.retorno_id ? `${i}:${r.retorno_id}` : `${i}:lead`);
          await t.como("service_role", null, async (q) => {
            for (const r of rs) await q(sqlConcluir, paramsConcluir(r.id, ["Oi!"], [], 1));
          });
          if (i === 10) {
            const e = await entrada(t, b.cx, tel(1));
            await vencer(t, e.conversa_id);
            lead = e.conversa_id;
            leadNaPegada = -1;
          }
          if (lead && i === 11)
            t.igual(leadNaPegada, 11, "o lead que escreveu entra na pegada seguinte");
        }
        t.igual(leadNaPegada, 11, "o lead entrou na pegada seguinte");
        const [cont] = await t.sql(
          `select count(*) filter (where retorno_id is not null)::int as com,
              count(distinct retorno_id)::int as distintos,
              (select count(*)::int from (select conversa_id from public.rodadas group by conversa_id having count(*) > 1) d) as duplas
         from public.rodadas`,
        );
        t.igual(
          cont,
          { com: 250, distintos: 250, duplas: 0 },
          "cada um uma vez, nenhuma conversa com duas rodadas",
        );
        const [st] = await t.sql(
          `select count(*) filter (where status = 'saindo')::int as saindo, count(*)::int as total from public.retornos`,
        );
        t.igual(st, { saindo: 250, total: 250 }, "todos saindo");
        const tipoDe = new Map(
          (await t.sql("select id, tipo::text as tipo from public.retornos")).map((r: Linha) => [
            r.id as string,
            r.tipo as string,
          ]),
        );
        const pegadaDe = (tipo: string) =>
          ordem
            .filter((o) => !o.endsWith(":lead") && tipoDe.get(o.split(":")[1]!) === tipo)
            .map((o) => Number(o.split(":")[0]));
        t.ok(
          Math.max(...pegadaDe("retorno")) <= Math.min(...pegadaDe("lembrete")),
          "os retornos antes dos lembretes",
        );
      },
    );

    it("p_limite_puras: 0 só faz a faixa 0; 1 faz uma pura; a vaga que sobra é a da faixa 0; o retorno antes do lembrete", async () => {
      const b = await preparar(t);
      const cA = await atendida(t, b, tel(1));
      const cB = await atendida(t, b, tel(2));
      const cC = await atendida(t, b, tel(3));
      const rB = await inserir(t, cB.conversa, { vence: "now() - interval '2 minutes'" });
      const rC = await inserir(t, cC.conversa, { vence: "now() - interval '1 minute'" });
      await entrada(t, b.cx, tel(1));
      await vencer(t, cA.conversa);
      const s0 = await pegar(t, 3, 0);
      t.igual(
        s0.map((r: Linha) => [r.conversa_id, r.retorno_id]),
        [[cA.conversa, null]],
        "só a faixa 0",
      );
      t.igual(
        [await estado(t, rB), await estado(t, rC)],
        [
          ["pendente", null],
          ["pendente", null],
        ],
      );
      const s1 = await pegar(t, 3, 1);
      t.igual(
        s1.map((r: Linha) => r.retorno_id),
        [rB],
        "uma pura: a mais antiga",
      );
      // limite 1 com a faixa 0 cheia: nenhuma pura
      const cD = await atendida(t, b, tel(4));
      await entrada(t, b.cx, tel(4));
      await vencer(t, cD.conversa);
      const s2 = await pegar(t, 1, 1);
      t.igual(
        s2.map((r: Linha) => [r.conversa_id, r.retorno_id]),
        [[cD.conversa, null]],
        "a vaga é do lead",
      );
      t.igual(await estado(t, rC), ["pendente", null]);
      // o retorno antes do lembrete, mesmo com o lembrete mais antigo
      const cE = await atendida(t, b, tel(5));
      await inserir(t, cE.conversa, { tipo: "lembrete", vence: "now() - interval '30 minutes'" });
      const s3 = await pegar(t, 3, 1);
      t.igual(
        s3.map((r: Linha) => r.retorno_id),
        [rC],
        "o retorno ganha do lembrete",
      );
    });

    it("um defeito nas partes novas nunca segura a resposta ao lead (B1)", async () => {
      const b = await preparar(t);
      const cA = await atendida(t, b, tel(1));
      const cB = await atendida(t, b, tel(2));
      const rB = await inserir(t, cB.conversa);
      const rA = await inserir(t, cA.conversa);
      await quebrar(t, "retornos_prontos");
      await quebrar(t, "rodada_tem_fala_do_lead");
      await quebrar(t, "retornos_varrer");
      const e = await entrada(t, b.cx, tel(1));
      await vencer(t, cA.conversa);
      const rs = await pegar(t);
      t.igual(
        rs.map((r: Linha) => [r.conversa_id, r.retorno_id]),
        [[cA.conversa, null]],
        "a faixa 0 inteira, sem as novas",
      );
      t.igual(
        (
          await t.sql(
            "select id from public.mensagens where rodada_id = $1 and direcao = 'entrada'",
            [rs[0].id],
          )
        ).map((m: Linha) => m.id),
        [e.mensagem_id],
        "as entradas ligadas",
      );
      t.igual(
        [await estado(t, rA), await estado(t, rB)],
        [
          ["pendente", null],
          ["pendente", null],
        ],
      );
    });

    it("uma rodada rodando criada por fora numa conversa candidata não derruba a pegada (sem 23505)", async () => {
      const b = await preparar(t);
      const cA = await atendida(t, b, tel(1));
      const cB = await atendida(t, b, tel(2));
      await inserir(t, cA.conversa);
      const rB = await inserir(t, cB.conversa);
      await t.sql("insert into public.rodadas (conversa_id, status) values ($1, 'rodando')", [
        cA.conversa,
      ]);
      const rs = await pegar(t);
      t.igual(
        rs.map((r: Linha) => r.retorno_id),
        [rB],
      );
    });

    it("a varredura de centenas: respeita o p_max e fecha tudo em poucas chamadas", async () => {
      await preparar(t);
      const cvs = await conversas(120, "humano");
      await t.sql(
        `insert into public.retornos (conversa_id, tipo, vence_em, expira_em, motivo)
       select id, 'retorno', now() - interval '1 minute', now() + interval '1 hour', 'Volume' from unnest($1::uuid[]) id`,
        [cvs],
      );
      t.igual(await varrer(t, 50), 50, "50 por chamada");
      t.igual(await contar(t, "select 1 from public.retornos where status = 'pendente'"), 70);
      t.igual(await varrer(t, 500), 70);
      t.igual(
        await contar(
          t,
          "select 1 from public.retornos where status = 'nao_enviado' and nao_enviado_motivo = 'com_equipe'",
        ),
        120,
      );
      t.igual(await varrer(t, 500), 0, "nada mais");
    });

    it("a varredura (I11a): o item que estoura deixa um aviso, fica fora da contagem e não derruba os outros itens nem a passada seguinte", async () => {
      await preparar(t);
      const [h1, h2, h3] = (await conversas(3, "humano")) as [string, string, string];
      const [c1, f1, f2] = (await conversas(3)) as [string, string, string];
      const vencido = { vence: "now() - interval '1 minute'", expira: "now() + interval '1 hour'" };
      const rA1 = await inserir(t, h1, vencido); // passo A (com a equipe na hora): estoura
      const rA2 = await inserir(t, h2, vencido); // passo A
      const rC = await inserir(t, c1, {
        vence: "now() - interval '4 hours'",
        expira: "now() - interval '1 minute'",
      }); // passo C
      /** Um órfão (passo F): em_rodada numa rodada que já falhou, sem bolha. */
      const orfao = async (conversa: string) => {
        const [{ id: rd }] = await t.sql(
          `insert into public.rodadas (conversa_id, status, iniciada_em, terminada_em)
         values ($1, 'falhou', now() - interval '2 minutes', now() - interval '1 minute') returning id`,
          [conversa],
        );
        const id = await inserir(t, conversa, vencido);
        await t.sql(
          "update public.retornos set status = 'em_rodada', rodada_id = $2, tentativas = 1 where id = $1",
          [id, rd],
        );
        return id;
      };
      const rF1 = await orfao(f1); // estoura
      const rF2 = await orfao(f2);
      // o defeito, só neste banco de teste: a linha de rA1 e a de rF1 não podem mudar
      await t.sql(`
      create function public.teste_estoura() returns trigger language plpgsql as $f$
      begin
        if old.id = any (array['${rA1}', '${rF1}']::uuid[]) then
          raise exception 'estoura_de_proposito';
        end if;
        return coalesce(new, old);
      end;
      $f$;
      create trigger zz_teste_estoura before update or delete on public.retornos
        for each row execute function public.teste_estoura();
    `);
      const avisosDa = (avisos: string[]) =>
        avisos.filter((a) => a.startsWith("retornos_varrer_item_falhou")).sort();
      const esperados = [
        `retornos_varrer_item_falhou: A ${rA1}: estoura_de_proposito`,
        `retornos_varrer_item_falhou: F ${rF1}: estoura_de_proposito`,
      ].sort();

      const p1 = await varrerComAvisos(t);
      t.igual(p1.n, 3, "a contagem: só os três que mudaram (A2, C e F2)");
      t.igual(
        avisosDa(p1.avisos),
        esperados,
        "um aviso por item que estourou, com o passo, o id e o erro",
      );
      t.igual(
        await estado(t, rA2),
        ["nao_enviado", "com_equipe"],
        "A: o outro item do mesmo passo",
      );
      t.igual(await estado(t, rC), ["nao_enviado", "passou_do_prazo"], "C: o passo seguinte");
      t.igual(await estado(t, rF2), ["pendente", null], "F: o outro órfão volta a pendente");
      t.igual(await estado(t, rA1), ["pendente", null], "o que estourou no A fica como estava");
      t.igual(await estado(t, rF1), ["em_rodada", null], "o que estourou no F fica como estava");

      // a passada seguinte: o item novo é tratado, e os dois com defeito avisam de novo
      const rA3 = await inserir(t, h3, vencido);
      const p2 = await varrerComAvisos(t);
      t.igual(p2.n, 1, "a passada seguinte trata o item novo");
      t.igual(await estado(t, rA3), ["nao_enviado", "com_equipe"]);
      t.igual(avisosDa(p2.avisos), esperados, "os mesmos avisos");

      // sem o defeito, a passada seguinte fecha os dois
      await t.sql("drop trigger zz_teste_estoura on public.retornos");
      const p3 = await varrerComAvisos(t);
      t.igual([p3.n, avisosDa(p3.avisos)], [2, []], "sem o defeito: os dois, sem aviso");
      t.igual(await estado(t, rA1), ["nao_enviado", "com_equipe"]);
      t.igual(await estado(t, rF1), ["pendente", null]);
    });

    it("a varredura (I11a): o item que estoura nos passos B, C, D e E também deixa um aviso e não segura os vizinhos do mesmo passo", async () => {
      await preparar(t, { gateway: "meta" });
      const [b1, b2, c1, c2, d1, d2, e1, e2, e3, e4] = (await conversas(10)) as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      // B e o 2º E: a janela oficial fechada (a última do lead há 25 h)
      await t.sql(
        "update public.conversas set ultima_do_lead_em = now() - interval '25 hours' where id = any ($1::uuid[])",
        [[b1, b2, e3, e4]],
      );
      // D: a conversa devolvida depois de armar (o lembrete longe da hora)
      await t.sql("update public.conversas set devolvida_em = now() where id = any ($1::uuid[])", [
        [d1, d2],
      ]);
      const vencido = { vence: "now() - interval '1 minute'", expira: "now() + interval '1 hour'" };
      const prazo = { vence: "now() - interval '4 hours'", expira: "now() - interval '1 minute'" };
      const lembrete = (vence: string, expira: string) => ({
        tipo: "lembrete",
        vence,
        expira,
        marcado: "now() - interval '1 hour'",
      });
      const rB1 = await inserir(t, b1, vencido); // estoura
      const rB2 = await inserir(t, b2, vencido);
      const rC1 = await inserir(t, c1, prazo); // estoura
      const rC2 = await inserir(t, c2, prazo);
      const rD1 = await inserir(
        t,
        d1,
        lembrete("now() + interval '2 hours'", "now() + interval '3 hours'"),
      ); // estoura
      const rD2 = await inserir(
        t,
        d2,
        lembrete("now() + interval '2 hours'", "now() + interval '3 hours'"),
      );
      const rE1 = await inserir(
        t,
        e1,
        lembrete("now() - interval '4 hours'", "now() - interval '1 minute'"),
      ); // estoura
      const rE2 = await inserir(
        t,
        e2,
        lembrete("now() - interval '4 hours'", "now() - interval '1 minute'"),
      );
      const rE3 = await inserir(
        t,
        e3,
        lembrete("now() - interval '1 minute'", "now() + interval '1 hour'"),
      ); // estoura
      const rE4 = await inserir(
        t,
        e4,
        lembrete("now() - interval '1 minute'", "now() + interval '1 hour'"),
      );
      const estouram = [rB1, rC1, rD1, rE1, rE3];
      await t.sql(`
      create function public.teste_estoura() returns trigger language plpgsql as $f$
      begin
        if old.id = any (array['${estouram.join("','")}']::uuid[]) then
          raise exception 'estoura_de_proposito';
        end if;
        return coalesce(new, old);
      end;
      $f$;
      create trigger zz_teste_estoura before update or delete on public.retornos
        for each row execute function public.teste_estoura();
    `);
      const avisosDa = (avisos: string[]) =>
        avisos.filter((a) => a.startsWith("retornos_varrer_item_falhou")).sort();
      const esperados = [
        `retornos_varrer_item_falhou: B ${rB1}: estoura_de_proposito`,
        `retornos_varrer_item_falhou: C ${rC1}: estoura_de_proposito`,
        `retornos_varrer_item_falhou: D ${rD1}: estoura_de_proposito`,
        `retornos_varrer_item_falhou: E ${rE1}: estoura_de_proposito`,
        `retornos_varrer_item_falhou: E ${rE3}: estoura_de_proposito`,
      ].sort();
      const p1 = await varrerComAvisos(t);
      t.igual(
        avisosDa(p1.avisos),
        esperados,
        "um aviso por item que estourou, com o passo, o id e o erro",
      );
      t.igual(p1.n, 5, "a contagem: só os cinco vizinhos que mudaram");
      t.igual(await estado(t, rB2), ["nao_enviado", "fora_24h"], "B: o vizinho");
      t.igual(await estado(t, rC2), ["nao_enviado", "passou_do_prazo"], "C: o vizinho");
      t.igual(await retorno(t, rD2), undefined, "D: o vizinho apagado");
      t.igual(await estado(t, rE2), ["nao_enviado", "passou_do_prazo"], "o 1º E: o vizinho");
      t.igual(await estado(t, rE4), ["nao_enviado", "fora_24h"], "o 2º E: o vizinho");
      for (const id of estouram)
        t.igual(await estado(t, id), ["pendente", null], `o que estourou fica como estava (${id})`);
      // sem o defeito, a passada seguinte fecha os cinco, sem aviso
      await t.sql("drop trigger zz_teste_estoura on public.retornos");
      const p2 = await varrerComAvisos(t);
      t.igual([p2.n, avisosDa(p2.avisos)], [5, []], "sem o defeito: os cinco, sem aviso");
      t.igual(await estado(t, rB1), ["nao_enviado", "fora_24h"]);
      t.igual(await estado(t, rC1), ["nao_enviado", "passou_do_prazo"]);
      t.igual(await retorno(t, rD1), undefined);
      t.igual(await estado(t, rE1), ["nao_enviado", "passou_do_prazo"]);
      t.igual(await estado(t, rE3), ["nao_enviado", "fora_24h"]);
    });

    it("a varredura (I11a): o item que estoura no passo G (saindo) não segura os outros", async () => {
      const b = await preparar(t);
      // dois retornos saindo (a rodada pura concluiu e a bolha está na fila)
      const conversas2 = [
        (await atendida(t, b, tel(1))).conversa,
        (await atendida(t, b, tel(2))).conversa,
      ];
      const rts = [await inserir(t, conversas2[0]!), await inserir(t, conversas2[1]!)];
      const puras = await pegar(t);
      const [g1, g2] = rts.map((rt, i) => {
        const pura = puras.find((r: Linha) => r.conversa_id === conversas2[i]);
        t.igual(pura?.retorno_id, rt, `a rodada pura ${i + 1}`);
        return { rt, pura: pura.id as string };
      }) as [{ rt: string; pura: string }, { rt: string; pura: string }];
      for (const g of [g1, g2]) {
        await concluir(t, g.pura, ["Oi! Como combinamos..."], [responder("nao")]);
        t.igual(await estado(t, g.rt), ["saindo", null]);
      }
      // as duas bolhas saem com os gatilhos desligados (só neste banco de teste): os retornos ficam
      // saindo, e quem os fecha é a varredura G
      await t.sql("set session_replication_role = replica");
      try {
        await t.sql(
          "update public.mensagens set status = 'enviada', status_em = now(), momento = now() where rodada_id = any ($1::uuid[]) and direcao = 'saida'",
          [[g1.pura, g2.pura]],
        );
      } finally {
        await t.sql("set session_replication_role = origin");
      }
      t.igual(
        [await estado(t, g1.rt), await estado(t, g2.rt)],
        [
          ["saindo", null],
          ["saindo", null],
        ],
        "ainda saindo",
      );
      await quebrarPara(t, "retorno_pelas_bolhas", g1.rt);
      const p = await varrerComAvisos(t);
      t.igual(p.n, 1, "só o que mudou");
      t.igual(
        p.avisos.filter((a) => a.startsWith("retornos_varrer_item_falhou")),
        [`retornos_varrer_item_falhou: G ${g1.rt}: quebrada_de_proposito`],
        "o aviso do G",
      );
      t.igual(await estado(t, g2.rt), ["enviado", null], "o outro sai como enviado");
      t.igual(await estado(t, g1.rt), ["saindo", null], "o que estourou fica saindo");
    });
  },
);

// ---------------------------------------------------------------------------
// preparar_copia e o relógio novo (nina_retornos_relogio)
// ---------------------------------------------------------------------------

// Não depende do fluxo: depois da volta atrás pesada, a preparar_copia dos dois jobs continua.
describe.skipIf(!temRelogio || !temFuncoes)(
  "banco: retornos, a preparar_copia com os dois jobs (nina_retornos_relogio)",
  { timeout: TEMPO_TESTE },
  () => {
    const t = usarBanco(base);
    const JOBS = [
      {
        jobname: "nina-relogio",
        schedule: "17 * * * *",
        command: "select public.manutencao_nina()",
        username: "dono_app",
        active: true,
      },
      {
        jobname: "nina-retornos",
        schedule: "* * * * *",
        command: "select public.relogio_retornos()",
        username: "dono_app",
        active: true,
      },
    ];
    const jobs = () =>
      t.sql("select jobname, schedule, command, username, active from cron.job order by jobname");
    const prepararCopia = async () =>
      (await t.como("service_role", null, (q) => q("select public.preparar_copia() as r")))[0]
        .r as string;
    const versao = async () =>
      (await t.sql("select relogio_versao as v from public.motor"))[0].v as number;

    it("no original: preparada instala os dois jobs e grava a versão 1; a 2ª chamada dá pronta", async () => {
      t.igual(await versao(), 0);
      t.igual(await prepararCopia(), "preparada");
      t.igual(await jobs(), JOBS);
      t.igual(await versao(), 1);
      t.igual(await prepararCopia(), "pronta");
      t.igual(await jobs(), JOBS, "sem duplicar");
    });

    it("em produção (relógio antigo de 1 h e versão 0): a próxima chamada instala os dois, sem esperar 1 dia", async () => {
      t.igual(await prepararCopia(), "preparada");
      await t.sql("delete from cron.job where jobname = 'nina-retornos'");
      await t.sql(
        "update public.motor set relogio_versao = 0, relogio_em = now() - interval '1 hour'",
      );
      t.igual(await prepararCopia(), "preparada", "a versão 0 refaz");
      t.igual(await jobs(), JOBS);
      t.igual(await versao(), 1);
      t.igual(await prepararCopia(), "pronta");
    });

    it("relógio vencido (mais de 1 dia) com a versão 1: refaz os dois, sem duplicar", async () => {
      t.igual(await prepararCopia(), "preparada");
      await t.sql("delete from cron.job");
      await t.sql("update public.motor set relogio_em = now() - interval '23 hours'");
      t.igual(await prepararCopia(), "pronta", "com menos de 1 dia não refaz");
      await t.sql("update public.motor set relogio_em = now() - interval '25 hours'");
      t.igual(await prepararCopia(), "preparada");
      t.igual(await jobs(), JOBS);
    });

    it("com o cron recusado: nenhum dos dois, relogio_em nulo e a versão 0; com o cron de volta, os dois", async () => {
      await t.sql("revoke execute on function cron.schedule(text, text, text) from dono_app");
      try {
        t.igual(await prepararCopia(), "preparada");
        t.igual(await jobs(), [], "nenhum job (o cron recusa os dois)");
        const [l] = await t.sql("select relogio_em, relogio_versao from public.motor");
        t.igual([l.relogio_em, l.relogio_versao], [null, 0]);
      } finally {
        await t.sql("grant execute on function cron.schedule(text, text, text) to dono_app");
      }
      t.igual(await prepararCopia(), "preparada");
      t.igual(await jobs(), JOBS);
      t.igual(await versao(), 1);
    });

    it("só o nina-retornos recusado: o nina-relogio de hoje fica, a versão não sobe e a chamada seguinte instala o 2º", async () => {
      // só no banco de teste: o cron recusa o job nina-retornos e aceita o nina-relogio
      await t.sql(
        "alter table cron.job add constraint so_o_relogio check (jobname is distinct from 'nina-retornos')",
      );
      try {
        t.igual(await prepararCopia(), "preparada");
        t.igual(await jobs(), [JOBS[0]], "só o nina-relogio (blocos separados)");
        const [l] = await t.sql("select relogio_em, relogio_versao from public.motor");
        t.ok(l.relogio_em instanceof Date, "relogio_em do nina-relogio");
        t.igual(l.relogio_versao, 0, "a versão não sobe sem os dois");
      } finally {
        await t.sql("alter table cron.job drop constraint so_o_relogio");
      }
      t.igual(await prepararCopia(), "preparada", "a versão 0 refaz");
      t.igual(await jobs(), JOBS, "os dois, sem duplicar");
      t.igual(await versao(), 1);
      t.igual(await prepararCopia(), "pronta");
    });

    it("o tempo real continua com as mesmas tabelas, sem retornos (B10)", async () => {
      t.igual(await prepararCopia(), "preparada");
      const lista = (
        await t.sql(
          "select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'",
        )
      ).map((r: Linha) => r.tablename as string);
      t.ok(!lista.includes("retornos"), "retornos fora");
      const [{ tem }] = await t.sql("select to_regclass('public.ligacoes') is not null as tem");
      t.igual(lista.length, tem ? 9 : 8, "as tabelas do tempo real");
    });

    it("o comando de cada job é um select de uma função do public e roda como o dono", async () => {
      t.igual(await prepararCopia(), "preparada");
      for (const j of await jobs()) {
        t.ok(
          /^select public\.[a-z_]+\(\)$/.test(j.command),
          `${j.jobname}: o comando é um select de uma função do public`,
        );
        t.ok(
          !/http|net\./i.test(j.command),
          `${j.jobname}: o comando é um select de uma função do public`,
        );
        await comoDono(t, j.command);
      }
    });
  },
);

// ---------------------------------------------------------------------------
// os arquivos dos envios: texto, idempotência e travas
// ---------------------------------------------------------------------------

// Os 6 envios, na ordem em que são aplicados. O nina_retornos_dashboard não depende do
// nina_retornos_regras, do nina_retornos_funcoes, do nina_retornos_rodada nem do
// nina_retornos_relogio; o nina_retornos_relogio exige ele (trava falta_nina_retornos_dashboard). Os
// grupos abaixo o incluem quando o arquivo está presente.
const NOMES_ENVIOS = [
  "nina_retornos_tabelas",
  "nina_retornos_regras",
  "nina_retornos_funcoes",
  "nina_retornos_rodada",
  "nina_retornos_dashboard",
  "nina_retornos_relogio",
];
const envios = () =>
  [arqTabelas, arqRegras, arqFuncoes, arqRodada, arqDashboard, arqRelogio].filter(
    (a): a is string => !!a,
  );
// Os envios e, quando existe, a volta atrás pesada: ela também pode ir ao agente do Lovable como um
// envio (com OK do Davi), e segue as mesmas regras de texto (não tem a posição "envio N de 6").
const enviosEDesfazer = () => [
  ...envios(),
  ...(ARQ_DESFAZER && existsSync(ARQ_DESFAZER) ? [ARQ_DESFAZER] : []),
];
const DASHBOARD = "public.dashboard_periodo(timestamptz, timestamptz, timestamptz)";

// Pula só sem nenhum envio; cada prova olha os arquivos que existem (no estado que vai primeiro ao
// Lovable, só os três primeiros).
describe.skipIf(!arqTabelas)(
  "banco: retornos, o texto dos envios",
  { timeout: TEMPO_TESTE },
  () => {
    const t = usarBanco(base);
    const ler = async (a: string | undefined) => {
      const bruto = await readFile(a ?? "", "utf8");
      return { bruto, texto: bruto.replace(/--[^\n]*/g, "") };
    };

    it("o nina_retornos_tabelas, o nina_retornos_regras, o nina_retornos_funcoes, o nina_retornos_rodada, o nina_retornos_dashboard e a volta atrás pesada não falam com o cron; o nina_retornos_relogio não faz pedido HTTP, não chama a acordar_motor e não lê cron.job", async () => {
      for (const a of enviosEDesfazer().filter((x) => x !== arqRelogio)) {
        const { texto } = await ler(a);
        t.igual(/\bcron\./i.test(texto), false, `${basename(a)}: sem cron.`);
      }
      if (!arqRelogio) return;
      const { bruto, texto } = await ler(arqRelogio);
      t.igual(
        /\bnet\./i.test(bruto),
        false,
        "o nina_retornos_relogio sem net. (nem em comentário)",
      );
      // o comentário descreve a cadeia às claras (D4: nina-retornos → relogio_retornos → acordar_motor);
      // o código do nina_retornos_relogio não a chama
      t.igual(
        /acordar_motor/i.test(texto),
        false,
        "o nina_retornos_relogio não chama a acordar_motor",
      );
      t.ok(
        /relogio_retornos[\s\S]*acordar_motor/i.test(bruto),
        "o cabeçalho do nina_retornos_relogio descreve a cadeia até a acordar_motor",
      );
      t.igual(/cron\.job/i.test(bruto), false, "o nina_retornos_relogio não lê cron.job");
      t.igual(
        (texto.match(/cron\.[a-z_]+/gi) ?? []).map((s) => s.toLowerCase()),
        ["cron.schedule", "cron.schedule"],
        "do cron, só os dois cron.schedule",
      );
      t.ok(
        texto.includes(
          "cron.schedule('nina-relogio', '17 * * * *', 'select public.manutencao_nina()')",
        ),
        "o relógio de hoje",
      );
      t.ok(
        texto.includes(
          "cron.schedule('nina-retornos', '* * * * *', 'select public.relogio_retornos()')",
        ),
        "o relógio dos retornos",
      );
    });

    it("nenhum envio (nem a volta atrás pesada) junta cron.schedule com net.http_post, lê cron.job, toca o cofre, os buckets ou a publicação", async () => {
      for (const a of enviosEDesfazer()) {
        const { bruto, texto } = await ler(a);
        const nome = basename(a);
        t.igual(
          /cron\.schedule/i.test(bruto) && /net\.http_post/i.test(bruto),
          false,
          `${nome}: cron.schedule e net.http_post juntos`,
        );
        t.igual(/cron\.job/i.test(bruto), false, `${nome}: cron.job`);
        t.igual(/\bvault\./i.test(texto), false, `${nome}: vault`);
        t.igual(/storage\.buckets/i.test(texto), false, `${nome}: storage.buckets`);
        if (a === arqRelogio) {
          t.igual(
            /alter\s+publication[^;]*\bretornos\b/i.test(texto),
            false,
            `${nome}: retornos no tempo real (B10)`,
          );
          t.igual(
            /'retornos'/.test(texto),
            false,
            `${nome}: 'retornos' na lista do tempo real (B10)`,
          );
        } else {
          t.igual(/alter\s+publication/i.test(texto), false, `${nome}: tempo real (B10)`);
        }
        t.igual(/^\s*(begin|commit)\s*;/im.test(texto), false, `${nome}: sem BEGIN/COMMIT`);
      }
    });

    // A maior migration que o agente do Lovable já aplicou tinha 57,5 KB (o motivo da divisão em 6).
    it("cada envio (e a volta atrás pesada) cabe no que o agente do Lovable já aplicou e o cabeçalho diz de que depende, a ordem e quando vai", async () => {
      for (const a of enviosEDesfazer()) {
        const { bruto } = await ler(a);
        const nome = basename(a);
        t.ok(
          Buffer.byteLength(bruto, "utf8") < 57_500,
          `${nome}: ${Buffer.byteLength(bruto, "utf8")} bytes (o limite é 57.500)`,
        );
        t.ok(/Depende de:/.test(bruto), `${nome}: o cabeçalho diz "Depende de:"`);
        t.ok(/Ordem:/.test(bruto), `${nome}: o cabeçalho diz "Ordem:"`);
        t.ok(
          /Quando vai ao agente do Lovable/.test(bruto),
          `${nome}: o cabeçalho diz "Quando vai ao agente do Lovable"`,
        );
      }
    });

    it("a 1ª linha de cada envio diz o nome e a posição (envio N de 6); no resto do texto, nenhum envio é citado pelo número", async () => {
      for (const [i, nome] of NOMES_ENVIOS.entries()) {
        const a = acharArquivo(nome);
        if (!a) continue; // o envio que ainda não existe neste estado (a montagem cobra a ordem)
        const linhas = (await ler(a)).bruto.split("\n");
        // A ferramenta de migration do Lovable só aceita um job de minuto se a 1ª linha do arquivo
        // for o comentário de revisão dela; o cabeçalho do envio vem logo depois. Só o
        // nina_retornos_relogio agenda job de minuto.
        const revisada = linhas[0]?.startsWith("-- lovable-cron-fallback-reviewed:") ?? false;
        t.igual(
          revisada,
          nome === "nina_retornos_relogio",
          `${basename(a)}: a linha de revisão do Lovable só no envio do job de minuto`,
        );
        if (revisada) linhas.shift();
        const [primeira = "", ...resto] = linhas;
        const esperado = `-- ${nome} (envio ${i + 1} de ${NOMES_ENVIOS.length} dos retornos,`;
        t.ok(
          primeira.startsWith(esperado),
          `${basename(a)}: a 1ª linha devia começar com "${esperado}"; veio "${primeira}"`,
        );
        // "envio 4 das ligações" é de outra entrega, no texto da base que a preparar_copia herda (e
        // quebra a linha antes de "ligações")
        const porNumero = resto.join("\n").match(/\benvios?\s+\d+(?![\s\d]*das\b)/gi) ?? [];
        t.igual(porNumero, [], `${basename(a)}: envio citado pelo número (cite pelo nome)`);
      }
    });

    // O nina_retornos_tabelas foi aplicado sem a coluna das horas do lembrete armado; a revisão das
    // funções a pediu depois, e ela nasce no começo do nina_retornos_regras.
    it("a coluna retornos.lembrete_horas e o check: nunca no nina_retornos_tabelas (o texto aplicado); no nina_retornos_regras, depois da trava e antes da 1ª função, e o cabeçalho diz", async () => {
      const { texto: tab } = await ler(arqTabelas);
      const nomeTab = basename(arqTabelas!);
      t.igual(
        /\bretornos_lembrete_horas\b/i.test(tab),
        false,
        `${nomeTab}: sem o check retornos_lembrete_horas`,
      );
      t.igual(
        /alter\s+table\s+public\.retornos\s+add\s+column/i.test(tab),
        false,
        `${nomeTab}: sem add column em retornos`,
      );
      const criaRetornos =
        tab.match(
          /create\s+table\s+if\s+not\s+exists\s+public\.retornos\s*\([\s\S]*?\n\);/i,
        )?.[0] ?? "";
      t.ok(criaRetornos.length > 0, `${nomeTab}: o create table de retornos`);
      t.igual(
        /lembrete_horas/i.test(criaRetornos),
        false,
        `${nomeTab}: o create table de retornos sem a lembrete_horas`,
      );
      if (!arqRegras) return;
      const { bruto, texto } = await ler(arqRegras);
      const nome = basename(arqRegras);
      const inicioTrava = texto.search(/\bdo\s+\$\$/i);
      const fimTrava = texto.indexOf("$$;", inicioTrava);
      const trava = texto.slice(inicioTrava, fimTrava);
      const coluna = texto.search(
        /alter\s+table\s+public\.retornos\s+add\s+column\s+if\s+not\s+exists\s+lembrete_horas\s+integer\s*;/i,
      );
      const tira = texto.search(
        /alter\s+table\s+public\.retornos\s+drop\s+constraint\s+if\s+exists\s+retornos_lembrete_horas\s*;/i,
      );
      const check = texto.search(
        /alter\s+table\s+public\.retornos\s+add\s+constraint\s+retornos_lembrete_horas\s+check\s*\(\s*lembrete_horas\s+is\s+null\s+or\s+\(\s*tipo\s*=\s*'lembrete'\s+and\s+lembrete_horas\s+between\s+1\s+and\s+23\s*\)\s*\)\s*;/i,
      );
      const primeiraFuncao = texto.search(/create\s+or\s+replace\s+function/i);
      t.ok(inicioTrava >= 0 && fimTrava > inicioTrava, `${nome}: a trava no começo`);
      t.ok(coluna > fimTrava, `${nome}: a coluna depois da trava`);
      t.ok(
        tira > coluna && check > tira,
        `${nome}: o check (drop if exists e add) depois da coluna`,
      );
      t.ok(
        check < primeiraFuncao,
        `${nome}: a coluna e o check antes da 1ª função (a retornos_prontos, de language sql, a lê na criação)`,
      );
      t.igual(
        /table_name\s*=\s*'retornos'\s+and\s+column_name\s*=\s*'lembrete_horas'/i.test(trava),
        false,
        `${nome}: a trava não exige a coluna que o próprio envio cria`,
      );
      const cabecalho = bruto.slice(0, bruto.search(/^(?!--)/m));
      t.ok(
        /retornos\.lembrete_horas/.test(cabecalho),
        `${nome}: o cabeçalho diz que este envio acrescenta a coluna retornos.lembrete_horas`,
      );
      t.ok(
        /retornos_lembrete_horas/.test(cabecalho),
        `${nome}: o cabeçalho diz que este envio acrescenta o check`,
      );
      t.ok(
        /types\.ts muda/.test(cabecalho),
        `${nome}: o cabeçalho diz que o types.ts muda com ele`,
      );
      t.ok(
        /já estava aplicado/.test(cabecalho),
        `${nome}: o cabeçalho diz por que a coluna não está no nina_retornos_tabelas`,
      );
      t.igual(
        /\bnem\s+coluna\b|\bnenhuma\s+coluna\b/i.test(cabecalho),
        false,
        `${nome}: o cabeçalho não diz que nenhuma coluna muda`,
      );
    });

    // O texto de um envio aplicado não muda mais (o nina_retornos_tabelas: a drizzle 0020 e a base
    // 0042). Um arquivo com o nome dele em NINA_SQL_EXTRA ou em drizzle/migrations tem de ser igual,
    // byte a byte, à cópia na base. (Na cópia de quem remixar, drizzle/migrations nasce vazia: lá só
    // conta o que vier em NINA_SQL_EXTRA.)
    it("o envio já na base não muda: todo arquivo com o nome dele (em drizzle/migrations ou em NINA_SQL_EXTRA) é igual, byte a byte, à cópia na base", async () => {
      const naBase = await arquivosBase();
      const drizzle = existsSync(PASTA_MIGRATIONS)
        ? (await readdir(PASTA_MIGRATIONS))
            .filter((f) => /^[0-9]{4}_.*\.sql$/.test(f))
            .map((f) => join(PASTA_MIGRATIONS, f))
        : [];
      for (const nome of NOMES_ENVIOS) {
        const copia = naBase.find((a) => basename(a).includes(nome));
        if (!copia) continue; // ainda não aplicado: o texto pode mudar
        const esperado = await readFile(copia);
        for (const a of [...drizzle, ...extras].filter((x) => basename(x).includes(nome))) {
          t.igual(
            (await readFile(a)).equals(esperado),
            true,
            `${a}: igual, byte a byte, à cópia na base (${basename(copia)})`,
          );
        }
      }
    });
  },
);

describe.skipIf(!provaTrava)(
  "banco: retornos, as travas de dependência",
  { timeout: TEMPO_TESTE },
  () => {
    const t = usarBanco(baseSem!);

    const textoDe = async (f: string) =>
      (
        await t.sql(
          `select coalesce((select prosrc from pg_proc where oid = to_regprocedure($1)), '') as s`,
          [f],
        )
      )[0].s as string;
    const CONCLUIR = "public.concluir_rodada(uuid, jsonb, jsonb, integer)";
    const FALHAR = "public.falhar_rodada(uuid, public.motivo_humano, boolean)";
    const quantas = (lista: string[]) =>
      contar(t, "select 1 from pg_proc where proname = any ($1::text[])", [lista]);
    const gatilhos = () =>
      contar(t, "select 1 from pg_trigger where tgname = 'mensagens_saida_do_retorno'");

    it("sem o nina_retornos_tabelas, cada um dos outros cinco é recusado (falta_nina_retornos_tabelas) e não deixa nada", async () => {
      const recriadas = () =>
        Promise.all([CONCLUIR, FALHAR, "public.preparar_copia()", DASHBOARD].map(textoDe));
      const antes = await recriadas();
      for (const a of [arqRegras, arqFuncoes, arqRodada, arqDashboard, arqRelogio]) {
        if (!a) continue;
        await t.erro(t.aplicar(a), "falta_nina_retornos_tabelas");
      }
      t.igual(
        await quantas([...FUNCOES_REGRAS, ...FUNCOES_FUNCOES, GATILHO]),
        0,
        "nenhuma função nova",
      );
      t.igual(await recriadas(), antes, "nenhuma função recriada");
      t.igual(await gatilhos(), 0, "nenhum gatilho");
    });

    it.skipIf(!arqRegras || !arqFuncoes)(
      "o nina_retornos_funcoes sem o nina_retornos_regras é recusado e não deixa nada",
      async () => {
        await t.aplicar(arqTabelas!);
        await t.erro(t.aplicar(arqFuncoes!), "falta_nina_retornos_regras");
        t.igual(await quantas(FUNCOES_FUNCOES), 0);
        await t.aplicar(arqRegras!);
        await t.aplicar(arqFuncoes!);
        t.igual(
          await quantas(FUNCOES_FUNCOES),
          FUNCOES_FUNCOES.length,
          "com o nina_retornos_regras, passa",
        );
      },
    );

    // A coluna das horas do lembrete armado (retornos.lembrete_horas) e o check dela nascem no começo
    // do nina_retornos_regras: o nina_retornos_tabelas já estava aplicado quando a revisão os pediu.
    const colunaHoras = () =>
      contar(
        t,
        `select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'retornos' and column_name = 'lembrete_horas'`,
      );
    const checkHoras = () =>
      contar(
        t,
        `select 1 from pg_constraint
        where conrelid = 'public.retornos'::regclass and conname = 'retornos_lembrete_horas' and contype = 'c'`,
      );

    it.skipIf(!arqRegras)(
      "a coluna retornos.lembrete_horas e o check nascem com o nina_retornos_regras, e não com o nina_retornos_tabelas; aplicado de novo, não duplica",
      async () => {
        await t.aplicar(arqTabelas!);
        t.igual(
          [await colunaHoras(), await checkHoras()],
          [0, 0],
          "o nina_retornos_tabelas (o texto aplicado) não tem a coluna nem o check",
        );
        await t.aplicar(arqRegras!);
        t.igual(
          [await colunaHoras(), await checkHoras()],
          [1, 1],
          "o nina_retornos_regras cria a coluna e o check",
        );
        await t.aplicar(arqRegras!);
        t.igual(
          [await colunaHoras(), await checkHoras()],
          [1, 1],
          "aplicado de novo, sem duplicar",
        );
      },
    );

    it.skipIf(!arqRegras || !arqFuncoes)(
      "o nina_retornos_funcoes sem a coluna retornos.lembrete_horas (do nina_retornos_regras) é recusado com falta_nina_retornos_regras e não deixa nada",
      async () => {
        await t.aplicar(arqTabelas!);
        await t.aplicar(arqRegras!);
        // só no banco de teste: as funções do nina_retornos_regras ficam, a coluna sai (um
        // nina_retornos_regras de antes da revisão que a pediu)
        await t.sql("alter table public.retornos drop column lembrete_horas");
        const e = await t.erro(t.aplicar(arqFuncoes!), "falta_nina_retornos_regras");
        t.ok(
          String((e as { hint?: string }).hint ?? "").includes("retornos.lembrete_horas"),
          "a dica nomeia a coluna que o nina_retornos_regras cria",
        );
        t.igual(await quantas(FUNCOES_FUNCOES), 0, "nenhuma função do nina_retornos_funcoes");
        await t.aplicar(arqRegras!);
        t.igual(
          [await colunaHoras(), await checkHoras()],
          [1, 1],
          "o nina_retornos_regras de novo devolve a coluna e o check",
        );
        await t.aplicar(arqFuncoes!);
        t.igual(await quantas(FUNCOES_FUNCOES), FUNCOES_FUNCOES.length, "com a coluna, passa");
      },
    );

    it.skipIf(!arqRodada)(
      "o nina_retornos_rodada sem o nina_retornos_regras é recusado e não troca a concluir_rodada nem a falhar_rodada nem cria o gatilho",
      async () => {
        await t.aplicar(arqTabelas!);
        const antes = [await textoDe(CONCLUIR), await textoDe(FALHAR)];
        await t.erro(t.aplicar(arqRodada!), "falta_nina_retornos_regras");
        t.igual([await textoDe(CONCLUIR), await textoDe(FALHAR)], antes);
        t.igual(await gatilhos(), 0);
      },
    );

    it.skipIf(!arqRegras || !arqRodada)(
      "o nina_retornos_rodada sem o nina_retornos_funcoes é recusado e não troca a concluir_rodada nem a falhar_rodada nem cria o gatilho",
      async () => {
        await t.aplicar(arqTabelas!);
        await t.aplicar(arqRegras!);
        const antes = [await textoDe(CONCLUIR), await textoDe(FALHAR)];
        await t.erro(t.aplicar(arqRodada!), "falta_nina_retornos_funcoes");
        t.igual([await textoDe(CONCLUIR), await textoDe(FALHAR)], antes);
        t.igual(await gatilhos(), 0);
      },
    );

    it.skipIf(!arqRegras || !arqFuncoes || !arqRodada)(
      "sem a retornos_ligados (um nina_retornos_funcoes de antes dela), o nina_retornos_rodada e o nina_retornos_relogio são recusados",
      async () => {
        await t.aplicar(arqTabelas!);
        await t.aplicar(arqRegras!);
        await t.aplicar(arqFuncoes!);
        await t.sql("drop function public.retornos_ligados()");
        const antes = [await textoDe(CONCLUIR), await textoDe(FALHAR)];
        await t.erro(t.aplicar(arqRodada!), "falta_nina_retornos_funcoes");
        t.igual(
          [await textoDe(CONCLUIR), await textoDe(FALHAR)],
          antes,
          "não troca o fim da rodada",
        );
        t.igual(await gatilhos(), 0, "nem cria o gatilho");
        if (!arqDashboard || !arqRelogio) return;
        await t.aplicar(arqFuncoes!); // devolve a retornos_ligados
        await t.aplicar(arqRodada!);
        await t.aplicar(arqDashboard!);
        await t.sql("drop function public.retornos_ligados()");
        await t.erro(t.aplicar(arqRelogio!), "falta_nina_retornos_funcoes");
        t.ok(
          !(await textoDe("public.preparar_copia()")).includes("nina-retornos"),
          "não troca a preparar_copia",
        );
      },
    );

    it.skipIf(!arqRelogio)(
      "o nina_retornos_relogio sem o nina_retornos_regras é recusado e não troca a preparar_copia",
      async () => {
        await t.aplicar(arqTabelas!);
        await t.erro(t.aplicar(arqRelogio!), "falta_nina_retornos_regras");
        t.ok(!(await textoDe("public.preparar_copia()")).includes("nina-retornos"));
      },
    );

    it.skipIf(!arqRegras || !arqRelogio)(
      "o nina_retornos_relogio sem o nina_retornos_funcoes é recusado e não troca a preparar_copia",
      async () => {
        await t.aplicar(arqTabelas!);
        await t.aplicar(arqRegras!);
        await t.erro(t.aplicar(arqRelogio!), "falta_nina_retornos_funcoes");
        t.ok(!(await textoDe("public.preparar_copia()")).includes("nina-retornos"));
      },
    );

    it.skipIf(!arqRegras || !arqFuncoes || !arqRodada || !arqDashboard || !arqRelogio)(
      "o nina_retornos_relogio sem o nina_retornos_rodada é recusado e não troca a preparar_copia; sem o nina_retornos_dashboard (obrigatório), também; com os dois, passa (os dois jobs provam os cinco)",
      async () => {
        await t.aplicar(arqTabelas!);
        await t.aplicar(arqRegras!);
        await t.aplicar(arqFuncoes!);
        await t.erro(t.aplicar(arqRelogio!), "falta_nina_retornos_rodada");
        t.ok(!(await textoDe("public.preparar_copia()")).includes("nina-retornos"));
        await t.aplicar(arqRodada!);
        const e = await t.erro(t.aplicar(arqRelogio!), "falta_nina_retornos_dashboard");
        t.ok(
          String((e as { hint?: string }).hint ?? "").includes("nina_retornos_dashboard"),
          "a dica nomeia o envio que falta",
        );
        t.ok(
          !(await textoDe("public.preparar_copia()")).includes("nina-retornos"),
          "sem o nina_retornos_dashboard, não troca",
        );
        await t.aplicar(arqDashboard!);
        await t.aplicar(arqRelogio!);
        t.ok(
          (await textoDe("public.preparar_copia()")).includes("nina-retornos"),
          "com o nina_retornos_rodada e o nina_retornos_dashboard, passa",
        );
      },
    );

    it.skipIf(!arqDashboard)(
      "o nina_retornos_dashboard só com o nina_retornos_tabelas é aplicado (não depende dos outros)",
      async () => {
        await t.aplicar(arqTabelas!);
        t.ok(!(await textoDe(DASHBOARD)).includes("retorno_id"), "antes, a de hoje");
        await t.aplicar(arqDashboard!);
        t.ok((await textoDe(DASHBOARD)).includes("retorno_id"), "a dashboard_periodo nova");
        t.igual(
          await quantas([...FUNCOES_REGRAS, ...FUNCOES_FUNCOES, GATILHO]),
          0,
          "nada dos outros envios",
        );
      },
    );

    it("todos os envios na mesma transação, em ordem (o caso do remix), passam pelas travas e funcionam", async () => {
      const partes = await Promise.all(
        envios().map(async (a) => limparSql(await readFile(a, "utf8"))),
      );
      await t.sql("set role dono_app");
      try {
        await t.db.exec(["begin;", ...partes, "commit;"].join("\n"));
      } finally {
        await t.sql("reset role");
      }
      // os envios que existem neste estado (no que vai primeiro ao Lovable, só os três primeiros)
      const todas = [...(arqRegras ? FUNCOES_REGRAS : []), ...(arqFuncoes ? FUNCOES_FUNCOES : [])];
      t.igual(
        await contar(t, "select distinct proname from pg_proc where proname = any ($1::text[])", [
          todas,
        ]),
        todas.length,
      );
      t.igual(
        (await textoDe("public.preparar_copia()")).includes("nina-retornos"),
        !!arqRelogio,
        "a preparar_copia nova, com o nina_retornos_relogio",
      );
      t.igual(
        await gatilhos(),
        arqRodada ? 1 : 0,
        "o gatilho das bolhas, com o nina_retornos_rodada",
      );
      t.igual(
        (await textoDe(DASHBOARD)).includes("retorno_id"),
        !!arqDashboard,
        "a dashboard_periodo, com o nina_retornos_dashboard",
      );
    });

    // ---- a trava dos envios que recriam função do app publicado (funcao_mudou_antes_dos_retornos) ----
    // Cada envio que recria uma função que já existe (o nina_retornos_rodada, o
    // nina_retornos_dashboard e o nina_retornos_relogio) parte do texto mais recente dela na base e
    // confere, antes de recriá-la, que o texto em vigor ainda é esse (h_partida) ou o do próprio envio
    // (h_envio, aplicado de novo).
    //
    // Uma exceção, de 19/11/2026: o nina_retornos_rodada foi aplicado (drizzle 0023, base 0045) com
    // uma linha em branco a menos dentro da falhar_rodada do que o texto revisado (a transcrição do
    // envio a perdeu; o resto do arquivo é igual, byte a byte). O corpo que o arquivo grava não tem o
    // md5 que a trava dele guarda como h_envio. Chave: o h_envio da trava; valor: o md5 do corpo de
    // fato (o mesmo que está em produção e na lista da volta atrás pesada). Por isso esse arquivo
    // não pode ser reaplicado por cima de si mesmo: a trava recusa, sem mudar nada.
    const CORPO_DE_FATO: Record<string, string> = {
      "6aa02d88b2b7b727b0325cf192323957": "1c3d6a2fd5326dd6a154c51d1cbca400",
    };
    const RECRIADAS: {
      arq: string | undefined;
      antes: (string | undefined)[];
      funcoes: string[];
    }[] = [
      {
        arq: arqRodada,
        antes: [arqTabelas, arqRegras, arqFuncoes],
        funcoes: ["concluir_rodada", "falhar_rodada"],
      },
      { arq: arqDashboard, antes: [arqTabelas], funcoes: ["dashboard_periodo"] },
      {
        arq: arqRelogio,
        antes: [arqTabelas, arqRegras, arqFuncoes, arqRodada, arqDashboard],
        funcoes: ["preparar_copia"],
      },
    ];
    const porNome = (a: string[], b: string[]) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0);
    const listaDaTrava = async (arq: string) =>
      [
        ...(await readFile(arq, "utf8")).matchAll(
          /\('([a-z_]+)',\s*'([0-9a-f]{32})',\s*'([0-9a-f]{32})'\)/g,
        ),
      ].map((m) => ({
        nome: m[1]!,
        partida: m[2]!,
        envio: m[3]!,
      }));
    const md5Das = async (nomes: string[]) =>
      (
        await t.sql(
          `select p.proname as nome, md5(p.prosrc) as h from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = any ($1::text[])`,
          [nomes],
        )
      )
        .map((r: Linha) => [r.nome as string, r.h as string])
        .sort(porNome);

    it("a trava de cada envio que recria função conhece o texto: antes dele, o da base (h_partida); depois, o do envio (h_envio)", async () => {
      let conferidas = 0;
      for (const a of envios()) {
        const r = RECRIADAS.find((x) => x.arq === a);
        if (!r) {
          await t.aplicar(a);
          continue;
        }
        const lista = await listaDaTrava(a);
        t.igual(
          lista.map((h) => h.nome).sort(),
          [...r.funcoes].sort(),
          `${basename(a)}: a lista da trava confere as recriadas`,
        );
        const esperado = (campo: "partida" | "envio") =>
          lista.map((h) => [h.nome, h[campo]]).sort(porNome);
        t.igual(
          await md5Das(r.funcoes),
          esperado("partida"),
          `${basename(a)}: antes dele, o texto da base (h_partida)`,
        );
        const acl = async () =>
          t.sql(
            `select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.proacl::text as acl
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = any ($1::text[]) order by 1`,
            [r.funcoes],
          );
        const aclAntes = await acl();
        await t.aplicar(a);
        t.igual(
          await md5Das(r.funcoes),
          lista.map((h) => [h.nome, CORPO_DE_FATO[h.envio] ?? h.envio]).sort(porNome),
          `${basename(a)}: depois dele, o do envio (o corpo mudou e o hash não?)`,
        );
        t.igual(await acl(), aclAntes, `${basename(a)}: a mesma assinatura e os mesmos grants`);
        conferidas += r.funcoes.length;
      }
      t.igual(
        conferidas,
        RECRIADAS.filter((r) => r.arq).reduce((n, r) => n + r.funcoes.length, 0),
        "todas as recriadas conferidas",
      );
    });

    for (const r of RECRIADAS) {
      for (const funcao of r.funcoes) {
        const nomeEnvio = r.arq ? basename(r.arq) : "(ausente)";
        it.skipIf(!r.arq || r.antes.some((a) => !a))(
          `com a ${funcao} recriada por outra entrega antes do envio (${nomeEnvio}), a trava recusa e nada muda`,
          async () => {
            for (const a of r.antes) await t.aplicar(a!);
            // imita uma migration de outra entrega que recriou a função partindo do mesmo texto
            await t.sql(`
            do $q$
            declare f record;
            begin
              select pg_get_function_arguments(p.oid) as args, pg_get_function_result(p.oid) as res, p.prosrc as src,
                     case p.provolatile when 's' then 'stable' when 'i' then 'immutable' else 'volatile' end as vol
                into f
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = '${funcao}';
              execute format('create or replace function public.%I(%s) returns %s language plpgsql %s security definer '
                             || 'set search_path = '''' as %L',
                             '${funcao}', f.args, f.res, f.vol,
                             chr(10) || '  -- 0019: outra entrega mudou esta função' || f.src);
            end;
            $q$;
          `);
            const todas = [
              "concluir_rodada",
              "falhar_rodada",
              "dashboard_periodo",
              "preparar_copia",
              GATILHO,
            ];
            const antes = await md5Das(todas);
            const gatilhosAntes = await gatilhos();
            const e = await t.erro(t.aplicar(r.arq!), "funcao_mudou_antes_dos_retornos");
            t.ok(
              String((e as { hint?: string }).hint ?? "").includes(funcao),
              "a dica nomeia a função",
            );
            t.igual(
              await md5Das(todas),
              antes,
              "nenhuma função mudou de texto (nem a do gatilho das bolhas nasceu)",
            );
            t.igual(await gatilhos(), gatilhosAntes, "nenhum gatilho novo");
          },
        );
      }
    }

    // Por cima da base de antes do nina_retornos_tabelas (e não da base inteira): assim os envios são
    // os últimos aplicados, e uma migration futura que recrie a preparar_copia, a concluir_rodada, a
    // falhar_rodada, a dashboard_periodo ou uma função do nina_retornos_regras ou do
    // nina_retornos_funcoes não muda o que esta prova compara.
    it.skipIf(!arqRegras || !arqFuncoes)(
      "todos os envios aplicados de novo, em ordem, não mudam nada (rodam duas vezes; o nina_retornos_rodada aplicado recusa a 2ª)",
      async () => {
        for (const a of envios()) await t.aplicar(a);
        const b = await preparar(t);
        // com o nina_retornos_rodada (e o relógio da versão 1 do preparar) a Nina marca; sem ele, os
        // retornos estão desligados e o retorno entra direto, como dado de teste
        const c = arqRodada
          ? await comRetorno(t, b, tel(1))
          : {
              retorno: await inserir(t, (await atendida(t, b, tel(1))).conversa, {
                vence: "now() + interval '1 day'",
                expira: "now() + interval '1 day 3 hours'",
              }),
            };
        const fotos = async () =>
          t.sql(
            `select p.proname, md5(p.prosrc) as h, p.proacl::text as acl from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' order by 1, 2`,
          );
        // as colunas e os checks da tabela retornos (o nina_retornos_regras acrescenta a
        // lembrete_horas e refaz o check dela)
        const tabela = async () => ({
          colunas: await t.sql(
            `select column_name, data_type, is_nullable, column_default from information_schema.columns
          where table_schema = 'public' and table_name = 'retornos' order by ordinal_position`,
          ),
          checks: await t.sql(
            `select conname, pg_get_constraintdef(oid) as def from pg_constraint
          where conrelid = 'public.retornos'::regclass and contype = 'c' order by 1`,
          ),
        });
        const antes = await fotos();
        const tabelaAntes = await tabela();
        const recusados: string[] = [];
        for (const a of envios()) {
          // o arquivo cuja trava não conhece o próprio corpo (CORPO_DE_FATO) recusa, sem mudar nada
          if ((await listaDaTrava(a)).some((h) => CORPO_DE_FATO[h.envio])) {
            await t.erro(t.aplicar(a), "funcao_mudou_antes_dos_retornos");
            recusados.push(a);
          } else {
            await t.aplicar(a);
          }
        }
        t.igual(
          recusados.every((a) => a === arqRodada),
          true,
          "só o nina_retornos_rodada aplicado recusa ser reaplicado por cima de si mesmo",
        );
        t.igual(await fotos(), antes, "as mesmas funções, com os mesmos textos e permissões");
        t.igual(await tabela(), tabelaAntes, "as mesmas colunas e os mesmos checks em retornos");
        t.igual(await estado(t, c.retorno), ["pendente", null], "o dado fica");
        const [{ lembrete_ligado, lembrete_horas }] = await t.sql(
          "select lembrete_ligado, lembrete_horas from public.configuracao",
        );
        t.igual([lembrete_ligado, lembrete_horas], [true, 3]);
      },
    );
  },
);

// ---------------------------------------------------------------------------
// a volta atrás pesada (nina_retornos_desfazer.sql, por NINA_SQL_DESFAZER)
// ---------------------------------------------------------------------------

// O cabeçalho do desfazer aceita o banco com o nina_retornos_rodada e sem o nina_retornos_dashboard
// e o nina_retornos_relogio: o grupo roda desde o nina_retornos_rodada; só o teste do relógio (que
// só varre) exige os 6 envios.
describe.skipIf(!temFluxo || !ARQ_DESFAZER || !existsSync(ARQ_DESFAZER))(
  "banco: retornos, a volta atrás pesada",
  { timeout: TEMPO_TESTE },
  () => {
    const t = usarBanco(base);

    it.skipIf(!temTudo)(
      "nenhuma rodada de retorno nasce, o lembrete não arma, o fim da rodada volta ao de hoje; o relógio só varre",
      async () => {
        const b = await preparar(t);
        const c = await comRetorno(t, b, tel(1));
        const c2 = await comRetorno(t, b, tel(2));
        await t.aplicar(ARQ_DESFAZER);
        await t.aplicar(ARQ_DESFAZER); // duas vezes
        // quem executa as 8 recriadas continua o dos envios (o mesmo esperado do "execute por papel")
        const recriadas = [
          "concluir_rodada",
          "falhar_rodada",
          "lembrete_ao_concluir",
          "motor_pendencias_com_retornos",
          "nina_marcar_retorno",
          "pegar_rodadas_com_retornos",
          "relogio_retornos",
          "tg_mensagens_saida_do_retorno",
        ];
        const papeis = await t.sql(
          `select p.proname,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as srv
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = any ($1::text[])
          order by 1`,
          [recriadas],
        );
        const doServidor = ["concluir_rodada", "falhar_rodada", ...SERVIDOR];
        t.igual(
          papeis.map((l: Linha) => [l.proname, l.anon, l.auth, l.srv]),
          recriadas.map((nome) => [
            nome,
            false,
            EQUIPE.includes(nome),
            doServidor.includes(nome) || EQUIPE.includes(nome),
          ]),
          "execute por papel depois do desfazer",
        );
        t.igual(
          await t.sql(
            `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
                  aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where n.nspname = 'public' and p.proname = any ($1::text[]) and a.grantee = 0`,
            [recriadas],
          ),
          [],
          "nada para PUBLIC depois do desfazer",
        );
        const [s] = await t.sql(
          `select pg_get_function_identity_arguments('public.pegar_rodadas_com_retornos(integer, integer)'::regprocedure) as a`,
        );
        t.igual(s.a, "p_limite integer, p_limite_puras integer", "os dois parâmetros ficam");
        for (const f of [
          "public.concluir_rodada(uuid, jsonb, jsonb, integer)",
          "public.falhar_rodada(uuid, public.motivo_humano, boolean)",
        ]) {
          const [{ src }] = await t.sql(
            "select prosrc as src from pg_proc where oid = $1::regprocedure",
            [f],
          );
          t.ok(!/retorno|lembrete/i.test(src), `${f}: o texto de hoje`);
        }
        await vencerRetorno(t, c.retorno);
        t.igual(await pegar(t), [], "nenhuma rodada pura");
        // o código novo republicado sem reaplicar o nina_retornos_funcoes e o nina_retornos_rodada: o
        // retorno parado não acende o atraso
        t.ok(
          (await prontos(t)).some((p: Linha) => p.retorno_id === c.retorno),
          "o retorno parado está pronto",
        );
        t.igual(await pendencias(t), await pendenciasHoje(t), "o atraso é só o de hoje");
        await entrada(t, b.cx, tel(1));
        await vencer(t, c.conversa);
        const [rd] = await pegar(t);
        t.igual(rd.retorno_id, null, "sem levar junto");
        // e a Nina não promete retorno que não sai
        const antesMarcar = await retornosDa(t, c.conversa);
        const q = await amanha(t, "10:00");
        await t.erro(marcar(t, rd.id, q.data, q.hora), "retornos_desligados");
        t.igual(await retornosDa(t, c.conversa), antesMarcar, "nada gravado");
        await concluir(t, rd.id, ["Oi"], [responder("sim")]);
        t.igual(
          await contar(t, "select 1 from public.retornos where tipo = 'lembrete'"),
          0,
          "o lembrete não arma",
        );
        // o relógio: só a varredura
        await assumir(t, b.uAtend, c2.conversa);
        await vencerRetorno(t, c2.retorno);
        await motorPronto(t);
        const antes = await pedidos(t);
        await relogio(t);
        t.igual(await pedidos(t), antes, "sem toque");
        t.igual(await estado(t, c2.retorno), ["nao_enviado", "com_equipe"], "a varredura continua");
      },
    );

    it("com uma rodada de retorno rodando, a trava recusa e nada muda; depois que ela termina, passa", async () => {
      const b = await preparar(t);
      const c = await atendida(t, b, tel(1));
      const rt = await inserir(t, c.conversa);
      const [pura] = await pegar(t);
      t.igual(pura.retorno_id, rt, "a rodada pura rodando");
      const textoDe = async () =>
        (
          await t.sql(
            "select prosrc as src from pg_proc where oid = 'public.falhar_rodada(uuid, public.motivo_humano, boolean)'::regprocedure",
          )
        )[0].src as string;
      const antes = await textoDe();
      await t.erro(t.aplicar(ARQ_DESFAZER), "rodada_de_retorno_rodando");
      t.igual(await textoDe(), antes, "a falhar_rodada continua a dos retornos");
      await concluir(t, pura.id, ["Oi! Como combinamos..."], [responder("nao")]);
      await t.aplicar(ARQ_DESFAZER);
      t.ok(!/retorno|lembrete/i.test(await textoDe()), "aplicado depois que a rodada terminou");
    });

    // As 8 funções que o desfazer recria e a lista de hashes da trava dele (o md5 do corpo do envio e
    // o do corpo que o próprio desfazer grava).
    const OITO = [
      "concluir_rodada",
      "falhar_rodada",
      "lembrete_ao_concluir",
      "motor_pendencias_com_retornos",
      "nina_marcar_retorno",
      "pegar_rodadas_com_retornos",
      "relogio_retornos",
      "tg_mensagens_saida_do_retorno",
    ];
    const porNome = (a: string[], b: string[]) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0);
    const textosDasOito = async () =>
      (
        await t.sql(
          `select p.proname as nome, md5(p.prosrc) as h from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = any ($1::text[])`,
          [OITO],
        )
      )
        .map((r: Linha) => [r.nome as string, r.h as string])
        .sort(porNome);
    const listaDoDesfazer = async () => {
      const texto = await readFile(ARQ_DESFAZER, "utf8");
      const hashes = [
        ...texto.matchAll(/\('([a-z_]+)',\s*'([0-9a-f]{32})',\s*'([0-9a-f]{32})'\)/g),
      ].map((m) => ({
        nome: m[1]!,
        envio: m[2]!,
        desfeito: m[3]!,
      }));
      const recria = [...texto.matchAll(/create or replace function public\.([a-z_]+)\(/g)].map(
        (m) => m[1]!,
      );
      return { hashes, recria };
    };

    it("a trava conhece o texto das 8 funções: com os envios, o md5 do envio; depois do desfazer, o do desfazer", async () => {
      const { hashes, recria } = await listaDoDesfazer();
      t.igual([...recria].sort(), OITO, "o arquivo recria as 8");
      t.igual(hashes.map((h) => h.nome).sort(), OITO, "a trava confere as 8");
      const esperado = (campo: "envio" | "desfeito") =>
        hashes.map((h) => [h.nome, h[campo]]).sort(porNome);
      t.igual(
        await textosDasOito(),
        esperado("envio"),
        "com os envios aplicados: o h_envio de cada uma (um envio mudou e o hash não?)",
      );
      await t.aplicar(ARQ_DESFAZER);
      t.igual(
        await textosDasOito(),
        esperado("desfeito"),
        "depois do desfazer: o h_desfeito de cada uma",
      );
    });

    it("com uma das 8 recriada depois dos envios (uma 0045), a trava recusa e nenhuma muda de texto", async () => {
      // imita uma migration posterior que recria a concluir_rodada partindo do texto do
      // nina_retornos_rodada
      await t.sql(`
        do $q$
        declare s text;
        begin
          select p.prosrc into s from pg_proc p
           where p.oid = 'public.concluir_rodada(uuid, jsonb, jsonb, integer)'::regprocedure;
          execute format('create or replace function public.concluir_rodada(p_rodada uuid, p_respostas jsonb, '
                         || 'p_ferramentas jsonb, p_passos int) returns void language plpgsql security definer '
                         || 'set search_path = '''' as %L',
                         chr(10) || '  -- 0045: outra entrega mudou esta função' || s);
        end;
        $q$;
      `);
      const antes = await textosDasOito();
      const e = await t.erro(t.aplicar(ARQ_DESFAZER), "funcao_mudou_depois_dos_retornos");
      t.ok(
        String((e as { hint?: string }).hint ?? "").includes("concluir_rodada"),
        "a dica nomeia a função",
      );
      t.igual(await textosDasOito(), antes, "nenhuma das 8 mudou de texto");
    });

    it("com o servidor novo no ar (o sinal do worker), a trava recusa e nada muda; depois da passada do antigo, passa", async () => {
      await preparar(t);
      const textoDe = async () =>
        (
          await t.sql(
            "select prosrc as src from pg_proc where oid = 'public.concluir_rodada(uuid, jsonb, jsonb, integer)'::regprocedure",
          )
        )[0].src as string;
      await t.sql(
        "update public.configuracao set worker_visto_em = now() - interval '1 minute', worker_retornos_em = now() - interval '1 minute' where id = 1",
      );
      const antes = await textoDe();
      await t.erro(t.aplicar(ARQ_DESFAZER), "servidor_novo_no_ar");
      t.igual(await textoDe(), antes, "a concluir_rodada continua a dos retornos");
      // a passada do worker antigo: só o worker_visto_em anda
      await t.sql("update public.configuracao set worker_visto_em = now() where id = 1");
      await t.aplicar(ARQ_DESFAZER);
      t.ok(!/retorno|lembrete/i.test(await textoDe()), "aplicado com o servidor antigo no ar");
    });

    // O refazer pela metade: só o nina_retornos_funcoes reaplicado (o nina_retornos_rodada esquecido).
    // A retornos_ligados confere o conteúdo do nina_retornos_rodada, então os retornos ficam
    // desligados até ele voltar.
    it.skipIf(!arqFuncoes || !arqRodada)(
      "refazer pela metade: com só o nina_retornos_funcoes reaplicado depois do desfazer, a irmã só faz a faixa 0 e a Nina não marca (retornos_desligados); com o nina_retornos_rodada, liga de novo",
      async () => {
        const b = await preparar(t);
        await t.aplicar(ARQ_DESFAZER);
        await t.aplicar(arqFuncoes!);
        const ligados = async () =>
          (await comoDono(t, "select public.retornos_ligados() as l"))[0].l as boolean;
        t.igual(await ligados(), false, "desligados: o nina_retornos_rodada não está em vigor");
        const livre = await atendida(t, b, tel(1));
        const rt = await inserir(t, livre.conversa);
        const e = await entrada(t, b.cx, tel(2));
        await vencer(t, e.conversa_id);
        // um retorno de antes, vencido, na conversa em que o lead falou: desligados, não vai junto
        const rtArmada = await inserir(t, e.conversa_id, { marcado: "now() - interval '1 day'" });
        const rs = await pegar(t, 3, 3);
        t.igual(
          rs.map((r: Linha) => [r.conversa_id, r.retorno_id ?? null]),
          [[e.conversa_id, null]],
          "só a faixa 0",
        );
        t.igual(await estado(t, rt), ["pendente", null], "o retorno continua pendente");
        const ar = await retorno(t, rtArmada);
        t.igual(
          [ar.status, ar.rodada_id],
          ["pendente", null],
          "o retorno da conversa do lead não vai junto",
        );
        const q = await amanha(t);
        await t.erro(marcar(t, rs[0].id, q.data, q.hora), "retornos_desligados");
        await t.aplicar(arqRodada!);
        t.igual(await ligados(), true, "com o nina_retornos_rodada de volta, ligados");
      },
    );

    // O refazer do cabeçalho do desfazer: o nina_retornos_funcoes e depois o nina_retornos_rodada.
    it.skipIf(!arqFuncoes || !arqRodada)(
      "refazer: o nina_retornos_rodada sozinho é recusado; o nina_retornos_funcoes e depois ele devolvem as 8 e o fluxo; desfazer de novo passa",
      async () => {
        const { hashes } = await listaDoDesfazer();
        const esperado = (campo: "envio" | "desfeito") =>
          hashes.map((h) => [h.nome, h[campo]]).sort(porNome);
        await t.aplicar(ARQ_DESFAZER);
        t.igual(await textosDasOito(), esperado("desfeito"), "desfeito");
        // a trava do nina_retornos_rodada cobra o nina_retornos_funcoes em vigor
        await t.erro(t.aplicar(arqRodada!), "falta_nina_retornos_funcoes");
        t.igual(
          await textosDasOito(),
          esperado("desfeito"),
          "o nina_retornos_rodada sozinho não muda nada",
        );
        await t.aplicar(arqFuncoes!);
        await t.aplicar(arqRodada!);
        t.igual(await textosDasOito(), esperado("envio"), "refeito: o h_envio de cada uma das 8");
        // o fluxo de volta: o retorno vencido vira rodada pura, e o fim dela o leva às bolhas
        const b = await preparar(t);
        const c = await atendida(t, b, tel(1));
        const rt = await inserir(t, c.conversa);
        const [pura] = await pegar(t);
        t.igual(pura?.retorno_id, rt, "a faixa 1 volta a pegar");
        await concluir(t, pura.id, ["Oi! Como combinamos..."], [responder("nao")]);
        t.igual(
          await estado(t, rt),
          ["saindo", null],
          "o fim da rodada tira o retorno de em_rodada",
        );
        await enviarTudo(t);
        t.igual(await estado(t, rt), ["enviado", null], "e a bolha o fecha");
        await t.aplicar(ARQ_DESFAZER);
        t.igual(await textosDasOito(), esperado("desfeito"), "desfeito de novo");
      },
    );
  },
);

// ---------------------------------------------------------------------------
// o tempo de resposta do Dashboard (nina_retornos_dashboard)
// ---------------------------------------------------------------------------

// Roda com e sem o nina_retornos_dashboard (precisa só de rodadas.retorno_id, do
// nina_retornos_tabelas) e espera cada estado: o mesmo teste prova que o filtro tira a rodada pura e
// que, sem ele, ela conta.
describe.skipIf(!temTabelas)(
  "banco: retornos, o tempo de resposta do Dashboard (nina_retornos_dashboard)",
  { timeout: TEMPO_TESTE },
  () => {
    const t = usarBanco(base);

    it(
      temDashboard
        ? "com o nina_retornos_dashboard: a resposta ao lead, a mista e a rodada comum sem entrada ligada (o pedido de permissão) contam; a rodada pura do retorno, não"
        : "sem o nina_retornos_dashboard: a rodada pura do retorno conta como hoje (o teste distingue os dois estados)",
      async () => {
        const b = await preparar(t);
        const [{ id: novo }] = await t.sql("select id from public.etapas where chave = 'novo'");
        const SP = (s: string) => `2026-10-10T${s}-03:00`;
        const conversa = async (nome: string) => {
          const [{ id: contato }] = await t.sql(
            "insert into public.contatos (nome, etapa_id) values ($1, $2) returning id",
            [nome, novo],
          );
          const [{ id }] = await t.sql(
            "insert into public.conversas (contato_id, conexao_id) values ($1, $2) returning id",
            [contato, b.cx],
          );
          return id as string;
        };
        const rodada = async (conv: string, inicio: string, retorno: boolean) => {
          const [{ id }] = await t.sql(
            `insert into public.rodadas (conversa_id, status, iniciada_em, terminada_em, retorno_id)
           values ($1, 'concluida', $2, $2, case when $3 then gen_random_uuid() end) returning id`,
            [conv, inicio, retorno],
          );
          return id as string;
        };
        const msg = (conv: string, direcao: string, em: string, rodadaId: string | null) =>
          t.sql(
            `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, status, momento, rodada_id, texto)
           values ($1, $2, $3, $4, $5, $6, $7, 'oi')`,
            [
              conv,
              b.cx,
              direcao,
              direcao === "entrada" ? "lead" : "nina",
              direcao === "entrada" ? "recebida" : "enviada",
              em,
              rodadaId,
            ],
          );
        // A: o lead às 10:00:00, a Nina às 10:00:10 (10 s)
        const A = await conversa("Lead A");
        const rA = await rodada(A, SP("10:00:00"), false);
        await msg(A, "entrada", SP("10:00:00"), rA);
        await msg(A, "saida", SP("10:00:10"), rA);
        // B: o lead à 01:00 (sem resposta) e a rodada pura do retorno às 18:00 (17 h depois)
        const B = await conversa("Lead B");
        await msg(B, "entrada", SP("01:00:00"), null);
        const rP = await rodada(B, SP("18:00:00"), true);
        await msg(B, "saida", SP("18:00:00"), rP);
        // C: a mista (o lead escreveu perto da hora e a rodada levou o retorno): 20 s
        const C = await conversa("Lead C");
        const rM = await rodada(C, SP("12:00:00"), true);
        await msg(C, "entrada", SP("12:00:00"), rM);
        await msg(C, "saida", SP("12:00:20"), rM);
        // D: a rodada comum sem entrada ligada (o pedido de permissão para ligar, base 0041: rodada
        // concluída, sem passos, sem retorno_id e sem entrada) continua contando, a partir da última
        // do lead (a entrada solta das 14:00:00): 40 s
        const D = await conversa("Lead D");
        await msg(D, "entrada", SP("14:00:00"), null);
        if (temPermissao) {
          await servidor(t, "select public.ligacao_permissao_registrar($1, $2, $3, $4, $5, $6)", [
            D,
            b.cx,
            "wamid-teste-d",
            b.mAdmin,
            "Posso te ligar?",
            SP("14:00:40"),
          ]);
        } else {
          const rD = await rodada(D, SP("14:00:40"), false);
          await msg(D, "saida", SP("14:00:40"), rD);
        }
        t.igual(
          await contar(
            t,
            `select 1 from public.mensagens m join public.rodadas r on r.id = m.rodada_id
            where m.conversa_id = $1 and m.direcao = 'saida' and r.retorno_id is null
              and not exists (select 1 from public.mensagens e where e.rodada_id = r.id and e.direcao = 'entrada')`,
            [D],
          ),
          1,
          "D: a bolha numa rodada comum sem entrada ligada",
        );

        const p = await t.como(
          "authenticated",
          b.uAdmin,
          async (q) =>
            (
              await q("select public.dashboard_periodo($1, $2, $3) as r", [
                SP("00:00:00"),
                "2026-10-11T00:00:00-03:00",
                null,
              ])
            )[0].r,
        );
        const esperado = temDashboard ? [20, 40, 20] : [30, 61_200, 30];
        t.igual(
          [p.respostaNinaS, p.respostaNinaP90S, p.series.respostaNinaS[0].valor],
          esperado,
          temDashboard
            ? "mediana de [10, 20, 40] e p90 40"
            : "mediana de [10, 20, 40, 61200] e p90 61200",
        );
        t.igual(p.enviadas, 4, "as bolhas continuam em enviadas");
      },
    );
  },
);
