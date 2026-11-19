import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Fetch } from "@/features/servidor/http";

import type { ClienteUsuario, ContextoUsuario } from "../configuracao.server";
import type { LinhaAgente, Sincronia } from "../ligacoes/agentes-banco.server";
import {
  AGENTE_PADRAO,
  LIMITES_PADRAO,
  type AgenteVoz,
  type LigacoesGravadas,
} from "../ligacoes/tipos";
import type { ConexaoServidor } from "../nucleo/tipos";

// Banco falso em memória: as conexões (com os segredos em texto puro, como o servidor os vê depois
// de decifrar) e as escritas das ligações, na ordem, numa linha do tempo junto com a rede.
type Linha = {
  id: string;
  gateway: "meta" | "zapi";
  id_externo: string;
  ativa: boolean;
  parametros: Record<string, unknown>;
  segredos: Record<string, string>;
};
const falso = vi.hoisted(() => ({
  /** a versão da linha (o atualizado_em que o gatilho renova) */
  versao: 0,
  linhas: [] as Linha[],
  tempo: [] as string[],
  chave: null as { provedor: string; chave: string } | null,
  resumo: null as unknown,
  voz: null as { id: string; nome: string } | null,
  /** As linhas de ligacao_agentes . */
  agentes: [] as LinhaAgente[],
  contexto: { texto: "Empresa e oferta: Consultoria de IA", criadoEm: "2026-11-10T10:00:00.000Z" },
  /** listarAgentes lança (o banco fora na desmontagem) */
  listarFalha: false,
  /** quantas gravações de sincronia ainda lançam (o banco fora) */
  sincroniaFalhas: 0,
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

function comoConexao(l: Linha): ConexaoServidor {
  return structuredClone({
    id: l.id,
    gateway: l.gateway,
    id_externo: l.id_externo,
    parametros: l.parametros,
    segredos: l.segredos,
    oficial: l.gateway === "meta",
  });
}

const dubles = vi.hoisted(() => ({
  conexaoAtiva: vi.fn(),
  carregarConexao: vi.fn(),
  lerChaveIA: vi.fn(),
  lerResumoChaveIA: vi.fn(),
  lerConfigVozTela: vi.fn(),
  iniciarLigacoes: vi.fn(),
  gravarLigacoes: vi.fn(),
  gravarProgressoLigacoes: vi.fn(),
  limparLigacoes: vi.fn(),
  idConexaoComLigacoesPendentes: vi.fn(),
  gravarElegibilidade: vi.fn(),
  lerVersaoConexaoAtiva: vi.fn(),
  lerVersaoConexao: vi.fn(),
}));
vi.mock("../nucleo/conexoes.server", () => ({
  conexaoAtiva: dubles.conexaoAtiva,
  carregarConexao: dubles.carregarConexao,
  lerChaveIA: dubles.lerChaveIA,
}));
vi.mock("./banco.server", () => ({
  lerResumoChaveIA: dubles.lerResumoChaveIA,
  lerConfigVozTela: dubles.lerConfigVozTela,
}));
// os agentes de voz e o Contexto, em memória (2.2)
vi.mock("../ligacoes/agentes-banco.server", () => ({
  listarAgentes: async () => {
    if (falso.listarFalha) throw new Error("banco_ler_agentes");
    return structuredClone(falso.agentes);
  },
  lerAgente: async (id: string) => structuredClone(falso.agentes.find((a) => a.id === id) ?? null),
  inserirAgente: async (campos: AgenteVoz, d: { atende: boolean; criadoPor: string | null }) => {
    const linha: LinhaAgente = {
      ...campos,
      id: `ag_${falso.agentes.length + 1}`,
      atende: d.atende,
      idExterno: null,
      versaoConfig: 0,
      sincronizadoEm: null,
      erroSincronia: null,
      criadoEm: new Date().toISOString(),
      atualizadoEm: `v${++falso.versao}`,
    };
    falso.agentes.push(linha);
    falso.tempo.push(`banco agente novo ${linha.nome}`);
    return structuredClone(linha);
  },
  atenderAgente: async (id: string) => {
    for (const a of falso.agentes) {
      if (a.atende !== (a.id === id)) a.atualizadoEm = `v${++falso.versao}`;
      a.atende = a.id === id;
    }
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
  lerLimites: async () => ({ ...LIMITES_PADRAO, simultaneas: 3 }),
  zerarIdsExternos: async (ids: string[]) => {
    for (const a of falso.agentes)
      if (a.idExterno && ids.includes(a.idExterno)) {
        a.idExterno = null;
        a.atualizadoEm = `v${++falso.versao}`;
      }
    falso.tempo.push(`banco zerar ${[...ids].sort().join(",")}`);
  },
}));
vi.mock("../ligacoes/banco.server", () => ({
  lerContextoAtual: async () => ({ ...falso.contexto }),
}));
vi.mock("./ligacoes-banco.server", () => ({
  iniciarLigacoes: dubles.iniciarLigacoes,
  gravarLigacoes: dubles.gravarLigacoes,
  gravarProgressoLigacoes: dubles.gravarProgressoLigacoes,
  limparLigacoes: dubles.limparLigacoes,
  idConexaoComLigacoesPendentes: dubles.idConexaoComLigacoesPendentes,
  gravarElegibilidade: dubles.gravarElegibilidade,
  lerVersaoConexaoAtiva: dubles.lerVersaoConexaoAtiva,
  lerVersaoConexao: dubles.lerVersaoConexao,
}));

import { VERSAO_AGENTE } from "@/features/servidor/ligacoes-elevenlabs";

import {
  ativarLigacoesLogica,
  desativarLigacoesLogica,
  desmontarLigacoes,
  desmontarLigacoesDaConexao,
  estadoLigacoesLogica,
  verificarLigacoesLogica,
} from "./ligacoes.server";

const MEMBRO = "9d1c7a20-0000-4000-8000-000000000001";
const CONEXAO = "c0ffee00-0000-4000-8000-0000000000aa";
const PHONE = "106540352242922";
const ORIGEM = "https://nina.exemplo.com";
const PREVIA = "https://id-preview--abc.lovable.app";

// Valores falsos, longos e únicos, para provar que nunca voltam nem vão ao log.
const CHAVE = "sk_eleven_chave_guardada_CHAVE_LIG_123456";
const TOKEN_META = "EAAG-token-da-meta-TOKEN_META_LIG_9988";
const APP_SECRET = "app-secret-meta-APPSECRET_LIG_7766";
const VERIFY = "verify-token-nosso-VERIFY_LIG_5544";
const HMAC = "wsec_segredo_hmac_HMAC_LIG_ZXCVBNM";
const SENHA = "senha-sip-meta-SENHA_LIG_QWERTYUIOP";

const META = "https://graph.facebook.com/v26.0";
const EL = "https://api.elevenlabs.io";

function linhaMeta(o: Partial<Linha> = {}): Linha {
  return {
    id: CONEXAO,
    gateway: "meta",
    id_externo: PHONE,
    ativa: true,
    parametros: { phoneId: PHONE, wabaId: "998877" },
    segredos: { token: TOKEN_META, appSecret: APP_SECRET, verifyToken: VERIFY },
    ...o,
  };
}

function ligacoesGravadas(o: Partial<LigacoesGravadas> = {}): LigacoesGravadas {
  return {
    versao: 1,
    situacao: "ativa",
    origem: ORIGEM,
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
    atualizadaEm: new Date().toISOString(),
    ...o,
  };
}

function contexto(o: { admin?: boolean } = {}): ContextoUsuario {
  const { admin = true } = o;
  const consulta = {
    select: () => consulta,
    eq: () => consulta,
    maybeSingle: async () => ({ data: { id: MEMBRO }, error: null }),
  };
  const supabase = {
    rpc: vi.fn(async () => ({ data: admin, error: null })),
    from: vi.fn(() => consulta),
  } as unknown as ClienteUsuario;
  return { supabase, userId: "user-1" };
}

// ---------- rede falsa: responde pela chave "MÉTODO url" ----------

/**
 * `antes` roda quando o pedido chega, antes da resposta (o que acontece "ao mesmo tempo"); `espera`
 * segura a resposta até a promessa resolver (para intercalar dois caminhos passo a passo).
 */
type Resposta = {
  status: number;
  corpo?: unknown;
  lancar?: Error;
  antes?: () => void;
  espera?: Promise<unknown>;
};
type Chamada = { metodo: string; url: string; init: RequestInit };

function rede(respostas: Record<string, Resposta | Resposta[]>) {
  const chamadas: Chamada[] = [];
  const naoEsperadas: string[] = [];
  const fetch: Fetch = async (url, init) => {
    const metodo = init?.method ?? "GET";
    const chave = `${metodo} ${url}`;
    chamadas.push({ metodo, url, init: init ?? {} });
    falso.tempo.push(`rede ${chave}`);
    const r0 = respostas[chave];
    const r = Array.isArray(r0) ? r0.shift() : r0;
    if (!r) {
      naoEsperadas.push(chave);
      throw new Error("pedido não esperado");
    }
    r.antes?.();
    if (r.espera) await r.espera;
    if (r.lancar) throw r.lancar;
    const texto = r.corpo === undefined ? "" : JSON.stringify(r.corpo);
    return { status: r.status, text: async () => texto } as unknown as Response;
  };
  return { fetch, chamadas, naoEsperadas };
}

function corpoDe(c: Chamada | undefined): unknown {
  return c?.init.body === undefined ? undefined : JSON.parse(String(c.init.body));
}

const R = {
  numero: `GET ${META}/${PHONE}?fields=display_phone_number%2Cwhatsapp_business_manager_messaging_limit%2Chealth_status`,
  conferirSip: `GET ${META}/${PHONE}/settings`,
  agentes: `GET ${EL}/v1/convai/agents?page_size=1`,
  segredo: `POST ${EL}/v1/convai/secrets`,
  webhook: `POST ${EL}/v1/workspace/webhooks`,
  ferramenta: `POST ${EL}/v1/convai/tools`,
  agente: `POST ${EL}/v1/convai/agents/create`,
  ligarSip: `POST ${META}/${PHONE}/settings`,
  senha: `GET ${META}/${PHONE}/settings?include_sip_credentials=true`,
  tronco: `POST ${EL}/v1/convai/phone-numbers`,
  patchTronco: `PATCH ${EL}/v1/convai/phone-numbers/phnum_1`,
  apagarTronco: `DELETE ${EL}/v1/convai/phone-numbers/phnum_1`,
  apagarAgente: `DELETE ${EL}/v1/convai/agents/agent_1`,
  apagarFerramenta: `DELETE ${EL}/v1/convai/tools/tool_1?force=true`,
  apagarWebhook: `DELETE ${EL}/v1/workspace/webhooks/wh_1`,
  apagarSegredo: `DELETE ${EL}/v1/convai/secrets/seg_1`,
};

function respostasDoAtivar(): Record<string, Resposta | Resposta[]> {
  return {
    [R.numero]: {
      status: 200,
      corpo: {
        display_phone_number: "+55 11 99999-0000",
        whatsapp_business_manager_messaging_limit: "TIER_2K",
      },
    },
    [R.conferirSip]: { status: 200, corpo: { calling: { status: "DISABLED" } } },
    [R.agentes]: { status: 200, corpo: { agents: [] } },
    [R.segredo]: { status: 200, corpo: { secret_id: "seg_1" } },
    [R.webhook]: { status: 200, corpo: { webhook_id: "wh_1", webhook_secret: HMAC } },
    [R.ferramenta]: { status: 200, corpo: { id: "tool_1" } },
    [R.agente]: { status: 200, corpo: { agent_id: "agent_1" } },
    // o primeiro POST liga o SIP, o segundo as chamadas (D18) e o terceiro o callback (spec da
    // saída); o seguinte (se houver) é o desligar da desmontagem
    [R.ligarSip]: [
      { status: 200, corpo: { success: true } },
      { status: 200, corpo: { success: true } },
      { status: 200, corpo: { success: true } },
      { status: 200, corpo: { success: true } },
    ],
    [R.senha]: {
      status: 200,
      corpo: {
        calling: {
          sip: { servers: [{ hostname: "sip.rtc.elevenlabs.io", sip_user_password: SENHA }] },
        },
      },
    },
    [R.tronco]: { status: 200, corpo: { phone_number_id: "phnum_1" } },
    // sem as mensagens SIP, o agente e a saída (seção 1)
    [R.patchTronco]: [
      { status: 200, corpo: {} },
      { status: 200, corpo: {} },
      { status: 200, corpo: {} },
    ],
    [R.apagarTronco]: { status: 204 },
    [R.apagarAgente]: { status: 204 },
    [R.apagarFerramenta]: { status: 204 },
    [R.apagarWebhook]: { status: 204 },
    [R.apagarSegredo]: { status: 204 },
  };
}

/** Uma promessa que o teste resolve na hora que quiser. */
function adiada<T = void>() {
  let resolver: (v: T) => void = () => {};
  const promessa = new Promise<T>((r) => (resolver = r));
  return { promessa, resolver };
}

/** Deixa as promessas pendentes andarem até `ok` valer (sem relógio). */
async function ate(ok: () => boolean) {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(ok()).toBe(true);
}

/**
 * O que ficou na conta da ElevenLabs e na Meta pela rede: cada id criado sem DELETE depois, e a
 * Meta com o SIP ligado sem o desligar depois do último ligar.
 */
function sobrouNaRede(chamadas: Chamada[]): string[] {
  const criados: string[] = [];
  const criadoPor: Record<string, string> = {
    [R.segredo]: "seg_1",
    [R.webhook]: "wh_1",
    [R.ferramenta]: "tool_1",
    [R.agente]: "agent_1",
    [R.tronco]: "phnum_1",
  };
  let metaLigada = false;
  for (const c of chamadas) {
    const k = `${c.metodo} ${c.url}`;
    if (criadoPor[k]) criados.push(criadoPor[k]!);
    if (k === R.ligarSip) {
      const corpo = JSON.stringify(corpoDe(c));
      if (corpo.includes('"sip":{"status":"DISABLED"}')) metaLigada = false;
      else if (corpo.includes('"sip"')) metaLigada = true;
    }
  }
  const apagados = chamadas.filter((c) => c.metodo === "DELETE").map((c) => c.url);
  const sobra = criados.filter((id) => !apagados.some((u) => u.includes(`/${id}`)));
  return metaLigada ? ["meta", ...sobra] : sobra;
}

/** A versão de uma linha no banco falso: o conteúdo dela (o atualizado_em muda a cada escrita). */
function versaoDa(l: Linha): string {
  return JSON.stringify([l.ativa, l.parametros, l.segredos, statusDa(l)]);
}

/** O status da conexão no banco falso (o padrão é "conectada"). */
function statusDa(l: Linha): string {
  return (l as Linha & { status?: string }).status ?? "conectada";
}

function linha(id = CONEXAO): Linha | undefined {
  return falso.linhas.find((l) => l.id === id);
}

/** A trava das escritas fora da ativação (D28), como a do banco: null = só sem ligações. */
function travaConfere(l: Linha, anterior: string | null): boolean {
  const atual = l.parametros["ligacoes"] as LigacoesGravadas | undefined;
  return anterior === null ? atual === undefined : atual?.atualizadaEm === anterior;
}

/** Grava o estado na linha e anota na linha do tempo: situação, ids presentes e a Meta. */
function escrever(l: Linha, estado: LigacoesGravadas, segredos: Record<string, string> = {}) {
  l.parametros = { ...l.parametros, ligacoes: structuredClone(estado) };
  l.segredos = { ...l.segredos, ...segredos };
  const ids = Object.entries(estado.eleven)
    .filter(([, v]) => v)
    .map(([k]) => k);
  falso.tempo.push(
    `banco gravar ${estado.situacao} [${ids.join(",")}]${estado.metaSip ? " meta" : ""}`,
  );
}

function semSegredos(valor: unknown, ...extras: string[]) {
  const texto = JSON.stringify(valor);
  for (const s of [CHAVE, TOKEN_META, APP_SECRET, VERIFY, HMAC, SENHA, ...extras]) {
    expect(texto).not.toContain(s);
  }
}

let espioes: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  falso.linhas = [linhaMeta()];
  falso.agentes = [];
  falso.listarFalha = false;
  falso.sincroniaFalhas = 0;
  falso.tempo = [];
  falso.voz = { id: "voz123ABC", nome: "Ana" };
  dubles.conexaoAtiva.mockReset().mockImplementation(async () => {
    const l = falso.linhas.find((x) => x.ativa);
    return l ? comoConexao(l) : null;
  });
  dubles.carregarConexao.mockReset().mockImplementation(async (id: string) => {
    const l = linha(id);
    return l ? comoConexao(l) : null;
  });
  dubles.lerChaveIA.mockReset().mockResolvedValue({
    id: "chave-1",
    provedor: "elevenlabs",
    modelo: "eleven_multilingual_v2",
    workspace_id: null,
    chave: CHAVE,
  });
  dubles.lerResumoChaveIA.mockReset().mockResolvedValue({
    id: "chave-1",
    provedor: "elevenlabs",
    modelo: "eleven_multilingual_v2",
    workspace_id: null,
    status: "ativa",
    ultimos4: "3456",
    ultimo_erro: null,
    temChave: true,
  });
  dubles.lerConfigVozTela
    .mockReset()
    .mockImplementation(async () => ({ modo: "quando_audio", voz: falso.voz, erro: null }));
  dubles.iniciarLigacoes
    .mockReset()
    .mockImplementation(async (id: string, estado: LigacoesGravadas, token: string) => {
      const l = linha(id);
      if (!l || "ligacoes" in l.parametros) return false;
      l.parametros = { ...l.parametros, ligacoes: structuredClone(estado) };
      l.segredos = { ...l.segredos, ligacaoToken: token };
      falso.tempo.push("banco iniciar");
      return true;
    });
  // as escritas fora da ativação têm a trava do atualizadaEm lido (D28): null = só sem ligações
  dubles.gravarLigacoes
    .mockReset()
    .mockImplementation(async (id: string, estado: LigacoesGravadas, anterior: string | null) => {
      const l = linha(id);
      if (!l) throw new Error("banco_gravar_ligacoes");
      if (!travaConfere(l, anterior)) {
        falso.tempo.push("banco gravar perdeu");
        return false;
      }
      escrever(l, estado);
      return true;
    });
  // a trava do progresso (D21): só grava com a conexão ativa, ainda "ativando" e com o mesmo
  // atualizadaEm da gravação anterior
  dubles.gravarProgressoLigacoes
    .mockReset()
    .mockImplementation(
      async (
        id: string,
        estado: LigacoesGravadas,
        anterior: string,
        segredos: Record<string, string> = {},
      ) => {
        const l = linha(id);
        const atual = l?.parametros["ligacoes"] as LigacoesGravadas | undefined;
        if (!l || !l.ativa || atual?.situacao !== "ativando" || atual.atualizadaEm !== anterior) {
          falso.tempo.push("banco progresso perdeu");
          return false;
        }
        escrever(l, estado, segredos);
        return true;
      },
    );
  dubles.limparLigacoes.mockReset().mockImplementation(async (id: string, anterior: string) => {
    const l = linha(id);
    if (!l) throw new Error("banco_limpar_ligacoes");
    if (!travaConfere(l, anterior)) {
      falso.tempo.push("banco limpar perdeu");
      return false;
    }
    const { ligacoes: _l, ...parametros } = l.parametros;
    const { ligacaoToken: _t, ligacaoHmac: _h, ...segredos } = l.segredos;
    l.parametros = parametros;
    l.segredos = segredos;
    falso.tempo.push("banco limpar");
    return true;
  });
  // a verificação (seção 21): só com a conexão ativa e sem ativação começada
  // a versão da linha (o atualizado_em do banco): aqui, o conteúdo dela; qualquer escrita a muda
  dubles.lerVersaoConexaoAtiva.mockReset().mockImplementation(async () => {
    const l = falso.linhas.find((x) => x.ativa);
    return l ? { id: l.id, atualizadoEm: versaoDa(l), status: statusDa(l) } : null;
  });
  dubles.lerVersaoConexao.mockReset().mockImplementation(async (id: string) => {
    const l = linha(id);
    return l ? { id: l.id, atualizadoEm: versaoDa(l), status: statusDa(l) } : null;
  });
  // a verificação (seção 21): só com a conexão ativa e na versão lida antes de conferir
  // a verificação (seção 21): só com a conexão ativa e na versão lida antes de conferir; com
  // `seLigacoes`, só sobre o estado das ligações que a ativação deixou
  dubles.gravarElegibilidade
    .mockReset()
    .mockImplementation(
      async (
        v: { id: string; atualizadoEm: string },
        e: unknown,
        seLigacoes?: string | null,
        seConferidaEm?: string,
      ) => {
        const l = linha(v.id);
        const lig = l?.parametros["ligacoes"] as LigacoesGravadas | undefined;
        const ligacoesConferem =
          seLigacoes === undefined ||
          (seLigacoes === null ? lig === undefined : lig?.atualizadaEm === seLigacoes);
        const guardada = l?.parametros["ligacoesElegibilidade"] as
          { conferidaEm?: string } | undefined;
        const verificacaoConfere =
          seConferidaEm === undefined || guardada?.conferidaEm === seConferidaEm;
        if (
          !l ||
          !l.ativa ||
          versaoDa(l) !== v.atualizadoEm ||
          !ligacoesConferem ||
          !verificacaoConfere
        ) {
          falso.tempo.push("banco elegibilidade perdeu");
          return false;
        }
        l.parametros = { ...l.parametros, ligacoesElegibilidade: structuredClone(e) };
        falso.tempo.push("banco elegibilidade");
        return true;
      },
    );
  dubles.idConexaoComLigacoesPendentes.mockReset().mockImplementation(async () => {
    const l = falso.linhas.find((x) => !x.ativa && "ligacoes" in x.parametros);
    return l?.id ?? null;
  });
  espioes = [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
  ];
});

afterEach(() => {
  // nenhum log com chave, token, segredo ou senha
  for (const e of espioes) {
    for (const chamada of e.mock.calls) semSegredos(chamada);
    e.mockRestore();
  }
});

// ---------- estado ----------

describe("estadoLigacoes", () => {
  it("sem admin dá sem_acesso, sem ler nada", async () => {
    const r = await estadoLigacoesLogica(contexto({ admin: false }), { origem: ORIGEM });
    expect(r).toMatchObject({ ok: false, erro: "sem_acesso" });
    expect(dubles.conexaoAtiva).not.toHaveBeenCalled();
  });

  it("tudo pronto: situação pronta com os 4 requisitos, só lendo o banco", async () => {
    const r = await estadoLigacoesLogica(contexto(), { origem: ORIGEM });
    expect(r).toEqual({
      ok: true,
      estado: {
        situacao: "pronta",
        requisitos: {
          conexaoMeta: true,
          chaveVoz: true,
          vozEscolhida: true,
          enderecoPublicado: true,
        },
        elegibilidade: null,
        numero: null,
        ativadaEm: null,
        pendencias: [],
      },
    });
    // nenhuma chave decifrada só para ler o estado
    expect(dubles.lerChaveIA).not.toHaveBeenCalled();
  });

  it("indisponível: cada requisito que falta aparece", async () => {
    falso.linhas = [linhaMeta({ gateway: "zapi" })];
    falso.voz = null;
    dubles.lerResumoChaveIA.mockResolvedValue(null);
    const r = await estadoLigacoesLogica(contexto(), { origem: PREVIA });
    expect(r).toMatchObject({
      ok: true,
      estado: {
        situacao: "indisponivel",
        requisitos: {
          conexaoMeta: false,
          chaveVoz: false,
          vozEscolhida: false,
          enderecoPublicado: false,
        },
      },
    });
    for (const origem of ["http://localhost:3000", "http://nina.exemplo.com"]) {
      const local = await estadoLigacoesLogica(contexto(), { origem });
      expect(local.ok && local.estado.requisitos.enderecoPublicado).toBe(false);
    }
  });

  it("chave de outro provedor ou inválida não conta", async () => {
    dubles.lerResumoChaveIA.mockResolvedValue({
      provedor: "elevenlabs",
      status: "invalida",
      temChave: true,
    });
    const r = await estadoLigacoesLogica(contexto(), { origem: ORIGEM });
    expect(r.ok && r.estado.requisitos.chaveVoz).toBe(false);
  });

  it("ativa: o número formatado e a data", async () => {
    falso.linhas = [linhaMeta({ parametros: { phoneId: PHONE, ligacoes: ligacoesGravadas() } })];
    const r = await estadoLigacoesLogica(contexto(), { origem: ORIGEM });
    expect(r).toMatchObject({
      ok: true,
      estado: {
        situacao: "ativa",
        numero: "+55 11 99999-0000",
        ativadaEm: "2026-11-11T12:00:00.000Z",
      },
    });
    semSegredos(r);
  });

  it("pendências de uma conexão que já saiu (D15) aparecem no cartão", async () => {
    falso.linhas = [
      linhaMeta({
        id: "antiga",
        ativa: false,
        segredos: {},
        parametros: {
          ligacoes: ligacoesGravadas({ situacao: "com_pendencias", pendencias: ["agente"] }),
        },
      }),
      linhaMeta({ id: "nova", id_externo: "222" }),
    ];
    const r = await estadoLigacoesLogica(contexto(), { origem: ORIGEM });
    expect(r).toMatchObject({
      ok: true,
      estado: { situacao: "com_pendencias", pendencias: ["agente"] },
    });
  });

  it("banco fora: falha fixa", async () => {
    dubles.conexaoAtiva.mockRejectedValue(new Error("banco_ler_conexao"));
    const r = await estadoLigacoesLogica(contexto(), { origem: ORIGEM });
    expect(r).toMatchObject({ ok: false, erro: "erro_ao_ler" });
  });
});

// ---------- ativar ----------

describe("ativarLigacoes", () => {
  it("caminho feliz: cada pedido na ordem, o progresso gravado a cada recurso e situação ativa", async () => {
    const { fetch, chamadas, naoEsperadas } = rede(respostasDoAtivar());
    const r = await ativarLigacoesLogica(contexto(), { origem: `${ORIGEM}/` }, { fetch });
    expect(naoEsperadas).toEqual([]);
    expect(r).toMatchObject({
      ok: true,
      estado: { situacao: "ativa", numero: "+55 11 99999-0000", pendencias: [] },
    });
    expect(falso.tempo).toEqual([
      `rede ${R.numero}`,
      `rede ${R.conferirSip}`,
      `rede ${R.agentes}`,
      // a verificação aprovada fica guardada na conexão (seção 21)
      "banco elegibilidade",
      // a linha do agente "Nina" (L2)
      "banco agente novo Nina",
      "banco iniciar",
      // a Meta antes da ElevenLabs (seção 21): se ela recusar, nada foi criado lá
      "banco gravar ativando [] meta",
      `rede ${R.ligarSip}`,
      `rede ${R.senha}`,
      `rede ${R.segredo}`,
      "banco gravar ativando [segredoId] meta",
      `rede ${R.webhook}`,
      "banco gravar ativando [segredoId,webhookId] meta",
      `rede ${R.ferramenta}`,
      "banco gravar ativando [segredoId,webhookId,ferramentaId] meta",
      `rede ${R.agente}`,
      "banco gravar ativando [segredoId,webhookId,ferramentaId,agenteId] meta",
      `rede ${R.tronco}`,
      "banco gravar ativando [segredoId,webhookId,ferramentaId,agenteId,troncoId] meta",
      `rede ${R.patchTronco}`,
      `rede ${R.patchTronco}`,
      // a saída do tronco (seção 1)
      `rede ${R.patchTronco}`,
      // D18: as chamadas só ligam com o tronco pronto e ligado ao agente
      `rede ${R.ligarSip}`,
      // o callback de 7 dias, à parte (spec da saída; Opus, PR #24)
      `rede ${R.ligarSip}`,
      "banco gravar ativa [segredoId,webhookId,ferramentaId,agenteId,troncoId] meta",
      // a aprovação de novo, presa ao estado "ativa" (Opus, rodada 4)
      "banco elegibilidade",
    ]);

    // o estado gravado, sem segredo nenhum em parametros
    const l = linha()!;
    expect(l.parametros["phoneId"]).toBe(PHONE);
    expect(l.parametros["wabaId"]).toBe("998877");
    const gravado = l.parametros["ligacoes"] as LigacoesGravadas;
    expect(gravado).toMatchObject({
      versao: 1,
      situacao: "ativa",
      origem: ORIGEM,
      numero: "5511999990000",
      limiteMeta: "TIER_2K",
      metaSip: true,
      eleven: {
        segredoId: "seg_1",
        webhookId: "wh_1",
        ferramentaId: "tool_1",
        agenteId: "agent_1",
        troncoId: "phnum_1",
      },
    });
    expect(gravado.ativadaEm).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(gravado.atualizadaEm).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    semSegredos(l.parametros);
    // a verificação aprovada, guardada e devolvida no estado
    expect(l.parametros["ligacoesElegibilidade"]).toMatchObject({
      versao: 1,
      elegivel: true,
      limiteMeta: "TIER_2K",
    });
    expect(r.ok && r.estado.elegibilidade?.elegivel).toBe(true);

    // os segredos: os da Meta ficam, o token e o HMAC entram
    const token = l.segredos["ligacaoToken"]!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(l.segredos).toEqual({
      token: TOKEN_META,
      appSecret: APP_SECRET,
      verifyToken: VERIFY,
      ligacaoToken: token,
      ligacaoHmac: HMAC,
    });

    // os pedidos: chave da ElevenLabs no xi-api-key, token da Meta no Bearer
    const porChave = (k: string) => chamadas.find((c) => `${c.metodo} ${c.url}` === k);
    expect(porChave(R.numero)?.init.headers).toEqual({ Authorization: `Bearer ${TOKEN_META}` });
    expect(porChave(R.agentes)?.init.headers).toEqual({ "xi-api-key": CHAVE });
    expect(corpoDe(porChave(R.segredo))).toMatchObject({ type: "new", value: `Bearer ${token}` });
    expect(corpoDe(porChave(R.webhook))).toMatchObject({
      settings: {
        auth_type: "hmac",
        webhook_url: `${ORIGEM}/api/public/ligacoes/${CONEXAO}/pos-chamada`,
      },
    });
    expect(corpoDe(porChave(R.ferramenta))).toMatchObject({
      tool_config: {
        api_schema: {
          url: `${ORIGEM}/api/public/ligacoes/${CONEXAO}/equipe`,
          request_headers: { Authorization: { secret_id: "seg_1" } },
        },
      },
    });
    expect(corpoDe(porChave(R.agente))).toMatchObject({
      conversation_config: { tts: { voice_id: "voz123ABC" } },
      platform_settings: {
        workspace_overrides: {
          conversation_initiation_client_data_webhook: {
            url: `${ORIGEM}/api/public/ligacoes/${CONEXAO}/inicio`,
            request_headers: { Authorization: { secret_id: "seg_1" } },
          },
          webhooks: { post_call_webhook_id: "wh_1" },
        },
      },
    });
    // D18: o SIP liga com as chamadas desligadas; o último POST liga só as chamadas
    const postsMeta = chamadas.filter((c) => `${c.metodo} ${c.url}` === R.ligarSip);
    expect(postsMeta.map(corpoDe)).toEqual([
      expect.objectContaining({
        calling: expect.objectContaining({
          status: "DISABLED",
          sip: expect.objectContaining({ status: "ENABLED" }),
        }),
      }),
      { calling: { status: "ENABLED" } },
      { calling: { callback_permission_status: "ENABLED" } },
    ]);
    expect(corpoDe(porChave(R.tronco))).toMatchObject({
      phone_number: "+5511999990000",
      inbound_trunk_config: { credentials: { username: "5511999990000", password: SENHA } },
    });
    const patches = chamadas.filter((c) => `${c.metodo} ${c.url}` === R.patchTronco);
    expect(patches.map(corpoDe)).toEqual([
      { store_sip_messages: false },
      { agent_id: "agent_1" },
      {
        outbound_trunk_config: {
          address: "wa.meta.vc",
          transport: "tls",
          media_encryption: "required",
          credentials: { username: "5511999990000", password: SENHA },
          custom_from_domain: "sip.rtc.elevenlabs.io",
        },
      },
    ]);
    expect(gravado.saida).toBe(true);

    // nada de segredo no resultado nem no log (afterEach)
    semSegredos(r, token);
  });

  it("sem admin dá sem_acesso, sem rede", async () => {
    const { fetch, chamadas } = rede({});
    expect(
      await ativarLigacoesLogica(contexto({ admin: false }), { origem: ORIGEM }, { fetch }),
    ).toMatchObject({ ok: false, erro: "sem_acesso" });
    expect(chamadas).toHaveLength(0);
  });

  const preparos: [string, () => void, string][] = [
    ["sem_conexao_meta", () => void (falso.linhas = [linhaMeta({ gateway: "zapi" })]), ORIGEM],
    ["sem_conexao_meta", () => void (falso.linhas = []), ORIGEM],
    ["sem_chave_voz", () => void dubles.lerResumoChaveIA.mockResolvedValue(null), ORIGEM],
    ["sem_voz", () => void (falso.voz = null), ORIGEM],
    ["endereco_de_previa", () => undefined, PREVIA],
  ];
  it.each(preparos)(
    "requisito: %s, só as leituras da verificação, sem criar nada",
    async (erro, preparar, origem) => {
      preparar();
      const { fetch, chamadas } = rede(respostasDoAtivar());
      const r = await ativarLigacoesLogica(contexto(), { origem }, { fetch });
      expect(r).toMatchObject({ ok: false, erro });
      // a falha traz a lista inteira da verificação (seção 21), para o cartão mostrar
      expect(r.ok ? null : r.elegibilidade?.elegivel).toBe(false);
      expect(chamadas.every((c) => c.metodo === "GET")).toBe(true);
      expect(dubles.iniciarLigacoes).not.toHaveBeenCalled();
    },
  );

  it("duplo clique: ativando ou ativa dá ja_ativa sem chamar ninguém", async () => {
    for (const situacao of ["ativando", "ativa"] as const) {
      falso.linhas = [
        linhaMeta({ parametros: { phoneId: PHONE, ligacoes: ligacoesGravadas({ situacao }) } }),
      ];
      const { fetch, chamadas } = rede({});
      const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
      expect(r).toMatchObject({ ok: false, erro: "ja_ativa" });
      expect(chamadas).toHaveLength(0);
    }
  });

  it("duplo clique ao mesmo tempo: a trava do banco perde, nada é criado", async () => {
    dubles.iniciarLigacoes.mockResolvedValue(false);
    const { fetch, chamadas } = rede(respostasDoAtivar());
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "ja_ativa" });
    // só as conferências de leitura; nenhum POST
    expect(chamadas.map((c) => c.metodo)).toEqual(["GET", "GET", "GET"]);
  });

  it("pendências de antes: pede para terminar a desativação, sem rede", async () => {
    falso.linhas = [
      linhaMeta({
        parametros: {
          phoneId: PHONE,
          ligacoes: ligacoesGravadas({ situacao: "com_pendencias", pendencias: ["tronco"] }),
        },
      }),
    ];
    const { fetch, chamadas } = rede({});
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "com_pendencias" });
    expect(r.ok ? "" : r.mensagem).toContain("pendências");
    expect(r.ok ? "" : r.mensagem).not.toContain("Tentar de novo");
    expect(chamadas).toHaveLength(0);
  });

  it("chave sem acesso aos agentes: para antes de criar qualquer coisa", async () => {
    const respostas = respostasDoAtivar();
    respostas[R.agentes] = { status: 401, corpo: { detail: { status: "missing_permissions" } } };
    const { fetch, chamadas } = rede(respostas);
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({
      ok: false,
      erro: "chave_sem_acesso_agentes",
      mensagem:
        "A chave da ElevenLabs não tem acesso aos agentes. Na ElevenLabs, edite a chave e ligue ElevenLabs Agents (escrita) e Webhooks (escrita).",
    });
    expect(chamadas).toHaveLength(3);
    expect(dubles.iniciarLigacoes).not.toHaveBeenCalled();
  });

  it("token da Meta recusado na leitura do número: meta_token_invalido, nada criado", async () => {
    const respostas = respostasDoAtivar();
    respostas[R.numero] = { status: 401, corpo: { error: { code: 190 } } };
    const { fetch, chamadas } = rede(respostas);
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "meta_token_invalido" });
    // a ElevenLabs ainda é conferida (a lista mostra os dois); o SIP da Meta, não
    expect(chamadas.map((c) => `${c.metodo} ${c.url}`)).toEqual([R.numero, R.agentes]);
  });

  it("número em outra conta (409 no tronco): desmonta tudo na ordem da D17 e limpa", async () => {
    const respostas = respostasDoAtivar();
    respostas[R.tronco] = { status: 409, corpo: { detail: { status: "phone_number_conflict" } } };
    const { fetch, naoEsperadas } = rede(respostas);
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(naoEsperadas).toEqual([]);
    expect(r).toMatchObject({
      ok: false,
      erro: "numero_em_outra_conta",
      mensagem:
        "Este número já está cadastrado em outra conta da ElevenLabs. Apague-o lá (Agents → Phone Numbers) ou use a chave daquela conta.",
    });
    const depois = falso.tempo.slice(falso.tempo.indexOf(`rede ${R.tronco}`) + 1);
    expect(depois).toEqual([
      `rede ${R.ligarSip}`, // Meta: desliga o que o app ligou
      `rede ${R.apagarAgente}`,
      `rede ${R.apagarFerramenta}`,
      `rede ${R.apagarWebhook}`,
      `rede ${R.apagarSegredo}`,
      "banco limpar",
    ]);
    expect(linha()!.parametros).toEqual({
      phoneId: PHONE,
      wabaId: "998877",
      ligacoesElegibilidade: expect.objectContaining({ elegivel: true }),
    });
    expect(linha()!.segredos).toEqual({
      token: TOKEN_META,
      appSecret: APP_SECRET,
      verifyToken: VERIFY,
    });
  });

  it("a desmontagem desliga a Meta com o corpo DISABLED", async () => {
    const respostas = respostasDoAtivar();
    respostas[R.tronco] = { status: 500 };
    const { fetch, chamadas } = rede(respostas);
    await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    const posts = chamadas.filter((c) => `${c.metodo} ${c.url}` === R.ligarSip);
    expect(posts.map(corpoDe)[1]).toEqual({
      calling: { status: "DISABLED", sip: { status: "DISABLED" } },
    });
  });

  it("a Meta recusou: meta_recusou, nada criado na ElevenLabs e a desmontagem não desliga o que não ligou", async () => {
    const respostas = respostasDoAtivar();
    respostas[R.ligarSip] = { status: 400, corpo: { error: { code: 138006 } } };
    const { fetch, chamadas } = rede(respostas);
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "meta_recusou" });
    expect(chamadas.filter((c) => `${c.metodo} ${c.url}` === R.ligarSip)).toHaveLength(1);
    // a Meta vem antes da ElevenLabs (seção 21): nada lá para apagar
    expect(chamadas.some((c) => c.metodo !== "GET" && c.url.startsWith(EL))).toBe(false);
    expect(falso.tempo.slice(-2)).toEqual([`rede ${R.ligarSip}`, "banco limpar"]);
  });

  it.each([
    [138015, "meta_limite", "meta_limite"],
    [138014, "meta_pausada", "meta_numero"],
  ] as const)(
    "a Meta recusa o SIP com %s: %s, nada criado na ElevenLabs e a lista diz o motivo",
    async (codigo, erro, item) => {
      const respostas = respostasDoAtivar();
      respostas[R.ligarSip] = { status: 400, corpo: { error: { code: codigo } } };
      const { fetch, chamadas } = rede(respostas);
      const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
      expect(r).toMatchObject({ ok: false, erro });
      expect(chamadas.some((c) => c.metodo !== "GET" && c.url.startsWith(EL))).toBe(false);
      const el = r.ok ? null : r.elegibilidade;
      expect(el?.elegivel).toBe(false);
      expect(el?.itens.find((i) => i.id === item)?.estado).toBe("falta");
      // e fica guardada: o cartão mostra o motivo sem conferir de novo
      expect(linha()!.parametros["ligacoesElegibilidade"]).toMatchObject({ elegivel: false });
    },
  );

  it("tempo esgotado na Meta: pode ter ligado, então a desmontagem desliga", async () => {
    const respostas = respostasDoAtivar();
    respostas[R.ligarSip] = [
      { status: 0, lancar: new Error("caiu") },
      { status: 200, corpo: { success: true } },
    ];
    const { fetch, chamadas } = rede(respostas);
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "provedor_fora" });
    expect(chamadas.filter((c) => `${c.metodo} ${c.url}` === R.ligarSip)).toHaveLength(2);
    expect(dubles.limparLigacoes).toHaveBeenCalledWith(CONEXAO, expect.any(String));
  });

  it("falha no meio com um recurso que não sai: fica com_pendencias", async () => {
    const respostas = respostasDoAtivar();
    respostas[R.agente] = { status: 422, corpo: { detail: [{ msg: "x" }] } };
    respostas[R.apagarFerramenta] = { status: 500 };
    const { fetch } = rede(respostas);
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "provedor_fora" });
    const gravado = linha()!.parametros["ligacoes"] as LigacoesGravadas;
    expect(gravado).toMatchObject({
      situacao: "com_pendencias",
      pendencias: ["ferramenta"],
      eleven: {
        segredoId: null,
        webhookId: null,
        ferramentaId: "tool_1",
        agenteId: null,
        troncoId: null,
      },
      metaSip: false,
    });
    expect(dubles.limparLigacoes).not.toHaveBeenCalled();
  });

  it("webhook criado sem o segredo HMAC: apaga o que criou", async () => {
    const respostas = respostasDoAtivar();
    respostas[R.webhook] = { status: 200, corpo: { webhook_id: "wh_1" } };
    const { fetch } = rede(respostas);
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "provedor_fora" });
    expect(falso.tempo.slice(-3)).toEqual([
      `rede ${R.apagarWebhook}`,
      `rede ${R.apagarSegredo}`,
      "banco limpar",
    ]);
  });

  it("o banco falhou no progresso: desmonta e devolve erro_ao_gravar", async () => {
    dubles.gravarProgressoLigacoes.mockRejectedValueOnce(new Error("banco_gravar_ligacoes"));
    const { fetch } = rede(respostasDoAtivar());
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "erro_ao_gravar" });
    // o primeiro progresso é o da Meta, antes de pedir: a desmontagem desliga por garantia e nada
    // foi criado na ElevenLabs
    expect(falso.tempo.slice(-2)).toEqual([`rede ${R.ligarSip}`, "banco limpar"]);
    expect(falso.tempo.some((t) => t.startsWith(`rede POST ${EL}`))).toBe(false);
  });

  it("a trava do banco falhou: erro_ao_gravar, nada criado", async () => {
    dubles.iniciarLigacoes.mockRejectedValue(new Error("banco_ler_conexao"));
    const { fetch, chamadas } = rede(respostasDoAtivar());
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "erro_ao_gravar" });
    expect(chamadas.map((c) => c.metodo)).toEqual(["GET", "GET", "GET"]);
  });

  it("D18: a Meta recusa ligar as chamadas no fim: desliga o SIP e desmonta tudo", async () => {
    const respostas = respostasDoAtivar();
    respostas[R.ligarSip] = [
      { status: 200, corpo: { success: true } },
      { status: 400, corpo: { error: { code: 138006 } } },
      { status: 200, corpo: { success: true } },
    ];
    const { fetch, chamadas, naoEsperadas } = rede(respostas);
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(naoEsperadas).toEqual([]);
    expect(r).toMatchObject({ ok: false, erro: "meta_recusou" });
    const posts = chamadas.filter((c) => `${c.metodo} ${c.url}` === R.ligarSip).map(corpoDe);
    expect(posts).toHaveLength(3);
    expect(posts[1]).toEqual({ calling: { status: "ENABLED" } });
    expect(posts[2]).toEqual({ calling: { status: "DISABLED", sip: { status: "DISABLED" } } });
    expect(falso.tempo.slice(-6)).toEqual([
      `rede ${R.apagarTronco}`,
      `rede ${R.apagarAgente}`,
      `rede ${R.apagarFerramenta}`,
      `rede ${R.apagarWebhook}`,
      `rede ${R.apagarSegredo}`,
      "banco limpar",
    ]);
  });

  it("D19: o número já tem servidor SIP de outro sistema: meta_sip_em_uso, sem criar nada", async () => {
    const respostas = respostasDoAtivar();
    respostas[R.conferirSip] = {
      status: 200,
      corpo: {
        calling: {
          sip: { status: "ENABLED", servers: [{ hostname: "sip.outro.com.br", port: 5061 }] },
        },
      },
    };
    const { fetch, chamadas } = rede(respostas);
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "meta_sip_em_uso" });
    expect(r.ok ? "" : r.mensagem).toContain("painel da Meta");
    expect(chamadas.map((c) => `${c.metodo} ${c.url}`)).toEqual([
      R.numero,
      R.conferirSip,
      R.agentes,
    ]);
    expect(dubles.iniciarLigacoes).not.toHaveBeenCalled();
    expect(linha()!.parametros).not.toHaveProperty("ligacoes");
  });

  it("D33: o número já tem o SIP ligado no servidor da ElevenLabs: meta_sip_em_uso, sem criar nada", async () => {
    const respostas = respostasDoAtivar();
    respostas[R.conferirSip] = {
      status: 200,
      corpo: {
        calling: {
          status: "DISABLED",
          sip: { status: "ENABLED", servers: [{ hostname: "sip.rtc.elevenlabs.io", port: 5061 }] },
        },
      },
    };
    const { fetch, chamadas } = rede(respostas);
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "meta_sip_em_uso" });
    expect(r.ok ? "" : r.mensagem).toContain("já tem ligações ligadas na Meta");
    // nenhum POST na Meta e, na ElevenLabs, só a leitura da verificação
    expect(chamadas.map((c) => `${c.metodo} ${c.url}`)).toEqual([
      R.numero,
      R.conferirSip,
      R.agentes,
    ]);
    expect(dubles.iniciarLigacoes).not.toHaveBeenCalled();
    expect(linha()!.parametros).not.toHaveProperty("ligacoes");
  });

  describe("D20: ativação abandonada", () => {
    const velha = () => new Date(Date.now() - 3 * 60_000).toISOString();
    function comAtivando(o: Partial<LigacoesGravadas> = {}) {
      falso.linhas = [
        linhaMeta({
          parametros: {
            phoneId: PHONE,
            ligacoes: ligacoesGravadas({
              situacao: "ativando",
              ativadaEm: null,
              eleven: {
                segredoId: "seg_1",
                webhookId: "wh_1",
                ferramentaId: null,
                agenteId: null,
                troncoId: null,
              },
              metaSip: false,
              ...o,
            }),
          },
        }),
      ];
    }

    it("ativando recente continua ativando; parado há mais de 2 minutos vira com_pendencias com o que criou", async () => {
      comAtivando();
      expect(await estadoLigacoesLogica(contexto(), { origem: ORIGEM })).toMatchObject({
        ok: true,
        estado: { situacao: "ativando", pendencias: [] },
      });
      comAtivando({ atualizadaEm: velha(), metaSip: true });
      expect(await estadoLigacoesLogica(contexto(), { origem: ORIGEM })).toMatchObject({
        ok: true,
        estado: {
          situacao: "com_pendencias",
          pendencias: ["meta", "webhook", "segredo"],
          // o cartão diz "A ativação não terminou", não "Desativação incompleta"
          abandonada: true,
        },
      });
    });

    it("estado antigo, sem atualizadaEm, conta como abandonado", async () => {
      const { atualizadaEm: _a, ...semCampo } = ligacoesGravadas({ situacao: "ativando" });
      falso.linhas = [linhaMeta({ parametros: { phoneId: PHONE, ligacoes: semCampo } })];
      expect(await estadoLigacoesLogica(contexto(), { origem: ORIGEM })).toMatchObject({
        ok: true,
        estado: { situacao: "com_pendencias" },
      });
    });

    it("ativar na abandonada pede o Tentar de novo, sem rede; recente dá ja_ativa", async () => {
      comAtivando({ atualizadaEm: velha() });
      const { fetch, chamadas } = rede({});
      const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
      expect(r).toMatchObject({ ok: false, erro: "com_pendencias" });
      expect(r.ok ? "" : r.mensagem).toContain("Tentar de novo");
      expect(r.ok ? "" : r.mensagem).not.toContain("já começou");
      expect(chamadas).toHaveLength(0);

      comAtivando();
      const recente = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
      expect(recente.ok ? "" : recente.mensagem).toContain("já começou");
      expect(chamadas).toHaveLength(0);
    });

    it("desativar (o Tentar de novo) desmonta o que a ativação criou e limpa", async () => {
      comAtivando({ atualizadaEm: velha() });
      const { fetch, chamadas } = rede(respostasDoAtivar());
      const r = await desativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
      expect(chamadas.map((c) => `${c.metodo} ${c.url}`)).toEqual([
        R.apagarWebhook,
        R.apagarSegredo,
      ]);
      expect(r).toMatchObject({ ok: true, estado: { situacao: "pronta", pendencias: [] } });
      expect(linha()!.parametros).not.toHaveProperty("ligacoes");
    });
  });

  describe("D21: a conexão sai durante a ativação", () => {
    /** O Desconectar: a desmontagem dele limpou as ligações, e a conexão ficou inativa e sem segredos. */
    function desconectar(ligacoes?: LigacoesGravadas) {
      const l = linha()!;
      const { ligacoes: _l, ...resto } = l.parametros;
      l.parametros = ligacoes ? { ...resto, ligacoes } : resto;
      l.ativa = false;
      l.segredos = {};
    }

    it("desconectar enquanto o segredo era criado: para, apaga o segredo com a chave em memória e devolve ativacao_interrompida", async () => {
      const respostas = respostasDoAtivar();
      respostas[R.segredo] = {
        status: 200,
        corpo: { secret_id: "seg_1" },
        antes: () => desconectar(),
      };
      const { fetch, chamadas, naoEsperadas } = rede(respostas);
      const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
      expect(naoEsperadas).toEqual([]);
      expect(r).toMatchObject({ ok: false, erro: "ativacao_interrompida" });
      expect(r.ok ? "" : r.mensagem).toContain("A ativação foi interrompida");
      // na ElevenLabs, nada além do segredo foi criado, e ele saiu; a Meta (ligada antes, seção
      // 21) é desligada com o token em memória
      expect(chamadas.map((c) => `${c.metodo} ${c.url}`).slice(-3)).toEqual([
        R.segredo,
        R.ligarSip,
        R.apagarSegredo,
      ]);
      expect(corpoDe(chamadas.at(-2))).toEqual({
        calling: { status: "DISABLED", sip: { status: "DISABLED" } },
      });
      expect(
        chamadas.find((c) => `${c.metodo} ${c.url}` === R.apagarSegredo)?.init.headers,
      ).toEqual({ "xi-api-key": CHAVE });
      // a conexão inativa nunca termina como "ativa"
      expect(linha()!.parametros).not.toHaveProperty("ligacoes");
      expect(falso.tempo).toContain("banco progresso perdeu");
    });

    it("o Desconectar gravou meta_manual e a Meta falha de novo no desfazer: a pendência continua meta_manual", async () => {
      const respostas = respostasDoAtivar();
      const ligar = respostas[R.ligarSip];
      const primeiro = (Array.isArray(ligar) ? ligar[0] : ligar) as Resposta;
      // o 1º POST liga o SIP (passo 3); os seguintes (ligar as chamadas, desligar no desfazer) falham
      respostas[R.ligarSip] = [primeiro, { status: 500 }, { status: 500 }];
      respostas[R.tronco] = {
        status: 200,
        corpo: { phone_number_id: "phnum_1" },
        // o Desconectar apagou o que viu na ElevenLabs e não conseguiu desligar a Meta
        antes: () =>
          desconectar(
            ligacoesGravadas({
              situacao: "com_pendencias",
              ativadaEm: null,
              eleven: {
                segredoId: null,
                webhookId: null,
                ferramentaId: null,
                agenteId: null,
                troncoId: null,
              },
              metaSip: true,
              pendencias: ["meta_manual"],
            }),
          ),
      };
      respostas[R.apagarAgente] = { status: 404 };
      respostas[R.apagarFerramenta] = { status: 404 };
      respostas[R.apagarWebhook] = { status: 404 };
      respostas[R.apagarSegredo] = { status: 404 };
      const { fetch } = rede(respostas);
      const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
      expect(r.ok).toBe(false);
      const gravado = linha()!.parametros["ligacoes"] as LigacoesGravadas;
      expect(gravado.pendencias).toEqual(["meta_manual"]);
    });

    it("o Desconectar deixou pendências: junta as duas listas, desliga a Meta com o token em memória e limpa", async () => {
      const respostas = respostasDoAtivar();
      respostas[R.tronco] = {
        status: 200,
        corpo: { phone_number_id: "phnum_1" },
        // a desmontagem do Desconectar apagou o que viu, menos a ferramenta
        antes: () =>
          desconectar(
            ligacoesGravadas({
              situacao: "com_pendencias",
              ativadaEm: null,
              eleven: {
                segredoId: null,
                webhookId: null,
                ferramentaId: "tool_1",
                agenteId: null,
                troncoId: null,
              },
              metaSip: false,
              pendencias: ["ferramenta"],
            }),
          ),
      };
      // o que o Desconectar já apagou responde 404
      respostas[R.apagarAgente] = { status: 404 };
      respostas[R.apagarWebhook] = { status: 404 };
      respostas[R.apagarSegredo] = { status: 404 };
      const { fetch, chamadas, naoEsperadas } = rede(respostas);
      const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
      expect(naoEsperadas).toEqual([]);
      expect(r).toMatchObject({ ok: false, erro: "ativacao_interrompida" });
      const depois = chamadas
        .map((c) => `${c.metodo} ${c.url}`)
        .slice(chamadas.findIndex((c) => `${c.metodo} ${c.url}` === R.tronco) + 1);
      expect(depois).toEqual([
        R.ligarSip, // o desligar, com o token que a ativação tem em memória
        R.apagarTronco,
        R.apagarAgente,
        R.apagarFerramenta,
        R.apagarWebhook,
        R.apagarSegredo,
      ]);
      const postsMeta = chamadas.filter((c) => `${c.metodo} ${c.url}` === R.ligarSip);
      expect(corpoDe(postsMeta[postsMeta.length - 1])).toEqual({
        calling: { status: "DISABLED", sip: { status: "DISABLED" } },
      });
      // as chamadas nunca foram ligadas
      expect(
        chamadas
          .filter((c) => `${c.metodo} ${c.url}` === R.ligarSip)
          .map(corpoDe)
          .some((b) => JSON.stringify(b) === JSON.stringify({ calling: { status: "ENABLED" } })),
      ).toBe(false);
      expect(dubles.limparLigacoes).toHaveBeenCalledWith(CONEXAO, expect.any(String));
      expect(linha()!.parametros).not.toHaveProperty("ligacoes");
    });

    it("uma ativação nova começou depois: não grava por cima dela", async () => {
      const outra = ligacoesGravadas({
        situacao: "ativando",
        ativadaEm: null,
        eleven: {
          segredoId: "seg_outra",
          webhookId: null,
          ferramentaId: null,
          agenteId: null,
          troncoId: null,
        },
        metaSip: false,
        atualizadaEm: "2030-01-01T00:00:00.000Z",
      });
      const respostas = respostasDoAtivar();
      respostas[R.segredo] = {
        status: 200,
        corpo: { secret_id: "seg_1" },
        antes: () => {
          linha()!.parametros = { ...linha()!.parametros, ligacoes: outra };
        },
      };
      const { fetch } = rede(respostas);
      const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
      expect(r).toMatchObject({ ok: false, erro: "ativacao_interrompida" });
      expect(linha()!.parametros["ligacoes"]).toEqual(outra);
      expect(dubles.limparLigacoes).not.toHaveBeenCalled();
    });
  });
});

