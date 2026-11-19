import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Conversa } from "@/features/plataforma/chat/Conversa";
import { TelaChat } from "@/features/plataforma/chat/TelaChat";
import {
  Bolha,
  resumoBolha,
  type AutorBolha,
  type MensagemBolha,
} from "@/features/plataforma/comum/Bolha";
import {
  falasDaTranscricao,
  previaLegivel,
  tituloDoRegistro,
} from "@/features/plataforma/comum/ligacao";
import { resumoMensagem } from "@/features/plataforma/comum/LinhaConversa";
import { AbaConversa } from "@/features/plataforma/contatos/AbaConversa";
import { ProvedorDados } from "@/features/plataforma/dados/ProvedorDados";
import {
  criarEstadoInicial,
  idContato,
  idConversa,
  type EstadoBase,
  type Mensagem,
} from "@/features/plataforma/exemplo";
import { GavetaLead } from "@/features/plataforma/kanban/GavetaLead";
import { ProvedorPapel } from "@/features/plataforma/papel";

// Task T da spec das ligações (2.7): o registro da ligação vira um bloco
// próprio nas três conversas (Chat, aba Conversa dos Contatos e gaveta do Kanban, todas pela Bolha),
// com o telefone, o título de cada fase, o resumo e a transcrição que abre e fecha; e a prévia da
// lista de conversas mostra o título no lugar do texto cru.

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));

// 14:45 em São Paulo (17:45 UTC).
const AGORA = new Date("2026-10-30T17:45:00.000Z");
const minAtras = (m: number) => new Date(AGORA.getTime() - m * 60_000).toISOString();

const CONCLUIDA = "[ligação] concluída (192 s)\nO lead quer saber o preço do plano anual.";
const TRANSCRICAO =
  "Lead: Oi, queria saber do plano anual.\nNina: Claro! Posso te passar para a equipe.";

function msg(campos: Partial<MensagemBolha> = {}): MensagemBolha {
  return {
    id: "m-lig",
    origem: "lead",
    tipo: "outro",
    status: "recebida",
    texto: CONCLUIDA,
    transcricao: TRANSCRICAO,
    momento: minAtras(5),
    ...campos,
  };
}

