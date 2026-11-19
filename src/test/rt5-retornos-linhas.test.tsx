import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AbaConversa } from "@/features/plataforma/contatos/AbaConversa";
import { ProvedorDados } from "@/features/plataforma/dados/ProvedorDados";
import type { Leitura, RetornoDados } from "@/features/plataforma/dados/tipos";
import {
  criarEstadoInicial,
  idContato,
  idConversa,
  membroDoPapel,
  type EstadoBase,
  type Mensagem,
} from "@/features/plataforma/exemplo";
import { GavetaLead } from "@/features/plataforma/kanban/GavetaLead";
import { ProvedorPapel } from "@/features/plataforma/papel";

import { AGORA_TESTE, emBrasilia, lembreteDeTeste, retornoDeTeste } from "./retornos-fabrica";

// As linhas dos retornos na aba Conversa do perfil e na gaveta do Kanban (// Parte 1, E: "as linhas aparecem em todo lugar que mostra o histórico da
// conversa; só as linhas, a faixa e o Cancelar ficam no Chat e no cartão do perfil"). As duas telas
// rodam no modo exemplo, com os retornos postos no estado e o relógio fixo na quarta 18/11/2026 16:10.

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));

/** Leitura que o teste impõe no lugar da de verdade (com erro, carregando); nula, vale a do exemplo. */
const fake = vi.hoisted(() => ({ retornos: null as unknown }));
vi.mock("@/features/plataforma/dados/retornos", async (original) => {
  const real = await original<typeof import("@/features/plataforma/dados/retornos")>();
  return {
    ...real,
    useRetornos: (id: string) => {
      const doExemplo = real.useRetornos(id);
      return (fake.retornos as Leitura<RetornoDados[]> | null) ?? doExemplo;
    },
  };
});

