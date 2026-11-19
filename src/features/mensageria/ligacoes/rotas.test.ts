// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { banco, limparBanco, supabaseFalso } from "../ia/__testes__/dubles";
import type { ConexaoServidor } from "../nucleo/tipos";
import { assinarPosChamada } from "./assinatura";
import { lerSessao } from "./sessao";
import type { LigacoesGravadas } from "./tipos";

const estado = vi.hoisted(() => ({
  conexao: null as unknown,
  admin: null as unknown,
  /** a leitura da conexão demora até esta promessa resolver (D32) */
  esperaConexao: null as Promise<unknown> | null,
}));

// fábrica síncrona: as leituras do contexto carregam o cliente por import dinâmico
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return estado.admin;
  },
}));
vi.mock("../nucleo/conexoes.server", () => ({
  // a chave da voz, para ler a conversa na ElevenLabs (a ligação de saída ainda provisória)
  lerChaveIA: async () => ({ provedor: "elevenlabs", chave: "sk_eleven_rotas_teste" }),
  carregarConexao: async (id: string) => {
    if (estado.esperaConexao) await estado.esperaConexao;
    const c = estado.conexao as { id: string } | null;
    return c && c.id === id ? structuredClone(c) : null;
  },
}));
vi.mock("../nucleo/midia.server", () => ({
  baixarArquivo: async () => {
    throw new Error("midia_download_falhou");
  },
}));

estado.admin = supabaseFalso;
const {
  processarLigacao,
  MENSAGEM_EQUIPE,
  MAX_CORPO,
  MAX_CORPO_POS_CHAMADA,
  SAUDACAO_RECUSADA,
  SAUDACAO_LIMITE,
  CONTEXTO_ENCERRAR,
  CONVERSA_PENDENTE,
} = await import("./rotas.server");

/** A resposta de despedida (recusa depois de autenticar): 200, a ligação nunca fica muda. */
const DESPEDIDA = {
  type: "conversation_initiation_client_data",
  dynamic_variables: {
    nina_saudacao: SAUDACAO_RECUSADA,
    nina_contexto: CONTEXTO_ENCERRAR,
    nina_lead: "",
    secret__nina_sessao: "",
  },
};

const CONEXAO = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TOKEN = "token-da-ligacao-0123456789abcdef0123456789abcdef";
const HMAC = "wsec_segredo-do-webhook-0123456789";
const AGENTE = "agent_nina_1";
const PHONE_ID = "1098765432";
const BSUID = "BR.AbCdEf123";
const TELEFONE = "5511912345678";
const AGORA_MS = Date.UTC(2026, 10, 11, 15, 0, 0);
const AGORA_S = Math.floor(AGORA_MS / 1000);
const CONVERSA_ANA = "11111111-2222-4333-8444-555555555555";
/** O agente "Nina" da tela de Ligações: a linha de ligacao_agentes com o id da ElevenLabs. */
const AGENTE_VENDAS = "agent_vendas_2";
/** A versão mais recente do Contexto e a sincronia do agente, depois dela. */
const CONTEXTO_EM = "2026-11-10T10:00:00.000Z";
const SINCRONIZADO_EM = "2026-11-10T11:00:00.000Z";

function ligacoes(extra: Partial<LigacoesGravadas> = {}): LigacoesGravadas {
  return {
    versao: 1,
    situacao: "ativa",
    origem: "https://nina.example",
    numero: "5511900000000",
    limiteMeta: "TIER_2K",
    ativadaEm: "2026-11-10T12:00:00.000Z",
    eleven: {
      segredoId: "s1",
      webhookId: "w1",
      ferramentaId: "f1",
      agenteId: AGENTE,
      troncoId: "t1",
    },
    metaSip: true,
    pendencias: [],
    atualizadaEm: "2026-11-10T12:00:00.000Z",
    ...extra,
  };
}

function conexao(extra: Partial<ConexaoServidor> = {}): ConexaoServidor {
  return {
    id: CONEXAO,
    gateway: "meta",
    id_externo: PHONE_ID,
    oficial: true,
    parametros: { wabaId: "waba1", ligacoes: ligacoes() },
    segredos: {
      token: "meta",
      appSecret: "app",
      verifyToken: "vt",
      ligacaoToken: TOKEN,
      ligacaoHmac: HMAC,
    },
    ...extra,
  };
}

let seq = 0;

/** A registrar_entrada do banco, em memória: idempotente pelo id_externo, cria contato e conversa. */
function registrarEntradaFalsa(args: Record<string, unknown>) {
  const t = banco.tabelas as Record<string, Record<string, unknown>[]>;
  const msg = args["p_msg"] as Record<string, string>;
  const ids = args["p_ids"] as { tipo: string; valor: string }[];
  const existente = t["mensagens"]!.find(
    (m) => m["conexao_id"] === args["p_conexao"] && m["id_externo"] === msg["id_externo"],
  );
  if (existente) {
    return { mensagem_id: existente["id"], conversa_id: existente["conversa_id"], nova: false };
  }
  let contato: unknown = acharContato(ids);
  if (!contato) {
    contato = `k_novo_${++seq}`;
    t["contatos"]!.push({
      id: contato,
      nome: null,
      nome_whatsapp: null,
      resumo_nina: null,
      etapa_id: "e1",
    });
    for (const i of ids) t["contato_identificadores"]!.push({ contato_id: contato, ...i });
  }
  let conversa = t["conversas"]!.find((c) => c["contato_id"] === contato);
  if (!conversa) {
    conversa = {
      id: crypto.randomUUID(),
      contato_id: contato,
      modo: "nina",
      aguardando_humano_desde: null,
      responder_apos: null,
    };
    t["conversas"]!.push(conversa);
  }
  const id = `m_novo_${++seq}`;
  t["mensagens"]!.push({
    id,
    conversa_id: conversa["id"],
    conexao_id: args["p_conexao"],
    direcao: "entrada",
    origem: "lead",
    tipo: msg["tipo"],
    texto: msg["texto"],
    transcricao: null,
    status: "recebida",
    apagada_em: null,
    id_externo: msg["id_externo"],
    momento: msg["momento"],
  });
  conversa["ultima_mensagem_id"] = id;
  conversa["ultima_mensagem_preview"] = (msg["texto"] ?? "").slice(0, 140);
  return { mensagem_id: id, conversa_id: conversa["id"], nova: true };
}

function acharContato(ids: { tipo: string; valor: string }[]): unknown {
  for (const i of ids) {
    const achado = banco.tabelas["contato_identificadores"]!.find(
      (c) => c["tipo"] === i.tipo && c["valor"] === i.valor,
    );
    if (achado) return achado["contato_id"];
  }
  return null;
}

/** O rotulo_da_ligacao do banco (0024). */
function rotulo(status: string, duracao: number | null): string {
  if (status === "em_andamento") return "Ligação em andamento";
  if (status === "nao_completada") return "Ligação não completada";
  if (duracao === null) return "Ligação";
  if (duracao < 60) return `Ligação · ${duracao} s`;
  if (duracao % 60 === 0) return `Ligação · ${duracao / 60} min`;
  return `Ligação · ${Math.floor(duracao / 60)} min ${duracao % 60} s`;
}