const LEAD: AutorBolha = { nome: "Ricardo", nomeCompleto: "Ricardo Alves" };
const bloco = () => document.querySelector("[data-ligacao]") as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AGORA);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("O bloco da ligação (Bolha)", () => {
  it('concluída: o telefone, "Ligação · 3 min 12 s", o resumo e a hora; sem Responder', () => {
    const responder = vi.fn();
    render(<Bolha mensagem={msg()} autor={LEAD} nomeLead="Ricardo" aoResponder={responder} />);
    const b = bloco();
    expect(b).toHaveAttribute("data-fase", "concluida");
    expect(b.querySelector("svg")).not.toBeNull();
    expect(b).toHaveTextContent("Ligação · 3 min 12 s");
    expect(b).toHaveTextContent("O lead quer saber o preço do plano anual.");
    expect(b).toHaveTextContent("14:40");
    // o texto cru nunca aparece
    expect(screen.getByRole("article").textContent).not.toMatch(/\[ligação\]/);
    expect(screen.queryByRole("button", { name: "Responder citando esta mensagem" })).toBeNull();
    // o nome acessível diz o título e o resumo
    expect(screen.getByRole("article").getAttribute("aria-label")).toMatch(
      /Ligação · 3 min 12 s\. O lead quer saber/,
    );
  });

  it('"Ver transcrição" abre e fecha a transcrição, com o nome do lead', () => {
    render(<Bolha mensagem={msg()} autor={LEAD} nomeLead="Ricardo" />);
    const ver = screen.getByRole("button", { name: "Ver transcrição" });
    expect(ver).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "Transcrição da ligação" })).toBeNull();
    fireEvent.click(ver);
    expect(ver).toHaveAttribute("aria-expanded", "true");
    const t = screen.getByRole("region", { name: "Transcrição da ligação" });
    expect(ver).toHaveAttribute("aria-controls", t.id);
    expect(
      within(t)
        .getAllByRole("paragraph")
        .map((p) => p.textContent),
    ).toEqual([
      "Ricardo: Oi, queria saber do plano anual.",
      "Nina: Claro! Posso te passar para a equipe.",
    ]);
    fireEvent.click(ver);
    expect(ver).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "Transcrição da ligação" })).toBeNull();
  });

  it.each([
    [
      "em andamento há pouco",
      { texto: "[ligação] em andamento", momento: minAtras(3) },
      "andamento",
      "Ligação em andamento",
    ],
    [
      "em andamento há mais de 35 min (30 da duração máxima mais a folga)",
      { texto: "[ligação] em andamento", momento: minAtras(36) },
      "andamento",
      "Ligação sem resumo",
    ],
    ["não completada", { texto: "[ligação] não completada" }, "falhou", "Ligação não completada"],
    [
      "concluída sem resumo",
      { texto: "[ligação] concluída (45 s)" },
      "concluida",
      "Ligação · 45 s",
    ],
  ])("%s", (_nome, campos, fase, titulo) => {
    render(<Bolha mensagem={msg({ ...campos, transcricao: null })} autor={LEAD} />);
    expect(bloco()).toHaveAttribute("data-fase", fase);
    expect(bloco().querySelector("p")).toHaveTextContent(titulo);
    // sem transcrição, sem o botão
    expect(screen.queryByRole("button", { name: "Ver transcrição" })).toBeNull();
  });

  it('fora do formato (a prévia cortada) vale "Ligação"; texto com [ligação] em mensagem de texto é texto', () => {
    render(<Bolha mensagem={msg({ texto: "[ligação] conclu", transcricao: null })} autor={LEAD} />);
    expect(bloco()).toHaveTextContent("Ligação");
    cleanup();
    render(
      <Bolha mensagem={msg({ tipo: "texto", texto: "[ligação] concluída (12 s)" })} autor={LEAD} />,
    );
    expect(bloco()).toBeNull();
    expect(screen.getByRole("article")).toHaveTextContent("[ligação] concluída (12 s)");
  });
});

describe("O título do registro na prévia", () => {
  it("resumoMensagem e resumoBolha trocam o texto cru pelo título", () => {
    const m = {
      id: "m",
      origem: "lead" as const,
      tipo: "outro" as const,
      status: "recebida" as const,
      texto: CONCLUIDA,
      momento: minAtras(1),
    };
    expect(resumoMensagem(m)).toBe("Ligação · 3 min 12 s");
    expect(resumoBolha(msg({ texto: "[ligação] não completada" }))).toBe("Ligação não completada");
    // outro "outro" continua como antes
    expect(resumoMensagem({ ...m, texto: "[localização]" })).toBe("[localização]");
  });

  it("a prévia gravada na conversa (sem o tipo) também vira o título", () => {
    expect(previaLegivel(CONCLUIDA, minAtras(1))).toBe("Ligação · 3 min 12 s");
    expect(previaLegivel("[ligação] em andamento", minAtras(36))).toBe("Ligação sem resumo");
    expect(previaLegivel("[ligação] em andamento", minAtras(20))).toBe("Ligação em andamento");
    expect(previaLegivel("Oi, tudo bem?")).toBe("Oi, tudo bem?");
    expect(previaLegivel(null)).toBeNull();
    expect(tituloDoRegistro("[ligação] concluída (19")).toBe("Ligação");
  });

  it("a transcrição em falas: linha sem quem fica inteira, linhas vazias saem", () => {
    expect(falasDaTranscricao("Lead: oi\n\nNina: olá\ncontinuação")).toEqual([
      { quem: "Lead", fala: "oi" },
      { quem: "Nina", fala: "olá" },
      { quem: "", fala: "continuação" },
    ]);
  });
});

/* ---------- as três conversas, no modo exemplo ---------- */

const LEAD_ID = "ricardo";

