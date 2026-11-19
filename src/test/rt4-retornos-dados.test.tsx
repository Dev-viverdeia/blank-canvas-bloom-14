import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AssinanteTempoReal,
  CHAVES,
  COLUNAS_MENSAGEM,
  COLUNAS_RETORNO,
  INVALIDA,
  NOME_CANAL,
  POR_TABELA,
  ProvedorDados,
  TABELAS_DA_ACAO,
  TABELAS_TEMPO_REAL,
  CODIGOS_DO_BANCO,
  traduzirErro,
  useAjusteLembrete,
  useCancelarRetorno,
  useRetornos,
  type AjusteLembrete,
  type Leitura,
  type Resultado,
  type RetornoDados,
} from "@/features/plataforma/dados";
import {
  criarAcoesConfiguracaoBanco,
  type ServidorConfiguracao,
} from "@/features/plataforma/dados/configuracao";
import { lerPendencias, opcoesMotor } from "@/features/plataforma/dados/motor";
import {
  AJUSTE_LEMBRETE_PADRAO,
  lerAjusteLembrete,
  opcoesAjusteLembrete,
  opcoesRetornos,
} from "@/features/plataforma/dados/retornos";
import { criarClienteFalso, type Consulta } from "@/features/plataforma/dados/testes/clienteFalso";
import { criarEstadoInicial, useExemplo, type EstadoBase } from "@/features/plataforma/exemplo";
import { ProvedorPapel } from "@/features/plataforma/papel";

// T6 da entrega "retornos da Nina" (3.4 e 3.5):
// a camada de dados das telas. A lista fixa de colunas, as duas consultas por conversa e a releitura
// quando `rodadas` ou `mensagens` mudam (a tabela `retornos` NÃO entra no tempo real), a leitura do
// ajuste do lembrete, o cancelar da equipe (cancelando, erro e "já saiu": quadros 11, 12 e 13), o
// motor com os retornos e o `salvarRitmo` com o lembrete.

const CONVERSA = "cv-1";
const AGORA = new Date("2026-11-18T19:09:00.000Z");

/** A fábrica local: uma linha de `retornos` como as telas leem (os padrões são os do quadro 1). */
function linha(parcial: Partial<RetornoDados> = {}): RetornoDados {
  return {
    id: "rt-1",
    conversa_id: CONVERSA,
    tipo: "retorno",
    status: "pendente",
    vence_em: "2026-11-19T12:00:00.000Z",
    expira_em: "2026-11-19T15:00:00.000Z",
    motivo: "Ver o contrato com o sócio",
    marcado_em: "2026-11-18T19:09:00.000Z",
    rodada_origem_id: "rd-1",
    rodada_id: null,
    fechado_por_rodada: null,
    substitui_id: null,
    nao_enviado_motivo: null,
    nota_fim: null,
    cancelado_por: null,
    enviado_em: null,
    resolvido_em: null,
    criado_em: "2026-11-18T19:09:00.000Z",
    ...parcial,
  };
}

const p0001 = (message: string) => ({ code: "P0001", message, details: null, hint: null });

type Banco = { retornos: RetornoDados[]; ajuste: unknown; erroRetornos?: unknown };

