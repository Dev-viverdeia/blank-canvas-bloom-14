import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Elegibilidade, LigacoesGravadas } from "../ligacoes/tipos";

// supabaseAdmin falso: cada from() vira uma cadeia que guarda as chamadas e responde com o que o
// teste deixar em `estado.respostas` (na ordem), como o PostgREST faria.
type Chamada = { tabela: string; passos: [string, ...unknown[]][] };
const estado = vi.hoisted(() => ({
  chamadas: [] as Chamada[],
  respostas: [] as { data: unknown; error: unknown }[],
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const cadeia = (tabela: string) => {
    const chamada: Chamada = { tabela, passos: [] };
    estado.chamadas.push(chamada);
    const responder = () =>
      Promise.resolve(estado.respostas.shift() ?? { data: null, error: null });
    const c: Record<string, unknown> = {};
    for (const nome of ["select", "update", "eq", "is", "not", "order", "limit"]) {
      c[nome] = (...args: unknown[]) => {
        chamada.passos.push([nome, ...args]);
        return c;
      };
    }
    c["maybeSingle"] = () => {
      chamada.passos.push(["maybeSingle"]);
      return responder();
    };
    c["then"] = (ok: (v: unknown) => unknown, falha: (e: unknown) => unknown) =>
      responder().then(ok, falha);
    return c;
  };
  return { supabaseAdmin: { from: cadeia } };
});
vi.mock("../nucleo/cifra", () => ({
  aadConexao: (id: string, nome: string) => `${id}:${nome}`,
  cifrar: async (texto: string, aad: string) =>
    `v1:${Buffer.from(aad).toString("base64")}:${Buffer.from(texto).toString("base64")}`,
}));

import {
  agentesDasLigacoes,
  existemLigacoes,
  gravarElegibilidade,
  gravarLigacoes,
  lerVersaoConexao,
  lerVersaoConexaoAtiva,
  gravarProgressoLigacoes,
  idConexaoComLigacoesPendentes,
  iniciarLigacoes,
  limparLigacoes,
} from "./ligacoes-banco.server";

const ID = "c0ffee00-0000-4000-8000-0000000000aa";
const TOKEN = "token-ligacao-em-texto-puro-TOKEN123";
const HMAC = "hmac-em-texto-puro-HMAC456";
const META_CIFRADOS = {
  token: "v1:AAA=:BBB=",
  appSecret: "v1:CCC=:DDD=",
  verifyToken: "v1:EEE=:FFF=",
};
const PARAMETROS = { phoneId: "106540352242922", wabaId: "998877" };

const UMA = { data: [{ id: ID }], error: null };
const NENHUMA = { data: [], error: null };

function ligacoes(o: Partial<LigacoesGravadas> = {}): LigacoesGravadas {
  return {
    versao: 1,
    situacao: "ativando",
    origem: "https://nina.exemplo.com",
    numero: "5511999990000",
    limiteMeta: null,
    ativadaEm: null,
    eleven: {
      segredoId: null,
      webhookId: null,
      ferramentaId: null,
      agenteId: null,
      troncoId: null,
    },
    metaSip: false,
    pendencias: [],
    atualizadaEm: "2026-11-12T10:00:00.000Z",
    ...o,
  };
}

function cifradoDe(nome: string, texto: string): string {
  return `v1:${Buffer.from(`${ID}:${nome}`).toString("base64")}:${Buffer.from(texto).toString("base64")}`;
}

function passos(i: number) {
  return estado.chamadas[i]?.passos ?? [];
}
function valorDe(passo: string, i: number): Record<string, unknown> {
  return (passos(i).find((p) => p[0] === passo)?.[1] ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  estado.chamadas = [];
  estado.respostas = [];
});

const ELEGIBILIDADE: Elegibilidade = {
  versao: 1,
  elegivel: false,
  limiteMeta: "TIER_250",
  itens: [{ id: "meta_limite", dono: "meta", estado: "falta", valor: "TIER_250" }],
  conferidaEm: "2026-11-17T15:00:00.000Z",
};
const LIDA = (o: Record<string, unknown> = {}) => ({
  data: {
    parametros: { ...PARAMETROS, ligacoes: ligacoes() },
    atualizado_em: "2026-11-17T14:00:00.123456+00:00",
    ativa: true,
    status: "conectada",
    ...o,
  },
  error: null,
});

const VERSAO = { id: ID, atualizadoEm: "2026-11-17T14:00:00.123456+00:00", status: "conectada" };

describe("gravarElegibilidade (seção 21)", () => {
  it("lerVersaoConexaoAtiva e lerVersaoConexao: o id e o atualizado_em", async () => {
    const linhaVersao = { id: ID, atualizado_em: VERSAO.atualizadoEm, status: "conectada" };
    estado.respostas.push(
      { data: linhaVersao, error: null },
      { data: linhaVersao, error: null },
      { data: null, error: null },
    );
    expect(await lerVersaoConexaoAtiva()).toEqual(VERSAO);
    expect(passos(0)).toContainEqual(["select", "id, atualizado_em, status"]);
    expect(passos(0)).toContainEqual(["eq", "ativa", true]);
    expect(await lerVersaoConexao(ID)).toEqual(VERSAO);
    expect(passos(1)).toContainEqual(["eq", "id", ID]);
    expect(await lerVersaoConexao(ID)).toBeNull();
    estado.respostas.push({ data: null, error: { message: "x" } });
    await expect(lerVersaoConexaoAtiva()).rejects.toThrow("banco_ler_conexao");
  });

  it("junta só a chave nova aos parametros, com a trava da versão lida antes de conferir", async () => {
    estado.respostas.push(LIDA(), UMA);
    expect(await gravarElegibilidade(VERSAO, ELEGIBILIDADE)).toBe(true);
    expect(passos(0)).toContainEqual(["select", "parametros, atualizado_em, ativa, status"]);
    expect(passos(0)).toContainEqual(["eq", "id", ID]);
    // nada some: phoneId, wabaId e o estado das ligações ficam como foram lidos
    expect(valorDe("update", 1)).toEqual({
      parametros: { ...PARAMETROS, ligacoes: ligacoes(), ligacoesElegibilidade: ELEGIBILIDADE },
    });
    expect(passos(1)).toContainEqual(["eq", "id", ID]);
    expect(passos(1)).toContainEqual(["eq", "ativa", true]);
    expect(passos(1)).toContainEqual(["eq", "status", "conectada"]);
    expect(passos(1)).toContainEqual(["eq", "atualizado_em", VERSAO.atualizadoEm]);
    expect(passos(1)).toContainEqual(["select", "id"]);
  });

  it("a linha mudou depois da versão lida (na leitura ou entre a leitura e a escrita): false, sem tentar de novo", async () => {
    estado.respostas.push(LIDA({ atualizado_em: "2026-11-17T14:00:01.000000+00:00" }));
    expect(await gravarElegibilidade(VERSAO, ELEGIBILIDADE)).toBe(false);
    expect(estado.chamadas).toHaveLength(1);
    estado.chamadas = [];
    estado.respostas.push(LIDA(), NENHUMA);
    expect(await gravarElegibilidade(VERSAO, ELEGIBILIDADE)).toBe(false);
    expect(estado.chamadas).toHaveLength(2);
  });

  it("seLigacoes (a recusa tardia): só sobre o estado das ligações que a ativação deixou", async () => {
    // LIDA tem ligacoes com atualizadaEm "2026-11-12T10:00:00.000Z"
    estado.respostas.push(LIDA());
    expect(await gravarElegibilidade(VERSAO, ELEGIBILIDADE, null)).toBe(false);
    estado.respostas.push(LIDA());
    expect(await gravarElegibilidade(VERSAO, ELEGIBILIDADE, "2026-11-17T00:00:00.000Z")).toBe(
      false,
    );
    expect(estado.chamadas).toHaveLength(2);
    estado.respostas.push(LIDA(), UMA);
    expect(await gravarElegibilidade(VERSAO, ELEGIBILIDADE, "2026-11-12T10:00:00.000Z")).toBe(true);
    estado.respostas.push(LIDA({ parametros: PARAMETROS }), UMA);
    expect(await gravarElegibilidade(VERSAO, ELEGIBILIDADE, null)).toBe(true);
  });

  it("seConferidaEm: só por cima da verificação guardada com esse conferidaEm", async () => {
    const guardada = { ...ELEGIBILIDADE, conferidaEm: "2026-11-17T13:00:00.000Z" };
    const comGuardada = { parametros: { ...PARAMETROS, ligacoesElegibilidade: guardada } };
    estado.respostas.push(LIDA(comGuardada));
    expect(await gravarElegibilidade(VERSAO, ELEGIBILIDADE, null, "2026-11-17T12:00:00.000Z")).toBe(
      false,
    );
    expect(estado.chamadas).toHaveLength(1);
    estado.respostas.push(LIDA(comGuardada), UMA);
    expect(await gravarElegibilidade(VERSAO, ELEGIBILIDADE, null, "2026-11-17T13:00:00.000Z")).toBe(
      true,
    );
  });

  it.each([
    ["inativa", { ativa: false }],
    ["caída (o atualizado_em é a hora da queda no painel)", { status: "erro" }],
    ["desconectada", { status: "desconectada" }],
  ])("conexão %s: false, sem update", async (_n, o) => {
    estado.respostas.push(LIDA(o));
    expect(await gravarElegibilidade(VERSAO, ELEGIBILIDADE)).toBe(false);
    expect(estado.chamadas).toHaveLength(1);
  });

  it("a linha sumiu: false; erro de banco na leitura ou na escrita lança", async () => {
    estado.respostas.push({ data: null, error: null });
    expect(await gravarElegibilidade(VERSAO, ELEGIBILIDADE)).toBe(false);
    estado.respostas.push({ data: null, error: { message: "x" } });
    await expect(gravarElegibilidade(VERSAO, ELEGIBILIDADE)).rejects.toThrow("banco_ler_conexao");
    estado.respostas.push(LIDA(), { data: null, error: { message: "x" } });
    await expect(gravarElegibilidade(VERSAO, ELEGIBILIDADE)).rejects.toThrow(
      "banco_gravar_elegibilidade",
    );
  });
});

describe("banco das ligações", () => {
  it("iniciarLigacoes: junta aos parametros e aos segredos da Meta, com a trava do duplo clique", async () => {
    estado.respostas.push(
      { data: { parametros: PARAMETROS, segredos: META_CIFRADOS }, error: null },
      UMA,
    );
    expect(await iniciarLigacoes(ID, ligacoes(), TOKEN)).toBe(true);
    expect(passos(0)).toContainEqual(["select", "parametros, segredos"]);
    expect(passos(0)).toContainEqual(["eq", "id", ID]);
    const escrita = valorDe("update", 1);
    expect(escrita["parametros"]).toEqual({ ...PARAMETROS, ligacoes: ligacoes() });
    expect(escrita["segredos"]).toEqual({
      ...META_CIFRADOS,
      ligacaoToken: cifradoDe("ligacaoToken", TOKEN),
    });
    expect(passos(1)).toContainEqual(["eq", "id", ID]);
    // a conexão que saiu no meio não recebe a ativação (D21)
    expect(passos(1)).toContainEqual(["eq", "ativa", true]);
    expect(passos(1)).toContainEqual(["is", "parametros->ligacoes", null]);
    expect(passos(1)).toContainEqual(["select", "id"]);
    expect(JSON.stringify(estado.chamadas)).not.toContain(TOKEN);
  });

  it("iniciarLigacoes: já tinha ligações, ou a trava perdeu: false", async () => {
    estado.respostas.push({
      data: { parametros: { ...PARAMETROS, ligacoes: ligacoes() }, segredos: META_CIFRADOS },
      error: null,
    });
    expect(await iniciarLigacoes(ID, ligacoes(), TOKEN)).toBe(false);
    expect(estado.chamadas).toHaveLength(1);

    estado.chamadas = [];
    estado.respostas.push(
      { data: { parametros: PARAMETROS, segredos: META_CIFRADOS }, error: null },
      NENHUMA,
    );
    expect(await iniciarLigacoes(ID, ligacoes(), TOKEN)).toBe(false);
  });

  it("gravarLigacoes (D28): troca só a chave ligacoes, com a trava do atualizadaEm lido", async () => {
    const ANTES = "2026-11-12T10:00:00.000Z";
    estado.respostas.push(
      {
        data: {
          parametros: { ...PARAMETROS, ligacoes: ligacoes({ atualizadaEm: ANTES }) },
          segredos: { ...META_CIFRADOS, ligacaoToken: "v1:TTT=:TTT=" },
        },
        error: null,
      },
      UMA,
    );
    const novo = ligacoes({ eleven: { ...ligacoes().eleven, segredoId: "seg_1" } });
    expect(await gravarLigacoes(ID, novo, ANTES)).toBe(true);
    const escrita = valorDe("update", 1);
    expect(escrita["parametros"]).toEqual({ ...PARAMETROS, ligacoes: novo });
    // sem segredo novo, a coluna segredos fica de fora
    expect(escrita).not.toHaveProperty("segredos");
    expect(passos(1)).toContainEqual(["eq", "id", ID]);
    expect(passos(1)).toContainEqual(["eq", "parametros->ligacoes->>atualizadaEm", ANTES]);
    // fora da ativação, a conexão pode já estar desativada (pendências do Desconectar)
    expect(passos(1).some((p) => p[0] === "eq" && p[1] === "ativa")).toBe(false);
    expect(passos(1)).toContainEqual(["select", "id"]);
  });

  it("gravarLigacoes: anterior null só grava onde não há ligações", async () => {
    estado.respostas.push({ data: { parametros: PARAMETROS, segredos: {} }, error: null }, UMA);
    expect(await gravarLigacoes(ID, ligacoes(), null)).toBe(true);
    expect(passos(1)).toContainEqual(["is", "parametros->ligacoes", null]);
    estado.chamadas = [];
    estado.respostas.push({
      data: { parametros: { ...PARAMETROS, ligacoes: ligacoes() }, segredos: {} },
      error: null,
    });
    expect(await gravarLigacoes(ID, ligacoes(), null)).toBe(false);
    expect(estado.chamadas).toHaveLength(1);
  });

  it("gravarLigacoes: alguém gravou depois (na leitura ou entre a leitura e a escrita): false; erro de banco lança", async () => {
    const ANTES = "2026-11-12T10:00:00.000Z";
    estado.respostas.push({
      data: {
        parametros: { ligacoes: ligacoes({ atualizadaEm: "2026-11-12T10:00:09.000Z" }) },
        segredos: {},
      },
      error: null,
    });
    expect(await gravarLigacoes(ID, ligacoes(), ANTES)).toBe(false);
    expect(estado.chamadas).toHaveLength(1);
    estado.respostas.push(
      {
        data: { parametros: { ligacoes: ligacoes({ atualizadaEm: ANTES }) }, segredos: {} },
        error: null,
      },
      NENHUMA,
    );
    expect(await gravarLigacoes(ID, ligacoes(), ANTES)).toBe(false);
    estado.respostas.push(
      {
        data: { parametros: { ligacoes: ligacoes({ atualizadaEm: ANTES }) }, segredos: {} },
        error: null,
      },
      { data: null, error: { message: "x" } },
    );
    await expect(gravarLigacoes(ID, ligacoes(), ANTES)).rejects.toThrow("banco_gravar_ligacoes");
    estado.respostas.push({ data: null, error: { message: "x" } });
    await expect(gravarLigacoes(ID, ligacoes(), ANTES)).rejects.toThrow("banco_ler_conexao");
  });

  it("gravarProgressoLigacoes (D21): grava com a trava da conexão ativa e da mesma ativação", async () => {
    const ANTES = "2026-11-12T10:00:00.000Z";
    estado.respostas.push(
      {
        data: {
          parametros: { ...PARAMETROS, ligacoes: ligacoes({ atualizadaEm: ANTES }) },
          segredos: { ...META_CIFRADOS, ligacaoToken: "v1:TTT=:TTT=" },
        },
        error: null,
      },
      UMA,
    );
    const novo = ligacoes({
      eleven: { ...ligacoes().eleven, webhookId: "wh_1" },
      atualizadaEm: "2026-11-12T10:00:05.000Z",
    });
    expect(await gravarProgressoLigacoes(ID, novo, ANTES, { ligacaoHmac: HMAC })).toBe(true);
    const escrita = valorDe("update", 1);
    expect(escrita["parametros"]).toEqual({ ...PARAMETROS, ligacoes: novo });
    expect(escrita["segredos"]).toEqual({
      ...META_CIFRADOS,
      ligacaoToken: "v1:TTT=:TTT=",
      ligacaoHmac: cifradoDe("ligacaoHmac", HMAC),
    });
    expect(passos(1)).toContainEqual(["eq", "id", ID]);
    expect(passos(1)).toContainEqual(["eq", "ativa", true]);
    expect(passos(1)).toContainEqual(["eq", "parametros->ligacoes->>situacao", "ativando"]);
    expect(passos(1)).toContainEqual(["eq", "parametros->ligacoes->>atualizadaEm", ANTES]);
    expect(passos(1)).toContainEqual(["select", "id"]);
  });

  it("gravarProgressoLigacoes: outra ativação, desmontada, ou a trava perdeu: false, sem gravar", async () => {
    const ANTES = "2026-11-12T10:00:00.000Z";
    for (const gravada of [
      undefined,
      ligacoes({ atualizadaEm: "2026-11-12T10:01:00.000Z" }),
      ligacoes({ situacao: "com_pendencias", atualizadaEm: ANTES }),
    ]) {
      estado.chamadas = [];
      estado.respostas.push({
        data: {
          parametros: { ...PARAMETROS, ...(gravada ? { ligacoes: gravada } : {}) },
          segredos: {},
        },
        error: null,
      });
      expect(await gravarProgressoLigacoes(ID, ligacoes(), ANTES)).toBe(false);
      expect(estado.chamadas).toHaveLength(1);
    }
    // a leitura bate, mas a conexão saiu antes da escrita (0 linhas)
    estado.respostas.push(
      {
        data: { parametros: { ligacoes: ligacoes({ atualizadaEm: ANTES }) }, segredos: {} },
        error: null,
      },
      NENHUMA,
    );
    expect(await gravarProgressoLigacoes(ID, ligacoes(), ANTES)).toBe(false);
    estado.respostas.push(
      {
        data: { parametros: { ligacoes: ligacoes({ atualizadaEm: ANTES }) }, segredos: {} },
        error: null,
      },
      { data: null, error: { message: "x" } },
    );
    await expect(gravarProgressoLigacoes(ID, ligacoes(), ANTES)).rejects.toThrow(
      "banco_gravar_ligacoes",
    );
  });

  it("existemLigacoes (D22): alguma conexão, ativa ou não, com parametros.ligacoes", async () => {
    estado.respostas.push({ data: [{ id: "x" }], error: null });
    expect(await existemLigacoes()).toBe(true);
    expect(passos(0)).toContainEqual(["not", "parametros->ligacoes", "is", null]);
    expect(passos(0).some((p) => p[0] === "eq" && p[1] === "ativa")).toBe(false);
    estado.respostas.push({ data: [], error: null });
    expect(await existemLigacoes()).toBe(false);
    estado.respostas.push({ data: null, error: { message: "x" } });
    await expect(existemLigacoes()).rejects.toThrow("banco_ler_conexao");
  });

  it("limparLigacoes: tira só ligacoes e os dois segredos, com a trava (D28)", async () => {
    const ANTES = "2026-11-12T10:00:00.000Z";
    estado.respostas.push(
      {
        data: {
          parametros: { ...PARAMETROS, ligacoes: ligacoes({ atualizadaEm: ANTES }) },
          segredos: { ...META_CIFRADOS, ligacaoToken: "v1:TTT=:TTT=", ligacaoHmac: "v1:HHH=:HHH=" },
        },
        error: null,
      },
      UMA,
    );
    expect(await limparLigacoes(ID, ANTES)).toBe(true);
    const escrita = valorDe("update", 1);
    expect(escrita["parametros"]).toEqual(PARAMETROS);
    expect(escrita["segredos"]).toEqual(META_CIFRADOS);
    expect(passos(1)).toContainEqual(["eq", "parametros->ligacoes->>atualizadaEm", ANTES]);
  });

  it("limparLigacoes numa conexão desativada (segredos já vazios): não mexe nos segredos", async () => {
    const ANTES = "2026-11-12T10:00:00.000Z";
    estado.respostas.push(
      {
        data: { parametros: { ligacoes: ligacoes({ atualizadaEm: ANTES }) }, segredos: {} },
        error: null,
      },
      UMA,
    );
    expect(await limparLigacoes(ID, ANTES)).toBe(true);
    expect(valorDe("update", 1)).not.toHaveProperty("segredos");
    expect(valorDe("update", 1)["parametros"]).toEqual({});
  });

  it("limparLigacoes: alguém gravou depois, ou já limpou: false, sem gravar", async () => {
    const ANTES = "2026-11-12T10:00:00.000Z";
    for (const parametros of [
      { ligacoes: ligacoes({ atualizadaEm: "2026-11-12T10:00:09.000Z" }) },
      PARAMETROS,
    ]) {
      estado.chamadas = [];
      estado.respostas.push({ data: { parametros, segredos: {} }, error: null });
      expect(await limparLigacoes(ID, ANTES)).toBe(false);
      expect(estado.chamadas).toHaveLength(1);
    }
    // o estado antigo, sem atualizadaEm: o filtro pede o campo ausente
    const { atualizadaEm: _a, ...semCampo } = ligacoes();
    estado.chamadas = [];
    estado.respostas.push(
      { data: { parametros: { ligacoes: semCampo }, segredos: {} }, error: null },
      UMA,
    );
    expect(await limparLigacoes(ID, "")).toBe(true);
    expect(passos(1)).toContainEqual(["is", "parametros->ligacoes->>atualizadaEm", null]);
  });

  it("agentesDasLigacoes (D29): o agente de cada conexão com ligações, null onde não há", async () => {
    estado.respostas.push({
      data: [
        {
          parametros: {
            ligacoes: ligacoes({ eleven: { ...ligacoes().eleven, agenteId: "agent_1" } }),
          },
        },
        { parametros: { ligacoes: ligacoes() } },
      ],
      error: null,
    });
    expect(await agentesDasLigacoes()).toEqual(["agent_1", null]);
    expect(passos(0)).toContainEqual(["not", "parametros->ligacoes", "is", null]);
    estado.respostas.push({ data: [], error: null });
    expect(await agentesDasLigacoes()).toEqual([]);
    estado.respostas.push({ data: null, error: { message: "x" } });
    await expect(agentesDasLigacoes()).rejects.toThrow("banco_ler_conexao");
  });

  it("idConexaoComLigacoesPendentes: só as inativas com parametros.ligacoes", async () => {
    estado.respostas.push({ data: { id: "antiga" }, error: null });
    expect(await idConexaoComLigacoesPendentes()).toBe("antiga");
    expect(passos(0)).toContainEqual(["eq", "ativa", false]);
    expect(passos(0)).toContainEqual(["not", "parametros->ligacoes", "is", null]);
    estado.respostas.push({ data: null, error: null });
    expect(await idConexaoComLigacoesPendentes()).toBeNull();
    estado.respostas.push({ data: null, error: { message: "x" } });
    await expect(idConexaoComLigacoesPendentes()).rejects.toThrow("banco_ler_conexao");
  });
});
