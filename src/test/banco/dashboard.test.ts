// @vitest-environment node
// Funções do Dashboard (migration 0008, com o dashboard_custo recriado na 0014): dashboard_periodo,
// dashboard_funil, dashboard_custo, dashboard_problemas e dashboard_agora. Porte do 32-dashboard
// do banco2. Definições: decisão 9 da spec  e os "como contamos"
// da tela. Os dados são montados à mão, como superusuário, com datas fixas em São Paulo (-03:00);
// as funções são chamadas como o usuário da tela (authenticated).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "vitest";
import { montarBase, RAIZ, TEMPO_TESTE, usarBanco, type Banco, type Linha } from "./montar";

const TIPOS_TS = join(RAIZ, "src", "features", "plataforma", "dashboard", "dados", "tipos.ts");
const SP = (s: string) => `${s}-03:00`;
const ms = (iso: string) => Date.parse(iso);
const HORA = 3_600_000;
const DIA = 86_400_000;
const iso = (n: number) => new Date(n).toISOString();

// ---------------------------------------------------------------------------
// ajudantes
// ---------------------------------------------------------------------------
async function equipe(t: Banco) {
  const uAdmin = await t.criarUsuario("admin@empresa.exemplo", "Admin");
  const uAtend = await t.criarUsuario("atendente@empresa.exemplo", "Atendente");
  const uFora = await t.criarUsuario("fora@empresa.exemplo", "Sem convite");
  const [{ id: mAdmin }] = await t.sql("select id from public.membros where user_id = $1", [
    uAdmin,
  ]);
  const [{ id: mAtend }] = await t.sql(
    `insert into public.membros (user_id, nome, email, papel) values ($1, 'Marina', 'atendente@empresa.exemplo', 'atendente') returning id`,
    [uAtend],
  );
  return { uAdmin, uAtend, uFora, mAdmin, mAtend };
}

async function conexao(t: Banco) {
  const [{ id }] = await t.sql(
    `insert into public.conexoes (gateway, nome, id_externo, status, ativa) values ('zapi', 'Teste', 'inst-1', 'conectada', true) returning id`,
  );
  return id;
}

// Linha: os testes leem E.novo, E.ganho...
async function etapas(t: Banco): Promise<Linha> {
  const linhas = await t.sql("select chave, id from public.etapas");
  return Object.fromEntries(linhas.map((l) => [l.chave, l.id]));
}

interface Movimento {
  para: string;
  em: string;
  ator?: string;
  membro?: string | null;
}

interface DadosLead {
  t0?: string | null;
  nome?: string;
  caminho?: Movimento[];
  criado?: string | null;
}

// Um lead da coorte: contato com 1ª mensagem em t0, histórico de etapa escrito à mão
// (a entrada em Novo em t0 e cada movimento do caminho) e a conversa.
async function lead(
  t: Banco,
  E: Linha,
  cx: string,
  { t0, nome = "Lead", caminho = [], criado }: DadosLead = {},
) {
  const ultimo = caminho.at(-1);
  const final = ultimo ? ultimo.para : "novo";
  const [{ id: contato }] = await t.sql(
    `insert into public.contatos (nome, etapa_id, primeira_mensagem_em, criado_em, etapa_desde)
     values ($1, $2, $3, coalesce($4::timestamptz, $3::timestamptz), coalesce($5::timestamptz, $3::timestamptz)) returning id`,
    [nome, E[final], t0, criado ?? null, ultimo ? ultimo.em : null],
  );
  await t.sql("delete from public.contato_etapa_historico where contato_id = $1", [contato]);
  if (t0) {
    await t.sql(
      `insert into public.contato_etapa_historico (contato_id, de_etapa_id, para_etapa_id, ator, criado_em)
       values ($1, null, $2, 'sistema', $3)`,
      [contato, E.novo, t0],
    );
  }
  let de = E.novo;
  for (const p of caminho) {
    await t.sql(
      `insert into public.contato_etapa_historico (contato_id, de_etapa_id, para_etapa_id, ator, membro_id, criado_em)
       values ($1, $2, $3, $4, $5, $6)`,
      [contato, de, E[p.para], p.ator ?? "membro", p.membro ?? null, p.em],
    );
    de = E[p.para];
  }
  const [{ id: conversa }] = await t.sql(
    `insert into public.conversas (contato_id, conexao_id) values ($1, $2) returning id`,
    [contato, cx],
  );
  return { contato, conversa };
}

interface DadosMsg {
  lado?: string;
  status?: string;
  em: string;
  rodada?: string | null;
  autor?: string | null;
  statusEm?: string | null;
  midiaRef?: string | null;
  midiaStatus?: string | null;
}

async function msg(t: Banco, cx: string, conversa: string, o: DadosMsg) {
  const lado = o.lado ?? "lead";
  const direcao = lado === "lead" ? "entrada" : "saida";
  const status = o.status ?? (lado === "lead" ? "recebida" : "enviada");
  const [{ id }] = await t.sql(
    `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, status, momento, rodada_id,
                                   autor_membro_id, status_em, midia_ref_externa, midia_status, texto)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'oi') returning id`,
    [
      conversa,
      cx,
      direcao,
      lado,
      status,
      o.em,
      o.rodada ?? null,
      o.autor ?? null,
      o.statusEm ?? null,
      o.midiaRef ?? null,
      o.midiaStatus ?? null,
    ],
  );
  return id;
}

interface DadosRodada {
  status?: string;
  motivo?: string | null;
  inicio?: string;
  fim?: string;
}

async function rodada(
  t: Banco,
  conversa: string,
  { status = "concluida", motivo = null, inicio, fim }: DadosRodada,
) {
  const [{ id }] = await t.sql(
    `insert into public.rodadas (conversa_id, status, motivo, iniciada_em, terminada_em) values ($1, $2, $3, $4, $5) returning id`,
    [conversa, status, motivo, inicio ?? fim, fim ?? null],
  );
  return id;
}

interface DadosChamada {
  tipo?: string;
  usd: number | null;
  em: string;
  rodada?: string | null;
  conversa?: string | null;
  provedor?: string;
  modelo?: string;
}