function montarBanco(
  banco: Partial<Banco> = {},
  extra: {
    rpc?: (
      nome: string,
      args: Record<string, unknown>,
    ) => { data: unknown; error: unknown } | undefined;
  } = {},
) {
  const b: Banco = { retornos: [], ajuste: null, ...banco };
  const f = criarClienteFalso({
    consulta: (c: Consulta) => {
      if (c.tabela === "retornos") {
        if (b.erroRetornos) return { data: null, error: b.erroRetornos };
        const tipo = c.passos.find((p) => p[0] === "eq" && p[1] === "tipo")?.[2];
        const status = c.passos.find((p) => p[0] === "in" && p[1] === "status")?.[2] as
          string[] | undefined;
        const dados = b.retornos.filter(
          (r) => r.tipo === tipo && (!status || status.includes(r.status)),
        );
        return { data: dados, error: null };
      }
      if (c.tabela === "configuracao") return { data: b.ajuste, error: null };
      return undefined;
    },
    rpc: (nome, args) => extra.rpc?.(nome, args),
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { f, qc, b };
}

function envolver(f: ReturnType<typeof criarClienteFalso>, qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <ProvedorDados fonte="banco" cliente={f.cliente}>
        {children}
      </ProvedorDados>
    </QueryClientProvider>
  );
}

/** Monta um componente que guarda o que o hook devolve a cada pintura. */
function ler<T>(usar: () => T, f: ReturnType<typeof criarClienteFalso>, qc: QueryClient) {
  const ref: { atual: T | undefined } = { atual: undefined };
  function Espiao() {
    ref.atual = usar();
    return null;
  }
  const Envolver = envolver(f, qc);
  const vista = render(
    <Envolver>
      <Espiao />
    </Envolver>,
  );
  return { ref, vista };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("COLUNAS_RETORNO e MensagemDados", () => {
  it("é a lista fixa do desenho (3.4), nunca *", () => {
    expect(COLUNAS_RETORNO).toBe(
      "id, conversa_id, tipo, status, vence_em, expira_em, motivo, marcado_em, rodada_origem_id, rodada_id, fechado_por_rodada, substitui_id, nao_enviado_motivo, nota_fim, cancelado_por, enviado_em, resolvido_em, criado_em",
    );
    expect(COLUNAS_RETORNO).not.toContain("*");
    // as colunas só do banco (a varredura e o relógio) não chegam à tela
    for (const fora of ["tentar_apos", "tentativas", "atualizado_em", "lembrete_horas"]) {
      expect(COLUNAS_RETORNO.split(", ")).not.toContain(fora);
    }
  });

  it("MensagemDados ganha rodada_id: a lista de colunas da mensagem a lê", () => {
    expect(COLUNAS_MENSAGEM.split(", ")).toContain("rodada_id");
  });
});

describe("as duas consultas de retornos por conversa", () => {
  it("1) tipo = retorno, todos os status; 2) tipo = lembrete, só pendente e enviado, pela lista fixa e em páginas", async () => {
    const { f, qc } = montarBanco({
      retornos: [
        linha({ id: "rt-a", criado_em: "2026-11-18T19:09:00.000Z" }),
        linha({
          id: "rt-b",
          tipo: "lembrete",
          status: "pendente",
          criado_em: "2026-11-18T20:00:00.000Z",
        }),
        linha({
          id: "rt-c",
          tipo: "lembrete",
          status: "dispensado",
          criado_em: "2026-11-18T21:00:00.000Z",
        }),
      ],
    });
    const { ref } = ler(() => useRetornos(CONVERSA), f, qc);
    await waitFor(() => expect(ref.atual?.carregando).toBe(false));

    const consultas = f.consultas.filter((c) => c.tabela === "retornos");
    expect(consultas).toHaveLength(2);
    for (const c of consultas) {
      expect(c.op).toBe("select");
      expect(c.valor).toBe(COLUNAS_RETORNO);
      expect(c.passos).toContainEqual(["eq", "conversa_id", CONVERSA]);
      expect(c.passos).toContainEqual(["order", "criado_em"]);
      expect(c.passos).toContainEqual(["order", "id"]);
      expect(c.passos).toContainEqual(["range", 0, 999]);
    }
    const doRetorno = consultas.find((c) =>
      c.passos.some((p) => p[0] === "eq" && p[1] === "tipo" && p[2] === "retorno"),
    )!;
    const doLembrete = consultas.find((c) =>
      c.passos.some((p) => p[0] === "eq" && p[1] === "tipo" && p[2] === "lembrete"),
    )!;
    expect(doRetorno.passos.some((p) => p[0] === "in")).toBe(false);
    expect(doLembrete.passos).toContainEqual(["in", "status", ["pendente", "enviado"]]);

    // juntadas e ordenadas por criado_em: o lembrete dispensado nem chega
    expect(ref.atual?.dados?.map((r) => r.id)).toEqual(["rt-a", "rt-b"]);
  });

  it("a chave fica embaixo de CHAVES.retornos, uma por conversa", () => {
    const { f } = montarBanco();
    const o = opcoesRetornos(f.cliente, CONVERSA);
    expect(CHAVES.retornos).toEqual(["retornos"]);
    expect(o.queryKey).toEqual([...CHAVES.retornos, "da-conversa", CONVERSA]);
    expect(opcoesRetornos(f.cliente, "cv-2").queryKey).not.toEqual(o.queryKey);
  });

  it("empate no criado_em: desempata pelo id", async () => {
    const { f, qc } = montarBanco({
      retornos: [
        linha({ id: "rt-2", criado_em: "2026-11-18T19:09:00.000Z" }),
        linha({ id: "rt-1", tipo: "lembrete", criado_em: "2026-11-18T19:09:00.000Z" }),
      ],
    });
    const { ref } = ler(() => useRetornos(CONVERSA), f, qc);
    await waitFor(() => expect(ref.atual?.carregando).toBe(false));
    expect(ref.atual?.dados?.map((r) => r.id)).toEqual(["rt-1", "rt-2"]);
  });

  it("sem conversa: lista vazia pronta, sem ir ao banco", () => {
    const { f, qc } = montarBanco();
    const { ref } = ler(() => useRetornos(null), f, qc);
    expect(ref.atual).toMatchObject({ dados: [], carregando: false, erro: null });
    expect(f.consultas.filter((c) => c.tabela === "retornos")).toHaveLength(0);
  });

  it("erro na leitura: a leitura traz o erro traduzido (a tela mantém o log)", async () => {
    const { f, qc } = montarBanco({
      erroRetornos: { code: "42501", message: "permission denied" },
    });
    const { ref } = ler(() => useRetornos(CONVERSA), f, qc);
    await waitFor(() => expect(ref.atual?.carregando).toBe(false));
    expect(ref.atual?.erro).toBe("sem_acesso");
    expect(ref.atual?.dados).toBeUndefined();
  });

  describe("releitura sozinha: 60 s só com retorno aberto", () => {
    const intervalo = (dados: RetornoDados[] | undefined) => {
      const { f } = montarBanco();
      const o = opcoesRetornos(f.cliente, CONVERSA);
      const fn = o.refetchInterval as (q: {
        state: { data: RetornoDados[] | undefined };
      }) => number | false;
      return fn({ state: { data: dados } });
    };

    it("retorno pendente ou em andamento (fora dos 4 finais): 60 000 ms", () => {
      expect(intervalo([linha({ status: "pendente" })])).toBe(60_000);
      expect(intervalo([linha({ status: "em_rodada" })])).toBe(60_000);
      expect(intervalo([linha({ status: "saindo" })])).toBe(60_000);
    });

    it("sem nada, só retorno finalizado ou só lembrete: nunca", () => {
      expect(intervalo(undefined)).toBe(false);
      expect(intervalo([])).toBe(false);
      expect(intervalo([linha({ status: "enviado" }), linha({ status: "cancelado" })])).toBe(false);
      expect(intervalo([linha({ status: "dispensado" }), linha({ status: "nao_enviado" })])).toBe(
        false,
      );
      expect(intervalo([linha({ tipo: "lembrete", status: "pendente" })])).toBe(false);
    });
  });
});

describe("tempo real: a tabela retornos NÃO entra; rodadas e mensagens deixam a leitura velha", () => {
  it("POR_TABELA: mensagens e rodadas ganham retornos; retornos lê só a si mesma", () => {
    expect(POR_TABELA.mensagens).toContain("retornos");
    expect(POR_TABELA.rodadas).toContain("retornos");
    expect([...POR_TABELA.rodadas].sort()).toEqual([
      "custos",
      "dashboard",
      "historico",
      "retornos",
    ]);
    expect(POR_TABELA.retornos).toEqual(["retornos"]);
  });

  it("a lista do tempo real continua com as 9 tabelas, sem retornos", () => {
    expect(TABELAS_TEMPO_REAL).toHaveLength(9);
    expect(TABELAS_TEMPO_REAL).not.toContain("retornos");
  });

  it("apagar o contato leva os retornos (a cascata do banco)", () => {
    expect(TABELAS_DA_ACAO.apagarContato).toContain("retornos");
    expect(INVALIDA.apagarContato).toContain("retornos");
  });

  it("aviso de rodadas ou de mensagens invalida a raiz retornos", () => {
    const f = criarClienteFalso();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidar = vi.spyOn(qc, "invalidateQueries");
    render(
      <QueryClientProvider client={qc}>
        <ProvedorDados fonte="banco" cliente={f.cliente}>
          <AssinanteTempoReal juntarMs={0} />
        </ProvedorDados>
      </QueryClientProvider>,
    );
    const canal = f.canais.find((c) => c.nome === NOME_CANAL)!;
    const raizes = () =>
      invalidar.mock.calls.map(
        (c) => (c[0] as { queryKey?: readonly string[] } | undefined)?.queryKey?.[0],
      );
    act(() => canal.emitir({ table: "rodadas", eventType: "UPDATE", new: { id: "rd-1" } }));
    expect(raizes()).toContain("retornos");
    invalidar.mockClear();
    act(() => canal.emitir({ table: "mensagens", eventType: "UPDATE", new: { id: "m-1" } }));
    expect(raizes()).toContain("retornos");
    // e a leitura aberta fica velha de verdade
    qc.setQueryData([...CHAVES.retornos, "da-conversa", CONVERSA], [linha()]);
    act(() => canal.emitir({ table: "rodadas", eventType: "INSERT", new: { id: "rd-2" } }));
    expect(qc.getQueryState([...CHAVES.retornos, "da-conversa", CONVERSA])?.isInvalidated).toBe(
      true,
    );
  });
});

describe("o ajuste do lembrete", () => {
  it("o padrão é ligado, 3 h", () => {
    expect(AJUSTE_LEMBRETE_PADRAO).toEqual({ ligado: true, horas: 3 });
  });

  it.each([
    [null, { ligado: true, horas: 3 }],
    [undefined, { ligado: true, horas: 3 }],
    [{}, { ligado: true, horas: 3 }],
    [
      { lembrete_ligado: false, lembrete_horas: 6 },
      { ligado: false, horas: 6 },
    ],
    [
      { lembrete_ligado: true, lembrete_horas: 23 },
      { ligado: true, horas: 23 },
    ],
    [
      { lembrete_ligado: true, lembrete_horas: 1 },
      { ligado: true, horas: 1 },
    ],
    // campo a campo: um valor torto não derruba o outro
    [
      { lembrete_ligado: false, lembrete_horas: 0 },
      { ligado: false, horas: 3 },
    ],
    [
      { lembrete_ligado: false, lembrete_horas: 24 },
      { ligado: false, horas: 3 },
    ],
    [
      { lembrete_ligado: false, lembrete_horas: 2.5 },
      { ligado: false, horas: 3 },
    ],
    [
      { lembrete_ligado: false, lembrete_horas: "5" },
      { ligado: false, horas: 3 },
    ],
    [
      { lembrete_ligado: "sim", lembrete_horas: 5 },
      { ligado: true, horas: 5 },
    ],
    [
      { lembrete_ligado: null, lembrete_horas: null },
      { ligado: true, horas: 3 },
    ],
  ])("lerAjusteLembrete(%j) = %j", (entrada, esperado) => {
    expect(lerAjusteLembrete(entrada)).toEqual(esperado);
  });

  it("lê só as 2 colunas da linha 1 da configuração, sem mexer em COLUNAS_CONFIGURACAO", async () => {
    const { f, qc } = montarBanco({ ajuste: { lembrete_ligado: false, lembrete_horas: 5 } });
    const { ref } = ler(() => useAjusteLembrete(), f, qc);
    await waitFor(() => expect(ref.atual?.carregando).toBe(false));
    expect(ref.atual?.dados).toEqual({ ligado: false, horas: 5 });
    const c = f.consultas.find((x) => x.tabela === "configuracao")!;
    expect(c.valor).toBe("lembrete_ligado, lembrete_horas");
    expect(c.passos).toContainEqual(["eq", "id", 1]);
    expect(c.unica).toBe(true);
  });

  it("a chave fica embaixo de CHAVES.configuracao (salvar o ritmo já relê a raiz) e relê a cada 60 s", () => {
    const { f } = montarBanco();
    const o = opcoesAjusteLembrete(f.cliente);
    expect(o.queryKey).toEqual([...CHAVES.configuracao, "lembrete"]);
    expect(o.refetchInterval).toBe(60_000);
  });

  it("sem linha na configuração: o padrão", async () => {
    const { f, qc } = montarBanco({ ajuste: null });
    const { ref } = ler(() => useAjusteLembrete(), f, qc);
    await waitFor(() => expect(ref.atual?.carregando).toBe(false));
    expect(ref.atual?.dados).toEqual({ ligado: true, horas: 3 });
  });

  it("habilitado = false: não vai ao banco e a leitura não fica carregando", () => {
    const { f, qc } = montarBanco();
    const { ref } = ler(() => useAjusteLembrete(false), f, qc);
    expect(ref.atual).toMatchObject({ dados: undefined, carregando: false, erro: null });
    expect(f.consultas.filter((c) => c.tabela === "configuracao")).toHaveLength(0);
  });
});

describe("cancelar da equipe (useCancelarRetorno)", () => {
  function montarCancelar(
    rpc: (
      nome: string,
      args: Record<string, unknown>,
    ) => { data: unknown; error: unknown } | undefined,
  ) {
    const { f, qc } = montarBanco({}, { rpc });
    const espia = vi.spyOn(qc, "invalidateQueries");
    const { ref } = ler(() => useCancelarRetorno(), f, qc);
    const raizes = () =>
      espia.mock.calls.map(
        (c) => (c[0] as { queryKey?: readonly string[] } | undefined)?.queryKey?.[0],
      );
    return { f, qc, ref, raizes, espia };
  }

  it("ok: chama cancelar_retorno com p_retorno e relê retornos", async () => {
    const { f, ref, raizes } = montarCancelar(() => ({ data: null, error: null }));
    let r: Resultado | undefined;
    await act(async () => {
      r = await ref.atual!("rt-1");
    });
    expect(r).toEqual({ ok: true });
    expect(f.rpcs).toEqual([{ nome: "cancelar_retorno", args: { p_retorno: "rt-1" } }]);
    expect(raizes()).toContain("retornos");
    expect(raizes()).not.toContain("eu");
  });

  it("já saiu (P0001 retorno_nao_pendente): devolve o erro próprio e relê mesmo assim", async () => {
    const { ref, raizes } = montarCancelar(() => ({
      data: null,
      error: p0001("retorno_nao_pendente"),
    }));
    let r: Resultado | undefined;
    await act(async () => {
      r = await ref.atual!("rt-1");
    });
    expect(r).toEqual({ ok: false, erro: "retorno_nao_pendente" });
    expect(raizes()).toContain("retornos");
  });

  it("uuid que o banco não conhece (22P02): nao_encontrado, e relê", async () => {
    const { ref, raizes } = montarCancelar(() => ({
      data: null,
      error: { code: "22P02", message: "invalid input syntax for type uuid" },
    }));
    let r: Resultado | undefined;
    await act(async () => {
      r = await ref.atual!("nao-e-uuid");
    });
    expect(r).toMatchObject({ ok: false, erro: "nao_encontrado" });
    expect(raizes()).toContain("retornos");
  });

  it("sem acesso: devolve sem_acesso, relê retornos e relê o Eu", async () => {
    const { ref, raizes } = montarCancelar(() => ({ data: null, error: p0001("sem_acesso") }));
    let r: Resultado | undefined;
    await act(async () => {
      r = await ref.atual!("rt-1");
    });
    expect(r).toEqual({ ok: false, erro: "sem_acesso" });
    expect(raizes()).toContain("retornos");
    expect(raizes()).toContain("eu");
  });

  it("falha de rede (a chamada lança ou volta com erro cru): falha, nunca lança, e relê", async () => {
    const { ref, raizes } = montarCancelar(() => ({
      data: null,
      error: new TypeError("Failed to fetch"),
    }));
    let r: Resultado | undefined;
    await act(async () => {
      r = await ref.atual!("rt-1");
    });
    expect(r).toMatchObject({ ok: false, erro: "falha" });
    expect(raizes()).toContain("retornos");
    expect(raizes()).not.toContain("eu");
  });

  it("a chamada que lança de verdade também vira falha (e relê)", async () => {
    const { f, qc } = montarBanco();
    const original = f.cliente.rpc.bind(f.cliente);
    (f.cliente as unknown as { rpc: unknown }).rpc = () => {
      throw new Error("rede caiu");
    };
    void original;
    const espia = vi.spyOn(qc, "invalidateQueries");
    const { ref } = ler(() => useCancelarRetorno(), f, qc);
    let r: Resultado | undefined;
    await act(async () => {
      r = await ref.atual!("rt-1");
    });
    expect(r).toMatchObject({ ok: false, erro: "falha" });
    expect(espia).toHaveBeenCalledWith({ queryKey: CHAVES.retornos });
  });

  it("a promessa só resolve depois da releitura (o 'Cancelando…' dura até lá)", async () => {
    const { f, qc } = montarBanco({ retornos: [linha()] });
    const { ref } = ler(
      () => ({ ler: useRetornos(CONVERSA), cancelar: useCancelarRetorno() }),
      f,
      qc,
    );
    await waitFor(() => expect(ref.atual?.ler.carregando).toBe(false));
    const antes = f.consultas.filter((c) => c.tabela === "retornos").length;
    await act(async () => {
      await ref.atual!.cancelar("rt-1");
    });
    // as duas consultas foram refeitas antes de a ação devolver
    expect(f.consultas.filter((c) => c.tabela === "retornos").length).toBe(antes + 2);
  });
});

describe("erros: retorno_nao_pendente", () => {
  it("está em CODIGOS_DO_BANCO", () => {
    expect(CODIGOS_DO_BANCO["retorno_nao_pendente"]).toBe("retorno_nao_pendente");
  });

  it("P0001 retorno_nao_pendente → retorno_nao_pendente (sem cair em falha)", () => {
    expect(traduzirErro(p0001("retorno_nao_pendente"))).toEqual({ erro: "retorno_nao_pendente" });
  });

  it("o resultado de função de servidor { erro: 'retorno_nao_pendente' } também é reconhecido", () => {
    expect(traduzirErro({ ok: false, erro: "retorno_nao_pendente" }).erro).toBe(
      "retorno_nao_pendente",
    );
  });
});

describe("A Nina está atrasada: o motor lê motor_pendencias_com_retornos", () => {
  it("chama a função nova (e só ela) e lê as 3 colunas de sempre", async () => {
    const f = criarClienteFalso({
      rpc: () => ({
        data: [
          {
            proximo_em: null,
            vencido_desde: "2026-11-18T12:00:00.000Z",
            atrasado_desde: "2026-11-18T11:58:00.000Z",
          },
        ],
        error: null,
      }),
    });
    const o = opcoesMotor(f.cliente);
    const r = await (o.queryFn as () => Promise<unknown>)();
    expect(f.rpcs).toEqual([{ nome: "motor_pendencias_com_retornos", args: undefined }]);
    expect(r).toEqual({
      proximoEm: null,
      vencidoDesde: Date.parse("2026-11-18T12:00:00.000Z"),
      atrasadoDesde: Date.parse("2026-11-18T11:58:00.000Z"),
    });
    expect(lerPendencias([{ proximo_em: null }])).toBeNull();
  });
});

describe("salvarRitmo com o lembrete (configuracao.ts)", () => {
  function servidor(resposta: Record<string, unknown>) {
    const salvarRitmo = vi.fn(async () => ({ ok: true, ...resposta }));
    return { salvarRitmo } as unknown as ServidorConfiguracao & {
      salvarRitmo: ReturnType<typeof vi.fn>;
    };
  }

  it("sem o 3º parâmetro, manda só { espera, teto } (como hoje)", async () => {
    const s = servidor({ espera: 9, teto: 60 });
    const acoes = criarAcoesConfiguracaoBanco(s, new QueryClient());
    const r = await acoes.salvarRitmo(9, 60);
    expect(s.salvarRitmo).toHaveBeenCalledWith({ espera: 9, teto: 60 });
    expect(r).toEqual({ ok: true, espera: 9, teto: 60 });
  });

  it("com o lembrete, manda { espera, teto, lembrete } e devolve o que o servidor gravou", async () => {
    const s = servidor({ espera: 9, teto: 60, lembrete: { ligado: false, horas: 6 } });
    const acoes = criarAcoesConfiguracaoBanco(s, new QueryClient());
    const pedido: AjusteLembrete = { ligado: false, horas: 5 };
    const r = await acoes.salvarRitmo(9, 60, pedido);
    expect(s.salvarRitmo).toHaveBeenCalledWith({
      espera: 9,
      teto: 60,
      lembrete: { ligado: false, horas: 5 },
    });
    expect(r).toEqual({ ok: true, espera: 9, teto: 60, lembrete: { ligado: false, horas: 6 } });
  });

  it("resposta sem o lembrete devolvido: recua para o pedido", async () => {
    const s = servidor({ espera: 9, teto: 60 });
    const acoes = criarAcoesConfiguracaoBanco(s, new QueryClient());
    const r = await acoes.salvarRitmo(9, 60, { ligado: true, horas: 4 });
    expect(r).toEqual({ ok: true, espera: 9, teto: 60, lembrete: { ligado: true, horas: 4 } });
  });

  it("no sucesso, o cache do ajuste já tem o valor novo antes de a ação devolver (o interruptor não pisca)", async () => {
    const qc = new QueryClient();
    qc.setQueryData([...CHAVES.configuracao, "lembrete"], { ligado: true, horas: 3 });
    const s = servidor({ espera: 9, teto: 60, lembrete: { ligado: false, horas: 3 } });
    const acoes = criarAcoesConfiguracaoBanco(s, qc);
    await acoes.salvarRitmo(9, 60, { ligado: false, horas: 3 });
    expect(qc.getQueryData([...CHAVES.configuracao, "lembrete"])).toEqual({
      ligado: false,
      horas: 3,
    });
  });

  it("só o ritmo salvo não mexe no cache do ajuste", async () => {
    const qc = new QueryClient();
    qc.setQueryData([...CHAVES.configuracao, "lembrete"], { ligado: false, horas: 8 });
    const acoes = criarAcoesConfiguracaoBanco(servidor({ espera: 9, teto: 60 }), qc);
    await acoes.salvarRitmo(9, 60);
    expect(qc.getQueryData([...CHAVES.configuracao, "lembrete"])).toEqual({
      ligado: false,
      horas: 8,
    });
  });

  it("a recusa do servidor (horas fora de 1 a 23) volta com a mensagem do contrato e não toca o cache", async () => {
    const qc = new QueryClient();
    qc.setQueryData([...CHAVES.configuracao, "lembrete"], { ligado: true, horas: 3 });
    const s = {
      salvarRitmo: vi.fn(async () => ({
        ok: false,
        erro: "fora_do_limite",
        campo: "lembrete_horas",
        mensagem: "As horas do lembrete vão de 1 a 23.",
      })),
    } as unknown as ServidorConfiguracao;
    const acoes = criarAcoesConfiguracaoBanco(s, qc);
    const r = await acoes.salvarRitmo(9, 60, { ligado: true, horas: 24 });
    expect(r).toMatchObject({
      ok: false,
      erro: "fora_do_limite",
      campo: "lembrete_horas",
      mensagem: "As horas do lembrete vão de 1 a 23.",
    });
    expect(qc.getQueryData([...CHAVES.configuracao, "lembrete"])).toEqual({
      ligado: true,
      horas: 3,
    });
  });

  it("sem acesso (atendente): sem_acesso, e relê o Eu", async () => {
    const qc = new QueryClient();
    const espia = vi.spyOn(qc, "invalidateQueries");
    const s = {
      salvarRitmo: vi.fn(async () => ({ ok: false, erro: "sem_acesso" })),
    } as unknown as ServidorConfiguracao;
    const r = await criarAcoesConfiguracaoBanco(s, qc).salvarRitmo(9, 60, {
      ligado: true,
      horas: 3,
    });
    expect(r).toMatchObject({ ok: false, erro: "sem_acesso" });
    expect(espia).toHaveBeenCalledWith({ queryKey: CHAVES.eu });
  });
});

describe("modo exemplo: as mesmas leituras, prontas, sem nenhum retorno semeado", () => {
  const AGORA_EX = new Date("2026-10-30T17:45:00.000Z");
  type ComRetornos = EstadoBase & { retornos?: RetornoDados[]; lembrete?: AjusteLembrete };

  let leituras: {
    retornos: Leitura<RetornoDados[]>;
    ajuste: Leitura<AjusteLembrete>;
    cancelar: (id: string) => Promise<Resultado>;
  };
  let exemplo: ReturnType<typeof useExemplo>;
  function Leitor({ conversa }: { conversa: string | null }) {
    leituras = {
      retornos: useRetornos(conversa),
      ajuste: useAjusteLembrete(),
      cancelar: useCancelarRetorno(),
    };
    exemplo = useExemplo();
    return null;
  }
  function montar(
    extra: { retornos?: RetornoDados[]; lembrete?: AjusteLembrete } = {},
    conversa: string | null = CONVERSA,
  ) {
    render(
      <ProvedorPapel inicial="admin">
        <ProvedorDados
          exemplo={() => Object.assign(criarEstadoInicial(AGORA_EX), extra) as ComRetornos}
          relogio={() => AGORA_EX}
          progredirEnvios={false}
        >
          <Leitor conversa={conversa} />
        </ProvedorDados>
      </ProvedorPapel>,
    );
  }

  it("sem nada no estado: nenhum retorno e o ajuste padrão (ligado, 3 h)", () => {
    montar();
    expect(leituras.retornos).toMatchObject({ dados: [], carregando: false, erro: null });
    expect(leituras.ajuste).toMatchObject({
      dados: { ligado: true, horas: 3 },
      carregando: false,
      erro: null,
    });
  });

  it("lê do estado só os da conversa (retorno: todos os status; lembrete: pendente e enviado), em ordem", () => {
    montar({
      retornos: [
        linha({ id: "rt-3", criado_em: "2026-11-18T22:00:00.000Z" }),
        linha({
          id: "rt-1",
          tipo: "lembrete",
          status: "pendente",
          criado_em: "2026-11-18T10:00:00.000Z",
        }),
        linha({
          id: "rt-2",
          tipo: "lembrete",
          status: "cancelado",
          criado_em: "2026-11-18T11:00:00.000Z",
        }),
        linha({ id: "rt-4", conversa_id: "cv-9", criado_em: "2026-11-18T12:00:00.000Z" }),
      ],
      lembrete: { ligado: false, horas: 7 },
    });
    expect(leituras.retornos.dados?.map((r) => r.id)).toEqual(["rt-1", "rt-3"]);
    expect(leituras.ajuste.dados).toEqual({ ligado: false, horas: 7 });
  });

  it("sem conversa: lista vazia", () => {
    montar({ retornos: [linha()] }, null);
    expect(leituras.retornos.dados).toEqual([]);
  });

  it("cancelar usa a ação do exemplo (quando ela existe) e traduz o 'já saiu'", async (ctx) => {
    montar({ retornos: [linha()] });
    if (typeof (exemplo.acoes as { cancelarRetorno?: unknown }).cancelarRetorno !== "function") {
      // a ação do exemplo é da T10; sem ela, este caso espera
      ctx.skip();
      return;
    }
    let r1: Resultado | undefined;
    await act(async () => {
      r1 = await leituras.cancelar("rt-1");
    });
    expect(r1).toEqual({ ok: true });
    let r2: Resultado | undefined;
    await act(async () => {
      r2 = await leituras.cancelar("rt-1");
    });
    expect(r2).toEqual({ ok: false, erro: "retorno_nao_pendente" });
  });
});
