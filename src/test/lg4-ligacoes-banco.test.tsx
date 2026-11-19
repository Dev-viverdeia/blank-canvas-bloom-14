import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Suspense, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BlocoLigacaoDaMensagem } from "@/features/plataforma/comum/BlocoLigacao";
import { tituloDaMensagemDeLigacao } from "@/features/plataforma/comum/ligacao";
import {
  ServidorConfiguracaoContexto,
  type ServidorConfiguracao,
} from "@/features/plataforma/dados/configuracao";
import { useAcoesContextoBanco } from "@/features/plataforma/dados/contexto";
import {
  ServidorLigacoesContexto,
  falasDaLinha,
  resultadoDoServidor,
  type ServidorLigacoes,
} from "@/features/plataforma/dados/ligacoes";
import { ProvedorDados } from "@/features/plataforma/dados/ProvedorDados";
import { criarClienteFalso, type Consulta } from "@/features/plataforma/dados/testes/clienteFalso";
import { TelaLigacoes } from "@/features/plataforma/ligacoes";
import {
  VAZIO_AGENTES_ATIVAS,
  VAZIO_AGENTES_DESLIGADAS,
} from "@/features/plataforma/ligacoes/Agentes";
import { ProvedorPapel } from "@/features/plataforma/papel";
import { VERSAO_AGENTE } from "@/features/mensageria/ligacoes/tipos";

// A fase B da área Ligações (2.2 e 2.3): a tela lendo do banco (o
// histórico com o contato e o agente, os agentes, os limites), as ações pelas funções de servidor
// (trocadas por falsas pelo ServidorLigacoesContexto), o "em andamento" com o tempo correndo, o aviso
// do agente atrás do Contexto (L14), o bloco da ligação no Chat e o Contexto salvo levando os agentes.

vi.mock("@/components/nina/VooNina", async (original) => {
  const real = await original<typeof import("@/components/nina/VooNina")>();
  return { ...real, movimentoReduzido: () => true, rolarAteEMedir: () => Promise.resolve(null) };
});