/** As funções do envio 3 (0024) em memória, com as mesmas regras do SQL. */
function rpcFalsa(nome: string, args: Record<string, unknown>) {
  const t = banco.tabelas as Record<string, Record<string, unknown>[]>;
  const ligs = (t["ligacoes"] ??= []);
  if (nome === "ligacao_iniciar") {
    const ext = String(args["p_id_externo"]);
    const ja = ligs.find((l) => l["id_externo"] === ext);
    if (ja) {
      return {
        data: [
          { ligacao_id: ja["id"], conversa_id: ja["conversa_id"], permitida: true, motivo: null },
        ],
        error: null,
      };
    }
    // os limites da conta (a versão de 8 argumentos, só no início; base 0039): as simultâneas
    if (args["p_conferir_conta"] === true) {
      const simult = (t["configuracao"]?.[0]?.["ligacoes_simultaneas"] as number) ?? 99;
      if (ligs.filter((l) => l["status"] === "em_andamento").length >= simult) {
        return {
          data: [
            { ligacao_id: null, conversa_id: null, permitida: false, motivo: "limite_simultaneas" },
          ],
          error: null,
        };
      }
    }
    const contato = acharContato(args["p_ids"] as { tipo: string; valor: string }[]);
    if (contato) {
      const limite = (t["configuracao"]?.[0]?.["ligacoes_por_contato"] as number) ?? 10;
      const momento = Date.parse(String(args["p_momento"]));
      const qtd = ligs.filter((l) => {
        const c = t["conversas"]!.find((x) => x["id"] === l["conversa_id"]);
        return (
          c?.["contato_id"] === contato &&
          l["direcao"] === "entrada" &&
          Date.parse(String(l["iniciada_em"])) > momento - 24 * 3600_000
        );
      }).length;
      if (qtd >= limite) {
        return {
          data: [
            { ligacao_id: null, conversa_id: null, permitida: false, motivo: "limite_por_contato" },
          ],
          error: null,
        };
      }
    }
    const r = registrarEntradaFalsa({
      p_conexao: args["p_conexao"],
      p_ids: args["p_ids"],
      p_msg: {
        id_externo: `ligacao:${ext}`,
        tipo: "ligacao",
        texto: rotulo("em_andamento", null),
        momento: args["p_momento"],
      },
    });
    const linha = {
      id: `lig_${++seq}`,
      conversa_id: r.conversa_id,
      mensagem_id: r.mensagem_id,
      conexao_id: args["p_conexao"],
      agente_id: args["p_agente"] ?? null,
      direcao: "entrada",
      status: "em_andamento",
      id_externo: ext,
      iniciada_em: args["p_momento"],
      encerrada_em: null,
      duracao_s: null,
      motivo_fim: null,
      resumo: null,
      transcricao: [],
      passou_equipe: false,
      custo_creditos: null,
    };
    ligs.push(linha);
    return {
      data: [
        { ligacao_id: linha.id, conversa_id: linha.conversa_id, permitida: true, motivo: null },
      ],
      error: null,
    };
  }
  if (nome === "ligacao_saida_confirmar") {
    // a spec: troca o id provisório pelo da conversa na ElevenLabs
    const l = ligs.find((x) => x["id"] === args["p_ligacao"]);
    if (!l || l["direcao"] !== "saida") return { data: false, error: null };
    if (l["id_externo"] === args["p_id_externo"]) return { data: true, error: null };
    if (l["id_externo"] !== `saida-${String(args["p_ligacao"])}`)
      return { data: false, error: null };
    l["id_externo"] = args["p_id_externo"];
    return { data: true, error: null };
  }
  if (nome === "ligacao_encerrar") {
    const l = ligs.find((x) => x["id_externo"] === args["p_id_externo"]);
    if (!l) return { data: [], error: null };
    const status = String(args["p_status"]);
    if (!(l["status"] === "concluida" && status !== "concluida")) {
      const transc = args["p_transcricao"];
      Object.assign(l, {
        status,
        encerrada_em: args["p_encerrada_em"] ?? l["encerrada_em"],
        duracao_s: args["p_duracao_s"] ?? l["duracao_s"],
        motivo_fim: args["p_motivo_fim"] ?? l["motivo_fim"],
        resumo: args["p_resumo"] ?? l["resumo"],
        transcricao: Array.isArray(transc) && transc.length > 0 ? transc : l["transcricao"],
        custo_creditos: args["p_custo_creditos"] ?? l["custo_creditos"],
      });
      const texto = rotulo(status, (l["duracao_s"] as number | null) ?? null);
      const m = t["mensagens"]!.find((x) => x["id"] === l["mensagem_id"]);
      if (m) m["texto"] = texto;
      const c = t["conversas"]!.find((x) => x["id"] === l["conversa_id"]);
      if (c && c["ultima_mensagem_id"] === l["mensagem_id"]) c["ultima_mensagem_preview"] = texto;
    }
    return { data: [{ ligacao_id: l["id"], conversa_id: l["conversa_id"] }], error: null };
  }
  if (nome === "ligacao_passar_para_equipe") {
    const l = ligs.find((x) => x["id"] === args["p_ligacao"]);
    if (!l) return { data: null, error: { code: "P0001", message: "ligacao_nao_encontrada" } };
    if (l["passou_equipe"]) return { data: false, error: null };
    l["passou_equipe"] = true;
    const c = t["conversas"]!.find((x) => x["id"] === l["conversa_id"]);
    if (c && c["modo"] === "nina") {
      Object.assign(c, {
        modo: "humano",
        motivo_humano: "nina_passou",
        aguardando_humano_desde: c["aguardando_humano_desde"] ?? new Date(AGORA_MS).toISOString(),
        responder_apos: null,
      });
      t["conversa_eventos"]!.push({ conversa_id: c["id"], tipo: "passou", motivo: "nina_passou" });
      return { data: true, error: null };
    }
    return { data: false, error: null };
  }
  if (nome === "ligacao_avisar_falha") {
    // o essencial da regra do banco (a regra inteira é testada em src/test/banco)
    const l = ligs.find((x) => x["id"] === args["p_ligacao"]);
    if (!l || l["status"] !== "nao_completada" || l["aviso_falha_em"]) {
      return { data: null, error: null };
    }
    l["aviso_falha_em"] = new Date(AGORA_MS).toISOString();
    return { data: `aviso_${String(l["id"])}`, error: null };
  }
  if (nome === "acordar_motor") return { data: "tocado", error: null };
  return { data: null, error: null };
}

function mensagemAntiga(id: string, minutosAtras: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    conversa_id: CONVERSA_ANA,
    conexao_id: CONEXAO,
    direcao: "entrada",
    origem: "lead",
    tipo: "texto",
    texto: `texto ${id}`,
    transcricao: null,
    status: "recebida",
    apagada_em: null,
    id_externo: `wamid.${id}`,
    momento: new Date(AGORA_MS - minutosAtras * 60_000).toISOString(),
    ...extra,
  };
}

