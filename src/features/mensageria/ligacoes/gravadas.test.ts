import { describe, expect, it } from "vitest";

import {
  ativacaoAbandonada,
  criadosNaAtivacao,
  lerLigacoesGravadas,
  manterLigacoes,
} from "./gravadas";

describe("lerLigacoesGravadas", () => {
  it("sem a chave, ou fora do formato de objeto: null", () => {
    expect(lerLigacoesGravadas({})).toBeNull();
    expect(lerLigacoesGravadas(null)).toBeNull();
    expect(lerLigacoesGravadas({ ligacoes: "x" })).toBeNull();
    expect(lerLigacoesGravadas({ ligacoes: [] })).toBeNull();
  });

  it("lê o estado e neutraliza o que vier fora do formato", () => {
    expect(
      lerLigacoesGravadas({
        wabaId: "1",
        ligacoes: {
          versao: 1,
          situacao: "inventada",
          origem: "https://nina.exemplo.com",
          numero: "+55 (11) 99999-0000",
          limiteMeta: "",
          eleven: { agenteId: "agent_1", troncoId: 7 },
          metaSip: "sim",
          pendencias: ["agente", 3],
        },
      }),
    ).toEqual({
      versao: 1,
      situacao: "com_pendencias",
      origem: "https://nina.exemplo.com",
      numero: "5511999990000",
      limiteMeta: null,
      ativadaEm: null,
      eleven: {
        segredoId: null,
        webhookId: null,
        ferramentaId: null,
        agenteId: "agent_1",
        troncoId: null,
      },
      metaSip: false,
      pendencias: ["agente"],
      atualizadaEm: "",
    });
  });

  it("guarda o atualizadaEm (D20)", () => {
    const l = lerLigacoesGravadas({
      ligacoes: { situacao: "ativando", atualizadaEm: "2026-11-12T10:00:00.000Z" },
    });
    expect(l?.atualizadaEm).toBe("2026-11-12T10:00:00.000Z");
  });
});

describe("ativação abandonada (D20)", () => {
  const AGORA = Date.parse("2026-11-12T10:00:00.000Z");
  const ativando = (atualizadaEm: unknown, extra: Record<string, unknown> = {}) =>
    lerLigacoesGravadas({ ligacoes: { situacao: "ativando", atualizadaEm, ...extra } })!;

  it("ativando parado há mais de 2 minutos, ou sem o campo (estado antigo), é abandonado", () => {
    const limite = 2 * 60 * 1000;
    expect(ativacaoAbandonada(ativando("2026-11-12T09:59:00.000Z"), AGORA, limite)).toBe(false);
    expect(ativacaoAbandonada(ativando("2026-11-12T09:58:00.000Z"), AGORA, limite)).toBe(false);
    expect(ativacaoAbandonada(ativando("2026-11-12T09:57:59.000Z"), AGORA, limite)).toBe(true);
    expect(ativacaoAbandonada(ativando(undefined), AGORA, limite)).toBe(true);
    expect(ativacaoAbandonada(ativando("ontem"), AGORA, limite)).toBe(true);
    // só a ativação para no meio
    const ativa = lerLigacoesGravadas({ ligacoes: { situacao: "ativa" } })!;
    expect(ativacaoAbandonada(ativa, AGORA, limite)).toBe(false);
  });

  it("o que foi criado: a Meta (metaSip) e os ids não nulos, na ordem da desmontagem", () => {
    expect(
      criadosNaAtivacao(ativando("", { metaSip: true, eleven: { segredoId: "s", agenteId: "a" } })),
    ).toEqual(["meta", "agente", "segredo"]);
    expect(criadosNaAtivacao(ativando(""))).toEqual([]);
  });
});

describe("manterLigacoes", () => {
  it("copia o estado e os dois segredos das ligações para a conexão regravada", () => {
    const r = manterLigacoes(
      {
        parametros: { phoneId: "1", wabaId: "velho", ligacoes: { versao: 1 } },
        segredos: { token: "velho", ligacaoToken: "t", ligacaoHmac: "h" },
      },
      { parametros: { phoneId: "1" }, segredos: { token: "novo", appSecret: "a" } },
    );
    expect(r).toEqual({
      parametros: { phoneId: "1", ligacoes: { versao: 1 } },
      segredos: { token: "novo", appSecret: "a", ligacaoToken: "t", ligacaoHmac: "h" },
    });
  });

  it("a verificação (seção 21) fica com o mesmo phoneId e o mesmo token", () => {
    const el = { versao: 1, elegivel: false };
    const r = manterLigacoes(
      {
        parametros: { phoneId: "1", wabaId: "velho", ligacoesElegibilidade: el },
        segredos: { token: "t" },
      },
      { parametros: { phoneId: "1", wabaId: "consertado" }, segredos: { token: "t" } },
    );
    expect(r.parametros).toEqual({ phoneId: "1", wabaId: "consertado", ligacoesElegibilidade: el });
  });

  it.each([
    ["outro token", { phoneId: "1" }, { token: "novo" }],
    ["outro phoneId", { phoneId: "2" }, { token: "t" }],
    ["sem phoneId", {}, { token: "t" }],
    ["sem token", { phoneId: "1" }, {}],
  ])("a verificação cai com %s: o que ela conferiu mudou", (_n, parametros, segredos) => {
    const r = manterLigacoes(
      {
        parametros: { phoneId: "1", ligacoesElegibilidade: { versao: 1 } },
        segredos: { token: "t" } as Record<string, string>,
      },
      { parametros, segredos: segredos as Record<string, string> },
    );
    expect(r.parametros).not.toHaveProperty("ligacoesElegibilidade");
  });

  it("sem ligações antes, nada muda", () => {
    const novos = { parametros: { phoneId: "1" }, segredos: { token: "novo" } };
    expect(manterLigacoes({ parametros: {}, segredos: {} }, novos)).toEqual(novos);
  });
});
