import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENTE_PADRAO,
  LIMITES_PADRAO,
  type AgenteVozPronto,
} from "@/features/mensageria/ligacoes/tipos";

import type { Fetch } from "./http";
import {
  apagarRecursoEleven,
  atualizarAgente,
  chaveLeAgente,
  conferirAcessoAgentes,
  criarAgente,
  criarFerramentaEquipe,
  criarSegredo,
  criarTronco,
  criarWebhookPosChamada,
  ligarPeloTronco,
  ligarSaidaDoTronco,
  ligarTroncoAoAgente,
  montarConfigAgente,
  montarSaidaDoTronco,
  montarPromptLigacao,
  MAX_PROMPT_BYTES,
  ORDEM_APAGAR,
  PERFIS,
  apontarTronco,
  CONTEXTO_VAZIO,
  promptDoAgente,
  tempoDaLigacao,
  TAG_AGENTE,
  VERSAO_AGENTE,
  type DadosAgente,
} from "./ligacoes-elevenlabs";

// Valores falsos, longos e únicos, para provar que nunca voltam no resultado nem vão ao log.
const CHAVE = "sk_teste_ligacoes_CHAVE_ELEVEN_1234567890";
const TOKEN = "token-ligacao-gerado-TOKEN_9876543210abc";
const SENHA = "senha-sip-da-meta-SENHA_ZXCVBNM_123456";
const HMAC = "wsec_hmac-do-webhook-HMAC_QWERTYUIOP";
const CONEXAO = "c0ffee00-0000-4000-8000-0000000000aa";

type Resposta = { status: number; corpo?: unknown; lancar?: Error };
type Chamada = { url: string; init: RequestInit };

function fetchFalso(...respostas: Resposta[]) {
  const chamadas: Chamada[] = [];
  let i = 0;
  const fetch: Fetch = async (url, init) => {
    chamadas.push({ url, init: init ?? {} });
    const r = respostas[Math.min(i, respostas.length - 1)];
    i += 1;
    if (!r) throw new Error("sem resposta configurada");
    if (r.lancar) throw r.lancar;
    const texto = r.corpo === undefined ? "" : JSON.stringify(r.corpo);
    return { status: r.status, text: async () => texto } as unknown as Response;
  };
  return { fetch, chamadas };
}

function cabecalhos(c: Chamada | undefined): Record<string, string> {
  return (c?.init.headers ?? {}) as Record<string, string>;
}
function corpo(c: Chamada | undefined): unknown {
  return JSON.parse(String(c?.init.body ?? "null"));
}
function semSegredos(valor: unknown) {
  const texto = JSON.stringify(valor);
  for (const s of [CHAVE, TOKEN, SENHA, HMAC]) expect(texto).not.toContain(s);
}

let espioes: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  espioes = [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
  ];
});
afterEach(() => {
  for (const e of espioes) {
    for (const chamada of e.mock.calls) semSegredos(chamada);
    e.mockRestore();
  }
});

const AGENTE: AgenteVozPronto = { ...AGENTE_PADRAO, vozId: "voz123ABC" };

const DADOS_AGENTE: DadosAgente = {
  agente: AGENTE,
  limites: LIMITES_PADRAO,
  recursos: {
    conexaoId: CONEXAO,
    urlInicio: `https://nina.exemplo.com/api/public/ligacoes/${CONEXAO}/inicio`,
    segredoId: "seg_1",
    webhookId: "wh_1",
    ferramentaId: "tool_1",
  },
  contexto: "Empresa e oferta: Consultoria de IA",
};

function comAgente(mudanca: Partial<AgenteVozPronto>): DadosAgente {
  return { ...DADOS_AGENTE, agente: { ...AGENTE, ...mudanca } };
}

describe("PERFIS e VERSAO_AGENTE (L13)", () => {
  it("cada perfil com o seu modelo de IA; fala e escuta no padrão da ElevenLabs", () => {
    expect(PERFIS).toEqual({
      recomendado: { llm: "gemini-3.5-flash" },
      rapido: { llm: "gemini-3.1-flash-lite" },
      caprichado: { llm: "claude-sonnet-4-6" },
    });
    expect(VERSAO_AGENTE).toBe(6);
  });

  it.each([
    ["recomendado", "gemini-3.5-flash"],
    ["rapido", "gemini-3.1-flash-lite"],
    ["caprichado", "claude-sonnet-4-6"],
  ] as const)("perfil %s: llm %s, sem model_id na fala e sem escuta fixa", (perfil, llm) => {
    const c = montarConfigAgente(comAgente({ perfil })).conversation_config;
    expect(c.agent.prompt.llm).toBe(llm);
    expect(c.tts).toEqual({ voice_id: "voz123ABC" });
    expect(c).not.toHaveProperty("asr");
  });
});