// ---------- D28: o Desconectar e a ativação ao mesmo tempo ----------

describe("D28: desmontar durante a ativação", () => {
  it("o cenário do Sol: o Desconectar lê 'ativando' sem recursos e espera a chave; a ativação não termina e nada fica órfão", async () => {
    const segredoSolto = adiada();
    const chaveSolta = adiada();
    const respostas = respostasDoAtivar();
    respostas[R.segredo] = {
      status: 200,
      corpo: { secret_id: "seg_1" },
      espera: segredoSolto.promessa,
    };
    // os DELETE podem vir dos dois caminhos: o segundo de cada dá 404
    for (const k of [
      R.apagarTronco,
      R.apagarAgente,
      R.apagarFerramenta,
      R.apagarWebhook,
      R.apagarSegredo,
    ]) {
      respostas[k] = [{ status: 204 }, { status: 404 }];
    }
    respostas[R.ligarSip] = Array.from({ length: 4 }, () => ({
      status: 200,
      corpo: { success: true },
    }));
    const { fetch, chamadas, naoEsperadas } = rede(respostas);

    // 1. a ativação grava "ativando" e espera o segredo
    const ativacao = ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    await ate(() => chamadas.some((c) => `${c.metodo} ${c.url}` === R.segredo));
    expect((linha()!.parametros["ligacoes"] as LigacoesGravadas).situacao).toBe("ativando");

    // 2. o Desconectar lê a conexão ("ativando", sem recursos) e fica esperando a chave
    dubles.lerChaveIA.mockImplementationOnce(async () => {
      await chaveSolta.promessa;
      return {
        id: "chave-1",
        provedor: "elevenlabs",
        modelo: "",
        workspace_id: null,
        chave: CHAVE,
      };
    });
    const desconectar = desmontarLigacoes(comoConexao(linha()!), { fetch });
    await ate(() => dubles.lerChaveIA.mock.calls.length >= 2);

    // 3. nesse intervalo, a ativação segue até onde der
    segredoSolto.resolver();
    const r = await ativacao;
    // 4. a chave chega e o Desconectar termina
    chaveSolta.resolver();
    const pendencias = await desconectar;

    expect(naoEsperadas).toEqual([]);
    expect(r).toMatchObject({ ok: false, erro: "ativacao_interrompida" });
    expect(pendencias).toEqual([]);
    // nada ficou na ElevenLabs nem na Meta, e o registro saiu (ou lista o que ficou)
    expect(sobrouNaRede(chamadas)).toEqual([]);
    expect(linha()!.parametros).not.toHaveProperty("ligacoes");
    // a Meta nunca teve as chamadas ligadas
    expect(
      chamadas.some(
        (c) =>
          `${c.metodo} ${c.url}` === R.ligarSip &&
          JSON.stringify(corpoDe(c)) === '{"calling":{"status":"ENABLED"}}',
      ),
    ).toBe(false);
  });

  it("a ativação termina entre a leitura do Desconectar e a marca: a marca perde, relê e desmonta tudo", async () => {
    const { fetch, chamadas } = rede(respostasDoAtivar());
    // o Desconectar leu antes ("ativando", sem nada)
    dubles.iniciarLigacoes.mockImplementationOnce(
      async (id: string, estado: LigacoesGravadas, token: string) => {
        const l = linha(id)!;
        l.parametros = { ...l.parametros, ligacoes: structuredClone(estado) };
        l.segredos = { ...l.segredos, ligacaoToken: token };
        lidaPeloDesconectar = comoConexao(l);
        return true;
      },
    );
    let lidaPeloDesconectar: ConexaoServidor | null = null;
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: true, estado: { situacao: "ativa" } });

    const pendencias = await desmontarLigacoes(lidaPeloDesconectar!, { fetch });
    expect(pendencias).toEqual([]);
    expect(falso.tempo).toContain("banco gravar perdeu");
    expect(sobrouNaRede(chamadas)).toEqual([]);
    expect(linha()!.parametros).not.toHaveProperty("ligacoes");
  });

  it("a desmontagem que termina depois de outra que já limpou não regrava nada", async () => {
    falso.linhas = [linhaMeta({ parametros: { phoneId: PHONE, ligacoes: ligacoesGravadas() } })];
    const lida = comoConexao(linha()!);
    const { fetch } = rede({
      ...respostasDoAtivar(),
      [R.apagarTronco]: [{ status: 204 }, { status: 404 }],
      [R.apagarAgente]: [{ status: 204 }, { status: 404 }],
      [R.apagarFerramenta]: [{ status: 204 }, { status: 404 }],
      [R.apagarWebhook]: [{ status: 204 }, { status: 404 }],
      [R.apagarSegredo]: [{ status: 204 }, { status: 404 }],
    });
    // duas abas: o Desconectar e o desativar, com a mesma leitura
    const [a, b] = await Promise.all([
      desmontarLigacoes(lida, { fetch }),
      desativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch }),
    ]);
    expect(a).toEqual([]);
    expect(b).toMatchObject({ ok: true, estado: { pendencias: [] } });
    expect(linha()!.parametros).not.toHaveProperty("ligacoes");
  });

  it("a ativação que perde a trava para outra ativação desmonta só a ElevenLabs dela e não desliga a Meta", async () => {
    const outra = ligacoesGravadas({
      situacao: "ativando",
      ativadaEm: null,
      eleven: {
        segredoId: "seg_outra",
        webhookId: null,
        ferramentaId: null,
        agenteId: null,
        troncoId: null,
      },
      metaSip: true,
      atualizadaEm: "2030-01-01T00:00:00.000Z",
    });
    const respostas = respostasDoAtivar();
    // a outra ativação começa enquanto esta cria o tronco (já com o SIP ligado por esta)
    respostas[R.tronco] = {
      status: 200,
      corpo: { phone_number_id: "phnum_1" },
      antes: () => {
        linha()!.parametros = { ...linha()!.parametros, ligacoes: outra };
      },
    };
    const { fetch, chamadas, naoEsperadas } = rede(respostas);
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(naoEsperadas).toEqual([]);
    expect(r).toMatchObject({ ok: false, erro: "ativacao_interrompida" });
    const depois = chamadas
      .map((c) => `${c.metodo} ${c.url}`)
      .slice(chamadas.findIndex((c) => `${c.metodo} ${c.url}` === R.tronco) + 1);
    // sem o desligar da Meta: ela é da ativação nova
    expect(depois).toEqual([
      R.apagarTronco,
      R.apagarAgente,
      R.apagarFerramenta,
      R.apagarWebhook,
      R.apagarSegredo,
    ]);
    expect(linha()!.parametros["ligacoes"]).toEqual(outra);
  });
});

