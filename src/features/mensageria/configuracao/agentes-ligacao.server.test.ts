import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Fetch } from "@/features/servidor/http";
import { VERSAO_AGENTE } from "@/features/servidor/ligacoes-elevenlabs";

import type { ClienteUsuario, ContextoUsuario } from "../configuracao.server";
import type { LinhaAgente, Sincronia } from "../ligacoes/agentes-banco.server";
import {
  AGENTE_PADRAO,
  LIMITES_PADRAO,
  type AgenteVoz,
  type LigacoesGravadas,
  type LimitesLigacoes,
} from "../ligacoes/tipos";

// Os agentes de voz da área Ligações (2.2): o banco em memória, a rede
// falsa e a conexão ativa com as ligações (ou sem elas).
const falso = vi.hoisted(() => ({
  /** O erro que o atualizarCamposAgente falso lança (null = grava). */
  falhaSalvar: null as string | null,
  /** Os agentes com ligação em andamento (o ligacao_agente_soltar falso recusa). */
  emLigacao: [] as string[],
  /** a versão da linha (o atualizado_em que o gatilho renova) */
  versao: 0,
  agentes: [] as LinhaAgente[],
  limites: null as LimitesLigacoes | null,
  ligacoes: null as LigacoesGravadas | null,
  contexto: { texto: "Empresa e oferta: Consultoria de IA", criadoEm: "2026-11-10T10:00:00.000Z" },
  gravadas: [] as LigacoesGravadas[],
  chave: "sk_eleven_AGENTES_CHAVE_123" as string | null,
  atenderFalha: false,
  /** quantas gravações de sincronia ainda lançam (o banco fora) */
  sincroniaFalhas: 0,
  /** roda no começo de cada gravarLigacoes (o que outra requisição grava ao mesmo tempo) */
  aoGravarLigacoes: null as null | (() => void),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy(
    {},
    {
      get: () => {
        throw new Error("banco real não pode ser usado");
      },
    },
  ),
}));
vi.mock("../ligacoes/agentes-banco.server", () => ({
  listarAgentes: async () => structuredClone(falso.agentes),
  // o ligacao_agente_soltar falso: confere e solta o id na mesma "transação"
  soltarAgente: async (id: string) => {
    const a = falso.agentes.find((x) => x.id === id);
    if (!a) return { ok: false, motivo: "nao_encontrado" };
    if (a.atende) return { ok: false, motivo: "atende" };
    if (falso.emLigacao.includes(id)) return { ok: false, motivo: "em_ligacao" };
    const idExterno = a.idExterno;
    a.idExterno = null;
    a.sincronizadoEm = null;
    return { ok: true, idExterno };
  },
  lerAgente: async (id: string) => structuredClone(falso.agentes.find((a) => a.id === id) ?? null),
  inserirAgente: async (campos: AgenteVoz, d: { atende: boolean }) => {
    // o índice único parcial: um só atende
    if (d.atende && falso.agentes.some((a) => a.atende))
      throw new Error("banco_criar_agente:23505");
    const linha: LinhaAgente = {
      ...campos,
      id: `ag_${falso.agentes.length + 1}`,
      atende: d.atende,
      idExterno: null,
      versaoConfig: 0,
      sincronizadoEm: null,
      erroSincronia: null,
      criadoEm: "2026-11-12T00:00:00.000Z",
      atualizadoEm: `v${++falso.versao}`,
    };
    falso.agentes.push(linha);
    return structuredClone(linha);
  },
  atualizarCamposAgente: async (id: string, campos: AgenteVoz) => {
    if (falso.falhaSalvar) throw new Error(falso.falhaSalvar);
    const a = falso.agentes.find((x) => x.id === id);
    if (!a) return null;
    Object.assign(a, campos, { atualizadoEm: `v${++falso.versao}` });
    return structuredClone(a);
  },
  gravarSincronia: async (id: string, s: Sincronia) => {
    const a = falso.agentes.find((x) => x.id === id);
    if (!a) return false;
    if (falso.sincroniaFalhas > 0) {
      falso.sincroniaFalhas -= 1;
      throw new Error("banco_sincronia_agente");
    }
    if (s.seAtualizadoEm !== undefined && a.atualizadoEm !== s.seAtualizadoEm) return false;
    if (s.seIdExterno !== undefined && a.idExterno !== s.seIdExterno) return false;
    a.atualizadoEm = `v${++falso.versao}`;
    if (s.idExterno !== undefined) a.idExterno = s.idExterno;
    if (s.versaoConfig !== undefined) a.versaoConfig = s.versaoConfig;
    if (s.sincronizadoEm !== undefined) a.sincronizadoEm = s.sincronizadoEm;
    a.erroSincronia = s.erroSincronia;
    return true;
  },
  apagarLinhaAgente: async (
    id: string,
    o: { mesmoQueAtende?: boolean; soSemId?: boolean } = {},
  ) => {
    const antes = falso.agentes.length;
    falso.agentes = falso.agentes.filter(
      (a) =>
        a.id !== id ||
        (a.atende && !o.mesmoQueAtende) ||
        (o.soSemId === true && a.idExterno !== null),
    );
    return falso.agentes.length < antes;
  },
  atenderAgente: async (id: string) => {
    if (falso.atenderFalha) throw new Error("banco_atender_agente");
    for (const a of falso.agentes) {
      if (a.atende !== (a.id === id)) a.atualizadoEm = `v${++falso.versao}`;
      a.atende = a.id === id;
    }
  },
  lerLimites: async () => falso.limites ?? LIMITES_PADRAO,
  gravarLimites: async (l: LimitesLigacoes) => {
    falso.limites = l;
  },
}));
vi.mock("../ligacoes/banco.server", () => ({
  lerContextoAtual: async () => ({ ...falso.contexto }),
}));
vi.mock("../nucleo/conexoes.server", () => ({
  conexaoAtiva: async () =>
    falso.ligacoes
      ? {
          id: CONEXAO,
          gateway: "meta",
          id_externo: "106",
          oficial: true,
          parametros: { phoneId: "106", ligacoes: structuredClone(falso.ligacoes) },
          segredos: {},
        }
      : null,
  lerChaveIA: async () =>
    falso.chave
      ? { id: "k1", provedor: "elevenlabs", modelo: "", workspace_id: null, chave: falso.chave }
      : null,
}));
vi.mock("./banco.server", () => ({
  lerConfigVozTela: async () => ({
    modo: "quando_audio",
    voz: { id: "vozCartao", nome: "Ana" },
    erro: null,
  }),
}));
vi.mock("./ligacoes-banco.server", () => ({
  gravarLigacoes: async (_id: string, estado: LigacoesGravadas, anterior: string | null) => {
    falso.aoGravarLigacoes?.();
    if (falso.ligacoes?.atualizadaEm !== anterior) return false;
    falso.ligacoes = estado;
    falso.gravadas.push(estado);
    return true;
  },
}));