/** O exemplo com uma ligação concluída como a última mensagem do Ricardo. */
function comLigacao(): EstadoBase {
  const e = criarEstadoInicial(AGORA);
  const conversaId = idConversa(LEAD_ID);
  const modelo = e.mensagens.find((m) => m.conversa_id === conversaId && m.origem === "lead")!;
  const ligacao: Mensagem = {
    ...modelo,
    id: "m-ligacao",
    direcao: "entrada",
    origem: "lead",
    tipo: "outro",
    status: "recebida",
    texto: CONCLUIDA,
    transcricao: TRANSCRICAO,
    momento: minAtras(1),
    criado_em: minAtras(1),
    autor_membro_id: null,
    midia_nome: null,
    midia_mime: null,
    midia_tamanho: null,
    midia_caminho: null,
    midia_status: null,
    editada: false,
    apagada_em: null,
    erro: null,
    reacao: null,
    citaId: null,
    duracaoS: null,
  };
  return {
    ...e,
    mensagens: [...e.mensagens, ligacao],
    conversas: e.conversas.map((c) =>
      c.id === conversaId
        ? { ...c, ultima_mensagem_em: ligacao.momento, ultima_mensagem_preview: CONCLUIDA }
        : c,
    ),
  };
}

function Montar({ children }: { children: ReactNode }) {
  return (
    <ProvedorPapel inicial="admin">
      <ProvedorDados exemplo={comLigacao} progredirEnvios={false} relogio={() => AGORA}>
        {children}
      </ProvedorDados>
    </ProvedorPapel>
  );
}

function ComGaveta() {
  const [aberto, setAberto] = useState<string | null>(null);
  return (
    <>
      <button type="button" onClick={() => setAberto(idContato(LEAD_ID))}>
        Abrir
      </button>
      <GavetaLead contatoId={aberto} aoFechar={() => setAberto(null)} />
    </>
  );
}

async function assentar() {
  await act(async () => {
    await Promise.resolve();
  });
}

/** O bloco aparece com o título e a transcrição abre e fecha. */
function conferirBloco(dentro: HTMLElement) {
  const b = dentro.querySelector("[data-ligacao]") as HTMLElement;
  expect(b).not.toBeNull();
  expect(b).toHaveTextContent("Ligação · 3 min 12 s");
  expect(b).toHaveTextContent("O lead quer saber o preço do plano anual.");
  const ver = within(b).getByRole("button", { name: "Ver transcrição" });
  fireEvent.click(ver);
  expect(within(b).getByRole("region", { name: "Transcrição da ligação" })).toHaveTextContent(
    "Nina: Claro!",
  );
  fireEvent.click(ver);
  expect(within(b).queryByRole("region")).toBeNull();
}

describe("O bloco nas três conversas", () => {
  it("Chat", async () => {
    render(
      <Montar>
        <Conversa conversaId={idConversa(LEAD_ID)} fichaAberta={false} onAlternarFicha={() => {}} />
      </Montar>,
    );
    await assentar();
    conferirBloco(document.body);
  });

  it("aba Conversa dos Contatos", async () => {
    render(
      <Montar>
        <AbaConversa
          contatoId={idContato(LEAD_ID)}
          agora={AGORA.getTime()}
          irParaAba={vi.fn()}
          verNaConversa={vi.fn()}
          avisar={vi.fn()}
          mensagemAlvo={null}
          focarCaixa={false}
        />
      </Montar>,
    );
    await assentar();
    conferirBloco(document.body);
  });

  it("gaveta do Kanban", async () => {
    render(
      <Montar>
        <ComGaveta />
      </Montar>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Abrir" }));
    await assentar();
    conferirBloco(screen.getByRole("dialog"));
  });

  it('a lista do Chat mostra "Ligação · 3 min 12 s" na prévia, com o telefone', async () => {
    render(
      <Montar>
        <TelaChat />
      </Montar>,
    );
    await assentar();
    const linha = screen
      .getAllByRole("button")
      .find((b) =>
        (b.getAttribute("aria-label") ?? b.textContent ?? "").includes("Ligação · 3 min 12 s"),
      );
    expect(linha).toBeDefined();
    expect(linha!.textContent).not.toMatch(/\[ligação\]/);
    expect(linha!.querySelector('[data-tipo="outro"]')).not.toBeNull();
  });
});