describe("montarConfigAgente (spec 2.5, L13 a L15)", () => {
  const a = montarConfigAgente(DADOS_AGENTE);

  it("nome, tag, idioma, saudação, placeholders, ferramenta e voz", () => {
    expect(a.name).toBe("Nina (ligações) c0ffee00 · Nina");
    expect(montarConfigAgente(comAgente({ nome: "  Vendas   SP " })).name).toBe(
      "Nina (ligações) c0ffee00 · Vendas SP",
    );
    expect(a.tags).toEqual([TAG_AGENTE]);
    expect(TAG_AGENTE).toBe("nina-ligacoes");
    const agente = a.conversation_config.agent;
    expect(agente.language).toBe("pt");
    expect(agente.first_message).toBe("{{nina_saudacao}}");
    expect(agente.dynamic_variables.dynamic_variable_placeholders).toEqual({
      nina_saudacao: "Oi! Aqui é a Nina. Como posso te ajudar?",
      nina_contexto: "",
      nina_lead: "",
    });
    expect(agente.prompt.llm).toBe("gemini-3.5-flash");
    expect(agente.prompt.tool_ids).toEqual(["tool_1"]);
    expect(agente.prompt.built_in_tools.end_call.params.system_tool_type).toBe("end_call");
    expect(agente.prompt.built_in_tools.end_call.description).toContain(
      "Não use por causa de silêncio",
    );
    expect(a.conversation_config.tts).toEqual({ voice_id: "voz123ABC" });
  });

  it("a saudação de reserva sai do modelo do agente, sem o nome", () => {
    const d = montarConfigAgente(comAgente({ saudacao: "Olá {nome}, aqui é a Bia da Loja!" }));
    expect(
      d.conversation_config.agent.dynamic_variables.dynamic_variable_placeholders.nina_saudacao,
    ).toBe("Olá, aqui é a Bia da Loja!");
  });

  it("duração e silêncio (L15) vêm do agente", () => {
    expect(a.conversation_config.conversation).toEqual({ max_duration_seconds: 600 });
    expect(a.conversation_config.turn).toEqual({ silence_end_call_timeout: 25 });
    const d = montarConfigAgente(comAgente({ duracaoMaxS: 1200, silencioS: 40 }));
    expect(d.conversation_config.conversation).toEqual({ max_duration_seconds: 1200 });
    expect(d.conversation_config.turn).toEqual({ silence_end_call_timeout: 40 });
  });

  it("os limites da conta: simultâneas e por dia vão ao agente; por contato, não (L19)", () => {
    expect(a.platform_settings.call_limits).toEqual({
      agent_concurrency_limit: 2,
      daily_limit: 100,
      bursting_enabled: false,
    });
    const d = montarConfigAgente({
      ...DADOS_AGENTE,
      limites: { simultaneas: 5, porDia: 300, porContato: 3 },
    });
    expect(d.platform_settings.call_limits).toEqual({
      agent_concurrency_limit: 5,
      daily_limit: 300,
      bursting_enabled: false,
    });
  });

  it("init com o segredo, pós-chamada sem áudio, sem gravar a voz", () => {
    const p = a.platform_settings;
    expect(p.summary_language).toBe("pt");
    expect(p.privacy).toEqual({ record_voice: false });
    expect(p.overrides.enable_conversation_initiation_client_data_from_webhook).toBe(true);
    expect(p.workspace_overrides.conversation_initiation_client_data_webhook).toEqual({
      url: DADOS_AGENTE.recursos.urlInicio,
      request_headers: { Authorization: { secret_id: "seg_1" } },
    });
    expect(p.workspace_overrides.webhooks).toEqual({
      post_call_webhook_id: "wh_1",
      events: ["transcript", "call_initiation_failure"],
      send_audio: false,
    });
    expect(p.auth.enable_auth).toBe(true);
  });

  it("o prompt do agente é o de montarPromptLigacao com o Contexto inteiro no fim (L14)", () => {
    expect(a.conversation_config.agent.prompt.prompt).toBe(
      promptDoAgente(AGENTE, DADOS_AGENTE.contexto),
    );
    expect(a.conversation_config.agent.prompt.prompt.startsWith(montarPromptLigacao(AGENTE))).toBe(
      true,
    );
  });
});