const {
  adotarAgenteDoTroncoLogica,
  apagarAgenteLigacaoLogica,
  atenderAgenteLigacaoLogica,
  atualizarAgentesLigacaoLogica,
  criarAgenteLigacaoLogica,
  lerCamposAgente,
  salvarAgenteLigacaoLogica,
  salvarLimitesLigacoesLogica,
  sincronizarContextoLigacaoLogica,
  sincronizarVozLigacaoLogica,
} = await import("./agentes-ligacao.server");

const CONEXAO = "c0ffee00-0000-4000-8000-0000000000aa";
const EL = "https://api.elevenlabs.io";

function contexto(admin = true): ContextoUsuario {
  const consulta = {
    select: () => consulta,
    eq: () => consulta,
    maybeSingle: async () => ({ data: { id: "membro-1" }, error: null }),
  };
  const supabase = {
    rpc: vi.fn(async () => ({ data: admin, error: null })),
    from: vi.fn(() => consulta),
  } as unknown as ClienteUsuario;
  return { supabase, userId: "user-1" };
}

function ativas(): LigacoesGravadas {
  return {
    versao: 1,
    situacao: "ativa",
    origem: "https://nina.exemplo.com",
    numero: "5511999990000",
    limiteMeta: "TIER_2K",
    ativadaEm: "2026-11-11T12:00:00.000Z",
    eleven: {
      segredoId: "seg_1",
      webhookId: "wh_1",
      ferramentaId: "tool_1",
      agenteId: "agent_1",
      troncoId: "phnum_1",
    },
    metaSip: true,
    pendencias: [],
    atualizadaEm: "2026-11-11T12:00:00.000Z",
  };
}

function agente(o: Partial<LinhaAgente>): LinhaAgente {
  return {
    ...AGENTE_PADRAO,
    id: "ag_x",
    atende: false,
    idExterno: null,
    versaoConfig: 1,
    sincronizadoEm: null,
    erroSincronia: null,
    criadoEm: "2026-11-01T00:00:00.000Z",
    atualizadoEm: "v0",
    ...o,
  };
}

const CAMPOS = {
  nome: "Vendas",
  uso: "receber",
  objetivo: "vendas",
  instrucoes: "Ofereça o plano anual.",
  regrasEquipe: null,
  vozId: "vozVendas",
  vozNome: "Bruno",
  perfil: "rapido",
  saudacao: "Oi, {nome}! Aqui é o time de vendas.",
  duracaoMaxS: 600,
  silencioS: 25,
};

type Chamada = { chave: string; corpo: unknown };

type Resposta = { status: number; corpo?: unknown; antes?: () => void };