beforeEach(() => {
  vi.useFakeTimers({ now: AGORA_TESTE, shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  fake.retornos = null;
});

const JULIANA = idContato("juliana");
const CV = idConversa("juliana");

const estadoBase = () => criarEstadoInicial(new Date(AGORA_TESTE));

/** As mensagens de texto da Nina na conversa da Juliana, da mais antiga para a mais nova. */
const bolhasDaNina = (e: EstadoBase): Mensagem[] =>
  e.mensagens
    .filter((m) => m.conversa_id === CV && m.origem === "nina" && m.tipo === "texto" && m.texto)
    .sort((a, b) => Date.parse(a.momento) - Date.parse(b.momento));

/** O estado com os retornos postos e, se pedido, a rodada gravada nas bolhas da Nina. */
function comRetornos(rs: RetornoDados[], rodadas: Record<string, string> = {}) {
  return (e: EstadoBase): EstadoBase =>
    ({
      ...e,
      retornos: rs.map((r) => ({ ...r, conversa_id: CV })),
      mensagens: e.mensagens.map((m) => (rodadas[m.id] ? { ...m, rodada_id: rodadas[m.id] } : m)),
    }) as EstadoBase;
}

type Tela = "aba" | "gaveta";

function montar(tela: Tela, ajustar: (e: EstadoBase) => EstadoBase) {
  const props = {
    contatoId: JULIANA,
    agora: AGORA_TESTE,
    irParaAba: vi.fn(),
    verNaConversa: vi.fn(),
    avisar: vi.fn(),
  };
  return render(
    <ProvedorPapel inicial="admin">
      <ProvedorDados
        exemplo={() => ajustar(estadoBase())}
        progredirEnvios={false}
        relogio={() => new Date(AGORA_TESTE)}
      >
        {tela === "aba" ? (
          <AbaConversa {...props} mensagemAlvo={null} focarCaixa={false} />
        ) : (
          <GavetaLead contatoId={JULIANA} aoFechar={vi.fn()} />
        )}
      </ProvedorDados>
    </ProvedorPapel>,
  );
}

const log = () => screen.getByRole("log");
const linha = (texto: string | RegExp) =>
  within(log())
    .queryAllByRole("note")
    .find((n) =>
      typeof texto === "string"
        ? (n.textContent ?? "").includes(texto)
        : texto.test(n.textContent ?? ""),
    );
/** Na ordem da tela, as bolhas (de qualquer origem) e as linhas. */
const sequencia = () =>
  Array.from(
    log().querySelectorAll<HTMLElement>("p[data-origem], div[data-origem], [role='note']"),
  );
const posicao = (el: Element) => sequencia().indexOf(el as HTMLElement);
/** A bolha com este texto (a primeira de texto simples que o contém). */
const bolha = (texto: string) =>
  within(log())
    .getByText(texto, { selector: "p[data-origem], p[data-origem] *" })
    .closest("[data-origem]")!;

describe.each<[string, Tela]>([
  ["a aba Conversa do perfil", "aba"],
  ["a gaveta do Kanban", "gaveta"],
])("%s", (_nome, tela) => {
  it("sem retorno, nenhuma linha de retorno e a conversa como hoje", () => {
    montar(tela, comRetornos([]));
    expect(linha(/retorno|Lembrete automático/)).toBeUndefined();
    expect(bolhasDaNina(estadoBase()).length).toBeGreaterThan(0);
  });

  it("o retorno marcado vira a linha 'A Nina marcou um retorno para qui, 19/11, às 09:00', com a hora em que ela marcou", () => {
    montar(tela, comRetornos([retornoDeTeste()]));
    const l = linha("A Nina marcou um retorno")!;
    expect(l).toBeDefined();
    expect(l.textContent).toContain("A Nina marcou um retorno para qui, 19/11, às 09:00");
    expect(l.textContent).toContain("16:09");
    expect(within(l).getByText("qui, 19/11, às 09:00").tagName).toBe("B");
  });

  it("não tem faixa nem 'Cancelar' (a faixa e o cancelar são do Chat e do cartão do perfil)", () => {
    montar(tela, comRetornos([retornoDeTeste()]));
    expect(document.querySelector("[data-faixa-retorno]")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Cancelar/ })).toBeNull();
    expect(screen.queryByText(/Retorno marcado para/)).toBeNull();
  });

  it("a remarcação conta como 'remarcou' e o retorno substituído não ganha linha própria", () => {
    const velho = retornoDeTeste({
      status: "cancelado",
      resolvido_em: emBrasilia("2026-11-18", "16:09"),
      fechado_por_rodada: "rod-origem",
    });
    const novo = retornoDeTeste({
      substitui_id: velho.id,
      vence_em: emBrasilia("2026-11-19", "14:00"),
      expira_em: emBrasilia("2026-11-19", "17:00"),
    });
    montar(tela, comRetornos([velho, novo]));
    expect(linha("A Nina remarcou o retorno para qui, 19/11, às 14:00")).toBeDefined();
    expect(linha("cancelou o retorno")).toBeUndefined();
  });

  it("quem da equipe cancelou aparece pelo nome, e 'Você' para quem está olhando", () => {
    const eu = membroDoPapel(estadoBase().membros, "admin").id;
    montar(
      tela,
      comRetornos([
        retornoDeTeste({
          status: "cancelado",
          cancelado_por: eu,
          resolvido_em: emBrasilia("2026-11-18", "16:09"),
        }),
      ]),
    );
    expect(linha("Você cancelou o retorno de qui, 19/11, às 09:00")).toBeDefined();
  });

  it("as linhas do fim: enviado, dispensado e não enviado (em vermelho, com o motivo)", () => {
    montar(
      tela,
      comRetornos([
        retornoDeTeste({ status: "enviado", enviado_em: emBrasilia("2026-11-18", "16:09") }),
        retornoDeTeste({
          status: "dispensado",
          resolvido_em: emBrasilia("2026-11-18", "16:09"),
          nota_fim: "O assunto já estava resolvido.",
        }),
        retornoDeTeste({
          status: "nao_enviado",
          nao_enviado_motivo: "com_equipe",
          resolvido_em: emBrasilia("2026-11-18", "16:09"),
        }),
      ]),
    );
    expect(linha("Retorno combinado: a Nina voltou a falar com o lead")).toBeDefined();
    expect(
      linha("dispensou o retorno de qui, 19/11, às 09:00: O assunto já estava resolvido"),
    ).toBeDefined();
    const falha = linha("não enviado: a conversa estava com a equipe")!;
    expect(falha).toBeDefined();
    expect(falha).toHaveAttribute("data-tom", "falha");
  });

  it("o lembrete que saiu vira 'Lembrete automático: o lead não respondia havia 3 h'; o pendente não faz linha", () => {
    montar(
      tela,
      comRetornos([
        lembreteDeTeste({ status: "enviado", enviado_em: emBrasilia("2026-11-18", "12:00") }),
        lembreteDeTeste({ status: "pendente" }),
      ]),
    );
    expect(
      within(log()).getAllByText(/Lembrete automático: o lead não respondia havia 3 h/),
    ).toHaveLength(1);
  });

  it("'A Nina marcou' fica logo depois da bolha da Nina da rodada, mesmo com a hora do fato antes dela", () => {
    const nina = bolhasDaNina(estadoBase());
    const ultima = nina[nina.length - 1]!;
    const marcado = new Date(Date.parse(ultima.momento) - 10_000).toISOString();
    montar(
      tela,
      comRetornos(
        [retornoDeTeste({ marcado_em: marcado, criado_em: marcado, rodada_origem_id: "rod-1" })],
        {
          [ultima.id]: "rod-1",
        },
      ),
    );
    const b = bolha(ultima.texto!);
    const l = linha("A Nina marcou um retorno")!;
    expect(posicao(l)).toBe(posicao(b) + 1);
  });

  it("'Retorno combinado' fica logo antes da 1ª bolha da Nina da rodada", () => {
    const nina = bolhasDaNina(estadoBase());
    const alvo = nina[nina.length - 1]!;
    const fato = new Date(Date.parse(alvo.momento) + 2_000).toISOString();
    montar(
      tela,
      comRetornos(
        [
          retornoDeTeste({
            status: "enviado",
            enviado_em: fato,
            resolvido_em: fato,
            rodada_id: "rod-2",
          }),
        ],
        { [alvo.id]: "rod-2" },
      ),
    );
    const b = bolha(alvo.texto!);
    const l = linha("Retorno combinado")!;
    expect(posicao(l)).toBe(posicao(b) - 1);
  });

  it("erro ao ler os retornos não tira a conversa do ar: só as linhas faltam", () => {
    fake.retornos = {
      dados: undefined,
      carregando: false,
      erro: "falha",
      tentarDeNovo: vi.fn(),
    } satisfies Leitura<RetornoDados[]>;
    montar(tela, comRetornos([retornoDeTeste()]));
    const nina = bolhasDaNina(estadoBase());
    expect(within(log()).getByText(nina[0]!.texto!)).toBeInTheDocument();
    expect(linha("A Nina marcou um retorno")).toBeUndefined();
  });
});

