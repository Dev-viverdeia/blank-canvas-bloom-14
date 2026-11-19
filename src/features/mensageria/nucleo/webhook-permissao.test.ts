import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConexaoServidor, Evento } from "./tipos";

// A resposta do lead ao pedido de permissão para ligar (seção 3).
const falso = vi.hoisted(() => ({
  updates: [] as { tabela: string; valores: unknown; filtros: [string, unknown][] }[],
  erro: null as unknown,
  casaram: 1,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (tabela: string) => {
      const q = { tabela, valores: null as unknown, filtros: [] as [string, unknown][] };
      const b = {
        update: (v: unknown) => ((q.valores = v), b),
        eq: (c: string, v: unknown) => (q.filtros.push([c, v]), b),
        select: () => b,
        then: (ok: (v: unknown) => unknown) => {
          falso.updates.push(q);
          const data = falso.erro
            ? null
            : Array.from({ length: falso.casaram }, (_, i) => ({ id: i }));
          return Promise.resolve({ data, error: falso.erro }).then(ok);
        },
      };
      return b;
    },
  },
}));

import { aplicarEventos } from "./webhook.server";

const conexao: ConexaoServidor = {
  id: "cx-1",
  gateway: "meta",
  id_externo: "106540352242922",
  parametros: {},
  segredos: {},
  oficial: true,
};

const evento = (o: Partial<Extract<Evento, { tipo: "permissao_ligar" }>> = {}): Evento => ({
  tipo: "permissao_ligar",
  pedidoId: "wamid.P1",
  resposta: "aceitou",
  permanente: false,
  expiraEm: "2026-11-24T15:00:00.000Z",
  momento: "2026-11-17T15:00:00.000Z",
  ...o,
});

beforeEach(() => {
  falso.updates = [];
  falso.erro = null;
  falso.casaram = 1;
});

describe("aplicarEventos: permissao_ligar", () => {
  it("grava a resposta no pedido citado, da mesma conexão", async () => {
    expect(await aplicarEventos([evento()], conexao, 1)).toEqual({ pendente: false });
    expect(falso.updates).toEqual([
      {
        tabela: "ligacao_permissoes",
        valores: {
          resposta: "aceitou",
          permanente: false,
          expira_em: "2026-11-24T15:00:00.000Z",
          respondido_em: "2026-11-17T15:00:00.000Z",
        },
        filtros: [
          ["conexao_id", "cx-1"],
          ["id_gateway", "wamid.P1"],
        ],
      },
    ]);
  });

  it("a resposta que chega antes de o pedido ficar gravado: o evento fica pendente (Sol, PR #24)", async () => {
    falso.casaram = 0;
    expect(await aplicarEventos([evento()], conexao, 1)).toEqual({ pendente: true });
  });

  it("a recusa não guarda permanente", async () => {
    await aplicarEventos(
      [evento({ resposta: "recusou", permanente: true, expiraEm: null })],
      conexao,
      1,
    );
    expect(falso.updates[0]?.valores).toMatchObject({ resposta: "recusou", permanente: null });
  });

  it("erro do banco lança (o evento fica para nova tentativa)", async () => {
    falso.erro = { message: "x" };
    await expect(aplicarEventos([evento()], conexao, 1)).rejects.toThrow("banco_permissao_ligar");
  });
});