function rede(respostas: Record<string, Resposta[]>) {
  const chamadas: Chamada[] = [];
  const fetch: Fetch = async (url, init) => {
    const chave = `${init?.method ?? "GET"} ${url}`;
    chamadas.push({
      chave,
      corpo: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const r = respostas[chave]?.shift();
    if (!r) throw new Error(`pedido não esperado: ${chave}`);
    r.antes?.();
    const texto = r.corpo === undefined ? "" : JSON.stringify(r.corpo);
    return { status: r.status, text: async () => texto } as unknown as Response;
  };
  return { fetch, chamadas };
}

beforeEach(() => {
  falso.emLigacao = [];
  falso.falhaSalvar = null;
  falso.agentes = [];
  falso.limites = null;
  falso.ligacoes = null;
  falso.gravadas = [];
  falso.chave = "sk_eleven_AGENTES_CHAVE_123";
  falso.atenderFalha = false;
  falso.sincroniaFalhas = 0;
  falso.aoGravarLigacoes = null;
  falso.contexto = {
    texto: "Empresa e oferta: Consultoria de IA",
    criadoEm: "2026-11-10T10:00:00.000Z",
  };
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("lerCamposAgente", () => {
  it("apara e aceita os campos nas faixas", () => {
    expect(lerCamposAgente({ ...CAMPOS, nome: "  Vendas  " })).toEqual({
      ok: true,
      campos: { ...CAMPOS, nome: "Vendas" },
    });
  });

  it.each([
    [{ nome: "" }, "nome"],
    [{ nome: "x".repeat(61) }, "nome"],
    [{ uso: "atender" }, "para que serve"],
    [{ objetivo: "outra" }, "objetivo"],
    [{ instrucoes: "x".repeat(4001) }, "instruções"],
    [{ regrasEquipe: "   " }, "regras"],
    [{ vozId: "voz com espaço" }, "voz"],
    [{ perfil: "turbo" }, "perfil"],
    [{ saudacao: "" }, "saudação"],
    [{ duracaoMaxS: 100 }, "duração"],
    [{ silencioS: 61 }, "silêncio"],
    [{ silencioS: 25.5 }, "silêncio"],
  ])("recusa %j", (mudanca, palavra) => {
    const r = lerCamposAgente({ ...CAMPOS, ...mudanca });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.erro).toBe("campos_invalidos");
    expect(!r.ok && r.mensagem.toLowerCase()).toContain(palavra);
  });
});

describe("Receptivo e Ativo (A1)", () => {
  it("o primeiro agente atende, então tem de ser Receptivo; depois dele, um Ativo nasce sem atender", async () => {
    const { fetch, chamadas } = rede({});
    const ativo = { ...CAMPOS, nome: "Retorno", uso: "ligar" };
    const r0 = await criarAgenteLigacaoLogica(contexto(), ativo, { fetch });
    expect(r0).toMatchObject({ ok: false, erro: "campos_invalidos" });
    expect(!r0.ok && r0.mensagem).toContain("Receptivo");
    expect(falso.agentes).toHaveLength(0);
    await criarAgenteLigacaoLogica(contexto(), CAMPOS, { fetch });
    expect(await criarAgenteLigacaoLogica(contexto(), ativo, { fetch })).toMatchObject({
      ok: true,
    });
    expect(falso.agentes.map((a) => [a.nome, a.uso, a.atende])).toEqual([
      ["Vendas", "receber", true],
      ["Retorno", "ligar", false],
    ]);
    expect(chamadas).toHaveLength(0);
  });

  it("o Ativo não atende o número; o que atende não vira Ativo; o Receptivo que não atende vira", async () => {
    falso.agentes = [
      agente({ id: "ag_a", atende: true }),
      agente({ id: "ag_b", uso: "ligar" }),
      agente({ id: "ag_c" }),
    ];
    const { fetch, chamadas } = rede({});
    const atender = await atenderAgenteLigacaoLogica(contexto(), "ag_b", { fetch });
    expect(atender).toMatchObject({ ok: false, erro: "campos_invalidos" });
    expect(!atender.ok && atender.mensagem).toContain("Ativo");
    const virar = await salvarAgenteLigacaoLogica(
      contexto(),
      "ag_a",
      { ...CAMPOS, uso: "ligar" },
      { fetch },
    );
    expect(virar).toMatchObject({ ok: false, erro: "campos_invalidos" });
    expect(falso.agentes.map((a) => [a.id, a.uso, a.atende])).toEqual([
      ["ag_a", "receber", true],
      ["ag_b", "ligar", false],
      ["ag_c", "receber", false],
    ]);
    expect(
      await salvarAgenteLigacaoLogica(contexto(), "ag_c", { ...CAMPOS, uso: "ligar" }, { fetch }),
    ).toMatchObject({ ok: true });
    expect(falso.agentes.find((a) => a.id === "ag_c")?.uso).toBe("ligar");
    expect(chamadas).toHaveLength(0);
  });
});

describe("as corridas do uso (Opus, PR #26)", () => {
  it("sem o uso (uma aba antiga): o agente fica com o uso atual", async () => {
    falso.agentes = [agente({ id: "ag_a", atende: true }), agente({ id: "ag_b", uso: "ligar" })];
    const { uso: _uso, ...semUso } = CAMPOS;
    const { fetch } = rede({});
    expect(await salvarAgenteLigacaoLogica(contexto(), "ag_b", semUso, { fetch })).toMatchObject({
      ok: true,
    });
    expect(falso.agentes.find((a) => a.id === "ag_b")?.uso).toBe("ligar");
    expect(lerCamposAgente(semUso)).toMatchObject({ ok: true, campos: { uso: "receber" } });
  });

  it("o banco recusa pelo check do uso (salvar e Atender ao mesmo tempo): a mensagem do uso", async () => {
    falso.agentes = [agente({ id: "ag_a", atende: true }), agente({ id: "ag_b" })];
    falso.falhaSalvar = "banco_salvar_agente:23514";
    const { fetch } = rede({});
    const r = await salvarAgenteLigacaoLogica(
      contexto(),
      "ag_b",
      { ...CAMPOS, uso: "ligar" },
      { fetch },
    );
    expect(r).toMatchObject({ ok: false, erro: "campos_invalidos" });
    expect(!r.ok && r.mensagem).toContain("mudou ao mesmo tempo");
  });
});

describe("o apagar que falha lá devolve o id com o aviso de antes (Opus, PR #26)", () => {
  it("o erro da sincronia de antes continua na linha", async () => {
    falso.ligacoes = ativas();
    falso.agentes = [
      agente({ id: "ag_nina", atende: true, idExterno: "agent_1" }),
      agente({
        id: "ag_v",
        uso: "ligar",
        idExterno: "agent_2",
        erroSincronia: "A ElevenLabs recusou.",
      }),
    ];
    const { fetch } = rede({ [`DELETE ${EL}/v1/convai/agents/agent_2`]: [{ status: 500 }] });
    expect(await apagarAgenteLigacaoLogica(contexto(), "ag_v", { fetch })).toMatchObject({
      ok: false,
      erro: "provedor_fora",
    });
    expect(falso.agentes.find((a) => a.id === "ag_v")).toMatchObject({
      idExterno: "agent_2",
      erroSincronia: "A ElevenLabs recusou.",
    });
  });
});

describe("uma sincronia recria o agente enquanto o apagar espera a ElevenLabs (Opus, PR #26)", () => {
  it("a linha com o agente novo não sai: ele não fica órfão, e a mensagem pede para tentar de novo", async () => {
    falso.ligacoes = ativas();
    falso.agentes = [
      agente({ id: "ag_nina", atende: true, idExterno: "agent_1" }),
      agente({ id: "ag_v", uso: "ligar", idExterno: "agent_2" }),
    ];
    const { fetch } = rede({
      [`DELETE ${EL}/v1/convai/agents/agent_2`]: [
        {
          status: 204,
          antes: () => {
            falso.agentes.find((a) => a.id === "ag_v")!.idExterno = "agent_3";
          },
        },
      ],
    });
    const r = await apagarAgenteLigacaoLogica(contexto(), "ag_v", { fetch });
    expect(r).toMatchObject({ ok: false, erro: "erro_ao_gravar" });
    expect(falso.agentes.find((a) => a.id === "ag_v")?.idExterno).toBe("agent_3");
  });
});

describe("dois admins apagam o mesmo agente, e o apagar lá falha (Sol, PR #26)", () => {
  it("a linha saiu no meio: o id não volta, e a mensagem diz que o agente ficou na ElevenLabs", async () => {
    falso.ligacoes = ativas();
    falso.agentes = [
      agente({ id: "ag_nina", atende: true, idExterno: "agent_1" }),
      agente({ id: "ag_v", uso: "ligar", idExterno: "agent_2" }),
    ];
    const { fetch } = rede({
      [`DELETE ${EL}/v1/convai/agents/agent_2`]: [
        {
          status: 500,
          // o outro admin apaga a linha enquanto este espera a ElevenLabs
          antes: () => {
            falso.agentes = falso.agentes.filter((a) => a.id !== "ag_v");
          },
        },
      ],
    });
    const r = await apagarAgenteLigacaoLogica(contexto(), "ag_v", { fetch });
    expect(r).toMatchObject({ ok: false, erro: "provedor_fora" });
    expect(!r.ok && r.mensagem).toContain("Apague o agente por lá");
  });
});

describe("apagar com ligação em andamento (Sol, PR #26)", () => {
  it("recusa: apagar lá derrubaria a ligação", async () => {
    falso.agentes = [agente({ id: "ag_a", atende: true }), agente({ id: "ag_b", uso: "ligar" })];
    falso.emLigacao = ["ag_b"];
    const { fetch, chamadas } = rede({});
    const r = await apagarAgenteLigacaoLogica(contexto(), "ag_b", { fetch });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.mensagem).toContain("numa ligação");
    expect(falso.agentes.map((a) => a.id)).toEqual(["ag_a", "ag_b"]);
    expect(chamadas).toHaveLength(0);
  });
});

describe("só o admin", () => {
  it("sem admin: sem_acesso, sem mexer em nada", async () => {
    const r = await criarAgenteLigacaoLogica(contexto(false), CAMPOS);
    expect(r).toMatchObject({ ok: false, erro: "sem_acesso" });
    expect(falso.agentes).toHaveLength(0);
  });
});

describe("sem as ligações ativas: só a linha muda", () => {
  it("criar: o primeiro atende, o segundo não; nada vai à rede", async () => {
    const { fetch, chamadas } = rede({});
    const r1 = await criarAgenteLigacaoLogica(contexto(), CAMPOS, { fetch });
    const r2 = await criarAgenteLigacaoLogica(
      contexto(),
      { ...CAMPOS, nome: "Suporte" },
      { fetch },
    );
    expect(r1).toEqual({ ok: true, id: "ag_1" });
    expect(r2).toEqual({ ok: true, id: "ag_2" });
    expect(falso.agentes.map((a) => [a.nome, a.atende, a.idExterno])).toEqual([
      ["Vendas", true, null],
      ["Suporte", false, null],
    ]);
    expect(chamadas).toHaveLength(0);
  });

  it("atender: só a ligacao_agente_atender", async () => {
    falso.agentes = [agente({ id: "ag_a", atende: true }), agente({ id: "ag_b" })];
    const { fetch, chamadas } = rede({});
    expect(await atenderAgenteLigacaoLogica(contexto(), "ag_b", { fetch })).toEqual({
      ok: true,
      id: "ag_b",
    });
    expect(falso.agentes.map((a) => a.atende)).toEqual([false, true]);
    expect(chamadas).toHaveLength(0);
  });

  it("atualizar não faz nada", async () => {
    falso.agentes = [agente({ id: "ag_a" })];
    const { fetch, chamadas } = rede({});
    expect(await atualizarAgentesLigacaoLogica(contexto(), { fetch })).toEqual({ ok: true });
    expect(chamadas).toHaveLength(0);
  });
});

describe("com as ligações ativas: cada agente é um agente na ElevenLabs (L10)", () => {
  beforeEach(() => {
    falso.ligacoes = ativas();
    falso.agentes = [agente({ id: "ag_nina", nome: "Nina", atende: true, idExterno: "agent_1" })];
  });

  it("o agente ainda ligado ao tronco (um Atender pela metade) não vira Ativo (Opus, PR #26)", async () => {
    falso.agentes.push(agente({ id: "ag_v", idExterno: "agent_2" }));
    falso.ligacoes!.eleven.agenteId = "agent_2";
    const { fetch, chamadas } = rede({});
    const r = await salvarAgenteLigacaoLogica(
      contexto(),
      "ag_v",
      { ...CAMPOS, uso: "ligar" },
      { fetch },
    );
    expect(r).toMatchObject({ ok: false, erro: "campos_invalidos" });
    expect(falso.agentes.find((a) => a.id === "ag_v")?.uso).toBe("receber");
    expect(chamadas).toHaveLength(0);
  });

  it("criar cria lá, com a voz, o perfil, o Contexto e os limites; grava id, versão e a sincronia", async () => {
    falso.limites = { simultaneas: 4, porDia: 50, porContato: 3 };
    const { fetch, chamadas } = rede({
      [`POST ${EL}/v1/convai/agents/create`]: [{ status: 200, corpo: { agent_id: "agent_9" } }],
    });
    const r = await criarAgenteLigacaoLogica(contexto(), CAMPOS, { fetch });
    expect(r).toEqual({ ok: true, id: "ag_2" });
    const corpo = chamadas[0]!.corpo as {
      name: string;
      conversation_config: {
        tts: { voice_id: string };
        agent: { prompt: { prompt: string; llm: string } };
      };
      platform_settings: { call_limits: { agent_concurrency_limit: number; daily_limit: number } };
    };
    expect(corpo.name).toBe("Nina (ligações) c0ffee00 · Vendas");
    expect(corpo.conversation_config.tts.voice_id).toBe("vozVendas");
    expect(corpo.conversation_config.agent.prompt.llm).toBe("gemini-3.1-flash-lite");
    expect(corpo.conversation_config.agent.prompt.prompt).toContain("Ofereça o plano anual.");
    expect(corpo.conversation_config.agent.prompt.prompt).toContain("Consultoria de IA");
    expect(corpo.platform_settings.call_limits).toMatchObject({
      agent_concurrency_limit: 4,
      daily_limit: 50,
    });
    expect(falso.agentes[1]).toMatchObject({
      atende: false,
      idExterno: "agent_9",
      versaoConfig: VERSAO_AGENTE,
      erroSincronia: null,
      sincronizadoEm: expect.stringMatching(/^\d{4}-/),
    });
  });

  it("criar que falha lá não deixa a linha", async () => {
    const { fetch } = rede({ [`POST ${EL}/v1/convai/agents/create`]: [{ status: 500 }] });
    const r = await criarAgenteLigacaoLogica(contexto(), CAMPOS, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "provedor_fora" });
    expect(falso.agentes).toHaveLength(1);
  });

  it("sem voz própria, a voz do cartão Voz", async () => {
    const { fetch, chamadas } = rede({
      [`POST ${EL}/v1/convai/agents/create`]: [{ status: 200, corpo: { agent_id: "agent_9" } }],
    });
    await criarAgenteLigacaoLogica(contexto(), { ...CAMPOS, vozId: null }, { fetch });
    expect(chamadas[0]!.corpo).toMatchObject({
      conversation_config: { tts: { voice_id: "vozCartao" } },
    });
  });

  it("salvar atualiza lá (PATCH); a falha deixa a mudança salva e o erro na linha", async () => {
    const { fetch, chamadas } = rede({
      [`PATCH ${EL}/v1/convai/agents/agent_1`]: [{ status: 200, corpo: {} }, { status: 404 }],
    });
    expect(await salvarAgenteLigacaoLogica(contexto(), "ag_nina", CAMPOS, { fetch })).toEqual({
      ok: true,
      id: "ag_nina",
    });
    expect(chamadas[0]!.corpo).toMatchObject({ name: "Nina (ligações) c0ffee00 · Vendas" });
    expect(falso.agentes[0]).toMatchObject({ nome: "Vendas", versaoConfig: VERSAO_AGENTE });

    const r = await salvarAgenteLigacaoLogica(
      contexto(),
      "ag_nina",
      { ...CAMPOS, nome: "X" },
      { fetch },
    );
    expect(r).toMatchObject({ ok: false, erro: "agente_nao_encontrado" });
    expect(!r.ok && r.mensagem).toMatch(
      /^A mudança ficou salva, mas não chegou ao agente de voz\./,
    );
    expect(falso.agentes[0]).toMatchObject({
      nome: "X",
      erroSincronia: expect.stringContaining("não existe mais"),
    });
  });

  it("salvar um agente que não existe: nao_encontrado", async () => {
    const r = await salvarAgenteLigacaoLogica(contexto(), "ag_sumiu", CAMPOS);
    expect(r).toMatchObject({ ok: false, erro: "nao_encontrado" });
  });

  it("apagar: o que atende não; os outros saem lá e aqui", async () => {
    falso.agentes.push(agente({ id: "ag_v", idExterno: "agent_2" }));
    const { fetch, chamadas } = rede({
      [`DELETE ${EL}/v1/convai/agents/agent_2`]: [{ status: 500 }, { status: 204 }],
    });
    expect(await apagarAgenteLigacaoLogica(contexto(), "ag_nina", { fetch })).toMatchObject({
      ok: false,
      erro: "agente_que_atende",
    });
    expect(await apagarAgenteLigacaoLogica(contexto(), "ag_v", { fetch })).toMatchObject({
      ok: false,
      erro: "provedor_fora",
    });
    expect(falso.agentes).toHaveLength(2);
    // o agente continua lá: o id voltou para a linha (Sol, PR #26)
    expect(falso.agentes.find((a) => a.id === "ag_v")?.idExterno).toBe("agent_2");
    expect(await apagarAgenteLigacaoLogica(contexto(), "ag_v", { fetch })).toEqual({
      ok: true,
      id: "ag_v",
    });
    expect(falso.agentes.map((a) => a.id)).toEqual(["ag_nina"]);
    expect(chamadas).toHaveLength(2);
  });

  it("atender (L11): o tronco passa para o agente, o banco grava e parametros acompanha", async () => {
    falso.agentes.push(agente({ id: "ag_v", idExterno: "agent_2" }));
    const { fetch, chamadas } = rede({
      [`PATCH ${EL}/v1/convai/phone-numbers/phnum_1`]: [{ status: 200, corpo: {} }],
    });
    expect(await atenderAgenteLigacaoLogica(contexto(), "ag_v", { fetch })).toEqual({
      ok: true,
      id: "ag_v",
    });
    expect(chamadas.map((c) => c.corpo)).toEqual([{ agent_id: "agent_2" }]);
    expect(falso.agentes.map((a) => [a.id, a.atende])).toEqual([
      ["ag_nina", false],
      ["ag_v", true],
    ]);
    expect(falso.ligacoes!.eleven.agenteId).toBe("agent_2");
  });

  it("atender um agente que ainda não existe lá: cria e depois troca o tronco", async () => {
    falso.agentes.push(agente({ id: "ag_v", idExterno: null }));
    const { fetch, chamadas } = rede({
      [`POST ${EL}/v1/convai/agents/create`]: [{ status: 200, corpo: { agent_id: "agent_7" } }],
      [`PATCH ${EL}/v1/convai/phone-numbers/phnum_1`]: [{ status: 200, corpo: {} }],
    });
    expect(await atenderAgenteLigacaoLogica(contexto(), "ag_v", { fetch })).toMatchObject({
      ok: true,
    });
    expect(chamadas.map((c) => c.chave)).toEqual([
      `POST ${EL}/v1/convai/agents/create`,
      `PATCH ${EL}/v1/convai/phone-numbers/phnum_1`,
    ]);
    expect(falso.ligacoes!.eleven.agenteId).toBe("agent_7");
  });

  it("atender com o tronco recusado não muda o banco; com o banco fora, o tronco volta", async () => {
    falso.agentes.push(agente({ id: "ag_v", idExterno: "agent_2" }));
    const tronco = `PATCH ${EL}/v1/convai/phone-numbers/phnum_1`;
    const { fetch, chamadas } = rede({
      [tronco]: [{ status: 500 }, { status: 200, corpo: {} }, { status: 200, corpo: {} }],
    });
    expect(await atenderAgenteLigacaoLogica(contexto(), "ag_v", { fetch })).toMatchObject({
      ok: false,
    });
    expect(falso.agentes[0]!.atende).toBe(true);
    falso.atenderFalha = true;
    expect(await atenderAgenteLigacaoLogica(contexto(), "ag_v", { fetch })).toMatchObject({
      ok: false,
      erro: "erro_ao_gravar",
    });
    expect(chamadas.slice(1).map((c) => c.corpo)).toEqual([
      { agent_id: "agent_2" },
      { agent_id: "agent_1" },
    ]);
    expect(falso.ligacoes!.eleven.agenteId).toBe("agent_1");
  });

  it("atualizar (L13): todos os agentes vão para a versão do código; quem não existe lá é criado", async () => {
    falso.agentes.push(agente({ id: "ag_v", idExterno: null, versaoConfig: 0 }));
    falso.agentes[0]!.versaoConfig = 1;
    const { fetch, chamadas } = rede({
      [`PATCH ${EL}/v1/convai/agents/agent_1`]: [{ status: 200, corpo: {} }],
      [`POST ${EL}/v1/convai/agents/create`]: [{ status: 200, corpo: { agent_id: "agent_8" } }],
    });
    expect(await atualizarAgentesLigacaoLogica(contexto(), { fetch })).toEqual({ ok: true });
    expect(chamadas).toHaveLength(2);
    expect(falso.agentes.map((a) => [a.idExterno, a.versaoConfig])).toEqual([
      ["agent_1", VERSAO_AGENTE],
      ["agent_8", VERSAO_AGENTE],
    ]);
  });

  it("atualizar com falha: diz quantos não foram", async () => {
    falso.agentes.push(agente({ id: "ag_v", idExterno: "agent_2" }));
    const { fetch } = rede({
      [`PATCH ${EL}/v1/convai/agents/agent_1`]: [{ status: 500 }],
      [`PATCH ${EL}/v1/convai/agents/agent_2`]: [{ status: 500 }],
    });
    const r = await atualizarAgentesLigacaoLogica(contexto(), { fetch });
    expect(r).toMatchObject({ ok: false, erro: "provedor_fora" });
    expect(!r.ok && r.mensagem).toMatch(/^2 agentes não foram atualizados\./);
  });

  it("o Contexto salvo (L14): só os agentes atrás dele recebem o PATCH com o Contexto novo", async () => {
    falso.agentes = [
      agente({ id: "ag_a", idExterno: "agent_1", sincronizadoEm: "2026-11-09T00:00:00.000Z" }),
      agente({ id: "ag_b", idExterno: "agent_2", sincronizadoEm: "2026-11-11T00:00:00.000Z" }),
      agente({ id: "ag_c", idExterno: null }),
    ];
    const { fetch, chamadas } = rede({
      [`PATCH ${EL}/v1/convai/agents/agent_1`]: [{ status: 200, corpo: {} }],
    });
    expect(await sincronizarContextoLigacaoLogica(contexto(), { fetch })).toEqual({ ok: true });
    expect(chamadas.map((c) => c.chave)).toEqual([`PATCH ${EL}/v1/convai/agents/agent_1`]);
    expect(
      (chamadas[0]!.corpo as { conversation_config: { agent: { prompt: { prompt: string } } } })
        .conversation_config.agent.prompt.prompt,
    ).toContain("Consultoria de IA");
    // o carimbo é o criado_em da versão do Contexto que foi no prompt (L35), não a hora do servidor
    expect(falso.agentes[0]!.sincronizadoEm).toBe(falso.contexto.criadoEm);
  });

  it("a voz do cartão mudou (L37): só os agentes lá sem voz própria recebem o PATCH com a voz nova", async () => {
    falso.agentes = [
      agente({ id: "ag_a", idExterno: "agent_1", vozId: null }),
      agente({ id: "ag_b", idExterno: "agent_2", vozId: "vozPropria" }),
      agente({ id: "ag_c", idExterno: null, vozId: null }),
    ];
    const { fetch, chamadas } = rede({
      [`PATCH ${EL}/v1/convai/agents/agent_1`]: [{ status: 200, corpo: {} }],
    });
    expect(await sincronizarVozLigacaoLogica(contexto(), { fetch })).toEqual({ ok: true });
    expect(chamadas.map((c) => c.chave)).toEqual([`PATCH ${EL}/v1/convai/agents/agent_1`]);
    expect(chamadas[0]!.corpo).toMatchObject({
      conversation_config: { tts: { voice_id: "vozCartao" } },
    });
  });

  it("limites: grava e leva o call_limits a todos os agentes que existem lá", async () => {
    falso.agentes.push(agente({ id: "ag_v", idExterno: "agent_2" }));
    const { fetch, chamadas } = rede({
      [`PATCH ${EL}/v1/convai/agents/agent_1`]: [{ status: 200, corpo: {} }],
      [`PATCH ${EL}/v1/convai/agents/agent_2`]: [{ status: 200, corpo: {} }],
    });
    const limites = { simultaneas: 5, porDia: 300, porContato: 4 };
    expect(await salvarLimitesLigacoesLogica(contexto(), limites, { fetch })).toEqual({ ok: true });
    expect(falso.limites).toEqual(limites);
    for (const c of chamadas) {
      expect(c.corpo).toMatchObject({
        platform_settings: { call_limits: { agent_concurrency_limit: 5, daily_limit: 300 } },
      });
    }
    expect(chamadas).toHaveLength(2);
  });

  it("limites fora da faixa: recusa sem gravar", async () => {
    const r = await salvarLimitesLigacoesLogica(contexto(), {
      simultaneas: 0,
      porDia: 100,
      porContato: 10,
    });
    expect(r).toMatchObject({ ok: false, erro: "campos_invalidos" });
    expect(falso.limites).toBeNull();
  });

  it("sem a chave da voz, com as ligações ativas: sem_chave_voz", async () => {
    falso.chave = null;
    const r = await criarAgenteLigacaoLogica(contexto(), CAMPOS);
    expect(r).toMatchObject({ ok: false, erro: "sem_chave_voz" });
    expect(falso.agentes).toHaveLength(1);
  });
});

type CorpoAgente = { conversation_config: { agent: { prompt: { prompt: string } } } };
const promptDe = (c: { corpo: unknown }) =>
  (c.corpo as CorpoAgente).conversation_config.agent.prompt.prompt;

describe("a prévia nunca mexe no agente de voz do endereço publicado", () => {
  beforeEach(() => {
    falso.ligacoes = ativas();
    falso.agentes = [
      agente({ id: "ag_nina", nome: "Nina", atende: true, idExterno: "agent_1" }),
      agente({ id: "ag_v", idExterno: "agent_2" }),
    ];
  });
  const previa = () => ({ ...contexto(), naPrevia: true });

  it("atualizar, Contexto, voz, criar, atender e apagar: endereco_de_previa, sem ir à rede", async () => {
    const { fetch, chamadas } = rede({});
    for (const r of [
      await atualizarAgentesLigacaoLogica(previa(), { fetch }),
      await sincronizarContextoLigacaoLogica(previa(), { fetch }),
      await sincronizarVozLigacaoLogica(previa(), { fetch }),
      await criarAgenteLigacaoLogica(previa(), CAMPOS, { fetch }),
      await atenderAgenteLigacaoLogica(previa(), "ag_v", { fetch }),
      await apagarAgenteLigacaoLogica(previa(), "ag_v", { fetch }),
    ]) {
      expect(r).toMatchObject({ ok: false, erro: "endereco_de_previa" });
    }
    expect(chamadas).toHaveLength(0);
    expect(falso.agentes.map((a) => a.id)).toEqual(["ag_nina", "ag_v"]);
    expect(falso.agentes.find((a) => a.atende)?.id).toBe("ag_nina");
  });

  it("salvar o agente e os limites: recusa sem gravar (o banco valeria já, sem estar no agente)", async () => {
    const { fetch, chamadas } = rede({});
    const antes = falso.limites;
    const limites = { simultaneas: 5, porDia: 300, porContato: 4 };
    const r = await salvarLimitesLigacoesLogica(previa(), limites, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "endereco_de_previa" });
    expect(falso.limites).toEqual(antes);
    const s = await salvarAgenteLigacaoLogica(previa(), "ag_v", CAMPOS, { fetch });
    expect(s).toMatchObject({ ok: false, erro: "endereco_de_previa" });
    expect(chamadas).toHaveLength(0);
  });

  it("adotar o agente do tronco pela prévia não faz nada", async () => {
    const { fetch, chamadas } = rede({});
    expect(await adotarAgenteDoTroncoLogica(previa(), { fetch })).toEqual({ ok: true });
    expect(chamadas).toHaveLength(0);
  });

  it("sem as ligações ativas, a prévia muda as linhas normalmente (nada a levar lá)", async () => {
    falso.ligacoes = null;
    const { fetch, chamadas } = rede({});
    expect(await atenderAgenteLigacaoLogica(previa(), "ag_v", { fetch })).toEqual({
      ok: true,
      id: "ag_v",
    });
    expect(chamadas).toHaveLength(0);
  });
});

