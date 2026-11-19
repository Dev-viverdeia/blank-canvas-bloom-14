// @vitest-environment node
// A ligação com um agente escolhido : nina_ligar_com_agente.
// - os agentes que já existiam viram Receptivos (uso 'receber');
// - só um agente Receptivo atende o número;
// - ligacoes.objetivo guarda o objetivo que a equipe escreveu (até 500 caracteres).
// Roda quando o banco tem o envio (na base, ou em NINA_SQL_EXTRA); antes disso fica pulado.
import { describe, expect, it } from "vitest";

import { montarBase, TEMPO_TESTE, temValorEnum, usarBanco } from "./montar";

const base = await montarBase();
const t = usarBanco(base);
const temEstrutura = temValorEnum(base, "ligacao_agente_uso", "ligar");

async function falha(sql: string, params: unknown[] = []): Promise<string> {
  try {
    await t.sql(sql, params);
  } catch (e) {
    return String((e as { code?: string }).code ?? e);
  }
  return "passou";
}

describe.skipIf(!temEstrutura)("banco: ligar com um agente", { timeout: TEMPO_TESTE }, () => {
  it("o agente nasce Receptivo; o Ativo não pode atender, e o que atende não vira Ativo", async () => {
    const [nina] = await t.sql(
      `insert into public.ligacao_agentes (nome, atende) values ('Nina', true) returning id, uso`,
    );
    expect(nina.uso).toBe("receber");
    const [ativo] = await t.sql(
      `insert into public.ligacao_agentes (nome, uso) values ('Vendas', 'ligar') returning id, uso`,
    );
    expect(ativo.uso).toBe("ligar");
    // check violation (23514)
    expect(
      await falha(`update public.ligacao_agentes set atende = true where id = $1`, [ativo.id]),
    ).toBe("23514");
    expect(
      await falha(`update public.ligacao_agentes set uso = 'ligar' where id = $1`, [nina.id]),
    ).toBe("23514");
    // a troca de quem atende pela função de sempre recusa o Ativo e aceita o Receptivo
    expect(await falha(`select public.ligacao_agente_atender($1)`, [ativo.id])).toBe("23514");
    const [outro] = await t.sql(
      `insert into public.ligacao_agentes (nome) values ('Suporte') returning id`,
    );
    await t.sql(`select public.ligacao_agente_atender($1)`, [outro.id]);
    const linhas = await t.sql(`select nome from public.ligacao_agentes where atende`);
    expect(linhas.map((l) => l.nome)).toEqual(["Suporte"]);
  });

  it("o objetivo da ligação: nulo ou de 1 a 500 caracteres", async () => {
    const [{ id: cx }] = await t.sql(
      `insert into public.conexoes (gateway, nome, id_externo, ativa, status, parametros)
       values ('meta', 'Conexão de teste', '106540352242333', true, 'conectada', '{}'::jsonb)
       returning id`,
    );
    const [r] = await t.sql(
      `select * from public.registrar_entrada($1, $2::jsonb, $3, $4::jsonb)`,
      [
        cx,
        JSON.stringify([{ tipo: "telefone", valor: "5511900000301" }]),
        "Ana Lima",
        JSON.stringify({
          id_externo: "wamid.obj1",
          tipo: "texto",
          texto: "Oi",
          momento: new Date().toISOString(),
        }),
      ],
    );
    const [{ id }] = await t.sql(
      `insert into public.ligacoes (conversa_id, conexao_id, direcao, id_externo, iniciada_em)
       values ($1, $2, 'saida', 'conv_obj_1', now()) returning id`,
      [r.conversa_id, cx],
    );
    await t.sql(`update public.ligacoes set objetivo = $1 where id = $2`, [
      "Retomar o orçamento",
      id,
    ]);
    await t.sql(`update public.ligacoes set objetivo = $1 where id = $2`, ["x".repeat(500), id]);
    expect(
      await falha(`update public.ligacoes set objetivo = $1 where id = $2`, ["x".repeat(501), id]),
    ).toBe("23514");
    expect(await falha(`update public.ligacoes set objetivo = '' where id = $1`, [id])).toBe(
      "23514",
    );
  });
});

// ---------------------------------------------------------------------------
// nina_ligar_com_agente_limites: a ligacao_iniciar_saida de 4 argumentos (objetivo e limites da
// conta). Pulado enquanto o banco não tem a versão de 4 argumentos.
// ---------------------------------------------------------------------------

async function temQuatro(): Promise<boolean> {
  const [r] = await t.sql(
    `select to_regprocedure('public.ligacao_iniciar_saida(uuid, uuid, timestamptz, text)') is not null as tem`,
  );
  return r.tem === true;
}

