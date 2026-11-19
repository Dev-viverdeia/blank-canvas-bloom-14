import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Conversa } from "@/features/plataforma/chat/Conversa";
import { ProvedorDados } from "@/features/plataforma/dados/ProvedorDados";
import { pronta } from "@/features/plataforma/dados/leitura";
import type { Leitura, Resultado, RetornoDados } from "@/features/plataforma/dados/tipos";
import {
  criarEstadoInicial,
  idConversa,
  membroDoPapel,
  type EstadoBase,
} from "@/features/plataforma/exemplo";
import { ProvedorPapel, type Papel } from "@/features/plataforma/papel";

import { AGORA_TESTE, emBrasilia, lembreteDeTeste, retornoDeTeste } from "./retornos-fabrica";

// Retornos da Nina na conversa do Chat (mockup, quadros 1 a 16): a faixa sobre
// a caixa, as linhas do histórico e o cancelar. A Conversa roda no modo exemplo, com os retornos postos
// no estado (`ajustar`), o relógio fixo na quarta 18/11/2026 16:10 e o cancelar trocado por um dublê
// (a ação de verdade é testada em rt4). O lembrete nunca tem faixa no Chat.

afterEach(() => {
  cleanup();
  fake.leitura = null;
  cancelar.mockReset();
});

const cancelar = vi.hoisted(() => vi.fn<(id: string) => Promise<unknown>>());
/** Leitura que o teste impõe no lugar da de verdade (carregando, com erro); nula, vale a do exemplo. */
const fake = vi.hoisted(() => ({ leitura: null as unknown }));

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("@/features/plataforma/dados/retornos", async (original) => {
  const real = await original<typeof import("@/features/plataforma/dados/retornos")>();
  return {
    ...real,
    useCancelarRetorno: () => cancelar,
    useRetornos: (id: string) => {
      const doExemplo = real.useRetornos(id);
      return (fake.leitura as Leitura<RetornoDados[]> | null) ?? doExemplo;
    },
  };
});

beforeEach(() => {
  cancelar.mockResolvedValue({ ok: true });
});

/** O estado do exemplo com os retornos postos (o tipo do exemplo ainda não os conhece: a T10 os acrescenta). */
const comRetornos =
  (...rs: RetornoDados[]) =>
  (e: EstadoBase) =>
    ({ ...e, retornos: rs }) as EstadoBase;

function montar(
  lead: string,
  opcoes: {
    papel?: Papel;
    retornos?: RetornoDados[];
    ajustar?: (e: EstadoBase) => EstadoBase;
    avisar?: (texto: string, tom?: string) => void;
    agora?: number;
  } = {},
) {
  const conversaId = idConversa(lead);
  const inicial = () => {
    let e = criarEstadoInicial(new Date());
    e = comRetornos(...(opcoes.retornos ?? []).map((r) => ({ ...r, conversa_id: conversaId })))(e);
    return opcoes.ajustar ? opcoes.ajustar(e) : e;
  };
  const arvore = (id: string) => (
    <ProvedorPapel inicial={opcoes.papel ?? "admin"}>
      <ProvedorDados exemplo={inicial} progredirEnvios={false}>
        <Conversa
          conversaId={id}
          fichaAberta={false}
          onAlternarFicha={vi.fn()}
          agora={opcoes.agora ?? AGORA_TESTE}
          avisar={opcoes.avisar as never}
        />
      </ProvedorDados>
    </ProvedorPapel>
  );
  const r = render(arvore(conversaId));
  return {
    ...r,
    conversaId,
    outraConversa: (lead2: string) => r.rerender(arvore(idConversa(lead2))),
  };
}

const log = () => screen.getByRole("log");
const campo = () => screen.getByRole("textbox", { name: /^Mensagem/ });
const faixaDom = () => document.querySelector<HTMLElement>("[data-faixa-retorno]");
const temFaixa = () => document.querySelector("[data-com-faixa]") !== null;
const link = () => within(faixaDom()!).getByRole("button", { name: /^Cancel/ });
/** As linhas (role=note) do log com o texto, por tudo o que elas dizem. */
const linhaDoLog = (texto: string | RegExp) =>
  within(log())
    .getAllByRole("note")
    .find((n) =>
      typeof texto === "string" ? n.textContent?.includes(texto) : texto.test(n.textContent ?? ""),
    );