describe("a gravação da ativação que entrou mas voltou com erro", () => {
  it("o atualizadaEm gravado é o que esta ativação mandou: conta como dela, desmonta e limpa", async () => {
    // a gravação do agente entra no banco, mas a resposta volta com erro
    let vezes = 0;
    const real = dubles.gravarProgressoLigacoes.getMockImplementation()!;
    dubles.gravarProgressoLigacoes.mockImplementation(async (...args: unknown[]) => {
      vezes += 1;
      const ok = await (real as (...a: unknown[]) => Promise<boolean>)(...args);
      if (vezes === 4) throw new Error("banco_gravar_ligacoes");
      return ok;
    });
    const { fetch, chamadas } = rede(respostasDoAtivar());
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "erro_ao_gravar" });
    expect(sobrouNaRede(chamadas)).toEqual([]);
    expect(linha()!.parametros).not.toHaveProperty("ligacoes");
    expect(dubles.limparLigacoes).toHaveBeenCalledWith(CONEXAO, expect.any(String));
  });
});

describe("D29: a chave da voz muda durante a ativação", () => {
  const OUTRA = "sk_eleven_chave_de_outra_conta_OUTRA_9";
  const LER_AGENTE = `GET ${EL}/v1/convai/agents/agent_1`;
  function trocarChaveNoFim(respostas: Record<string, Resposta | Resposta[]>) {
    // a troca concorrente: o salvar grava a chave nova enquanto a Meta liga as chamadas
    const posts = respostas[R.ligarSip] as Resposta[];
    posts[1] = {
      ...posts[1]!,
      antes: () =>
        void dubles.lerChaveIA.mockResolvedValue({
          id: "chave-1",
          provedor: "elevenlabs",
          modelo: "",
          workspace_id: null,
          chave: OUTRA,
        }),
    };
  }

  it("trocada por uma de outra conta: desmonta com a chave da memória e falha com a mensagem clara", async () => {
    const respostas = respostasDoAtivar();
    trocarChaveNoFim(respostas);
    respostas[LER_AGENTE] = { status: 404 };
    const { fetch, chamadas, naoEsperadas } = rede(respostas);
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(naoEsperadas).toEqual([]);
    expect(r).toMatchObject({ ok: false, erro: "chave_invalida" });
    expect(r.ok ? "" : r.mensagem).toContain(
      "foi trocada por uma de outra conta durante a ativação",
    );
    // a conferência com a chave nova; a desmontagem com a da memória
    expect(chamadas.find((c) => `${c.metodo} ${c.url}` === LER_AGENTE)?.init.headers).toEqual({
      "xi-api-key": OUTRA,
    });
    for (const c of chamadas.filter((x) => x.metodo === "DELETE")) {
      expect(c.init.headers).toEqual({ "xi-api-key": CHAVE });
    }
    expect(sobrouNaRede(chamadas)).toEqual([]);
    expect(linha()!.parametros).not.toHaveProperty("ligacoes");
    semSegredos(r, OUTRA);
  });

  it("trocada por outra chave da mesma conta (lê o agente): termina ativa", async () => {
    const respostas = respostasDoAtivar();
    trocarChaveNoFim(respostas);
    respostas[LER_AGENTE] = { status: 200, corpo: { agent_id: "agent_1" } };
    const { fetch } = rede(respostas);
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: true, estado: { situacao: "ativa" } });
  });

  it("a mesma chave: nenhuma conferência a mais", async () => {
    const { fetch, chamadas } = rede(respostasDoAtivar());
    await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(chamadas.some((c) => `${c.metodo} ${c.url}` === LER_AGENTE)).toBe(false);
  });
});