beforeEach(() => {
  seq = 0;
  estado.conexao = conexao();
  limparBanco({
    contato_identificadores: [{ contato_id: "k_ana", tipo: "bsuid", valor: BSUID }],
    contatos: [
      {
        id: "k_ana",
        nome: "Ana Souza",
        nome_whatsapp: "Ana W",
        resumo_nina: "Quer automação.",
        etapa_id: "e2",
      },
    ],
    etapas: [
      { id: "e1", nome: "Novo" },
      { id: "e2", nome: "Em qualificação" },
    ],
    conversas: [
      {
        id: CONVERSA_ANA,
        contato_id: "k_ana",
        modo: "nina",
        aguardando_humano_desde: null,
        responder_apos: null,
        ultima_mensagem_id: "m2",
        ultima_mensagem_preview: "Oi, Ana!",
      },
    ],
    contexto_versoes: [
      { id: 1, empresa_oferta: "Versão antiga", itens: [], criado_em: "2026-11-01T10:00:00.000Z" },
      {
        id: 2,
        empresa_oferta: "Consultoria de IA",
        preco: "A partir de R$ 1.000",
        itens: [],
        criado_em: CONTEXTO_EM,
      },
    ],
    ligacao_agentes: [
      {
        id: "ag_nina",
        id_externo: AGENTE,
        saudacao: "Oi, {nome}! Aqui é a Nina. Como posso te ajudar?",
        sincronizado_em: SINCRONIZADO_EM,
        duracao_max_s: 1800,
      },
      {
        id: "ag_vendas",
        id_externo: AGENTE_VENDAS,
        saudacao: "{nome}, aqui é o time de vendas!",
        sincronizado_em: SINCRONIZADO_EM,
        duracao_max_s: 600,
      },
    ],
    ligacoes: [],
    configuracao: [{ id: 1, ligacoes_por_contato: 10 }],
    mensagens: [
      mensagemAntiga("m1", 60, { texto: "Quanto custa?" }),
      mensagemAntiga("m2", 50, {
        direcao: "saida",
        origem: "nina",
        texto: "Oi, Ana!",
        status: "enviada",
      }),
    ],
    conversa_eventos: [],
  });
  banco.respostaRpc = rpcFalsa;
  // nenhum teste sai para a rede: a leitura da conversa na ElevenLabs (a ligação de saída ainda
  // provisória) responde 404, salvo onde o teste troca
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function pedido(acao: string, corpo: unknown, cabecalhos: Record<string, string> = {}): Request {
  return new Request(`https://nina.example/api/public/ligacoes/${CONEXAO}/${acao}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...cabecalhos },
    body: typeof corpo === "string" ? corpo : JSON.stringify(corpo),
  });
}

const AUT = { authorization: `Bearer ${TOKEN}` };

function corpoInicio(extra: Record<string, unknown> = {}) {
  return {
    caller_id: `+${TELEFONE}`,
    agent_id: AGENTE,
    called_number: "+5511900000000",
    conversation_id: "conv_ligacao_1",
    call_sid: "sip-call-1",
    sip_headers: { "X-WA-Meta-User-Id": BSUID, "x-wa-meta-phone-number-id": PHONE_ID },
    ...extra,
  };
}

async function chamar(acao: string, corpo: unknown, cab: Record<string, string> = AUT) {
  const r = await processarLigacao(pedido(acao, corpo, cab), CONEXAO, acao, { agoraMs: AGORA_MS });
  return { status: r.status, corpo: (await r.json()) as Record<string, unknown>, r };
}

/** As ligações gravadas (a tabela ligacoes). */
function ligacoesGravadas() {
  return banco.tabelas["ligacoes"]!;
}

/** As mensagens de ligação na conversa (o tipo "ligacao", L16). */
function registros() {
  return banco.tabelas["mensagens"]!.filter((m) => String(m["id_externo"]).startsWith("ligacao:"));
}

function conversaAna() {
  return banco.tabelas["conversas"]!.find((c) => c["id"] === CONVERSA_ANA)!;
}

type Variaveis = Record<string, string>;

describe("comum", () => {
  it("ação desconhecida, conexão inexistente, de outro gateway ou sem ligações: 404", async () => {
    expect((await processarLigacao(pedido("x", {}), CONEXAO, "outra")).status).toBe(404);
    expect((await processarLigacao(pedido("inicio", {}), "nao-e-uuid", "inicio")).status).toBe(404);
    expect(
      (
        await processarLigacao(
          pedido("inicio", {}),
          "aaaaaaaa-bbbb-4ccc-8ddd-000000000000",
          "inicio",
        )
      ).status,
    ).toBe(404);
    estado.conexao = conexao({ gateway: "zapi" });
    expect((await chamar("inicio", corpoInicio())).status).toBe(404);
    estado.conexao = conexao({ parametros: { wabaId: "waba1" } });
    expect((await chamar("inicio", corpoInicio())).status).toBe(404);
    // desativada: os segredos saíram
    estado.conexao = conexao({ segredos: {} });
    expect((await chamar("inicio", corpoInicio())).status).toBe(404);
    expect(registros()).toHaveLength(0);
  });

  it("só POST, e a resposta é JSON sem cache", async () => {
    const get = new Request(`https://nina.example/api/public/ligacoes/${CONEXAO}/inicio`);
    expect((await processarLigacao(get, CONEXAO, "inicio")).status).toBe(405);
    const { r } = await chamar("inicio", corpoInicio());
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

describe("início", () => {
  it("contato conhecido: grava pela ligacao_iniciar e devolve as variáveis", async () => {
    const { status, corpo } = await chamar("inicio", corpoInicio());
    expect(status).toBe(200);
    expect(corpo["type"]).toBe("conversation_initiation_client_data");
    const v = corpo["dynamic_variables"] as Variaveis;
    expect(v["nina_saudacao"]).toBe("Oi, Ana! Aqui é a Nina. Como posso te ajudar?");
    // o agente em dia com o Contexto já o tem no prompt (L14): o nina_contexto vai vazio
    expect(v["nina_contexto"]).toBe("");
    expect(v["nina_lead"]).toBe(
      "Nome: Ana Souza\nEtapa: Em qualificação\nResumo: Quer automação.\nÚltimas mensagens:\n" +
        "Lead: Quanto custa?\nNina: Oi, Ana!",
    );
    const sessao = await lerSessao(TOKEN, v["secret__nina_sessao"], AGORA_S);
    expect(sessao).toMatchObject({ conversaId: CONVERSA_ANA, conversaEleven: "conv_ligacao_1" });

    expect(ligacoesGravadas()).toEqual([
      expect.objectContaining({
        conversa_id: CONVERSA_ANA,
        agente_id: "ag_nina",
        status: "em_andamento",
        id_externo: "conv_ligacao_1",
        iniciada_em: new Date(AGORA_MS).toISOString(),
      }),
    ]);
    expect(registros()).toEqual([
      expect.objectContaining({
        conversa_id: CONVERSA_ANA,
        tipo: "ligacao",
        texto: "Ligação em andamento",
        id_externo: "ligacao:conv_ligacao_1",
      }),
    ]);
    const rpc = banco.rpcs.find((r) => r.nome === "ligacao_iniciar")!;
    expect(rpc.args).toMatchObject({
      p_conexao: CONEXAO,
      p_ids: [
        { tipo: "bsuid", valor: BSUID },
        { tipo: "telefone", valor: TELEFONE },
      ],
      p_id_externo: "conv_ligacao_1",
      p_agente: "ag_nina",
      p_direcao: "entrada",
    });
    // uma ida só para gravar: nada de registrar_entrada nem contar ligações à parte
    expect(banco.rpcs.map((r) => r.nome)).toEqual(["ligacao_iniciar"]);
  });

  it("L32: a ligação anterior entra no nina_lead com o resumo dela", async () => {
    banco.tabelas["mensagens"]!.push(
      mensagemAntiga("m3", 40, {
        tipo: "ligacao",
        texto: "Ligação · 2 min 54 s",
        id_externo: "ligacao:conv_antiga_1",
      }),
    );
    banco.tabelas["ligacoes"]!.push({
      id: "lg_antiga",
      conversa_id: CONVERSA_ANA,
      mensagem_id: "m3",
      id_externo: "conv_antiga_1",
      status: "concluida",
      resumo: "Ana pediu o preço do plano anual.",
      transcricao: [{ papel: "lead", texto: "Quanto é o anual?", segundos: 3 }],
    });
    const { corpo } = await chamar("inicio", corpoInicio());
    const lead = (corpo["dynamic_variables"] as Variaveis)["nina_lead"]!;
    // (a fala do lead passa por neutralizar: o colchete de abertura vira o largo)
    expect(lead).toContain("ligação] 2 min 54 s Ana pediu o preço do plano anual.");
    expect(lead).not.toContain("Quanto é o anual?");
  });

  it("a ligação de saída anterior entra no nina_lead como da Nina, dizendo quem ligou (Opus, PR #24)", async () => {
    banco.tabelas["mensagens"]!.push(
      mensagemAntiga("m3", 40, {
        tipo: "ligacao",
        texto: "Ligação não completada",
        id_externo: "ligacao:conv_saida_antiga",
      }),
    );
    banco.tabelas["ligacoes"]!.push({
      id: "lg_saida_antiga",
      conversa_id: CONVERSA_ANA,
      mensagem_id: "m3",
      id_externo: "conv_saida_antiga",
      direcao: "saida",
      status: "nao_completada",
      resumo: null,
      transcricao: [],
    });
    const { corpo } = await chamar("inicio", corpoInicio());
    const lead = (corpo["dynamic_variables"] as Variaveis)["nina_lead"]!;
    expect(lead).toContain("Nina: ");
    expect(lead).toContain("ligação feita pela empresa] não completada");
    expect(lead).not.toMatch(/Lead: \S*ligação/);
  });

  it("a saudação é a do agente que atende a ligação", async () => {
    const { corpo } = await chamar("inicio", corpoInicio({ agent_id: AGENTE_VENDAS }));
    expect((corpo["dynamic_variables"] as Variaveis)["nina_saudacao"]).toBe(
      "Ana, aqui é o time de vendas!",
    );
    expect(ligacoesGravadas()[0]).toMatchObject({ agente_id: "ag_vendas" });
  });

  it("L14: o agente atrás do Contexto recebe o Contexto atual no nina_contexto", async () => {
    banco.tabelas["ligacao_agentes"]![0]!["sincronizado_em"] = "2026-11-09T00:00:00.000Z";
    const { corpo } = await chamar("inicio", corpoInicio());
    const v = corpo["dynamic_variables"] as Variaveis;
    expect(v["nina_contexto"]).toContain("Empresa e oferta: Consultoria de IA");
    expect(v["nina_contexto"]).not.toContain("Versão antiga");
  });

  it("L14: o agente que nunca sincronizou também recebe o Contexto", async () => {
    banco.tabelas["ligacao_agentes"]![0]!["sincronizado_em"] = null;
    const { corpo } = await chamar("inicio", corpoInicio());
    expect((corpo["dynamic_variables"] as Variaveis)["nina_contexto"]).toContain(
      "Consultoria de IA",
    );
  });

  it("o agente da primeira versão (só em parametros.ligacoes) é aceito e recebe o Contexto", async () => {
    banco.tabelas["ligacao_agentes"] = [];
    const { status, corpo } = await chamar("inicio", corpoInicio());
    expect(status).toBe(200);
    const v = corpo["dynamic_variables"] as Variaveis;
    expect(v["nina_saudacao"]).toBe("Oi, Ana! Aqui é a Nina. Como posso te ajudar?");
    expect(v["nina_contexto"]).toContain("Consultoria de IA");
    expect(ligacoesGravadas()[0]).toMatchObject({ agente_id: null });
  });

  it("o mesmo início de novo não duplica a ligação", async () => {
    await chamar("inicio", corpoInicio());
    const { status } = await chamar("inicio", corpoInicio());
    expect(status).toBe(200);
    expect(registros()).toHaveLength(1);
    expect(ligacoesGravadas()).toHaveLength(1);
  });

  it("contato novo só com o telefone: nasce pela ligacao_iniciar, saudação sem nome", async () => {
    const { status, corpo } = await chamar("inicio", corpoInicio({ sip_headers: {} }));
    expect(status).toBe(200);
    const v = corpo["dynamic_variables"] as Variaveis;
    expect(v["nina_saudacao"]).toBe("Oi! Aqui é a Nina. Como posso te ajudar?");
    expect(v["nina_lead"]).toContain("Últimas mensagens: (nenhuma)");
    expect(banco.tabelas["contato_identificadores"]).toContainEqual(
      expect.objectContaining({ tipo: "telefone", valor: TELEFONE }),
    );
    expect(registros()[0]!["conversa_id"]).not.toBe(CONVERSA_ANA);
  });

  it("sem Bearer, ou com outro: 401 e nada gravado", async () => {
    expect((await chamar("inicio", corpoInicio(), {})).status).toBe(401);
    expect((await chamar("inicio", corpoInicio(), { authorization: "Bearer outro" })).status).toBe(
      401,
    );
    expect((await chamar("inicio", corpoInicio(), { authorization: TOKEN })).status).toBe(401);
    expect(registros()).toHaveLength(0);
  });

  it("corpo inválido ou grande demais, depois de autenticar: despedida (200), nunca a ligação muda", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const corpo of [
      "{nao json",
      "[1,2]",
      corpoInicio({ conversation_id: undefined }),
      corpoInicio({ conversation_id: "a b c d e" }),
      corpoInicio({ lixo: "x".repeat(MAX_CORPO) }),
    ]) {
      const r = await chamar("inicio", corpo);
      expect(r.status).toBe(200);
      expect(r.corpo).toEqual(DESPEDIDA);
    }
    expect(registros()).toHaveLength(0);
  });

  it("recusa com despedida (200) outro agente, ligações fora de 'ativa', outro número e sem identidade", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const despede = async (corpo: unknown) => {
      const r = await chamar("inicio", corpo);
      expect(r.status).toBe(200);
      expect(r.corpo).toEqual(DESPEDIDA);
    };
    await despede(corpoInicio({ agent_id: "agent_outro" }));
    await despede(corpoInicio({ agent_id: 42 }));
    await despede(
      corpoInicio({
        sip_headers: { "x-wa-meta-user-id": BSUID, "x-wa-meta-phone-number-id": "999" },
      }),
    );
    await despede(corpoInicio({ sip_headers: {}, caller_id: "anonimo" }));
    estado.conexao = conexao({
      parametros: { ligacoes: ligacoes({ situacao: "com_pendencias" }) },
    });
    await despede(corpoInicio());
    expect(registros()).toHaveLength(0);
  });

  it("os limites da conta (todos os agentes): o início confere e se despede; o pós-chamada não confere (Sol, PR #26)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    banco.tabelas["configuracao"]![0]!["ligacoes_simultaneas"] = 1;
    await chamar("inicio", corpoInicio({ conversation_id: "conv_conta_1" }));
    const { corpo } = await chamar("inicio", corpoInicio({ conversation_id: "conv_conta_2" }));
    expect((corpo["dynamic_variables"] as Variaveis)["nina_saudacao"]).toBe(SAUDACAO_RECUSADA);
    expect(ligacoesGravadas()).toHaveLength(1);
    const inicios = banco.rpcs.filter((r) => r.nome === "ligacao_iniciar");
    expect(inicios.every((r) => r.args["p_conferir_conta"] === true)).toBe(true);
  });

  it("limite por contato (o da configuração): a ligacao_iniciar recusa e o início se despede", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    banco.tabelas["configuracao"]![0]!["ligacoes_por_contato"] = 2;
    expect((await chamar("inicio", corpoInicio({ conversation_id: "conv_nova_1" }))).status).toBe(
      200,
    );
    expect((await chamar("inicio", corpoInicio({ conversation_id: "conv_nova_2" }))).status).toBe(
      200,
    );
    const { status, corpo } = await chamar(
      "inicio",
      corpoInicio({ conversation_id: "conv_nova_3" }),
    );
    expect(status).toBe(200);
    expect(corpo["dynamic_variables"]).toEqual({
      nina_saudacao: SAUDACAO_LIMITE,
      nina_contexto: CONTEXTO_ENCERRAR,
      nina_lead: "",
      secret__nina_sessao: "",
    });
    expect(ligacoesGravadas()).toHaveLength(2);
    // a mesma ligação de novo (reenvio do início) não conta a si mesma
    expect((await chamar("inicio", corpoInicio({ conversation_id: "conv_nova_1" }))).status).toBe(
      200,
    );
  });

  it("falha do banco depois de autenticar: 200 genérico, com a sessão pela conversa da ElevenLabs e sem dado no log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    banco.respostaRpc = () => ({
      data: null,
      error: { code: "XX000", message: `falhou ${TELEFONE}` },
    });
    const { status, corpo } = await chamar("inicio", corpoInicio());
    expect(status).toBe(200);
    const v = corpo["dynamic_variables"] as Variaveis;
    expect(v).toMatchObject({
      nina_saudacao: "Oi! Aqui é a Nina. Como posso te ajudar?",
      nina_contexto: "",
      nina_lead: "",
    });
    await expect(lerSessao(TOKEN, v["secret__nina_sessao"], AGORA_S)).resolves.toMatchObject({
      conversaId: CONVERSA_PENDENTE,
      conversaEleven: "conv_ligacao_1",
    });
    const escrito = JSON.stringify(log.mock.calls);
    expect(escrito).toContain("ligacao_inicio");
    expect(escrito).toContain("ligacao_iniciar:XX000");
    expect(escrito).not.toContain(TELEFONE);
    expect(escrito).not.toContain(BSUID);
    expect(escrito).not.toContain("conv_ligacao_1");
  });

  it("D26: banco mais lento que 4 s: 200 genérico no teto, com a sessão pela conversa da ElevenLabs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      // a ligacao_iniciar nunca responde
      banco.respostaRpc = () => new Promise(() => undefined) as never;
      let resposta: Response | null = null;
      void processarLigacao(pedido("inicio", corpoInicio(), AUT), CONEXAO, "inicio", {
        agoraMs: AGORA_MS,
      }).then((r) => (resposta = r));
      await vi.advanceTimersByTimeAsync(3999);
      expect(resposta).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      // a sessão é assinada com o WebCrypto (fora dos relógios falsos)
      for (let i = 0; i < 100 && !resposta; i++) await new Promise((r) => setImmediate(r));
      expect(resposta).not.toBeNull();
      const r = resposta as unknown as Response;
      expect(r.status).toBe(200);
      const v = ((await r.json()) as Record<string, unknown>)["dynamic_variables"] as Variaveis;
      expect(v).toMatchObject({
        nina_saudacao: "Oi! Aqui é a Nina. Como posso te ajudar?",
        nina_contexto: "",
        nina_lead: "",
      });
      await expect(lerSessao(TOKEN, v["secret__nina_sessao"], AGORA_S)).resolves.toMatchObject({
        conversaId: CONVERSA_PENDENTE,
        conversaEleven: "conv_ligacao_1",
      });
      expect(JSON.stringify(log.mock.calls)).toContain("tempo_esgotado");
    } finally {
      vi.useRealTimers();
    }
  });

  it("D32: a leitura da conexão pendurada: 503 no teto, contado desde a chegada", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      estado.esperaConexao = new Promise(() => undefined);
      let resposta: Response | null = null;
      void processarLigacao(pedido("inicio", corpoInicio(), AUT), CONEXAO, "inicio", {
        agoraMs: AGORA_MS,
      }).then((r) => (resposta = r));
      await vi.advanceTimersByTimeAsync(3999);
      expect(resposta).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      const r = resposta as unknown as Response;
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ erro: "indisponivel" });
      expect(JSON.stringify(log.mock.calls)).toContain("tempo_esgotado");
      expect(registros()).toHaveLength(0);
    } finally {
      estado.esperaConexao = null;
      vi.useRealTimers();
    }
  });

  it("D32: a conexão gasta parte do teto; o banco tem só o resto, e o estouro depois de autenticar dá o 200 genérico", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      estado.esperaConexao = new Promise((r) => setTimeout(r, 3000));
      banco.respostaRpc = () => new Promise(() => undefined) as never;
      let resposta: Response | null = null;
      void processarLigacao(pedido("inicio", corpoInicio(), AUT), CONEXAO, "inicio", {
        agoraMs: AGORA_MS,
      }).then((r) => (resposta = r));
      await vi.advanceTimersByTimeAsync(3999);
      expect(resposta).toBeNull();
      // 4 s no total, não 3 s + 4 s
      await vi.advanceTimersByTimeAsync(1);
      for (let i = 0; i < 100 && !resposta; i++) await new Promise((r) => setImmediate(r));
      const r = resposta as unknown as Response;
      expect(r.status).toBe(200);
      const v = ((await r.json()) as Record<string, unknown>)["dynamic_variables"] as Variaveis;
      expect(v["nina_saudacao"]).toBe("Oi! Aqui é a Nina. Como posso te ajudar?");
      expect(v["secret__nina_sessao"]).not.toBe("");
    } finally {
      estado.esperaConexao = null;
      vi.useRealTimers();
    }
  });

  it("D32: o Bearer errado continua 401, mesmo com a conexão lenta dentro do teto", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      estado.esperaConexao = new Promise((r) => setTimeout(r, 1000));
      let resposta: Response | null = null;
      void processarLigacao(
        pedido("inicio", corpoInicio(), { authorization: "Bearer errado" }),
        CONEXAO,
        "inicio",
        { agoraMs: AGORA_MS },
      ).then((r) => (resposta = r));
      await vi.advanceTimersByTimeAsync(1000);
      expect((resposta as unknown as Response).status).toBe(401);
    } finally {
      estado.esperaConexao = null;
      vi.useRealTimers();
    }
  });

  it("D26: o banco dentro do teto responde normal", async () => {
    const { status, corpo } = await processarLigacao(
      pedido("inicio", corpoInicio(), AUT),
      CONEXAO,
      "inicio",
      { agoraMs: AGORA_MS, tetoInicioMs: 4000 },
    ).then(async (r) => ({ status: r.status, corpo: (await r.json()) as Record<string, unknown> }));
    expect(status).toBe(200);
    expect((corpo["dynamic_variables"] as Variaveis)["secret__nina_sessao"]).not.toBe("");
  });
});