describe("montarPromptLigacao (L14, L15)", () => {
  const padrao = montarPromptLigacao(AGENTE_PADRAO);

  it("L42: sabe que já é uma ligação, adapta o Contexto escrito para texto e fala só português", () => {
    expect(padrao).toContain("Esta é uma ligação");
    expect(padrao).toContain(
      "Enquanto vocês falam, nunca convide a pessoa a te ligar nem a te mandar um áudio",
    );
    expect(padrao).toContain("foi escrito para o atendimento por mensagem no WhatsApp");
    expect(padrao).toContain(
      "Fale sempre em português do Brasil, do começo ao fim, inclusive na despedida",
    );
    expect(padrao.indexOf("Esta é uma ligação")).toBeLessThan(padrao.indexOf("Como falar"));
  });

  it("L44 e seção 8: nada no chat durante a ligação; o que vai por escrito ela mesma manda depois", () => {
    expect(padrao).toContain("Durante a ligação você não manda nada no chat");
    expect(padrao).toContain(
      "você mesma manda por mensagem neste WhatsApp assim que a ligação terminar",
    );
    expect(padrao).toContain("Nunca diga que já mandou");
    // a promessa antiga, que ninguém cumpria; a equipe só manda quando a conversa já está com ela
    expect(padrao).not.toContain(
      "Se a pessoa precisar de um link ou de um endereço, diga que a equipe",
    );
    expect(padrao).toContain("conversa já está com a equipe, diga que a equipe manda por mensagem");
    // a despedida da ligação recusada vale por cima do "encerre só com despedida clara"
    expect(padrao).toContain("disser que esta ligação não continua, siga ele");
  });

  it("seção 8: as regras de fala das ligações reais, em termos neutros (nada da demonstração)", () => {
    for (const trecho of [
      "no máximo 2 frases curtas",
      "No máximo uma pergunta por fala",
      "veja se a pessoa já respondeu",
      "pode vir errada",
      "Tudo o que você escreve vira voz",
      "nunca diga nem escreva o nome delas",
      "Seu tom acompanha o da pessoa",
      "corrija na hora com leveza",
      "sem fazer conta de cabeça",
      "não peguei, pode repetir?",
      "encerre só quando a pessoa se despedir com clareza",
      "não fale do tempo da ligação por conta própria",
    ]) {
      expect(padrao).toContain(trecho);
    }
    for (const proibido of [
      "demonstração",
      "dono",
      "selfie",
      "imobiliária",
      "Viver de IA",
      "nina_ver_chat",
    ]) {
      expect(padrao).not.toContain(proibido);
    }
  });

  it("as regras fixas de voz, o encerrar e as variáveis, nesta ordem", () => {
    for (const trecho of [
      "Você é a Nina",
      "uma pergunta por fala",
      "Não leia listas, links",
      "Não invente preço",
      "nina_passar_para_equipe",
      "pode desligar aí",
      "end_call",
      "{{nina_contexto}}",
      "{{nina_lead}}",
    ]) {
      expect(padrao).toContain(trecho);
    }
    const ordem = [
      "Como falar",
      "Seu papel",
      "Passar para a equipe",
      "Encerrar",
      "<sobre_o_lead>",
      "<contexto_atualizado>",
    ].map((t) => padrao.indexOf(t));
    expect(ordem.every((i) => i >= 0)).toBe(true);
    expect([...ordem].sort((x, y) => x - y)).toEqual(ordem);
  });

  it("L15: pergunta uma vez se a pessoa está aí e espera; não desliga por silêncio", () => {
    expect(padrao).toContain("pergunte uma vez se ela ainda está aí e espere");
    expect(padrao).toContain("Não desligue por causa do silêncio");
    expect(padrao).not.toMatch(/silêncio[^.]*use end_call/i);
  });

  it.each([
    ["vendas", "vender"],
    ["suporte", "dar suporte"],
    ["outro", "Atenda a pessoa"],
  ] as const)("objetivo %s", (objetivo, trecho) => {
    expect(montarPromptLigacao({ ...AGENTE_PADRAO, objetivo })).toContain(trecho);
  });

  it("as instruções do agente entram só quando existem", () => {
    expect(padrao).not.toContain("<instrucoes_deste_atendimento>");
    const p = montarPromptLigacao({ ...AGENTE_PADRAO, instrucoes: "  Ofereça o plano anual.  " });
    expect(p).toContain(
      "<instrucoes_deste_atendimento>\nOfereça o plano anual.\n</instrucoes_deste_atendimento>",
    );
  });

  it("regras de equipe nulas: as do Contexto (Quando passar para humano)", () => {
    expect(padrao).toContain('a parte "Quando passar para humano" do contexto da empresa');
    expect(padrao).not.toContain("<regras_para_passar_para_a_equipe>");
  });

  it("regras de equipe próprias valem no lugar das do Contexto", () => {
    const p = montarPromptLigacao({
      ...AGENTE_PADRAO,
      regrasEquipe: "Passe quando falarem em reembolso.",
    });
    expect(p).toContain('Elas valem no lugar da parte "Quando passar para humano"');
    expect(p).toContain(
      "<regras_para_passar_para_a_equipe>\nPasse quando falarem em reembolso.\n</regras_para_passar_para_a_equipe>",
    );
    // a pessoa pedir alguém da equipe continua passando
    expect(p).toContain("quando a pessoa pedir para falar com alguém da equipe");
  });

  it("regras próprias só com espaços contam como as do Contexto", () => {
    expect(montarPromptLigacao({ ...AGENTE_PADRAO, regrasEquipe: "   " })).toBe(padrao);
  });

  it("o texto do admin não abre variável da ElevenLabs", () => {
    const p = montarPromptLigacao({
      ...AGENTE_PADRAO,
      instrucoes: "Use {{system__time}} e {{nina_lead}}",
      regrasEquipe: "Se {{{x}}}",
    });
    expect(p).toContain("Use {system__time} e {nina_lead}");
    expect(p).toContain("Se {x}");
    expect(p.match(/\{\{/g)).toHaveLength(2); // só as duas variáveis do código
  });
});

describe("criar na ElevenLabs", () => {
  it("conferirAcessoAgentes: GET barato com xi-api-key e sem Authorization", async () => {
    const { fetch, chamadas } = fetchFalso({ status: 200, corpo: { agents: [] } });
    expect(await conferirAcessoAgentes(CHAVE, { fetch })).toBeNull();
    expect(chamadas[0]?.url).toBe("https://api.elevenlabs.io/v1/convai/agents?page_size=1");
    expect(chamadas[0]?.init.method).toBe("GET");
    expect(cabecalhos(chamadas[0])).toEqual({ "xi-api-key": CHAVE });
    expect(chamadas[0]?.init.redirect).toBe("manual");
  });

  it("criarSegredo: o valor é 'Bearer <token>' e o token não volta", async () => {
    const { fetch, chamadas } = fetchFalso({
      status: 200,
      corpo: { secret_id: "seg_abc", eco: `Bearer ${TOKEN}` },
    });
    const r = await criarSegredo(CHAVE, { conexaoId: CONEXAO, token: TOKEN }, { fetch });
    expect(r).toEqual({ ok: true, segredoId: "seg_abc" });
    expect(chamadas[0]?.url).toBe("https://api.elevenlabs.io/v1/convai/secrets");
    expect(chamadas[0]?.init.method).toBe("POST");
    expect(cabecalhos(chamadas[0])).toEqual({
      "xi-api-key": CHAVE,
      "Content-Type": "application/json",
    });
    expect(corpo(chamadas[0])).toEqual({
      type: "new",
      name: "Nina (ligações) c0ffee00 token",
      value: `Bearer ${TOKEN}`,
    });
    semSegredos(r);
  });

  it("criarWebhookPosChamada: HMAC, devolve o segredo da assinatura", async () => {
    const { fetch, chamadas } = fetchFalso({
      status: 200,
      corpo: { webhook_id: "wh_9", webhook_secret: HMAC },
    });
    const url = `https://nina.exemplo.com/api/public/ligacoes/${CONEXAO}/pos-chamada`;
    const r = await criarWebhookPosChamada(CHAVE, { conexaoId: CONEXAO, url }, { fetch });
    expect(r).toEqual({ ok: true, webhookId: "wh_9", hmac: HMAC });
    expect(chamadas[0]?.url).toBe("https://api.elevenlabs.io/v1/workspace/webhooks");
    expect(corpo(chamadas[0])).toEqual({
      settings: {
        auth_type: "hmac",
        name: "Nina (ligações) c0ffee00 pós-chamada",
        webhook_url: url,
      },
    });
  });

  it("criarWebhookPosChamada sem o segredo: hmac null (quem chama apaga)", async () => {
    const { fetch } = fetchFalso({ status: 200, corpo: { webhook_id: "wh_9" } });
    const r = await criarWebhookPosChamada(
      CHAVE,
      { conexaoId: CONEXAO, url: "https://x" },
      { fetch },
    );
    expect(r).toEqual({ ok: true, webhookId: "wh_9", hmac: null });
  });

  it("criarFerramentaEquipe: webhook com o Bearer guardado e a sessão secreta", async () => {
    const { fetch, chamadas } = fetchFalso({ status: 200, corpo: { id: "tool_7" } });
    const urlEquipe = `https://nina.exemplo.com/api/public/ligacoes/${CONEXAO}/equipe`;
    const r = await criarFerramentaEquipe(CHAVE, { urlEquipe, segredoId: "seg_1" }, { fetch });
    expect(r).toEqual({ ok: true, ferramentaId: "tool_7" });
    expect(chamadas[0]?.url).toBe("https://api.elevenlabs.io/v1/convai/tools");
    const c = corpo(chamadas[0]) as { tool_config: Record<string, unknown> };
    expect(c.tool_config).toMatchObject({
      type: "webhook",
      name: "nina_passar_para_equipe",
      api_schema: {
        url: urlEquipe,
        method: "POST",
        request_headers: {
          Authorization: { secret_id: "seg_1" },
          "X-Nina-Sessao": { variable_name: "secret__nina_sessao" },
        },
      },
    });
  });

  it("criarAgente: POST /agents/create com a configuração montada", async () => {
    const { fetch, chamadas } = fetchFalso({ status: 200, corpo: { agent_id: "agent_1" } });
    const r = await criarAgente(CHAVE, DADOS_AGENTE, { fetch });
    expect(r).toEqual({ ok: true, agenteId: "agent_1" });
    expect(chamadas[0]?.url).toBe("https://api.elevenlabs.io/v1/convai/agents/create");
    expect(corpo(chamadas[0])).toEqual(montarConfigAgente(DADOS_AGENTE));
  });

  it("criarTronco: só entrada, criptografia, senha da Meta e domínio wa.meta.vc, sem lista de IP", async () => {
    const { fetch, chamadas } = fetchFalso({
      status: 200,
      corpo: { phone_number_id: "phnum_1", eco: SENHA },
    });
    const r = await criarTronco(
      CHAVE,
      { conexaoId: CONEXAO, numero: "5511999990000", senha: SENHA },
      { fetch },
    );
    expect(r).toEqual({ ok: true, troncoId: "phnum_1" });
    expect(chamadas[0]?.url).toBe("https://api.elevenlabs.io/v1/convai/phone-numbers");
    expect(corpo(chamadas[0])).toEqual({
      phone_number: "+5511999990000",
      label: "Nina (ligações) c0ffee00",
      provider: "sip_trunk",
      supports_inbound: true,
      supports_outbound: false,
      inbound_trunk_config: {
        media_encryption: "required",
        credentials: { username: "5511999990000", password: SENHA },
        remote_domains: ["wa.meta.vc"],
        attributes_to_headers: {},
      },
      outbound_trunk_config: null,
    });
    semSegredos(r);
  });

  it("criarTronco: 409 phone_number_conflict vira numero_em_outra_conta (D16)", async () => {
    const { fetch } = fetchFalso({
      status: 409,
      corpo: { detail: { status: "phone_number_conflict", message: `já existe ${SENHA}` } },
    });
    const r = await criarTronco(
      CHAVE,
      { conexaoId: CONEXAO, numero: "5511999990000", senha: SENHA },
      { fetch },
    );
    expect(r).toMatchObject({ ok: false, erro: "numero_em_outra_conta" });
    semSegredos(r);
  });

  it("ligarTroncoAoAgente: os dois PATCH, na ordem", async () => {
    const { fetch, chamadas } = fetchFalso({ status: 200, corpo: {} }, { status: 200, corpo: {} });
    expect(await ligarTroncoAoAgente(CHAVE, "phnum_1", "agent_1", { fetch })).toBeNull();
    expect(chamadas.map((c) => [c.init.method, c.url, corpo(c)])).toEqual([
      [
        "PATCH",
        "https://api.elevenlabs.io/v1/convai/phone-numbers/phnum_1",
        { store_sip_messages: false },
      ],
      [
        "PATCH",
        "https://api.elevenlabs.io/v1/convai/phone-numbers/phnum_1",
        { agent_id: "agent_1" },
      ],
    ]);
  });

  it("ligarTroncoAoAgente: o primeiro PATCH falhou, o segundo não sai", async () => {
    const { fetch, chamadas } = fetchFalso({ status: 500 });
    expect(await ligarTroncoAoAgente(CHAVE, "phnum_1", "agent_1", { fetch })).toMatchObject({
      erro: "provedor_fora",
    });
    expect(chamadas).toHaveLength(1);
  });

  it.each([
    [401, { detail: { status: "missing_permissions" } }, "chave_sem_acesso_agentes"],
    [403, { detail: { status: "missing_permissions" } }, "chave_sem_acesso_agentes"],
    [401, { detail: { status: "invalid_api_key", message: CHAVE } }, "chave_invalida"],
    [403, { detail: "ip bloqueado" }, "chave_invalida"],
    [401, { detail: { status: "quota_exceeded" } }, "provedor_fora"],
    [429, {}, "provedor_fora"],
    [422, { detail: [{ msg: "campo" }] }, "provedor_fora"],
    [500, {}, "provedor_fora"],
  ])("status %i dá %s, sem a chave no resultado", async (status, corpoErro, erro) => {
    const { fetch } = fetchFalso({ status, corpo: corpoErro });
    const r = await criarSegredo(CHAVE, { conexaoId: CONEXAO, token: TOKEN }, { fetch });
    expect(r).toMatchObject({ ok: false, erro });
    semSegredos(r);
  });

  it("2xx sem id válido é 'não respondeu como esperado'", async () => {
    const { fetch } = fetchFalso({ status: 200, corpo: { agent_id: "../x" } });
    expect(await criarAgente(CHAVE, DADOS_AGENTE, { fetch })).toMatchObject({
      ok: false,
      erro: "provedor_fora",
    });
  });

  it("rede e tempo esgotado viram erros próprios", async () => {
    const rede = fetchFalso({ status: 0, lancar: new Error(`falhou ${CHAVE}`) });
    const r = await criarSegredo(
      CHAVE,
      { conexaoId: CONEXAO, token: TOKEN },
      { fetch: rede.fetch },
    );
    expect(r).toMatchObject({ ok: false, erro: "provedor_fora" });
    semSegredos(r);

    const pendurado: Fetch = (_url, init) =>
      new Promise((_ok, falhar) =>
        init?.signal?.addEventListener("abort", () => falhar(new Error(`abortado ${CHAVE}`))),
      );
    const t = await criarSegredo(
      CHAVE,
      { conexaoId: CONEXAO, token: TOKEN },
      { fetch: pendurado, prazoMs: 5 },
    );
    expect(t).toMatchObject({ ok: false, erro: "tempo_esgotado" });
    semSegredos(t);
  });
});

describe("atualizarAgente (L10, L13)", () => {
  const config = montarConfigAgente(DADOS_AGENTE);

  it("PATCH /agents/<id> com a chave e a configuração montada", async () => {
    const { fetch, chamadas } = fetchFalso({ status: 200, corpo: { agent_id: "agent_1" } });
    expect(await atualizarAgente(CHAVE, "agent_1", config, { fetch })).toBeNull();
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]?.url).toBe("https://api.elevenlabs.io/v1/convai/agents/agent_1");
    expect(chamadas[0]?.init.method).toBe("PATCH");
    expect(cabecalhos(chamadas[0])).toEqual({
      "xi-api-key": CHAVE,
      "Content-Type": "application/json",
    });
    expect(corpo(chamadas[0])).toEqual(config);
  });

  it("404: agente_nao_encontrado, com mensagem fixa", async () => {
    const { fetch } = fetchFalso({
      status: 404,
      corpo: { detail: { status: "agent_not_found", message: `não achei ${CHAVE}` } },
    });
    const r = await atualizarAgente(CHAVE, "agent_1", config, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "agente_nao_encontrado" });
    expect(r?.mensagem).toContain("ElevenLabs");
    semSegredos(r);
  });

  it("id fora do formato: agente_nao_encontrado, sem rede", async () => {
    const { fetch, chamadas } = fetchFalso({ status: 200 });
    expect(await atualizarAgente(CHAVE, "../user", config, { fetch })).toMatchObject({
      erro: "agente_nao_encontrado",
    });
    expect(chamadas).toHaveLength(0);
  });

  it.each([
    [401, { detail: { status: "missing_permissions" } }, "chave_sem_acesso_agentes"],
    [401, { detail: { status: "invalid_api_key", message: CHAVE } }, "chave_invalida"],
    [403, { detail: "ip bloqueado" }, "chave_invalida"],
    [401, { detail: { status: "quota_exceeded" } }, "provedor_fora"],
    [422, { detail: [{ msg: "campo" }] }, "provedor_fora"],
    [429, {}, "provedor_fora"],
    [500, {}, "provedor_fora"],
  ])("status %i dá %s, sem a chave no resultado", async (status, corpoErro, erro) => {
    const { fetch } = fetchFalso({ status, corpo: corpoErro });
    const r = await atualizarAgente(CHAVE, "agent_1", config, { fetch });
    expect(r).toMatchObject({ ok: false, erro });
    semSegredos(r);
  });

  it("rede e tempo esgotado viram erros próprios", async () => {
    const rede = fetchFalso({ status: 0, lancar: new Error(`falhou ${CHAVE}`) });
    expect(await atualizarAgente(CHAVE, "agent_1", config, { fetch: rede.fetch })).toMatchObject({
      erro: "provedor_fora",
    });
    const pendurado: Fetch = (_url, init) =>
      new Promise((_ok, falhar) =>
        init?.signal?.addEventListener("abort", () => falhar(new Error("abortado"))),
      );
    expect(
      await atualizarAgente(CHAVE, "agent_1", config, { fetch: pendurado, prazoMs: 5 }),
    ).toMatchObject({ erro: "tempo_esgotado" });
  });
});

