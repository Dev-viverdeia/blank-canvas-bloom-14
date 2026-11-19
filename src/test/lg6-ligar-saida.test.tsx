import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgenteParaLigar, EstadoPermissaoDeLigar } from "@/features/mensageria/ligacoes/tipos";
import { BotaoLigar } from "@/features/plataforma/chat/BotaoLigar";
import { Conversa } from "@/features/plataforma/chat/Conversa";
import {
  TEXTO_PEDIDO_LEAD,
  agentePadrao,
  linkWhatsApp,
  objetivoDoPedido,
  textoDoPainel,
  podeRepetir,
  textoFalhaSaida,
} from "@/features/plataforma/chat/ligar";
import { ProvedorDados } from "@/features/plataforma/dados/ProvedorDados";
import {
  ServidorSaidaContexto,
  agenteParaLigarDe,
  estadoPermissaoDe,
  limparDemoSaida,
  type ServidorSaida,
} from "@/features/plataforma/dados/ligarSaida";
import { criarClienteFalso } from "@/features/plataforma/dados/testes/clienteFalso";
import {
  criarEstadoInicial,
  idConversa,
  type ChaveIA,
  type EstadoBase,
} from "@/features/plataforma/exemplo";
import { ProvedorPapel } from "@/features/plataforma/papel";

// A tela da ligação de saída (seção 6): o botão "Ligar" da conversa, o
// painel em cada estado da permissão do lead e a camada de dados. No modo exemplo, sem rede.
// Ligar com um agente (A2 e A3): o "Como ligar", a lista de agentes
// (os Ativos primeiro, o indisponível desabilitado), o objetivo até 500 caracteres e o "Eu mesmo, pelo
// meu WhatsApp". O pedido que chega ao servidor é conferido no modo banco, com o servidor falso.

const navegar = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navegar,
}));

const AGORA = new Date("2026-11-17T15:00:00-03:00");
const LEAD = "Ricardo Menezes";