let seqLim = 0;
async function cenario(): Promise<{ cx: string; ag: string; conversa: () => Promise<string> }> {
  const [{ id: cx }] = await t.sql(
    `insert into public.conexoes (gateway, nome, id_externo, ativa, status, criado_em, parametros)
     values ('meta', 'Conexão de teste', '106540352242444', true, 'conectada', now() - interval '1 hour',
             '{"ligacoes": {"situacao": "ativa"}}'::jsonb)
     returning id`,
  );
  await t.sql(
    `update public.configuracao set onboarding_concluido_em = now() - interval '1 hour' where id = 1`,
  );
  const [{ id: ag }] = await t.sql(
    `insert into public.ligacao_agentes (nome, uso, duracao_max_s, id_externo)
     values ('Vendas', 'ligar', 600, 'agent_vendas_${seqLim}') returning id`,
  );
  const conversa = async () => {
    seqLim += 1;
    const [r] = await t.sql(
      `select * from public.registrar_entrada($1, $2::jsonb, $3, $4::jsonb)`,
      [
        cx,
        JSON.stringify([
          { tipo: "telefone", valor: `55119000004${String(seqLim).padStart(2, "0")}` },
        ]),
        "Ana Lima",
        JSON.stringify({
          id_externo: `wamid.lim${seqLim}`,
          tipo: "texto",
          texto: "Oi",
          momento: new Date(Date.now() - 3_600_000).toISOString(),
        }),
      ],
    );
    return r.conversa_id as string;
  };
  return { cx, ag, conversa };
}

async function iniciar(conv: string, ag: string, objetivo: string | null) {
  const [r] = await t.como("service_role", null, (q) =>
    q(`select * from public.ligacao_iniciar_saida($1, $2, $3, $4)`, [
      conv,
      ag,
      new Date().toISOString(),
      objetivo,
    ]),
  );
  return r as { ligacao_id: string | null; permitida: boolean; motivo: string | null };
}