const AGORA = new Date("2026-11-12T15:00:00-03:00");
const NUMERO = "+55 11 90000-0000";
const UID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function andar(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function carregar() {
  for (let i = 0; i < 8; i++) await andar(5);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AGORA);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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
const CONFIG = {
  id: 1,
  espera_lote_s: 8,
  espera_lote_max_s: 60,
  onboarding_concluido_em: "2026-10-21T12:00:00.000Z",
  atualizado_em: AGORA.toISOString(),
  worker_visto_em: AGORA.toISOString(),
  voz_id: "v1",
  voz_nome: "Voz de teste",
  ligacoes_simultaneas: 4,
  ligacoes_por_dia: 250,
  ligacoes_por_contato: 7,
};
const CONTEXTO_EM = "2026-11-12T12:00:00.000Z";

function agente(o: Record<string, unknown>) {
  return {
    id: "ag-nina",
    nome: "Nina",
    objetivo: "vendas",
    instrucoes: "",
    regras_equipe: null,
    voz_id: "v1",
    voz_nome: "Voz de teste",
    perfil: "recomendado",
    saudacao: "Oi, {nome}! Aqui é a Nina. Como posso te ajudar?",
    duracao_max_s: 600,
    silencio_s: 25,
    atende: true,
    id_externo: "agent_1",
    versao_config: VERSAO_AGENTE,
    sincronizado_em: "2026-11-12T13:00:00.000Z",
    erro_sincronia: null,
    criado_em: "2026-11-01T12:00:00.000Z",
    atualizado_em: "2026-11-01T12:00:00.000Z",
    ...o,
  };
}

const iniciadaHa = (min: number) => new Date(AGORA.getTime() - min * 60_000).toISOString();

function ligacao(o: Record<string, unknown>) {
  return {
    id: "lg-1",
    conversa_id: "cv-1",
    mensagem_id: "msg-1",
    agente_id: "ag-nina",
    direcao: "entrada",
    status: "concluida",
    iniciada_em: iniciadaHa(30),
    encerrada_em: iniciadaHa(27),
    duracao_s: 174,
    motivo_fim: "client_ended",
    resumo: "Ricardo quer orçamento para a loja nova.",
    transcricao: [
      { papel: "nina", texto: "[excited] Oi, Ricardo!", segundos: 0 },
      { papel: "lead", texto: "Quero um orçamento.", segundos: 4 },
    ],
    passou_equipe: false,
    conversas: {
      contato_id: "ct-1",
      contatos: {
        id: "ct-1",
        nome: "Ricardo Lima",
        nome_whatsapp: null,
        telefone: "5511988887777",
      },
    },
    ...o,
  };
}

type Banco = {
  agentes: Record<string, unknown>[];
  ligacoes: Record<string, unknown>[];
  contexto: Record<string, unknown> | null;
};

function servidorFalso(sobre: Partial<Record<keyof ServidorLigacoes, unknown>> = {}) {
  const ok = () => vi.fn(async () => ({ ok: true }));
  return {
    criarAgente: vi.fn(async () => ({ ok: true, id: "ag-novo" })),
    salvarAgente: ok(),
    apagarAgente: ok(),
    atender: ok(),
    atualizarAgentes: ok(),
    sincronizarContexto: ok(),
    salvarLimites: ok(),
    adotarAgenteDoTronco: ok(),
    ...sobre,
  } as unknown as ServidorLigacoes & Record<keyof ServidorLigacoes, ReturnType<typeof vi.fn>>;
}

const SERVIDOR_CONFIGURACAO = {
  estadoLigacoes: vi.fn(async () => ({
    ok: true,
    estado: {
      situacao: "ativa",
      requisitos: {
        conexaoMeta: true,
        chaveVoz: true,
        vozEscolhida: true,
        enderecoPublicado: true,
      },
      numero: NUMERO,
      ativadaEm: "2026-11-01T13:00:00.000Z",
      pendencias: [],
    },
  })),
  listarVozes: vi.fn(async () => ({ ok: true, vozes: [], atual: null })),
} as unknown as ServidorConfiguracao;

function clienteDo(banco: Banco) {
  return criarClienteFalso({
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
          return { data: [], error: null };
        case "configuracao":
          return { data: CONFIG, error: null };
        case "contexto_versoes":
          return { data: banco.contexto, error: null };
        case "ligacao_agentes":
          return { data: banco.agentes, error: null };
        case "ligacoes": {
          const porMensagem = c.passos.find((p) => p[0] === "eq" && p[1] === "mensagem_id");
          if (porMensagem) {
            const l = banco.ligacoes.find((x) => x["mensagem_id"] === porMensagem[2]);
            return {
              data: l ? { ...l, ligacao_agentes: { nome: "Nina" } } : null,
              error: null,
            };
          }
          return { data: banco.ligacoes, error: null };
        }
        default:
          return undefined;
      }
    },
    rpc: (nome) =>
      nome === "motor_pendencias_com_retornos"
        ? { data: [{ proximo_em: null, vencido_desde: null, atrasado_desde: null }], error: null }
        : undefined,
  });
}

function montar(
  banco: Banco,
  servidor = servidorFalso(),
  papel: "admin" | "atendente" = "admin",
  filho: ReactNode = <TelaLigacoes />,
) {
  const f = clienteDo(banco);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ProvedorPapel papel={papel}>
        <Suspense fallback={<p>suspenso</p>}>
          <ProvedorDados fonte="banco" cliente={f.cliente}>
            <ServidorConfiguracaoContexto.Provider value={SERVIDOR_CONFIGURACAO}>
              <ServidorLigacoesContexto.Provider value={servidor}>
                {filho}
              </ServidorLigacoesContexto.Provider>
            </ServidorConfiguracaoContexto.Provider>
          </ProvedorDados>
        </Suspense>
      </ProvedorPapel>
    </QueryClientProvider>,
  );
  return { servidor, f, qc };
}