describe("L34: a linha que atende sem id_externo adota o agente do tronco", () => {
  beforeEach(() => {
    falso.ligacoes = ativas();
  });

  it("ligações da primeira versão, sem linha: o Novo agente adota o agente do tronco (PATCH) e passa a atender", async () => {
    const { fetch, chamadas } = rede({
      [`PATCH ${EL}/v1/convai/agents/agent_1`]: [{ status: 200, corpo: {} }],
    });
    const r = await criarAgenteLigacaoLogica(contexto(), CAMPOS, { fetch });
    expect(r).toEqual({ ok: true, id: "ag_1" });
    // nenhum agente novo fora do tronco, e o tronco não muda
    expect(chamadas.map((c) => c.chave)).toEqual([`PATCH ${EL}/v1/convai/agents/agent_1`]);
    expect(falso.agentes).toEqual([
      expect.objectContaining({ atende: true, idExterno: "agent_1", versaoConfig: VERSAO_AGENTE }),
    ]);
    expect(falso.ligacoes!.eleven.agenteId).toBe("agent_1");
  });

  it("a ElevenLabs recusa o PATCH da adoção: a linha nova sai, sem ter atendido", async () => {
    const { fetch } = rede({ [`PATCH ${EL}/v1/convai/agents/agent_1`]: [{ status: 500 }] });
    const r = await criarAgenteLigacaoLogica(contexto(), CAMPOS, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "provedor_fora" });
    expect(falso.agentes).toEqual([]);
  });

  it("o passo 8 não gravou o id: o Atualizar adota o agente do tronco em vez de criar outro", async () => {
    falso.agentes = [agente({ id: "ag_nina", atende: true, idExterno: null, versaoConfig: 0 })];
    const { fetch, chamadas } = rede({
      [`PATCH ${EL}/v1/convai/agents/agent_1`]: [{ status: 200, corpo: {} }],
    });
    expect(await atualizarAgentesLigacaoLogica(contexto(), { fetch })).toEqual({ ok: true });
    expect(chamadas.map((c) => c.chave)).toEqual([`PATCH ${EL}/v1/convai/agents/agent_1`]);
    expect(falso.agentes[0]).toMatchObject({ idExterno: "agent_1", versaoConfig: VERSAO_AGENTE });
  });
});

