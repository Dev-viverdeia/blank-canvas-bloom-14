import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Fetch } from "./http";
import {
  consultarPermissaoMeta,
  conferirSipMeta,
  CORPO_DESLIGAR_SIP,
  corpoPedidoPermissao,
  ligarCallbackMeta,
  pedirPermissaoMeta,
  CORPO_LIGAR_SIP,
  desligarSipMeta,
  lerNumeroMeta,
  lerSenhaSipMeta,
  ligarChamadasMeta,
  ligarSipMeta,
} from "./ligacoes-meta";

const TOKEN = "EAAG-token-meta-TOKEN_LIGACOES_123456";
const SENHA = "senha-sip-gerada-pela-meta-SENHA_998877";
const PHONE = "106540352242922";
const BASE = `https://graph.facebook.com/v26.0/${PHONE}`;

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

function semSegredos(valor: unknown) {
  const texto = JSON.stringify(valor);
  expect(texto).not.toContain(TOKEN);
  expect(texto).not.toContain(SENHA);
}

let espioes: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  espioes = [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
  ];
});
afterEach(() => {
  for (const e of espioes) {
    for (const chamada of e.mock.calls) semSegredos(chamada);
    e.mockRestore();
  }
});

describe("lerNumeroMeta", () => {
  it("pede o número e o limite com o Bearer da conexão", async () => {
    const { fetch, chamadas } = fetchFalso({
      status: 200,
      corpo: {
        display_phone_number: "+55 11 99999-0000",
        whatsapp_business_manager_messaging_limit: "TIER_2K",
        health_status: { can_send_message: "available", entities: [] },
      },
    });
    const r = await lerNumeroMeta(TOKEN, PHONE, { fetch });
    expect(r).toEqual({ ok: true, numero: "5511999990000", limite: "TIER_2K", saude: "AVAILABLE" });
    expect(chamadas[0]?.url).toBe(
      `${BASE}?fields=display_phone_number%2Cwhatsapp_business_manager_messaging_limit%2Chealth_status`,
    );
    expect(chamadas[0]?.init.method).toBe("GET");
    expect(chamadas[0]?.init.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it("sem limite, limite null; sem número, falha", async () => {
    const semLimite = fetchFalso({ status: 200, corpo: { display_phone_number: "15550001111" } });
    expect(await lerNumeroMeta(TOKEN, PHONE, { fetch: semLimite.fetch })).toEqual({
      ok: true,
      numero: "15550001111",
      limite: null,
      saude: null,
    });
    const semNumero = fetchFalso({ status: 200, corpo: {} });
    expect(await lerNumeroMeta(TOKEN, PHONE, { fetch: semNumero.fetch })).toMatchObject({
      ok: false,
      erro: "provedor_fora",
    });
  });

  it.each([
    [401, { error: { code: 190, message: TOKEN } }, "meta_token_invalido"],
    [400, { error: { code: 190 } }, "meta_token_invalido"],
    [403, { error: { code: 10 } }, "meta_token_invalido"],
    [400, { error: { code: 100 } }, "meta_token_invalido"],
    [400, { error: { code: 80007 } }, "provedor_fora"],
    [500, {}, "provedor_fora"],
  ])("status %i dá %s, sem o token", async (status, corpo, erro) => {
    const { fetch } = fetchFalso({ status, corpo });
    const r = await lerNumeroMeta(TOKEN, PHONE, { fetch });
    expect(r).toMatchObject({ ok: false, erro });
    semSegredos(r);
  });
});

describe("conferirSipMeta (D19)", () => {
  it("GET /settings sem as senhas; sem servidor, ou só o da ElevenLabs desligado: livre", async () => {
    const vazio = fetchFalso({ status: 200, corpo: { calling: { status: "DISABLED" } } });
    expect(await conferirSipMeta(TOKEN, PHONE, { fetch: vazio.fetch })).toBeNull();
    expect(vazio.chamadas[0]?.url).toBe(`${BASE}/settings`);
    expect(vazio.chamadas[0]?.init.method).toBe("GET");
    expect(vazio.chamadas[0]?.init.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    const nosso = fetchFalso({
      status: 200,
      corpo: {
        calling: {
          status: "DISABLED",
          sip: { status: "DISABLED", servers: [{ hostname: "sip.rtc.elevenlabs.io", port: 5061 }] },
        },
      },
    });
    expect(await conferirSipMeta(TOKEN, PHONE, { fetch: nosso.fetch })).toBeNull();
  });

  it("D33: SIP ou chamadas ligados recusam, qualquer que seja o servidor", async () => {
    const elevenlabs = [{ hostname: "sip.rtc.elevenlabs.io", port: 5061 }];
    for (const calling of [
      { sip: { status: "ENABLED", servers: elevenlabs } },
      { status: "DISABLED", sip: { status: " enabled ", servers: elevenlabs } },
      { status: "ENABLED", sip: { status: "DISABLED", servers: elevenlabs } },
      { status: "ENABLED" },
      { sip: { status: "ENABLED" } },
      { sip: { status: "ENABLED", servers: [] } },
    ]) {
      const { fetch, chamadas } = fetchFalso({ status: 200, corpo: { calling } });
      const r = await conferirSipMeta(TOKEN, PHONE, { fetch });
      expect(r).toMatchObject({ ok: false, erro: "meta_sip_em_uso" });
      expect(r?.mensagem).toContain("já tem ligações ligadas na Meta");
      expect(chamadas.map((c) => c.init.method)).toEqual(["GET"]);
    }
  });

  it("servidor SIP com outro endereço: meta_sip_em_uso, com a frase fixa", async () => {
    const { fetch } = fetchFalso({
      status: 200,
      corpo: {
        calling: {
          sip: {
            status: "ENABLED",
            servers: [
              { hostname: "sip.rtc.elevenlabs.io", port: 5061 },
              { hostname: "sip.outro-sistema.com", port: 5061 },
            ],
          },
        },
      },
    });
    const r = await conferirSipMeta(TOKEN, PHONE, { fetch });
    expect(r).toMatchObject({ ok: false, erro: "meta_sip_em_uso" });
    expect(r?.mensagem).toContain("outro sistema");
    expect(r?.mensagem).toContain("painel da Meta");
    expect(r?.mensagem).not.toContain("sip.outro-sistema.com");
  });

  it("D31: servidor de outro sistema só libera com sip.status DISABLED explícito", async () => {
    const outro = [{ hostname: "sip.outro-sistema.com", port: 5061 }];
    for (const status of ["DISABLED", " disabled "]) {
      const { fetch } = fetchFalso({
        status: 200,
        corpo: { calling: { sip: { status, servers: outro } } },
      });
      expect(await conferirSipMeta(TOKEN, PHONE, { fetch })).toBeNull();
    }
  });

  it("D31: servidor de outro sistema sem sip.status, ou com outro valor, recusa", async () => {
    const outro = [{ hostname: "sip.outro-sistema.com", port: 5061 }];
    for (const sip of [
      { servers: outro },
      { status: "", servers: outro },
      { status: "PENDING", servers: outro },
      { status: 0, servers: outro },
    ]) {
      const { fetch } = fetchFalso({ status: 200, corpo: { calling: { sip } } });
      expect(await conferirSipMeta(TOKEN, PHONE, { fetch })).toMatchObject({
        ok: false,
        erro: "meta_sip_em_uso",
      });
    }
  });

  it("D31: sem servidor de outro sistema e sem nada ligado, livre", async () => {
    for (const sip of [
      { servers: [] },
      { servers: [{ hostname: "sip.rtc.elevenlabs.io", port: 5061 }] },
      { status: "DISABLED" },
    ]) {
      const { fetch } = fetchFalso({ status: 200, corpo: { calling: { sip } } });
      expect(await conferirSipMeta(TOKEN, PHONE, { fetch })).toBeNull();
    }
  });

  it("token recusado e rede: as falhas comuns", async () => {
    const recusado = fetchFalso({ status: 401, corpo: { error: { code: 190 } } });
    expect(await conferirSipMeta(TOKEN, PHONE, { fetch: recusado.fetch })).toMatchObject({
      erro: "meta_token_invalido",
    });
    const rede = fetchFalso({ status: 0, lancar: new Error("rede") });
    expect(await conferirSipMeta(TOKEN, PHONE, { fetch: rede.fetch })).toMatchObject({
      erro: "provedor_fora",
    });
  });
});

describe("ligarChamadasMeta (D18)", () => {
  it("POST /settings só com calling.status ENABLED", async () => {
    const { fetch, chamadas } = fetchFalso({ status: 200, corpo: { success: true } });
    expect(await ligarChamadasMeta(TOKEN, PHONE, { fetch })).toEqual({ ok: true });
    expect(chamadas[0]?.url).toBe(`${BASE}/settings`);
    expect(chamadas[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(chamadas[0]?.init.body))).toEqual({
      calling: { status: "ENABLED" },
    });
  });

  it("recusa (4xx) é meta_recusou; 5xx, falha", async () => {
    const recusa = fetchFalso({ status: 400, corpo: { error: { code: 138006 } } });
    expect(await ligarChamadasMeta(TOKEN, PHONE, { fetch: recusa.fetch })).toMatchObject({
      ok: false,
      erro: "meta_recusou",
    });
    const fora = fetchFalso({ status: 502 });
    expect(await ligarChamadasMeta(TOKEN, PHONE, { fetch: fora.fetch })).toMatchObject({
      ok: false,
      erro: "provedor_fora",
    });
  });
});

describe("ligarSipMeta", () => {
  it("POST /settings com o SIP ligado e as chamadas ainda desligadas (spec 2.6 passo 3, D18)", async () => {
    const { fetch, chamadas } = fetchFalso({ status: 200, corpo: { success: true } });
    expect(await ligarSipMeta(TOKEN, PHONE, { fetch })).toEqual({ ok: true });
    expect(chamadas[0]?.url).toBe(`${BASE}/settings`);
    expect(chamadas[0]?.init.method).toBe("POST");
    expect(chamadas[0]?.init.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(chamadas[0]?.init.body))).toEqual({
      calling: {
        status: "DISABLED",
        callback_permission_status: "DISABLED",
        srtp_key_exchange_protocol: "SDES",
        audio: { additional_codecs: ["PCMA", "PCMU"] },
        sip: {
          status: "ENABLED",
          servers: [{ hostname: "sip.rtc.elevenlabs.io", port: 5061 }],
        },
      },
    });
    expect(CORPO_LIGAR_SIP.calling.sip.servers[0].hostname).toBe("sip.rtc.elevenlabs.io");
  });

  it.each([
    [138015, "meta_limite"],
    [138018, "meta_requisito_tecnico"],
    [138014, "meta_pausada"],
  ])("a recusa %i tem motivo (seção 21): %s, e não aplicou", async (codigo, erro) => {
    const { fetch } = fetchFalso({ status: 400, corpo: { error: { code: codigo } } });
    expect(await ligarSipMeta(TOKEN, PHONE, { fetch })).toMatchObject({
      ok: false,
      erro,
      aplicado: "nao",
    });
    expect(await ligarChamadasMeta(TOKEN, PHONE, { fetch })).toMatchObject({ ok: false, erro });
  });

  it("recusa da Meta (4xx) é meta_recusou e não aplicou", async () => {
    const { fetch } = fetchFalso({ status: 400, corpo: { error: { code: 138006 } } });
    expect(await ligarSipMeta(TOKEN, PHONE, { fetch })).toMatchObject({
      ok: false,
      erro: "meta_recusou",
      aplicado: "nao",
    });
  });

  it("token recusado é meta_token_invalido", async () => {
    const { fetch } = fetchFalso({ status: 401, corpo: { error: { code: 190 } } });
    expect(await ligarSipMeta(TOKEN, PHONE, { fetch })).toMatchObject({
      erro: "meta_token_invalido",
      aplicado: "nao",
    });
  });

  it("tempo, rede e 5xx: pode ter aplicado", async () => {
    const pendurado: Fetch = (_u, init) =>
      new Promise((_ok, falhar) =>
        init?.signal?.addEventListener("abort", () => falhar(new Error("x"))),
      );
    expect(await ligarSipMeta(TOKEN, PHONE, { fetch: pendurado, prazoMs: 5 })).toMatchObject({
      erro: "tempo_esgotado",
      aplicado: "talvez",
    });
    const rede = fetchFalso({ status: 0, lancar: new Error("rede") });
    expect(await ligarSipMeta(TOKEN, PHONE, { fetch: rede.fetch })).toMatchObject({
      erro: "provedor_fora",
      aplicado: "talvez",
    });
    const fora = fetchFalso({ status: 502 });
    expect(await ligarSipMeta(TOKEN, PHONE, { fetch: fora.fetch })).toMatchObject({
      aplicado: "talvez",
    });
  });
});

describe("lerSenhaSipMeta", () => {
  it("GET com include_sip_credentials e a senha do servidor da ElevenLabs", async () => {
    const { fetch, chamadas } = fetchFalso({
      status: 200,
      corpo: {
        calling: {
          status: "ENABLED",
          sip: {
            status: "ENABLED",
            servers: [
              { app_id: 1, hostname: "sip.outro.com", sip_user_password: "outra-senha-qualquer" },
              { app_id: 2, hostname: "sip.rtc.elevenlabs.io", sip_user_password: SENHA },
            ],
          },
        },
      },
    });
    const r = await lerSenhaSipMeta(TOKEN, PHONE, { fetch });
    expect(r).toEqual({ ok: true, senha: SENHA });
    expect(chamadas[0]?.url).toBe(`${BASE}/settings?include_sip_credentials=true`);
    expect(chamadas[0]?.init.method).toBe("GET");
  });

  it("sem a senha, falha fixa sem nenhum valor", async () => {
    const { fetch } = fetchFalso({
      status: 200,
      corpo: { calling: { sip: { servers: [{ hostname: "sip.rtc.elevenlabs.io" }] } } },
    });
    expect(await lerSenhaSipMeta(TOKEN, PHONE, { fetch })).toMatchObject({
      ok: false,
      erro: "provedor_fora",
    });
  });

  it("um erro que ecoa a senha não a devolve", async () => {
    const { fetch } = fetchFalso({ status: 500, corpo: { error: { message: SENHA } } });
    const r = await lerSenhaSipMeta(TOKEN, PHONE, { fetch });
    expect(r.ok).toBe(false);
    semSegredos(r);
  });
});

describe("desligarSipMeta", () => {
  it("POST com calling e sip DISABLED", async () => {
    const { fetch, chamadas } = fetchFalso({ status: 200, corpo: { success: true } });
    expect(await desligarSipMeta(TOKEN, PHONE, { fetch })).toBe(true);
    expect(chamadas[0]?.url).toBe(`${BASE}/settings`);
    expect(chamadas[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(chamadas[0]?.init.body))).toEqual({
      calling: { status: "DISABLED", sip: { status: "DISABLED" } },
    });
    expect(CORPO_DESLIGAR_SIP.calling.status).toBe("DISABLED");
  });

  it("falha, rede ou sem token: false (pendência)", async () => {
    expect(await desligarSipMeta(TOKEN, PHONE, { fetch: fetchFalso({ status: 400 }).fetch })).toBe(
      false,
    );
    const rede = fetchFalso({ status: 0, lancar: new Error("rede") });
    expect(await desligarSipMeta(TOKEN, PHONE, { fetch: rede.fetch })).toBe(false);
    const nada = fetchFalso({ status: 200 });
    expect(await desligarSipMeta("", PHONE, { fetch: nada.fetch })).toBe(false);
    expect(nada.chamadas).toHaveLength(0);
  });
});

// ---------- a ligação de saída (seção 3) ----------

const LEAD = "5511988887777";

describe("consultarPermissaoMeta", () => {
  it("GET call_permissions do lead: temporária, pode ligar, e o pedido travado até o limite acabar", async () => {
    const { fetch, chamadas } = fetchFalso({
      status: 200,
      corpo: {
        messaging_product: "whatsapp",
        permission: { status: "temporary", expiration_time: 1795000000 },
        actions: [
          {
            action_name: "send_call_permission_request",
            can_perform_action: false,
            limits: [
              {
                time_period: "PT24H",
                max_allowed: 1,
                current_usage: 1,
                limit_expiration_time: 1794990000,
              },
              { time_period: "P7D", max_allowed: 2, current_usage: 1 },
            ],
          },
          { action_name: "start_call", can_perform_action: true, limits: [] },
        ],
      },
    });
    const r = await consultarPermissaoMeta(TOKEN, PHONE, LEAD, { fetch });
    expect(r).toEqual({
      ok: true,
      status: "temporary",
      expiraEm: new Date(1795000000 * 1000).toISOString(),
      ligar: { pode: true, liberaEm: null },
      pedir: { pode: false, liberaEm: new Date(1794990000 * 1000).toISOString() },
    });
    expect(chamadas[0]?.url).toBe(`${BASE}/call_permissions?user_wa_id=${LEAD}`);
    expect(chamadas[0]?.init.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it("o limite que trava por mais tempo manda; status desconhecido vira no_permission; sem ação, não pode", async () => {
    const { fetch } = fetchFalso({
      status: 200,
      corpo: {
        permission: { status: "algo_novo" },
        actions: [
          {
            action_name: "start_call",
            can_perform_action: false,
            limits: [{ limit_expiration_time: 1794990000 }, { limit_expiration_time: 1795090000 }],
          },
        ],
      },
    });
    const r = await consultarPermissaoMeta(TOKEN, PHONE, LEAD, { fetch });
    expect(r).toMatchObject({
      ok: true,
      status: "no_permission",
      expiraEm: null,
      ligar: { pode: false, liberaEm: new Date(1795090000 * 1000).toISOString() },
      pedir: { pode: false, liberaEm: null },
    });
  });

  it("permanente não tem validade; token recusado e Meta fora viram as falhas de sempre", async () => {
    const ok = fetchFalso({
      status: 200,
      corpo: { permission: { status: "permanent" }, actions: [] },
    });
    expect(await consultarPermissaoMeta(TOKEN, PHONE, LEAD, { fetch: ok.fetch })).toMatchObject({
      status: "permanent",
      expiraEm: null,
    });
    const token = fetchFalso({ status: 401, corpo: { error: { code: 190, message: TOKEN } } });
    const r = await consultarPermissaoMeta(TOKEN, PHONE, LEAD, { fetch: token.fetch });
    expect(r).toMatchObject({ ok: false, erro: "meta_token_invalido" });
    semSegredos(r);
    const fora = fetchFalso({ status: 502 });
    expect(await consultarPermissaoMeta(TOKEN, PHONE, LEAD, { fetch: fora.fetch })).toMatchObject({
      ok: false,
      erro: "provedor_fora",
    });
  });

  it("número do lead inválido: falha sem pedir", async () => {
    const { fetch, chamadas } = fetchFalso({ status: 200 });
    expect(await consultarPermissaoMeta(TOKEN, PHONE, "+55 11", { fetch })).toMatchObject({
      ok: false,
    });
    expect(chamadas).toHaveLength(0);
  });
});

describe("pedirPermissaoMeta", () => {
  it("POST messages com o interativo call_permission_request; devolve o wamid", async () => {
    const { fetch, chamadas } = fetchFalso({
      status: 200,
      corpo: { messages: [{ id: "wamid.PEDIDO1" }] },
    });
    const r = await pedirPermissaoMeta(TOKEN, PHONE, LEAD, "Podemos te ligar?", { fetch });
    expect(r).toEqual({ ok: true, wamid: "wamid.PEDIDO1" });
    expect(chamadas[0]?.url).toBe(`${BASE}/messages`);
    expect(chamadas[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(chamadas[0]?.init.body))).toEqual(
      corpoPedidoPermissao(LEAD, "Podemos te ligar?"),
    );
    expect(corpoPedidoPermissao(LEAD, "x")).toMatchObject({
      to: LEAD,
      type: "interactive",
      interactive: {
        type: "call_permission_request",
        action: { name: "call_permission_request" },
        body: { text: "x" },
      },
    });
  });

  it("sem wamid na resposta: provedor_fora; recusa da Meta: meta_recusou", async () => {
    const sem = fetchFalso({ status: 200, corpo: {} });
    expect(await pedirPermissaoMeta(TOKEN, PHONE, LEAD, "x", { fetch: sem.fetch })).toMatchObject({
      erro: "provedor_fora",
    });
    const recusa = fetchFalso({ status: 400, corpo: { error: { code: 131047 } } });
    expect(
      await pedirPermissaoMeta(TOKEN, PHONE, LEAD, "x", { fetch: recusa.fetch }),
    ).toMatchObject({
      erro: "meta_recusou",
    });
  });
});

describe("ligarCallbackMeta", () => {
  it("POST settings só com o callback ligado", async () => {
    const { fetch, chamadas } = fetchFalso({ status: 200, corpo: { success: true } });
    expect(await ligarCallbackMeta(TOKEN, PHONE, { fetch })).toEqual({ ok: true });
    expect(JSON.parse(String(chamadas[0]?.init.body))).toEqual({
      calling: { callback_permission_status: "ENABLED" },
    });
  });
});