function bancoPadrao(): Banco {
  return {
    agentes: [agente({})],
    ligacoes: [ligacao({})],
    contexto: { id: 3, numero: 3, criado_em: CONTEXTO_EM, empresa_oferta: "Consultoria de IA" },
  };
}

async function abrirAba(nome: string) {
  fireEvent.click(screen.getByRole("tab", { name: nome }));
  await carregar();
}

describe("as peças puras da camada de dados", () => {
  it("falasDaLinha: nina vira agente, as marcas de emoção saem e o que vier fora do formato também", () => {
    expect(
      falasDaLinha([
        { papel: "nina", texto: "[excited] Oi!", segundos: 0.4 },
        { papel: "lead", texto: "Olá [link do site]", segundos: 3 },
        { papel: "outro", texto: "x", segundos: 1 },
        { papel: "lead", texto: "[laugh]", segundos: 5 },
        "lixo",
      ]),
    ).toEqual([
      { papel: "agente", texto: "Oi!", segundos: 0 },
      { papel: "lead", texto: "Olá [link do site]", segundos: 3 },
    ]);
    expect(falasDaLinha(null)).toEqual([]);
  });

  it("resultadoDoServidor: os códigos conhecidos ficam; o resto vira falha com a frase do servidor", () => {
    expect(resultadoDoServidor({ ok: true, id: "a" })).toEqual({ ok: true, id: "a" });
    expect(resultadoDoServidor({ ok: false, erro: "agente_que_atende", mensagem: "x" })).toEqual({
      ok: false,
      erro: "agente_que_atende",
      detalhe: "x",
    });
    expect(resultadoDoServidor({ ok: false, erro: "prompt_grande", mensagem: "Grande." })).toEqual({
      ok: false,
      erro: "falha",
      detalhe: "Grande.",
    });
    expect(resultadoDoServidor(null)).toEqual({ ok: false, erro: "falha" });
  });

  it("tituloDaMensagemDeLigacao: o rótulo do tipo ligacao; o em andamento velho vira sem resumo", () => {
    const agora = AGORA.getTime();
    expect(
      tituloDaMensagemDeLigacao({ tipo: "ligacao", texto: "Ligação · 2 min 54 s" }, agora),
    ).toBe("Ligação · 2 min 54 s");
    expect(
      tituloDaMensagemDeLigacao(
        { tipo: "ligacao", texto: "Ligação em andamento", momento: iniciadaHa(36) },
        agora,
      ),
    ).toBe("Ligação sem resumo");
    // uma ligação de 30 min continua em andamento aos 20
    expect(
      tituloDaMensagemDeLigacao(
        { tipo: "ligacao", texto: "Ligação em andamento", momento: iniciadaHa(20) },
        agora,
      ),
    ).toBe("Ligação em andamento");
    expect(
      tituloDaMensagemDeLigacao({ tipo: "outro", texto: "[ligação] concluída (60 s)" }, agora),
    ).toBe("Ligação · 1 min");
    expect(tituloDaMensagemDeLigacao({ tipo: "texto", texto: "oi" }, agora)).toBeNull();
  });
});