describe("L33: sincronias do mesmo agente ao mesmo tempo", () => {
  beforeEach(() => {
    falso.ligacoes = ativas();
    falso.agentes = [agente({ id: "ag_nina", nome: "Nina", atende: true, idExterno: "agent_1" })];
  });

  it("outra sincronia grava no meio: relê e refaz o PATCH com o Contexto mais novo; o carimbo é dele", async () => {
    const PATCH = `PATCH ${EL}/v1/convai/agents/agent_1`;
    const { fetch, chamadas } = rede({
      [PATCH]: [
        {
          status: 200,
          corpo: {},
          // enquanto este PATCH (com o Contexto velho) anda, o Contexto muda e outra sincronia
          // grava a linha com ele
          antes: () => {
            falso.contexto = {
              texto: "Empresa e oferta: Contexto NOVO",
              criadoEm: "2026-11-12T09:00:00.000Z",
            };
            Object.assign(falso.agentes[0]!, {
              sincronizadoEm: "2026-11-12T09:00:00.000Z",
              atualizadoEm: "v_outra",
            });
          },
        },
        { status: 200, corpo: {} },
      ],
    });
    expect(await atualizarAgentesLigacaoLogica(contexto(), { fetch })).toEqual({ ok: true });
    expect(chamadas).toHaveLength(2);
    expect(promptDe(chamadas[0]!)).toContain("Consultoria de IA");
    // o último PATCH é o do Contexto que está no carimbo
    expect(promptDe(chamadas[1]!)).toContain("Contexto NOVO");
    expect(falso.agentes[0]!.sincronizadoEm).toBe("2026-11-12T09:00:00.000Z");
  });

  it("a linha muda a cada tentativa: desiste e marca o agente como atrás (versão 0, sem carimbo)", async () => {
    const PATCH = `PATCH ${EL}/v1/convai/agents/agent_1`;
    const mexer = () => {
      falso.agentes[0]!.atualizadoEm = `v_outra_${++falso.versao}`;
    };
    const { fetch, chamadas } = rede({
      [PATCH]: Array.from({ length: 4 }, () => ({ status: 200, corpo: {}, antes: mexer })),
    });
    const r = await atualizarAgentesLigacaoLogica(contexto(), { fetch });
    expect(r).toMatchObject({ ok: false, erro: "erro_ao_gravar" });
    expect(chamadas).toHaveLength(4);
    expect(falso.agentes[0]).toMatchObject({ versaoConfig: 0, sincronizadoEm: null });
  });
});