describe("apagar na ElevenLabs (D17)", () => {
  it("a ordem é tronco, agente, ferramenta, webhook e segredo", () => {
    expect(ORDEM_APAGAR).toEqual(["tronco", "agente", "ferramenta", "webhook", "segredo"]);
  });

  it.each([
    ["tronco", "https://api.elevenlabs.io/v1/convai/phone-numbers/id_1"],
    ["agente", "https://api.elevenlabs.io/v1/convai/agents/id_1"],
    ["ferramenta", "https://api.elevenlabs.io/v1/convai/tools/id_1?force=true"],
    ["webhook", "https://api.elevenlabs.io/v1/workspace/webhooks/id_1"],
    ["segredo", "https://api.elevenlabs.io/v1/convai/secrets/id_1"],
  ] as const)("%s: DELETE em %s", async (recurso, url) => {
    const { fetch, chamadas } = fetchFalso({ status: 204 });
    expect(await apagarRecursoEleven(CHAVE, recurso, "id_1", { fetch })).toBe("saiu");
    expect(chamadas[0]?.url).toBe(url);
    expect(chamadas[0]?.init.method).toBe("DELETE");
    expect(cabecalhos(chamadas[0])).toEqual({ "xi-api-key": CHAVE });
    expect(chamadas[0]?.init.body).toBeUndefined();
  });

  it("404 conta como apagado; 409, 500, rede e tempo não", async () => {
    expect(
      await apagarRecursoEleven(CHAVE, "agente", "a", { fetch: fetchFalso({ status: 404 }).fetch }),
    ).toBe("saiu");
    expect(
      await apagarRecursoEleven(CHAVE, "ferramenta", "a", {
        fetch: fetchFalso({ status: 409 }).fetch,
      }),
    ).toBe("ficou");
    expect(
      await apagarRecursoEleven(CHAVE, "agente", "a", { fetch: fetchFalso({ status: 500 }).fetch }),
    ).toBe("ficou");
    const rede = fetchFalso({ status: 0, lancar: new Error("rede") });
    expect(await apagarRecursoEleven(CHAVE, "segredo", "a", { fetch: rede.fetch })).toBe("ficou");
  });

  it("D30: 401 é a chave recusada (revogada), não uma falha que passa sozinha", async () => {
    for (const corpo of [
      { detail: { status: "invalid_api_key" } },
      { detail: { status: "missing_permissions" } },
    ]) {
      const { fetch } = fetchFalso({ status: 401, corpo });
      expect(await apagarRecursoEleven(CHAVE, "agente", "a", { fetch })).toBe("chave_recusada");
    }
  });
});