describe("Histórico no banco", () => {
  it("lê as ligações com o contato e o agente; a transcrição sem marcas de emoção", async () => {
    montar(bancoPadrao());
    await carregar();
    const linha = document.querySelector('[data-ligacao="lg-1"]') as HTMLElement;
    expect(linha).toHaveTextContent("Ricardo Lima");
    expect(linha).toHaveTextContent("2 min 54 s");
    expect(linha).toHaveTextContent("Nina");
    fireEvent.click(linha);
    await carregar();
    const detalhe = document.querySelector('[data-lg-detalhe="lg-1"]') as HTMLElement;
    expect(detalhe).toHaveTextContent("Ricardo quer orçamento para a loja nova.");
    expect(detalhe).toHaveTextContent("O contato desligou");
    const falas = within(detalhe).getByRole("list", { name: "Falas da ligação" });
    expect(falas).toHaveTextContent("Oi, Ricardo!");
    expect(falas).not.toHaveTextContent("[excited]");
  });

  it("d) em andamento: quem ligou, o agente que atende e o tempo correndo, segundo a segundo", async () => {
    const b = bancoPadrao();
    b.ligacoes = [
      ligacao({
        status: "em_andamento",
        iniciada_em: new Date(AGORA.getTime() - 65_000).toISOString(),
        encerrada_em: null,
        duracao_s: null,
        resumo: null,
        transcricao: [],
      }),
    ];
    montar(b);
    await carregar();
    fireEvent.click(document.querySelector('[data-ligacao="lg-1"]') as HTMLElement);
    await carregar();
    const detalhe = document.querySelector('[data-lg-detalhe="lg-1"]') as HTMLElement;
    expect(detalhe).toHaveTextContent("Ricardo Lima");
    expect(detalhe).toHaveTextContent("Quem atendeNina");
    const tempo = within(detalhe).getByRole("timer");
    expect(tempo).toHaveTextContent("1 min 5 s até agora");
    await andar(3000);
    expect(tempo).toHaveTextContent("1 min 8 s até agora");
    expect(detalhe).toHaveTextContent("a ElevenLabs entrega as falas só no fim");
  });

  it("o atendente vê a situação pelo agente que atende (o membro não lê parametros)", async () => {
    montar(bancoPadrao(), servidorFalso(), "atendente");
    await carregar();
    expect(
      screen.getByRole("heading", { level: 2, name: `Ativas no ${NUMERO} · quem atende: Nina` }),
    ).toBeTruthy();
  });

  it("sem agente com id na ElevenLabs, o atendente vê as ligações desligadas", async () => {
    const b = bancoPadrao();
    b.agentes = [agente({ id_externo: null })];
    montar(b, servidorFalso(), "atendente");
    await carregar();
    expect(screen.getByRole("heading", { level: 2, name: "Ligações desligadas" })).toBeTruthy();
  });
});

describe("Agentes no banco", () => {
  it("L14: o agente atrás do Contexto mostra o aviso, e Atualizar chama o servidor e relê", async () => {
    const b = bancoPadrao();
    b.agentes = [agente({ sincronizado_em: "2026-11-12T11:00:00.000Z" })];
    const { servidor, f } = montar(b);
    await carregar();
    await abrirAba("Agentes");
    const aviso =
      screen.getByText("Há uma atualização para os agentes").closest("[role]") ?? document.body;
    expect(document.body).toHaveTextContent(
      "O Contexto mudou depois da última atualização dos agentes de voz.",
    );
    expect(document.body).not.toHaveTextContent("Melhoramos a voz e a conversa dos agentes.");
    const antes = f.consultas.filter((c) => c.tabela === "ligacao_agentes").length;
    fireEvent.click(within(aviso as HTMLElement).getByRole("button", { name: "Atualizar" }));
    await carregar();
    expect(servidor.atualizarAgentes).toHaveBeenCalledTimes(1);
    expect(f.consultas.filter((c) => c.tabela === "ligacao_agentes").length).toBeGreaterThan(antes);
  });

  it("em dia com o Contexto e com a versão: sem aviso", async () => {
    montar(bancoPadrao());
    await carregar();
    await abrirAba("Agentes");
    expect(screen.queryByText("Há uma atualização para os agentes")).toBeNull();
  });

  it("a versão antiga mostra o aviso da versão", async () => {
    const b = bancoPadrao();
    b.agentes = [agente({ versao_config: 1 })];
    montar(b);
    await carregar();
    await abrirAba("Agentes");
    expect(document.body).toHaveTextContent("Melhoramos a voz e a conversa dos agentes.");
  });

  it("o agente que ainda não existe na ElevenLabs (versão 0, sem id) não mostra o aviso", async () => {
    const b = bancoPadrao();
    b.agentes = [agente({ id_externo: null, versao_config: 0, sincronizado_em: null })];
    montar(b);
    await carregar();
    await abrirAba("Agentes");
    expect(screen.queryByText("Há uma atualização para os agentes")).toBeNull();
  });

  it("o erro da sincronia aparece no cartão", async () => {
    const b = bancoPadrao();
    b.agentes = [agente({ erro_sincronia: "A ElevenLabs não respondeu como esperado." })];
    montar(b);
    await carregar();
    await abrirAba("Agentes");
    expect(document.body).toHaveTextContent(
      "Não deu para levar a última mudança: A ElevenLabs não respondeu como esperado.",
    );
  });

  it("Atender as ligações chama o servidor com o agente", async () => {
    const b = bancoPadrao();
    b.agentes = [
      agente({}),
      agente({ id: "ag-v", nome: "Vendas", atende: false, id_externo: "agent_2" }),
    ];
    const { servidor } = montar(b);
    await carregar();
    await abrirAba("Agentes");
    fireEvent.click(screen.getByRole("button", { name: "Atender as ligações com Vendas" }));
    await carregar();
    expect(servidor.atender).toHaveBeenCalledWith("ag-v");
  });

  it("Novo agente: a recusa do servidor mostra a frase dele no editor", async () => {
    const frase = "O Contexto ficou grande demais para o agente de voz.";
    const { servidor } = montar(
      bancoPadrao(),
      servidorFalso({
        criarAgente: vi.fn(async () => ({ ok: false, erro: "prompt_grande", mensagem: frase })),
      }),
    );
    await carregar();
    await abrirAba("Agentes");
    fireEvent.click(screen.getByRole("button", { name: "Novo agente" }));
    await carregar();
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Suporte" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar agente" }));
    await carregar();
    expect(servidor.criarAgente).toHaveBeenCalledWith(expect.objectContaining({ nome: "Suporte" }));
    expect(document.querySelector("[data-lg-editor]")).toHaveTextContent(frase);
  });
});

