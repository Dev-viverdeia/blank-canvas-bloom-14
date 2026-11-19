import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProvedorDados } from "@/features/plataforma/dados/ProvedorDados";
import {
  criarEstadoInicial,
  idConversa,
  type ChaveIA,
  type EstadoBase,
} from "@/features/plataforma/exemplo";
import { ID_AGENTE_NINA, VERSAO_AGENTE_EXEMPLO } from "@/features/plataforma/exemplo/ligacoes";
import { reduzir } from "@/features/plataforma/exemplo/reducer";
import {
  LIMITES_PADRAO,
  SAUDACAO_PADRAO,
  TelaLigacoes,
  camposPadrao,
  filtrarLigacoes,
  mudarLimite,
  numerosDasLigacoes,
  seloDaLigacao,
  textoMotivoFim,
  type Ligacao,
} from "@/features/plataforma/ligacoes";
import { TEXTO_ATUALIZACAO } from "@/features/plataforma/ligacoes/textos";
import {
  SAUDACAO_LIGAR,
  saudacaoAoTrocarUso,
  usoPadraoDoNovo,
} from "@/features/plataforma/ligacoes/tipos";
import { ProvedorPapel, type Papel } from "@/features/plataforma/papel";
import { PARADAS, paradasDoTour } from "@/features/plataforma/tour";

// A área Ligações no modo exemplo (2.3; fase A2): o topo (o passo a passo
// antes de ativar; ativas, a situação e os três números), o Histórico (lista, filtros, busca e a
// ligação aberta, com "Abrir conversa"), os Agentes (cartões, quem atende, o aviso de atualização,
// criar, editar e apagar), os Ajustes (o número, os limites e o cartão de desativar), o que o
// atendente vê, as regras do exemplo e o tour. O cartão de ativar e a camada da Configuração têm os
// testes no lg1.

vi.mock("@/components/nina/VooNina", async (original) => {
  const real = await original<typeof import("@/components/nina/VooNina")>();
  return { ...real, movimentoReduzido: () => true, rolarAteEMedir: () => Promise.resolve(null) };
});

const AGORA = new Date("2026-11-03T15:00:00-03:00");
const NUMERO = "+55 11 90000-0000";