async function chamada(
  t: Banco,
  {
    tipo = "resposta",
    usd,
    em,
    rodada: r = null,
    conversa = null,
    provedor = "anthropic",
    modelo = "claude-haiku",
  }: DadosChamada,
) {
  await t.sql(
    `insert into public.ia_chamadas (tipo, provedor, modelo, custo_usd, custo_origem, criado_em, rodada_id, conversa_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tipo, provedor, modelo, usd, usd === null ? "sem_preco" : "tabela", em, r, conversa],
  );
}

async function evento(t: Banco, conversa: string, tipo: string, motivo: string | null, em: string) {
  await t.sql(
    `insert into public.conversa_eventos (conversa_id, tipo, motivo, criado_em) values ($1, $2, $3, $4)`,
    [conversa, tipo, motivo, em],
  );
}

// Chama uma função como o usuário (authenticated) e devolve o jsonb.
async function chamar(t: Banco, userId: string, sql: string, params?: unknown[]) {
  return t.como("authenticated", userId, async (q) => (await q(sql, params))[0].r);
}

const PERIODO = "select public.dashboard_periodo($1, $2, $3) as r";
const FUNIL = "select public.dashboard_funil($1, $2, $3) as r";
const CUSTO = "select public.dashboard_custo($1, $2) as r";
const PROBLEMAS = "select public.dashboard_problemas($1, $2) as r";
const AGORA = "select public.dashboard_agora() as r";

const porNome = (etapasFunil: Linha[]) => Object.fromEntries(etapasFunil.map((e) => [e.nome, e]));

// Os campos de primeiro nível de uma interface de tipos.ts (indentação de 2 espaços).
function camposDe(texto: string, nome: string) {
  const ini = texto.indexOf(`export interface ${nome} {`);
  if (ini < 0) throw new Error(`interface ${nome} não achada em tipos.ts`);
  const fim = texto.indexOf("\n}", ini);
  const corpo = texto.slice(ini, fim);
  return [...corpo.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1] ?? "");
}

// ---------------------------------------------------------------------------
// testes
// ---------------------------------------------------------------------------

const base = await montarBase();
const t = usarBanco(base);

describe("banco: dashboard (0008)", { timeout: TEMPO_TESTE }, () => {
  it("dashboard: anon recusado nas 5 funções; conta sem membro recebe sem_acesso", async () => {
    const { uFora } = await equipe(t);
    const de = SP("2026-10-01T00:00:00");
    const ate = SP("2026-10-02T00:00:00");
    const chamadas: [string, unknown[] | undefined][] = [
      [PERIODO, [de, ate, null]],
      [FUNIL, [de, ate, null]],
      [CUSTO, [de, ate]],
      [PROBLEMAS, [de, ate]],
      [AGORA, undefined],
    ];
    await t.como("anon", null, async (q) => {
      for (const [sql, p] of chamadas) await t.erro(q(sql, p), "permission denied");
    });
    for (const [sql, p] of chamadas) {
      await t.erro(
        t.como("authenticated", uFora, async (q) => q(sql, p)),
        "sem_acesso",
      );
    }
    // grants: authenticated e service_role executam; anon e public não
    const linhas = await t.sql(
      `select p.proname,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as srv
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'dashboard\\_%' and p.proname <> 'dashboard'`,
    );
    const nomes = linhas.map((l) => l.proname).sort();
    t.igual(
      nomes,
      [
        "dashboard_agora",
        "dashboard_custo",
        "dashboard_custo_por_etapa",
        "dashboard_etapa_em",
        "dashboard_funil",
        "dashboard_periodo",
        "dashboard_problemas",
      ],
      "funções do arquivo",
    );
    for (const l of linhas) {
      t.ok(!l.anon, `${l.proname}: anon não executa`);
      const ajudante =
        l.proname === "dashboard_etapa_em" || l.proname === "dashboard_custo_por_etapa";
      t.igual(l.auth, !ajudante, `${l.proname}: authenticated`);
      t.igual(l.srv, !ajudante, `${l.proname}: service_role`);
    }
  });

  it("dashboard: período inválido dá periodo_invalido", async () => {
    const { uAdmin } = await equipe(t);
    const a = SP("2026-10-02T00:00:00");
    const b = SP("2026-10-01T00:00:00");
    await t.erro(chamar(t, uAdmin, PERIODO, [a, b, null]), "periodo_invalido");
    await t.erro(chamar(t, uAdmin, FUNIL, [a, a, null]), "periodo_invalido");
    await t.erro(chamar(t, uAdmin, CUSTO, [null, a]), "periodo_invalido");
    await t.erro(chamar(t, uAdmin, PROBLEMAS, [SP("2024-01-01T00:00:00"), a]), "periodo_invalido");
  });

  it("dashboard_periodo: enviadas é só o que saiu (9c), recebidas e conversas pela data da mensagem", async () => {
    const { uAtend, mAtend } = await equipe(t);
    const cx = await conexao(t);
    const E = await etapas(t);
    const de = SP("2026-10-10T00:00:00");
    const ate = SP("2026-10-11T00:00:00");
    const a = await lead(t, E, cx, { t0: SP("2026-10-10T09:00:00") });
    const b = await lead(t, E, cx, { t0: SP("2026-10-10T09:00:00") });
    const c = await lead(t, E, cx, { t0: SP("2026-10-01T09:00:00") }); // de fora da coorte
    const d = await lead(t, E, cx, { t0: SP("2026-10-01T09:00:00") }); // só uma que não saiu
    const r = await rodada(t, a.conversa, { fim: SP("2026-10-10T09:00:20") });
    await msg(t, cx, a.conversa, { em: SP("2026-10-10T09:00:00"), rodada: r });
    await msg(t, cx, a.conversa, { em: SP("2026-10-10T09:00:05") });
    for (const status of [
      "enviada",
      "entregue",
      "lida",
      "na_fila",
      "enviando",
      "falhou",
      "cancelada",
    ]) {
      await msg(t, cx, a.conversa, {
        lado: "nina",
        status,
        em: SP("2026-10-10T09:00:30"),
        rodada: r,
      });
    }
    await msg(t, cx, b.conversa, {
      lado: "humano_tela",
      autor: mAtend,
      em: SP("2026-10-10T10:00:00"),
    });
    await msg(t, cx, b.conversa, {
      lado: "humano_tela",
      autor: mAtend,
      status: "falhou",
      em: SP("2026-10-10T10:01:00"),
    });
    await msg(t, cx, c.conversa, { lado: "humano_celular", em: SP("2026-10-10T11:00:00") });
    await msg(t, cx, c.conversa, { em: SP("2026-10-09T23:00:00") }); // fora da janela
    await msg(t, cx, d.conversa, {
      lado: "nina",
      status: "falhou",
      em: SP("2026-10-10T12:00:00"),
      rodada: await rodada(t, d.conversa, { fim: SP("2026-10-10T12:00:00") }),
    });

    const p = await chamar(t, uAtend, PERIODO, [de, ate, null]);
    t.igual(p.recebidas, 2, "recebidas");
    t.igual(
      p.enviadas,
      5,
      "enviadas: enviada, entregue e lida da Nina, a da tela que saiu e a do celular",
    );
    t.igual(p.enviadasPorOrigem, { nina: 3, humano_tela: 1, humano_celular: 1 }, "por origem");
    t.igual(p.conversas, 3, "a conversa só com mensagem que não saiu não conta");
    t.igual(p.leadsNovos, 2, "leads novos (coorte)");
    t.igual(p.series.recebidas, [{ dia: "2026-10-10", valor: 2 }], "série de recebidas");
    t.igual(p.series.enviadas, [{ dia: "2026-10-10", valor: 5 }], "série de enviadas");
    t.igual(p.series.conversas, [{ dia: "2026-10-10", valor: 3 }], "série de conversas");
  });

  it("dashboard_periodo: passagens do período separando decisão e falha (9a) e a autonomia", async () => {
    const { uAdmin } = await equipe(t);
    const cx = await conexao(t);
    const E = await etapas(t);
    const de = SP("2026-10-10T00:00:00");
    const ate = SP("2026-10-12T00:00:00");
    const conv = [];
    for (let i = 0; i < 6; i += 1) {
      const l = await lead(t, E, cx, { t0: SP("2026-10-10T08:00:00") });
      await msg(t, cx, l.conversa, { em: SP("2026-10-10T08:00:00") });
      conv.push(l.conversa);
    }
    await evento(t, conv[0], "passou", "nina_passou", SP("2026-10-10T09:00:00"));
    await evento(t, conv[1], "passou", "nina_passou", SP("2026-10-11T23:59:59"));
    await evento(t, conv[2], "passou", "sem_credito", SP("2026-10-10T09:00:00"));
    await evento(t, conv[3], "passou", "erro_provedor", SP("2026-10-11T10:00:00"));
    await evento(t, conv[4], "passou", "sem_credito", SP("2026-10-12T00:00:00")); // fora (fim aberto)
    await evento(t, conv[4], "passou", "limite_passos", SP("2026-10-09T23:59:59")); // fora (antes)
    // assumir pelo botão não é "passado para a equipe" (9a), mas é passagem: tira a autonomia
    await evento(t, conv[5], "assumiu", null, SP("2026-10-10T10:00:00"));

    const p = await chamar(t, uAdmin, PERIODO, [de, ate, null]);
    t.igual(
      p.passados,
      { ninaPassou: 2, falha: 2, porMotivo: { nina_passou: 2, sem_credito: 1, erro_provedor: 1 } },
      "passados",
    );
    // autônoma só conv[4] (as passagens dele são fora da janela); conv[5] foi assumida
    t.igual(p.conversas, 6, "conversas");
    t.igual(p.conversasAutonomas, 1, "autônomas");
    t.igual(p.autonomiaPct, 16.7, "autonomia com 1 casa");
  });

  it("dashboard_periodo: mensagem humana tira a autonomia; tempos de resposta (mediana e p90)", async () => {
    const { uAdmin, mAtend } = await equipe(t);
    const cx = await conexao(t);
    const E = await etapas(t);
    const de = SP("2026-10-10T00:00:00");
    const ate = SP("2026-10-12T00:00:00");
    // A: lead 10:00:00, Nina 10:00:30 (30 s); B: lead 11:00 e 11:00:30, Nina 11:02:00 (90 s, da última)
    const A = await lead(t, E, cx, { t0: SP("2026-10-10T10:00:00") });
    const rA = await rodada(t, A.conversa, { fim: SP("2026-10-10T10:00:31") });
    await msg(t, cx, A.conversa, { em: SP("2026-10-10T10:00:00"), rodada: rA });
    await msg(t, cx, A.conversa, { lado: "nina", em: SP("2026-10-10T10:00:30"), rodada: rA });
    await msg(t, cx, A.conversa, { lado: "nina", em: SP("2026-10-10T10:00:32"), rodada: rA });
    const B = await lead(t, E, cx, { t0: SP("2026-10-10T11:00:00") });
    const rB = await rodada(t, B.conversa, { fim: SP("2026-10-10T11:02:00") });
    await msg(t, cx, B.conversa, { em: SP("2026-10-10T11:00:00"), rodada: rB });
    await msg(t, cx, B.conversa, { em: SP("2026-10-10T11:00:30"), rodada: rB });
    await msg(t, cx, B.conversa, { lado: "nina", em: SP("2026-10-10T11:02:00"), rodada: rB });
    // C: dia 11, Nina em 10 s; depois a equipe escreve (a conversa deixa de ser autônoma)
    const C = await lead(t, E, cx, { t0: SP("2026-10-11T09:00:00") });
    const rC = await rodada(t, C.conversa, { fim: SP("2026-10-11T09:00:10") });
    await msg(t, cx, C.conversa, { em: SP("2026-10-11T09:00:00"), rodada: rC });
    await msg(t, cx, C.conversa, { lado: "nina", em: SP("2026-10-11T09:00:10"), rodada: rC });
    await msg(t, cx, C.conversa, {
      lado: "humano_tela",
      autor: mAtend,
      em: SP("2026-10-11T09:30:00"),
    });

    const p = await chamar(t, uAdmin, PERIODO, [de, ate, null]);
    t.igual(p.respostaNinaS, 30, "mediana de [10, 30, 90]");
    t.igual(p.respostaNinaP90S, 90, "p90 pela posição mais próxima");
    t.igual(
      p.series.respostaNinaS,
      [
        { dia: "2026-10-10", valor: 60 },
        { dia: "2026-10-11", valor: 10 },
      ],
      "mediana por dia",
    );
    t.igual(p.primeiraRespostaS, 30, "1ª resposta: mediana de [30, 120, 10]");
    t.igual(p.conversas, 3, "conversas");
    t.igual(p.conversasAutonomas, 2, "C tem mensagem humana");
    t.igual(p.autonomiaPct, 66.7, "autonomia");

    // p_estado_em: a 1ª resposta só conta se saiu até ali
    const antes = await chamar(t, uAdmin, PERIODO, [de, ate, SP("2026-10-10T10:01:00")]);
    t.igual(antes.primeiraRespostaS, 30, "só A tinha resposta às 10:01");
    t.igual(antes.leadsNovos, 3, "leadsNovos do resumo é a coorte da janela");
  });

  it("dashboard_periodo: virada do dia em São Paulo (23:59:59 e 00:00, -03:00) nas séries, na janela e na coorte", async () => {
    const { uAdmin } = await equipe(t);
    const cx = await conexao(t);
    const E = await etapas(t);
    const de = SP("2026-10-10T00:00:00");
    const ate = SP("2026-10-12T00:00:00");
    const fora = await lead(t, E, cx, { t0: SP("2026-10-09T23:59:59") });
    const dentro = await lead(t, E, cx, { t0: SP("2026-10-10T00:00:00") });
    const ultimo = await lead(t, E, cx, { t0: SP("2026-10-11T23:59:59") });
    await lead(t, E, cx, { t0: SP("2026-10-12T00:00:00") }); // fora (fim aberto)
    await msg(t, cx, fora.conversa, { em: SP("2026-10-09T23:59:59") });
    await msg(t, cx, dentro.conversa, { em: SP("2026-10-10T00:00:00") });
    await msg(t, cx, dentro.conversa, { em: SP("2026-10-10T23:59:59") });
    await msg(t, cx, dentro.conversa, { em: SP("2026-10-11T00:00:00") });
    await msg(t, cx, ultimo.conversa, { em: SP("2026-10-11T23:59:59") });
    await msg(t, cx, ultimo.conversa, { em: SP("2026-10-12T00:00:00") });
    // custo: 02:30 UTC do dia 11 = 23:30 do dia 10 em São Paulo
    await chamada(t, { usd: 0.25, em: "2026-10-11T02:30:00Z", conversa: dentro.conversa });
    await chamada(t, { usd: 0.5, em: SP("2026-10-11T00:00:00"), conversa: dentro.conversa });

    const p = await chamar(t, uAdmin, PERIODO, [de, ate, null]);
    t.igual(p.leadsNovos, 2, "coorte: 00:00 do dia 10 até 23:59:59 do dia 11");
    t.igual(p.recebidas, 4, "recebidas na janela");
    t.igual(
      p.series.recebidas,
      [
        { dia: "2026-10-10", valor: 2 },
        { dia: "2026-10-11", valor: 2 },
      ],
      "recebidas por dia",
    );
    t.igual(
      p.series.conversas,
      [
        { dia: "2026-10-10", valor: 1 },
        { dia: "2026-10-11", valor: 2 },
      ],
      "conversas por dia",
    );
    t.igual(
      p.series.custoUsd,
      [
        { dia: "2026-10-10", valor: 0.25 },
        { dia: "2026-10-11", valor: 0.5 },
      ],
      "custo por dia de São Paulo",
    );

    // um período de 1 dia tem 1 ponto; um dia sem nada tem zero
    const vazio = await chamar(t, uAdmin, PERIODO, [
      SP("2026-10-20T00:00:00"),
      SP("2026-10-22T00:00:00"),
      null,
    ]);
    t.igual(
      vazio.series.recebidas,
      [
        { dia: "2026-10-20", valor: 0 },
        { dia: "2026-10-21", valor: 0 },
      ],
      "zeros",
    );
    t.igual(
      [vazio.conversas, vazio.recebidas, vazio.enviadas, vazio.leadsNovos],
      [0, 0, 0, 0],
      "contagens zeradas",
    );
    t.igual(
      [vazio.primeiraRespostaS, vazio.respostaNinaS, vazio.respostaNinaP90S, vazio.autonomiaPct],
      [null, null, null, null],
      "sem amostra = null",
    );
    t.igual(vazio.passados, { ninaPassou: 0, falha: 0, porMotivo: {} }, "sem passagens");

    // o funil também vira o dia em São Paulo
    const f = await chamar(t, uAdmin, FUNIL, [de, ate, null]);
    t.igual(f.leadsNovos, 2, "funil: mesma coorte");
    const novo = porNome(f.etapas)["Novo"];
    t.igual(
      novo.entradasPorDia,
      [
        { dia: "2026-10-10", valor: 1 },
        { dia: "2026-10-11", valor: 1 },
      ],
      "entradas por dia",
    );
  });

  it("dashboard_funil: chegaram, avançaram, abandonaram (perdido e sem resposta), a conta fecha, tempos, movimentos e ciclo", async () => {
    const { uAdmin, mAdmin } = await equipe(t);
    const cx = await conexao(t);
    const E = await etapas(t);
    const de = SP("2026-10-01T00:00:00");
    const ate = SP("2026-10-08T00:00:00");
    const estado = SP("2026-10-20T12:00:00");
    const t0 = SP("2026-10-02T10:00:00");
    const h = (n: number) => iso(ms(t0) + n * HORA);
    // L1: Novo → Em qualificação (Nina, 2 h) → Qualificado (equipe, 5 h) → Ganho (equipe, 29 h)
    const L1 = await lead(t, E, cx, {
      t0,
      caminho: [
        { para: "em_qualificacao", em: h(2), ator: "nina" },
        { para: "qualificado", em: h(5), ator: "membro", membro: mAdmin },
        { para: "ganho", em: h(29), ator: "membro", membro: mAdmin },
      ],
    });
    // L2: Novo → Em qualificação (Nina, 4 h) → Perdido (10 h)
    const L2 = await lead(t, E, cx, {
      t0,
      caminho: [
        { para: "em_qualificacao", em: h(4), ator: "nina" },
        { para: "perdido", em: h(10), ator: "nina" },
      ],
    });
    // L3: parado em Novo, calado desde o dia 2 (mais de 7 dias antes do instante do funil)
    const L3 = await lead(t, E, cx, { t0 });
    // L4: em Novo, escreveu no dia 18 (fora da janela, mas antes do instante)
    const L4 = await lead(t, E, cx, { t0 });
    // L5: Novo → Qualificado direto (Nina, 6 h), escreveu no dia 19
    const L5 = await lead(t, E, cx, {
      t0,
      caminho: [{ para: "qualificado", em: h(6), ator: "nina" }],
    });
    for (const L of [L1, L2, L3, L4, L5]) await msg(t, cx, L.conversa, { em: t0 });
    await msg(t, cx, L4.conversa, { em: SP("2026-10-18T09:00:00") });
    await msg(t, cx, L5.conversa, { em: SP("2026-10-19T09:00:00") });
    await msg(t, cx, L1.conversa, {
      lado: "nina",
      em: h(1),
      rodada: await rodada(t, L1.conversa, { fim: h(1) }),
    });
    // fora da coorte (1ª mensagem antes da janela) e depois do instante: não entram
    await lead(t, E, cx, { t0: SP("2026-09-30T23:59:59") });
    await lead(t, E, cx, { t0: SP("2026-10-07T23:00:00"), criado: SP("2026-10-07T23:00:00") });

    const f = await chamar(t, uAdmin, FUNIL, [de, ate, estado]);
    t.igual(f.leadsNovos, 6, "leads novos (o do dia 7 entra: chegou antes do instante)");
    t.igual(f.ganhos, 1, "ganhos");
    t.igual(f.cicloMedianoDias, 1.2, "ciclo: 29 h = 1,2 dia");
    t.igual(
      f.etapas.map((e: Linha) => e.nome),
      ["Novo", "Em qualificação", "Qualificado", "Em negociação", "Ganho"],
      "etapas sem Perdido, na ordem",
    );
    const x = porNome(f.etapas);
    const resumo = (e: Linha) => [
      e.chegaram,
      e.avancaram,
      e.aindaEstao,
      e.abandonaram.perdido,
      e.abandonaram.semResposta,
      e.abandonaram.total,
    ];
    t.igual(
      resumo(x["Novo"]),
      [6, 3, 1, 0, 2, 2],
      "Novo: L3 e o do dia 7 (sem mensagem, chegou há 12 dias) sem resposta; L4 ainda está",
    );
    t.igual(
      resumo(x["Em qualificação"]),
      [3, 2, 0, 1, 0, 1],
      "Em qualificação: L5 passou por cima e conta; L2 perdido daqui",
    );
    t.igual(resumo(x["Qualificado"]), [2, 1, 1, 0, 0, 0], "Qualificado: L5 ainda está");
    t.igual(resumo(x["Em negociação"]), [1, 1, 0, 0, 0, 0], "Em negociação: L1 pulou e avançou");
    t.igual([x["Ganho"].chegaram, x["Ganho"].aindaEstao], [1, 1], "Ganho");
    for (const e of f.etapas.filter((e: Linha) => e.tipo === "aberta")) {
      t.igual(
        e.chegaram,
        e.avancaram + e.abandonaram.total + e.aindaEstao,
        `a conta fecha em ${e.nome}`,
      );
    }
    t.igual(x["Novo"].tempoMedianoH, 4, "Novo: mediana de 2, 4 e 6 h");
    t.igual(x["Em qualificação"].tempoMedianoH, 4.5, "Em qualificação: mediana de 3 e 6 h");
    t.igual(x["Qualificado"].tempoMedianoH, 24, "Qualificado: só quem saiu (L1)");
    t.igual(x["Em negociação"].tempoMedianoH, null, "ninguém ficou em Em negociação");
    t.igual(x["Ganho"].tempoMedianoH, null, "Ganho não tem tempo");
    t.igual(x["Novo"].movimentos, { nina: 3, equipe: 0 }, "quem tirou de Novo");
    t.igual(
      x["Em qualificação"].movimentos,
      { nina: 1, equipe: 1 },
      "L5 pela Nina, L1 pela equipe",
    );
    t.igual(x["Qualificado"].movimentos, { nina: 0, equipe: 1 }, "Qualificado");
    for (const e of f.etapas.filter((e: Linha) => e.tipo === "aberta")) {
      t.igual(
        e.movimentos.nina + e.movimentos.equipe,
        e.avancaram,
        `movimentos = avançaram em ${e.nome}`,
      );
    }
    t.igual(
      x["Novo"].mensagens,
      { recebidas: 5, enviadas: 1 },
      "mensagens em Novo (só as da janela)",
    );
    t.igual(
      x["Em qualificação"].entradasPorDia.find((d: Linha) => d.dia === "2026-10-02").valor,
      2,
      "entradas por dia",
    );
    t.igual(x["Novo"].entradasPorDia.length, 7, "um ponto por dia da janela");
    t.igual(x["Ganho"].ninaPodeMover, false, "ninaPodeMover");
    t.igual(typeof x["Novo"].custoUsd, "number", "admin recebe custo");
  });

  it("dashboard_funil: p_estado_em lê o funil como estava naquele instante", async () => {
    const { uAdmin } = await equipe(t);
    const cx = await conexao(t);
    const E = await etapas(t);
    const de = SP("2026-10-01T00:00:00");
    const ate = SP("2026-10-08T00:00:00");
    const t0 = SP("2026-10-02T10:00:00");
    const h = (n: number) => iso(ms(t0) + n * HORA);
    const L1 = await lead(t, E, cx, {
      t0,
      caminho: [
        { para: "em_qualificacao", em: h(2), ator: "nina" },
        { para: "ganho", em: h(30), ator: "membro" },
      ],
    });
    const L2 = await lead(t, E, cx, {
      t0,
      caminho: [{ para: "perdido", em: h(48), ator: "membro" }],
    });
    await lead(t, E, cx, { t0: h(5) }); // chega depois do 1º instante
    await msg(t, cx, L1.conversa, { em: t0 });
    await msg(t, cx, L2.conversa, { em: t0 });

    const antes = await chamar(t, uAdmin, FUNIL, [de, ate, h(3)]);
    t.igual(antes.leadsNovos, 2, "às 13:00 o 3º lead ainda não tinha chegado");
    t.igual(antes.ganhos, 0, "ninguém tinha ganho");
    const a = porNome(antes.etapas);
    t.igual(
      [
        a["Novo"].chegaram,
        a["Novo"].avancaram,
        a["Novo"].aindaEstao,
        a["Novo"].abandonaram.perdido,
      ],
      [2, 1, 1, 0],
      "L2 ainda estava em Novo",
    );
    t.igual(
      [a["Em qualificação"].chegaram, a["Em qualificação"].aindaEstao],
      [1, 1],
      "L1 estava em Em qualificação",
    );
    t.igual(a["Ganho"].chegaram, 0, "Ganho ainda vazio");
    t.igual(a["Novo"].tempoMedianoH, 2, "só o tempo de quem já tinha saído");
    t.igual(a["Em qualificação"].tempoMedianoH, null, "L1 ainda não tinha saído");

    const depois = await chamar(t, uAdmin, FUNIL, [de, ate, h(60)]);
    t.igual([depois.leadsNovos, depois.ganhos], [3, 1], "depois: 3 leads, 1 ganho");
    const d = porNome(depois.etapas);
    t.igual(
      [
        d["Novo"].chegaram,
        d["Novo"].avancaram,
        d["Novo"].aindaEstao,
        d["Novo"].abandonaram.perdido,
      ],
      [3, 1, 1, 1],
      "L2 perdido saindo de Novo",
    );
    t.igual(d["Em qualificação"].tempoMedianoH, 28, "L1 saiu de Em qualificação");
    t.igual(depois.cicloMedianoDias, 1.3, "ciclo: 30 h = 1,25 dia → 1,3");

    // sem p_estado_em = agora (o mesmo que o "depois", porque tudo já passou)
    const agora = await chamar(t, uAdmin, FUNIL, [de, ate, null]);
    t.igual([agora.leadsNovos, agora.ganhos], [3, 1], "nulo = agora");
  });

  it("dashboard_custo: total com onboarding em linha própria (9d), por tipo, por modelo, sem preço e fora da coorte; o funil fecha", async () => {
    const { uAdmin, uAtend } = await equipe(t);
    const cx = await conexao(t);
    const E = await etapas(t);
    const de = SP("2026-10-01T00:00:00");
    const ate = SP("2026-10-08T00:00:00");
    const t0 = SP("2026-10-02T10:00:00");
    const h = (n: number) => iso(ms(t0) + n * HORA);
    const L1 = await lead(t, E, cx, {
      t0,
      caminho: [{ para: "em_qualificacao", em: h(2), ator: "nina" }],
    });
    const L2 = await lead(t, E, cx, { t0, caminho: [{ para: "perdido", em: h(1), ator: "nina" }] });
    const velho = await lead(t, E, cx, { t0: SP("2026-09-15T10:00:00") });
    const r1 = await rodada(t, L1.conversa, { fim: h(1) });
    await msg(t, cx, L1.conversa, { em: t0, rodada: r1 });
    await msg(t, cx, L1.conversa, { lado: "nina", em: h(1), rodada: r1 });
    const rv = await rodada(t, velho.conversa, { fim: h(3) });
    await msg(t, cx, velho.conversa, { lado: "nina", em: h(3), rodada: rv });
    await chamada(t, { usd: 0.1, em: h(1), rodada: r1 }); // L1 em Novo (pela rodada)
    await chamada(t, { usd: 0.2, em: h(3), conversa: L1.conversa }); // L1 em Em qualificação
    await chamada(t, { usd: 0.07, em: h(2), conversa: L2.conversa }); // L2 em Perdido
    await chamada(t, { usd: 0.05, em: h(3), rodada: rv }); // fora da coorte
    await chamada(t, {
      tipo: "transcricao",
      usd: 0.03,
      em: h(3),
      conversa: L1.conversa,
      provedor: "openai",
      modelo: "whisper",
    });
    await chamada(t, { tipo: "onboarding", usd: 0.5, em: h(4), modelo: "claude-sonnet" });
    await chamada(t, { usd: null, em: h(4), conversa: L1.conversa });
    await chamada(t, { usd: 9, em: SP("2026-10-08T00:00:00"), conversa: L1.conversa }); // fora (fim aberto)

    const c = await chamar(t, uAdmin, CUSTO, [de, ate]);
    t.igual(c.total, 0.95, "total: resposta + transcrição + onboarding");
    // a 0014 acrescentou a fala (a voz da Nina) ao porTipo, zerada quando não há chamada de fala
    t.igual(c.porTipo, { fala: 0, resposta: 0.42, onboarding: 0.5, transcricao: 0.03 }, "por tipo");
    t.igual(c.semPreco, 1, "sem preço");
    t.igual(
      c.porModelo,
      [
        { provedor: "anthropic", modelo: "claude-sonnet", usd: 0.5 },
        { provedor: "anthropic", modelo: "claude-haiku", usd: 0.42 },
        { provedor: "openai", modelo: "whisper", usd: 0.03 },
      ],
      "por modelo, do maior para o menor",
    );
    t.igual(c.conversasComNina, 2, "conversas em que a Nina respondeu");
    t.igual(c.porConversaUsd, 0.21, "resposta ÷ conversas com a Nina");
    t.igual(c.foraDaCoorteUsd, 0.12, "fora da coorte (0,05) + tempo em Perdido (0,07)");

    const f = await chamar(t, uAdmin, FUNIL, [de, ate, null]);
    const x = porNome(f.etapas);
    t.igual(x["Novo"].custoUsd, 0.1, "custo em Novo");
    t.igual(x["Em qualificação"].custoUsd, 0.2, "custo em Em qualificação");
    t.igual(x["Qualificado"].custoUsd, 0, "zero, não nulo, para o admin");
    const soma = f.etapas.reduce((s: number, e: Linha) => s + e.custoUsd, 0);
    t.igual(
      Math.round((soma + c.foraDaCoorteUsd) * 1e6),
      Math.round(c.porTipo.resposta * 1e6),
      "Σ etapas + fora = resposta",
    );

    const p = await chamar(t, uAdmin, PERIODO, [de, ate, null]);
    const somaSerie = p.series.custoUsd.reduce((s: number, d: Linha) => s + d.valor, 0);
    t.igual(
      Math.round(somaSerie * 1e6),
      Math.round(c.total * 1e6),
      "a série de custo soma o total",
    );

    // atendente: custo nulo no período e no funil; dashboard_custo recusa
    const pa = await chamar(t, uAtend, PERIODO, [de, ate, null]);
    t.igual(pa.series.custoUsd, null, "série de custo nula para o atendente");
    const fa = await chamar(t, uAtend, FUNIL, [de, ate, null]);
    t.ok(
      fa.etapas.every((e: Linha) => e.custoUsd === null),
      "custo por etapa nulo para o atendente",
    );
    t.igual(fa.leadsNovos, f.leadsNovos, "o resto do funil é igual");
    await t.erro(chamar(t, uAtend, CUSTO, [de, ate]), "sem_acesso");

    // período sem nada
    const v = await chamar(t, uAdmin, CUSTO, [
      SP("2026-10-20T00:00:00"),
      SP("2026-10-21T00:00:00"),
    ]);
    t.igual(
      v,
      {
        total: 0,
        porTipo: { fala: 0, resposta: 0, transcricao: 0, onboarding: 0 },
        semPreco: 0,
        porModelo: [],
        conversasComNina: 0,
        porConversaUsd: null,
        foraDaCoorteUsd: 0,
      },
      "custo vazio",
    );
  });

  it("dashboard_problemas: falhas seguidas do mesmo motivo viram um problema (9b); envio, mídia e conexão", async () => {
    const { uAtend } = await equipe(t);
    const cx = await conexao(t);
    const E = await etapas(t);
    const de = SP("2026-10-10T00:00:00");
    const ate = SP("2026-10-11T00:00:00");
    const L = [];
    for (let i = 0; i < 4; i += 1) L.push(await lead(t, E, cx, { t0: SP("2026-10-01T10:00:00") }));
    const cv = L.map((l) => l.conversa);
    // antes do período: começa uma sequência de erro_provedor que entra no período (é de antes: fica fora)
    await rodada(t, cv[0], { fim: SP("2026-10-09T22:00:00") });
    await rodada(t, cv[0], {
      status: "falhou",
      motivo: "erro_provedor",
      fim: SP("2026-10-09T23:50:00"),
    });
    await rodada(t, cv[1], {
      status: "falhou",
      motivo: "erro_provedor",
      fim: SP("2026-10-10T00:05:00"),
    });
    // no período: 3 sem_credito seguidos (a cancelada no meio não corta), uma concluída, 1 sem_credito, 1 erro_provedor
    await rodada(t, cv[0], { fim: SP("2026-10-10T08:00:00") });
    await rodada(t, cv[0], {
      status: "falhou",
      motivo: "sem_credito",
      fim: SP("2026-10-10T09:00:00"),
    });
    await rodada(t, cv[1], {
      status: "falhou",
      motivo: "sem_credito",
      fim: SP("2026-10-10T09:10:00"),
    });
    await rodada(t, cv[2], { status: "cancelada", fim: SP("2026-10-10T09:15:00") });
    await rodada(t, cv[2], {
      status: "falhou",
      motivo: "sem_credito",
      fim: SP("2026-10-10T09:20:00"),
    });
    await evento(t, cv[0], "passou", "sem_credito", SP("2026-10-10T09:00:00"));
    await evento(t, cv[2], "passou", "sem_credito", SP("2026-10-10T09:20:00"));
    await evento(t, cv[3], "passou", "nina_passou", SP("2026-10-10T09:05:00"));
    await rodada(t, cv[3], { fim: SP("2026-10-10T10:00:00") });
    await rodada(t, cv[3], {
      status: "falhou",
      motivo: "sem_credito",
      fim: SP("2026-10-10T11:00:00"),
    });
    await rodada(t, cv[3], {
      status: "falhou",
      motivo: "erro_provedor",
      fim: SP("2026-10-10T11:30:00"),
    });
    await rodada(t, cv[0], { status: "rodando", inicio: SP("2026-10-10T11:40:00") });

    // envios: 2 falhas seguidas, 1 que saiu, 1 falha; mais uma falha do dia 9 (fora)
    const r = await rodada(t, cv[1], { fim: SP("2026-10-10T12:00:00") });
    await msg(t, cx, cv[1], {
      lado: "nina",
      status: "falhou",
      em: SP("2026-10-09T12:00:00"),
      statusEm: SP("2026-10-09T12:00:30"),
      rodada: r,
    });
    await msg(t, cx, cv[1], { lado: "nina", em: SP("2026-10-09T13:00:00"), rodada: r });
    await msg(t, cx, cv[1], {
      lado: "nina",
      status: "falhou",
      em: SP("2026-10-10T12:00:00"),
      statusEm: SP("2026-10-10T12:01:00"),
      rodada: r,
    });
    await msg(t, cx, cv[2], {
      lado: "nina",
      status: "falhou",
      em: SP("2026-10-10T12:00:30"),
      statusEm: SP("2026-10-10T12:03:00"),
      rodada: await rodada(t, cv[2], { fim: SP("2026-10-10T12:00:30") }),
    });
    await msg(t, cx, cv[1], { lado: "nina", em: SP("2026-10-10T12:10:00"), rodada: r });
    await msg(t, cx, cv[1], {
      lado: "nina",
      status: "falhou",
      em: SP("2026-10-10T13:00:00"),
      statusEm: SP("2026-10-10T13:00:10"),
      rodada: r,
    });
    // mídias recebidas: 1 copiada, 2 que falharam seguidas
    await msg(t, cx, cv[0], {
      em: SP("2026-10-10T14:00:00"),
      midiaRef: "m1",
      midiaStatus: "copiada",
    });
    await msg(t, cx, cv[0], {
      em: SP("2026-10-10T14:10:00"),
      midiaRef: "m2",
      midiaStatus: "falhou",
    });
    await msg(t, cx, cv[3], {
      em: SP("2026-10-10T14:20:00"),
      midiaRef: "m3",
      midiaStatus: "falhou",
    });
    // conexão: caiu (ativa) às 15:00, erro às 15:05, voltou às 15:30; uma queda dela inativa não conta
    const ev = (status_de: string | null, status_para: string, ativa: boolean, em: string) =>
      t.sql(
        `insert into public.conexao_eventos (conexao_id, status_de, status_para, ativa_de, ativa_para, criado_em) values ($1, $2, $3, $4, $4, $5)`,
        [cx, status_de, status_para, ativa, em],
      );
    await ev("conectada", "desconectada", true, SP("2026-10-10T15:00:00"));
    await ev("desconectada", "erro", true, SP("2026-10-10T15:05:00"));
    await ev("erro", "conectada", true, SP("2026-10-10T15:30:00"));
    await ev("conectada", "desconectada", false, SP("2026-10-10T16:00:00"));
    await ev("desconectada", "conectada", false, SP("2026-10-10T16:10:00"));
    await ev("conectada", "desconectada", true, SP("2026-10-10T20:00:00")); // ainda caída

    const lista = await chamar(t, uAtend, PROBLEMAS, [de, ate]);
    const curto = lista.map((p: Linha) => [
      p.tipo,
      p.motivo,
      new Date(p.quando).toISOString(),
      p.quantidade,
      p.durMin,
      p.conversasAfetadas,
    ]);
    t.igual(
      curto,
      [
        ["conexao", null, new Date(SP("2026-10-10T20:00:00")).toISOString(), 1, curto[0][4], 0],
        ["conexao", null, new Date(SP("2026-10-10T15:00:00")).toISOString(), 2, 30, 0],
        ["midia", null, new Date(SP("2026-10-10T14:10:00")).toISOString(), 2, 10, 2],
        ["envio", null, new Date(SP("2026-10-10T13:00:10")).toISOString(), 1, 0, 1],
        ["envio", null, new Date(SP("2026-10-10T12:01:00")).toISOString(), 2, 2, 2],
        ["falha_ia", "erro_provedor", new Date(SP("2026-10-10T11:30:00")).toISOString(), 1, 0, 0],
        ["falha_ia", "sem_credito", new Date(SP("2026-10-10T11:00:00")).toISOString(), 1, 0, 0],
        ["falha_ia", "sem_credito", new Date(SP("2026-10-10T09:00:00")).toISOString(), 3, 20, 2],
      ],
      "problemas do mais recente para o mais antigo",
    );
    t.ok(
      curto[0][4] > 0 && lista[0].fim === null,
      "conexão ainda caída: fim nulo e duração até agora",
    );
    t.igual(
      new Date(lista[1].fim).toISOString(),
      new Date(SP("2026-10-10T15:30:00")).toISOString(),
      "a conexão voltou às 15:30",
    );
    t.igual(
      new Date(lista[7].fim).toISOString(),
      new Date(SP("2026-10-10T09:20:00")).toISOString(),
      "fim = a última falha",
    );
    t.ok(
      lista.every((p: Linha) => typeof p.id === "string" && p.id.length > 0),
      "todo problema tem id",
    );
    t.igual(new Set(lista.map((p: Linha) => p.id)).size, lista.length, "ids únicos");

    // período só de ontem: a sequência de erro_provedor que começou no dia 9 aparece lá
    const ontem = await chamar(t, uAtend, PROBLEMAS, [SP("2026-10-09T00:00:00"), de]);
    t.igual(
      ontem.map((p: Linha) => [p.tipo, p.motivo, p.quantidade]),
      [
        ["falha_ia", "erro_provedor", 1],
        ["envio", null, 1],
      ],
      "no dia 9: a falha das 23:50 (a das 00:05 do dia 10 fica de fora, porque passa do fim) e o envio",
    );
  });

  it("dashboard_agora: aguardando, não lidas, com quem, ativa, kanban, esfriando e por etapa", async () => {
    const { uAtend, mAtend } = await equipe(t);
    const cx = await conexao(t);
    const E = await etapas(t);
    const agoraMs = Date.now();
    const ha = (min: number) => iso(agoraMs - min * 60_000);
    const novo = (nome: string, extra: DadosLead = {}) =>
      lead(t, E, cx, { t0: ha(60 * 24 * 10), nome, ...extra });
    const A = await novo("Ana");
    const B = await novo("Bruno");
    const C = await novo("Carla");
    const D = await novo("Davi");
    const Ee = await novo("Eva");
    const F = await novo("Fábio");
    const G = await novo("Gil", { caminho: [{ para: "ganho", em: ha(60), ator: "membro" }] });
    const H = await novo("Hugo", {
      caminho: [{ para: "qualificado", em: ha(60 * 24 * 3), ator: "nina" }],
    });
    await msg(t, cx, D.conversa, { em: ha(2) });
    await msg(t, cx, G.conversa, { em: ha(1) }); // a Nina não está ativa no Ganho
    await rodada(t, Ee.conversa, { status: "rodando", inicio: ha(0.5) });
    await t.sql(
      `update public.conversas set modo = 'humano', responsavel_id = null, aguardando_humano_desde = $2, motivo_humano = 'sem_credito', nao_lidas = 3 where id = $1`,
      [A.conversa, ha(30)],
    );
    await t.sql(
      `update public.conversas set modo = 'humano', responsavel_id = null, aguardando_humano_desde = $2, motivo_humano = 'nina_passou', nao_lidas = 1 where id = $1`,
      [H.conversa, ha(5)],
    );
    await t.sql(
      `update public.conversas set modo = 'humano', responsavel_id = $2, aguardando_humano_desde = null where id = $1`,
      [B.conversa, mAtend],
    );
    await t.sql(
      `update public.conversas set modo = 'humano', responsavel_id = null, aguardando_humano_desde = null, motivo_humano = 'humano_celular' where id = $1`,
      [C.conversa],
    );
    await t.sql(
      `update public.conversas set modo = 'nina', nao_lidas = 0, ultima_do_lead_em = $2, ultima_mensagem_em = $3 where id = $1`,
      [F.conversa, ha(60 * 30), ha(60 * 29)],
    );
    await t.sql(`update public.conversas set ultima_da_nina_em = $2 where id = $1`, [
      F.conversa,
      ha(60 * 29),
    ]);
    await t.sql(`update public.conversas set nao_lidas = 0 where id in ($1, $2)`, [
      D.conversa,
      G.conversa,
    ]);
    // um lead parado em Novo há 10 dias (conversa sem mensagem: vale a 1ª mensagem)
    await lead(t, E, cx, { t0: ha(60 * 24 * 10), nome: "Ivo" });

    const a = await chamar(t, uAtend, AGORA);
    t.igual(a.aguardando.total, 2, "aguardando: A e H");
    t.igual(
      a.aguardando.itens.map((i: Linha) => [i.nome, i.motivo]),
      [
        ["Ana", "sem_credito"],
        ["Hugo", "nina_passou"],
      ],
      "mais antiga primeiro",
    );
    t.igual(Date.parse(a.aguardando.maisAntigaDesde), Date.parse(ha(30)), "a espera mais antiga");
    t.igual(a.aguardando.itens[0].conversaId, A.conversa, "conversaId");
    t.igual(a.naoLidas, { conversas: 2, mensagens: 4 }, "não lidas");
    t.igual(a.comQuem.nina, 5, "com a Nina: Davi, Eva, Fábio, Gil e Ivo");
    t.igual(a.comQuem.membros, [{ membroId: mAtend, nome: "Marina", n: 1 }], "com a equipe");
    t.igual(a.comQuem.celular, 1, "celular");
    t.igual(
      a.ninaAtiva.conversas,
      2,
      "ativas: D (mensagem há 2 min) e E (rodada rodando); G está no Ganho",
    );
    t.igual(a.ninaAtiva.digitando?.nome, "Eva", "digitando");
    t.igual(a.esfriando, 1, "F esfriando");
    const k = Object.fromEntries(a.kanban.map((e: Linha) => [e.nome, e]));
    t.igual(
      a.kanban.map((e: Linha) => e.nome),
      ["Novo", "Em qualificação", "Qualificado", "Em negociação", "Ganho", "Perdido"],
      "kanban na ordem",
    );
    t.igual(
      [k["Novo"].n, k["Qualificado"].n, k["Ganho"].n, k["Perdido"].n],
      [7, 1, 1, 0],
      "leads por etapa",
    );
    t.igual(k["Perdido"].tipo, "perdido", "tipo");
    const pe = Object.fromEntries(a.porEtapa.map((e: Linha) => [e.etapaId, e]));
    t.igual(
      pe[E.novo].paradosMais7d,
      5,
      "parados em Novo: Ana, Bruno, Carla, Eva e Ivo (sem mensagem: vale a 1ª, há 10 dias); Davi e Fábio escreveram",
    );
    t.igual(pe[E.ganho].paradosMais7d, 0, "só nas abertas");
    t.igual(pe[E.novo].leads.length, 5, "até 5 por etapa");
    t.igual(
      pe[E.qualificado].leads.map((l: Linha) => [l.nome, l.conversaId]),
      [["Hugo", H.conversa]],
      "o lead e a conversa",
    );
    t.igual(Date.parse(a.ultimaDaNinaEm), Date.parse(ha(60 * 29)), "última resposta da Nina");
    t.igual(Date.parse(a.ultimaRecebidaEm), Date.parse(ha(1)), "última recebida");
  });

  it("dashboard: volume acima de 1.000 linhas (1.500 leads) sem corte", async () => {
    const { uAtend } = await equipe(t);
    const cx = await conexao(t);
    await t.sql(
      `insert into public.contatos (nome, primeira_mensagem_em)
       select 'Lead ' || g, timestamptz '2026-10-10 10:00:00-03' + g * interval '1 second' from generate_series(1, 1500) g`,
    );
    await t.sql(
      `insert into public.conversas (contato_id, conexao_id) select c.id, $1 from public.contatos c`,
      [cx],
    );
    await t.sql(
      `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, status, momento, texto)
       select cv.id, $1, 'entrada', 'lead', 'recebida', ct.primeira_mensagem_em, 'oi'
         from public.conversas cv join public.contatos ct on ct.id = cv.contato_id`,
      [cx],
    );
    await t.sql(
      `update public.conversas set modo = 'humano', aguardando_humano_desde = now(), motivo_humano = 'nina_passou'`,
    );
    const de = SP("2026-10-10T00:00:00");
    const ate = SP("2026-10-11T00:00:00");
    const p = await chamar(t, uAtend, PERIODO, [de, ate, null]);
    t.igual([p.leadsNovos, p.conversas, p.recebidas], [1500, 1500, 1500], "período");
    const f = await chamar(t, uAtend, FUNIL, [de, ate, null]);
    t.igual([f.leadsNovos, porNome(f.etapas)["Novo"].chegaram], [1500, 1500], "funil");
    const a = await chamar(t, uAtend, AGORA);
    t.igual(
      [a.aguardando.total, a.aguardando.itens.length, a.kanban[0].n],
      [1500, 1500, 1500],
      "agora",
    );
  });

  it("dashboard: o formato bate com os tipos do front (dashboard/dados/tipos.ts)", async () => {
    const { uAdmin } = await equipe(t);
    const cx = await conexao(t);
    const E = await etapas(t);
    const de = SP("2026-10-10T00:00:00");
    const ate = SP("2026-10-11T00:00:00");
    const l = await lead(t, E, cx, { t0: SP("2026-10-10T10:00:00") });
    await msg(t, cx, l.conversa, { em: SP("2026-10-10T10:00:00") });
    await rodada(t, l.conversa, {
      status: "falhou",
      motivo: "erro_provedor",
      fim: SP("2026-10-10T10:00:10"),
    });
    const tipos = await readFile(TIPOS_TS, "utf8");

    // Cada campo do tipo vem do banco, ou está na lista do que o front calcula (ou de onde vem).
    // Cada chave do banco está no tipo, ou na lista de extras (dado cru para o front calcular).
    const conferir = (nome: string, obj: Linha, frontCalcula: string[], extras: string[]) => {
      const campos = camposDe(tipos, nome);
      const chaves = Object.keys(obj);
      for (const c of campos) {
        t.ok(
          chaves.includes(c) || frontCalcula.includes(c),
          `${nome}.${c}: não veio do banco nem está na lista do front`,
        );
        t.ok(
          !(chaves.includes(c) && frontCalcula.includes(c)),
          `${nome}.${c}: veio do banco e está na lista do front`,
        );
      }
      for (const k of chaves)
        t.ok(
          campos.includes(k) || extras.includes(k),
          `${nome}: chave ${k} fora do tipo e dos extras`,
        );
    };

    const p = await chamar(t, uAdmin, PERIODO, [de, ate, null]);
    conferir("ResumoPeriodo", p, ["ninaPctEnviadas", "problemas"], ["conversasAutonomas"]);
    t.igual(
      Object.keys(p.series).sort(),
      ["conversas", "custoUsd", "enviadas", "recebidas", "respostaNinaS"],
      "series",
    );
    t.igual(Object.keys(p.passados).sort(), ["falha", "ninaPassou", "porMotivo"], "passados");
    t.igual(
      Object.keys(p.enviadasPorOrigem).sort(),
      ["humano_celular", "humano_tela", "nina"],
      "enviadasPorOrigem",
    );
    t.ok(
      p.series.conversas.every(
        (d: Linha) => /^\d{4}-\d{2}-\d{2}$/.test(d.dia) && typeof d.valor === "number",
      ),
      "PontoDia",
    );

    const f = await chamar(t, uAdmin, FUNIL, [de, ate, null]);
    conferir(
      "Funil",
      f,
      [
        "perdidos",
        "taxaGanhoPct",
        "perdidosPorOrigem",
        "frase",
        "fraseSaidas",
        "movimentos",
        "perguntas",
      ],
      [],
    );
    conferir("EtapaFunil", f.etapas[0], ["conversaoProxPct", "frase", "fraseQueda"], []);
    t.igual(
      Object.keys(f.etapas[0].abandonaram).sort(),
      ["perdido", "semResposta", "total"],
      "abandonaram",
    );
    t.igual(Object.keys(f.etapas[0].mensagens).sort(), ["enviadas", "recebidas"], "mensagens");
    t.igual(Object.keys(f.etapas[0].movimentos).sort(), ["equipe", "nina"], "movimentos");

    const c = await chamar(t, uAdmin, CUSTO, [de, ate]);
    conferir("CustoPeriodo", c, ["porGanhoUsd", "previsaoMesUsd"], ["conversasComNina"]);
    t.igual(
      Object.keys(c.porTipo).sort(),
      // a fala veio na 0014; o tipos.ts do Dashboard ainda não a tem
      ["fala", "onboarding", "resposta", "transcricao"],
      "porTipo com a linha do onboarding",
    );

    const pr = await chamar(t, uAdmin, PROBLEMAS, [de, ate]);
    t.igual(pr.length, 1, "um problema");
    conferir(
      "ProblemaPeriodo",
      pr[0],
      ["titulo", "causa", "acao", "soAdmin"],
      ["fim", "durMin", "motivo", "quantidade", "conversasAfetadas"],
    );
    t.ok(["falha_ia", "envio", "midia", "conexao"].includes(pr[0].tipo), "tipo do problema");
    t.ok(!Number.isNaN(Date.parse(pr[0].quando)), "quando é ISO");

    const a = await chamar(t, uAdmin, AGORA);
    conferir("Agora", a, ["saude"], ["ultimaRecebidaEm", "ultimaDaNinaEm"]);
    t.igual(
      Object.keys(a.aguardando).sort(),
      ["itens", "maisAntigaDesde", "total"],
      "aguardando (maisAntigaMin vem como maisAntigaDesde)",
    );
    t.igual(Object.keys(a.naoLidas).sort(), ["conversas", "mensagens"], "naoLidas");
    t.igual(Object.keys(a.comQuem).sort(), ["celular", "membros", "nina"], "comQuem");
    t.igual(Object.keys(a.ninaAtiva).sort(), ["conversas", "digitando"], "ninaAtiva");
    t.igual(Object.keys(a.kanban[0]).sort(), ["etapaId", "n", "nome", "tipo"], "kanban");
    t.igual(Object.keys(a.porEtapa[0]).sort(), ["etapaId", "leads", "paradosMais7d"], "porEtapa");
  });
});