describe("a gaveta enquanto lê os retornos", () => {
  it("a lista espera os retornos chegarem (a linha não entra depois da primeira pintura)", async () => {
    fake.retornos = {
      dados: undefined,
      carregando: true,
      erro: null,
      tentarDeNovo: () => {},
    } satisfies Leitura<RetornoDados[]>;
    montar("gaveta", comRetornos([retornoDeTeste()]));
    expect(
      within(log()).getByRole("status", { name: "Carregando as mensagens" }),
    ).toBeInTheDocument();
    await act(async () => {});
  });
});

describe("a aba Conversa enquanto lê os retornos", () => {
  it("a lista espera os retornos chegarem: nenhuma mensagem nem linha entra depois da primeira pintura", async () => {
    fake.retornos = {
      dados: undefined,
      carregando: true,
      erro: null,
      tentarDeNovo: () => {},
    } satisfies Leitura<RetornoDados[]>;
    montar("aba", comRetornos([retornoDeTeste()]));
    expect(
      within(log()).getByRole("status", { name: "Carregando as mensagens" }),
    ).toBeInTheDocument();
    expect(linha("A Nina marcou um retorno")).toBeUndefined();
    const nina = bolhasDaNina(estadoBase());
    expect(within(log()).queryByText(nina[0]!.texto!)).toBeNull();
    await act(async () => {});
  });

  it("depois que os retornos chegam, a lista aparece com as linhas", () => {
    fake.retornos = {
      dados: [{ ...retornoDeTeste(), conversa_id: CV }],
      carregando: false,
      erro: null,
      tentarDeNovo: vi.fn(),
    } satisfies Leitura<RetornoDados[]>;
    montar("aba", comRetornos([retornoDeTeste()]));
    expect(within(log()).queryByRole("status", { name: "Carregando as mensagens" })).toBeNull();
    expect(linha("A Nina marcou um retorno")).toBeDefined();
  });
});