describe("D30: a chave da ElevenLabs revogada", () => {
  function comLigacoesAtivas() {
    falso.linhas = [
      linhaMeta({
        parametros: { phoneId: PHONE, ligacoes: ligacoesGravadas() },
        segredos: {
          token: TOKEN_META,
          appSecret: APP_SECRET,
          verifyToken: VERIFY,
          ligacaoToken: "token-da-ligacao-LIGTOKEN_1234",
          ligacaoHmac: HMAC,
        },
      }),
    ];
  }

  it("401 na desmontagem vira eleven_manual, e o Já apaguei tira: o beco do Fable tem saída", async () => {
    comLigacoesAtivas();
    const respostas = respostasDoAtivar();
    respostas[R.apagarTronco] = { status: 401, corpo: { detail: { status: "invalid_api_key" } } };
    const primeira = rede(respostas);
    const r = await desativarLigacoesLogica(
      contexto(),
      { origem: ORIGEM },
      { fetch: primeira.fetch },
    );
    // a Meta sai; depois do 401, a ElevenLabs não é chamada de novo
    expect(primeira.chamadas.map((c) => `${c.metodo} ${c.url}`)).toEqual([
      R.ligarSip,
      R.apagarTronco,
    ]);
    expect(r).toMatchObject({
      ok: true,
      estado: { situacao: "com_pendencias", pendencias: ["eleven_manual"] },
    });
    const gravado = linha()!.parametros["ligacoes"] as LigacoesGravadas;
    expect(gravado).toMatchObject({ metaSip: false, pendencias: ["eleven_manual"] });
    expect(gravado.eleven.agenteId).toBe("agent_1");
    expect(await estadoLigacoesLogica(contexto(), { origem: ORIGEM })).toMatchObject({
      ok: true,
      estado: { pendencias: ["eleven_manual"] },
    });

    // o "Já apaguei": o desativar com eleven_manual gravado tenta o primeiro DELETE; o 401 (a
    // chave não alcança a conta) vale a palavra do admin, para ele e os próximos, sem mais rede
    const segunda = rede({ [R.apagarTronco]: { status: 401, corpo: {} } });
    const r2 = await desativarLigacoesLogica(
      contexto(),
      { origem: ORIGEM },
      { fetch: segunda.fetch },
    );
    expect(segunda.chamadas.map((c) => `${c.metodo} ${c.url}`)).toEqual([R.apagarTronco]);
    expect(r2).toMatchObject({ ok: true, estado: { situacao: "pronta", pendencias: [] } });
    // sem ligações, a chave da voz fica livre (D22)
    expect(linha()!.parametros).not.toHaveProperty("ligacoes");
    expect(linha()!.segredos).not.toHaveProperty("ligacaoToken");
  });

  it("o Desconectar não confirma o eleven_manual: tenta de novo e mantém a pendência", async () => {
    comLigacoesAtivas();
    const l = linha()!;
    l.parametros = {
      ...l.parametros,
      ligacoes: ligacoesGravadas({
        situacao: "com_pendencias",
        metaSip: false,
        pendencias: ["eleven_manual"],
      }),
    };
    const respostas = respostasDoAtivar();
    respostas[R.apagarTronco] = { status: 401, corpo: {} };
    const { fetch, chamadas } = rede(respostas);
    expect(await desmontarLigacoes(comoConexao(linha()!), { fetch })).toEqual(["eleven_manual"]);
    expect(chamadas.map((c) => `${c.metodo} ${c.url}`)).toEqual([R.apagarTronco]);
    expect((linha()!.parametros["ligacoes"] as LigacoesGravadas).pendencias).toEqual([
      "eleven_manual",
    ]);
  });

  function comElevenManual() {
    comLigacoesAtivas();
    const l = linha()!;
    l.parametros = {
      ...l.parametros,
      ligacoes: ligacoesGravadas({
        situacao: "com_pendencias",
        metaSip: false,
        pendencias: ["eleven_manual"],
      }),
    };
  }
  const DELETES = [
    R.apagarTronco,
    R.apagarAgente,
    R.apagarFerramenta,
    R.apagarWebhook,
    R.apagarSegredo,
  ];

  it("Já apaguei com a chave guardada: os DELETE na ordem da D17; 2xx e 404 confirmam", async () => {
    comElevenManual();
    const respostas = respostasDoAtivar();
    respostas[R.apagarAgente] = { status: 404, corpo: {} };
    respostas[R.apagarWebhook] = { status: 404, corpo: {} };
    const { fetch, chamadas } = rede(respostas);
    const r = await desativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(chamadas.map((c) => `${c.metodo} ${c.url}`)).toEqual(DELETES);
    for (const c of chamadas) expect(c.init.headers).toEqual({ "xi-api-key": CHAVE });
    expect(r).toMatchObject({ ok: true, estado: { situacao: "pronta", pendencias: [] } });
    expect(linha()!.parametros).not.toHaveProperty("ligacoes");
  });

  it("Já apaguei com outra falha (500, rede): a pendência manual fica, com o id que não saiu", async () => {
    comElevenManual();
    const respostas = respostasDoAtivar();
    respostas[R.apagarAgente] = { status: 500 };
    respostas[R.apagarSegredo] = { status: 0, lancar: new Error("rede") };
    const { fetch, chamadas } = rede(respostas);
    const r = await desativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    // as outras falhas não param a ordem: cada recurso é tentado
    expect(chamadas.map((c) => `${c.metodo} ${c.url}`)).toEqual(DELETES);
    expect(r).toMatchObject({
      ok: true,
      estado: { situacao: "com_pendencias", pendencias: ["eleven_manual"] },
    });
    const gravado = linha()!.parametros["ligacoes"] as LigacoesGravadas;
    expect(gravado.pendencias).toEqual(["eleven_manual"]);
    expect(gravado.eleven).toMatchObject({
      troncoId: null,
      agenteId: "agent_1",
      ferramentaId: null,
      webhookId: null,
      segredoId: "seg_1",
    });
    expect(linha()!.segredos).toHaveProperty("ligacaoToken");
  });

  it("Já apaguei sem chave guardada: vale a palavra do admin, sem rede", async () => {
    comElevenManual();
    dubles.lerChaveIA.mockResolvedValue(null);
    const { fetch, chamadas } = rede({});
    const r = await desativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(chamadas).toHaveLength(0);
    expect(r).toMatchObject({ ok: true, estado: { situacao: "pronta", pendencias: [] } });
  });

  it("um 401 depois de outras falhas junta tudo da ElevenLabs no eleven_manual", async () => {
    comLigacoesAtivas();
    const respostas = respostasDoAtivar();
    respostas[R.apagarTronco] = { status: 500 };
    respostas[R.apagarAgente] = { status: 401, corpo: {} };
    const { fetch } = rede(respostas);
    const r = await desativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: true, estado: { pendencias: ["eleven_manual"] } });
  });
});

