import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DONO_ITEM_ELEGIBILIDADE,
  ITENS_ELEGIBILIDADE,
  type Elegibilidade,
  type EstadoItemElegibilidade,
  type EstadoLigacoes,
  type IdItemElegibilidade,
  type PendenciaLigacoes,
} from "@/features/mensageria/ligacoes/tipos";
import { TelaConfiguracao } from "@/features/plataforma/configuracao";
import { TEXTO_LINHA_LIGACOES } from "@/features/plataforma/configuracao/LinhaLigacoes";
import { TelaLigacoes } from "@/features/plataforma/ligacoes";
import {
  DICA_TESTE_LIGACAO,
  LEITURA_FALHOU,
  PASSOS_ATIVACAO,
  TEXTO_ELEVEN_MANUAL,
  avisoPendencias,
  TEXTO_META_MANUAL,
} from "@/features/plataforma/ligacoes/Ativacao";
import {
  ServidorConfiguracaoContexto,
  criarAcoesConfiguracaoBanco,
  elegibilidadeDe,
  estadoLigacoesExemplo,
  type ServidorConfiguracao,
} from "@/features/plataforma/dados/configuracao";
import { CHAVES } from "@/features/plataforma/dados/chaves";
import { ProvedorDados } from "@/features/plataforma/dados/ProvedorDados";
import { criarClienteFalso, type Consulta } from "@/features/plataforma/dados/testes/clienteFalso";
import {
  criarEstadoInicial,
  useExemplo,
  type ChaveIA,
  type EstadoBase,
} from "@/features/plataforma/exemplo";
import { reduzir } from "@/features/plataforma/exemplo/reducer";
import {
  BLOCO_LIMITE,
  LINK_VERIFICACAO_META,
  APOIO_CONFIGURAR_META_OK,
  DICA_SEM_META,
  RESUMO_SEM_META,
  TEXTOS_ITEM,
  TEXTO_FASE,
  TITULO_SEM_META,
  detalheOk,
  podeVerificar,
  textoFalta,
  TEXTO_NUMERO_PAUSADO,
  faseDoCartao,
  itensDoCartao,
  limiteLegivel,
  tituloLimite,
} from "@/features/plataforma/ligacoes/verificacao";
import { ProvedorPapel } from "@/features/plataforma/papel";

// Task T da spec das ligações (2.6 e 2.7): o cartão das ligações em cada
// situação, no modo exemplo (tudo simulado, sem rede) e no banco (as funções de servidor trocadas por
// falsas pelo ServidorConfiguracaoContexto), os botões e o diálogo; e a camada de dados das três
// funções. Desda spec-ligacoes-tela, o cartão mora na área Ligações: antes de ativar, no topo; ativas
// ou com pendências, na aba Ajustes. Os testes abrem os Ajustes, e o cartão está sempre na tela.

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

/** Espera as leituras e abre a aba Ajustes (o cartão fica no topo ou nos Ajustes: assim, sempre na tela). */
async function carregar() {
  for (let i = 0; i < 6; i++) await andar(5);
  const ajustes = screen.queryByRole("tab", { name: "Ajustes" });
  if (ajustes && ajustes.getAttribute("aria-selected") !== "true") {
    fireEvent.click(ajustes);
    await andar(5);
  }
}

const cartao = () => document.getElementById("lg-cartao")!;
const botao = (nome: string | RegExp, dentro: HTMLElement = document.body) =>
  within(dentro).getByRole("button", { name: nome });
const titulo = () => within(cartao()).getByRole("heading", { level: 2 });
/** A gaveta da verificação (spec-ligacoes, seção 21): vai para o body por portal. */
const gaveta = () => document.querySelector<HTMLElement>("[data-lg-gaveta='verificacao']")!;
/** O item da verificação, pelo id do contrato: só na gaveta (o cartão mostra um resumo). */
const item = (id: string) => gaveta().querySelector(`[data-item="${id}"]`)!;
const VERIFICAR = "Verificar meu número";
const ATIVAR = "Ativar ligações";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AGORA);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/* ---------- modo exemplo ---------- */

/** A chave da ElevenLabs da voz, ativa (os 4 últimos inventados). */
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

/** O exemplo com tudo pronto para ligar: a conexão da Meta, a chave da voz e a voz escolhida. */
function exemploPronto(
  base: EstadoBase = criarEstadoInicial(AGORA),
  sem: "voz_id" | null = null,
): EstadoBase {
  return {
    ...base,
    conexao: { ...base.conexao!, gateway: "meta", oficial: true, nome: NUMERO },
    chaves: [...base.chaves.filter((k) => k.finalidade !== "voz"), CHAVE_VOZ],
    configuracao: {
      ...base.configuracao,
      voz_id: sem === "voz_id" ? null : "v1",
      voz_nome: sem === "voz_id" ? null : "Voz de teste",
    },
  };
}

/** Escolhe a voz de fora do cartão (como o fluxo "vozes" faria). */
function EscolherVoz() {
  const { acoes } = useExemplo();
  return (
    <button type="button" onClick={() => acoes.escolherVoz({ id: "v1", nome: "Voz de teste" })}>
      escolher voz de fora
    </button>
  );
}

function montarExemplo(estado: EstadoBase = criarEstadoInicial(AGORA)) {
  return render(
    <ProvedorPapel inicial="admin">
      <ProvedorDados exemplo={estado} progredirEnvios={false} relogio={() => new Date(AGORA)}>
        <TelaLigacoes />
        <EscolherVoz />
      </ProvedorDados>
    </ProvedorPapel>,
  );
}