describe("início: o worker e a conversa com a equipe", () => {
  it("o início acorda o worker (ele confere as presas durante a ligação)", async () => {
    await chamar("inicio", corpoInicio());
    // o toque sai em segundo plano (toques de testes anteriores podem chegar junto)
    await vi.waitFor(() =>
      expect(banco.rpcs.filter((r) => r.nome === "acordar_motor").length).toBeGreaterThanOrEqual(1),
    );
  });

  it("com a conversa já com a equipe, o lead da voz diz que a equipe manda o que for por escrito", async () => {
    conversaAna()["modo"] = "humano";
    const { corpo } = await chamar("inicio", corpoInicio());
    expect((corpo["dynamic_variables"] as Variaveis)["nina_lead"]).toContain(
      "Esta conversa já está com a equipe",
    );
  });
});

describe("equipe", () => {
  it("a sessão da resposta degradada (teto estourado) passa para a equipe assim que a ligação está gravada", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { assinarSessao } = await import("./sessao");
    // a ligação gravada pelo trabalho de banco que seguiu depois da resposta
    await chamar("inicio", corpoInicio());
    const degradada = await assinarSessao(TOKEN, CONVERSA_PENDENTE, "conv_ligacao_1", AGORA_S, 60);
    const r = await chamar("equipe", "", { ...AUT, "X-Nina-Sessao": degradada });
    expect(r).toMatchObject({ status: 200, corpo: { ok: true, mensagem: MENSAGEM_EQUIPE } });
    expect(conversaAna()).toMatchObject({ modo: "humano" });
  });

  it("ligação de saída: a sessão com o id provisório acha a ligação pelo id dela, mesmo já confirmada", async () => {
    const { assinarSessao } = await import("./sessao");
    const SAIDA = "5a1da000-0000-4000-8000-0000000000b2";
    ligacoesGravadas().push({
      id: SAIDA,
      conversa_id: CONVERSA_ANA,
      mensagem_id: null,
      conexao_id: CONEXAO,
      agente_id: "ag_nina",
      direcao: "saida",
      status: "em_andamento",
      id_externo: "conv_saida_confirmada",
      iniciada_em: new Date(AGORA_MS).toISOString(),
      passou_equipe: false,
    });
    const s = await assinarSessao(TOKEN, CONVERSA_ANA, `saida-${SAIDA}`, AGORA_S, 600);
    const r = await chamar("equipe", "", { ...AUT, "X-Nina-Sessao": s });
    expect(r).toMatchObject({ status: 200, corpo: { ok: true, mensagem: MENSAGEM_EQUIPE } });
    expect(ligacoesGravadas()[0]).toMatchObject({ passou_equipe: true });
    expect(conversaAna()).toMatchObject({ modo: "humano" });
  });

  async function sessao(): Promise<string> {
    const { corpo } = await chamar("inicio", corpoInicio());
    return (corpo["dynamic_variables"] as Variaveis)["secret__nina_sessao"]!;
  }

  it("passa a conversa da sessão para a equipe pela ligacao_passar_para_equipe, uma vez só", async () => {
    const s = await sessao();
    const cab = { ...AUT, "X-Nina-Sessao": s };
    const r1 = await chamar("equipe", "", cab);
    expect(r1).toMatchObject({ status: 200, corpo: { ok: true, mensagem: MENSAGEM_EQUIPE } });
    expect(conversaAna()).toMatchObject({
      modo: "humano",
      motivo_humano: "nina_passou",
      responder_apos: null,
    });
    expect(conversaAna()["aguardando_humano_desde"]).toEqual(expect.any(String));
    expect(ligacoesGravadas()[0]).toMatchObject({ passou_equipe: true });
    const r2 = await chamar("equipe", { qualquer: "coisa" }, cab);
    expect(r2.status).toBe(200);
    expect(banco.tabelas["conversa_eventos"]).toEqual([
      expect.objectContaining({ conversa_id: CONVERSA_ANA, tipo: "passou", motivo: "nina_passou" }),
    ]);
    expect(
      banco.rpcs.filter((r) => r.nome === "ligacao_passar_para_equipe").map((r) => r.args),
    ).toEqual([
      { p_ligacao: ligacoesGravadas()[0]!["id"] },
      { p_ligacao: ligacoesGravadas()[0]!["id"] },
    ]);
  });

  it("sem Bearer ou sem sessão válida: 401 e nada muda", async () => {
    const s = await sessao();
    expect((await chamar("equipe", "", { "X-Nina-Sessao": s })).status).toBe(401);
    expect((await chamar("equipe", "", AUT)).status).toBe(401);
    expect((await chamar("equipe", "", { ...AUT, "X-Nina-Sessao": "" })).status).toBe(401);
    expect((await chamar("equipe", "", { ...AUT, "X-Nina-Sessao": `${s}0` })).status).toBe(401);
    // o agente dura até 30 min: a sessão vence depois disso mais a folga
    const vencida = await processarLigacao(
      pedido("equipe", "", { ...AUT, "X-Nina-Sessao": s }),
      CONEXAO,
      "equipe",
      { agoraMs: AGORA_MS + 36 * 60_000 },
    );
    expect(vencida.status).toBe(401);
    expect(conversaAna()["modo"]).toBe("nina");
  });

  it("L40: a sessão vale a duração máxima do agente: o lead pede uma pessoa aos 28 min de uma ligação de 30", async () => {
    const s = await sessao();
    const r = await processarLigacao(
      pedido("equipe", "", { ...AUT, "X-Nina-Sessao": s }),
      CONEXAO,
      "equipe",
      { agoraMs: AGORA_MS + 28 * 60_000 },
    );
    expect(r.status).toBe(200);
    expect(conversaAna()["modo"]).toBe("humano");
  });

  it("L40: o agente de 10 min tem a sessão de 10 min mais a folga", async () => {
    const { corpo } = await chamar("inicio", corpoInicio({ agent_id: AGENTE_VENDAS }));
    const s = (corpo["dynamic_variables"] as Variaveis)["secret__nina_sessao"]!;
    const depois = await processarLigacao(
      pedido("equipe", "", { ...AUT, "X-Nina-Sessao": s }),
      CONEXAO,
      "equipe",
      { agoraMs: AGORA_MS + 16 * 60_000 },
    );
    expect(depois.status).toBe(401);
  });

  it("a ligação da sessão sumiu: 503", async () => {
    const s = await sessao();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    banco.tabelas["ligacoes"] = [];
    expect((await chamar("equipe", "", { ...AUT, "X-Nina-Sessao": s })).status).toBe(503);
    expect(conversaAna()["modo"]).toBe("nina");
  });

  it("corpo que não é JSON: 400", async () => {
    const s = await sessao();
    expect((await chamar("equipe", "nao json", { ...AUT, "X-Nina-Sessao": s })).status).toBe(400);
    expect(conversaAna()["modo"]).toBe("nina");
  });
});