describe("Ajustes no banco", () => {
  it("os limites vêm da configuracao", async () => {
    montar(bancoPadrao());
    await carregar();
    await abrirAba("Ajustes");
    const painel = document.querySelector('[data-painel="ajustes"]') as HTMLElement;
    expect(painel).toHaveTextContent("250");
    expect(painel).toHaveTextContent("7");
  });
});

describe("a ligação no Chat (tipo ligacao, L16)", () => {
  it("o bloco lê a linha de ligacoes da mensagem: título, resumo e a transcrição", async () => {
    montar(
      bancoPadrao(),
      servidorFalso(),
      "admin",
      <BlocoLigacaoDaMensagem
        mensagemId="msg-1"
        texto="Ligação · 2 min 54 s"
        momento={iniciadaHa(30)}
        nomeLead="Ricardo"
      />,
    );
    await carregar();
    const bloco = document.querySelector("[data-ligacao]") as HTMLElement;
    expect(bloco).toHaveAttribute("data-fase", "concluida");
    expect(bloco).toHaveTextContent("Ligação · 2 min 54 s");
    expect(bloco).toHaveTextContent("Ricardo quer orçamento para a loja nova.");
    fireEvent.click(within(bloco).getByRole("button", { name: "Ver transcrição" }));
    const transc = within(bloco).getByRole("region", { name: "Transcrição da ligação" });
    expect(transc).toHaveTextContent("Nina: Oi, Ricardo!");
    expect(transc).toHaveTextContent("Ricardo: Quero um orçamento.");
    expect(transc).not.toHaveTextContent("[excited]");
  });

  it("sem a linha (ainda não chegou), o rótulo da mensagem", async () => {
    montar(
      bancoPadrao(),
      servidorFalso(),
      "admin",
      <BlocoLigacaoDaMensagem
        mensagemId="msg-x"
        texto="Ligação em andamento"
        momento={iniciadaHa(2)}
      />,
    );
    await carregar();
    const bloco = document.querySelector("[data-ligacao]") as HTMLElement;
    expect(bloco).toHaveAttribute("data-fase", "andamento");
    expect(bloco).toHaveTextContent("Ligação em andamento");
    expect(within(bloco).queryByRole("button", { name: "Ver transcrição" })).toBeNull();
  });
});