describe("Cartão Ligações no modo exemplo", () => {
  it("o exemplo padrão (Z-API): no topo da área, um resumo curto que manda para a Configuração", async () => {
    montarExemplo();
    await carregar();
    const c = cartao();
    // no topo da área, antes das abas
    expect(
      c.compareDocumentPosition(screen.getByRole("tablist")) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(c).toHaveTextContent("Ligações pelo WhatsApp");
    expect(titulo()).toHaveTextContent(TITULO_SEM_META);
    expect(c).toHaveTextContent(RESUMO_SEM_META);
    expect(within(c).getByRole("link", { name: "Abrir a Configuração" })).toBeInTheDocument();
    // sem a conexão da Meta não há número para verificar, e a lista não fica no cartão
    expect(within(c).queryByRole("button", { name: VERIFICAR })).toBeNull();
    expect(within(c).queryByRole("button", { name: ATIVAR })).toBeNull();
    expect(c.querySelector("[data-item]")).toBeNull();
  });

  it("na Configuração, o cartão virou uma linha com o atalho, fora do fio da Saúde", async () => {
    render(
      <ProvedorPapel inicial="admin">
        <ProvedorDados
          exemplo={exemploPronto()}
          progredirEnvios={false}
          relogio={() => new Date(AGORA)}
        >
          <TelaConfiguracao />
        </ProvedorDados>
      </ProvedorPapel>,
    );
    for (let i = 0; i < 6; i++) await andar(5);
    expect(screen.getByTestId("cfg-saude").textContent).not.toMatch(/Liga/);
    expect(document.getElementById("lg-cartao")).toBeNull();
    const linha = document.getElementById("cfg-linha-ligacoes")!;
    expect(linha).toHaveTextContent(TEXTO_LINHA_LIGACOES);
    expect(within(linha).getByRole("link", { name: "Abrir Ligações" })).toHaveAttribute(
      "href",
      "/app/ligacoes",
    );
    // no lugar do cartão: depois da Voz e antes do Ritmo
    const voz = document.getElementById("cfg-card-voz")!;
    expect(voz.compareDocumentPosition(linha) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      linha.compareDocumentPosition(document.getElementById("cfg-card-ritmo")!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("um requisito que muda fora do cartão: ele relê e a fase muda", async () => {
    montarExemplo(exemploPronto(undefined, "voz_id"));
    await carregar();
    expect(titulo()).toHaveTextContent(TEXTO_FASE.configurar.titulo);
    expect(cartao()).toHaveTextContent("Falta na Nina: voz escolhida.");
    // com a conexão da Meta, já dá para verificar o número
    expect(botao(VERIFICAR, cartao())).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "escolher voz de fora" }));
    await carregar();
    expect(titulo()).toHaveTextContent(TEXTO_FASE.verificar.tituloCartao!);
    expect(botao(ATIVAR, cartao())).toBeEnabled();
  });

  it("falta a voz e o número tem 250: a gaveta mostra o bloqueio da Meta primeiro, e a voz na lista", async () => {
    montarExemplo(exemploPronto(undefined, "voz_id"));
    await carregar();
    fireEvent.click(
      within(cartao()).getByRole("checkbox", { name: "Simular limite de 250 na demo" }),
    );
    fireEvent.click(botao(VERIFICAR, cartao()));
    await carregar();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(titulo()).toHaveTextContent(TEXTO_FASE.bloqueada_meta.titulo);
    expect(item("meta_limite")).toHaveAttribute("data-estado", "falta");
    expect(item("voz")).toHaveAttribute("data-estado", "falta");
    expect(
      within(gaveta()).getByRole("link", { name: "Abrir a Configuração" }),
    ).toBeInTheDocument();
  });

  it("falta a voz e a Meta libera: a gaveta e o cartão dizem que só falta a Nina", async () => {
    montarExemplo(exemploPronto(undefined, "voz_id"));
    await carregar();
    fireEvent.click(botao(VERIFICAR, cartao()));
    await carregar();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(gaveta()).toHaveTextContent(APOIO_CONFIGURAR_META_OK);
    expect(item("meta_limite")).toHaveAttribute("data-estado", "ok");
    expect(titulo()).toHaveTextContent(TEXTO_FASE.configurar.titulo);
    expect(cartao()).toHaveTextContent("A Meta já libera ligações no seu número.");
    expect(cartao().getAttribute("data-situacao")).not.toBe("ativa");
    expect(botao("Verificar de novo", cartao())).toBeEnabled();
  });

  it("Ativar: verifica, passa e já ativa no número, desde hoje, com a dica de teste e o aviso", async () => {
    montarExemplo(exemploPronto());
    await carregar();
    // antes de ativar, o cartão é curto: nada da lista
    expect(cartao().querySelector("[data-item]")).toBeNull();
    fireEvent.click(botao(ATIVAR, cartao()));
    await carregar();
    expect(titulo()).toHaveTextContent(`Ativas no número ${NUMERO}`);
    expect(cartao()).toHaveTextContent("Desde 03/11/2026");
    expect(cartao()).toHaveTextContent(DICA_TESTE_LIGACAO);
    expect(cartao().getAttribute("data-situacao")).toBe("ativa");
    expect(screen.getByRole("status")).toHaveTextContent(
      `Ligações ativadas. A Nina atende no ${NUMERO}.`,
    );
    // passou: a gaveta fecha sozinha
    expect(gaveta()).toBeNull();
    expect(within(cartao()).queryByRole("button", { name: ATIVAR })).toBeNull();
  });

  it("Desativar: o diálogo; Cancelar não muda nada, Desativar volta a liberada", async () => {
    montarExemplo(exemploPronto());
    await carregar();
    fireEvent.click(botao(ATIVAR, cartao()));
    await carregar();

    fireEvent.click(botao("Desativar ligações", cartao()));
    const dlg = screen.getByRole("alertdialog", { name: "Desativar as ligações?" });
    expect(dlg).toHaveTextContent(
      "A Nina deixa de atender ligações neste número. Dá para ativar de novo quando quiser.",
    );
    fireEvent.click(botao("Cancelar", dlg));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(cartao().getAttribute("data-situacao")).toBe("ativa");

    fireEvent.click(botao("Desativar ligações", cartao()));
    fireEvent.click(botao("Desativar", screen.getByRole("alertdialog")));
    await carregar();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(cartao().getAttribute("data-situacao")).toBe("pronta");
    // a verificação passou antes: o cartão diz que o número pode e oferece ativar de novo
    expect(cartao()).toHaveTextContent(
      "O seu número pode usar ligações (conferido em 03/11/2026).",
    );
    expect(cartao()).toHaveTextContent("Liberado");
    expect(botao(ATIVAR, cartao())).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("Ligações desativadas.");
  });

  it("limite de 250 (o cliente comum): bloqueada pela Meta, sem erro, com o caminho para liberar", async () => {
    montarExemplo(exemploPronto());
    await carregar();
    fireEvent.click(
      within(cartao()).getByRole("checkbox", { name: "Simular limite de 250 na demo" }),
    );
    fireEvent.click(botao(ATIVAR, cartao()));
    await carregar();
    // não é erro: nada de alerta, e o cartão não ativou
    expect(screen.queryByRole("alert")).toBeNull();
    expect(cartao().getAttribute("data-situacao")).toBe("pronta");
    // a gaveta fica aberta com a lista inteira
    const g = gaveta();
    expect(within(g).getByRole("heading", { level: 2 })).toHaveTextContent(
      TEXTO_FASE.bloqueada_meta.titulo,
    );
    expect(g).toHaveTextContent("Essa regra é da Meta, não da Nina.");
    expect(
      within(g)
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(["Na Nina", "Regras da Meta", "Na ElevenLabs"]);
    const limite = item("meta_limite");
    expect(limite).toHaveAttribute("data-estado", "falta");
    expect(limite).toHaveTextContent("O seu limite na Meta hoje é de 250 conversas por dia");
    expect(limite).toHaveTextContent("responder os clientes não aumenta esse limite");
    const passos = within(limite as HTMLElement).getByRole("list", {
      name: "Como liberar as ligações",
    });
    expect(within(passos).getAllByRole("listitem")).toHaveLength(BLOCO_LIMITE.passos.length);
    expect(
      within(limite as HTMLElement).getByRole("link", { name: /Central de segurança/ }),
    ).toHaveAttribute("href", LINK_VERIFICACAO_META);
    expect(limite).toHaveTextContent(BLOCO_LIMITE.enquanto);
    expect(item("meta_token")).toHaveAttribute("data-estado", "ok");
    expect(g).toHaveTextContent("Conferido em 03/11/2026 às 15:00");
    // fechada a gaveta, o cartão resume em uma linha e oferece "Ver como liberar"
    fireEvent.click(within(g).getAllByRole("button", { name: "Fechar" })[0]!);
    await andar(5);
    expect(gaveta()).toBeNull();
    expect(titulo()).toHaveTextContent(TEXTO_FASE.bloqueada_meta.titulo);
    expect(cartao()).toHaveTextContent("Bloqueado pela Meta");
    expect(cartao()).toHaveTextContent(
      "A Meta exige limite de 2.000 conversas por dia, e o seu está em 250.",
    );
    expect(cartao().querySelector("[data-item]")).toBeNull();
    fireEvent.click(botao("Ver como liberar", cartao()));
    await andar(5);
    expect(item("meta_limite")).toHaveAttribute("data-estado", "falta");
    // a empresa foi verificada: "Verificar de novo" passa e já ativa
    fireEvent.click(
      within(gaveta()).getByRole("checkbox", { name: "Simular limite de 250 na demo" }),
    );
    fireEvent.click(botao("Verificar de novo", gaveta()));
    await carregar();
    expect(titulo()).toHaveTextContent(`Ativas no número ${NUMERO}`);
  });

  it('Simular falha no Desativar: com pendências, e "Tentar de novo" termina sem diálogo', async () => {
    montarExemplo(exemploPronto());
    await carregar();
    fireEvent.click(botao(ATIVAR, cartao()));
    await carregar();
    fireEvent.click(within(cartao()).getByRole("checkbox", { name: "Simular falha na demo" }));
    fireEvent.click(botao("Desativar ligações", cartao()));
    fireEvent.click(botao("Desativar", screen.getByRole("alertdialog")));
    await carregar();
    expect(cartao().getAttribute("data-situacao")).toBe("com_pendencias");
    expect(titulo()).toHaveTextContent("Desativação incompleta");
    expect(within(cartao()).getByRole("list", { name: "O que ficou para trás" })).toHaveTextContent(
      "O número na ElevenLabs",
    );
    fireEvent.click(botao("Tentar de novo", cartao()));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await carregar();
    expect(cartao().getAttribute("data-situacao")).toBe("pronta");
  });
});

describe("As ligações no estado do exemplo", () => {
  const base = () => exemploPronto();
  const comando = (acao: Parameters<typeof reduzir>[1]["acao"], estado: EstadoBase) =>
    reduzir(estado, {
      acao,
      euId: (estado.membros.find((m) => m.papel === "admin" && m.ativo) ?? estado.membros[0]!).id,
      agora: AGORA.toISOString(),
    });

  it("os requisitos saem do estado: Meta ativa, chave da ElevenLabs ativa e voz escolhida", () => {
    expect(estadoLigacoesExemplo(base())).toMatchObject({
      situacao: "pronta",
      numero: null,
      pendencias: [],
    });
    const zapi = criarEstadoInicial(AGORA);
    expect(estadoLigacoesExemplo(zapi).requisitos).toMatchObject({
      conexaoMeta: false,
      enderecoPublicado: true,
    });
    const semCredito = {
      ...base(),
      chaves: base().chaves.map((k) =>
        k.finalidade === "voz" ? { ...k, status: "sem_credito" as const } : k,
      ),
    };
    expect(estadoLigacoesExemplo(semCredito)).toMatchObject({
      situacao: "indisponivel",
      requisitos: { chaveVoz: false },
    });
  });

  it("ligar só com a conexão da Meta; trocar ou desconectar o WhatsApp desliga (D15)", () => {
    const recusada = comando({ tipo: "trocarLigacoes", ativas: true }, criarEstadoInicial(AGORA));
    expect(recusada.resultado).toEqual({ ok: false, erro: "sem_conexao_ativa" });
    const ligada = comando({ tipo: "trocarLigacoes", ativas: true }, base()).estado;
    expect(estadoLigacoesExemplo(ligada)).toMatchObject({
      situacao: "ativa",
      numero: NUMERO,
      ativadaEm: AGORA.toISOString(),
    });
    const desconectada = comando({ tipo: "trocarConexao", nova: null }, ligada).estado;
    expect(desconectada.ligacoes).toBeNull();
    const trocada = comando(
      { tipo: "trocarConexao", nova: { gateway: "meta", nome: "+55 11 95555-0000" } },
      ligada,
    ).estado;
    expect(trocada.ligacoes).toBeNull();
    expect(estadoLigacoesExemplo(trocada).situacao).toBe("pronta");
  });
});

/* ---------- modo banco ---------- */

const UID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EU = {
  id: "mb-1",
  nome: "Ana",
  email: "ana@teste.com",
  papel: "admin",
  ativo: true,
  user_id: UID,
  criado_em: "2026-10-01T12:00:00.000Z",
  vistos: {},
};
const CONEXAO = {
  id: "cx-1",
  nome: NUMERO,
  gateway: "meta",
  status: "conectada",
  ativa: true,
  oficial: true,
  id_externo: "123",
  ultimo_erro: null,
  criado_em: "2026-10-20T12:00:00.000Z",
  atualizado_em: "2026-10-20T12:00:00.000Z",
};
const CHAVE_RESPOSTA = {
  id: "k-1",
  finalidade: "resposta",
  provedor: "anthropic",
  modelo: "claude-haiku-5-5",
  status: "ativa",
  ultimos4: "TSTE",
  ultimo_erro: null,
  validada_em: AGORA.toISOString(),
  atualizada_em: AGORA.toISOString(),
  atualizada_por: null,
} as ChaveIA;
const CONFIG = {
  id: 1,
  espera_lote_s: 8,
  espera_lote_max_s: 60,
  onboarding_concluido_em: "2026-10-21T12:00:00.000Z",
  atualizado_em: AGORA.toISOString(),
  worker_visto_em: AGORA.toISOString(),
  voz_id: "v1",
  voz_nome: "Voz de teste",
};

const REQ_OK = { conexaoMeta: true, chaveVoz: true, vozEscolhida: true, enderecoPublicado: true };
function est(
  situacao: EstadoLigacoes["situacao"],
  extra: Partial<EstadoLigacoes> = {},
): EstadoLigacoes {
  return {
    situacao,
    requisitos: REQ_OK,
    elegibilidade: null,
    numero: null,
    ativadaEm: null,
    pendencias: [],
    ...extra,
  };
}
const ATIVA = est("ativa", { numero: NUMERO, ativadaEm: "2026-11-01T13:00:00.000Z" });

function servidorFalso(sobre: Partial<Record<keyof ServidorConfiguracao, unknown>> = {}) {
  const ok = (extra: Record<string, unknown> = {}) => vi.fn(async () => ({ ok: true, ...extra }));
  const s = {
    conferirConexao: ok({ conexao_id: "cx-1", gateway: "meta", nome: NUMERO, status: "conectada" }),
    revalidarChaveIA: ok({ status: "ativa" }),
    listarVozes: ok({ vozes: [], atual: null }),
    estadoLigacoes: ok({ estado: est("pronta") }),
    ativarLigacoes: ok({ estado: ATIVA }),
    desativarLigacoes: ok({ estado: est("pronta") }),
    ...sobre,
  };
  return s as unknown as ServidorConfiguracao &
    Record<keyof ServidorConfiguracao, ReturnType<typeof vi.fn>>;
}

function montarBanco(servidor = servidorFalso()) {
  const f = criarClienteFalso({
    uid: UID,
    consulta: (c: Consulta) => {
      switch (c.tabela) {
        case "membros":
          return { data: EU, error: null };
        case "conexoes":
          return { data: CONEXAO, error: null };
        case "conexao_eventos":
        case "auditoria":
          return { data: null, error: null };
        case "ia_chaves":
          return { data: [CHAVE_RESPOSTA, { ...CHAVE_VOZ, id: "k-3" }], error: null };
        case "configuracao":
          return { data: CONFIG, error: null };
        default:
          return undefined;
      }
    },
    rpc: (nome) =>
      nome === "motor_pendencias_com_retornos"
        ? { data: [{ proximo_em: null, vencido_desde: null, atrasado_desde: null }], error: null }
        : undefined,
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ProvedorPapel papel="admin">
        <Suspense fallback={<p>suspenso</p>}>
          <ProvedorDados fonte="banco" cliente={f.cliente}>
            <ServidorConfiguracaoContexto.Provider value={servidor}>
              <TelaLigacoes />
            </ServidorConfiguracaoContexto.Provider>
          </ProvedorDados>
        </Suspense>
      </ProvedorPapel>
    </QueryClientProvider>,
  );
  return { servidor, qc };
}

describe("Cartão Ligações no banco", () => {
  it("lê o estado ao abrir: o requisito que falta vem do servidor, e a Meta já dá para verificar", async () => {
    const servidor = servidorFalso({
      estadoLigacoes: vi.fn(async () => ({
        ok: true,
        estado: est("indisponivel", { requisitos: { ...REQ_OK, enderecoPublicado: false } }),
      })),
    });
    montarBanco(servidor);
    await carregar();
    expect(servidor.estadoLigacoes).toHaveBeenCalledTimes(1);
    expect(titulo()).toHaveTextContent(TEXTO_FASE.configurar.titulo);
    expect(cartao()).toHaveTextContent("Falta na Nina: aberta pelo endereço publicado.");
    expect(botao(VERIFICAR, cartao())).toBeEnabled();
  });

  it("Verificar: os 4 passos andam enquanto o servidor trabalha; no fim, ativa com o número do servidor", async () => {
    let soltar: (v: unknown) => void = () => {};
    const servidor = servidorFalso({
      ativarLigacoes: vi.fn(() => new Promise((r) => (soltar = r))),
    });
    montarBanco(servidor);
    await carregar();
    fireEvent.click(botao(ATIVAR, cartao()));
    await andar(0);
    // os passos e a barra ficam na gaveta, que abre ao ativar
    const passos = within(gaveta()).getByRole("list", { name: "Passos da ativação" });
    const itens = within(passos).getAllByRole("listitem");
    expect(itens.map((i) => i.textContent?.replace(" (feito)", ""))).toEqual([...PASSOS_ATIVACAO]);
    expect(itens[0]).toHaveAttribute("aria-current", "step");
    const barra = within(gaveta()).getByRole("progressbar", { name: "Progresso da ativação" });
    expect(barra).toHaveAttribute("aria-valuetext", "Passo 1 de 4");
    expect(within(cartao()).queryByRole("button", { name: ATIVAR })).toBeNull();
    expect(titulo()).toHaveTextContent("Verificando e ativando");
    expect(within(gaveta()).getByRole("heading", { level: 2 })).toHaveTextContent(
      "Verificando e ativando",
    );
    await andar(2500);
    expect(itens[0]).toHaveAttribute("data-estado", "ok");
    expect(itens[1]).toHaveAttribute("aria-current", "step");
    expect(barra).toHaveAttribute("aria-valuetext", "Passo 2 de 4");
    await andar(2500);
    expect(itens[2]).toHaveAttribute("aria-current", "step");
    await andar(2500);
    expect(itens[3]).toHaveAttribute("aria-current", "step");
    await andar(2500);
    // o último espera a resposta
    expect(itens[3]).toHaveAttribute("aria-current", "step");
    await act(async () => soltar({ ok: true, estado: ATIVA }));
    await carregar();
    expect(servidor.ativarLigacoes).toHaveBeenCalledTimes(1);
    expect(titulo()).toHaveTextContent(`Ativas no número ${NUMERO}`);
    expect(cartao()).toHaveTextContent("Desde 01/11/2026");
  });

  it("Ativar recusado: a frase do servidor no aviso de erro e o estado relido", async () => {
    const mensagem =
      "A chave da ElevenLabs não tem acesso aos agentes. Na ElevenLabs, edite a chave e ligue ElevenLabs Agents (escrita) e Webhooks (escrita).";
    const servidor = servidorFalso({
      ativarLigacoes: vi.fn(async () => ({
        ok: false,
        erro: "chave_sem_acesso_agentes",
        mensagem,
      })),
    });
    montarBanco(servidor);
    await carregar();
    fireEvent.click(botao(ATIVAR, cartao()));
    await carregar();
    expect(within(cartao()).getByRole("alert")).toHaveTextContent(mensagem);
    expect(within(gaveta()).getByRole("alert")).toHaveTextContent(mensagem);
    expect(servidor.estadoLigacoes).toHaveBeenCalledTimes(2);
    expect(botao(ATIVAR, cartao())).toBeEnabled();
  });

  it("ativa: Desativar pede confirmação e chama o servidor uma vez", async () => {
    const servidor = servidorFalso({
      estadoLigacoes: vi.fn(async () => ({ ok: true, estado: ATIVA })),
    });
    montarBanco(servidor);
    await carregar();
    expect(cartao()).toHaveTextContent(DICA_TESTE_LIGACAO);
    fireEvent.click(botao("Desativar ligações", cartao()));
    expect(servidor.desativarLigacoes).not.toHaveBeenCalled();
    fireEvent.click(
      botao("Desativar", screen.getByRole("alertdialog", { name: "Desativar as ligações?" })),
    );
    await carregar();
    expect(servidor.desativarLigacoes).toHaveBeenCalledTimes(1);
    expect(cartao().getAttribute("data-situacao")).toBe("pronta");
  });

  it('com pendências: a lista do que ficou e "Tentar de novo" desativa de novo', async () => {
    const servidor = servidorFalso({
      estadoLigacoes: vi.fn(async () => ({
        ok: true,
        // um nome que a tela não conhece não aparece (D35: as pendências têm tipo próprio)
        estado: est("com_pendencias", {
          pendencias: ["meta", "agente", "outra"] as unknown as PendenciaLigacoes[],
        }),
      })),
    });
    montarBanco(servidor);
    await carregar();
    const lista = within(cartao()).getByRole("list", { name: "O que ficou para trás" });
    expect(
      within(lista)
        .getAllByRole("listitem")
        .map((i) => i.textContent),
    ).toEqual(["As chamadas ligadas na Meta", "O agente de voz na ElevenLabs"]);
    fireEvent.click(botao("Tentar de novo", cartao()));
    await carregar();
    expect(servidor.desativarLigacoes).toHaveBeenCalledTimes(1);
    expect(cartao().getAttribute("data-situacao")).toBe("pronta");
  });

  it('"ativando" vindo do servidor: os passos, sem botão, e relê a cada 5 s', async () => {
    const lidos = [est("ativando"), ATIVA];
    const servidor = servidorFalso({
      estadoLigacoes: vi.fn(async () => ({ ok: true, estado: lidos.shift() ?? ATIVA })),
    });
    montarBanco(servidor);
    await carregar();
    expect(within(cartao()).getByRole("list", { name: "Passos da ativação" })).toBeInTheDocument();
    // o passo não é conhecido aqui: a barra corre sem fim, sem valor
    const barra = within(cartao()).getByRole("progressbar", { name: "Progresso da ativação" });
    expect(barra).toHaveAttribute("data-indeterminado");
    expect(barra).not.toHaveAttribute("aria-valuenow");
    expect(within(cartao()).queryByRole("button")).toBeNull();
    await andar(5000);
    await carregar();
    expect(servidor.estadoLigacoes).toHaveBeenCalledTimes(2);
    expect(cartao().getAttribute("data-situacao")).toBe("ativa");
  });

  it('"ativando" parado (D20): o servidor devolve com_pendencias e o cartão para de girar e mostra "Tentar de novo"', async () => {
    const lidos = [
      est("ativando"),
      est("ativando"),
      est("com_pendencias", { pendencias: ["meta", "agente"] }),
    ];
    const servidor = servidorFalso({
      estadoLigacoes: vi.fn(async () => ({ ok: true, estado: lidos.shift() ?? est("pronta") })),
    });
    montarBanco(servidor);
    await carregar();
    expect(within(cartao()).queryByRole("button")).toBeNull();
    await andar(5000);
    await carregar();
    expect(cartao().getAttribute("data-situacao")).toBe("ativando");
    await andar(5000);
    await carregar();
    expect(servidor.estadoLigacoes).toHaveBeenCalledTimes(3);
    expect(cartao().getAttribute("data-situacao")).toBe("com_pendencias");
    expect(within(cartao()).queryByRole("list", { name: "Passos da ativação" })).toBeNull();
    // não relê mais sozinho
    await andar(10000);
    expect(servidor.estadoLigacoes).toHaveBeenCalledTimes(3);
    fireEvent.click(botao("Tentar de novo", cartao()));
    await carregar();
    expect(servidor.desativarLigacoes).toHaveBeenCalledTimes(1);
    expect(cartao().getAttribute("data-situacao")).toBe("pronta");
  });

  it('meta_manual (D23): o texto do painel da Meta e "Já desliguei", que chama desativar', async () => {
    const servidor = servidorFalso({
      estadoLigacoes: vi.fn(async () => ({
        ok: true,
        estado: est("com_pendencias", { pendencias: ["meta_manual"] }),
      })),
    });
    montarBanco(servidor);
    await carregar();
    expect(cartao()).toHaveTextContent(TEXTO_META_MANUAL);
    expect(TEXTO_META_MANUAL).toBe(
      "Desligue as ligações deste número no painel da Meta (WhatsApp Manager → o número → Ligações).",
    );
    const lista = within(cartao()).getByRole("list", { name: "O que ficou para trás" });
    expect(within(lista).getByRole("listitem")).toHaveTextContent("As chamadas ligadas na Meta");
    expect(within(cartao()).queryByRole("button", { name: "Tentar de novo" })).toBeNull();
    fireEvent.click(botao("Já desliguei", cartao()));
    await carregar();
    expect(servidor.desativarLigacoes).toHaveBeenCalledTimes(1);
    expect(cartao().getAttribute("data-situacao")).toBe("pronta");
  });

  it('sem meta_manual, nem o texto do painel nem "Já desliguei"', async () => {
    const servidor = servidorFalso({
      estadoLigacoes: vi.fn(async () => ({
        ok: true,
        estado: est("com_pendencias", { pendencias: ["meta"] }),
      })),
    });
    montarBanco(servidor);
    await carregar();
    expect(cartao()).not.toHaveTextContent(TEXTO_META_MANUAL);
    expect(within(cartao()).queryByRole("button", { name: "Já desliguei" })).toBeNull();
  });

  it('"ativando" e uma leitura que falha: a releitura rearma e o cartão chega ao fim', async () => {
    const lidos: (EstadoLigacoes | Error)[] = [est("ativando"), new Error("rede caiu"), ATIVA];
    const servidor = servidorFalso({
      estadoLigacoes: vi.fn(async () => {
        const proximo = lidos.shift() ?? ATIVA;
        if (proximo instanceof Error) throw proximo;
        return { ok: true, estado: proximo };
      }),
    });
    montarBanco(servidor);
    await carregar();
    expect(cartao().getAttribute("data-situacao")).toBe("ativando");
    await andar(5000);
    await carregar();
    // a segunda leitura falhou: o cartão continua no "ativando" e relê de novo
    expect(servidor.estadoLigacoes).toHaveBeenCalledTimes(2);
    expect(cartao().getAttribute("data-situacao")).toBe("ativando");
    await andar(5000);
    await carregar();
    expect(servidor.estadoLigacoes).toHaveBeenCalledTimes(3);
    expect(cartao().getAttribute("data-situacao")).toBe("ativa");
  });

  it('a ativação abandonada (D20): "A ativação não terminou", com a lista do que ela criou', async () => {
    const servidor = servidorFalso({
      estadoLigacoes: vi.fn(async () => ({
        ok: true,
        estado: est("com_pendencias", { pendencias: ["meta", "agente"], abandonada: true }),
      })),
    });
    montarBanco(servidor);
    await carregar();
    expect(titulo()).toHaveTextContent("A ativação não terminou");
    expect(cartao()).not.toHaveTextContent("Desativação incompleta");
    expect(cartao()).not.toHaveTextContent("A desativação não terminou");
    expect(cartao()).toHaveTextContent(
      "A ativação parou no meio. Tentar de novo desfaz o que ela criou:",
    );
    expect(
      within(within(cartao()).getByRole("list", { name: "O que ficou para trás" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(2);
    fireEvent.click(botao("Tentar de novo", cartao()));
    await carregar();
    expect(servidor.desativarLigacoes).toHaveBeenCalledTimes(1);
  });

  it("a ativação abandonada sem nada criado: sem lista vazia nem frase que anuncia uma", async () => {
    const servidor = servidorFalso({
      estadoLigacoes: vi.fn(async () => ({
        ok: true,
        estado: est("com_pendencias", { pendencias: [], abandonada: true }),
      })),
    });
    montarBanco(servidor);
    await carregar();
    expect(titulo()).toHaveTextContent("A ativação não terminou");
    expect(within(cartao()).queryByRole("list", { name: "O que ficou para trás" })).toBeNull();
    expect(cartao().textContent).not.toMatch(/:\s*$|Ficou para trás:|criou:/);
    expect(cartao()).toHaveTextContent("antes de criar qualquer coisa");
    expect(botao("Tentar de novo", cartao())).toBeEnabled();
  });

  it('eleven_manual (D30): o texto do painel da ElevenLabs e "Já apaguei", que chama desativar', async () => {
    const servidor = servidorFalso({
      estadoLigacoes: vi.fn(async () => ({
        ok: true,
        estado: est("com_pendencias", { pendencias: ["eleven_manual"] }),
      })),
    });
    montarBanco(servidor);
    await carregar();
    expect(TEXTO_ELEVEN_MANUAL).toBe(
      "Apague no painel da ElevenLabs o que sobrou com o nome “Nina (ligações) …”: o agente, o número, a ferramenta, o webhook ou o segredo.",
    );
    expect(cartao()).toHaveTextContent(TEXTO_ELEVEN_MANUAL);
    expect(cartao()).not.toHaveTextContent(TEXTO_META_MANUAL);
    const lista = within(cartao()).getByRole("list", { name: "O que ficou para trás" });
    expect(within(lista).getByRole("listitem")).toHaveTextContent("O que sobrou na ElevenLabs");
    expect(within(cartao()).queryByRole("button", { name: "Tentar de novo" })).toBeNull();
    fireEvent.click(botao("Já apaguei", cartao()));
    await carregar();
    expect(servidor.desativarLigacoes).toHaveBeenCalledTimes(1);
    expect(cartao().getAttribute("data-situacao")).toBe("pronta");
  });

  it("o Já apaguei que não confirmou: o aviso repete o pedido do cartão, sem Tente de novo", async () => {
    const pendente = est("com_pendencias", { pendencias: ["eleven_manual"] });
    const servidor = servidorFalso({
      estadoLigacoes: vi.fn(async () => ({ ok: true, estado: pendente })),
      desativarLigacoes: vi.fn(async () => ({ ok: true, estado: pendente })),
    });
    montarBanco(servidor);
    await carregar();
    fireEvent.click(botao("Já apaguei", cartao()));
    await carregar();
    expect(servidor.desativarLigacoes).toHaveBeenCalledTimes(1);
    const aviso = screen.getByRole("status");
    expect(aviso).toHaveTextContent(
      "Falta apagar o que sobrou no painel da ElevenLabs. Depois, clique em Já apaguei.",
    );
    expect(aviso).not.toHaveTextContent("Tente de novo");
    expect(cartao()).toHaveTextContent(TEXTO_ELEVEN_MANUAL);
    expect(botao("Já apaguei", cartao())).toBeEnabled();
  });

  it("o aviso das pendências combina com o botão do cartão", () => {
    expect(avisoPendencias(["meta", "agente"])).toBe("Algumas partes não saíram. Tente de novo.");
    expect(avisoPendencias(["meta_manual"])).toBe(
      "Falta desligar as ligações no painel da Meta. Depois, clique em Já desliguei.",
    );
    expect(avisoPendencias(["meta", "eleven_manual"])).toContain("clique em Já apaguei");
    expect(avisoPendencias(["meta_manual", "eleven_manual"])).toContain("clique em Já fiz os dois");
    const manuais: PendenciaLigacoes[][] = [
      ["meta_manual"],
      ["eleven_manual"],
      ["meta_manual", "eleven_manual"],
    ];
    for (const p of manuais) {
      expect(avisoPendencias(p)).not.toContain("Tente de novo");
    }
  });

  it('a leitura falha: o aviso e "Ler de novo"', async () => {
    let falhar = true;
    const servidor = servidorFalso({
      estadoLigacoes: vi.fn(async () => {
        if (falhar) throw new Error("rede caiu: ana@teste.com");
        return { ok: true, estado: est("pronta") };
      }),
    });
    montarBanco(servidor);
    await carregar();
    expect(cartao()).toHaveTextContent(LEITURA_FALHOU);
    expect(cartao().textContent).not.toMatch(/rede caiu/);
    falhar = false;
    fireEvent.click(botao("Ler de novo", cartao()));
    await carregar();
    expect(cartao().getAttribute("data-situacao")).toBe("pronta");
  });
});

describe("Camada de dados das ligações (banco)", () => {
  it("o estado fora do formato vira falha; a recusa leva só o código e a frase", async () => {
    const servidor = servidorFalso({
      estadoLigacoes: vi.fn(async () => ({ ok: true, estado: { situacao: "outra" } })),
      ativarLigacoes: vi.fn(async () => ({
        ok: false,
        erro: "meta_recusou",
        mensagem: "Frase.",
        segredo: "x",
      })),
    });
    const acoes = criarAcoesConfiguracaoBanco(servidor, new QueryClient());
    expect(await acoes.estadoLigacoes()).toEqual({ ok: false, erro: "falha" });
    // a ativação abandonada (D20) chega ao cartão; outro valor não vira campo
    for (const [abandonada, esperado] of [
      [true, { abandonada: true }],
      ["sim", {}],
    ] as const) {
      servidor.estadoLigacoes.mockResolvedValueOnce({
        ok: true,
        estado: { ...est("com_pendencias"), abandonada },
      });
      expect(await acoes.estadoLigacoes()).toEqual({
        ok: true,
        estado: { ...est("com_pendencias"), ...esperado },
      });
    }
    expect(await acoes.ativarLigacoes()).toEqual({
      ok: false,
      erro: "meta_recusou",
      mensagem: "Frase.",
    });
  });

  it("ativar e desativar releem a conexão; o estado só lê", async () => {
    const qc = new QueryClient();
    const invalidar = vi.spyOn(qc, "invalidateQueries");
    const acoes = criarAcoesConfiguracaoBanco(servidorFalso(), qc);
    const r = await acoes.estadoLigacoes();
    expect(r).toEqual({ ok: true, estado: est("pronta") });
    expect(invalidar).not.toHaveBeenCalled();
    expect(await acoes.ativarLigacoes()).toEqual({ ok: true, estado: ATIVA });
    expect(invalidar).toHaveBeenCalledWith({ queryKey: CHAVES.conexao });
    invalidar.mockClear();
    await acoes.desativarLigacoes();
    expect(invalidar).toHaveBeenCalledWith({ queryKey: CHAVES.conexao });
  });

  it("sem_acesso relê o Eu", async () => {
    const qc = new QueryClient();
    const invalidar = vi.spyOn(qc, "invalidateQueries");
    const acoes = criarAcoesConfiguracaoBanco(
      servidorFalso({ estadoLigacoes: vi.fn(async () => ({ ok: false, erro: "sem_acesso" })) }),
      qc,
    );
    expect(await acoes.estadoLigacoes()).toEqual({ ok: false, erro: "sem_acesso" });
    expect(invalidar).toHaveBeenCalledWith({ queryKey: CHAVES.eu });
  });
});

/* ---------- a verificação antes de ativar (spec-ligacoes, seção 21) ---------- */

function elegDe(
  estados: Partial<Record<IdItemElegibilidade, EstadoItemElegibilidade>>,
  valores: Partial<Record<IdItemElegibilidade, string>> = {},
): Elegibilidade {
  const itens = ITENS_ELEGIBILIDADE.map((id) => ({
    id,
    dono: DONO_ITEM_ELEGIBILIDADE[id],
    estado: estados[id] ?? ("ok" as EstadoItemElegibilidade),
    ...(valores[id] ? { valor: valores[id] } : {}),
  }));
  return {
    versao: 1,
    elegivel: itens.every((i) => i.estado === "ok"),
    limiteMeta: valores.meta_limite ?? null,
    itens,
    conferidaEm: "2026-11-03T17:40:00.000Z",
  };
}

describe("A verificação: fases e textos", () => {
  it("a fase sai dos requisitos de agora e da última verificação", () => {
    const req = REQ_OK;
    expect(faseDoCartao({ requisitos: { ...req, chaveVoz: false }, elegibilidade: null })).toBe(
      "configurar",
    );
    expect(faseDoCartao({ requisitos: req, elegibilidade: null })).toBe("verificar");
    expect(faseDoCartao({ requisitos: req, elegibilidade: elegDe({}) })).toBe("liberada");
    expect(
      faseDoCartao({
        requisitos: req,
        elegibilidade: elegDe({ meta_limite: "falta" }, { meta_limite: "TIER_250" }),
      }),
    ).toBe("bloqueada_meta");
    expect(
      faseDoCartao({ requisitos: req, elegibilidade: elegDe({ chave_agentes: "falta" }) }),
    ).toBe("ajustar");
    expect(
      faseDoCartao({ requisitos: req, elegibilidade: elegDe({ meta_numero: "falhou" }) }),
    ).toBe("sem_conferir");
    // a regra da Meta que falta vence o item que não deu para conferir
    expect(
      faseDoCartao({
        requisitos: req,
        elegibilidade: elegDe({ meta_limite: "falta", chave_agentes: "falhou" }),
      }),
    ).toBe("bloqueada_meta");
  });

  it("o bloqueio da Meta vem antes do que falta na Nina; o que saiu invalida a verificação", () => {
    const eleg = elegDe({ meta_limite: "falta" }, { meta_limite: "TIER_250" });
    const semVoz = { requisitos: { ...REQ_OK, vozEscolhida: false }, elegibilidade: eleg };
    // liberar na Meta leva dias: o cliente precisa saber primeiro
    expect(faseDoCartao(semVoz)).toBe("bloqueada_meta");
    expect(itensDoCartao(semVoz).find((i) => i.id === "voz")?.estado).toBe("falta");
    // sem a conexão da Meta, a verificação dela não vale mais
    const semMeta = { requisitos: { ...REQ_OK, conexaoMeta: false }, elegibilidade: eleg };
    expect(faseDoCartao(semMeta)).toBe("configurar");
    expect(itensDoCartao(semMeta).find((i) => i.id === "meta_limite")?.estado).toBe(
      "nao_conferido",
    );
    // sem a chave da voz, o item da ElevenLabs também volta a não conferido
    const semChave = { requisitos: { ...REQ_OK, chaveVoz: false }, elegibilidade: elegDe({}) };
    expect(itensDoCartao(semChave).find((i) => i.id === "chave_agentes")?.estado).toBe(
      "nao_conferido",
    );
    expect(podeVerificar(semChave)).toBe(true);
    expect(podeVerificar(semMeta)).toBe(false);
  });

  it("o tier em português", () => {
    expect(limiteLegivel("TIER_250")).toBe("250");
    expect(limiteLegivel("TIER_2K")).toBe("2.000");
    expect(limiteLegivel("TIER_100K")).toBe("100.000");
    expect(limiteLegivel("TIER_UNLIMITED")).toBeNull();
    expect(limiteLegivel("outro")).toBeNull();
    // o tier novo ou desconhecido passa no servidor (a Meta decide no SIP): sem número, sem linha
    expect(limiteLegivel("TIER_NOT_SET")).toBeNull();
    expect(detalheOk({ id: "meta_limite", valor: "TIER_NOT_SET" })).toBeNull();
    expect(tituloLimite("TIER_250")).toBe("O seu limite na Meta hoje é de 250 conversas por dia");
    expect(tituloLimite(undefined)).toBe("O seu número ainda não tem o limite que a Meta exige");
    // a Meta recusou (138015) com o tier lido em 2K: o título não diz "o seu limite é 2.000"
    expect(tituloLimite("TIER_2K")).toBe("O seu número ainda não tem o limite que a Meta exige");
    // o erro do item escolhe o texto: a pausa por qualidade não é o número bloqueado
    expect(textoFalta({ id: "meta_numero", erro: "meta_pausada" })).toBe(TEXTO_NUMERO_PAUSADO);
    expect(textoFalta({ id: "meta_numero", erro: "meta_numero_bloqueado" })).toBe(
      TEXTOS_ITEM.meta_numero.falta,
    );
    expect(textoFalta({ id: "meta_numero" })).toBe(TEXTOS_ITEM.meta_numero.falta);
    expect(
      elegibilidadeDe({
        ...elegDe({ meta_numero: "falta" }),
        itens: elegDe({}).itens.map((i) =>
          i.id === "meta_numero" ? { ...i, estado: "falta", erro: "meta_pausada" } : i,
        ),
      })?.itens.find((i) => i.id === "meta_numero"),
    ).toMatchObject({ estado: "falta", erro: "meta_pausada" });
    expect(detalheOk({ id: "meta_limite", valor: "TIER_UNLIMITED" })).toBe(
      "Sem limite de conversas.",
    );
    expect(detalheOk({ id: "meta_numero", valor: "AVAILABLE" })).toBeNull();
  });
});

describe("A verificação no banco", () => {
  it("o ativar reprovado com a verificação: o cartão vira bloqueado pela Meta, sem aviso de erro", async () => {
    const eleg = elegDe({ meta_limite: "falta" }, { meta_limite: "TIER_250" });
    const servidor = servidorFalso({
      ativarLigacoes: vi.fn(async () => ({
        ok: false,
        erro: "meta_limite",
        mensagem: "A Meta ainda não liberou ligações para este número.",
        elegibilidade: eleg,
      })),
    });
    montarBanco(servidor);
    await carregar();
    fireEvent.click(botao(ATIVAR, cartao()));
    await carregar();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(titulo()).toHaveTextContent(TEXTO_FASE.bloqueada_meta.titulo);
    expect(item("meta_limite")).toHaveTextContent(
      "O seu limite na Meta hoje é de 250 conversas por dia",
    );
    expect(gaveta()).toHaveTextContent("Conferido em 03/11/2026 às 14:40");
    expect(botao("Verificar de novo", cartao())).toBeEnabled();
    // a falha já trouxe o resultado: nada de reler
    expect(servidor.estadoLigacoes).toHaveBeenCalledTimes(1);
  });

  it("o número BLOCKED (meta_numero_bloqueado): bloqueado pela Meta, com o caminho na saúde da conta", async () => {
    const eleg = elegDe({ meta_numero: "falta" }, { meta_numero: "BLOCKED" });
    const servidor = servidorFalso({
      ativarLigacoes: vi.fn(async () => ({
        ok: false,
        erro: "meta_numero_bloqueado",
        mensagem: "A Meta bloqueou este número.",
        elegibilidade: eleg,
      })),
    });
    montarBanco(servidor);
    await carregar();
    fireEvent.click(botao(ATIVAR, cartao()));
    await carregar();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(titulo()).toHaveTextContent(TEXTO_FASE.bloqueada_meta.titulo);
    expect(cartao()).toHaveTextContent("A Meta bloqueou este número.");
    expect(item("meta_numero")).toHaveTextContent(TEXTOS_ITEM.meta_numero.falta);
    expect(item("meta_numero")).toHaveTextContent("forma de pagamento");
  });

  it("a última verificação vem no estado: ao abrir, o cartão resume o bloqueio e a gaveta abre em Ver como liberar", async () => {
    const eleg = elegDe({ meta_sip_livre: "falta" });
    const servidor = servidorFalso({
      estadoLigacoes: vi.fn(async () => ({
        ok: true,
        estado: est("pronta", { elegibilidade: eleg }),
      })),
    });
    montarBanco(servidor);
    await carregar();
    expect(titulo()).toHaveTextContent(TEXTO_FASE.bloqueada_meta.titulo);
    expect(cartao()).toHaveTextContent("Este número já manda as ligações para outro sistema.");
    // a lista só aparece quando ele pede
    expect(gaveta()).toBeNull();
    fireEvent.click(botao("Ver como liberar", cartao()));
    await andar(5);
    expect(servidor.ativarLigacoes).not.toHaveBeenCalled();
    expect(item("meta_sip_livre")).toHaveTextContent(TEXTOS_ITEM.meta_sip_livre.falta);
    expect(item("meta_limite")).toHaveAttribute("data-estado", "ok");
  });

  it("a camada de dados confere a verificação item a item e a leva na recusa", async () => {
    const eleg = elegDe({ meta_limite: "falta" }, { meta_limite: "TIER_250" });
    const servidor = servidorFalso({
      ativarLigacoes: vi.fn(async () => ({
        ok: false,
        erro: "meta_limite",
        mensagem: "Frase.",
        elegibilidade: {
          ...eleg,
          // um item desconhecido e um dono trocado: o primeiro some, o segundo volta ao da tabela
          itens: [
            ...eleg.itens.map((i) => (i.id === "voz" ? { ...i, dono: "meta" } : i)),
            { id: "outro", estado: "ok" },
          ],
        },
      })),
    });
    const acoes = criarAcoesConfiguracaoBanco(servidor, new QueryClient());
    expect(await acoes.ativarLigacoes()).toEqual({
      ok: false,
      erro: "meta_limite",
      mensagem: "Frase.",
      elegibilidade: eleg,
    });
    expect(elegibilidadeDe({ ...eleg, versao: 2 })).toBeNull();
    expect(elegibilidadeDe(null)).toBeNull();
  });
});