describe("chaveLeAgente (D29)", () => {
  it("GET do agente com a chave: só o 200 conta como mesma conta", async () => {
    const { fetch, chamadas } = fetchFalso({ status: 200, corpo: { agent_id: "agent_1" } });
    expect(await chaveLeAgente(CHAVE, "agent_1", { fetch })).toBe(true);
    expect(chamadas[0]?.url).toBe("https://api.elevenlabs.io/v1/convai/agents/agent_1");
    expect(chamadas[0]?.init.method).toBe("GET");
    expect(cabecalhos(chamadas[0])).toEqual({ "xi-api-key": CHAVE });
    for (const status of [401, 403, 404, 500]) {
      expect(await chaveLeAgente(CHAVE, "agent_1", { fetch: fetchFalso({ status }).fetch })).toBe(
        false,
      );
    }
    const rede = fetchFalso({ status: 0, lancar: new Error("rede") });
    expect(await chaveLeAgente(CHAVE, "agent_1", { fetch: rede.fetch })).toBe(false);
  });

  it("id fora do formato ou chave vazia: false, sem rede", async () => {
    const { fetch, chamadas } = fetchFalso({ status: 200 });
    expect(await chaveLeAgente(CHAVE, "../user", { fetch })).toBe(false);
    expect(await chaveLeAgente("  ", "agent_1", { fetch })).toBe(false);
    expect(chamadas).toHaveLength(0);
  });
});

