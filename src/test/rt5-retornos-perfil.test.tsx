import { readFileSync } from "node:fs";
import path from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PerfilContato } from "@/features/plataforma/contatos/Perfil";
import { ProvedorDados } from "@/features/plataforma/dados/ProvedorDados";
import { pronta } from "@/features/plataforma/dados/leitura";
import type { AjusteLembrete, Leitura, RetornoDados } from "@/features/plataforma/dados/tipos";
import {
  IDS,
  criarEstadoInicial,
  idContato,
  idConversa,
  type EstadoBase,
} from "@/features/plataforma/exemplo";
import { ProvedorPapel, type Papel } from "@/features/plataforma/papel";

import { AGORA_TESTE, emBrasilia, lembreteDeTeste, retornoDeTeste } from "./retornos-fabrica";

// Retornos da Nina no perfil do contato (mockup, quadros 17 a 19): o cartão
// "Retorno marcado" ou "Lembrete automático" na coluna da direita, entre "Quem atende" e "Próximo passo",
// com o "Cancelar" para qualquer membro. O perfil roda no modo exemplo, com os retornos postos no estado,
// o relógio fixo na quarta 18/11/2026 16:10 e o cancelar trocado por um dublê (a ação de verdade é
// testada em rt4). As abas entram como dublês (só o cartão interessa aqui).

vi.mock("@/features/plataforma/contatos/AbaResumo", () => ({
  AbaResumo: () => <div data-testid="aba-resumo" />,
}));
vi.mock("@/features/plataforma/contatos/AbaConversa", () => ({
  AbaConversa: () => <div data-testid="aba-conversa" />,
}));
vi.mock("@/features/plataforma/contatos/AbaLinha", () => ({
  AbaLinha: () => <div data-testid="aba-linha" />,
}));
vi.mock("@/features/plataforma/contatos/AbaMidias", () => ({
  AbaMidias: () => <div data-testid="aba-midias" />,
}));
vi.mock("@/features/plataforma/contatos/AbaFicha", () => ({
  AbaFicha: () => <div data-testid="aba-ficha" />,
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));

const cancelar = vi.hoisted(() => vi.fn<(id: string) => Promise<unknown>>());
/** O que o teste impõe no lugar da leitura de verdade; nulo, vale a do exemplo. */
const fake = vi.hoisted(() => ({
  retornos: null as unknown,
  ajuste: null as unknown,
  pediuAjuste: [] as boolean[],
}));

vi.mock("@/features/plataforma/dados/retornos", async (original) => {
  const real = await original<typeof import("@/features/plataforma/dados/retornos")>();
  return {
    ...real,
    useCancelarRetorno: () => cancelar,
    useRetornos: (id: string) => {
      const doExemplo = real.useRetornos(id);
      return (fake.retornos as Leitura<RetornoDados[]> | null) ?? doExemplo;
    },
    useAjusteLembrete: (habilitado = true) => {
      fake.pediuAjuste.push(habilitado);
      const doExemplo = real.useAjusteLembrete(habilitado);
      return (fake.ajuste as Leitura<AjusteLembrete> | null) ?? doExemplo;
    },
  };
});

const JULIANA = idContato("juliana");
const CV_JULIANA = idConversa("juliana");
const PASSO = { titulo: "Marcar a demonstração", texto: "Ela pediu uma demonstração da agenda." };
const PERTO_DO_LEAD = emBrasilia("2026-11-18", "08:50");

const avisar = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AGORA_TESTE);
  cancelar.mockResolvedValue({ ok: true });
  fake.pediuAjuste = [];
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  fake.retornos = null;
  fake.ajuste = null;
  cancelar.mockReset();
  avisar.mockReset();
});

type Ajuste = (e: EstadoBase) => EstadoBase;

/**
 * O estado em que o lembrete pode aparecer: a Nina com a conversa, o lead calado desde as 08:50, a
 * etapa aberta, o WhatsApp conectado. `ajustar` muda o que o caso precisa.
 */
const base =
  (...rs: RetornoDados[]): Ajuste =>
  (e) =>
    ({
      ...e,
      retornos: rs.map((r) => ({ ...r, conversa_id: CV_JULIANA })),
      conversas: e.conversas.map((c) =>
        c.id === CV_JULIANA
          ? { ...c, modo: "nina", responsavel_id: null, ultima_do_lead_em: PERTO_DO_LEAD }
          : c,
      ),
      contatos: e.contatos.map((c) => (c.id === JULIANA ? { ...c, proximoPasso: PASSO } : c)),
    }) as EstadoBase;