describe("L36: o agente criado lá que não chega a uma linha", () => {
  beforeEach(() => {
    falso.ligacoes = ativas();
    falso.agentes = [agente({ id: "ag_nina", nome: "Nina", atende: true, idExterno: "agent_1" })];
  });

  it("a gravação do id falha: o agente criado sai lá e a linha nova também", async () => {
    falso.sincroniaFalhas = 1;
    const { fetch, chamadas } = rede({
      [`POST ${EL}/v1/convai/agents/create`]: [{ status: 200, corpo: { agent_id: "agent_9" } }],
      [`DELETE ${EL}/v1/convai/agents/agent_9`]: [{ status: 204 }],
    });
    const r = await criarAgenteLigacaoLogica(contexto(), CAMPOS, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "erro_ao_gravar" });
    expect(chamadas.map((c) => c.chave)).toContain(`DELETE ${EL}/v1/convai/agents/agent_9`);
  });

  it("as ligações saem enquanto o agente é criado: ele sai lá e a linha fica sem id", async () => {
    const { fetch, chamadas } = rede({
      [`POST ${EL}/v1/convai/agents/create`]: [
        {
          status: 200,
          corpo: { agent_id: "agent_9" },
          antes: () => {
            falso.ligacoes = { ...falso.ligacoes!, situacao: "com_pendencias" };
          },
        },
      ],
      [`DELETE ${EL}/v1/convai/agents/agent_9`]: [{ status: 204 }],
    });
    const r = await criarAgenteLigacaoLogica(contexto(), CAMPOS, { fetch });
    expect(r).toEqual({ ok: true, id: "ag_2" });
    expect(chamadas.map((c) => c.chave)).toContain(`DELETE ${EL}/v1/convai/agents/agent_9`);
    expect(falso.agentes[1]).toMatchObject({ idExterno: null });
  });
});