describe("o Contexto no prompt do agente (L14, mudança de 12/11/2026)", () => {
  it("vai inteiro e fixo depois das variáveis; o tempo da ligação fecha o prompt", () => {
    const longo = `Empresa e oferta: ${"Consultoria de IA. ".repeat(1_100)}`; // ~20 mil letras
    const p = promptDoAgente(AGENTE_PADRAO, longo);
    expect(longo.length).toBeGreaterThan(19_000);
    expect(p).toContain(longo.trim());
    expect(p.endsWith("</tempo_da_ligacao>")).toBe(true);
    expect(p.indexOf("<sobre_o_lead>")).toBeLessThan(p.indexOf("<contexto_da_empresa>"));
    expect(p.indexOf("</contexto_da_empresa>")).toBeLessThan(p.indexOf("<tempo_da_ligacao>"));
  });

  it("o tempo da ligação: só o máximo, fixo, sem o relógio que zerava o cache do LLM", () => {
    expect(tempoDaLigacao(600)).toBe(
      "<tempo_da_ligacao>\nO máximo desta ligação é de 10 minutos.\n</tempo_da_ligacao>",
    );
    expect(tempoDaLigacao(60)).toContain("é de 1 minuto.");
    expect(tempoDaLigacao(600)).not.toContain("{{");
  });

  it("nada no prompt muda a cada vez de falar: nenhuma variável de sistema da ElevenLabs", () => {
    // uma variável que muda a cada fala (como system__call_duration_secs) zera o cache do LLM em
    // toda fala: medido em 18/11/2026, o LLM da ligação ficou 12 a 16 vezes mais caro
    const p = promptDoAgente(AGENTE_PADRAO, "Empresa e oferta: consultoria.");
    expect(p).not.toMatch(/\{\{\s*system__/);
    expect(p).not.toContain("faltam uns 2 minutos");
  });

  it("o nina_contexto vale no lugar do fixo quando vier preenchido", () => {
    const p = promptDoAgente(AGENTE_PADRAO, "x");
    expect(p).toContain("<contexto_atualizado>\n{{nina_contexto}}\n</contexto_atualizado>");
    expect(p).toContain(
      "Quando <contexto_atualizado> vier preenchido, ele é a versão mais nova do contexto da empresa e vale no lugar de <contexto_da_empresa>",
    );
  });

  it("sem Contexto, uma frase no lugar; o Contexto não abre variável da ElevenLabs", () => {
    expect(promptDoAgente(AGENTE_PADRAO, "  ")).toContain(
      `<contexto_da_empresa>\n${CONTEXTO_VAZIO}\n</contexto_da_empresa>`,
    );
    const p = promptDoAgente(AGENTE_PADRAO, "Preço: {{system__time}}");
    expect(p).toContain("Preço: {system__time}");
    // só as variáveis do prompt: nina_lead e nina_contexto (nada que mude a cada fala)
    expect(p.match(/\{\{/g)).toHaveLength(2);
  });

  it("prompt acima de 2 MB: prompt_grande, sem ir à rede, no criar e no atualizar", async () => {
    const enorme = "á".repeat(MAX_PROMPT_BYTES / 2 + 10); // 2 bytes cada em UTF-8
    const d: DadosAgente = { ...DADOS_AGENTE, contexto: enorme };
    const { fetch, chamadas } = fetchFalso({ status: 200, corpo: { agent_id: "agent_x" } });
    expect(await criarAgente(CHAVE, d, { fetch })).toMatchObject({
      ok: false,
      erro: "prompt_grande",
    });
    expect(await atualizarAgente(CHAVE, "agent_1", montarConfigAgente(d), { fetch })).toMatchObject(
      { ok: false, erro: "prompt_grande" },
    );
    expect(chamadas).toHaveLength(0);
  });
});

describe("as falas curtas na ligação", () => {
  it("no máximo 2 frases curtas por vez, nunca dois exemplos, a pessoa pede mais", () => {
    const p = montarPromptLigacao(AGENTE_PADRAO);
    expect(p).toContain("no máximo 2 frases curtas (uns 10 segundos)");
    expect(p).toContain("Nunca dê dois exemplos nem duas ofertas de uma vez");
    expect(p).toContain("Se a pessoa quiser saber mais, ela pede");
    expect(p.indexOf("Fale pouco de cada vez")).toBeLessThan(p.indexOf("Seu papel"));
  });
});

describe("apontarTronco (L11)", () => {
  it("PATCH do tronco com o agente novo", async () => {
    const { fetch, chamadas } = fetchFalso({ status: 200, corpo: {} });
    expect(await apontarTronco(CHAVE, "phnum_1", "agent_2", { fetch })).toBeNull();
    expect(chamadas[0]?.url).toBe("https://api.elevenlabs.io/v1/convai/phone-numbers/phnum_1");
    expect(chamadas[0]?.init.method).toBe("PATCH");
    expect(corpo(chamadas[0])).toEqual({ agent_id: "agent_2" });
  });

  it("404 é agente_nao_encontrado; id fora do formato não vai à rede", async () => {
    const { fetch, chamadas } = fetchFalso({ status: 404, corpo: {} });
    expect(await apontarTronco(CHAVE, "phnum_1", "agent_2", { fetch })).toMatchObject({
      erro: "agente_nao_encontrado",
    });
    expect(await apontarTronco(CHAVE, "../x", "agent_2", { fetch })).toMatchObject({ ok: false });
    expect(chamadas).toHaveLength(1);
  });
});

// ---------- a ligação de saída (seções 1 e 4) ----------

describe("a saída do tronco", () => {
  it("PATCH com o outbound_trunk_config que funcionou na vitrine (custom_from_domain, sem proxy)", async () => {
    const { fetch, chamadas } = fetchFalso({ status: 200, corpo: {} });
    const r = await ligarSaidaDoTronco(
      CHAVE,
      "phnum_1",
      { numero: "+55 11 99999-0000", senha: SENHA },
      { fetch },
    );
    expect(r).toBeNull();
    expect(chamadas[0]?.url).toBe("https://api.elevenlabs.io/v1/convai/phone-numbers/phnum_1");
    expect(chamadas[0]?.init.method).toBe("PATCH");
    expect(cabecalhos(chamadas[0])["xi-api-key"]).toBe(CHAVE);
    expect(corpo(chamadas[0])).toEqual({
      outbound_trunk_config: {
        address: "wa.meta.vc",
        transport: "tls",
        media_encryption: "required",
        credentials: { username: "5511999990000", password: SENHA },
        custom_from_domain: "sip.rtc.elevenlabs.io",
      },
    });
    expect(montarSaidaDoTronco({ numero: "5511999990000", senha: SENHA })).toEqual(
      corpo(chamadas[0]),
    );
  });

  it("falha da ElevenLabs volta sem a senha", async () => {
    const { fetch } = fetchFalso({ status: 422, corpo: { detail: SENHA } });
    const r = await ligarSaidaDoTronco(
      CHAVE,
      "phnum_1",
      { numero: "5511999990000", senha: SENHA },
      { fetch },
    );
    expect(r).toMatchObject({ ok: false });
    semSegredos(r);
  });
});

describe("ligarPeloTronco", () => {
  const variaveis = {
    nina_saudacao: "Oi, Ana!",
    nina_lead: "Nome: Ana",
    nina_contexto: "",
    nina_ligacao: "lig-1",
    secret__nina_sessao: TOKEN,
  };

  it("POST outbound-call com o agente, o tronco, o número em E.164 e as variáveis; devolve a conversa", async () => {
    const { fetch, chamadas } = fetchFalso({
      status: 200,
      corpo: { success: true, message: "ok", conversation_id: "conv_saida_1", sip_call_id: "x" },
    });
    const r = await ligarPeloTronco(
      CHAVE,
      { agenteId: "agent_1", troncoId: "phnum_1", para: "5511988887777", variaveis },
      { fetch },
    );
    expect(r).toEqual({ ok: true, conversaEleven: "conv_saida_1" });
    expect(chamadas[0]?.url).toBe("https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call");
    expect(corpo(chamadas[0])).toEqual({
      agent_id: "agent_1",
      agent_phone_number_id: "phnum_1",
      to_number: "+5511988887777",
      conversation_initiation_client_data: { dynamic_variables: variaveis },
    });
  });

  it("success false ou sem conversa: falha; erro HTTP sem o token da sessão no resultado", async () => {
    const naoSaiu = fetchFalso({ status: 200, corpo: { success: false, message: "busy" } });
    expect(
      await ligarPeloTronco(
        CHAVE,
        { agenteId: "agent_1", troncoId: "phnum_1", para: "5511988887777", variaveis },
        { fetch: naoSaiu.fetch },
      ),
    ).toMatchObject({ ok: false });
    const erro = fetchFalso({ status: 400, corpo: { detail: TOKEN } });
    const r = await ligarPeloTronco(
      CHAVE,
      { agenteId: "agent_1", troncoId: "phnum_1", para: "5511988887777", variaveis },
      { fetch: erro.fetch },
    );
    expect(r).toMatchObject({ ok: false });
    semSegredos(r);
  });

  it("incerto: tempo esgotado, rede, 5xx ou 2xx sem o id (pode ter saído); certo: 4xx e success false", async () => {
    const d = { agenteId: "agent_1", troncoId: "phnum_1", para: "5511988887777", variaveis };
    const caso = async (...r: Parameters<typeof fetchFalso>) =>
      ligarPeloTronco(CHAVE, d, { fetch: fetchFalso(...r).fetch });
    expect(await caso({ status: 0, lancar: new TypeError("rede") })).toMatchObject({
      ok: false,
      incerto: true,
    });
    expect(await caso({ status: 502 })).toMatchObject({ ok: false, incerto: true });
    expect(await caso({ status: 200, corpo: { success: true } })).toMatchObject({
      ok: false,
      incerto: true,
    });
    expect(await caso({ status: 422, corpo: {} })).toMatchObject({ ok: false, incerto: false });
    expect(await caso({ status: 200, corpo: { success: false } })).toMatchObject({
      ok: false,
      incerto: false,
    });
  });

  it("ids ou número inválidos: falha sem pedir", async () => {
    const { fetch, chamadas } = fetchFalso({ status: 200 });
    expect(
      await ligarPeloTronco(
        CHAVE,
        { agenteId: "a/b", troncoId: "phnum_1", para: "5511988887777", variaveis },
        { fetch },
      ),
    ).toMatchObject({ ok: false });
    expect(
      await ligarPeloTronco(
        CHAVE,
        { agenteId: "agent_1", troncoId: "phnum_1", para: "+55", variaveis },
        { fetch },
      ),
    ).toMatchObject({ ok: false });
    expect(chamadas).toHaveLength(0);
  });
});