describe("a ativação que não começa", () => {
  it("a conexão saiu antes da trava (iniciarLigacoes falso): a mensagem da conexão desconectada", async () => {
    dubles.iniciarLigacoes.mockImplementation(async () => {
      linha()!.ativa = false;
      return false;
    });
    const { fetch } = rede(respostasDoAtivar());
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "sem_conexao_meta" });
    expect(r.ok ? "" : r.mensagem).not.toContain("já começou");
    expect(r.ok ? "" : r.mensagem).toContain("WhatsApp oficial da Meta conectado");
  });
});

// ---------- desativar ----------

describe("desativarLigacoes", () => {
  function comLigacoes(o: Partial<LigacoesGravadas> = {}) {
    falso.linhas = [
      linhaMeta({
        parametros: { phoneId: PHONE, wabaId: "998877", ligacoes: ligacoesGravadas(o) },
        segredos: {
          token: TOKEN_META,
          appSecret: APP_SECRET,
          verifyToken: VERIFY,
          ligacaoToken: "token-da-ligacao-LIGTOKEN_1234",
          ligacaoHmac: HMAC,
        },
      }),
    ];
  }

  it("Meta, depois tronco, agente, ferramenta (force), webhook e segredo; limpa só as ligações", async () => {
    comLigacoes();
    const { fetch, chamadas, naoEsperadas } = rede(respostasDoAtivar());
    const r = await desativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(naoEsperadas).toEqual([]);
    expect(r).toMatchObject({ ok: true, estado: { situacao: "pronta", pendencias: [] } });
    expect(chamadas.map((c) => `${c.metodo} ${c.url}`)).toEqual([
      R.ligarSip,
      R.apagarTronco,
      R.apagarAgente,
      R.apagarFerramenta,
      R.apagarWebhook,
      R.apagarSegredo,
    ]);
    expect(corpoDe(chamadas[0])).toEqual({
      calling: { status: "DISABLED", sip: { status: "DISABLED" } },
    });
    expect(chamadas[1]?.init.headers).toEqual({ "xi-api-key": CHAVE });
    expect(linha()!.parametros).toEqual({ phoneId: PHONE, wabaId: "998877" });
    expect(linha()!.segredos).toEqual({
      token: TOKEN_META,
      appSecret: APP_SECRET,
      verifyToken: VERIFY,
    });
    semSegredos(r, "token-da-ligacao-LIGTOKEN_1234");
  });

  it("404 conta como já apagado", async () => {
    comLigacoes({ metaSip: false });
    const respostas = respostasDoAtivar();
    respostas[R.apagarAgente] = { status: 404 };
    respostas[R.apagarSegredo] = { status: 404 };
    const { fetch } = rede(respostas);
    const r = await desativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: true, estado: { situacao: "pronta" } });
    expect(dubles.limparLigacoes).toHaveBeenCalledWith(CONEXAO, expect.any(String));
  });

  it("o que não sai fica como pendência; Tentar de novo só refaz o que ficou", async () => {
    comLigacoes();
    const respostas = respostasDoAtivar();
    respostas[R.ligarSip] = { status: 500 };
    respostas[R.apagarAgente] = { status: 500 };
    const primeira = rede(respostas);
    const r = await desativarLigacoesLogica(
      contexto(),
      { origem: ORIGEM },
      { fetch: primeira.fetch },
    );
    expect(r).toMatchObject({
      ok: true,
      estado: { situacao: "com_pendencias", pendencias: ["meta", "agente"] },
    });
    const gravado = linha()!.parametros["ligacoes"] as LigacoesGravadas;
    expect(gravado.eleven).toEqual({
      segredoId: null,
      webhookId: null,
      ferramentaId: null,
      agenteId: "agent_1",
      troncoId: null,
    });
    expect(gravado.metaSip).toBe(true);
    // os segredos ficam até tudo sair
    expect(linha()!.segredos["ligacaoHmac"]).toBe(HMAC);

    const segunda = rede(respostasDoAtivar());
    const r2 = await desativarLigacoesLogica(
      contexto(),
      { origem: ORIGEM },
      { fetch: segunda.fetch },
    );
    expect(segunda.chamadas.map((c) => `${c.metodo} ${c.url}`)).toEqual([
      R.ligarSip,
      R.apagarAgente,
    ]);
    expect(r2).toMatchObject({ ok: true, estado: { situacao: "pronta", pendencias: [] } });
    expect(linha()!.parametros).not.toHaveProperty("ligacoes");
  });

  it("sem a chave da ElevenLabs: a Meta sai, os recursos de lá ficam como pendência", async () => {
    comLigacoes();
    dubles.lerChaveIA.mockResolvedValue(null);
    const { fetch, chamadas } = rede(respostasDoAtivar());
    const r = await desativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(chamadas.map((c) => `${c.metodo} ${c.url}`)).toEqual([R.ligarSip]);
    expect(r).toMatchObject({
      ok: true,
      estado: {
        situacao: "com_pendencias",
        pendencias: ["tronco", "agente", "ferramenta", "webhook", "segredo"],
      },
    });
  });

  it("nada a desativar: devolve o estado, sem rede", async () => {
    const { fetch, chamadas } = rede({});
    const r = await desativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: true, estado: { situacao: "pronta" } });
    expect(chamadas).toHaveLength(0);
  });

  it("sem admin dá sem_acesso", async () => {
    comLigacoes();
    const { fetch, chamadas } = rede({});
    const r = await desativarLigacoesLogica(
      contexto({ admin: false }),
      { origem: ORIGEM },
      { fetch },
    );
    expect(r).toMatchObject({ ok: false, erro: "sem_acesso" });
    expect(chamadas).toHaveLength(0);
  });

  it("o banco falhou no fim: erro_ao_gravar", async () => {
    comLigacoes();
    dubles.limparLigacoes.mockRejectedValue(new Error("banco_limpar_ligacoes"));
    const { fetch } = rede(respostasDoAtivar());
    const r = await desativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "erro_ao_gravar" });
  });

  it("conexão antiga já desconectada (sem token): a Meta vira meta_manual (D23), e só o Já desliguei a tira", async () => {
    falso.linhas = [
      linhaMeta({
        id: "antiga",
        ativa: false,
        segredos: {},
        parametros: {
          phoneId: PHONE,
          ligacoes: ligacoesGravadas({
            situacao: "com_pendencias",
            pendencias: ["meta", "agente"],
          }),
        },
      }),
    ];
    const { fetch, chamadas } = rede(respostasDoAtivar());
    const r = await desativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    // a Meta não é chamada (sem token); a ElevenLabs sai toda
    expect(chamadas.map((c) => c.metodo)).not.toContain("POST");
    expect(r).toMatchObject({
      ok: true,
      estado: { situacao: "com_pendencias", pendencias: ["meta_manual"] },
    });
    expect(dubles.limparLigacoes).not.toHaveBeenCalled();
    const gravado = linha("antiga")!.parametros["ligacoes"] as LigacoesGravadas;
    expect(gravado).toMatchObject({ metaSip: true, pendencias: ["meta_manual"] });
    expect(Object.values(gravado.eleven).every((v) => v === null)).toBe(true);

    // o estado continua mostrando a pendência
    const lido = await estadoLigacoesLogica(contexto(), { origem: ORIGEM });
    expect(lido).toMatchObject({ ok: true, estado: { pendencias: ["meta_manual"] } });

    // o "Já desliguei": o desativar com meta_manual gravado tira a pendência, sem rede
    const segunda = rede({});
    const r2 = await desativarLigacoesLogica(
      contexto(),
      { origem: ORIGEM },
      { fetch: segunda.fetch },
    );
    expect(segunda.chamadas).toHaveLength(0);
    expect(r2).toMatchObject({ ok: true, estado: { pendencias: [] } });
    expect(dubles.limparLigacoes).toHaveBeenCalledWith("antiga", expect.any(String));
  });
});