describe("a ligação viva (L23)", () => {
  const emAndamento = () =>
    ligacao({
      status: "em_andamento",
      iniciada_em: new Date(AGORA.getTime() - 65_000).toISOString(),
      encerrada_em: null,
      duracao_s: null,
      resumo: null,
      transcricao: [],
    });

  it("no Chat: o equalizador, quem atende e o tempo; o fim pelo tempo real troca para o resumo", async () => {
    const b = bancoPadrao();
    b.ligacoes = [emAndamento()];
    const { qc } = montar(
      b,
      servidorFalso(),
      "admin",
      <BlocoLigacaoDaMensagem
        mensagemId="msg-1"
        texto="Ligação em andamento"
        momento={iniciadaHa(1)}
      />,
    );
    await carregar();
    const bloco = document.querySelector("[data-ligacao]") as HTMLElement;
    expect(bloco).toHaveAttribute("data-vivo");
    expect(bloco.querySelector("[data-equalizador]")).toHaveAttribute("aria-hidden", "true");
    expect(bloco).toHaveTextContent("Nina atende · 1 min 5 s até agora");
    await andar(2000);
    expect(bloco).toHaveTextContent("1 min 7 s até agora");
    // o pós-chamada chega (o tempo real relê a linha)
    b.ligacoes = [ligacao({})];
    await act(async () => {
      await qc.invalidateQueries();
    });
    await carregar();
    expect(bloco).not.toHaveAttribute("data-vivo");
    expect(bloco.querySelector("[data-equalizador]")).toBeNull();
    expect(bloco).toHaveTextContent("Ricardo quer orçamento para a loja nova.");
  });

  it("no Histórico: a linha tem o equalizador; a aberta é um cartão vivo, sem o 'por que terminou'", async () => {
    const b = bancoPadrao();
    b.ligacoes = [emAndamento()];
    const { qc } = montar(b);
    await carregar();
    const linha = document.querySelector('[data-ligacao="lg-1"]') as HTMLElement;
    expect(linha.querySelector("[data-equalizador]")).not.toBeNull();
    fireEvent.click(linha);
    await carregar();
    let detalhe = document.querySelector('[data-lg-detalhe="lg-1"]') as HTMLElement;
    expect(detalhe).toHaveAttribute("data-andamento");
    expect(detalhe.querySelector("[data-lg-vivo]")).toHaveTextContent("Em andamento");
    expect(detalhe).not.toHaveTextContent("Por que terminou");
    b.ligacoes = [ligacao({})];
    await act(async () => {
      await qc.invalidateQueries();
    });
    await carregar();
    detalhe = document.querySelector('[data-lg-detalhe="lg-1"]') as HTMLElement;
    expect(detalhe).not.toHaveAttribute("data-andamento");
    expect(detalhe.querySelector("[data-lg-vivo]")).toBeNull();
    expect(detalhe).toHaveTextContent("Por que terminouO contato desligou");
    // a conversa: o agente de um lado, o lead do outro
    const falas = within(detalhe).getAllByRole("listitem");
    expect(falas.map((f) => f.getAttribute("data-papel"))).toEqual(["agente", "lead"]);
  });
});

describe("os cartões dos agentes", () => {
  it("sem voz própria, o cartão mostra a voz da Nina (o cartão Voz, L37)", async () => {
    const b = bancoPadrao();
    b.agentes = [agente({ voz_id: null, voz_nome: null })];
    montar(b);
    await carregar();
    await abrirAba("Agentes");
    expect(document.querySelector('[data-agente="ag-nina"]')).toHaveTextContent(
      "VozVoz de teste (a voz da Nina)",
    );
  });
});