beforeEach(() => {
  limparDemoSaida();
});
afterEach(() => {
  cleanup();
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

/** O exemplo com as ligações ativas (ou não). */
function exemplo(ativas: boolean): EstadoBase {
  const base = criarEstadoInicial(new Date());
  return {
    ...base,
    conexao: { ...base.conexao!, gateway: "meta", oficial: true },
    chaves: [...base.chaves.filter((k) => k.finalidade !== "voz"), CHAVE_VOZ],
    configuracao: { ...base.configuracao, voz_id: "v1", voz_nome: "Voz" },
    ligacoes: ativas ? { ativadaEm: AGORA.toISOString() } : null,
  };
}

function montar(ativas = true, mudar: (e: EstadoBase) => EstadoBase = (e) => e) {
  const avisar = vi.fn();
  render(
    <ProvedorPapel inicial="atendente">
      <ProvedorDados exemplo={() => mudar(exemplo(ativas))} progredirEnvios={false}>
        <Conversa
          conversaId={idConversa("ricardo")}
          fichaAberta={false}
          onAlternarFicha={() => {}}
          avisar={avisar}
        />
      </ProvedorDados>
    </ProvedorPapel>,
  );
  return { avisar };
}

async function esperar() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

const botaoLigar = () => screen.getByRole("button", { name: `Ligar para ${LEAD}` });
const painel = () => document.querySelector<HTMLElement>("[data-lgr-painel]")!;

describe("O botão Ligar na conversa (exemplo)", () => {
  it("só aparece com as ligações ativas", () => {
    montar(false);
    expect(screen.queryByRole("button", { name: `Ligar para ${LEAD}` })).toBeNull();
  });

  it("o atendente também liga: pedir, aguardar o lead, ligar", async () => {
    const { avisar } = montar(true);
    // fechado, não lê nada; aberto, lê a permissão
    expect(painel()).toBeNull();
    fireEvent.click(botaoLigar());
    await esperar();
    expect(botaoLigar()).toHaveAttribute("aria-expanded", "true");
    expect(painel()).toHaveTextContent("O lead precisa autorizar a ligação");
    expect(painel()).toHaveTextContent(TEXTO_PEDIDO_LEAD);
    fireEvent.click(within(painel()).getByRole("button", { name: "Pedir para ligar" }));
    await esperar();
    expect(painel()).toHaveTextContent("Aguardando o lead autorizar");
    expect(within(painel()).queryByRole("button")).toBeNull();
    // Esc fecha e devolve o foco ao botão
    fireEvent.keyDown(document, { key: "Escape" });
    expect(painel()).toBeNull();
    expect(document.activeElement).toBe(botaoLigar());
    // reaberto: a demo responde que o lead permitiu por 7 dias
    fireEvent.click(botaoLigar());
    await esperar();
    expect(painel()).toHaveTextContent(`Ligar para ${LEAD}`);
    expect(painel()).toHaveTextContent("O lead permitiu ligações até");
    fireEvent.click(within(painel()).getByRole("button", { name: "Ligar agora" }));
    await esperar();
    expect(painel()).toBeNull();
    // o padrão é o primeiro agente Ativo pronto, e o aviso cita o agente
    expect(avisar).toHaveBeenCalledWith(
      `Vendas – retorno está ligando para ${LEAD}. A ligação aparece na conversa.`,
      undefined,
    );
  });
});

const agentesNaJanela = () =>
  Array.from(painel().querySelectorAll<HTMLElement>("[data-lgr-agente]"));
const radioDoAgente = (nome: string) =>
  within(painel()).getByRole("radio", { name: new RegExp(`^${nome}`) });

describe("Como ligar (exemplo)", () => {
  it("abre no Como ligar: os agentes com o selo, os Ativos primeiro, e o primeiro Ativo marcado", async () => {
    montar(true);
    fireEvent.click(botaoLigar());
    await esperar();
    expect(painel()).toHaveAttribute("role", "dialog");
    expect(painel()).toHaveAccessibleName(`Ligar para ${LEAD}`);
    const modo = within(painel()).getByRole("group", { name: "Como ligar" });
    const comAgente = within(modo).getByRole("radio", { name: "Com um agente" });
    expect(comAgente).toBeChecked();
    // o foco entra na janela, no modo marcado
    expect(document.activeElement).toBe(comAgente);
    expect(
      agentesNaJanela().map((a) => a.querySelector("[class*='lgrOpcaoNome']")!.textContent),
    ).toEqual(["Vendas – retorno", "Nina", "Suporte"]);
    expect(agentesNaJanela()[0]!.querySelector("[data-selo-uso]")).toHaveTextContent(
      "Ativa: faz ligações",
    );
    expect(agentesNaJanela()[1]!.querySelector("[data-selo-uso]")).toHaveTextContent(
      "Receptiva: recebe as ligações do número",
    );
    expect(radioDoAgente("Vendas – retorno")).toBeChecked();
    expect(
      within(painel()).getByRole("textbox", { name: "Objetivo desta ligação (opcional)" }),
    ).toHaveAttribute("placeholder", "Ex.: retomar o orçamento de ontem e combinar a visita");
  });

  it("o indisponível fica desabilitado, com o motivo; o desatualizado liga, com o aviso", async () => {
    montar(true, (e) => ({
      ...e,
      ligacaoAgentes: e.ligacaoAgentes!.map((a) =>
        a.id === "ag-retorno"
          ? { ...a, erroSincronia: "A ElevenLabs recusou." }
          : a.id === "ag-suporte"
            ? { ...a, semAgenteLa: true }
            : a,
      ),
    }));
    fireEvent.click(botaoLigar());
    await esperar();
    // a última atualização falhou: ele liga com a configuração anterior (não fica desabilitado)
    const retorno = radioDoAgente("Vendas – retorno");
    expect(retorno).toBeEnabled();
    expect(retorno).toBeChecked();
    expect(retorno).toHaveAccessibleDescription(
      "A última atualização falhou: ele liga com a configuração anterior. Atualize em Ligações → Agentes.",
    );
    const suporte = radioDoAgente("Suporte");
    expect(suporte).toBeDisabled();
    expect(suporte).toHaveAccessibleDescription("Ainda não está pronto na ElevenLabs.");
  });

  it("sem Ativo pronto, marca o Receptivo que atende", async () => {
    montar(true, (e) => ({
      ...e,
      ligacaoAgentes: e.ligacaoAgentes!.map((a) =>
        a.id === "ag-retorno" ? { ...a, semAgenteLa: true } : a,
      ),
    }));
    fireEvent.click(botaoLigar());
    await esperar();
    expect(radioDoAgente("Vendas – retorno")).toBeDisabled();
    expect(radioDoAgente("Nina")).toBeChecked();
  });

  it('"Eu mesmo, pelo meu WhatsApp": o link wa.me com os dígitos do lead, numa aba nova, sem o servidor', async () => {
    const { avisar } = montar(true);
    fireEvent.click(botaoLigar());
    await esperar();
    fireEvent.click(within(painel()).getByRole("radio", { name: "Eu mesmo, pelo meu WhatsApp" }));
    // o painel de permissão e os agentes saem: esta ligação não passa pela Nina
    expect(painel().querySelector("[data-lgr-agentes]")).toBeNull();
    expect(painel().querySelector("[data-lgr-permissao]")).toBeNull();
    const link = within(painel()).getByRole("link", { name: "Abrir o WhatsApp" });
    expect(link).toHaveAttribute("href", "https://wa.me/5511900000001");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    fireEvent.click(link);
    expect(painel()).toBeNull();
    expect(avisar).not.toHaveBeenCalled();
  });

  it('sem o telefone do lead, o "Eu mesmo" fica desabilitado, com o motivo', async () => {
    montar(true, (e) => ({
      ...e,
      contatos: e.contatos.map((c) => (c.nome === LEAD ? { ...c, telefone: null } : c)),
    }));
    fireEvent.click(botaoLigar());
    await esperar();
    const eu = within(painel()).getByRole("radio", { name: /^Eu mesmo, pelo meu WhatsApp/ });
    expect(eu).toBeDisabled();
    expect(eu).toHaveAccessibleDescription("Sem o telefone do lead");
    expect(within(painel()).queryByRole("link")).toBeNull();
  });
});

/* ---------- o pedido que chega ao servidor (modo banco, servidor falso) ---------- */

const PODE_LIGAR: EstadoPermissaoDeLigar = {
  permissao: "permanente",
  expiraEm: null,
  podeLigar: true,
  podePedir: false,
  dentroDaJanela: true,
  motivo: null,
  pedido: null,
  pedirDeNovoEm: null,
};

const AGENTES: AgenteParaLigar[] = [
  {
    id: "ag-n",
    nome: "Nina",
    uso: "receber",
    objetivo: "vendas",
    atende: true,
    indisponivel: null,
    desatualizado: false,
  },
  {
    id: "ag-x",
    nome: "Antigo",
    uso: "ligar",
    objetivo: "outro",
    atende: false,
    indisponivel: "nao_sincronizado",
    desatualizado: false,
  },
  {
    id: "ag-r",
    nome: "Retorno",
    uso: "ligar",
    objetivo: "vendas",
    atende: false,
    indisponivel: null,
    desatualizado: false,
  },
];

function servidorFalso(sobre: Partial<Record<keyof ServidorSaida, unknown>> = {}) {
  return {
    permissao: vi.fn(async () => ({ ok: true, estado: PODE_LIGAR })),
    pedir: vi.fn(async () => ({ ok: true, estado: PODE_LIGAR })),
    ligar: vi.fn(async () => ({ ok: true, ligacaoId: "lg-1" })),
    agentes: vi.fn(async () => ({ ok: true, agentes: AGENTES })),
    ...sobre,
  } as unknown as ServidorSaida & Record<keyof ServidorSaida, ReturnType<typeof vi.fn>>;
}

function montarBanco(servidor = servidorFalso(), telefone: string | null = "55 (11) 98888-7777") {
  const avisar = vi.fn();
  const f = criarClienteFalso({ uid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ProvedorDados fonte="banco" cliente={f.cliente}>
        <ServidorSaidaContexto.Provider value={servidor}>
          <BotaoLigar conversaId="cv-1" nome="Juliana" telefone={telefone} aoAvisar={avisar} />
        </ServidorSaidaContexto.Provider>
      </ProvedorDados>
    </QueryClientProvider>,
  );
  return { servidor, avisar };
}

const objetivoCampo = () =>
  within(painel()).getByRole("textbox", { name: "Objetivo desta ligação (opcional)" });
const ligarAgora = () => within(painel()).getByRole("button", { name: "Ligar agora" });

describe("Ligar com um agente (banco)", () => {
  it("lê os agentes ao abrir, ordena os Ativos primeiro e liga com o agente escolhido e o objetivo aparado", async () => {
    const { servidor, avisar } = montarBanco();
    expect(servidor.agentes).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Ligar para Juliana" }));
    await esperar();
    expect(servidor.agentes).toHaveBeenCalledTimes(1);
    expect(
      agentesNaJanela().map((a) => a.querySelector("[class*='lgrOpcaoNome']")!.textContent),
    ).toEqual(["Antigo", "Retorno", "Nina"]);
    expect(radioDoAgente("Antigo")).toBeDisabled();
    expect(radioDoAgente("Retorno")).toBeChecked();
    fireEvent.click(radioDoAgente("Nina"));
    fireEvent.change(objetivoCampo(), { target: { value: "  Retomar o orçamento de ontem.  " } });
    expect(painel()).toHaveTextContent("29/500");
    fireEvent.click(ligarAgora());
    await esperar();
    expect(servidor.ligar).toHaveBeenCalledWith("cv-1", {
      agenteId: "ag-n",
      objetivo: "Retomar o orçamento de ontem.",
    });
    expect(painel()).toBeNull();
    expect(avisar).toHaveBeenCalledWith(
      "Nina está ligando para Juliana. A ligação aparece na conversa.",
    );
  });

  it("sem objetivo, o pedido vai sem ele", async () => {
    const { servidor } = montarBanco();
    fireEvent.click(screen.getByRole("button", { name: "Ligar para Juliana" }));
    await esperar();
    fireEvent.change(objetivoCampo(), { target: { value: "   " } });
    fireEvent.click(ligarAgora());
    await esperar();
    expect(servidor.ligar).toHaveBeenCalledWith("cv-1", { agenteId: "ag-r", objetivo: undefined });
  });

  it("passou de 500 caracteres: o Ligar fica desabilitado e o campo avisa", async () => {
    const { servidor } = montarBanco();
    fireEvent.click(screen.getByRole("button", { name: "Ligar para Juliana" }));
    await esperar();
    fireEvent.change(objetivoCampo(), { target: { value: "a".repeat(500) } });
    expect(ligarAgora()).toBeEnabled();
    expect(objetivoCampo()).not.toHaveAttribute("aria-invalid");
    fireEvent.change(objetivoCampo(), { target: { value: "a".repeat(501) } });
    expect(ligarAgora()).toBeDisabled();
    expect(objetivoCampo()).toHaveAttribute("aria-invalid", "true");
    expect(objetivoCampo()).toHaveAccessibleDescription(
      "O objetivo tem 501 caracteres; o limite é 500. Encurte para ligar.",
    );
    fireEvent.click(ligarAgora());
    await esperar();
    expect(servidor.ligar).not.toHaveBeenCalled();
  });

  it("a recusa do servidor (agente indisponível) mostra a mensagem e a janela fica aberta", async () => {
    const mensagem = "Este agente não está pronto para ligar. Escolha outro agente.";
    const { avisar } = montarBanco(
      servidorFalso({
        ligar: vi.fn(async () => ({ ok: false, erro: "agente_indisponivel", mensagem })),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Ligar para Juliana" }));
    await esperar();
    fireEvent.click(ligarAgora());
    await esperar();
    expect(within(painel()).getByRole("alert")).toHaveTextContent(mensagem);
    expect(avisar).not.toHaveBeenCalled();
  });

  it("sem agente pronto, o Ligar fica desabilitado e a janela diz por quê", async () => {
    montarBanco(
      servidorFalso({
        agentes: vi.fn(async () => ({
          ok: true,
          agentes: [{ ...AGENTES[0]!, indisponivel: "nao_sincronizado" }],
        })),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Ligar para Juliana" }));
    await esperar();
    expect(ligarAgora()).toBeDisabled();
    expect(painel()).toHaveTextContent("Nenhum agente está pronto para ligar agora.");
  });

  it("a falha ao ler os agentes oferece Tentar de novo", async () => {
    const agentes = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        erro: "erro_ao_ler",
        mensagem: "Não deu para ler os agentes.",
      })
      .mockResolvedValueOnce({ ok: true, agentes: AGENTES });
    montarBanco(servidorFalso({ agentes }));
    fireEvent.click(screen.getByRole("button", { name: "Ligar para Juliana" }));
    await esperar();
    const grupo = painel().querySelector<HTMLElement>("[data-lgr-agentes]")!;
    expect(grupo).toHaveTextContent("Não deu para ler os agentes.");
    fireEvent.click(within(grupo).getByRole("button", { name: "Tentar de novo" }));
    await esperar();
    expect(radioDoAgente("Retorno")).toBeChecked();
  });

  it("o contador e o limite contam o objetivo aparado, como o servidor", async () => {
    const { servidor } = montarBanco();
    fireEvent.click(screen.getByRole("button", { name: "Ligar para Juliana" }));
    await esperar();
    // 500 caracteres com uma quebra de linha e espaços nas pontas não bloqueiam
    fireEvent.change(objetivoCampo(), { target: { value: `  ${"a".repeat(500)}\n` } });
    expect(painel()).toHaveTextContent("500/500");
    expect(objetivoCampo()).not.toHaveAttribute("aria-invalid");
    expect(ligarAgora()).toBeEnabled();
    fireEvent.click(ligarAgora());
    await esperar();
    expect(servidor.ligar).toHaveBeenCalledWith("cv-1", {
      agenteId: "ag-r",
      objetivo: "a".repeat(500),
    });
  });

  it("o agente marcado que fica indisponível ao reler não é trocado: o Ligar fica desabilitado, com o aviso", async () => {
    const agentes = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, agentes: AGENTES })
      .mockResolvedValueOnce({
        ok: true,
        agentes: AGENTES.map((a) =>
          a.id === "ag-n" ? { ...a, indisponivel: "nao_sincronizado" } : a,
        ),
      });
    montarBanco(servidorFalso({ agentes }));
    const ligar = () => screen.getByRole("button", { name: "Ligar para Juliana" });
    fireEvent.click(ligar());
    await esperar();
    fireEvent.click(radioDoAgente("Nina"));
    // fecha e abre de novo: relê, e a Nina deixou de estar pronta
    fireEvent.click(ligar());
    fireEvent.click(ligar());
    await esperar();
    expect(agentes).toHaveBeenCalledTimes(2);
    const nina = radioDoAgente("Nina");
    expect(nina).toBeChecked();
    expect(nina).toBeDisabled();
    // o Retorno (o padrão) não é marcado sozinho
    expect(radioDoAgente("Retorno")).not.toBeChecked();
    expect(ligarAgora()).toBeDisabled();
    expect(painel()).toHaveTextContent(
      "O agente escolhido não está mais disponível. Escolha outro.",
    );
    // escolher outro libera o Ligar
    fireEvent.click(radioDoAgente("Retorno"));
    expect(ligarAgora()).toBeEnabled();
    expect(painel().querySelector("[data-lgr-saiu]")).toBeNull();
  });

  it("o marcado que some da lista: nenhum fica marcado e a janela pede outro", async () => {
    const agentes = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, agentes: AGENTES })
      .mockResolvedValueOnce({ ok: true, agentes: AGENTES.filter((a) => a.id !== "ag-r") });
    montarBanco(servidorFalso({ agentes }));
    const ligar = () => screen.getByRole("button", { name: "Ligar para Juliana" });
    fireEvent.click(ligar());
    await esperar();
    expect(radioDoAgente("Retorno")).toBeChecked();
    fireEvent.click(ligar());
    fireEvent.click(ligar());
    await esperar();
    expect(radioDoAgente("Nina")).not.toBeChecked();
    expect(ligarAgora()).toBeDisabled();
    expect(painel()).toHaveTextContent("O agente escolhido não está mais disponível.");
  });

  it("a recusa agente_indisponivel relê a lista e não troca o agente", async () => {
    const agentes = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, agentes: AGENTES })
      .mockResolvedValueOnce({
        ok: true,
        agentes: AGENTES.map((a) =>
          a.id === "ag-r" ? { ...a, indisponivel: "nao_sincronizado" } : a,
        ),
      });
    const mensagem = "Este agente não está pronto para ligar. Escolha outro agente.";
    const { servidor, avisar } = montarBanco(
      servidorFalso({
        agentes,
        ligar: vi.fn(async () => ({ ok: false, erro: "agente_indisponivel", mensagem })),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Ligar para Juliana" }));
    await esperar();
    fireEvent.click(ligarAgora());
    await esperar();
    expect(servidor.ligar).toHaveBeenCalledTimes(1);
    expect(agentes).toHaveBeenCalledTimes(2);
    expect(radioDoAgente("Retorno")).toBeDisabled();
    expect(radioDoAgente("Retorno")).toHaveAccessibleDescription(
      "Ainda não está pronto na ElevenLabs.",
    );
    expect(radioDoAgente("Nina")).not.toBeChecked();
    expect(ligarAgora()).toBeDisabled();
    expect(painel()).toHaveTextContent(mensagem);
    expect(avisar).not.toHaveBeenCalled();
    // escolher outro agente tira a recusa do anterior da tela (Opus, PR #26)
    fireEvent.click(radioDoAgente("Nina"));
    expect(painel()).not.toHaveTextContent(mensagem);
    expect(ligarAgora()).toBeEnabled();
  });

  it("trocar de agente não apaga a falha que não é do agente (a ligação que pode ter saído; Opus, PR #26)", async () => {
    const mensagem = "A ElevenLabs não confirmou a ligação a tempo, e ela pode ter saído.";
    montarBanco(
      servidorFalso({
        ligar: vi.fn(async () => ({ ok: false, erro: "tempo_esgotado", mensagem })),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Ligar para Juliana" }));
    await esperar();
    fireEvent.click(ligarAgora());
    await esperar();
    expect(painel()).toHaveTextContent(mensagem);
    fireEvent.click(radioDoAgente("Nina"));
    expect(painel()).toHaveTextContent(mensagem);
  });

  it('"Abrir o WhatsApp" fecha a janela e devolve o foco ao botão Ligar', async () => {
    montarBanco();
    const ligar = screen.getByRole("button", { name: "Ligar para Juliana" });
    fireEvent.click(ligar);
    await esperar();
    fireEvent.click(within(painel()).getByRole("radio", { name: "Eu mesmo, pelo meu WhatsApp" }));
    fireEvent.click(within(painel()).getByRole("link", { name: "Abrir o WhatsApp" }));
    expect(painel()).toBeNull();
    expect(document.activeElement).toBe(ligar);
  });

  it('"Eu mesmo" usa só os dígitos do telefone e não chama o servidor', async () => {
    const { servidor } = montarBanco();
    fireEvent.click(screen.getByRole("button", { name: "Ligar para Juliana" }));
    await esperar();
    fireEvent.click(within(painel()).getByRole("radio", { name: "Eu mesmo, pelo meu WhatsApp" }));
    expect(within(painel()).getByRole("link", { name: "Abrir o WhatsApp" })).toHaveAttribute(
      "href",
      "https://wa.me/5511988887777",
    );
    expect(servidor.ligar).not.toHaveBeenCalled();
  });
});

function estado(extra: Partial<EstadoPermissaoDeLigar> = {}): EstadoPermissaoDeLigar {
  return {
    permissao: "nenhuma",
    expiraEm: null,
    podeLigar: false,
    podePedir: false,
    dentroDaJanela: false,
    motivo: null,
    pedido: null,
    pedirDeNovoEm: null,
    ...extra,
  };
}

describe("Os textos do painel", () => {
  it("cada motivo diz a regra e, quando há, quando dá de novo", () => {
    const agora = new Date("2026-11-17T15:00:00-03:00");
    const amanha = "2026-11-18T17:00:00.000Z";
    expect(
      textoDoPainel(estado({ podeLigar: true, permissao: "permanente" }), LEAD, agora),
    ).toMatchObject({
      acao: "ligar",
      detalhe: "O lead permitiu ligações sem prazo.",
    });
    expect(textoDoPainel(estado({ motivo: "pedir", podePedir: true }), LEAD, agora).acao).toBe(
      "pedir",
    );
    expect(
      textoDoPainel(estado({ motivo: "recusou", pedirDeNovoEm: amanha }), LEAD, agora),
    ).toMatchObject({
      acao: null,
      titulo: "O lead não permitiu ligações",
      detalhe: "Dá para pedir de novo 18/11, às 14:00.",
    });
    expect(textoDoPainel(estado({ motivo: "fora_da_janela" }), LEAD, agora).texto).toContain(
      "24 h depois da última mensagem do lead",
    );
    expect(textoDoPainel(estado({ motivo: "limite_de_pedidos" }), LEAD, agora).texto).toContain(
      "1 vez por dia e 2 vezes por semana",
    );
    expect(textoDoPainel(estado({ motivo: "ligacao_em_andamento" }), LEAD, agora).acao).toBeNull();
    expect(textoFalhaSaida({ erro: "x", mensagem: "Frase do servidor." })).toBe(
      "Frase do servidor.",
    );
    // a ElevenLabs não confirmou a tempo: a ligação pode ter saído, então nada de "Ligar agora" de novo
    expect(podeRepetir({ erro: "tempo_esgotado" })).toBe(false);
    expect(podeRepetir({ erro: "provedor_fora" })).toBe(true);
    expect(podeRepetir(null)).toBe(true);
  });
});

describe("As regras puras do Como ligar", () => {
  it("o agente padrão, o link do WhatsApp e o objetivo do pedido", () => {
    expect(agentePadrao(AGENTES)).toBe("ag-r");
    expect(agentePadrao([AGENTES[0]!, AGENTES[1]!])).toBe("ag-n");
    expect(agentePadrao([AGENTES[1]!])).toBeNull();
    // o Ativo pronto sem aviso vem antes do desatualizado, mesmo depois dele na lista (Opus, PR #26)
    const desatualizado = { ...AGENTES[2]!, id: "ag-d", nome: "Agenda", desatualizado: true };
    expect(agentePadrao([desatualizado, AGENTES[2]!])).toBe("ag-r");
    expect(agentePadrao([desatualizado, AGENTES[0]!])).toBe("ag-d");
    expect(linkWhatsApp("+55 (11) 98888-7777")).toBe("https://wa.me/5511988887777");
    expect(linkWhatsApp(null)).toBeNull();
    expect(linkWhatsApp("")).toBeNull();
    // só o internacional (E.164): curto, zerado ou longo demais não vira link (Sol, PR #26)
    expect(linkWhatsApp("123")).toBeNull();
    expect(linkWhatsApp("011988887777")).toBeNull();
    expect(linkWhatsApp("1".repeat(16))).toBeNull();
    expect(linkWhatsApp("BR.AbCdEf123")).toBeNull();
    expect(objetivoDoPedido("  x  ")).toBe("x");
    expect(objetivoDoPedido("   ")).toBeUndefined();
  });
});

describe("A camada de dados da saída", () => {
  it("confere cada agente da janela campo a campo", () => {
    expect(agenteParaLigarDe({ id: "a", nome: "A", uso: "outro" })).toBeNull();
    expect(
      agenteParaLigarDe({ id: "a", nome: "A", uso: "ligar", indisponivel: "novo_motivo" }),
    ).toEqual({
      id: "a",
      nome: "A",
      uso: "ligar",
      objetivo: "outro",
      atende: false,
      // um motivo desconhecido deixa o agente de fora (na dúvida, não liga)
      indisponivel: "nao_sincronizado",
      desatualizado: false,
    });
    expect(
      agenteParaLigarDe({
        id: "b",
        nome: "B",
        uso: "receber",
        indisponivel: null,
        desatualizado: true,
      }),
    ).toMatchObject({ indisponivel: null, desatualizado: true });
  });

  it("confere o estado campo a campo", () => {
    expect(estadoPermissaoDe({ permissao: "outra" })).toBeNull();
    expect(
      estadoPermissaoDe({
        permissao: "temporaria",
        expiraEm: "2026-11-24T12:00:00.000Z",
        podeLigar: true,
        podePedir: "sim",
        dentroDaJanela: true,
        motivo: "inventado",
        pedido: { pedidoEm: "2026-11-17T12:00:00.000Z", resposta: "aceitou", permanente: false },
        pedirDeNovoEm: null,
        segredo: "x",
      }),
    ).toEqual({
      permissao: "temporaria",
      expiraEm: "2026-11-24T12:00:00.000Z",
      podeLigar: true,
      podePedir: false,
      dentroDaJanela: true,
      motivo: null,
      pedido: {
        pedidoEm: "2026-11-17T12:00:00.000Z",
        resposta: "aceitou",
        permanente: false,
        respondidoEm: null,
      },
      pedirDeNovoEm: null,
    });
  });
});