const semLinha = (texto: string | RegExp) =>
  expect(
    within(log())
      .queryAllByRole("note")
      .find((n) =>
        typeof texto === "string"
          ? n.textContent?.includes(texto)
          : texto.test(n.textContent ?? ""),
      ),
  ).toBeUndefined();

const MOTIVO = "Retomar a proposta do plano anual, depois da conversa dela com o sócio";

describe("quadro 1: retorno marcado", () => {
  it("a faixa azul acima da caixa: título em negrito, motivo e o link Cancelar", () => {
    montar("fernando", { retornos: [retornoDeTeste({ id: "r1" })] });
    expect(temFaixa()).toBe(true);
    const faixa = faixaDom()!;
    expect(within(faixa).getByText("Retorno marcado para amanhã, 09:00").tagName).toBe("B");
    expect(faixa).toHaveTextContent(`Retorno marcado para amanhã, 09:00 · ${MOTIVO}`);
    expect(link()).toHaveAccessibleName("Cancelar o retorno de amanhã, 09:00");
  });

  it("a caixa continua com 'você assume ao enviar' (a faixa do retorno não toma o lugar da dica)", () => {
    montar("fernando", { retornos: [retornoDeTeste()] });
    expect(campo()).toHaveAttribute(
      "placeholder",
      expect.stringContaining("você assume ao enviar"),
    );
  });

  it("a linha 'A Nina marcou um retorno para qui, 19/11, às 09:00 · 16:09' entra no histórico", () => {
    montar("fernando", { retornos: [retornoDeTeste()] });
    const l = linhaDoLog("A Nina marcou um retorno para")!;
    expect(l).toHaveTextContent("A Nina marcou um retorno para qui, 19/11, às 09:00 · 16:09");
    expect(within(l).getByText("qui, 19/11, às 09:00").tagName).toBe("B");
    expect(l).not.toHaveAttribute("data-tom");
  });

  it("a Nina marcou durante a conversa: a linha fica depois da bolha dela (a rodada de origem)", () => {
    const conversa = idConversa("fernando");
    const ancorar = (e: EstadoBase) =>
      ({
        ...e,
        mensagens: [
          ...e.mensagens.filter((m) => m.conversa_id !== conversa),
          mensagem(
            conversa,
            "m-lead",
            "Me chama amanhã de manhã?",
            "lead",
            "2026-11-18",
            "16:08",
            null,
          ),
          mensagem(
            conversa,
            "m-nina",
            "Combinado, Carla! Te chamo amanhã, quinta, às 9h.",
            "nina",
            "2026-11-18",
            "16:09:05",
            "rod-1",
          ),
        ],
      }) as EstadoBase;
    montar("fernando", {
      ajustar: ancorar,
      retornos: [
        retornoDeTeste({
          rodada_origem_id: "rod-1",
          marcado_em: emBrasilia("2026-11-18", "16:09:01"),
        }),
      ],
    });
    const bolha = screen.getByText("Combinado, Carla! Te chamo amanhã, quinta, às 9h.");
    const linha = linhaDoLog("A Nina marcou um retorno")!;
    expect(bolha.compareDocumentPosition(linha) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

/** Uma mensagem do exemplo, com o `rodada_id` que só o banco traz. */
function mensagem(
  conversa: string,
  id: string,
  texto: string,
  origem: "lead" | "nina",
  dia: string,
  hora: string,
  rodada: string | null,
) {
  const momento = emBrasilia(dia, hora);
  return {
    id,
    conversa_id: conversa,
    conexao_id: null,
    direcao: origem === "lead" ? "entrada" : "saida",
    origem,
    tipo: "texto",
    status: origem === "lead" ? "recebida" : "entregue",
    texto,
    transcricao: null,
    momento,
    autor_membro_id: null,
    midia_nome: null,
    midia_mime: null,
    midia_tamanho: null,
    midia_caminho: null,
    midia_status: null,
    editada: false,
    apagada_em: null,
    erro: null,
    id_externo: null,
    id_gateway: null,
    criado_em: momento,
    responde_a_id: null,
    midia_duracao_s: null,
    rodada_id: rodada,
  };
}

describe("quadros 2 e 3: na hora marcada e o lembrete", () => {
  const enviado = retornoDeTeste({
    id: "r1",
    status: "enviado",
    rodada_id: "rod-7",
    enviado_em: emBrasilia("2026-11-19", "09:00:03"),
    resolvido_em: emBrasilia("2026-11-19", "09:00:03"),
  });

  it("o retorno enviado: a faixa some e a linha 'Retorno combinado…' entra, antes da bolha da Nina", () => {
    const conversa = idConversa("fernando");
    montar("fernando", {
      retornos: [enviado],
      agora: Date.parse("2026-11-19T09:05:00-03:00"),
      ajustar: (e) =>
        ({
          ...e,
          mensagens: [
            ...e.mensagens.filter((m) => m.conversa_id !== conversa),
            mensagem(
              conversa,
              "m-nina",
              "Bom dia, Carla! Como combinamos, voltei para falar do plano anual.",
              "nina",
              "2026-11-19",
              "09:00:03",
              "rod-7",
            ),
          ],
        }) as EstadoBase,
    });
    expect(faixaDom()).toBeNull();
    expect(temFaixa()).toBe(false);
    const l = linhaDoLog("Retorno combinado: a Nina voltou a falar com o lead")!;
    expect(l).toHaveTextContent("Retorno combinado: a Nina voltou a falar com o lead · 09:00");
    const bolha = screen.getByText(/^Bom dia, Carla!/);
    expect(bolha.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it("o lembrete pendente nunca tem faixa, nem o retorno enviado com lembrete armado", () => {
    montar("fernando", {
      retornos: [enviado, lembreteDeTeste({ id: "l1" })],
      agora: Date.parse("2026-11-19T09:05:00-03:00"),
    });
    expect(temFaixa()).toBe(false);
    expect(faixaDom()).toBeNull();
    expect(screen.queryByText(/lembrete/i, { selector: "[data-faixa-retorno] *" })).toBeNull();
    // e a conversa não mostra "Cancelar" de lembrete nenhum
    expect(screen.queryByRole("button", { name: /^Cancelar o lembrete/ })).toBeNull();
    // armar não escreve linha no histórico
    semLinha("Lembrete");
  });

  it("quadro 3: o lembrete que saiu vira a linha 'Lembrete automático: o lead não respondia havia 3 h'", () => {
    montar("fernando", {
      retornos: [
        lembreteDeTeste({
          id: "l1",
          status: "enviado",
          rodada_id: "rod-l",
          enviado_em: emBrasilia("2026-11-18", "12:00:02"),
          resolvido_em: emBrasilia("2026-11-18", "12:00:02"),
        }),
      ],
    });
    expect(linhaDoLog("Lembrete automático")).toHaveTextContent(
      "Lembrete automático: o lead não respondia havia 3 h · 12:00",
    );
    expect(temFaixa()).toBe(false);
  });
});

describe("quadro 4: o lead responde antes da hora", () => {
  it("o retorno continua pendente: a faixa fica, com a mesma data", () => {
    montar("fernando", { retornos: [retornoDeTeste()] });
    expect(faixaDom()).toHaveTextContent("Retorno marcado para amanhã, 09:00");
  });
});

describe("quadro 5: a Nina remarca", () => {
  const velho = retornoDeTeste({
    id: "velho",
    status: "cancelado",
    fechado_por_rodada: "rod-2",
    resolvido_em: emBrasilia("2026-11-18", "16:20"),
  });
  const novo = retornoDeTeste({
    id: "novo",
    substitui_id: "velho",
    vence_em: emBrasilia("2026-11-20", "14:00"),
    expira_em: emBrasilia("2026-11-20", "17:00"),
    marcado_em: emBrasilia("2026-11-18", "16:20"),
    rodada_origem_id: "rod-2",
  });

  it("a faixa diz a data nova e as linhas são 'marcou' e 'remarcou' (o substituído sem linha de cancelamento)", () => {
    montar("fernando", { retornos: [velho, novo], agora: Date.parse("2026-11-18T16:25:00-03:00") });
    expect(faixaDom()).toHaveTextContent("Retorno marcado para sex, 20/11, 14:00");
    expect(document.querySelectorAll("[data-faixa-retorno]")).toHaveLength(1);
    expect(linhaDoLog("A Nina marcou um retorno para")).toHaveTextContent(
      "qui, 19/11, às 09:00 · 16:09",
    );
    expect(linhaDoLog("A Nina remarcou o retorno para")).toHaveTextContent(
      "sex, 20/11, às 14:00 · 16:20",
    );
    semLinha("cancelou");
  });
});

describe("quadros 6 e 8: a Nina cancela e a Nina relê e não manda", () => {
  it("quadro 6: 'A Nina cancelou o retorno de …' e nenhuma faixa", () => {
    montar("fernando", {
      retornos: [
        retornoDeTeste({
          status: "cancelado",
          fechado_por_rodada: "rod-9",
          vence_em: emBrasilia("2026-11-20", "14:00"),
          resolvido_em: emBrasilia("2026-11-18", "17:40"),
        }),
      ],
      agora: Date.parse("2026-11-18T17:41:00-03:00"),
    });
    expect(temFaixa()).toBe(false);
    expect(linhaDoLog("A Nina cancelou")).toHaveTextContent(
      "A Nina cancelou o retorno de sex, 20/11, às 14:00 · 17:40",
    );
  });

  it("quadro 8: dispensado com o porquê da Nina", () => {
    montar("fernando", {
      retornos: [
        retornoDeTeste({
          status: "dispensado",
          nota_fim: "o lead já fechou pelo site",
          resolvido_em: emBrasilia("2026-11-19", "09:00"),
        }),
      ],
      agora: Date.parse("2026-11-19T09:05:00-03:00"),
    });
    expect(linhaDoLog("A Nina dispensou")).toHaveTextContent(
      "A Nina dispensou o retorno das 09:00: o lead já fechou pelo site · 09:00",
    );
    expect(temFaixa()).toBe(false);
  });

  it("quadro 8: dispensado sem porquê anotado", () => {
    montar("fernando", {
      retornos: [
        retornoDeTeste({ status: "dispensado", resolvido_em: emBrasilia("2026-11-19", "09:00") }),
      ],
      agora: Date.parse("2026-11-19T09:05:00-03:00"),
    });
    expect(linhaDoLog("A Nina releu")).toHaveTextContent(
      "A Nina releu a conversa e não mandou o retorno das 09:00 · 09:00",
    );
  });
});

describe("quadro 9: com a equipe antes da hora", () => {
  it("faixa dupla: a faixa de hoje, o retorno e a nota 'A Nina só envia se…', sem o motivo", () => {
    montar("patricia", { retornos: [retornoDeTeste()] });
    const faixa = faixaDom()!;
    expect(faixa).toHaveAttribute("data-dupla");
    expect(faixa).toHaveTextContent(
      "Marina está atendendo. Se você enviar, a conversa continua com Marina.",
    );
    expect(within(faixa).getByText("Retorno marcado para amanhã, 09:00")).toBeInTheDocument();
    expect(
      within(faixa).getByText("A Nina só envia se a conversa voltar para ela antes da hora."),
    ).toBeInTheDocument();
    expect(faixa).not.toHaveTextContent("Retomar a proposta");
    // sem a dica de assumir: com outra pessoa, o texto padrão da caixa
    expect(campo()).toHaveAttribute("placeholder", expect.not.stringContaining("você assume"));
    // o link é só um
    expect(within(faixa).getAllByRole("button", { name: /^Cancelar/ })).toHaveLength(1);
  });

  it("a conversa parada por falha também fica dupla (a faixa vermelha e o retorno)", () => {
    montar("juliana", { retornos: [retornoDeTeste()] });
    const faixa = faixaDom()!;
    expect(faixa).toHaveAttribute("data-dupla");
    expect(faixa).toHaveTextContent("Sem crédito de IA: a Nina parou. Ao responder, você assume.");
    expect(faixa).toHaveTextContent("A Nina só envia se a conversa voltar para ela antes da hora.");
  });

  it("WhatsApp desconectado: o bloqueio e o retorno, e a equipe ainda pode cancelar", () => {
    montar("fernando", {
      retornos: [retornoDeTeste()],
      ajustar: (e) => ({
        ...e,
        conexao: e.conexao && { ...e.conexao, ativa: false, status: "desconectada" },
      }),
    });
    const faixa = faixaDom()!;
    expect(faixa).toHaveAttribute("data-dupla");
    expect(faixa).toHaveTextContent("WhatsApp desconectado");
    expect(link()).toHaveAccessibleName("Cancelar o retorno de amanhã, 09:00");
  });
});

describe("quadro 10: a hora chega com a equipe (não enviado)", () => {
  it.each([
    ["com_equipe", "a conversa estava com a equipe"],
    ["fora_24h", "passaram 24 h da última mensagem do lead"],
    ["desconectado", "o WhatsApp estava desconectado"],
    ["passou_do_prazo", "passou mais de 3 h da hora marcada"],
    ["envio_recusado", "o WhatsApp recusou o envio"],
    ["nina_falhou", "a Nina não conseguiu responder"],
  ])("%s: a linha vermelha com o motivo", (motivo, texto) => {
    montar("fernando", {
      retornos: [
        retornoDeTeste({
          status: "nao_enviado",
          nao_enviado_motivo: motivo,
          resolvido_em: emBrasilia("2026-11-19", "09:00"),
        }),
      ],
      agora: Date.parse("2026-11-19T09:05:00-03:00"),
    });
    const l = linhaDoLog("não enviado")!;
    expect(l).toHaveTextContent(`Retorno das 09:00 não enviado: ${texto} · 09:00`);
    expect(l).toHaveAttribute("data-tom", "falha");
    expect(temFaixa()).toBe(false);
  });

  it("com a equipe, a faixa 'está atendendo' fica e a do retorno não (já não está pendente)", () => {
    montar("patricia", {
      retornos: [
        retornoDeTeste({
          status: "nao_enviado",
          nao_enviado_motivo: "com_equipe",
          resolvido_em: emBrasilia("2026-11-19", "09:00"),
        }),
      ],
      agora: Date.parse("2026-11-19T09:05:00-03:00"),
    });
    expect(faixaDom()).toBeNull();
    expect(
      screen.getByText("Marina está atendendo. Se você enviar, a conversa continua com Marina."),
    ).toBeInTheDocument();
  });
});

describe("quadros 7, 11, 12 e 13: o cancelar", () => {
  it("quadro 11: o clique vira 'Cancelando…' (aria-disabled), o 2º clique não chama de novo e o foco fica", async () => {
    let resolver: (r: Resultado) => void = () => {};
    cancelar.mockReturnValue(new Promise<Resultado>((r) => (resolver = r)));
    montar("fernando", { retornos: [retornoDeTeste({ id: "r1" })] });
    const antes = link();
    antes.focus();
    fireEvent.click(antes);
    fireEvent.click(antes);
    expect(cancelar).toHaveBeenCalledTimes(1);
    expect(cancelar).toHaveBeenCalledWith("r1");
    const cancelando = within(faixaDom()!).getByRole("button", {
      name: "Cancelando o retorno de amanhã, 09:00",
    });
    expect(cancelando).toHaveTextContent("Cancelando…");
    expect(cancelando).toHaveAttribute("aria-disabled", "true");
    expect(cancelando).toHaveAttribute("aria-busy", "true");
    expect(document.activeElement).toBe(cancelando);
    await act(async () => resolver({ ok: true }));
  });

  it("quadro 7: deu certo, a faixa some na hora, o aviso de sucesso sai e o foco vai para o campo", async () => {
    const avisar = vi.fn();
    montar("fernando", { retornos: [retornoDeTeste({ id: "r1" })], avisar });
    fireEvent.click(link());
    await waitFor(() => expect(faixaDom()).toBeNull());
    expect(avisar).toHaveBeenCalledWith("Retorno cancelado. A Nina não vai chamar o lead.", "ok");
    expect(temFaixa()).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(campo()));
  });

  it("quadro 7: sem o toast da tela, o aviso vai para o leitor de tela", async () => {
    montar("fernando", { retornos: [retornoDeTeste({ id: "r1" })] });
    fireEvent.click(link());
    const status = () =>
      log().closest("[data-ficha]")!.querySelector<HTMLElement>(":scope > [role='status']")!;
    await waitFor(() =>
      expect(status()).toHaveTextContent("Retorno cancelado. A Nina não vai chamar o lead."),
    );
  });

  it("quadro 7: a linha 'Você cancelou o retorno de …' (feita pela equipe) e o nome de outro membro", () => {
    const eu = membroDoPapel(criarEstadoInicial(new Date()).membros, "admin").id;
    montar("fernando", {
      retornos: [
        retornoDeTeste({
          status: "cancelado",
          cancelado_por: eu,
          resolvido_em: emBrasilia("2026-11-18", "17:02"),
        }),
      ],
      agora: Date.parse("2026-11-18T17:05:00-03:00"),
    });
    expect(linhaDoLog("cancelou")).toHaveTextContent(
      "Você cancelou o retorno de qui, 19/11, às 09:00 · 17:02",
    );
    cleanup();
    montar("fernando", {
      retornos: [
        retornoDeTeste({
          status: "cancelado",
          cancelado_por: "membro-apagado",
          resolvido_em: emBrasilia("2026-11-18", "17:02"),
        }),
      ],
      agora: Date.parse("2026-11-18T17:05:00-03:00"),
    });
    expect(linhaDoLog("cancelou")).toHaveTextContent(
      "Alguém da equipe cancelou o retorno de qui, 19/11, às 09:00",
    );
  });

  it("quadro 12: erro ao cancelar, o aviso de erro, o link volta a 'Cancelar', o retorno continua e o foco fica nele", async () => {
    cancelar.mockResolvedValue({ ok: false, erro: "falha" });
    const avisar = vi.fn();
    montar("fernando", { retornos: [retornoDeTeste({ id: "r1" })], avisar });
    link().focus();
    fireEvent.click(link());
    await waitFor(() =>
      expect(avisar).toHaveBeenCalledWith("Não deu para cancelar agora. Tente de novo.", "erro"),
    );
    const de_novo = within(faixaDom()!).getByRole("button", {
      name: "Cancelar o retorno de amanhã, 09:00",
    });
    expect(de_novo).toHaveTextContent("Cancelar");
    expect(de_novo).not.toHaveAttribute("aria-disabled");
    expect(document.activeElement).toBe(de_novo);
    // e dá para tentar de novo
    cancelar.mockResolvedValue({ ok: true });
    fireEvent.click(de_novo);
    await waitFor(() => expect(faixaDom()).toBeNull());
    expect(cancelar).toHaveBeenCalledTimes(2);
  });

  it("quadro 12: sem acesso, o aviso de acesso e a faixa fica", async () => {
    cancelar.mockResolvedValue({ ok: false, erro: "sem_acesso" });
    const avisar = vi.fn();
    montar("fernando", { retornos: [retornoDeTeste({ id: "r1" })], avisar });
    fireEvent.click(link());
    await waitFor(() =>
      expect(avisar).toHaveBeenCalledWith(
        "Sua conta não tem mais acesso a isto. Peça ao admin para conferir o seu convite.",
        "erro",
      ),
    );
    expect(faixaDom()).not.toBeNull();
  });

  it.each(["retorno_nao_pendente", "nao_encontrado"] as const)(
    "quadro 13: já saiu (%s), o aviso, a faixa some e a leitura é pedida de novo pelo hook",
    async (erro) => {
      cancelar.mockResolvedValue({ ok: false, erro });
      const avisar = vi.fn();
      montar("fernando", { retornos: [retornoDeTeste({ id: "r1" })], avisar });
      fireEvent.click(link());
      await waitFor(() => expect(faixaDom()).toBeNull());
      expect(avisar).toHaveBeenCalledWith("Esse retorno já saiu ou já foi cancelado.", "erro");
      await waitFor(() => expect(document.activeElement).toBe(campo()));
    },
  );

  it("o atendente também cancela (caso 22): quem decide é o banco", async () => {
    const avisar = vi.fn();
    montar("fernando", { papel: "atendente", retornos: [retornoDeTeste({ id: "r1" })], avisar });
    fireEvent.click(link());
    await waitFor(() => expect(faixaDom()).toBeNull());
    expect(cancelar).toHaveBeenCalledWith("r1");
    expect(avisar).toHaveBeenCalledWith("Retorno cancelado. A Nina não vai chamar o lead.", "ok");
  });

  it("trocar de conversa durante o cancelar: o resultado não mostra aviso na outra e o 'Cancelando…' não vai junto", async () => {
    let resolver: (r: Resultado) => void = () => {};
    cancelar.mockReturnValue(new Promise<Resultado>((r) => (resolver = r)));
    const avisar = vi.fn();
    const { outraConversa } = montar("fernando", {
      retornos: [retornoDeTeste({ id: "r1" })],
      avisar,
      ajustar: (e) =>
        ({
          ...e,
          retornos: [
            ...(e as unknown as { retornos: RetornoDados[] }).retornos,
            retornoDeTeste({ id: "r2", conversa_id: idConversa("ricardo") }),
          ],
        }) as EstadoBase,
    });
    fireEvent.click(link());
    outraConversa("ricardo");
    // na outra conversa, o retorno dela está intacto, e com o link normal
    const faixa = faixaDom()!;
    expect(
      within(faixa).getByRole("button", { name: "Cancelar o retorno de amanhã, 09:00" }),
    ).toBeInTheDocument();
    await act(async () => resolver({ ok: true }));
    expect(avisar).not.toHaveBeenCalled();
    expect(faixaDom()).not.toBeNull();
  });

  it("ir para a outra conversa e voltar durante o cancelar: segue 'Cancelando…', o 2º clique não chama de novo e o aviso é o de sucesso", async () => {
    let resolver: (r: Resultado) => void = () => {};
    cancelar.mockReturnValue(new Promise<Resultado>((r) => (resolver = r)));
    const avisar = vi.fn();
    const { outraConversa } = montar("fernando", {
      retornos: [retornoDeTeste({ id: "r1" })],
      avisar,
      ajustar: (e) =>
        ({
          ...e,
          retornos: [
            ...(e as unknown as { retornos: RetornoDados[] }).retornos,
            retornoDeTeste({ id: "r2", conversa_id: idConversa("ricardo") }),
          ],
        }) as EstadoBase,
    });
    fireEvent.click(link());
    outraConversa("ricardo");
    outraConversa("fernando");
    const cancelando = within(faixaDom()!).getByRole("button", {
      name: "Cancelando o retorno de amanhã, 09:00",
    });
    expect(cancelando).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(cancelando);
    expect(cancelar).toHaveBeenCalledTimes(1);
    await act(async () => resolver({ ok: true }));
    expect(avisar).toHaveBeenCalledTimes(1);
    expect(avisar).toHaveBeenCalledWith("Retorno cancelado. A Nina não vai chamar o lead.", "ok");
  });

  it("o cancelar em andamento numa conversa não trava o cancelar do retorno de outra", async () => {
    const resolvers: Array<(r: Resultado) => void> = [];
    cancelar.mockImplementation(() => new Promise<Resultado>((r) => resolvers.push(r)));
    const { outraConversa } = montar("fernando", {
      retornos: [retornoDeTeste({ id: "r1" })],
      ajustar: (e) =>
        ({
          ...e,
          retornos: [
            ...(e as unknown as { retornos: RetornoDados[] }).retornos,
            retornoDeTeste({ id: "r2", conversa_id: idConversa("ricardo") }),
          ],
        }) as EstadoBase,
    });
    fireEvent.click(link());
    outraConversa("ricardo");
    fireEvent.click(link());
    expect(cancelar).toHaveBeenCalledTimes(2);
    expect(cancelar).toHaveBeenNthCalledWith(2, "r2");
    await act(async () => resolvers.forEach((r) => r({ ok: true })));
  });
});

describe("quadro 14: sem retorno, nada muda", () => {
  it.each([
    ["com a Nina", "fernando"],
    ["esperando sem falha", "ricardo"],
    ["no celular", "carlos"],
    ["com você", "sergio"],
  ])("nenhuma faixa nem espaço %s", (_caso, lead) => {
    montar(lead);
    expect(temFaixa()).toBe(false);
    expect(faixaDom()).toBeNull();
    expect(
      within(log())
        .queryAllByRole("note")
        .filter((n) => /retorno|Lembrete/i.test(n.textContent ?? "")),
    ).toEqual([]);
  });

  it("só com um lembrete armado, também nenhuma faixa", () => {
    montar("fernando", { retornos: [lembreteDeTeste()] });
    expect(temFaixa()).toBe(false);
  });

  it("o retorno que passou do expira_em não fica na tela dizendo a hora de ontem", () => {
    montar("fernando", {
      retornos: [retornoDeTeste()],
      agora: Date.parse("2026-11-19T12:00:01-03:00"),
    });
    expect(temFaixa()).toBe(false);
  });

  it("o retorno atrasado (depois da hora, antes do expira_em) continua com a faixa, dizendo 'hoje, 09:00'", () => {
    montar("fernando", {
      retornos: [retornoDeTeste()],
      agora: Date.parse("2026-11-19T09:20:00-03:00"),
    });
    expect(faixaDom()).toHaveTextContent("Retorno marcado para hoje, 09:00");
  });

  it("o retorno em outro estado (em_rodada, saindo) esconde a faixa", () => {
    montar("fernando", { retornos: [retornoDeTeste({ status: "em_rodada" })] });
    expect(temFaixa()).toBe(false);
  });
});

describe("quadro 15: motivo longo", () => {
  it("o texto inteiro vai no title e o link continua do lado", () => {
    const longo = `${MOTIVO}, e voltar a falar do desconto para o pagamento à vista depois do fechamento do trimestre`;
    montar("fernando", { retornos: [retornoDeTeste({ motivo: longo })] });
    const txt = within(faixaDom()!).getByTitle(`Retorno marcado para amanhã, 09:00 · ${longo}`);
    expect(txt).toHaveTextContent(longo);
    expect(link()).toBeInTheDocument();
  });
});

describe("a leitura dos retornos nunca tira a conversa do ar", () => {
  const leitura = (parcial: Partial<Leitura<RetornoDados[]>>): Leitura<RetornoDados[]> => ({
    ...pronta<RetornoDados[]>([]),
    ...parcial,
  });

  it("a lista espera os retornos: carregando, 'Carregando as mensagens' e nenhuma linha antes da 1ª pintura", () => {
    fake.leitura = leitura({ dados: undefined, carregando: true });
    montar("fernando");
    expect(screen.getByRole("status", { name: "Carregando as mensagens" })).toBeInTheDocument();
    expect(within(log()).queryAllByRole("note")).toEqual([]);
  });

  it("erro sem dados: as mensagens ficam, com o aviso compacto e o 'Tentar de novo' da leitura", () => {
    const tentarDeNovo = vi.fn();
    fake.leitura = leitura({ dados: undefined, carregando: false, erro: "falha", tentarDeNovo });
    montar("fernando");
    expect(screen.queryByRole("status", { name: "Carregando as mensagens" })).toBeNull();
    expect(screen.queryByText("Não deu para carregar as mensagens")).toBeNull();
    expect(screen.getByText("Não deu para atualizar a conversa")).toBeInTheDocument();
    expect(temFaixa()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Tentar de novo/ }));
    expect(tentarDeNovo).toHaveBeenCalled();
  });

  it("erro numa releitura, com os dados antigos: a faixa fica e o aviso aparece", () => {
    fake.leitura = leitura({
      dados: [retornoDeTeste({ conversa_id: idConversa("fernando") })],
      erro: "falha",
    });
    montar("fernando");
    expect(screen.getByText("Não deu para atualizar a conversa")).toBeInTheDocument();
    expect(faixaDom()).not.toBeNull();
  });
});