describe("banco: a saída com o objetivo e os limites da conta", { timeout: TEMPO_TESTE }, () => {
  it("grava o objetivo (aparado) junto com a reserva; vazio vira nulo; mais de 500 é recusado", async (ctx) => {
    if (!(await temQuatro())) ctx.skip();
    const { ag, conversa } = await cenario();
    const r = await iniciar(await conversa(), ag, "  Retomar o orçamento  ");
    expect(r.permitida).toBe(true);
    const [l] = await t.sql(`select objetivo, agente_id from public.ligacoes where id = $1`, [
      r.ligacao_id,
    ]);
    expect(l).toEqual({ objetivo: "Retomar o orçamento", agente_id: ag });
    const vazio = await iniciar(await conversa(), ag, "   ");
    const [l2] = await t.sql(`select objetivo from public.ligacoes where id = $1`, [
      vazio.ligacao_id,
    ]);
    expect(l2.objetivo).toBeNull();
    const conv = await conversa();
    await expect(iniciar(conv, ag, "x".repeat(501))).rejects.toThrow(/objetivo_invalido/);
  });

  it("as simultâneas e as do dia contam todos os agentes, nas duas direções", async (ctx) => {
    if (!(await temQuatro())) ctx.skip();
    const { ag, conversa } = await cenario();
    await t.sql(
      `update public.configuracao set ligacoes_simultaneas = 1, ligacoes_por_dia = 2 where id = 1`,
    );
    // outro agente com uma ligação em andamento: a conta já está no limite de simultâneas
    const [{ id: outro }] = await t.sql(
      `insert into public.ligacao_agentes (nome, atende, duracao_max_s, id_externo)
       values ('Nina', true, 600, 'agent_nina') returning id`,
    );
    const primeira = await iniciar(await conversa(), outro, null);
    expect(primeira.permitida).toBe(true);
    const r = await iniciar(await conversa(), ag, null);
    expect(r).toMatchObject({ permitida: false, motivo: "limite_simultaneas" });
    // a primeira acaba: a segunda sai; a terceira do dia passa do limite de 2 por dia
    await t.sql(`update public.ligacoes set status = 'concluida' where id = $1`, [
      primeira.ligacao_id,
    ]);
    expect((await iniciar(await conversa(), ag, null)).permitida).toBe(true);
    await t.sql(`update public.ligacoes set status = 'concluida' where direcao = 'saida'`);
    const r3 = await iniciar(await conversa(), ag, null);
    expect(r3).toMatchObject({ permitida: false, motivo: "limite_por_dia" });
    // a que não completou não conta no dia
    await t.sql(`update public.ligacoes set status = 'nao_completada' where agente_id = $1`, [ag]);
    expect((await iniciar(await conversa(), ag, null)).permitida).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// nina_ligar_com_agente_corridas: o agente na ElevenLabs, a entrada com os limites da conta e o
// soltar do agente. Pulado enquanto o banco não tem o envio.
// ---------------------------------------------------------------------------

async function temCorridas(): Promise<boolean> {
  const [r] = await t.sql(
    `select to_regprocedure('public.ligacao_agente_soltar(uuid)') is not null as tem`,
  );
  return r.tem === true;
}

async function entrada(cx: string, fone: string, ext: string, ag: string, conferir: boolean) {
  const [r] = await t.como("service_role", null, (q) =>
    q(
      `select * from public.ligacao_iniciar($1, $2::jsonb, 'Ana Lima', $3, $4, 'entrada', now(), $5)`,
      [cx, JSON.stringify([{ tipo: "telefone", valor: fone }]), ext, ag, conferir],
    ),
  );
  return r as { ligacao_id: string | null; permitida: boolean; motivo: string | null };
}

async function soltar(ag: string) {
  const [r] = await t.como("service_role", null, (q) =>
    q(`select * from public.ligacao_agente_soltar($1)`, [ag]),
  );
  return r as { motivo: string | null; id_externo: string | null };
}

describe("banco: as corridas da ligação com o agente", { timeout: TEMPO_TESTE }, () => {
  it("a saída com um agente que não está na ElevenLabs: agente_indisponivel", async (ctx) => {
    if (!(await temCorridas())) ctx.skip();
    const { ag, conversa } = await cenario();
    await t.sql(`update public.ligacao_agentes set id_externo = null where id = $1`, [ag]);
    expect(await iniciar(await conversa(), ag, null)).toMatchObject({
      permitida: false,
      motivo: "agente_indisponivel",
    });
  });

  it("a entrada no início confere os limites da conta (com a saída de outro agente); o pós-chamada não", async (ctx) => {
    if (!(await temCorridas())) ctx.skip();
    const { cx, ag, conversa } = await cenario();
    await t.sql(`update public.configuracao set ligacoes_simultaneas = 1 where id = 1`);
    expect((await iniciar(await conversa(), ag, null)).permitida).toBe(true);
    const [{ id: nina }] = await t.sql(
      `insert into public.ligacao_agentes (nome, atende, id_externo) values ('Nina', true, 'agent_n') returning id`,
    );
    const recusada = await entrada(cx, "5511900000501", "conv_ent_1", nina, true);
    expect(recusada).toMatchObject({ permitida: false, motivo: "limite_simultaneas" });
    // o pós-chamada (sem conferir a conta) grava a que já aconteceu
    const gravada = await entrada(cx, "5511900000502", "conv_ent_2", nina, false);
    expect(gravada.permitida).toBe(true);
    // idempotente: a mesma ligação de novo volta permitida, mesmo no limite
    expect((await entrada(cx, "5511900000502", "conv_ent_2", nina, true)).permitida).toBe(true);
  });

  it("soltar: o que atende e o que está em ligação ficam; o outro solta o id na mesma transação", async (ctx) => {
    if (!(await temCorridas())) ctx.skip();
    const { ag, conversa } = await cenario();
    const [{ id: nina }] = await t.sql(
      `insert into public.ligacao_agentes (nome, atende, id_externo) values ('Nina', true, 'agent_n2') returning id`,
    );
    expect(await soltar(nina)).toEqual({ motivo: "atende", id_externo: null });
    const r = await iniciar(await conversa(), ag, null);
    expect(r.permitida).toBe(true);
    expect(await soltar(ag)).toEqual({ motivo: "em_ligacao", id_externo: null });
    await t.sql(`update public.ligacoes set status = 'concluida' where id = $1`, [r.ligacao_id]);
    const solto = await soltar(ag);
    expect(solto.motivo).toBeNull();
    expect(solto.id_externo).toMatch(/^agent_vendas_/);
    const [a] = await t.sql(`select id_externo from public.ligacao_agentes where id = $1`, [ag]);
    expect(a.id_externo).toBeNull();
    // depois de solto, a saída com ele é recusada
    expect((await iniciar(await conversa(), ag, null)).motivo).toBe("agente_indisponivel");
    expect(await soltar("00000000-0000-4000-8000-000000000000")).toEqual({
      motivo: "nao_encontrado",
      id_externo: null,
    });
  });
});