async function andar(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function carregar() {
  for (let i = 0; i < 6; i++) await andar(5);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AGORA);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const CHAVE_VOZ = {
  id: "k-voz",
  finalidade: "voz",
  provedor: "elevenlabs",
  modelo: "",
  status: "ativa",
  ultimos4: "EL11",
  ultimo_erro: null,
  validada_em: AGORA.toISOString(),
  atualizada_em: AGORA.toISOString(),
  atualizada_por: null,
} as ChaveIA;

/** O exemplo com a conexão da Meta, a chave da voz e a voz escolhida; `ativas` liga as ligações. */
function exemploPronto(ativas = false): EstadoBase {
  const base = criarEstadoInicial(AGORA);
  return {
    ...base,
    conexao: { ...base.conexao!, gateway: "meta", oficial: true, nome: NUMERO },
    chaves: [...base.chaves.filter((k) => k.finalidade !== "voz"), CHAVE_VOZ],
    configuracao: { ...base.configuracao, voz_id: "exemplo-voz-a", voz_nome: "Voz de exemplo A" },
    ligacoes: ativas ? { ativadaEm: AGORA.toISOString() } : null,
  };
}

/** A área numa rota de verdade (o "Abrir conversa" e os atalhos navegam), com o Chat e o Contexto ao lado. */
function montar({ estado, papel = "admin" }: { estado?: EstadoBase; papel?: Papel } = {}) {
  const raiz = createRootRoute({
    component: () => (
      <ProvedorPapel inicial={papel}>
        <ProvedorDados
          exemplo={estado ?? criarEstadoInicial(AGORA)}
          progredirEnvios={false}
          relogio={() => new Date(AGORA)}
        >
          <Outlet />
        </ProvedorDados>
      </ProvedorPapel>
    ),
  });
  const ligacoes = createRoute({
    getParentRoute: () => raiz,
    path: "/app/ligacoes",
    component: TelaLigacoes,
  });
  const chat = createRoute({
    getParentRoute: () => raiz,
    path: "/app/chat",
    validateSearch: (s: Record<string, unknown>) => ({
      conversa: typeof s["conversa"] === "string" ? s["conversa"] : undefined,
    }),
    component: () => <h1>Chat aberto</h1>,
  });
  const contexto = createRoute({
    getParentRoute: () => raiz,
    path: "/app/contexto",
    component: () => <h1>Contexto aberto</h1>,
  });
  const router = createRouter({
    routeTree: raiz.addChildren([ligacoes, chat, contexto]),
    history: createMemoryHistory({ initialEntries: ["/app/ligacoes"] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

const aba = (nome: string) => screen.getByRole("tab", { name: nome });
const linhas = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-lg-lista] button[data-ligacao]"));
const nomesNaLista = () =>
  linhas().map((b) => b.querySelector("[class*='lgItemNome']")!.textContent);
const cartaoDoAgente = (nome: string) =>
  screen.getByRole("heading", { level: 3, name: nome }).closest<HTMLElement>("[data-agente]")!;
const status = () => document.querySelector<HTMLElement>("[class*='lgSr'][role='status']")!;

async function abrirAba(nome: string) {
  await carregar();
  fireEvent.click(aba(nome));
  await carregar();
}

/* ---------- a área e as abas ---------- */

describe("a área Ligações", () => {
  it("o admin vê o título, o topo e as três abas, com o Histórico aberto", async () => {
    montar();
    await carregar();
    expect(screen.getByRole("heading", { level: 1, name: "Ligações" })).toBeInTheDocument();
    const abas = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(abas.map((a) => a.textContent)).toEqual(["Histórico", "Agentes", "Ajustes"]);
    expect(aba("Histórico")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("data-painel", "historico");
    // as setas trocam de aba
    fireEvent.keyDown(aba("Histórico"), { key: "ArrowRight" });
    expect(aba("Agentes")).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(aba("Agentes"));
  });

  it("o atendente vê só o Histórico, sem a linha das abas, e o topo sem ativar nada", async () => {
    montar({ papel: "atendente" });
    await carregar();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Agentes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ativar ligações" })).toBeNull();
    expect(document.getElementById("lg-cartao")).toBeNull();
    expect(
      screen.getByRole("heading", { level: 2, name: "Ligações desligadas" }),
    ).toBeInTheDocument();
    expect(linhas()).toHaveLength(8);
  });

  it("o atendente, com as ligações ativas, vê a situação e os números", async () => {
    montar({ papel: "atendente", estado: exemploPronto(true) });
    await carregar();
    expect(
      screen.getByRole("heading", { level: 2, name: `Ativas no ${NUMERO} · quem atende: Nina` }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("As ligações em números")).toHaveTextContent("Ligações hoje4");
  });
});

/* ---------- o movimento ---------- */

describe("o movimento reduzido", () => {
  it("a raiz é marcada (o CSS desliga as animações) e os números já vêm no valor final", async () => {
    montar({ estado: exemploPronto(true) });
    await carregar();
    expect(document.querySelector("[data-area='ligacoes']")).toHaveAttribute(
      "data-movimento",
      "reduzido",
    );
    const numeros = screen.getByLabelText("As ligações em números");
    expect(within(numeros).getByText("Ligações hoje").nextElementSibling).toHaveTextContent("4");
  });

  it("as abas: o painel troca com a aba; sem a medida (o jsdom), a aba escolhida pinta sozinha", async () => {
    montar();
    await carregar();
    const lista = screen.getByRole("tablist", { name: "Partes das ligações" });
    expect(lista).not.toHaveAttribute("data-medido");
    await abrirAba("Agentes");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("data-painel", "agentes");
    expect(screen.getByRole("tab", { name: "Agentes" })).toHaveAttribute("aria-selected", "true");
  });
});

/* ---------- o topo ---------- */

describe("o topo", () => {
  it("antes de ativar, o admin vê o passo a passo (o cartão que saiu da Configuração)", async () => {
    montar({ estado: exemploPronto() });
    await carregar();
    const cartao = document.getElementById("lg-cartao")!;
    expect(cartao).toHaveAttribute("data-situacao", "pronta");
    expect(within(cartao).getByRole("button", { name: "Ativar ligações" })).toBeEnabled();
  });

  it("ativas: a situação em uma linha e os três números (hoje, minutos no mês, em andamento)", async () => {
    montar({ estado: exemploPronto(true) });
    await carregar();
    expect(document.getElementById("lg-cartao")).toBeNull();
    const topo = document.querySelector<HTMLElement>("[data-lg-topo='ativas']")!;
    expect(within(topo).getByRole("heading", { level: 2 })).toHaveTextContent(
      `Ativas no ${NUMERO} · quem atende: Nina`,
    );
    const numeros = within(topo).getByLabelText("As ligações em números");
    const valor = (rotulo: string) =>
      within(numeros).getByText(rotulo).nextElementSibling!.textContent;
    // 4 hoje (Juliana, Ricardo, Fernando e Carla); 174 + 245 + 192 + 4 s em novembro = 11 min; 1 em andamento
    expect(valor("Ligações hoje")).toBe("4");
    expect(valor("Minutos no mês")).toBe("11");
    expect(valor("Em andamento")).toBe("1");
  });

  it("verificar pelo topo: passa, ativa, e o topo vira a situação, e quem atende é o agente do exemplo", async () => {
    montar({ estado: exemploPronto() });
    await carregar();
    fireEvent.click(screen.getByRole("button", { name: "Ativar ligações" }));
    await carregar();
    expect(document.getElementById("lg-cartao")).toBeNull();
    expect(
      screen.getByRole("heading", { level: 2, name: `Ativas no ${NUMERO} · quem atende: Nina` }),
    ).toBeInTheDocument();
    expect(status()).toHaveTextContent(`Ligações ativadas. A Nina atende no ${NUMERO}.`);
  });
});

/* ---------- o Histórico ---------- */

describe("o Histórico", () => {
  it("lista as ligações da mais recente para a mais antiga, com o selo, a duração e o agente", async () => {
    montar();
    await carregar();
    expect(nomesNaLista()).toEqual([
      "Juliana Prado",
      "Ricardo Menezes",
      "Fernando Castro",
      "Carla Mendes",
      "Patrícia Nogueira",
      "Thiago Nunes",
      "Marcos Vieira",
      "Carlos Eduardo Lima",
    ]);
    const ricardo = linhas()[1]!;
    expect(ricardo).toHaveAccessibleName(
      "Ricardo Menezes, concluída, 14:35, 2 min 54 s, atendida por Nina",
    );
    expect(within(ricardo).getByText("Concluída")).toBeInTheDocument();
    expect(within(linhas()[0]!).getByText("Em andamento")).toBeInTheDocument();
    expect(within(linhas()[3]!).getByText("Passou para a equipe")).toBeInTheDocument();
    expect(within(linhas()[4]!).getByText("Suporte")).toBeInTheDocument();
    expect(within(linhas()[7]!).getByText("Vendas – retorno")).toBeInTheDocument();
  });

  it("a ligação de saída com objetivo mostra o objetivo da equipe antes do resumo", async () => {
    montar();
    await carregar();
    fireEvent.click(linhas()[7]!);
    await carregar();
    const detalhe = document.querySelector<HTMLElement>("[data-lg-detalhe]")!;
    const objetivo = within(detalhe).getByRole("heading", {
      level: 3,
      name: "Objetivo desta ligação",
    }).parentElement!;
    expect(objetivo).toHaveTextContent(
      "Retomar o orçamento das duas lojas e confirmar até quando ele vale.",
    );
    // sem objetivo, nada
    fireEvent.click(linhas()[1]!);
    await carregar();
    expect(document.querySelector("[data-lg-objetivo]")).toBeNull();
  });

  it("os filtros: passaram para a equipe e não completadas, com a contagem", async () => {
    montar();
    await carregar();
    const filtros = screen.getByRole("group", { name: "Filtrar as ligações" });
    fireEvent.click(within(filtros).getByRole("button", { name: /Passaram para a equipe/ }));
    expect(nomesNaLista()).toEqual(["Carla Mendes"]);
    fireEvent.click(within(filtros).getByRole("button", { name: /Não completadas/ }));
    expect(nomesNaLista()).toEqual(["Fernando Castro", "Thiago Nunes"]);
    fireEvent.click(within(filtros).getByRole("button", { name: /Todas/ }));
    expect(linhas()).toHaveLength(8);
  });

  it("a busca por nome (sem acento) e por número; sem resultado, o aviso e o Limpar", async () => {
    montar();
    await carregar();
    const busca = screen.getByRole("searchbox", { name: "Buscar por nome ou número" });
    fireEvent.change(busca, { target: { value: "patricia" } });
    expect(nomesNaLista()).toEqual(["Patrícia Nogueira"]);
    fireEvent.change(busca, { target: { value: "(11) 90000-0001" } });
    expect(nomesNaLista()).toEqual(["Ricardo Menezes"]);
    fireEvent.change(busca, { target: { value: "ninguém" } });
    expect(linhas()).toHaveLength(0);
    expect(screen.getByText("Nenhuma ligação com esse filtro.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Limpar filtro e busca" }));
    expect(linhas()).toHaveLength(8);
    expect(busca).toHaveValue("");
  });

  it("abrir uma ligação: o resumo, a transcrição com o tempo, quem atendeu, a duração e por que terminou", async () => {
    montar();
    await carregar();
    expect(
      screen.getByText("Escolha uma ligação para ver o resumo e a conversa."),
    ).toBeInTheDocument();
    fireEvent.click(linhas()[1]!);
    await carregar();
    const detalhe = document.querySelector<HTMLElement>("[data-lg-detalhe]")!;
    const titulo = within(detalhe).getByRole("heading", { level: 2, name: "Ricardo Menezes" });
    expect(document.activeElement).toBe(titulo);
    expect(linhas()[1]).toHaveAttribute("aria-current", "true");
    expect(detalhe).toHaveTextContent("Ricardo quer trocar as luminárias do mercado por LED");
    const fato = (rotulo: string) =>
      within(detalhe).getByText(rotulo, { selector: "dt" }).nextElementSibling!.textContent;
    expect(fato("Quem atendeu")).toBe("Nina");
    expect(fato("Duração")).toBe("2 min 54 s");
    expect(fato("Por que terminou")).toBe("O contato desligou");
    const falas = within(
      within(detalhe).getByRole("list", { name: "Falas da ligação" }),
    ).getAllByRole("listitem");
    expect(falas).toHaveLength(7);
    expect(falas[0]).toHaveTextContent("0:01NinaOi, Ricardo! Aqui é a Nina. Como posso te ajudar?");
    expect(falas[1]).toHaveTextContent("0:06Ricardo");
    expect(falas[6]).toHaveTextContent("2:48");
  });

  it("a ligação em andamento e a não completada dizem o que falta, sem inventar resumo", async () => {
    montar();
    await carregar();
    fireEvent.click(linhas()[0]!);
    await carregar();
    let detalhe = document.querySelector<HTMLElement>("[data-lg-detalhe]")!;
    expect(detalhe).toHaveTextContent("O resumo aparece aqui quando a ligação terminar.");
    expect(detalhe).toHaveTextContent("3 min até agora");
    fireEvent.click(linhas()[2]!);
    await carregar();
    detalhe = document.querySelector<HTMLElement>("[data-lg-detalhe]")!;
    expect(detalhe).toHaveTextContent("A ligação não se completou, então não há resumo.");
    expect(detalhe).toHaveTextContent("A ligação caiu antes de começar");
  });

  it('"Abrir conversa" leva ao Chat com a conversa do lead', async () => {
    const router = montar();
    await carregar();
    fireEvent.click(linhas()[1]!);
    await carregar();
    fireEvent.click(screen.getByRole("button", { name: "Abrir conversa" }));
    await carregar();
    expect(router.state.location.pathname).toBe("/app/chat");
    expect(router.state.location.search).toEqual({ conversa: idConversa("ricardo") });
    expect(screen.getByRole("heading", { name: "Chat aberto" })).toBeInTheDocument();
  });
});

/* ---------- os Agentes ---------- */

describe("os Agentes", () => {
  it("os cartões: quem atende tem o selo; o outro, o botão; e o aviso de atualização", async () => {
    montar();
    await abrirAba("Agentes");
    const nina = cartaoDoAgente("Nina");
    const suporte = cartaoDoAgente("Suporte");
    expect(nina).toHaveTextContent("Atende as ligações");
    expect(within(nina).queryByRole("button", { name: /Atender as ligações/ })).toBeNull();
    expect(
      within(suporte).getByRole("button", { name: "Atender as ligações com Suporte" }),
    ).toBeInTheDocument();
    expect(suporte).toHaveTextContent("Mais rápido");
    expect(suporte).toHaveTextContent("Suporte");
    // o uso (spec-ligar-com-agente, A1): o selo com a explicação para o leitor de tela; o Ativo não
    // tem o "Atender as ligações"
    const retorno = cartaoDoAgente("Vendas – retorno");
    expect(nina.querySelector("[data-selo-uso]")).toHaveTextContent(
      "Receptiva: recebe as ligações do número",
    );
    expect(suporte.querySelector("[data-selo-uso]")).toHaveTextContent("Receptiva");
    expect(retorno.querySelector("[data-selo-uso]")).toHaveTextContent("Ativa: faz ligações");
    expect(within(retorno).queryByRole("button", { name: /Atender as ligações/ })).toBeNull();
    expect(retorno).not.toHaveTextContent("Atende as ligações");
    expect(screen.getByText("Há uma atualização para os agentes")).toBeInTheDocument();
    expect(screen.getByText(TEXTO_ATUALIZACAO)).toBeInTheDocument();
  });

  it('"Atualizar" leva todos para a versão do código e o aviso some', async () => {
    montar();
    await abrirAba("Agentes");
    fireEvent.click(screen.getByRole("button", { name: "Atualizar" }));
    await carregar();
    expect(screen.queryByText("Há uma atualização para os agentes")).toBeNull();
    expect(status()).toHaveTextContent("Agentes atualizados.");
  });

  it("trocar quem atende é um clique; o topo acompanha", async () => {
    montar({ estado: exemploPronto(true) });
    await abrirAba("Agentes");
    const simbolo = (nome: string) =>
      cartaoDoAgente(nome).querySelector("[data-estado]")!.getAttribute("data-estado");
    // quem atende está acordada e falando; o outro, em repouso
    expect(simbolo("Nina")).toBe("fala");
    expect(simbolo("Suporte")).toBe("dormindo");
    fireEvent.click(screen.getByRole("button", { name: "Atender as ligações com Suporte" }));
    await carregar();
    expect(cartaoDoAgente("Suporte")).toHaveTextContent("Atende as ligações");
    expect(simbolo("Suporte")).toBe("fala");
    expect(simbolo("Nina")).toBe("dormindo");
    expect(
      within(cartaoDoAgente("Nina")).getByRole("button", { name: "Atender as ligações com Nina" }),
    ).toBeInTheDocument();
    expect(status()).toHaveTextContent("Agora Suporte atende as ligações.");
    expect(
      screen.getByRole("heading", { level: 2, name: `Ativas no ${NUMERO} · quem atende: Suporte` }),
    ).toBeInTheDocument();
  });

  it('"Novo agente" nasce com os padrões; sem nome não cria; com nome, vira um cartão', async () => {
    montar({ estado: exemploPronto() });
    await abrirAba("Agentes");
    fireEvent.click(screen.getByRole("button", { name: "Novo agente" }));
    await carregar();
    const dlg = screen.getByRole("dialog", { name: "Novo agente" });
    expect(within(dlg).getByRole("textbox", { name: "Nome" })).toHaveValue("");
    // já há quem atenda: o novo nasce Ativo, com a saudação de quem liga
    expect(within(dlg).getByRole("radio", { name: /^Ativa/ })).toBeChecked();
    expect(within(dlg).getByRole("radio", { name: /^Receptiva/ })).not.toBeChecked();
    expect(within(dlg).getByRole("textbox", { name: "Saudação" })).toHaveValue(SAUDACAO_LIGAR);
    // voltar para Receptiva volta a saudação-modelo; e de novo para Ativa
    fireEvent.click(within(dlg).getByRole("radio", { name: /^Receptiva/ }));
    expect(within(dlg).getByRole("textbox", { name: "Saudação" })).toHaveValue(SAUDACAO_PADRAO);
    fireEvent.click(within(dlg).getByRole("radio", { name: /^Ativa/ }));
    expect(within(dlg).getByRole("textbox", { name: "Saudação" })).toHaveValue(SAUDACAO_LIGAR);
    expect(within(dlg).getByRole("radio", { name: "Vendas" })).toBeChecked();
    expect(within(dlg).getByRole("radio", { name: /Igual à Nina de texto/ })).toBeChecked();
    expect(within(dlg).getByRole("radio", { name: /^Recomendado/ })).toBeChecked();
    expect(
      within(within(dlg).getByRole("group", { name: "Duração máxima" })).getByText("10"),
    ).toBeInTheDocument();
    expect(
      within(within(dlg).getByRole("group", { name: "Desligar no silêncio" })).getByText("25"),
    ).toBeInTheDocument();
    // a voz escolhida da Nina já vem marcada, da lista da conta
    expect(within(dlg).getByRole("radio", { name: /Voz de exemplo A/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // o perfil: três opções, cada uma com uma linha
    expect(within(dlg).getByRole("radio", { name: /^Mais rápido/ })).toHaveAccessibleDescription(
      "Responde com a menor demora. Bom para conversas curtas e diretas.",
    );
    expect(within(dlg).getByRole("link", { name: "Abrir o Contexto" })).toHaveAttribute(
      "href",
      "/app/contexto",
    );

    fireEvent.click(within(dlg).getByRole("button", { name: "Criar agente" }));
    await carregar();
    expect(within(dlg).getByText("Dê um nome ao agente.")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-agente]")).toHaveLength(3);

    fireEvent.change(within(dlg).getByRole("textbox", { name: "Nome" }), {
      target: { value: "Vendas" },
    });
    fireEvent.click(within(dlg).getByRole("radio", { name: /^Mais caprichado/ }));
    fireEvent.click(within(dlg).getByRole("radio", { name: /Voz de exemplo B/ }));
    fireEvent.click(
      within(dlg).getByRole("button", { name: "Aumentar a duração máxima em 1 minuto" }),
    );
    fireEvent.click(
      within(dlg).getByRole("button", { name: "Esperar 5 segundos a menos no silêncio" }),
    );
    fireEvent.click(within(dlg).getByRole("button", { name: "Criar agente" }));
    await carregar();
    expect(screen.queryByRole("dialog")).toBeNull();
    const novo = cartaoDoAgente("Vendas");
    expect(novo).toHaveTextContent("Mais caprichado");
    expect(novo).toHaveTextContent("Voz de exemplo B");
    expect(novo).toHaveTextContent("até 11 min");
    expect(novo.querySelector("[data-selo-uso]")).toHaveTextContent("Ativa");
    expect(within(novo).queryByRole("button", { name: /Atender as ligações/ })).toBeNull();
    expect(status()).toHaveTextContent("Agente Vendas criado.");
    // um agente novo já nasce na versão do código: o aviso de atualização continua só pelos antigos
    expect(screen.getByText("Há uma atualização para os agentes")).toBeInTheDocument();
  });

  it('"Para que serve": a saudação escrita pelo admin não muda; sem agente, o novo é Receptivo', async () => {
    montar({ estado: exemploPronto() });
    await abrirAba("Agentes");
    fireEvent.click(screen.getByRole("button", { name: "Novo agente" }));
    await carregar();
    let dlg = screen.getByRole("dialog", { name: "Novo agente" });
    const saudacao = within(dlg).getByRole("textbox", { name: "Saudação" });
    fireEvent.change(saudacao, {
      target: { value: "Olá, {nome}! Liguei para falar da sua visita." },
    });
    fireEvent.click(within(dlg).getByRole("radio", { name: /^Receptiva/ }));
    expect(saudacao).toHaveValue("Olá, {nome}! Liguei para falar da sua visita.");
    fireEvent.click(within(dlg).getByRole("button", { name: "Cancelar" }));
    await carregar();

    // nenhum agente: o primeiro atende o número, então é Receptivo, e a Ativa diz por que não
    cleanup();
    montar({ estado: { ...exemploPronto(), ligacaoAgentes: [], historicoLigacoes: [] } });
    await abrirAba("Agentes");
    fireEvent.click(screen.getByRole("button", { name: "Novo agente" }));
    await carregar();
    dlg = screen.getByRole("dialog", { name: "Novo agente" });
    expect(within(dlg).getByRole("radio", { name: /^Receptiva/ })).toBeChecked();
    const ativa = within(dlg).getByRole("radio", { name: /^Ativa/ });
    expect(ativa).toBeDisabled();
    expect(ativa).toHaveAccessibleDescription(
      /O primeiro agente atende as ligações do número, então ele é Receptivo\./,
    );
    expect(within(dlg).getByRole("textbox", { name: "Saudação" })).toHaveValue(SAUDACAO_PADRAO);
  });

  it("o agente que atende não vira Ativo: a opção fica desabilitada, com o motivo", async () => {
    montar({ estado: exemploPronto() });
    await abrirAba("Agentes");
    fireEvent.click(screen.getByRole("button", { name: "Editar Nina" }));
    await carregar();
    let dlg = screen.getByRole("dialog", { name: "Editar Nina" });
    expect(within(dlg).getByRole("radio", { name: /^Receptiva/ })).toBeChecked();
    expect(within(dlg).getByRole("radio", { name: /^Ativa/ })).toBeDisabled();
    expect(dlg).toHaveTextContent(
      "Este agente atende as ligações do número. Para ele ser Ativo, escolha outro para atender antes.",
    );
    fireEvent.click(within(dlg).getByRole("button", { name: "Cancelar" }));
    await carregar();
    // o Suporte não atende: pode virar Ativo, e a saudação dele (escrita) fica
    fireEvent.click(screen.getByRole("button", { name: "Editar Suporte" }));
    await carregar();
    dlg = screen.getByRole("dialog", { name: "Editar Suporte" });
    fireEvent.click(within(dlg).getByRole("radio", { name: /^Ativa/ }));
    expect(within(dlg).getByRole("textbox", { name: "Saudação" })).toHaveValue(
      "Oi, {nome}! Aqui é o suporte. Em que posso ajudar?",
    );
    fireEvent.click(within(dlg).getByRole("button", { name: "Salvar" }));
    await carregar();
    const suporte = cartaoDoAgente("Suporte");
    expect(suporte.querySelector("[data-selo-uso]")).toHaveTextContent("Ativa");
    expect(within(suporte).queryByRole("button", { name: /Atender as ligações/ })).toBeNull();
  });

  it("editar um agente: a saudação-modelo acompanha o uso; a escrita pelo admin, não", async () => {
    const base = exemploPronto();
    montar({
      estado: {
        ...base,
        ligacaoAgentes: base.ligacaoAgentes!.map((a) =>
          a.id === "ag-suporte" ? { ...a, saudacao: SAUDACAO_PADRAO } : a,
        ),
      },
    });
    await abrirAba("Agentes");
    fireEvent.click(screen.getByRole("button", { name: "Editar Suporte" }));
    await carregar();
    let dlg = screen.getByRole("dialog", { name: "Editar Suporte" });
    const saudacao = () => within(dlg).getByRole("textbox", { name: "Saudação" });
    fireEvent.click(within(dlg).getByRole("radio", { name: /^Ativa/ }));
    expect(saudacao()).toHaveValue(SAUDACAO_LIGAR);
    fireEvent.click(within(dlg).getByRole("radio", { name: /^Receptiva/ }));
    expect(saudacao()).toHaveValue(SAUDACAO_PADRAO);
    fireEvent.click(within(dlg).getByRole("radio", { name: /^Ativa/ }));
    fireEvent.click(within(dlg).getByRole("button", { name: "Salvar" }));
    await carregar();
    // salvo como Ativo, com a saudação de quem liga; ao voltar para Receptiva, volta a de quem atende
    fireEvent.click(screen.getByRole("button", { name: "Editar Suporte" }));
    await carregar();
    dlg = screen.getByRole("dialog", { name: "Editar Suporte" });
    expect(within(dlg).getByRole("radio", { name: /^Ativa/ })).toBeChecked();
    expect(saudacao()).toHaveValue(SAUDACAO_LIGAR);
    fireEvent.change(saudacao(), { target: { value: "Oi, {nome}! Falo do suporte." } });
    fireEvent.click(within(dlg).getByRole("radio", { name: /^Receptiva/ }));
    expect(saudacao()).toHaveValue("Oi, {nome}! Falo do suporte.");
    expect(saudacaoAoTrocarUso("", "ligar")).toBe("");
    expect(saudacaoAoTrocarUso(`  ${SAUDACAO_PADRAO} `, "ligar")).toBe(SAUDACAO_LIGAR);
  });

  it("editar: regras próprias pedem texto; salvar muda o cartão e foca nele", async () => {
    montar({ estado: exemploPronto() });
    await abrirAba("Agentes");
    fireEvent.click(screen.getByRole("button", { name: "Editar Nina" }));
    await carregar();
    const dlg = screen.getByRole("dialog", { name: "Editar Nina" });
    fireEvent.click(within(dlg).getByRole("radio", { name: /Regras próprias/ }));
    fireEvent.click(within(dlg).getByRole("button", { name: "Salvar" }));
    await carregar();
    expect(
      within(dlg).getByText(/Escreva quando o agente passa para a equipe/),
    ).toBeInTheDocument();
    fireEvent.change(
      within(dlg).getByRole("textbox", { name: "Quando este agente passa para a equipe" }),
      {
        target: { value: "Quando pedirem desconto." },
      },
    );
    fireEvent.change(within(dlg).getByRole("textbox", { name: "Nome" }), {
      target: { value: "Nina vendas" },
    });
    fireEvent.click(within(dlg).getByRole("radio", { name: "Suporte" }));
    fireEvent.click(within(dlg).getByRole("button", { name: "Salvar" }));
    await carregar();
    expect(screen.queryByRole("dialog")).toBeNull();
    const cartao = cartaoDoAgente("Nina vendas");
    expect(cartao).toHaveTextContent("Atende as ligações");
    expect(cartao.querySelector("[data-objetivo]")).toHaveTextContent("Objetivo: Suporte");
    expect(document.activeElement).toBe(within(cartao).getByRole("heading", { level: 3 }));
    expect(status()).toHaveTextContent("Agente salvo.");
  });

  it("apagar: o que atende não tem o botão; o outro pede confirmação e sai, e o histórico fica sem o nome", async () => {
    montar();
    await abrirAba("Agentes");
    fireEvent.click(screen.getByRole("button", { name: "Editar Nina" }));
    await carregar();
    let dlg = screen.getByRole("dialog", { name: "Editar Nina" });
    expect(within(dlg).queryByRole("button", { name: "Apagar agente" })).toBeNull();
    expect(dlg).toHaveTextContent(
      "Este agente atende as ligações: para apagar, escolha outro antes.",
    );
    fireEvent.click(within(dlg).getByRole("button", { name: "Cancelar" }));
    await carregar();

    fireEvent.click(screen.getByRole("button", { name: "Editar Suporte" }));
    await carregar();
    dlg = screen.getByRole("dialog", { name: "Editar Suporte" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Apagar agente" }));
    expect(within(dlg).getByText(/^Apagar o agente Suporte\?/)).toHaveTextContent(
      "Apagar o agente Suporte? As ligações dele continuam no histórico.",
    );
    // sem a chave da ElevenLabs, a lista de vozes diz onde conectar
    expect(dlg).toHaveTextContent("Falta a chave da ElevenLabs.");
    fireEvent.click(within(dlg).getByRole("button", { name: "Apagar" }));
    await carregar();
    expect(screen.queryByRole("heading", { level: 3, name: "Suporte" })).toBeNull();
    expect(status()).toHaveTextContent("Agente Suporte apagado.");

    await abrirAba("Histórico");
    fireEvent.click(linhas()[4]!);
    await carregar();
    const detalhe = document.querySelector<HTMLElement>("[data-lg-detalhe]")!;
    expect(
      within(detalhe).getByText("Quem atendeu", { selector: "dt" }).nextElementSibling,
    ).toHaveTextContent("Agente apagado");
  });
});

/* ---------- os Ajustes ---------- */

describe("os Ajustes", () => {
  it("o número, os limites com os padrões e, ativas, o cartão de desativar", async () => {
    montar({ estado: exemploPronto(true) });
    await abrirAba("Ajustes");
    const numero = screen.getByRole("region", { name: "Número" });
    expect(numero).toHaveTextContent(`A Nina atende as ligações no ${NUMERO}, desde 03/11/2026.`);
    const limites = screen.getByRole("region", { name: "Limites" });
    const valor = (rotulo: string) =>
      within(within(limites).getByRole("group", { name: rotulo })).getByText(/^\d/).textContent;
    expect(valor("Ligações ao mesmo tempo")).toBe(String(LIMITES_PADRAO.simultaneas));
    expect(valor("Ligações por dia")).toBe(String(LIMITES_PADRAO.porDia));
    expect(valor("Por contato em 24 horas")).toBe(String(LIMITES_PADRAO.porContato));
    const cartao = document.getElementById("lg-cartao")!;
    expect(cartao).toHaveTextContent("Desativar ligações");
    expect(within(cartao).getByRole("button", { name: "Desativar ligações" })).toBeInTheDocument();
  });

  it("mudar e salvar os limites; o mínimo trava o −", async () => {
    montar();
    await abrirAba("Ajustes");
    const limites = screen.getByRole("region", { name: "Limites" });
    fireEvent.click(
      within(limites).getByRole("button", { name: "Uma ligação ao mesmo tempo a mais" }),
    );
    fireEvent.click(within(limites).getByRole("button", { name: "Dez ligações por dia a mais" }));
    expect(within(limites).getByText("Mudanças ainda não salvas")).toBeInTheDocument();
    fireEvent.click(within(limites).getByRole("button", { name: "Salvar os limites" }));
    await carregar();
    expect(status()).toHaveTextContent("Limites salvos.");
    expect(within(limites).queryByText("Mudanças ainda não salvas")).toBeNull();
    expect(
      within(within(limites).getByRole("group", { name: "Ligações ao mesmo tempo" })).getByText(
        "3",
      ),
    ).toBeInTheDocument();
    expect(
      within(within(limites).getByRole("group", { name: "Ligações por dia" })).getByText("110"),
    ).toBeInTheDocument();

    const menos = within(limites).getByRole("button", {
      name: "Uma ligação ao mesmo tempo a menos",
    });
    fireEvent.click(menos);
    fireEvent.click(menos);
    expect(menos).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(menos);
    expect(
      within(within(limites).getByRole("group", { name: "Ligações ao mesmo tempo" })).getByText(
        "1",
      ),
    ).toBeInTheDocument();
  });

  it("sem ligações ativas, o número manda para o topo e não há cartão de desativar", async () => {
    montar();
    await abrirAba("Ajustes");
    expect(screen.getByRole("region", { name: "Número" })).toHaveTextContent(
      "Nenhum número com ligações ativas.",
    );
    expect(
      within(screen.getByRole("tabpanel")).queryByRole("button", { name: "Desativar ligações" }),
    ).toBeNull();
  });

  it("desativar com pendência: o topo avisa e leva aos Ajustes", async () => {
    montar({ estado: exemploPronto(true) });
    await abrirAba("Ajustes");
    fireEvent.click(screen.getByRole("checkbox", { name: "Simular falha na demo" }));
    fireEvent.click(screen.getByRole("button", { name: "Desativar ligações" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Desativar" }),
    );
    await carregar();
    const topo = document.querySelector<HTMLElement>("[data-lg-topo='pendencias']")!;
    expect(topo).toHaveTextContent("A desativação não terminou");
    await abrirAba("Histórico");
    fireEvent.click(within(topo).getByRole("button", { name: "Ver nos Ajustes" }));
    await carregar();
    expect(aba("Ajustes")).toHaveAttribute("aria-selected", "true");
    expect(document.getElementById("lg-cartao")).toHaveAttribute("data-situacao", "com_pendencias");
  });
});

/* ---------- as regras puras e o exemplo ---------- */

describe("as regras da área", () => {
  const admin = (e: EstadoBase) => e.membros.find((m) => m.papel === "admin")!.id;
  const atendente = (e: EstadoBase) => e.membros.find((m) => m.papel === "atendente")!.id;
  const fazer = (e: EstadoBase, acao: Parameters<typeof reduzir>[1]["acao"], quem = admin(e)) =>
    reduzir(e, { acao, euId: quem, agora: AGORA.toISOString() });

  it("só o admin muda os agentes e os limites", () => {
    const e = criarEstadoInicial(AGORA);
    expect(
      fazer(e, { tipo: "atenderAgenteLigacao", agenteId: "ag-suporte" }, atendente(e)).resultado,
    ).toEqual({
      ok: false,
      erro: "sem_permissao",
    });
    expect(
      fazer(e, { tipo: "salvarLimitesLigacoes", limites: LIMITES_PADRAO }, atendente(e)).resultado
        .ok,
    ).toBe(false);
  });

  it("um só atende; o que atende não é apagado; atualizar leva todos para a versão", () => {
    const e = criarEstadoInicial(AGORA);
    const trocado = fazer(e, { tipo: "atenderAgenteLigacao", agenteId: "ag-suporte" }).estado;
    expect(trocado.ligacaoAgentes!.filter((a) => a.atende).map((a) => a.id)).toEqual([
      "ag-suporte",
    ]);
    expect(
      fazer(trocado, { tipo: "apagarAgenteLigacao", agenteId: "ag-suporte" }).resultado,
    ).toEqual({
      ok: false,
      erro: "agente_que_atende",
    });
    const apagado = fazer(trocado, {
      tipo: "apagarAgenteLigacao",
      agenteId: ID_AGENTE_NINA,
    }).estado;
    expect(apagado.ligacaoAgentes!.map((a) => a.id)).toEqual(["ag-suporte", "ag-retorno"]);
    expect(apagado.historicoLigacoes!.some((l) => l.agenteId === ID_AGENTE_NINA)).toBe(false);
    const atualizado = fazer(e, {
      tipo: "atualizarAgentesLigacao",
      versao: VERSAO_AGENTE_EXEMPLO,
    }).estado;
    expect(atualizado.ligacaoAgentes!.every((a) => a.versaoConfig === VERSAO_AGENTE_EXEMPLO)).toBe(
      true,
    );
  });

  it("o uso (spec-ligar-com-agente, A1): só o Receptivo atende; o que atende fica Receptivo; o primeiro é Receptivo", () => {
    const e = criarEstadoInicial(AGORA);
    expect(fazer(e, { tipo: "atenderAgenteLigacao", agenteId: "ag-retorno" }).resultado).toEqual({
      ok: false,
      erro: "uso_do_agente",
    });
    const nina = e.ligacaoAgentes!.find((a) => a.id === ID_AGENTE_NINA)!;
    expect(nina.uso).toBe("receber");
    expect(
      fazer(e, {
        tipo: "salvarAgenteLigacao",
        agenteId: ID_AGENTE_NINA,
        campos: { ...nina, uso: "ligar" },
        versao: 2,
      }).resultado,
    ).toEqual({ ok: false, erro: "uso_do_agente" });
    const vazio = { ...e, ligacaoAgentes: [] };
    expect(
      fazer(vazio, {
        tipo: "criarAgenteLigacao",
        campos: { ...camposPadrao(null, "ligar"), nome: "Retorno" },
        versao: 2,
      }).resultado,
    ).toEqual({ ok: false, erro: "uso_do_agente" });
    expect(usoPadraoDoNovo([])).toBe("receber");
    expect(usoPadraoDoNovo([{ atende: false }, { atende: true }])).toBe("ligar");
    expect(camposPadrao(null, "ligar").saudacao).toBe(SAUDACAO_LIGAR);
  });

  it("o primeiro agente criado atende; a ativação sem agente cria o Nina", () => {
    const vazio = { ...exemploPronto(), ligacaoAgentes: [] };
    const criado = fazer(vazio, {
      tipo: "criarAgenteLigacao",
      campos: { ...camposPadrao(), nome: "Vendas" },
      versao: 2,
    });
    expect(criado.resultado).toMatchObject({ ok: true, id: "ag-1" });
    expect(criado.estado.ligacaoAgentes![0]).toMatchObject({
      nome: "Vendas",
      atende: true,
      versaoConfig: 2,
    });
    expect(
      fazer(vazio, { tipo: "criarAgenteLigacao", campos: camposPadrao(), versao: 2 }).resultado.ok,
    ).toBe(false);

    const ativado = fazer(vazio, { tipo: "trocarLigacoes", ativas: true }).estado;
    expect(ativado.ligacaoAgentes).toEqual([
      expect.objectContaining({
        id: ID_AGENTE_NINA,
        nome: "Nina",
        atende: true,
        vozId: "exemplo-voz-a",
        regrasEquipe: null,
      }),
    ]);
  });

  it("os limites ficam nas faixas; o +10 do por dia anda de 10 em 10", () => {
    const e = criarEstadoInicial(AGORA);
    const r = fazer(e, {
      tipo: "salvarLimitesLigacoes",
      limites: { simultaneas: 250, porDia: 0, porContato: 5 },
    });
    // o teto das simultâneas é 200 (envio nina_ligacoes_limite_simultaneas)
    expect(r.estado.limitesLigacoes).toEqual({ simultaneas: 200, porDia: 1, porContato: 5 });
    expect(mudarLimite({ simultaneas: 2, porDia: 1, porContato: 10 }, "porDia", 1).porDia).toBe(10);
    expect(
      mudarLimite({ simultaneas: 2, porDia: 10_000, porContato: 10 }, "porDia", 1).porDia,
    ).toBe(10_000);
  });

  it("filtrar, os números e o motivo do fim", () => {
    const l = (x: Partial<Ligacao>): Ligacao => ({
      id: "x",
      conversaId: "cv",
      agenteId: null,
      direcao: "entrada",
      status: "concluida",
      iniciadaEm: AGORA.toISOString(),
      encerradaEm: null,
      duracaoS: 60,
      motivoFim: null,
      resumo: null,
      transcricao: [],
      passouEquipe: false,
      contatoId: null,
      nome: "Ana Lúcia",
      telefone: "5511912345678",
      agenteNome: null,
      ...x,
    });
    const lista = [
      l({ id: "a" }),
      l({ id: "b", passouEquipe: true, nome: "Bruno" }),
      l({ id: "c", status: "nao_completada", nome: null }),
    ];
    expect(filtrarLigacoes(lista, "todas", "lucia").map((x) => x.id)).toEqual(["a"]);
    expect(filtrarLigacoes(lista, "equipe", "").map((x) => x.id)).toEqual(["b"]);
    expect(filtrarLigacoes(lista, "nao_completadas", "1234").map((x) => x.id)).toEqual(["c"]);
    // número com menos de 3 dígitos não busca por telefone
    expect(filtrarLigacoes(lista, "todas", "12")).toHaveLength(0);
    expect(numerosDasLigacoes(lista, AGORA.getTime())).toEqual({
      hoje: 3,
      minutosNoMes: 3,
      emAndamento: 0,
    });
    expect(
      textoMotivoFim({ motivoFim: "max_duration", status: "concluida", passouEquipe: false }),
    ).toBe("Chegou à duração máxima");
    expect(
      textoMotivoFim({ motivoFim: "qualquer", status: "concluida", passouEquipe: false }),
    ).toBe("A ligação terminou");
  });

  it("L38: a ligação 'em andamento' sem o pós-chamada vence depois de 30 min mais a folga", () => {
    const l = (x: Partial<Ligacao>): Ligacao => ({
      id: "x",
      conversaId: "cv",
      agenteId: null,
      direcao: "entrada",
      status: "em_andamento",
      iniciadaEm: AGORA.toISOString(),
      encerradaEm: null,
      duracaoS: null,
      motivoFim: null,
      resumo: null,
      transcricao: [],
      passouEquipe: false,
      contatoId: null,
      nome: "Ana Lúcia",
      telefone: "5511912345678",
      agenteNome: null,
      ...x,
    });
    const minAtras = (m: number) => new Date(AGORA.getTime() - m * 60_000).toISOString();
    const agora = AGORA.getTime();
    const longa = l({ id: "a", iniciadaEm: minAtras(20) });
    const perdida = l({ id: "b", iniciadaEm: minAtras(40) });
    expect(seloDaLigacao(longa, agora)).toBe("andamento");
    expect(seloDaLigacao(perdida, agora)).toBe("sem_resumo");
    expect(textoMotivoFim(longa, agora)).toBe("Ainda não terminou");
    expect(textoMotivoFim(perdida, agora)).toBe("O fim da ligação não chegou da ElevenLabs");
    expect(numerosDasLigacoes([longa, perdida], agora).emAndamento).toBe(1);
  });
});

/* ---------- o tour ---------- */

describe("o tour com a área nova", () => {
  it("a parada Ligações vem logo depois do Chat, com a fala de cada papel", () => {
    expect(PARADAS.map((p) => p.rotulo).slice(0, 3)).toEqual(["O menu", "Chat", "Ligações"]);
    const ligacoes = (papel: Papel) =>
      paradasDoTour(papel).find((p) => p.area === "ligacoes")!.texto;
    expect(ligacoes("admin")).toBe(
      "Também atendo ligações pelo WhatsApp. Aqui você ativa, escolhe quem atende e vê o resumo de cada ligação.",
    );
    expect(ligacoes("atendente")).toBe(
      "Também atendo ligações pelo WhatsApp. Aqui você vê o resumo e a conversa de cada ligação.",
    );
  });

  it("a parada da Configuração não cita mais o cartão Ligações", () => {
    const cfg = PARADAS.find((p) => p.area === "configuracao")!.texto;
    expect(cfg).not.toMatch(/Ligações|cartão/);
    expect(cfg).toBe("O WhatsApp, o cérebro e a chave que você escolheu ficam aqui.");
  });
});