function montar(
  retornos: RetornoDados[],
  opcoes: { papel?: Papel; ajustar?: Ajuste; agora?: number } = {},
) {
  const inicial = () => {
    const e = base(...retornos)(criarEstadoInicial(new Date(AGORA_TESTE)));
    return opcoes.ajustar ? opcoes.ajustar(e) : e;
  };
  return render(
    <ProvedorPapel inicial={opcoes.papel ?? "admin"}>
      <ProvedorDados
        exemplo={inicial}
        progredirEnvios={false}
        relogio={() => new Date(AGORA_TESTE)}
      >
        <PerfilContato
          contatoId={JULIANA}
          agora={opcoes.agora ?? AGORA_TESTE}
          aoVoltar={vi.fn()}
          aoApagado={vi.fn()}
          avisar={avisar}
        />
      </ProvedorDados>
    </ProvedorPapel>,
  );
}

const cartaoRetorno = () => screen.queryByRole("region", { name: "Retorno marcado" });
const cartaoLembrete = () => screen.queryByRole("region", { name: "Lembrete automático" });
const lado = () => screen.getByRole("complementary");
/** Deixa as promessas do cancelar (e o estado depois delas) correrem. */
const esperar = () => act(async () => {});

describe("quadro 17: o perfil com o retorno marcado", () => {
  it("mostra quem marcou, o dia, o motivo inteiro e o botão, entre 'Quem atende' e 'Próximo passo'", () => {
    montar([retornoDeTeste()]);
    const c = cartaoRetorno()!;
    expect(c).toBeInTheDocument();
    expect(within(c).getByText("Retorno marcado")).toBeInTheDocument();
    expect(within(c).getByText("pela Nina, hoje às 16:09")).toBeInTheDocument();
    expect(within(c).getByText("Amanhã, 09:00")).toBeInTheDocument();
    expect(
      within(c).getByText("Retomar a proposta do plano anual, depois da conversa dela com o sócio"),
    ).toBeInTheDocument();
    expect(within(c).getByRole("button", { name: "Cancelar retorno" })).toBeInTheDocument();

    const quem = screen.getByRole("region", { name: "Quem atende" });
    const passo = screen.getByText("Próximo passo").closest("section")!;
    expect(quem.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(c.compareDocumentPosition(passo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(lado()).toContainElement(c);
  });

  it("o horário não é título (não entra na navegação por títulos)", () => {
    montar([retornoDeTeste()]);
    expect(screen.queryByRole("heading", { name: "Amanhã, 09:00" })).toBeNull();
  });

  it("o motivo não é cortado, por maior que seja", () => {
    const longo = "Retomar a proposta do plano anual. ".repeat(8).trim();
    montar([retornoDeTeste({ motivo: longo })]);
    expect(within(cartaoRetorno()!).getByText(longo)).toBeInTheDocument();
  });

  it("'amanhã' vira 'hoje' à meia-noite de Brasília, pelo relógio da tela", () => {
    montar([retornoDeTeste()], { agora: Date.parse("2026-11-19T00:10:00-03:00") });
    expect(within(cartaoRetorno()!).getByText("Hoje, 09:00")).toBeInTheDocument();
  });

  it("fora da Nina, o cartão diz que ela só envia se a conversa voltar antes da hora", () => {
    montar([retornoDeTeste()], {
      ajustar: (e) => ({
        ...e,
        conversas: e.conversas.map((c) =>
          c.id === CV_JULIANA ? { ...c, modo: "humano" as const, responsavel_id: null } : c,
        ),
      }),
    });
    expect(
      within(cartaoRetorno()!).getByText(
        "A Nina só envia se a conversa voltar para ela antes da hora.",
      ),
    ).toBeInTheDocument();
  });

  it("o retorno que já saiu, foi cancelado ou venceu não faz cartão", () => {
    for (const r of [
      retornoDeTeste({ status: "em_rodada" }),
      retornoDeTeste({ status: "enviado" }),
      retornoDeTeste({ status: "cancelado" }),
      retornoDeTeste({ status: "pendente", expira_em: emBrasilia("2026-11-18", "16:00") }),
    ]) {
      const { unmount } = montar([r]);
      expect(cartaoRetorno()).toBeNull();
      expect(cartaoLembrete()).toBeNull();
      unmount();
    }
  });
});

describe("quadro 18: o perfil com o lembrete automático", () => {
  it("mostra o lembrete, a hora e desde quando a Nina espera", () => {
    montar([lembreteDeTeste()]);
    expect(cartaoRetorno()).toBeNull();
    const c = cartaoLembrete()!;
    expect(within(c).getByText("Lembrete automático")).toBeInTheDocument();
    expect(within(c).getByText("se o lead não responder")).toBeInTheDocument();
    expect(within(c).getByText("Hoje, 12:00")).toBeInTheDocument();
    expect(
      within(c).getByText("A Nina espera a resposta do lead desde as 09:00."),
    ).toBeInTheDocument();
    expect(within(c).getByRole("button", { name: "Cancelar lembrete" })).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Quem atende" }).compareDocumentPosition(c) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("com retorno marcado, só o retorno (o retorno ganha)", () => {
    montar([lembreteDeTeste(), retornoDeTeste()]);
    expect(cartaoRetorno()).toBeInTheDocument();
    expect(cartaoLembrete()).toBeNull();
  });

  it.each([
    [
      "o ajuste está desligado",
      { ajuste: pronta<AjusteLembrete>({ ligado: false, horas: 3 }) },
      undefined,
    ],
    [
      "a conversa está com a equipe",
      {},
      (e: EstadoBase) => ({
        ...e,
        conversas: e.conversas.map((c) =>
          c.id === CV_JULIANA ? { ...c, modo: "humano" as const, responsavel_id: null } : c,
        ),
      }),
    ],
    [
      "o lead está em Ganho",
      {},
      (e: EstadoBase) => ({
        ...e,
        contatos: e.contatos.map((c) =>
          c.id === JULIANA ? { ...c, etapa_id: IDS.etapa.ganho } : c,
        ),
      }),
    ],
    [
      "o lead está em Perdido",
      {},
      (e: EstadoBase) => ({
        ...e,
        contatos: e.contatos.map((c) =>
          c.id === JULIANA ? { ...c, etapa_id: IDS.etapa.perdido } : c,
        ),
      }),
    ],
    [
      "o WhatsApp está desconectado",
      {},
      (e: EstadoBase) => ({
        ...e,
        conexao: e.conexao ? { ...e.conexao, status: "desconectada" as const } : e.conexao,
      }),
    ],
    [
      "o lead escreveu depois de a Nina armar o lembrete",
      {},
      (e: EstadoBase) => ({
        ...e,
        conversas: e.conversas.map((c) =>
          c.id === CV_JULIANA ? { ...c, ultima_do_lead_em: emBrasilia("2026-11-18", "10:00") } : c,
        ),
      }),
    ],
    [
      "a conversa foi devolvida à Nina depois de a Nina armar o lembrete (A5)",
      {},
      (e: EstadoBase) => ({
        ...e,
        conversas: e.conversas.map((c) =>
          c.id === CV_JULIANA ? { ...c, devolvida_em: emBrasilia("2026-11-18", "10:00") } : c,
        ),
      }),
    ],
  ] as const)("o lembrete não aparece quando %s", (_quando, extra, ajustar) => {
    fake.ajuste = "ajuste" in extra ? extra.ajuste : null;
    montar([lembreteDeTeste()], ajustar ? { ajustar } : {});
    expect(cartaoLembrete()).toBeNull();
  });

  it("devolvida à Nina antes de a Nina armar o lembrete, o cartão aparece", () => {
    montar([lembreteDeTeste()], {
      ajustar: (e: EstadoBase) => ({
        ...e,
        conversas: e.conversas.map((c) =>
          c.id === CV_JULIANA ? { ...c, devolvida_em: emBrasilia("2026-11-18", "08:00") } : c,
        ),
      }),
    });
    expect(cartaoLembrete()).toBeInTheDocument();
  });

  it("o lembrete que passou do prazo (expira_em) some", () => {
    montar([lembreteDeTeste({ expira_em: emBrasilia("2026-11-18", "16:00") })]);
    expect(cartaoLembrete()).toBeNull();
  });

  it("só pede o ajuste do lembrete quando há lembrete pendente", () => {
    montar([]);
    expect(fake.pediuAjuste.every((h) => h === false)).toBe(true);
    cleanup();
    fake.pediuAjuste = [];
    montar([lembreteDeTeste()]);
    expect(fake.pediuAjuste).toContain(true);
  });
});

describe("quadro 19: o perfil sem retorno", () => {
  it("sem retorno e sem lembrete, o cartão não existe e a coluna fica como hoje", () => {
    montar([]);
    expect(cartaoRetorno()).toBeNull();
    expect(cartaoLembrete()).toBeNull();
    const l = lado();
    expect(within(l).getByRole("region", { name: "Quem atende" })).toBeInTheDocument();
    expect(within(l).getByText("Próximo passo")).toBeInTheDocument();
    expect(l.querySelectorAll("section")).toHaveLength(2);
  });

  it("lembrete enviado, dispensado ou de outra conversa não faz cartão", () => {
    montar([lembreteDeTeste({ status: "enviado" }), retornoDeTeste({ status: "dispensado" })]);
    expect(cartaoRetorno()).toBeNull();
    expect(cartaoLembrete()).toBeNull();
  });
});

describe("cancelar pelo cartão", () => {
  it("chama a ação uma vez com o id, mesmo com cliques repetidos, e fica 'Cancelando…' até responder", async () => {
    let resolver!: (r: unknown) => void;
    cancelar.mockReturnValue(new Promise((r) => (resolver = r)));
    const r = retornoDeTeste();
    montar([r]);
    const botao = within(cartaoRetorno()!).getByRole("button", { name: "Cancelar retorno" });
    fireEvent.click(botao);
    fireEvent.click(botao);
    fireEvent.click(botao);
    expect(cancelar).toHaveBeenCalledTimes(1);
    expect(cancelar).toHaveBeenCalledWith(r.id);
    const cancelando = within(cartaoRetorno()!).getByRole("button", { name: "Cancelando…" });
    expect(cancelando).toHaveAttribute("aria-disabled", "true");
    expect(cartaoRetorno()).toHaveAttribute("aria-busy", "true");
    expect(cancelando).not.toBeDisabled();
    await act(async () => resolver({ ok: true }));
  });

  it("deu certo: o cartão some na hora, o aviso diz que cancelou e o foco vai para a coluna sem rolar", async () => {
    const foco = vi.spyOn(HTMLElement.prototype, "focus");
    montar([retornoDeTeste()]);
    fireEvent.click(within(cartaoRetorno()!).getByRole("button", { name: "Cancelar retorno" }));
    await esperar();
    expect(cartaoRetorno()).toBeNull();
    expect(avisar).toHaveBeenCalledWith("Retorno cancelado. A Nina não vai chamar o lead.", "ok");
    expect(document.activeElement).toBe(lado());
    expect(foco).toHaveBeenCalledWith({ preventScroll: true });
    foco.mockRestore();
  });

  it("o lembrete cancela pelo mesmo caminho, com o aviso do lembrete", async () => {
    const l = lembreteDeTeste();
    montar([l]);
    fireEvent.click(within(cartaoLembrete()!).getByRole("button", { name: "Cancelar lembrete" }));
    await esperar();
    expect(cancelar).toHaveBeenCalledWith(l.id);
    expect(cartaoLembrete()).toBeNull();
    expect(avisar).toHaveBeenCalledWith(
      "Lembrete cancelado. A Nina não vai mandar o lembrete.",
      "ok",
    );
  });

  it("'já saiu' (retorno_nao_pendente): o cartão some e o aviso é de erro", async () => {
    cancelar.mockResolvedValue({ ok: false, erro: "retorno_nao_pendente" });
    montar([retornoDeTeste()]);
    fireEvent.click(within(cartaoRetorno()!).getByRole("button", { name: "Cancelar retorno" }));
    await esperar();
    expect(cartaoRetorno()).toBeNull();
    expect(avisar).toHaveBeenCalledWith("Esse retorno já saiu ou já foi cancelado.", "erro");
  });

  it("falha: o cartão fica, o botão volta, o aviso é de erro e o foco fica no botão", async () => {
    cancelar.mockResolvedValue({ ok: false, erro: "falha" });
    montar([retornoDeTeste()]);
    const botao = within(cartaoRetorno()!).getByRole("button", { name: "Cancelar retorno" });
    botao.focus();
    fireEvent.click(botao);
    await esperar();
    expect(avisar).toHaveBeenCalledWith("Não deu para cancelar agora. Tente de novo.", "erro");
    const de_novo = within(cartaoRetorno()!).getByRole("button", { name: "Cancelar retorno" });
    expect(de_novo).not.toHaveAttribute("aria-disabled");
    expect(document.activeElement).toBe(de_novo);
    // dá para tentar outra vez
    fireEvent.click(de_novo);
    expect(cancelar).toHaveBeenCalledTimes(2);
    await esperar();
  });

  it("sem acesso: o cartão fica e o aviso é o do convite", async () => {
    cancelar.mockResolvedValue({ ok: false, erro: "sem_acesso" });
    montar([retornoDeTeste()]);
    fireEvent.click(within(cartaoRetorno()!).getByRole("button", { name: "Cancelar retorno" }));
    await esperar();
    expect(cartaoRetorno()).toBeInTheDocument();
    expect(avisar).toHaveBeenCalledWith(
      "Sua conta não tem mais acesso a isto. Peça ao admin para conferir o seu convite.",
      "erro",
    );
  });

  it("o atendente também cancela (a permissão é do banco, não do cartão)", async () => {
    const r = retornoDeTeste();
    montar([r], { papel: "atendente" });
    fireEvent.click(within(cartaoRetorno()!).getByRole("button", { name: "Cancelar retorno" }));
    await esperar();
    expect(cancelar).toHaveBeenCalledWith(r.id);
    expect(cartaoRetorno()).toBeNull();
  });
});

describe("a leitura dos retornos nunca derruba o perfil", () => {
  const erro = (dados?: RetornoDados[]): Leitura<RetornoDados[]> => ({
    dados,
    carregando: false,
    erro: "falha",
    tentarDeNovo: vi.fn(),
  });

  it("carregando: nenhum cartão e nenhum espaço reservado", () => {
    fake.retornos = {
      dados: undefined,
      carregando: true,
      erro: null,
      tentarDeNovo: () => {},
    } satisfies Leitura<RetornoDados[]>;
    montar([]);
    expect(cartaoRetorno()).toBeNull();
    expect(lado().querySelectorAll("section")).toHaveLength(2);
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
  });

  it("erro sem dados: o aviso compacto com 'Tentar de novo', e o resto do perfil segue", () => {
    const leitura = erro(undefined);
    fake.retornos = leitura;
    montar([]);
    const aviso = within(lado()).getByText("Não deu para ver se há retorno marcado");
    expect(aviso).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(within(lado()).getByRole("region", { name: "Quem atende" })).toBeInTheDocument();
    fireEvent.click(within(lado()).getByRole("button", { name: "Tentar de novo" }));
    expect(leitura.tentarDeNovo).toHaveBeenCalledTimes(1);
  });

  it("erro com dados: o cartão com o que já havia, sem o aviso", () => {
    fake.retornos = erro([{ ...retornoDeTeste(), conversa_id: CV_JULIANA }]);
    montar([]);
    expect(cartaoRetorno()).toBeInTheDocument();
    expect(screen.queryByText("Não deu para ver se há retorno marcado")).toBeNull();
  });

  it("erro ao ler o ajuste do lembrete: o aviso próprio, sem cartão", () => {
    fake.ajuste = {
      dados: undefined,
      carregando: false,
      erro: "falha",
      tentarDeNovo: vi.fn(),
    } satisfies Leitura<AjusteLembrete>;
    montar([lembreteDeTeste()]);
    expect(cartaoLembrete()).toBeNull();
    expect(within(lado()).getByText("Não deu para ver se há lembrete marcado")).toBeInTheDocument();
  });
});

describe("as classes do cartão existem no CSS do perfil", () => {
  it("toda classe de CartaoRetorno.tsx e as novas de Perfil.tsx têm seletor em Perfil.module.css", () => {
    const pasta = path.resolve(__dirname, "../features/plataforma/contatos");
    const css = readFileSync(path.join(pasta, "Perfil.module.css"), "utf8");
    const usadas = new Set<string>();
    for (const arquivo of ["CartaoRetorno.tsx", "Perfil.tsx"]) {
      const fonte = readFileSync(path.join(pasta, arquivo), "utf8");
      for (const m of fonte.matchAll(/\bs\.([A-Za-z0-9_]+)/g)) usadas.add(m[1]!);
    }
    expect(usadas.size).toBeGreaterThan(10);
    for (const nome of [
      "pfRetIcone",
      "pfRetBotao",
      "pfCartao",
      "pfPassoCab",
      "pfPassoTitulo",
      "pfPassoTexto",
      "pfCinza",
    ]) {
      expect(usadas.has(nome), `${nome} usada`).toBe(true);
    }
    const faltam = [...usadas].filter((n) => !new RegExp(`\\.${n}(?![A-Za-z0-9_-])`).test(css));
    expect(faltam).toEqual([]);
  });
});
