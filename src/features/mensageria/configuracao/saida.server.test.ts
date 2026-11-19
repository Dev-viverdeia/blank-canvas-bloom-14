import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Fetch } from "@/features/servidor/http";
import type { PermissaoMeta } from "@/features/servidor/ligacoes-meta";

import type { ClienteUsuario, ContextoUsuario } from "../configuracao.server";
import type { LigacoesGravadas } from "../ligacoes/tipos";

// Banco e rede falsos (seções 3 e 4).
const falso = vi.hoisted(() => ({
  /** O erro que o rpc falso devolve (null = devolve o falso.iniciar). */
  rpcErro: null as null | { code: string; message: string },
  membro: "m-1" as string | null,
  conversa: null as null | { id: string; contato_id: string; ultima_do_lead_em: string | null },
  telefone: "5511988887777" as string | null,
  emAndamento: [] as { status: string; iniciada_em: string; agente_id: string | null }[],
  pedido: null as null | Record<string, unknown>,
  inseridos: [] as Record<string, unknown>[],
  rpcs: [] as { nome: string; args: unknown }[],
  iniciar: {
    ligacao_id: "lig-1",
    id_externo: "saida-lig-1",
    permitida: true,
    motivo: null,
  } as Record<string, unknown>,
  ligacoes: null as LigacoesGravadas | null,
  segredos: {} as Record<string, string>,
  encerradas: [] as { id: string; status: string }[],
  confirmadas: [] as [string, string][],
  gravadas: [] as LigacoesGravadas[],
  gravarVale: true,
  depoisDeGravar: null as null | (() => void),
  semAgente: false,
  agentes: [] as { id: string; duracao_max_s: number }[],
  modo: "nina" as string,
  /** As linhas de ligacao_agentes do agentes-banco falso . */
  linhasAgente: [] as Record<string, unknown>[],
  /** As leituras seguintes do agente escolhido (vazia = a lista linhasAgente). */
  filaAgente: [] as (Record<string, unknown> | null)[],
  /** Os updates no supabaseAdmin: [tabela, campos]. */
  updates: [] as [string, Record<string, unknown>][],
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const cadeia = (tabela: string) => {
    const c: Record<string, unknown> = {};
    for (const n of ["select", "eq", "order", "limit", "in"]) c[n] = () => c;
    c["update"] = (campos: Record<string, unknown>) => {
      falso.updates.push([tabela, campos]);
      return c;
    };
    c["insert"] = async (linha: Record<string, unknown>) => {
      falso.inseridos.push({ tabela, ...linha });
      return { error: null };
    };
    c["then"] = (ok: (v: unknown) => unknown) => {
      const data =
        tabela === "contato_identificadores"
          ? falso.telefone
            ? [{ valor: falso.telefone }]
            : []
          : tabela === "ligacoes"
            ? falso.emAndamento
            : tabela === "ligacao_permissoes"
              ? falso.pedido
                ? [falso.pedido]
                : []
              : tabela === "ligacao_agentes"
                ? falso.agentes
                : [];
      return Promise.resolve({ data, error: null }).then(ok);
    };
    return c;
  };
  return {
    supabaseAdmin: {
      from: cadeia,
      rpc: async (nome: string, args: unknown) => {
        falso.rpcs.push({ nome, args });
        if (falso.rpcErro) return { data: null, error: falso.rpcErro };
        return { data: [falso.iniciar], error: null };
      },
    },
  };
});
vi.mock("../nucleo/conexoes.server", () => ({
  conexaoAtiva: async () =>
    falso.ligacoes === undefined
      ? null
      : {
          id: "cx-1",
          gateway: "meta",
          id_externo: "106540352242922",
          parametros: {
            phoneId: "106540352242922",
            ...(falso.ligacoes ? { ligacoes: falso.ligacoes } : {}),
          },
          segredos: {
            token: TOKEN_META,
            ligacaoToken: "token-da-ligacao-LIGTOKEN",
            ...falso.segredos,
          },
          oficial: true,
        },
  lerChaveIA: async () => ({ provedor: "elevenlabs", chave: CHAVE }),
}));
vi.mock("../ligacoes/banco.server", () => ({
  LEAD_COM_EQUIPE: "COM A EQUIPE",
  confirmarLigacaoDeSaida: async (id: string, conv: string) => {
    falso.confirmadas.push([id, conv]);
    return true;
  },
  encerrarLigacao: async (id: string, fim: { status: string }) => {
    falso.encerradas.push({ id, status: fim.status });
    return { ligacaoId: "lig-1", conversaId: "conv-1" };
  },
  lerAgenteDaLigacao: async () =>
    falso.semAgente
      ? null
      : {
          id: "ag-1",
          saudacao: "Oi, {nome}!",
          sincronizadoEm: "2026-11-17T00:00:00.000Z",
          duracaoMaxS: 600,
          uso: "receber",
        },
  lerContextoAtual: async () => ({ texto: "Contexto", criadoEm: "2026-11-16T00:00:00.000Z" }),
  lerLeadDaLigacao: async () => ({ nome: "Ana Lima", texto: "Nome: Ana Lima" }),
  modoDaConversa: async () => falso.modo,
}));
vi.mock("./ligacoes-banco.server", () => ({
  gravarLigacoes: async (_id: string, e: LigacoesGravadas) => {
    if (!falso.gravarVale) {
      falso.depoisDeGravar?.();
      return false;
    }
    falso.gravadas.push(e);
    return true;
  },
}));
vi.mock("../ligacoes/agentes-banco.server", () => ({
  lerAgente: async (id: string) =>
    falso.filaAgente.length > 0
      ? falso.filaAgente.shift()!
      : (falso.linhasAgente.find((a) => a["id"] === id) ?? null),
  listarAgentes: async () => falso.linhasAgente,
}));
vi.mock("@/lib/segundo-plano", () => ({ emSegundoPlano: () => undefined }));
vi.mock("../nucleo/motor.server", () => ({ acordarMotor: async () => undefined }));

import {
  agentesParaLigarLogica,
  estadoDaPermissao,
  LEAD_SAIDA,
  linhaDoObjetivo,
  ligarParaLeadLogica,
  pedirPermissaoDeLigarLogica,
  permissaoDeLigarLogica,
  TEXTO_PEDIDO_PERMISSAO,
} from "./saida.server";

const CHAVE = "sk_eleven_CHAVE_SAIDA_123456";
const TOKEN_META = "EAAG-token-TOKEN_META_SAIDA_998";
const SENHA = "senha-sip-SENHA_SAIDA_777";
const CONVERSA = "c0ffee00-0000-4000-8000-0000000000c1";
const AGORA = Date.parse("2026-11-17T15:00:00.000Z");
const META = "https://graph.facebook.com/v26.0/106540352242922";
const EL = "https://api.elevenlabs.io";

function ligacoesAtivas(o: Partial<LigacoesGravadas> = {}): LigacoesGravadas {
  return {
    versao: 1,
    situacao: "ativa",
    origem: "https://nina.exemplo.com",
    numero: "5511999990000",
    limiteMeta: "TIER_2K",
    ativadaEm: "2026-11-17T10:00:00.000Z",
    eleven: {
      segredoId: "s",
      webhookId: "w",
      ferramentaId: "f",
      agenteId: "agent_1",
      troncoId: "phnum_1",
    },
    metaSip: true,
    saida: true,
    pendencias: [],
    atualizadaEm: "2026-11-17T10:00:00.000Z",
    ...o,
  };
}

function contexto(): ContextoUsuario {
  const consulta = (tabela: string) => {
    const c: Record<string, unknown> = {};
    for (const n of ["select", "eq"]) c[n] = () => c;
    c["maybeSingle"] = async () =>
      tabela === "membros"
        ? { data: falso.membro ? { id: falso.membro } : null, error: null }
        : { data: falso.conversa, error: null };
    return c;
  };
  return { supabase: { from: consulta } as unknown as ClienteUsuario, userId: "u-1" };
}

type Resposta = { status: number; corpo?: unknown };
function rede(respostas: Record<string, Resposta | Resposta[]>) {
  const chamadas: { chave: string; corpo: unknown }[] = [];
  const fetch: Fetch = async (url, init) => {
    const chave = `${init?.method ?? "GET"} ${url}`;
    chamadas.push({ chave, corpo: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r0 = respostas[chave];
    const r = Array.isArray(r0) ? r0.shift() : r0;
    if (!r) throw new Error(`pedido não esperado: ${chave}`);
    const texto = r.corpo === undefined ? "" : JSON.stringify(r.corpo);
    return { status: r.status, text: async () => texto } as unknown as Response;
  };
  return { fetch, chamadas };
}

const PERMISSAO = `GET ${META}/call_permissions?user_wa_id=5511988887777`;
function permissao(status: string, ligar: boolean, pedir: boolean): Resposta {
  return {
    status: 200,
    corpo: {
      permission: { status },
      actions: [
        { action_name: "start_call", can_perform_action: ligar },
        { action_name: "send_call_permission_request", can_perform_action: pedir },
      ],
    },
  };
}

beforeEach(() => {
  falso.membro = "m-1";
  falso.conversa = {
    id: CONVERSA,
    contato_id: "k-1",
    ultima_do_lead_em: new Date(AGORA - 3_600_000).toISOString(),
  };
  falso.telefone = "5511988887777";
  falso.emAndamento = [];
  falso.pedido = null;
  falso.inseridos = [];
  falso.rpcs = [];
  falso.iniciar = { ligacao_id: "lig-1", id_externo: "saida-lig-1", permitida: true, motivo: null };
  falso.ligacoes = ligacoesAtivas();
  falso.segredos = {};
  falso.encerradas = [];
  falso.confirmadas = [];
  falso.gravadas = [];
  falso.gravarVale = true;
  falso.depoisDeGravar = null;
  falso.semAgente = false;
  falso.agentes = [];
  falso.modo = "nina";
  falso.linhasAgente = [];
  falso.filaAgente = [];
  falso.rpcErro = null;
  falso.updates = [];
});

/** Uma linha de ligacao_agentes pronta (com o agente na ElevenLabs e sem erro). */
function linhaAgente(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ag-vendas",
    nome: "Vendas – retorno",
    uso: "ligar",
    objetivo: "vendas",
    atende: false,
    saudacao: "Oi, {nome}! Aqui é a Nina, da Ótica Sol, sobre o seu orçamento.",
    idExterno: "agent_vendas",
    erroSincronia: null,
    sincronizadoEm: "2026-11-17T00:00:00.000Z",
    duracaoMaxS: 300,
    ...o,
  };
}

const pedido = { conversaId: CONVERSA, origem: "https://nina.exemplo.com" };

// ---------- o estado do botão (pura) ----------

describe("estadoDaPermissao", () => {
  const base = (horas = 1, resposta: string | null = null) => ({
    conversa: {
      id: CONVERSA,
      contatoId: "k",
      ultimaDoLeadEm: new Date(AGORA - horas * 3_600_000).toISOString(),
    },
    pedido:
      resposta === undefined
        ? null
        : resposta === null
          ? null
          : {
              id: "p",
              pedidoEm: new Date(AGORA - 2 * 3_600_000).toISOString(),
              resposta: resposta as "aceitou" | "recusou",
              permanente: null,
              respondidoEm: new Date(AGORA - 3_600_000).toISOString(),
            },
  });
  const m = (o: Partial<PermissaoMeta>): PermissaoMeta => ({
    status: "no_permission",
    expiraEm: null,
    ligar: { pode: false, liberaEm: null },
    pedir: { pode: true, liberaEm: null },
    ...o,
  });

  it("permanente e a Meta deixa ligar: liga", () => {
    const e = estadoDaPermissao(
      base(),
      m({ status: "permanent", ligar: { pode: true, liberaEm: null } }),
      AGORA,
    );
    expect(e).toMatchObject({
      permissao: "permanente",
      podeLigar: true,
      motivo: null,
      expiraEm: null,
    });
  });

  it("temporária: liga, com a validade", () => {
    const e = estadoDaPermissao(
      base(),
      m({
        status: "temporary",
        expiraEm: "2026-11-20T00:00:00.000Z",
        ligar: { pode: true, liberaEm: null },
      }),
      AGORA,
    );
    expect(e).toMatchObject({
      permissao: "temporaria",
      podeLigar: true,
      expiraEm: "2026-11-20T00:00:00.000Z",
    });
  });

  it("sem permissão, na janela e com o pedido liberado: pedir", () => {
    expect(estadoDaPermissao(base(), m({}), AGORA)).toMatchObject({
      podeLigar: false,
      podePedir: true,
      motivo: "pedir",
      dentroDaJanela: true,
    });
  });

  it("sem permissão e fora da janela: fora_da_janela, sem pedir", () => {
    expect(estadoDaPermissao(base(30), m({}), AGORA)).toMatchObject({
      podePedir: false,
      motivo: "fora_da_janela",
      dentroDaJanela: false,
    });
  });

  it("o pedido travado pela Meta: limite_de_pedidos, com quando dá de novo (da Meta)", () => {
    const e = estadoDaPermissao(
      base(),
      m({ pedir: { pode: false, liberaEm: "2026-11-18T14:00:00.000Z" } }),
      AGORA,
    );
    expect(e).toMatchObject({
      motivo: "limite_de_pedidos",
      pedirDeNovoEm: "2026-11-18T14:00:00.000Z",
    });
  });

  it("o lead recusou e a Meta ainda não deixa pedir: recusou, com quando dá pela regra se a Meta não disser", () => {
    const e = estadoDaPermissao(
      base(1, "recusou"),
      m({ pedir: { pode: false, liberaEm: null } }),
      AGORA,
    );
    expect(e.motivo).toBe("recusou");
    expect(e.pedirDeNovoEm).toBe(new Date(AGORA - 2 * 3_600_000 + 24 * 3_600_000).toISOString());
  });

  it("com permissão, mas a Meta não deixa ligar agora: meta_nao_deixa", () => {
    expect(estadoDaPermissao(base(), m({ status: "temporary" }), AGORA)).toMatchObject({
      podeLigar: false,
      podePedir: false,
      motivo: "meta_nao_deixa",
    });
  });
});

// ---------- permissaoDeLigar ----------

describe("permissaoDeLigar", () => {
  it("consulta a Meta e devolve o estado", async () => {
    const { fetch, chamadas } = rede({ [PERMISSAO]: permissao("permanent", true, false) });
    const r = await permissaoDeLigarLogica(contexto(), pedido, { fetch, agoraMs: AGORA });
    expect(r).toMatchObject({ ok: true, estado: { podeLigar: true, permissao: "permanente" } });
    expect(chamadas.map((c) => c.chave)).toEqual([PERMISSAO]);
  });

  it("com um pedido de menos de 24 h sem resposta: aguardando_lead pelo banco, sem ir à Meta", async () => {
    falso.pedido = {
      id: "p-1",
      pedido_em: new Date(AGORA - 60_000).toISOString(),
      resposta: null,
      permanente: null,
      respondido_em: null,
    };
    const { fetch, chamadas } = rede({});
    const r = await permissaoDeLigarLogica(contexto(), pedido, { fetch, agoraMs: AGORA });
    expect(r).toMatchObject({
      ok: true,
      estado: { motivo: "aguardando_lead", pedido: { resposta: null } },
    });
    expect(chamadas).toHaveLength(0);
  });

  it("o lead ligou depois do pedido (em vez de tocar no aceite): consulta a Meta de novo (Sol, PR #24)", async () => {
    falso.pedido = {
      id: "p-1",
      pedido_em: new Date(AGORA - 10 * 60_000).toISOString(),
      resposta: null,
      permanente: null,
      respondido_em: null,
    };
    falso.emAndamento = [
      {
        status: "concluida",
        iniciada_em: new Date(AGORA - 5 * 60_000).toISOString(),
        agente_id: null,
      },
    ];
    const { fetch, chamadas } = rede({ [PERMISSAO]: permissao("temporary", true, false) });
    const r = await permissaoDeLigarLogica(contexto(), pedido, { fetch, agoraMs: AGORA });
    expect(r).toMatchObject({ ok: true, estado: { podeLigar: true, permissao: "temporaria" } });
    expect(chamadas.map((c) => c.chave)).toEqual([PERMISSAO]);
  });

  it("sem ligações ativas, sem telefone ou com ligação em andamento: o motivo, sem ir à Meta", async () => {
    const { fetch, chamadas } = rede({});
    falso.ligacoes = ligacoesAtivas({ situacao: "com_pendencias" });
    expect(
      await permissaoDeLigarLogica(contexto(), pedido, { fetch, agoraMs: AGORA }),
    ).toMatchObject({
      estado: { motivo: "sem_ligacoes" },
    });
    falso.ligacoes = ligacoesAtivas();
    falso.telefone = null;
    expect(
      await permissaoDeLigarLogica(contexto(), pedido, { fetch, agoraMs: AGORA }),
    ).toMatchObject({
      estado: { motivo: "sem_telefone" },
    });
    falso.telefone = "5511988887777";
    falso.emAndamento = [
      {
        status: "em_andamento",
        iniciada_em: new Date(AGORA - 60_000).toISOString(),
        agente_id: null,
      },
    ];
    expect(
      await permissaoDeLigarLogica(contexto(), pedido, { fetch, agoraMs: AGORA }),
    ).toMatchObject({
      estado: { motivo: "ligacao_em_andamento" },
    });
    expect(chamadas).toHaveLength(0);
  });

  it("a ligação em andamento passada do teto do agente não bloqueia mais, mesmo sem as presas a fecharem (Sol, PR #24)", async () => {
    falso.agentes = [{ id: "ag-curto", duracao_max_s: 600 }];
    falso.emAndamento = [
      {
        status: "em_andamento",
        iniciada_em: new Date(AGORA - 15 * 60_000).toISOString(),
        agente_id: "ag-curto",
      },
    ];
    const { fetch, chamadas } = rede({ [PERMISSAO]: [permissao("permanent", true, false)] });
    const r = await permissaoDeLigarLogica(contexto(), pedido, { fetch, agoraMs: AGORA });
    expect(r).toMatchObject({ ok: true, estado: { podeLigar: true } });
    expect(chamadas).toHaveLength(1);
    // antes do teto (10 min de 12), ainda em andamento, sem ir à Meta
    falso.emAndamento[0]!.iniciada_em = new Date(AGORA - 10 * 60_000).toISOString();
    expect(
      await permissaoDeLigarLogica(contexto(), pedido, { fetch, agoraMs: AGORA }),
    ).toMatchObject({
      estado: { motivo: "ligacao_em_andamento" },
    });
  });

  it("sem membro ativo, ou conversa que o usuário não vê: sem_acesso / conversa_nao_encontrada", async () => {
    const { fetch } = rede({});
    falso.membro = null;
    expect(
      await permissaoDeLigarLogica(contexto(), pedido, { fetch, agoraMs: AGORA }),
    ).toMatchObject({
      ok: false,
      erro: "sem_acesso",
    });
    falso.membro = "m-1";
    falso.conversa = null;
    expect(
      await permissaoDeLigarLogica(contexto(), pedido, { fetch, agoraMs: AGORA }),
    ).toMatchObject({
      ok: false,
      erro: "conversa_nao_encontrada",
    });
  });
});

// ---------- pedirPermissaoDeLigar ----------

describe("pedirPermissaoDeLigar", () => {
  it("manda o interativo ao telefone do lead e grava o pedido com o wamid e quem pediu", async () => {
    const { fetch, chamadas } = rede({
      [PERMISSAO]: permissao("no_permission", false, true),
      [`POST ${META}/messages`]: { status: 200, corpo: { messages: [{ id: "wamid.P1" }] } },
    });
    const r = await pedirPermissaoDeLigarLogica(contexto(), pedido, { fetch, agoraMs: AGORA });
    expect(r).toMatchObject({ ok: true, estado: { motivo: "aguardando_lead", podePedir: false } });
    expect(chamadas[1]?.corpo).toMatchObject({
      to: "5511988887777",
      interactive: { type: "call_permission_request", body: { text: TEXTO_PEDIDO_PERMISSAO } },
    });
    expect(falso.inseridos).toEqual([
      expect.objectContaining({
        tabela: "ligacao_permissoes",
        conversa_id: CONVERSA,
        conexao_id: "cx-1",
        id_gateway: "wamid.P1",
        pedido_por: "m-1",
      }),
    ]);
  });

  it("fora da janela: fora_da_janela, sem mandar nada", async () => {
    falso.conversa!.ultima_do_lead_em = new Date(AGORA - 30 * 3_600_000).toISOString();
    const { fetch, chamadas } = rede({ [PERMISSAO]: permissao("no_permission", false, true) });
    const r = await pedirPermissaoDeLigarLogica(contexto(), pedido, { fetch, agoraMs: AGORA });
    expect(r).toMatchObject({ ok: false, erro: "fora_da_janela" });
    expect(chamadas.map((c) => c.chave)).toEqual([PERMISSAO]);
    expect(falso.inseridos).toEqual([]);
  });

  it("já com permissão: não pede (sem_permissao não; a Meta já deixa ligar)", async () => {
    const { fetch, chamadas } = rede({ [PERMISSAO]: permissao("permanent", true, true) });
    const r = await pedirPermissaoDeLigarLogica(contexto(), pedido, { fetch, agoraMs: AGORA });
    expect(r.ok).toBe(false);
    expect(chamadas).toHaveLength(1);
  });
});

// ---------- ligarParaLead ----------

const LIGAR = `POST ${EL}/v1/convai/sip-trunk/outbound-call`;

describe("ligarParaLead", () => {
  it("com permissão: registra, liga pelo tronco com as variáveis da saída e confirma o id da conversa", async () => {
    const { fetch, chamadas } = rede({
      [PERMISSAO]: permissao("permanent", true, false),
      [LIGAR]: { status: 200, corpo: { success: true, conversation_id: "conv_saida_1" } },
    });
    const r = await ligarParaLeadLogica(contexto(), pedido, { fetch, agoraMs: AGORA });
    expect(r).toEqual({ ok: true, ligacaoId: "lig-1" });
    expect(falso.rpcs).toEqual([
      {
        nome: "ligacao_iniciar_saida",
        args: {
          p_conversa: CONVERSA,
          p_agente: "ag-1",
          p_momento: new Date(AGORA).toISOString(),
          p_objetivo: null,
        },
      },
    ]);
    const corpo = chamadas.find((c) => c.chave === LIGAR)?.corpo as Record<string, unknown>;
    expect(corpo).toMatchObject({
      agent_id: "agent_1",
      agent_phone_number_id: "phnum_1",
      to_number: "+5511988887777",
    });
    const vars = (
      corpo["conversation_initiation_client_data"] as { dynamic_variables: Record<string, string> }
    ).dynamic_variables;
    expect(vars["nina_saudacao"]).toBe(
      "Oi, Ana! Aqui é a Nina, te ligando pelo WhatsApp. Tudo bem?",
    );
    expect(vars["nina_lead"]).toBe(`Nome: Ana Lima\n\n${LEAD_SAIDA}`);
    expect(vars["nina_ligacao"]).toBe("lig-1");
    expect(vars["nina_contexto"]).toBe("");
    expect(vars["secret__nina_sessao"]).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    expect(falso.confirmadas).toEqual([["lig-1", "conv_saida_1"]]);
    // nada de segredo no resultado
    expect(JSON.stringify(r)).not.toContain(CHAVE);
  });

  it("sem a linha do agente (a primeira versão): p_agente nulo, e o Contexto vai na variável (Opus, PR #24)", async () => {
    falso.semAgente = true;
    const { fetch, chamadas } = rede({
      [PERMISSAO]: permissao("permanent", true, false),
      [LIGAR]: { status: 200, corpo: { success: true, conversation_id: "conv_saida_5" } },
    });
    const r = await ligarParaLeadLogica(contexto(), pedido, { fetch, agoraMs: AGORA });
    expect(r.ok).toBe(true);
    expect(falso.rpcs[0]?.args).toMatchObject({ p_agente: null });
    const corpo = chamadas.find((c) => c.chave === LIGAR)?.corpo as {
      conversation_initiation_client_data: { dynamic_variables: Record<string, string> };
    };
    expect(corpo.conversation_initiation_client_data.dynamic_variables["nina_contexto"]).toBe(
      "Contexto",
    );
  });

  it("com a conversa com a equipe: a voz sabe que a equipe manda o combinado", async () => {
    falso.modo = "humano";
    const { fetch, chamadas } = rede({
      [PERMISSAO]: permissao("permanent", true, false),
      [LIGAR]: { status: 200, corpo: { success: true, conversation_id: "conv_saida_2" } },
    });
    await ligarParaLeadLogica(contexto(), pedido, { fetch, agoraMs: AGORA });
    const corpo = chamadas.find((c) => c.chave === LIGAR)?.corpo as {
      conversation_initiation_client_data: { dynamic_variables: Record<string, string> };
    };
    expect(corpo.conversation_initiation_client_data.dynamic_variables["nina_lead"]).toContain(
      "COM A EQUIPE",
    );
  });

  it("quem ativou antes da saída: completa o tronco (senha, PATCH, callback) e marca, antes de ligar", async () => {
    const { saida: _saida, ...semSaida } = ligacoesAtivas();
    falso.ligacoes = semSaida;
    const { fetch, chamadas } = rede({
      [PERMISSAO]: permissao("permanent", true, false),
      [`GET ${META}/settings?include_sip_credentials=true`]: {
        status: 200,
        corpo: {
          calling: {
            sip: { servers: [{ hostname: "sip.rtc.elevenlabs.io", sip_user_password: SENHA }] },
          },
        },
      },
      [`PATCH ${EL}/v1/convai/phone-numbers/phnum_1`]: { status: 200, corpo: {} },
      [`POST ${META}/settings`]: { status: 200, corpo: { success: true } },
      [LIGAR]: { status: 200, corpo: { success: true, conversation_id: "conv_saida_3" } },
    });
    const r = await ligarParaLeadLogica(contexto(), pedido, { fetch, agoraMs: AGORA });
    expect(r.ok).toBe(true);
    expect(chamadas.map((c) => c.chave)).toEqual([
      PERMISSAO,
      `GET ${META}/settings?include_sip_credentials=true`,
      `PATCH ${EL}/v1/convai/phone-numbers/phnum_1`,
      `POST ${META}/settings`,
      LIGAR,
    ]);
    expect(falso.gravadas).toEqual([expect.objectContaining({ saida: true })]);
    expect(JSON.stringify(r)).not.toContain(SENHA);
  });

  it("a ElevenLabs não ligou: a ligação fecha como não completada, e o erro volta", async () => {
    const { fetch } = rede({
      [PERMISSAO]: permissao("permanent", true, false),
      [LIGAR]: { status: 200, corpo: { success: false, message: "busy" } },
    });
    const r = await ligarParaLeadLogica(contexto(), pedido, { fetch, agoraMs: AGORA });
    expect(r).toMatchObject({ ok: false, erro: "provedor_fora" });
    expect(falso.encerradas).toEqual([{ id: "saida-lig-1", status: "nao_completada" }]);
    expect(falso.confirmadas).toEqual([]);
  });

  it("a ElevenLabs não respondeu a tempo (pode ter saído): a reserva fica, sem fechar a ligação (Sol, PR #24)", async () => {
    const { fetch } = rede({
      [PERMISSAO]: permissao("permanent", true, false),
      [LIGAR]: { status: 502 },
    });
    const r = await ligarParaLeadLogica(contexto(), pedido, { fetch, agoraMs: AGORA });
    expect(r).toMatchObject({ ok: false, erro: "tempo_esgotado" });
    expect(falso.encerradas).toEqual([]);
    expect(falso.confirmadas).toEqual([]);
  });

  it("quem ativou antes: o callback recusado não grava a marca, mas a ligação segue (Sol, PR #24)", async () => {
    const { saida: _s, ...semSaida } = ligacoesAtivas();
    falso.ligacoes = semSaida;
    const { fetch } = rede({
      [PERMISSAO]: permissao("permanent", true, false),
      [`GET ${META}/settings?include_sip_credentials=true`]: {
        status: 200,
        corpo: {
          calling: {
            sip: { servers: [{ hostname: "sip.rtc.elevenlabs.io", sip_user_password: SENHA }] },
          },
        },
      },
      [`PATCH ${EL}/v1/convai/phone-numbers/phnum_1`]: { status: 200, corpo: {} },
      [`POST ${META}/settings`]: { status: 400, corpo: { error: { code: 100 } } },
      [LIGAR]: { status: 200, corpo: { success: true, conversation_id: "conv_saida_4" } },
    });
    const r = await ligarParaLeadLogica(contexto(), pedido, { fetch, agoraMs: AGORA });
    expect(r.ok).toBe(true);
    expect(falso.gravadas).toEqual([]);
  });

  it("quem ativou antes: as ligações foram desativadas no meio do upgrade (a trava perdeu): não liga (Sol, PR #24)", async () => {
    const { saida: _s, ...semSaida } = ligacoesAtivas();
    falso.ligacoes = semSaida;
    falso.gravarVale = false;
    falso.depoisDeGravar = () => {
      falso.ligacoes = ligacoesAtivas({
        situacao: "com_pendencias",
        atualizadaEm: "2026-11-17T16:00:00.000Z",
      });
    };
    const { fetch, chamadas } = rede({
      [PERMISSAO]: permissao("permanent", true, false),
      [`GET ${META}/settings?include_sip_credentials=true`]: {
        status: 200,
        corpo: {
          calling: {
            sip: { servers: [{ hostname: "sip.rtc.elevenlabs.io", sip_user_password: SENHA }] },
          },
        },
      },
      [`PATCH ${EL}/v1/convai/phone-numbers/phnum_1`]: { status: 200, corpo: {} },
      [`POST ${META}/settings`]: { status: 200, corpo: { success: true } },
    });
    const r = await ligarParaLeadLogica(contexto(), pedido, { fetch, agoraMs: AGORA });
    expect(r).toMatchObject({ ok: false, erro: "sem_ligacoes" });
    expect(falso.rpcs).toEqual([]);
    expect(chamadas.some((c) => c.chave === LIGAR)).toBe(false);
  });

  it("sem permissão: sem_permissao, sem registrar nem ligar", async () => {
    const { fetch, chamadas } = rede({ [PERMISSAO]: permissao("no_permission", false, true) });
    const r = await ligarParaLeadLogica(contexto(), pedido, { fetch, agoraMs: AGORA });
    expect(r).toMatchObject({ ok: false });
    expect(falso.rpcs).toEqual([]);
    expect(chamadas.map((c) => c.chave)).toEqual([PERMISSAO]);
  });

  it("o banco recusa pelo limite por contato: a mensagem do limite, sem ligar", async () => {
    falso.iniciar = {
      ligacao_id: null,
      id_externo: null,
      permitida: false,
      motivo: "limite_por_contato",
    };
    const { fetch, chamadas } = rede({ [PERMISSAO]: permissao("temporary", true, false) });
    const r = await ligarParaLeadLogica(contexto(), pedido, { fetch, agoraMs: AGORA });
    expect(r).toMatchObject({ ok: false, erro: "limite_por_contato" });
    expect(chamadas.some((c) => c.chave === LIGAR)).toBe(false);
  });
});

// ---------- ligar com um agente  ----------

describe("ligar com um agente escolhido", () => {
  function varsDe(chamadas: { chave: string; corpo: unknown }[]) {
    const corpo = chamadas.find((c) => c.chave === LIGAR)?.corpo as Record<string, unknown>;
    const vars = (
      corpo["conversation_initiation_client_data"] as { dynamic_variables: Record<string, string> }
    ).dynamic_variables;
    return { corpo, vars };
  }

  it("o agente Ativo: liga com o agente dele, se apresenta com a saudação dele e leva o objetivo", async () => {
    falso.linhasAgente = [linhaAgente()];
    const { fetch, chamadas } = rede({
      [PERMISSAO]: permissao("permanent", true, false),
      [LIGAR]: { status: 200, corpo: { success: true, conversation_id: "conv_saida_7" } },
    });
    const r = await ligarParaLeadLogica(
      contexto(),
      { ...pedido, agenteId: "ag-vendas", objetivo: "  Retomar o orçamento de ontem  " },
      { fetch, agoraMs: AGORA },
    );
    expect(r).toEqual({ ok: true, ligacaoId: "lig-1" });
    // o objetivo vai aparado, junto com a reserva (Sol, PR #26)
    expect(falso.rpcs[0]?.args).toMatchObject({
      p_agente: "ag-vendas",
      p_objetivo: "Retomar o orçamento de ontem",
    });
    const { corpo, vars } = varsDe(chamadas);
    expect(corpo).toMatchObject({ agent_id: "agent_vendas", agent_phone_number_id: "phnum_1" });
    expect(vars["nina_saudacao"]).toBe(
      "Oi, Ana! Aqui é a Nina, da Ótica Sol, sobre o seu orçamento.",
    );
    expect(vars["nina_lead"]).toBe(
      `Nome: Ana Lima\n\n${LEAD_SAIDA}\n\n${linhaDoObjetivo("Retomar o orçamento de ontem")}`,
    );
    expect(falso.updates).toEqual([]);
  });

  it("o agente Receptivo escolhido: liga com ele, mas com a saudação de quem liga", async () => {
    falso.linhasAgente = [
      linhaAgente({
        id: "ag-nina",
        uso: "receber",
        atende: true,
        idExterno: "agent_1",
        saudacao: "Oi, {nome}! Aqui é a Nina. Como posso te ajudar?",
      }),
    ];
    const { fetch, chamadas } = rede({
      [PERMISSAO]: permissao("permanent", true, false),
      [LIGAR]: { status: 200, corpo: { success: true, conversation_id: "conv_saida_8" } },
    });
    await ligarParaLeadLogica(
      contexto(),
      { ...pedido, agenteId: "ag-nina" },
      { fetch, agoraMs: AGORA },
    );
    const { vars } = varsDe(chamadas);
    expect(vars["nina_saudacao"]).toBe(
      "Oi, Ana! Aqui é a Nina, te ligando pelo WhatsApp. Tudo bem?",
    );
    // sem objetivo: nulo na reserva, e o bloco do lead é o de sempre
    expect(vars["nina_lead"]).toBe(`Nome: Ana Lima\n\n${LEAD_SAIDA}`);
    expect(falso.rpcs[0]?.args).toMatchObject({ p_objetivo: null });
  });

  it("o objetivo só de espaços conta como sem objetivo; o de mais de 500 é recusado antes de tudo", async () => {
    const { fetch, chamadas } = rede({});
    const r = await ligarParaLeadLogica(
      contexto(),
      { ...pedido, objetivo: "x".repeat(501) },
      { fetch, agoraMs: AGORA },
    );
    expect(r).toMatchObject({ ok: false, erro: "objetivo_invalido" });
    expect(chamadas).toEqual([]);
    expect(falso.rpcs).toEqual([]);
  });

  it("o agente que não existe, ou que não está na ElevenLabs: agente_indisponivel, sem ir à Meta", async () => {
    const { fetch, chamadas } = rede({});
    const sumiu = await ligarParaLeadLogica(
      contexto(),
      { ...pedido, agenteId: "ag-sumiu" },
      { fetch, agoraMs: AGORA },
    );
    expect(sumiu).toMatchObject({ ok: false, erro: "agente_indisponivel" });
    falso.linhasAgente = [linhaAgente({ id: "ag-novo", idExterno: null })];
    const r = await ligarParaLeadLogica(
      contexto(),
      { ...pedido, agenteId: "ag-novo" },
      { fetch, agoraMs: AGORA },
    );
    expect(r).toMatchObject({ ok: false, erro: "agente_indisponivel" });
    expect(chamadas).toEqual([]);
    expect(falso.rpcs).toEqual([]);
  });
});

describe("agentesParaLigar", () => {
  it("os Ativos primeiro, depois por nome; o que não está pronto vem com o motivo", async () => {
    falso.linhasAgente = [
      linhaAgente({ id: "a1", nome: "Nina", uso: "receber", atende: true }),
      linhaAgente({ id: "a2", nome: "Vendas", idExterno: null }),
      linhaAgente({ id: "a3", nome: "Cobrança", erroSincronia: "falhou" }),
      linhaAgente({ id: "a4", nome: "Agenda" }),
    ];
    const r = await agentesParaLigarLogica(contexto());
    expect(r).toEqual({
      ok: true,
      agentes: [
        {
          id: "a4",
          nome: "Agenda",
          uso: "ligar",
          objetivo: "vendas",
          atende: false,
          indisponivel: null,
          desatualizado: false,
        },
        {
          id: "a3",
          nome: "Cobrança",
          uso: "ligar",
          objetivo: "vendas",
          atende: false,
          indisponivel: null,
          desatualizado: true,
        },
        {
          id: "a2",
          nome: "Vendas",
          uso: "ligar",
          objetivo: "vendas",
          atende: false,
          indisponivel: "nao_sincronizado",
          desatualizado: false,
        },
        {
          id: "a1",
          nome: "Nina",
          uso: "receber",
          objetivo: "vendas",
          atende: true,
          indisponivel: null,
          desatualizado: false,
        },
      ],
    });
    // nada da sincronia além do motivo (nem o id da ElevenLabs nem o texto do erro)
    expect(JSON.stringify(r)).not.toContain("agent_vendas");
    expect(JSON.stringify(r)).not.toContain("falhou");
  });

  it("sem membro ativo: sem_acesso", async () => {
    falso.membro = null;
    expect(await agentesParaLigarLogica(contexto())).toMatchObject({
      ok: false,
      erro: "sem_acesso",
    });
  });
});

describe("ligar com um agente: a revisão do Sol no PR #26", () => {
  it("o agente apagado entre a leitura e o registro: agente_indisponivel, sem registrar nem ligar", async () => {
    falso.linhasAgente = [linhaAgente()];
    falso.filaAgente = [linhaAgente(), null];
    const { fetch, chamadas } = rede({ [PERMISSAO]: permissao("permanent", true, false) });
    const r = await ligarParaLeadLogica(
      contexto(),
      { ...pedido, agenteId: "ag-vendas" },
      { fetch, agoraMs: AGORA },
    );
    expect(r).toMatchObject({ ok: false, erro: "agente_indisponivel" });
    expect(falso.rpcs).toEqual([]);
    expect(chamadas.some((c) => c.chave === LIGAR)).toBe(false);
  });

  it("a ligação sai com a linha relida: a saudação e o agente da última versão", async () => {
    falso.filaAgente = [
      linhaAgente(),
      linhaAgente({ saudacao: "Oi, {nome}! Saudação nova.", idExterno: "agent_vendas_2" }),
    ];
    const { fetch, chamadas } = rede({
      [PERMISSAO]: permissao("permanent", true, false),
      [LIGAR]: { status: 200, corpo: { success: true, conversation_id: "conv_saida_9" } },
    });
    await ligarParaLeadLogica(
      contexto(),
      { ...pedido, agenteId: "ag-vendas" },
      { fetch, agoraMs: AGORA },
    );
    const corpo = chamadas.find((c) => c.chave === LIGAR)?.corpo as Record<string, unknown>;
    expect(corpo).toMatchObject({ agent_id: "agent_vendas_2" });
    const vars = (
      corpo["conversation_initiation_client_data"] as { dynamic_variables: Record<string, string> }
    ).dynamic_variables;
    expect(vars["nina_saudacao"]).toBe("Oi, Ana! Saudação nova.");
  });

  it("a última sincronia em erro não impede: o agente lá liga com a configuração anterior (Opus, PR #26)", async () => {
    falso.linhasAgente = [linhaAgente({ erroSincronia: "A ElevenLabs recusou." })];
    for (const p of [{ ...pedido, agenteId: "ag-vendas" }, pedido]) {
      const { fetch } = rede({
        [PERMISSAO]: permissao("permanent", true, false),
        [LIGAR]: { status: 200, corpo: { success: true, conversation_id: "conv_saida_e" } },
      });
      expect(await ligarParaLeadLogica(contexto(), p, { fetch, agoraMs: AGORA })).toMatchObject({
        ok: true,
      });
    }
  });

  it("o agente apagado entre a releitura e o registro (a chave estrangeira): agente_indisponivel", async () => {
    falso.linhasAgente = [linhaAgente()];
    falso.rpcErro = { code: "23503", message: "fk" };
    const { fetch, chamadas } = rede({ [PERMISSAO]: permissao("permanent", true, false) });
    const r = await ligarParaLeadLogica(
      contexto(),
      { ...pedido, agenteId: "ag-vendas" },
      { fetch, agoraMs: AGORA },
    );
    expect(r).toMatchObject({ ok: false, erro: "agente_indisponivel" });
    expect(chamadas.some((c) => c.chave === LIGAR)).toBe(false);
  });

  it("os limites da conta (todos os agentes): limite_da_conta, sem ligar", async () => {
    for (const motivo of ["limite_simultaneas", "limite_por_dia"]) {
      falso.iniciar = { ligacao_id: null, id_externo: null, permitida: false, motivo };
      const { fetch, chamadas } = rede({ [PERMISSAO]: permissao("permanent", true, false) });
      const r = await ligarParaLeadLogica(contexto(), pedido, { fetch, agoraMs: AGORA });
      expect(r).toMatchObject({ ok: false, erro: "limite_da_conta" });
      expect(chamadas.some((c) => c.chave === LIGAR)).toBe(false);
    }
  });
});

describe("ligar com um agente: a rodada 2 do Sol no PR #26", () => {
  it("sem agente escolhido: o que atende agora (relido), não o que o tronco tinha", async () => {
    falso.linhasAgente = [
      linhaAgente({ id: "ag-atual", uso: "receber", atende: true, idExterno: "agent_atual" }),
    ];
    const { fetch, chamadas } = rede({
      [PERMISSAO]: permissao("permanent", true, false),
      [LIGAR]: { status: 200, corpo: { success: true, conversation_id: "conv_saida_r" } },
    });
    expect(await ligarParaLeadLogica(contexto(), pedido, { fetch, agoraMs: AGORA })).toMatchObject({
      ok: true,
    });
    expect(falso.rpcs[0]?.args).toMatchObject({ p_agente: "ag-atual" });
    const corpo = chamadas.find((c) => c.chave === LIGAR)?.corpo as Record<string, unknown>;
    expect(corpo).toMatchObject({ agent_id: "agent_atual" });
  });

  it("sem agente escolhido e o que atende fora da ElevenLabs: agente_indisponivel", async () => {
    falso.linhasAgente = [
      linhaAgente({ id: "ag-atual", uso: "receber", atende: true, idExterno: null }),
    ];
    const { fetch } = rede({ [PERMISSAO]: permissao("permanent", true, false) });
    expect(await ligarParaLeadLogica(contexto(), pedido, { fetch, agoraMs: AGORA })).toMatchObject({
      ok: false,
      erro: "agente_indisponivel",
    });
    expect(falso.rpcs).toEqual([]);
  });

  it("o banco recusa o agente (solto pelo apagar no meio): agente_indisponivel, sem ligar", async () => {
    falso.linhasAgente = [linhaAgente()];
    falso.iniciar = {
      ligacao_id: null,
      id_externo: null,
      permitida: false,
      motivo: "agente_indisponivel",
    };
    const { fetch, chamadas } = rede({ [PERMISSAO]: permissao("permanent", true, false) });
    expect(
      await ligarParaLeadLogica(
        contexto(),
        { ...pedido, agenteId: "ag-vendas" },
        { fetch, agoraMs: AGORA },
      ),
    ).toMatchObject({ ok: false, erro: "agente_indisponivel" });
    expect(chamadas.some((c) => c.chave === LIGAR)).toBe(false);
  });
});