describe("pós-chamada", () => {
  function evento(extra: Record<string, unknown> = {}, tipo = "post_call_transcription") {
    return {
      type: tipo,
      event_timestamp: AGORA_S + 200,
      data: {
        agent_id: AGENTE,
        conversation_id: "conv_ligacao_1",
        status: "done",
        transcript: [
          { role: "agent", message: "[excited] Oi, Ana!", time_in_call_secs: 0 },
          { role: "user", message: "Quero saber o preço.", time_in_call_secs: 3 },
        ],
        metadata: {
          start_time_unix_secs: AGORA_S,
          call_duration_secs: 192,
          termination_reason: "Call ended by remote party",
          cost: 812,
          phone_call: { external_number: `+${TELEFONE}` },
        },
        analysis: { transcript_summary: "Ana quer saber o preço." },
        ...extra,
      },
    };
  }

  async function postar(corpo: unknown, segredo = HMAC, t = AGORA_S + 200) {
    const cru = typeof corpo === "string" ? corpo : JSON.stringify(corpo);
    const assinatura = await assinarPosChamada(segredo, cru, t);
    return chamar("pos-chamada", cru, { "ElevenLabs-Signature": assinatura });
  }

  const FALAS = [
    { papel: "nina", texto: "Oi, Ana!", segundos: 0 },
    { papel: "lead", texto: "Quero saber o preço.", segundos: 3 },
  ];

  it("grava o fim pela ligacao_encerrar: status, duração, resumo, falas sem marcas, motivo e custo", async () => {
    await chamar("inicio", corpoInicio());
    const r = await postar(evento());
    expect(r).toMatchObject({ status: 200, corpo: { ok: true } });
    expect(ligacoesGravadas()).toEqual([
      expect.objectContaining({
        status: "concluida",
        duracao_s: 192,
        resumo: "Ana quer saber o preço.",
        transcricao: FALAS,
        motivo_fim: "client_ended",
        custo_creditos: 812,
        encerrada_em: new Date((AGORA_S + 192) * 1000).toISOString(),
      }),
    ]);
    // o rótulo na mensagem e na prévia (a ligação é a última mensagem)
    expect(registros()).toEqual([expect.objectContaining({ texto: "Ligação · 3 min 12 s" })]);
    expect(conversaAna()["ultima_mensagem_preview"]).toBe("Ligação · 3 min 12 s");

    expect((await postar(evento())).status).toBe(200);
    expect(ligacoesGravadas()).toHaveLength(1);
    expect(banco.tabelas["conversa_eventos"]).toHaveLength(0);
    expect(conversaAna()["modo"]).toBe("nina");
  });

  it("assinatura errada ou ausente: 401 e nada muda", async () => {
    await chamar("inicio", corpoInicio());
    expect((await postar(evento(), "outro-segredo")).status).toBe(401);
    expect((await postar(evento(), HMAC, AGORA_S - 3 * 3600)).status).toBe(401);
    expect((await chamar("pos-chamada", JSON.stringify(evento()), {})).status).toBe(401);
    expect(ligacoesGravadas()[0]!["status"]).toBe("em_andamento");
  });

  it("corpo inválido (assinado): 400", async () => {
    expect((await postar("{nao json")).status).toBe(400);
    expect((await postar({ type: "post_call_transcription" })).status).toBe(400);
    expect((await postar(evento({ conversation_id: 42 }))).status).toBe(400);
  });

  it("outro tipo, ou outro agente sem a ligação gravada: 200 ignorado, sem criar nada", async () => {
    await chamar("inicio", corpoInicio());
    expect((await postar(evento({}, "post_call_audio"))).corpo).toEqual({ ignorado: true });
    expect(ligacoesGravadas()[0]!["status"]).toBe("em_andamento");
    expect(
      await postar(evento({ agent_id: "agent_outro", conversation_id: "conv_de_outro_1" })),
    ).toMatchObject({ status: 200, corpo: { ignorado: true } });
    expect(ligacoesGravadas()).toHaveLength(1);
  });

  it("L39: o pós-chamada de uma ligação longa (1 MB) cabe; acima do teto, 413", async () => {
    await chamar("inicio", corpoInicio());
    const transcript = Array.from({ length: 400 }, (_, i) => ({
      role: i % 2 ? "user" : "agent",
      message: `Fala ${i}`,
      time_in_call_secs: i * 4,
      // os metadados de cada fala, que a ElevenLabs manda junto
      llm_usage: { detalhe: "x".repeat(2_500) },
    }));
    const grande = evento({ transcript });
    expect(JSON.stringify(grande).length).toBeGreaterThan(1_000_000);
    expect((await postar(grande)).corpo).toEqual({ ok: true });
    expect(ligacoesGravadas()[0]).toMatchObject({ status: "concluida" });
    const r = await chamar("pos-chamada", "x".repeat(MAX_CORPO_POS_CHAMADA + 1), {
      "ElevenLabs-Signature": `t=${AGORA_S},v0=${"0".repeat(64)}`,
    });
    expect(r.status).toBe(413);
  });

  it("cabeçalho de assinatura sem formato ou fora do horário: 401 antes de ler o corpo", async () => {
    // o corpo grande demais daria 413 se fosse lido: o 401 mostra que o cabeçalho vem antes
    const grande = "x".repeat(MAX_CORPO_POS_CHAMADA + 1);
    for (const assinatura of [
      "",
      "t=1,v0=00",
      `t=${AGORA_S - 3600},v0=${"0".repeat(64)}`,
      `t=${AGORA_S},v0=zz`,
    ]) {
      const r = await chamar("pos-chamada", grande, { "ElevenLabs-Signature": assinatura });
      expect(r.status).toBe(401);
    }
  });

  it("L38: a ligação de um agente que foi apagado no meio sai de 'em andamento'", async () => {
    await chamar("inicio", corpoInicio({ agent_id: AGENTE_VENDAS }));
    banco.tabelas["ligacao_agentes"] = banco.tabelas["ligacao_agentes"]!.filter(
      (a) => a["id"] !== "ag_vendas",
    );
    expect((await postar(evento({ agent_id: AGENTE_VENDAS }))).corpo).toEqual({ ok: true });
    expect(ligacoesGravadas()[0]).toMatchObject({ status: "concluida", duracao_s: 192 });
  });

  it("L38: o pós-chamada que chega com a desativação em curso também encerra a ligação", async () => {
    await chamar("inicio", corpoInicio());
    // a desmontagem marcou com_pendencias, apagou o agente do tronco e zerou o id_externo da linha
    estado.conexao = conexao({
      parametros: {
        wabaId: "waba1",
        ligacoes: ligacoes({
          situacao: "com_pendencias",
          eleven: { ...ligacoes().eleven, agenteId: null, troncoId: null },
          pendencias: ["webhook", "segredo"],
        }),
      },
    });
    for (const a of banco.tabelas["ligacao_agentes"]!) a["id_externo"] = null;
    expect((await postar(evento())).corpo).toEqual({ ok: true });
    expect(ligacoesGravadas()[0]).toMatchObject({ status: "concluida" });
  });

  it("de outro agente desta conta (uma linha de ligacao_agentes) vale", async () => {
    await chamar("inicio", corpoInicio({ agent_id: AGENTE_VENDAS }));
    expect((await postar(evento({ agent_id: AGENTE_VENDAS }))).corpo).toEqual({ ok: true });
    expect(ligacoesGravadas()[0]!["status"]).toBe("concluida");
  });

  it("sem a ligação (o início falhou): ligacao_iniciar pelo telefone, no começo, e encerra", async () => {
    const r = await postar(evento());
    expect(r.status).toBe(200);
    // a ligação que já aconteceu não é recusada pelos limites da conta (a versão de 7 argumentos)
    expect(banco.rpcs.find((x) => x.nome === "ligacao_iniciar")?.args).not.toHaveProperty(
      "p_conferir_conta",
    );
    // e, concluída, o worker é acordado: a rodada que esperava a ligação manda o combinado
    expect(banco.rpcs.map((x) => x.nome)).toEqual([
      "ligacao_iniciar",
      "ligacao_encerrar",
      "ligacao_rearmar_depois",
      "motor_endereco",
      "acordar_motor",
    ]);
    expect(ligacoesGravadas()).toEqual([
      expect.objectContaining({
        id_externo: "conv_ligacao_1",
        agente_id: "ag_nina",
        status: "concluida",
        transcricao: FALAS,
        iniciada_em: new Date(AGORA_MS).toISOString(),
      }),
    ]);
    expect(registros()).toEqual([
      expect.objectContaining({
        texto: "Ligação · 3 min 12 s",
        momento: new Date(AGORA_MS).toISOString(),
      }),
    ]);
    expect((await postar(evento())).status).toBe(200);
    expect(ligacoesGravadas()).toHaveLength(1);
  });

  it("a ligação que o início recusou (a despedida): o pós-chamada não grava nem arma a Nina (Opus, PR #26)", async () => {
    const r = await postar(
      evento({
        conversation_initiation_client_data: {
          dynamic_variables: { nina_contexto: CONTEXTO_ENCERRAR, nina_saudacao: SAUDACAO_RECUSADA },
        },
      }),
    );
    expect(r.corpo).toEqual({ ignorado: true });
    expect(ligacoesGravadas()).toHaveLength(0);
    expect(banco.rpcs.map((x) => x.nome)).not.toContain("ligacao_iniciar");
  });

  it("sem a ligação e sem identificador: ignora", async () => {
    const r = await postar(evento({ metadata: { call_duration_secs: 10 } }));
    expect(r.corpo).toEqual({ ignorado: true });
    expect(ligacoesGravadas()).toHaveLength(0);
  });

  it("sem a ligação e acima do limite por contato: ignora, sem gravar", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    banco.tabelas["configuracao"]![0]!["ligacoes_por_contato"] = 1;
    await chamar("inicio", corpoInicio({ caller_id: undefined, conversation_id: "conv_a1" }));
    banco.tabelas["contato_identificadores"]!.push({
      contato_id: "k_ana",
      tipo: "telefone",
      valor: TELEFONE,
    });
    expect((await postar(evento())).corpo).toEqual({ ignorado: true });
    expect(ligacoesGravadas()).toHaveLength(1);
  });

  it("a ferramenta no transcript garante a passagem (uma vez só por ligação)", async () => {
    await chamar("inicio", corpoInicio());
    const transcript = [
      { role: "user", message: "Quero falar com uma pessoa.", time_in_call_secs: 2 },
      {
        role: "agent",
        message: "",
        tool_calls: [{ tool_name: "nina_passar_para_equipe", params_as_json: "{}" }],
      },
      { role: "agent", message: "Avisei a equipe. Pode desligar aí.", time_in_call_secs: 9 },
    ];
    expect((await postar(evento({ transcript }))).status).toBe(200);
    expect(conversaAna()).toMatchObject({ modo: "humano", motivo_humano: "nina_passou" });
    // a equipe devolve; o reenvio do pós-chamada não passa de novo (D24, ligacoes.passou_equipe)
    Object.assign(conversaAna(), { modo: "nina", motivo_humano: null });
    expect((await postar(evento({ transcript }))).status).toBe(200);
    expect(conversaAna()["modo"]).toBe("nina");
    expect(banco.tabelas["conversa_eventos"]).toHaveLength(1);
    expect(ligacoesGravadas()[0]!["transcricao"]).toEqual([
      { papel: "lead", texto: "Quero falar com uma pessoa.", segundos: 2 },
      { papel: "nina", texto: "Avisei a equipe. Pode desligar aí.", segundos: 9 },
    ]);
  });

  it("status failed e call_initiation_failure: não completada", async () => {
    await chamar("inicio", corpoInicio());
    await postar({
      type: "call_initiation_failure",
      data: { agent_id: AGENTE, conversation_id: "conv_ligacao_1" },
    });
    expect(ligacoesGravadas()[0]).toMatchObject({
      status: "nao_completada",
      motivo_fim: "nao_atendida",
    });
    expect(registros()[0]!["texto"]).toBe("Ligação não completada");

    await chamar("inicio", corpoInicio({ conversation_id: "conv_ligacao_2" }));
    await postar(evento({ conversation_id: "conv_ligacao_2", status: "failed" }));
    expect(ligacoesGravadas()[1]).toMatchObject({ status: "nao_completada" });
  });

  it("a ligação que não completou vira aviso no chat, uma vez, e acorda o worker que o manda", async () => {
    await chamar("inicio", corpoInicio());
    banco.rpcs.length = 0;
    await postar({
      type: "call_initiation_failure",
      data: { agent_id: AGENTE, conversation_id: "conv_ligacao_1" },
    });
    const avisos = banco.rpcs.filter((r) => r.nome === "ligacao_avisar_falha");
    expect(avisos).toHaveLength(1);
    expect(String(avisos[0]!.args["p_texto"])).toMatch(/^Oi, Ana! Vi que você me ligou/);
    expect(banco.rpcs.filter((r) => r.nome === "acordar_motor")).toHaveLength(1);
    // o mesmo aviso de novo (reenvio): o banco não avisa duas vezes, e o worker não é acordado
    banco.rpcs.length = 0;
    await postar({
      type: "call_initiation_failure",
      data: { agent_id: AGENTE, conversation_id: "conv_ligacao_1" },
    });
    expect(banco.rpcs.filter((r) => r.nome === "acordar_motor")).toHaveLength(0);
  });

  it("o aviso que falha no banco: 500, para a ElevenLabs reenviar; no reenvio, avisa", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await chamar("inicio", corpoInicio());
    const original = banco.respostaRpc;
    banco.respostaRpc = (nome, args) =>
      nome === "ligacao_avisar_falha"
        ? { data: null, error: { code: "XX000", message: "x" } }
        : original(nome, args);
    const falha = {
      type: "call_initiation_failure",
      data: { agent_id: AGENTE, conversation_id: "conv_ligacao_1" },
    };
    expect((await postar(falha)).status).toBe(500);
    banco.respostaRpc = original;
    expect((await postar(falha)).corpo).toEqual({ ok: true });
    expect(ligacoesGravadas()[0]!["aviso_falha_em"]).toEqual(expect.any(String));
    expect(JSON.stringify(log.mock.calls)).not.toContain("conv_ligacao_1");
  });

  it("pós-chamada de uma ligação de saída sem o início: ignorado, sem criar contato", async () => {
    const r = await postar(
      evento({
        metadata: {
          call_duration_secs: 60,
          phone_call: { direction: "outbound", external_number: "+55 11 98888-7777" },
        },
      }),
    );
    expect(r.corpo).toEqual({ ignorado: true });
    expect(banco.rpcs.filter((x) => x.nome === "ligacao_iniciar")).toHaveLength(0);
  });

  const SAIDA = "5a1da000-0000-4000-8000-0000000000a1";
  function ligacaoDeSaida(idExterno = `saida-${SAIDA}`) {
    const linha = {
      id: SAIDA,
      conversa_id: CONVERSA_ANA,
      mensagem_id: null,
      conexao_id: CONEXAO,
      agente_id: "ag_nina",
      direcao: "saida",
      status: "em_andamento",
      id_externo: idExterno,
      iniciada_em: new Date(AGORA_MS).toISOString(),
      encerrada_em: null,
      duracao_s: null,
      motivo_fim: null,
      resumo: null,
      transcricao: [],
      passou_equipe: false,
      custo_creditos: null,
    };
    ligacoesGravadas().push(linha);
    return linha;
  }

  it("ligação de saída cujo pós-chamada chega antes da confirmação: confirma pela nina_ligacao e fecha", async () => {
    const linha = ligacaoDeSaida();
    const r = await postar(
      evento({
        metadata: {
          start_time_unix_secs: AGORA_S,
          call_duration_secs: 60,
          phone_call: { direction: "outbound", external_number: `+${TELEFONE}` },
        },
        conversation_initiation_client_data: { dynamic_variables: { nina_ligacao: SAIDA } },
      }),
    );
    expect(r).toMatchObject({ status: 200, corpo: { ok: true } });
    expect(linha).toMatchObject({
      id_externo: "conv_ligacao_1",
      status: "concluida",
      duracao_s: 60,
    });
    // nada de criar contato ou ligação de entrada
    expect(banco.rpcs.filter((x) => x.nome === "ligacao_iniciar")).toHaveLength(0);
    expect(ligacoesGravadas()).toHaveLength(1);
  });

  it("call_initiation_failure de uma saída ainda provisória: confirma pela nina_ligacao e fecha, sem aviso (Opus, PR #24)", async () => {
    const linha = ligacaoDeSaida();
    const r = await postar({
      type: "call_initiation_failure",
      event_timestamp: AGORA_S + 30,
      data: {
        agent_id: AGENTE,
        conversation_id: "conv_ligacao_1",
        conversation_initiation_client_data: { dynamic_variables: { nina_ligacao: SAIDA } },
      },
    });
    expect(r).toMatchObject({ status: 200, corpo: { ok: true } });
    expect(linha).toMatchObject({ id_externo: "conv_ligacao_1", status: "nao_completada" });
    expect(banco.rpcs.filter((x) => x.nome === "ligacao_avisar_falha")).toHaveLength(0);
  });

  it("call_initiation_failure sem a nina_ligacao no corpo: lê a conversa na ElevenLabs", async () => {
    const linha = ligacaoDeSaida();
    const busca = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        conversation_initiation_client_data: { dynamic_variables: { nina_ligacao: SAIDA } },
      }),
    }));
    vi.stubGlobal("fetch", busca);
    {
      const r = await postar({
        type: "call_initiation_failure",
        event_timestamp: AGORA_S + 30,
        data: { agent_id: AGENTE, conversation_id: "conv_ligacao_1" },
      });
      expect(r).toMatchObject({ status: 200, corpo: { ok: true } });
      expect(linha).toMatchObject({ id_externo: "conv_ligacao_1", status: "nao_completada" });
      expect(String((busca.mock.calls[0] as unknown[])[0])).toContain(
        "/v1/convai/conversations/conv_ligacao_1",
      );
    }
  });

  it("ligação de saída já confirmada: o pós-chamada fecha pelo id da conversa, sem confirmar de novo", async () => {
    const linha = ligacaoDeSaida("conv_ligacao_1");
    await postar(
      evento({
        metadata: {
          start_time_unix_secs: AGORA_S,
          call_duration_secs: 30,
          phone_call: { direction: "outbound", external_number: `+${TELEFONE}` },
        },
        conversation_initiation_client_data: { dynamic_variables: { nina_ligacao: SAIDA } },
      }),
    );
    expect(linha).toMatchObject({ status: "concluida" });
    expect(banco.rpcs.filter((x) => x.nome === "ligacao_saida_confirmar")).toHaveLength(0);
  });

  it("nina_ligacao que não é uuid, ou de uma ligação de entrada: ignorado, sem confirmar", async () => {
    const r = await postar(
      evento({
        metadata: { phone_call: { direction: "outbound", external_number: `+${TELEFONE}` } },
        conversation_initiation_client_data: { dynamic_variables: { nina_ligacao: "lig-x" } },
      }),
    );
    expect(r.corpo).toEqual({ ignorado: true });
    expect(banco.rpcs.filter((x) => x.nome === "ligacao_saida_confirmar")).toHaveLength(0);
  });

  it("o pós-chamada de 0 s com status done vira não completada (como nas presas)", async () => {
    await chamar("inicio", corpoInicio());
    await postar(
      evento({
        metadata: { start_time_unix_secs: AGORA_S, call_duration_secs: 0, phone_call: {} },
      }),
    );
    expect(ligacoesGravadas()[0]).toMatchObject({ status: "nao_completada" });
  });

  it("a passagem para a equipe acontece antes do fechamento", async () => {
    await chamar("inicio", corpoInicio());
    banco.rpcs.length = 0;
    await postar(
      evento({
        transcript: [
          {
            role: "agent",
            message: "Já chamo a equipe.",
            time_in_call_secs: 3,
            tool_calls: [{ tool_name: "nina_passar_para_equipe" }],
          },
        ],
      }),
    );
    const nomes = banco.rpcs.map((x) => x.nome);
    expect(nomes.indexOf("ligacao_passar_para_equipe")).toBeGreaterThanOrEqual(0);
    expect(nomes.indexOf("ligacao_passar_para_equipe")).toBeLessThan(
      nomes.indexOf("ligacao_encerrar"),
    );
  });

  it("o rearme que falha no banco: 500, para o reenvio repetir", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await chamar("inicio", corpoInicio());
    const original = banco.respostaRpc;
    banco.respostaRpc = (nome, args) =>
      nome === "ligacao_rearmar_depois"
        ? { data: null, error: { code: "XX000", message: "x" } }
        : original(nome, args);
    expect((await postar(evento())).status).toBe(500);
    banco.respostaRpc = original;
    expect((await postar(evento())).corpo).toEqual({ ok: true });
  });

  it("a ligação concluída não pede aviso", async () => {
    await chamar("inicio", corpoInicio());
    await postar(evento());
    expect(banco.rpcs.filter((r) => r.nome === "ligacao_avisar_falha")).toHaveLength(0);
  });

  it("call_initiation_failure sem a ligação ou depois da transcrição não muda nada", async () => {
    const falha = {
      type: "call_initiation_failure",
      data: { agent_id: AGENTE, conversation_id: "conv_x1234" },
    };
    expect((await postar(falha)).corpo).toEqual({ ignorado: true });
    expect(ligacoesGravadas()).toHaveLength(0);
    await chamar("inicio", corpoInicio());
    await postar(evento());
    await postar({ ...falha, data: { ...falha.data, conversation_id: "conv_ligacao_1" } });
    expect(ligacoesGravadas()[0]).toMatchObject({ status: "concluida" });
    expect(registros()[0]!["texto"]).toBe("Ligação · 3 min 12 s");
  });

  it("falha do banco: 500 para a ElevenLabs reenviar, sem dado no log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    banco.respostaRpc = () => ({ data: null, error: { code: "XX000", message: "x" } });
    const r = await postar(evento());
    expect(r.status).toBe(500);
    const escrito = JSON.stringify(log.mock.calls);
    expect(escrito).not.toContain(TELEFONE);
    expect(escrito).not.toContain("conv_ligacao_1");
  });
});