describe("o Contexto salvo leva os agentes (L14)", () => {
  function Salvar() {
    const acoes = useAcoesContextoBanco();
    return (
      <button type="button" onClick={() => void acoes.salvar(3, { preco: "R$ 2.000" })}>
        salvar contexto
      </button>
    );
  }

  it("depois de salvar, chama a sincronia dos agentes sem esperar por ela", async () => {
    let soltar: () => void = () => {};
    const servidor = servidorFalso({
      sincronizarContexto: vi.fn(
        () => new Promise<unknown>((r) => (soltar = () => r({ ok: true }))),
      ),
    });
    const f = clienteDo(bancoPadrao());
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const original = f.cliente.rpc.bind(f.cliente);
    (f.cliente as unknown as { rpc: unknown }).rpc = (nome: string, args: unknown) =>
      nome === "contexto_salvar"
        ? Promise.resolve({ data: { id: 4, numero: 4 }, error: null })
        : original(nome as never, args as never);
    render(
      <QueryClientProvider client={qc}>
        <ProvedorPapel papel="admin">
          <ProvedorDados fonte="banco" cliente={f.cliente}>
            <ServidorLigacoesContexto.Provider value={servidor}>
              <Salvar />
            </ServidorLigacoesContexto.Provider>
          </ProvedorDados>
        </ProvedorPapel>
      </QueryClientProvider>,
    );
    await carregar();
    fireEvent.click(screen.getByRole("button", { name: "salvar contexto" }));
    await carregar();
    expect(servidor.sincronizarContexto).toHaveBeenCalledTimes(1);
    // a sincronia ainda não respondeu, e o salvar já terminou (nada pendurado)
    await act(async () => soltar());
  });
});

describe("L43: as ligações da primeira versão (ativas, sem nenhum agente na lista)", () => {
  it("o admin abre a área: o app traz o agente do tronco como Nina, uma vez, sem clicar em nada", async () => {
    const b = bancoPadrao();
    b.agentes = [];
    let soltar: () => void = () => undefined;
    const adotar = vi.fn(
      () =>
        new Promise((r) => {
          soltar = () => {
            b.agentes = [agente({})];
            r({ ok: true, id: "ag-nina" });
          };
        }),
    );
    const { servidor } = montar(b, servidorFalso({ adotarAgenteDoTronco: adotar }));
    await carregar();
    expect(servidor.adotarAgenteDoTronco).toHaveBeenCalledTimes(1);
    await abrirAba("Agentes");
    // enquanto prepara: o carregando, e nunca a promessa do "nasce quando você ativa"
    expect(
      screen.getByRole("status", { name: "Trazendo o agente que já atende as ligações" }),
    ).toBeTruthy();
    expect(document.body).not.toHaveTextContent("nasce quando você ativa");
    expect(screen.getByRole("button", { name: "Novo agente" })).toBeDisabled();
    await act(async () => soltar());
    await carregar();
    expect(document.querySelector('[data-agente="ag-nina"]')).toHaveTextContent(
      "Atende as ligações",
    );
    // trocar de aba e voltar não chama de novo
    await abrirAba("Histórico");
    await abrirAba("Agentes");
    expect(servidor.adotarAgenteDoTronco).toHaveBeenCalledTimes(1);
  });

  it("não deu para trazer: o vazio diz que as ligações já estão ativas", async () => {
    const b = bancoPadrao();
    b.agentes = [];
    montar(
      b,
      servidorFalso({
        adotarAgenteDoTronco: vi.fn(async () => ({ ok: false, erro: "provedor_fora" })),
      }),
    );
    await carregar();
    await abrirAba("Agentes");
    expect(document.body).toHaveTextContent(VAZIO_AGENTES_ATIVAS);
    expect(document.body).not.toHaveTextContent(VAZIO_AGENTES_DESLIGADAS);
  });

  it("com o agente que atende já na lista, não chama; o atendente nunca chama", async () => {
    const { servidor } = montar(bancoPadrao());
    await carregar();
    expect(servidor.adotarAgenteDoTronco).not.toHaveBeenCalled();
    cleanup();
    const b = bancoPadrao();
    b.agentes = [];
    const outro = montar(b, servidorFalso(), "atendente");
    await carregar();
    expect(outro.servidor.adotarAgenteDoTronco).not.toHaveBeenCalled();
  });
});