// ---------- D15: desmontar no Desconectar e no Trocar ----------

describe("desmontarLigacoes (D15)", () => {
  it("sem ligações gravadas não chama ninguém", async () => {
    const { fetch, chamadas } = rede({});
    expect(await desmontarLigacoes(comoConexao(linhaMeta()), { fetch })).toEqual([]);
    expect(chamadas).toHaveLength(0);
  });

  it("desmonta e limpa", async () => {
    falso.linhas = [linhaMeta({ parametros: { phoneId: PHONE, ligacoes: ligacoesGravadas() } })];
    const { fetch, chamadas } = rede(respostasDoAtivar());
    expect(await desmontarLigacoes(comoConexao(linha()!), { fetch })).toEqual([]);
    expect(chamadas).toHaveLength(6);
    expect(dubles.limparLigacoes).toHaveBeenCalledWith(CONEXAO, expect.any(String));
  });

  it("teto esgotado: tudo vira pendência sem chamar ninguém, e não bloqueia", async () => {
    falso.linhas = [linhaMeta({ parametros: { phoneId: PHONE, ligacoes: ligacoesGravadas() } })];
    const { fetch, chamadas } = rede(respostasDoAtivar());
    const pendencias = await desmontarLigacoes(comoConexao(linha()!), { fetch, tetoMs: 0 });
    // D34: o token da Meta vai sumir, então a Meta já nasce manual
    expect(pendencias).toEqual([
      "meta_manual",
      "tronco",
      "agente",
      "ferramenta",
      "webhook",
      "segredo",
    ]);
    expect(chamadas).toHaveLength(0);
    expect((linha()!.parametros["ligacoes"] as LigacoesGravadas).situacao).toBe("com_pendencias");
  });

  it("D34: a Meta que falha no Desconectar já vira meta_manual, e o Já desliguei a tira", async () => {
    falso.linhas = [linhaMeta({ parametros: { phoneId: PHONE, ligacoes: ligacoesGravadas() } })];
    const respostas = respostasDoAtivar();
    respostas[R.ligarSip] = { status: 500 };
    const { fetch } = rede(respostas);
    expect(await desmontarLigacoes(comoConexao(linha()!), { fetch })).toEqual(["meta_manual"]);
    const gravado = linha()!.parametros["ligacoes"] as LigacoesGravadas;
    expect(gravado).toMatchObject({
      situacao: "com_pendencias",
      metaSip: true,
      pendencias: ["meta_manual"],
    });

    // a conexão perde o token (o Desconectar segue); o desativar seguinte é o Já desliguei
    linha()!.segredos = {};
    linha()!.ativa = false;
    const segunda = rede(respostasDoAtivar());
    const r = await desativarLigacoesLogica(
      contexto(),
      { origem: ORIGEM },
      { fetch: segunda.fetch },
    );
    expect(segunda.chamadas).toHaveLength(0);
    expect(r).toMatchObject({ ok: true, estado: { pendencias: [] } });
    expect(linha()!.parametros).not.toHaveProperty("ligacoes");
  });

  it("Já desliguei com o token ainda na conexão e a Meta falhando: vale a palavra do admin", async () => {
    falso.linhas = [
      linhaMeta({
        parametros: {
          phoneId: PHONE,
          ligacoes: ligacoesGravadas({
            situacao: "com_pendencias",
            pendencias: ["meta_manual"],
            eleven: {
              segredoId: null,
              webhookId: null,
              ferramentaId: null,
              agenteId: null,
              troncoId: null,
            },
          }),
        },
      }),
    ];
    const respostas = respostasDoAtivar();
    respostas[R.ligarSip] = { status: 500 };
    const { fetch } = rede(respostas);
    const r = await desativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: true, estado: { pendencias: [] } });
    expect(linha()!.parametros).not.toHaveProperty("ligacoes");
  });

  it("D34: o desativar com o token na conexão continua com a pendência meta (tem como tentar de novo)", async () => {
    falso.linhas = [linhaMeta({ parametros: { phoneId: PHONE, ligacoes: ligacoesGravadas() } })];
    const respostas = respostasDoAtivar();
    respostas[R.ligarSip] = { status: 500 };
    const { fetch } = rede(respostas);
    const r = await desativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: true, estado: { pendencias: ["meta"] } });
  });

  it("nunca lança, nem com o banco fora", async () => {
    falso.linhas = [linhaMeta({ parametros: { phoneId: PHONE, ligacoes: ligacoesGravadas() } })];
    dubles.limparLigacoes.mockRejectedValue(new Error("banco_limpar_ligacoes"));
    dubles.lerChaveIA.mockRejectedValue(new Error("cifra_invalida"));
    const { fetch } = rede(respostasDoAtivar());
    await expect(desmontarLigacoes(comoConexao(linha()!), { fetch })).resolves.toEqual([
      "tronco",
      "agente",
      "ferramenta",
      "webhook",
      "segredo",
    ]);
    dubles.carregarConexao.mockRejectedValue(new Error("banco_ler_conexao"));
    await expect(desmontarLigacoesDaConexao(CONEXAO, { fetch })).resolves.toEqual(["erro"]);
  });

  it("pelo id (o Trocar): carrega a conexão com os segredos e desmonta", async () => {
    falso.linhas = [linhaMeta({ parametros: { phoneId: PHONE, ligacoes: ligacoesGravadas() } })];
    const { fetch, chamadas } = rede(respostasDoAtivar());
    expect(await desmontarLigacoesDaConexao(CONEXAO, { fetch })).toEqual([]);
    expect(dubles.carregarConexao).toHaveBeenCalledWith(CONEXAO);
    expect(chamadas[0]?.init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN_META}` });
  });
});

// ---------- os agentes de voz (L2, L14, L19 e 2.2) ----------

describe("os agentes de voz na ativação e na desativação", () => {
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

  it("a 1ª ativação cria a linha Nina (atende, sem voz própria) e o agente com a voz do cartão, o Contexto e os limites", async () => {
    const { fetch, chamadas } = rede(respostasDoAtivar());
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: true, estado: { situacao: "ativa" } });
    expect(falso.agentes).toEqual([
      expect.objectContaining({
        nome: "Nina",
        atende: true,
        // a voz do cartão Voz, acompanhando a troca (L37)
        vozId: null,
        vozNome: null,
        idExterno: "agent_1",
        versaoConfig: VERSAO_AGENTE,
        erroSincronia: null,
        sincronizadoEm: expect.stringMatching(/^\d{4}-/),
      }),
    ]);
    const corpo = corpoDe(chamadas.find((c) => `${c.metodo} ${c.url}` === R.agente)) as {
      conversation_config: { tts: { voice_id: string }; agent: { prompt: { prompt: string } } };
      platform_settings: { call_limits: { agent_concurrency_limit: number } };
    };
    expect(corpo.conversation_config.agent.prompt.prompt).toContain(
      "<contexto_da_empresa>\nEmpresa e oferta: Consultoria de IA\n</contexto_da_empresa>",
    );
    expect(corpo.platform_settings.call_limits.agent_concurrency_limit).toBe(3);
    expect(corpo.conversation_config.tts.voice_id).toBe("voz123ABC");
  });

  it("reativação: reaproveita as linhas; o que atende vem da linha, os outros são criados depois de ativa", async () => {
    falso.agentes = [
      agente({ id: "ag_vendas", nome: "Vendas", vozId: "vozVendas", idExterno: "agent_velho" }),
      agente({
        id: "ag_nina",
        nome: "Nina",
        atende: true,
        vozId: "vozPropria",
        perfil: "caprichado",
        idExterno: null,
      }),
    ];
    const respostas = respostasDoAtivar();
    respostas[R.agente] = [
      { status: 200, corpo: { agent_id: "agent_1" } },
      { status: 200, corpo: { agent_id: "agent_2" } },
    ];
    const { fetch, chamadas, naoEsperadas } = rede(respostas);
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(naoEsperadas).toEqual([]);
    expect(r).toMatchObject({ ok: true, estado: { situacao: "ativa" } });
    expect(falso.tempo.some((t) => t.startsWith("banco agente novo"))).toBe(false);
    const criados = chamadas.filter((c) => `${c.metodo} ${c.url}` === R.agente).map(corpoDe) as {
      name: string;
      conversation_config: { tts: { voice_id: string }; agent: { prompt: { llm: string } } };
    }[];
    expect(criados.map((c) => c.name)).toEqual([
      "Nina (ligações) c0ffee00 · Nina",
      "Nina (ligações) c0ffee00 · Vendas",
    ]);
    expect(criados[0]!.conversation_config.tts.voice_id).toBe("vozPropria");
    expect(criados[0]!.conversation_config.agent.prompt.llm).toBe("claude-sonnet-4-6");
    // o agente de "Vendas" nasce depois das chamadas ligadas, e o tronco fica no que atende
    const ordem = chamadas.map((c) => `${c.metodo} ${c.url}`);
    expect(ordem.lastIndexOf(R.agente)).toBeGreaterThan(ordem.lastIndexOf(R.ligarSip));
    expect(linha()!.parametros["ligacoes"]).toMatchObject({ eleven: { agenteId: "agent_1" } });
    expect(falso.agentes.map((a) => [a.id, a.idExterno, a.versaoConfig])).toEqual([
      ["ag_vendas", "agent_2", VERSAO_AGENTE],
      ["ag_nina", "agent_1", VERSAO_AGENTE],
    ]);
  });

  it("um agente que não nasce depois de ativa não desfaz a ativação: fica em erro_sincronia", async () => {
    falso.agentes = [
      agente({ id: "ag_nina", nome: "Nina", atende: true }),
      agente({ id: "ag_vendas", nome: "Vendas" }),
    ];
    const respostas = respostasDoAtivar();
    respostas[R.agente] = [
      { status: 200, corpo: { agent_id: "agent_1" } },
      { status: 500, corpo: {} },
    ];
    const { fetch } = rede(respostas);
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: true, estado: { situacao: "ativa" } });
    expect(falso.agentes.find((a) => a.id === "ag_vendas")).toMatchObject({
      idExterno: null,
      erroSincronia: expect.stringContaining("ElevenLabs"),
    });
  });

  it("sem linha que atende, a mais antiga passa a atender", async () => {
    falso.agentes = [agente({ id: "ag_a", nome: "A" }), agente({ id: "ag_b", nome: "B" })];
    const respostas = respostasDoAtivar();
    respostas[R.agente] = [
      { status: 200, corpo: { agent_id: "agent_1" } },
      { status: 200, corpo: { agent_id: "agent_2" } },
    ];
    const { fetch } = rede(respostas);
    await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(falso.agentes.map((a) => [a.id, a.atende, a.idExterno])).toEqual([
      ["ag_a", true, "agent_1"],
      ["ag_b", false, "agent_2"],
    ]);
  });

  it("o passo 8 não grava o id do tronco: o erro fica em erro_sincronia (o Atualizar adota depois)", async () => {
    falso.sincroniaFalhas = 1;
    const { fetch } = rede(respostasDoAtivar());
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: true, estado: { situacao: "ativa" } });
    expect(falso.agentes[0]).toMatchObject({
      atende: true,
      idExterno: null,
      erroSincronia: expect.stringMatching(/\S/),
    });
  });

  it("o passo 8 relê quem atende: um Atender no meio da ativação ganha o agente do tronco", async () => {
    falso.agentes = [
      agente({ id: "ag_a", nome: "A", atende: true }),
      agente({ id: "ag_b", nome: "B", vozId: "vozB" }),
    ];
    const respostas = respostasDoAtivar();
    // enquanto o tronco é criado, o admin troca quem atende (sem as ligações ativas, só a linha)
    respostas[R.tronco] = {
      status: 200,
      corpo: { phone_number_id: "phnum_1" },
      antes: () => {
        for (const a of falso.agentes) {
          a.atende = a.id === "ag_b";
          a.atualizadoEm = `v${++falso.versao}`;
        }
      },
    };
    respostas[`PATCH ${EL}/v1/convai/agents/agent_1`] = { status: 200, corpo: {} };
    respostas[R.agente] = [
      { status: 200, corpo: { agent_id: "agent_1" } },
      { status: 200, corpo: { agent_id: "agent_2" } },
    ];
    const { fetch, chamadas, naoEsperadas } = rede(respostas);
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(naoEsperadas).toEqual([]);
    expect(r).toMatchObject({ ok: true, estado: { situacao: "ativa" } });
    // a configuração do B vai ao agente do tronco; o A nasce como outro agente
    const patch = chamadas.find(
      (c) => `${c.metodo} ${c.url}` === `PATCH ${EL}/v1/convai/agents/agent_1`,
    );
    expect(corpoDe(patch)).toMatchObject({ conversation_config: { tts: { voice_id: "vozB" } } });
    expect(falso.agentes.map((a) => [a.id, a.atende, a.idExterno])).toEqual([
      ["ag_a", false, "agent_2"],
      ["ag_b", true, "agent_1"],
    ]);
  });

  it("as ligações saem durante o passo 8: o outro agente criado sai lá e nenhuma linha fica com id", async () => {
    falso.agentes = [
      agente({ id: "ag_nina", nome: "Nina", atende: true }),
      agente({ id: "ag_vendas", nome: "Vendas" }),
    ];
    const respostas = respostasDoAtivar();
    respostas[R.agente] = [
      { status: 200, corpo: { agent_id: "agent_1" } },
      {
        status: 200,
        corpo: { agent_id: "agent_2" },
        // o Desconectar marca as ligações enquanto o outro agente nasce
        antes: () => {
          const l = linha()!;
          const atual = l.parametros["ligacoes"] as LigacoesGravadas;
          l.parametros = { ...l.parametros, ligacoes: { ...atual, situacao: "com_pendencias" } };
        },
      },
    ];
    respostas[`DELETE ${EL}/v1/convai/agents/agent_2`] = { status: 204 };
    const { fetch, chamadas } = rede(respostas);
    await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(chamadas.map((c) => `${c.metodo} ${c.url}`)).toContain(
      `DELETE ${EL}/v1/convai/agents/agent_2`,
    );
    expect(falso.agentes.find((a) => a.id === "ag_vendas")!.idExterno).toBeNull();
  });

  function comLigacoesEAgentes() {
    falso.linhas = [
      linhaMeta({
        parametros: { phoneId: PHONE, wabaId: "998877", ligacoes: ligacoesGravadas() },
        segredos: {
          token: TOKEN_META,
          appSecret: APP_SECRET,
          verifyToken: VERIFY,
          ligacaoToken: "token-da-ligacao-LIGTOKEN_1234",
          ligacaoHmac: HMAC,
        },
      }),
    ];
    falso.agentes = [
      agente({ id: "ag_nina", nome: "Nina", atende: true, idExterno: "agent_1" }),
      agente({ id: "ag_vendas", nome: "Vendas", idExterno: "agent_2" }),
    ];
  }
  const APAGAR_2 = `DELETE ${EL}/v1/convai/agents/agent_2`;

  it("desativar: a Meta e o tronco primeiro, os outros agentes depois do tronco; zera o id_externo das linhas, sem apagá-las", async () => {
    comLigacoesEAgentes();
    const respostas = respostasDoAtivar();
    respostas[APAGAR_2] = { status: 204 };
    const { fetch, chamadas, naoEsperadas } = rede(respostas);
    const r = await desativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(naoEsperadas).toEqual([]);
    expect(r).toMatchObject({ ok: true, estado: { situacao: "pronta", pendencias: [] } });
    expect(chamadas.map((c) => `${c.metodo} ${c.url}`)).toEqual([
      R.ligarSip,
      R.apagarTronco,
      APAGAR_2,
      R.apagarAgente,
      R.apagarFerramenta,
      R.apagarWebhook,
      R.apagarSegredo,
    ]);
    expect(falso.agentes.map((a) => [a.id, a.idExterno])).toEqual([
      ["ag_nina", null],
      ["ag_vendas", null],
    ]);
    expect(falso.tempo).toContain("banco zerar agent_1,agent_2");
  });

  it("o outro agente que não sai fica como pendência 'agente', com o id na linha", async () => {
    comLigacoesEAgentes();
    const respostas = respostasDoAtivar();
    respostas[APAGAR_2] = { status: 500 };
    const { fetch } = rede(respostas);
    const r = await desativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({
      ok: true,
      estado: { situacao: "com_pendencias", pendencias: ["agente"] },
    });
    expect(falso.agentes.map((a) => [a.id, a.idExterno])).toEqual([
      ["ag_nina", null],
      ["ag_vendas", "agent_2"],
    ]);
    // o "Tentar de novo" apaga o que ficou e limpa
    respostas[APAGAR_2] = { status: 204 };
    const segunda = rede(respostas);
    const r2 = await desativarLigacoesLogica(
      contexto(),
      { origem: ORIGEM },
      { fetch: segunda.fetch },
    );
    expect(r2).toMatchObject({ ok: true, estado: { situacao: "pronta", pendencias: [] } });
    expect(falso.agentes.every((a) => a.idExterno === null)).toBe(true);
  });

  it("o Desconectar (D15) também apaga os outros agentes", async () => {
    comLigacoesEAgentes();
    const respostas = respostasDoAtivar();
    respostas[APAGAR_2] = { status: 404 };
    const { fetch, chamadas } = rede(respostas);
    const pendencias = await desmontarLigacoes(comoConexao(linha()!), { fetch });
    expect(pendencias).toEqual([]);
    // a Meta e o tronco antes dos outros agentes: o teto do Desconectar não se gasta neles antes
    // de o número parar de receber ligações
    expect(chamadas.slice(0, 3).map((c) => `${c.metodo} ${c.url}`)).toEqual([
      R.ligarSip,
      R.apagarTronco,
      APAGAR_2,
    ]);
    expect(falso.agentes.every((a) => a.idExterno === null)).toBe(true);
  });

  it("sem conseguir ler as linhas dos agentes, fica a pendência 'agente'; o Tentar de novo relê e limpa", async () => {
    comLigacoesEAgentes();
    falso.listarFalha = true;
    const respostas = respostasDoAtivar();
    respostas[APAGAR_2] = { status: 204 };
    const { fetch } = rede(respostas);
    const r = await desativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({
      ok: true,
      estado: { situacao: "com_pendencias", pendencias: ["agente"] },
    });
    falso.listarFalha = false;
    const segunda = rede(respostas);
    const r2 = await desativarLigacoesLogica(
      contexto(),
      { origem: ORIGEM },
      { fetch: segunda.fetch },
    );
    expect(r2).toMatchObject({ ok: true, estado: { situacao: "pronta", pendencias: [] } });
    expect(segunda.chamadas.map((c) => `${c.metodo} ${c.url}`)).toEqual([APAGAR_2]);
    expect(falso.agentes.every((a) => a.idExterno === null)).toBe(true);
  });
});

// ---------- a verificação antes de ativar (seção 21) ----------

describe("verificarLigacoes", () => {
  it("sem admin dá sem_acesso, sem rede", async () => {
    const { fetch, chamadas } = rede({});
    const r = await verificarLigacoesLogica(
      contexto({ admin: false }),
      { origem: ORIGEM },
      { fetch },
    );
    expect(r).toMatchObject({ ok: false, erro: "sem_acesso" });
    expect(chamadas).toHaveLength(0);
  });

  it("tudo certo: só lê (GET), não cria nada, grava a verificação e o estado a devolve", async () => {
    const { fetch, chamadas, naoEsperadas } = rede(respostasDoAtivar());
    const r = await verificarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(naoEsperadas).toEqual([]);
    expect(chamadas.map((c) => `${c.metodo} ${c.url}`)).toEqual([
      R.numero,
      R.conferirSip,
      R.agentes,
    ]);
    expect(dubles.iniciarLigacoes).not.toHaveBeenCalled();
    expect(falso.agentes).toEqual([]);
    expect(r).toMatchObject({
      ok: true,
      estado: { situacao: "pronta", elegibilidade: { elegivel: true, limiteMeta: "TIER_2K" } },
    });
    expect(linha()!.parametros).not.toHaveProperty("ligacoes");
    expect(linha()!.parametros["ligacoesElegibilidade"]).toMatchObject({ elegivel: true });
    // o estado seguinte devolve a verificação guardada, sem rede
    const depois = await estadoLigacoesLogica(contexto(), { origem: ORIGEM });
    expect(depois.ok && depois.estado.elegibilidade?.elegivel).toBe(true);
    semSegredos(r);
  });

  it("número de 250: não elegível, com o tier, e nada criado", async () => {
    const respostas = respostasDoAtivar();
    respostas[R.numero] = {
      status: 200,
      corpo: {
        display_phone_number: "+55 11 99999-0000",
        whatsapp_business_manager_messaging_limit: "TIER_250",
      },
    };
    const { fetch, chamadas } = rede(respostas);
    const r = await verificarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(chamadas.every((c) => c.metodo === "GET")).toBe(true);
    const el = r.ok ? r.estado.elegibilidade : null;
    expect(el).toMatchObject({ elegivel: false, limiteMeta: "TIER_250" });
    expect(el?.itens.find((i) => i.id === "meta_limite")).toEqual({
      id: "meta_limite",
      dono: "meta",
      estado: "falta",
      valor: "TIER_250",
      erro: "meta_limite",
    });
  });

  it("com as ligações já ativas: não confere nada e devolve o estado", async () => {
    falso.linhas = [linhaMeta({ parametros: { phoneId: PHONE, ligacoes: ligacoesGravadas() } })];
    const { fetch, chamadas } = rede({});
    const r = await verificarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: true, estado: { situacao: "ativa" } });
    expect(chamadas).toHaveLength(0);
  });

  it("Sol, rodada 2: uma ativação recusada no meio da verificação; o resultado velho não grava por cima", async () => {
    const reprovada = { versao: 1, elegivel: false, marca: "recusa da ativação" };
    const respostas = respostasDoAtivar();
    respostas[R.agentes] = {
      status: 200,
      corpo: { agents: [] },
      // enquanto esta verificação esperava a ElevenLabs, outra requisição gravou a recusa
      antes: () => {
        linha()!.parametros = { ...linha()!.parametros, ligacoesElegibilidade: reprovada };
      },
    };
    const { fetch } = rede(respostas);
    const r = await verificarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: true, estado: { elegibilidade: { elegivel: true } } });
    expect(linha()!.parametros["ligacoesElegibilidade"]).toEqual(reprovada);
    expect(falso.tempo).toContain("banco elegibilidade perdeu");
  });

  it("Sol, rodada 2: o token foi consertado no meio da verificação; a aprovação do token velho não grava", async () => {
    const respostas = respostasDoAtivar();
    respostas[R.conferirSip] = {
      status: 200,
      corpo: { calling: { status: "DISABLED" } },
      antes: () => {
        linha()!.segredos = { ...linha()!.segredos, token: "token-consertado" };
      },
    };
    const { fetch } = rede(respostas);
    await verificarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(linha()!.parametros).not.toHaveProperty("ligacoesElegibilidade");
  });

  it("Opus, rodada 2: com a conexão caída, o estado não mostra a verificação guardada", async () => {
    const { fetch } = rede(respostasDoAtivar());
    await verificarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(linha()!.parametros["ligacoesElegibilidade"]).toMatchObject({ elegivel: true });
    Object.assign(linha()!, { status: "erro" });
    const r = await estadoLigacoesLogica(contexto(), { origem: ORIGEM });
    expect(r.ok && r.estado.elegibilidade).toBeNull();
  });

  it("o banco falhou ao gravar a verificação: devolve o resultado mesmo assim", async () => {
    dubles.gravarElegibilidade.mockRejectedValue(new Error("banco_gravar_elegibilidade"));
    const { fetch } = rede(respostasDoAtivar());
    const r = await verificarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: true, estado: { elegibilidade: { elegivel: true } } });
  });
});

describe("ativarLigacoes com a verificação (seção 21)", () => {
  it("número de 250: meta_limite antes de criar qualquer coisa, com a lista, e fica guardada", async () => {
    const respostas = respostasDoAtivar();
    respostas[R.numero] = {
      status: 200,
      corpo: {
        display_phone_number: "+55 11 99999-0000",
        whatsapp_business_manager_messaging_limit: "TIER_250",
      },
    };
    const { fetch, chamadas } = rede(respostas);
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "meta_limite" });
    expect(r.ok ? null : r.elegibilidade?.limiteMeta).toBe("TIER_250");
    expect(chamadas.every((c) => c.metodo === "GET")).toBe(true);
    expect(dubles.iniciarLigacoes).not.toHaveBeenCalled();
    expect(falso.agentes).toEqual([]);
    expect(linha()!.parametros["ligacoesElegibilidade"]).toMatchObject({ elegivel: false });
  });

  it("número bloqueado: meta_numero_bloqueado antes de criar qualquer coisa", async () => {
    const respostas = respostasDoAtivar();
    respostas[R.numero] = {
      status: 200,
      corpo: {
        display_phone_number: "+55 11 99999-0000",
        whatsapp_business_manager_messaging_limit: "TIER_2K",
        health_status: { can_send_message: "BLOCKED" },
      },
    };
    const { fetch, chamadas } = rede(respostas);
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "meta_numero_bloqueado" });
    expect(chamadas.every((c) => c.metodo === "GET")).toBe(true);
  });

  it("138015 só no ligar das chamadas: desmonta tudo, e a lista guardada passa a dizer o limite", async () => {
    const respostas = respostasDoAtivar();
    respostas[R.ligarSip] = [
      { status: 200, corpo: { success: true } },
      { status: 400, corpo: { error: { code: 138015 } } },
      { status: 200, corpo: { success: true } },
    ];
    const { fetch, chamadas, naoEsperadas } = rede(respostas);
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(naoEsperadas).toEqual([]);
    expect(r).toMatchObject({ ok: false, erro: "meta_limite" });
    const el = r.ok ? null : r.elegibilidade;
    expect(el?.elegivel).toBe(false);
    expect(el?.itens.find((i) => i.id === "meta_limite")?.estado).toBe("falta");
    expect(sobrouNaRede(chamadas)).toEqual([]);
    expect(linha()!.parametros).not.toHaveProperty("ligacoes");
    expect(linha()!.parametros["ligacoesElegibilidade"]).toMatchObject({ elegivel: false });
  });

  it("138015 no fim, mas o token foi consertado no meio da ativação: a recusa do token velho não grava", async () => {
    const respostas = respostasDoAtivar();
    respostas[R.ligarSip] = [
      { status: 200, corpo: { success: true } },
      {
        status: 400,
        corpo: { error: { code: 138015 } },
        antes: () => {
          linha()!.segredos = { ...linha()!.segredos, token: "token-consertado" };
        },
      },
      { status: 200, corpo: { success: true } },
    ];
    const { fetch } = rede(respostas);
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "meta_limite" });
    // a resposta diz o motivo; a lista guardada continua a do começo (aprovada)
    expect(r.ok ? null : r.elegibilidade?.elegivel).toBe(false);
    expect(linha()!.parametros["ligacoesElegibilidade"]).toMatchObject({ elegivel: true });
  });

  it("Sol, rodada 3: 138014 no fim de A, mas outra aba desativou A e ativou B; a recusa de A não grava sobre B", async () => {
    const aprovadaB = { versao: 1, elegivel: true, marca: "ativação B" };
    const respostas = respostasDoAtivar();
    respostas[R.ligarSip] = [
      { status: 200, corpo: { success: true } },
      {
        status: 400,
        corpo: { error: { code: 138014 } },
        // enquanto A esperava a Meta: A foi desativada e B ativou com o mesmo número e token
        antes: () => {
          linha()!.parametros = {
            ...linha()!.parametros,
            ligacoes: ligacoesGravadas({
              situacao: "ativa",
              atualizadaEm: "2099-01-01T00:00:00.000Z",
            }),
            ligacoesElegibilidade: aprovadaB,
          };
        },
      },
    ];
    const { fetch } = rede(respostas);
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "meta_pausada" });
    expect(linha()!.parametros["ligacoes"]).toMatchObject({ situacao: "ativa" });
    expect(linha()!.parametros["ligacoesElegibilidade"]).toEqual(aprovadaB);
  });

  it("Sol, rodada 4: 138014 no fim de A; A limpa tudo, B verifica e grava a aprovação antes de começar; a recusa de A não grava sobre ela", async () => {
    const aprovadaB = { versao: 1, elegivel: true, conferidaEm: "2099-01-01T00:00:00.000Z" };
    const respostas = respostasDoAtivar();
    respostas[R.ligarSip] = [
      { status: 200, corpo: { success: true } },
      { status: 400, corpo: { error: { code: 138014 } } },
      {
        status: 200,
        corpo: { success: true },
        // o desligar de A: logo depois, a limpeza de A, e B grava a aprovação dela (ainda sem
        // parametros.ligacoes)
        antes: () => {
          linha()!.parametros = { ...linha()!.parametros, ligacoesElegibilidade: aprovadaB };
        },
      },
    ];
    const { fetch } = rede(respostas);
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "meta_pausada" });
    expect(linha()!.parametros).not.toHaveProperty("ligacoes");
    expect(linha()!.parametros["ligacoesElegibilidade"]).toEqual(aprovadaB);
  });

  it("Opus, rodada 4: outra aba limpa A antes da recusa e B começa durante a desmontagem de A; a aprovação de B fica", async () => {
    const aprovadaB = { versao: 1, elegivel: true, marca: "ativação B" };
    const respostas = respostasDoAtivar();
    respostas[R.ligarSip] = [
      { status: 200, corpo: { success: true } },
      {
        status: 400,
        corpo: { error: { code: 138014 } },
        antes: () => {
          const p = { ...linha()!.parametros };
          delete p["ligacoes"];
          linha()!.parametros = p;
        },
      },
      { status: 200, corpo: { success: true } },
    ];
    respostas[R.apagarAgente] = {
      status: 204,
      antes: () => {
        linha()!.parametros = {
          ...linha()!.parametros,
          ligacoes: ligacoesGravadas({
            situacao: "ativando",
            atualizadaEm: "2099-01-01T00:00:00.000Z",
          }),
          ligacoesElegibilidade: aprovadaB,
        };
      },
    };
    const { fetch } = rede(respostas);
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "meta_pausada" });
    expect(linha()!.parametros["ligacoesElegibilidade"]).toEqual(aprovadaB);
  });

  it("Opus, rodada 4: B ainda verifica quando chega a recusa de A; B ativa e a aprovação dela fica guardada", async () => {
    const aEmEspera = adiada();
    const soltaA = adiada();
    const soltaB = adiada();
    let aParado = false;
    let bParado = false;
    const rA = respostasDoAtivar();
    rA[R.ligarSip] = [
      { status: 200, corpo: { success: true } },
      {
        status: 400,
        corpo: { error: { code: 138014 } },
        antes: () => {
          const p = { ...linha()!.parametros };
          delete p["ligacoes"];
          linha()!.parametros = p;
          aParado = true;
          aEmEspera.resolver();
        },
        espera: soltaA.promessa,
      },
      { status: 200, corpo: { success: true } },
    ];
    const pA = ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch: rede(rA).fetch });
    await ate(() => aParado);
    const rB = respostasDoAtivar();
    rB[R.numero] = {
      ...(rB[R.numero] as Resposta),
      antes: () => {
        bParado = true;
      },
      espera: soltaB.promessa,
    };
    const pB = ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch: rede(rB).fetch });
    await ate(() => bParado);
    soltaA.resolver();
    const a = await pA;
    expect(a).toMatchObject({ ok: false, erro: "meta_pausada" });
    expect(linha()!.parametros["ligacoesElegibilidade"]).toMatchObject({ elegivel: false });
    soltaB.resolver();
    const b = await pB;
    expect(b).toMatchObject({ ok: true });
    expect(linha()!.parametros["ligacoes"]).toMatchObject({ situacao: "ativa" });
    // B terminou ativa: a aprovação dela é a guardada, não a reprovação de A
    expect(linha()!.parametros["ligacoesElegibilidade"]).toMatchObject({ elegivel: true });
  });

  it("a recusa tardia não grava com outra ativação em curso (B começou durante a desmontagem de A, ainda sem gravar a verificação)", async () => {
    const respostas = respostasDoAtivar();
    respostas[R.ligarSip] = [
      { status: 200, corpo: { success: true } },
      {
        status: 400,
        corpo: { error: { code: 138014 } },
        antes: () => {
          const p = { ...linha()!.parametros };
          delete p["ligacoes"];
          linha()!.parametros = p;
        },
      },
      { status: 200, corpo: { success: true } },
    ];
    respostas[R.apagarAgente] = {
      status: 204,
      antes: () => {
        linha()!.parametros = {
          ...linha()!.parametros,
          ligacoes: ligacoesGravadas({
            situacao: "ativando",
            atualizadaEm: "2099-01-01T00:00:00.000Z",
          }),
        };
      },
    };
    const { fetch } = rede(respostas);
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "meta_pausada" });
    expect(linha()!.parametros["ligacoes"]).toMatchObject({ situacao: "ativando" });
    // a guardada continua a de A (aprovada): a recusa de A não passa por cima da ativação B
    expect(linha()!.parametros["ligacoesElegibilidade"]).toMatchObject({ elegivel: true });
  });

  it("138015 no fim e a desmontagem deixou pendência: a lista guardada também diz o limite", async () => {
    const respostas = respostasDoAtivar();
    respostas[R.ligarSip] = [
      { status: 200, corpo: { success: true } },
      { status: 400, corpo: { error: { code: 138015 } } },
      { status: 200, corpo: { success: true } },
    ];
    respostas[R.apagarFerramenta] = { status: 500 };
    const { fetch } = rede(respostas);
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "meta_limite" });
    expect(linha()!.parametros["ligacoes"]).toMatchObject({ situacao: "com_pendencias" });
    expect(linha()!.parametros["ligacoesElegibilidade"]).toMatchObject({ elegivel: false });
    // e o estado seguinte mostra a reprovação, não a aprovação de antes
    const depois = await estadoLigacoesLogica(contexto(), { origem: ORIGEM });
    expect(depois.ok && depois.estado.elegibilidade?.elegivel).toBe(false);
  });
});

describe("ativar com a ligação de saída (seção 1)", () => {
  it("a saída do tronco falhou: a ativação segue (a entrada não depende dela), sem a marca da saída", async () => {
    const respostas = respostasDoAtivar();
    respostas[R.patchTronco] = [
      { status: 200, corpo: {} },
      { status: 200, corpo: {} },
      { status: 500, corpo: {} },
    ];
    const { fetch, naoEsperadas, chamadas: chamadasAtivar } = rede(respostas);
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(naoEsperadas).toEqual([]);
    expect(r).toMatchObject({ ok: true, estado: { situacao: "ativa" } });
    const gravado = linha()!.parametros["ligacoes"] as LigacoesGravadas;
    expect(gravado.situacao).toBe("ativa");
    expect(gravado.saida).toBeUndefined();
    // o callback vai de todo jeito: quem liga ganha os 7 dias mesmo sem a saída (Sol, PR #24)
    const posts = chamadasAtivar.filter((c) => `${c.metodo} ${c.url}` === R.ligarSip).map(corpoDe);
    expect(posts).toContainEqual({ calling: { callback_permission_status: "ENABLED" } });
  });

  it("o callback vai à parte, depois das chamadas: o SIP liga sem ele (Opus, PR #24)", async () => {
    const { fetch, chamadas } = rede(respostasDoAtivar());
    await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    const posts = chamadas.filter((c) => `${c.metodo} ${c.url}` === R.ligarSip).map(corpoDe);
    expect(posts[0]).toMatchObject({ calling: { callback_permission_status: "DISABLED" } });
    expect(posts[2]).toEqual({ calling: { callback_permission_status: "ENABLED" } });
  });

  it("o callback recusado não desfaz a ativação: ativa, sem a marca da saída (Opus, PR #24)", async () => {
    const respostas = respostasDoAtivar();
    respostas[R.ligarSip] = [
      { status: 200, corpo: { success: true } },
      { status: 200, corpo: { success: true } },
      { status: 400, corpo: { error: { code: 100 } } },
    ];
    const { fetch, naoEsperadas } = rede(respostas);
    const r = await ativarLigacoesLogica(contexto(), { origem: ORIGEM }, { fetch });
    expect(naoEsperadas).toEqual([]);
    expect(r).toMatchObject({ ok: true, estado: { situacao: "ativa" } });
    expect((linha()!.parametros["ligacoes"] as LigacoesGravadas).saida).toBeUndefined();
  });
});