describe("L24 e L11: o Atender e o Apagar com o tronco", () => {
  const TRONCO = `PATCH ${EL}/v1/convai/phone-numbers/phnum_1`;
  beforeEach(() => {
    falso.ligacoes = ativas();
    falso.agentes = [
      agente({ id: "ag_nina", nome: "Nina", atende: true, idExterno: "agent_1" }),
      agente({ id: "ag_v", idExterno: "agent_2" }),
    ];
  });

  it("outra gravação passa à frente no espelho: relê e grava o agente do tronco", async () => {
    let primeira = true;
    falso.aoGravarLigacoes = () => {
      if (!primeira) return;
      primeira = false;
      falso.ligacoes = { ...falso.ligacoes!, atualizadaEm: "2026-11-12T08:00:00.000Z" };
    };
    const { fetch } = rede({ [TRONCO]: [{ status: 200, corpo: {} }] });
    expect(await atenderAgenteLigacaoLogica(contexto(), "ag_v", { fetch })).toEqual({
      ok: true,
      id: "ag_v",
    });
    expect(falso.ligacoes!.eleven.agenteId).toBe("agent_2");
  });

  it("o espelho não grava: a troca não conta como feita; o Atender repetido reconcilia", async () => {
    falso.aoGravarLigacoes = () => {
      falso.ligacoes = { ...falso.ligacoes!, atualizadaEm: `${++falso.versao}` };
    };
    const { fetch, chamadas } = rede({
      [TRONCO]: [
        { status: 200, corpo: {} },
        { status: 200, corpo: {} },
      ],
    });
    const r = await atenderAgenteLigacaoLogica(contexto(), "ag_v", { fetch });
    expect(r).toMatchObject({ ok: false, erro: "erro_ao_gravar" });
    expect(falso.ligacoes!.eleven.agenteId).toBe("agent_1");
    // o tronco e a linha já são do ag_v; repetir aponta o tronco de novo e grava o espelho
    falso.aoGravarLigacoes = null;
    expect(await atenderAgenteLigacaoLogica(contexto(), "ag_v", { fetch })).toEqual({
      ok: true,
      id: "ag_v",
    });
    expect(chamadas.map((c) => c.corpo)).toEqual([
      { agent_id: "agent_2" },
      { agent_id: "agent_2" },
    ]);
    expect(falso.ligacoes!.eleven.agenteId).toBe("agent_2");
  });

  it("uma troca posterior no meio do espelho: não grava por cima dela", async () => {
    falso.agentes.push(agente({ id: "ag_w", idExterno: "agent_3" }));
    let primeira = true;
    falso.aoGravarLigacoes = () => {
      if (!primeira) return;
      primeira = false;
      for (const a of falso.agentes) a.atende = a.id === "ag_w";
      falso.ligacoes = {
        ...falso.ligacoes!,
        eleven: { ...falso.ligacoes!.eleven, agenteId: "agent_3" },
        atualizadaEm: "2026-11-12T08:00:00.000Z",
      };
    };
    const { fetch } = rede({ [TRONCO]: [{ status: 200, corpo: {} }] });
    expect(await atenderAgenteLigacaoLogica(contexto(), "ag_v", { fetch })).toMatchObject({
      ok: true,
    });
    expect(falso.ligacoes!.eleven.agenteId).toBe("agent_3");
  });

  it("apagar recusa o agente ainda ligado ao tronco, mesmo sem a marca de atender", async () => {
    falso.ligacoes = {
      ...ativas(),
      eleven: { ...ativas().eleven, agenteId: "agent_2" },
    };
    const { fetch, chamadas } = rede({});
    expect(await apagarAgenteLigacaoLogica(contexto(), "ag_v", { fetch })).toMatchObject({
      ok: false,
      erro: "agente_que_atende",
    });
    expect(chamadas).toHaveLength(0);
    expect(falso.agentes).toHaveLength(2);
  });
});

describe("L43: as ligações da primeira versão (ativas, sem nenhuma linha)", () => {
  const PATCH = `PATCH ${EL}/v1/convai/agents/agent_1`;
  beforeEach(() => {
    falso.ligacoes = ativas();
  });

  it("nasce a linha Nina, que adota o agente do tronco com a configuração nova e o Contexto", async () => {
    const { fetch, chamadas } = rede({ [PATCH]: [{ status: 200, corpo: {} }] });
    const r = await adotarAgenteDoTroncoLogica(contexto(), { fetch });
    expect(r).toEqual({ ok: true, id: "ag_1" });
    // nenhum agente novo lá, e o tronco não muda
    expect(chamadas.map((c) => c.chave)).toEqual([PATCH]);
    expect(chamadas[0]!.corpo).toMatchObject({
      conversation_config: { tts: { voice_id: "vozCartao" } },
    });
    expect(promptDe(chamadas[0]!)).toContain("Consultoria de IA");
    expect(falso.agentes).toEqual([
      expect.objectContaining({
        nome: "Nina",
        atende: true,
        vozId: null,
        idExterno: "agent_1",
        versaoConfig: VERSAO_AGENTE,
        sincronizadoEm: falso.contexto.criadoEm,
        erroSincronia: null,
      }),
    ]);
    expect(falso.ligacoes!.eleven.agenteId).toBe("agent_1");
    expect(falso.gravadas).toEqual([]);
  });

  it("repetir não faz nada: com a linha que atende lá, nem vai à rede", async () => {
    falso.agentes = [agente({ id: "ag_nina", atende: true, idExterno: "agent_1" })];
    const { fetch, chamadas } = rede({});
    expect(await adotarAgenteDoTroncoLogica(contexto(), { fetch })).toEqual({ ok: true });
    expect(chamadas).toHaveLength(0);
    expect(falso.agentes).toHaveLength(1);
  });

  it("duas abas ao mesmo tempo: uma linha só, ligada ao agente do tronco", async () => {
    const { fetch, chamadas } = rede({
      [PATCH]: [
        { status: 200, corpo: {} },
        { status: 200, corpo: {} },
        { status: 200, corpo: {} },
      ],
    });
    const [a, b] = await Promise.all([
      adotarAgenteDoTroncoLogica(contexto(), { fetch }),
      adotarAgenteDoTroncoLogica(contexto(), { fetch }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(falso.agentes).toEqual([
      expect.objectContaining({ atende: true, idExterno: "agent_1", versaoConfig: VERSAO_AGENTE }),
    ]);
    // só PATCH no agente do tronco: nenhum agente criado lá
    expect(new Set(chamadas.map((c) => c.chave))).toEqual(new Set([PATCH]));
  });

  it("a ElevenLabs recusa: a linha fica com o erro no cartão, e a próxima abertura adota", async () => {
    const { fetch } = rede({
      [PATCH]: [{ status: 500 }, { status: 200, corpo: {} }],
    });
    expect(await adotarAgenteDoTroncoLogica(contexto(), { fetch })).toMatchObject({
      ok: false,
      erro: "provedor_fora",
    });
    expect(falso.agentes).toEqual([
      expect.objectContaining({ atende: true, idExterno: null, erroSincronia: expect.any(String) }),
    ]);
    expect(await adotarAgenteDoTroncoLogica(contexto(), { fetch })).toEqual({
      ok: true,
      id: "ag_1",
    });
    expect(falso.agentes).toEqual([
      expect.objectContaining({ idExterno: "agent_1", erroSincronia: null }),
    ]);
  });

  it("sem as ligações ativas, ou sem agente no tronco: nada muda", async () => {
    const { fetch, chamadas } = rede({});
    falso.ligacoes = null;
    expect(await adotarAgenteDoTroncoLogica(contexto(), { fetch })).toEqual({ ok: true });
    falso.ligacoes = { ...ativas(), eleven: { ...ativas().eleven, agenteId: null } };
    expect(await adotarAgenteDoTroncoLogica(contexto(), { fetch })).toEqual({ ok: true });
    expect(chamadas).toHaveLength(0);
    expect(falso.agentes).toEqual([]);
  });

  it("só o admin", async () => {
    const { fetch, chamadas } = rede({});
    expect(await adotarAgenteDoTroncoLogica(contexto(false), { fetch })).toMatchObject({
      ok: false,
      erro: "sem_acesso",
    });
    expect(chamadas).toHaveLength(0);
    expect(falso.agentes).toEqual([]);
  });
});
