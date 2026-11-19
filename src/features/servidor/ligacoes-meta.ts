// As ligações pelo WhatsApp na Meta (2.6): ler o número e o limite,
// conferir que o número não manda as ligações para outro servidor SIP (D19), ligar o SIP apontando
// para a ElevenLabs com as chamadas ainda desligadas, ler a senha SIP que a Meta gera, ligar as
// chamadas só depois do tronco pronto (D18) e desligar. Lógica pura, com o fetch injetado;
// Authorization: Bearer <token da conexão>, como o resto da conexão da Meta.
//
// - A senha SIP (calling.sip.servers[].sip_user_password, só com include_sip_credentials=true)
//   fica só em memória: vai direto para o tronco da ElevenLabs e nunca para o banco, o log ou o
//   resultado. O pedir apaga o eco do token e da senha antes de ler o corpo.
// - Erros da Graph API ({error: {code}}): 190 (ou 401) é o token; 138015 é o limite de 2.000
//   (meta_limite), 138018 um requisito técnico e 138014 a pausa por qualidade (seção 21); 10, 2xx
//   e 403 são permissão do token sobre o número; 4, 17, 32, 613, 80007 e 429 são tentativas demais.
//   No ligar, o resto de 4xx é a Meta recusando as ligações sem motivo conhecido (meta_recusou).

import { msgLigacoes } from "@/features/mensageria/ligacoes/mensagens";
import { SIP_ELEVENLABS, type FalhaLigacoes } from "@/features/mensageria/ligacoes/tipos";

import { META_GRAPH } from "./conexao";
import {
  abrirPrazo,
  FalhaDeRede,
  ler,
  lerNumero,
  lerTexto,
  pedir,
  TempoEsgotado,
  type OpcoesValidacao,
  type RespostaHttp,
} from "./http";

/**
 * O corpo do POST /<phoneId>/settings que liga o SIP (o formato da Subido), com as chamadas ainda
 * desligadas (D18): o lead só consegue ligar depois do tronco pronto (CORPO_LIGAR_CHAMADAS).
 */
export const CORPO_LIGAR_SIP = {
  calling: {
    status: "DISABLED",
    // o callback de 7 dias vai num pedido à parte, depois das chamadas, sem travar a ativação
    // (ligarCallbackMeta; Opus, PR #24)
    callback_permission_status: "DISABLED",
    srtp_key_exchange_protocol: "SDES",
    audio: { additional_codecs: ["PCMA", "PCMU"] },
    sip: {
      status: "ENABLED",
      servers: [{ hostname: SIP_ELEVENLABS.hostname, port: SIP_ELEVENLABS.port }],
    },
  },
} as const;

/** O corpo que liga as chamadas, o último passo da ativação (D18). */
export const CORPO_LIGAR_CHAMADAS = { calling: { status: "ENABLED" } } as const;

/** O corpo que desliga: as ligações e o SIP (os servidores ficam, a Meta não os apaga). */
export const CORPO_DESLIGAR_SIP = {
  calling: { status: "DISABLED", sip: { status: "DISABLED" } },
} as const;

const PHONE_ID = /^\d{5,30}$/;

function urlDoNumero(phoneId: string): string {
  return `${META_GRAPH}/${encodeURIComponent(phoneId)}`;
}

/** As falhas comuns da Graph API; null = 2xx. `recusa` é o que um 4xx sem código conhecido vira. */
function falhaMeta(r: RespostaHttp, recusa: () => FalhaLigacoes): FalhaLigacoes | null {
  if (r.status >= 200 && r.status < 300) return null;
  const codigo = lerNumero(r.corpo, "error", "code");
  if (codigo === 190 || r.status === 401) return msgLigacoes.metaTokenInvalido();
  // as recusas das ligações com motivo (spec seção 21): o limite de 2.000, um requisito técnico e
  // a pausa por qualidade
  if (codigo === 138015) return msgLigacoes.metaLimite();
  if (codigo === 138018) return msgLigacoes.metaRequisitoTecnico();
  if (codigo === 138014) return msgLigacoes.metaPausada();
  if (codigo === 4 || codigo === 17 || codigo === 32 || codigo === 613 || codigo === 80007) {
    return msgLigacoes.metaMuitas();
  }
  if (r.status === 429) return msgLigacoes.metaMuitas();
  if (codigo === 10 || (codigo !== undefined && codigo >= 200 && codigo < 300)) {
    return msgLigacoes.metaTokenInvalido();
  }
  if (r.status === 403) return msgLigacoes.metaTokenInvalido();
  if (r.status >= 400 && r.status < 500) return recusa();
  return msgLigacoes.metaFora();
}

function falhaDoErroMeta(e: unknown): FalhaLigacoes {
  if (e instanceof TempoEsgotado) return msgLigacoes.metaTempo();
  if (e instanceof FalhaDeRede) return msgLigacoes.metaSemRede();
  return msgLigacoes.metaFora();
}

async function chamar(
  token: string,
  url: string,
  init: { method: "GET" | "POST"; corpo?: unknown },
  opcoes: OpcoesValidacao | undefined,
): Promise<RespostaHttp> {
  const prazo = abrirPrazo(opcoes?.prazoMs);
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${token.trim()}` };
    if (init.corpo !== undefined) headers["Content-Type"] = "application/json";
    return await pedir(
      opcoes,
      prazo,
      url,
      {
        method: init.method,
        headers,
        ...(init.corpo !== undefined ? { body: JSON.stringify(init.corpo) } : {}),
      },
      [token],
    );
  } finally {
    prazo.encerrar();
  }
}

export type NumeroMeta = {
  numero: string;
  limite: string | null;
  /** health_status.can_send_message do número (ex.: "AVAILABLE", "LIMITED", "BLOCKED"); null = não veio. */
  saude: string | null;
};

/**
 * O número (só dígitos), o limite de mensagens e a saúde do número (spec 2.6, passo 1, e seção
 * 21).
 */
export async function lerNumeroMeta(
  token: string,
  phoneId: string,
  opcoes?: OpcoesValidacao,
): Promise<({ ok: true } & NumeroMeta) | FalhaLigacoes> {
  if (!PHONE_ID.test(phoneId)) return msgLigacoes.metaTokenInvalido();
  const busca = new URLSearchParams({
    fields: "display_phone_number,whatsapp_business_manager_messaging_limit,health_status",
  });
  try {
    const r = await chamar(
      token,
      `${urlDoNumero(phoneId)}?${busca.toString()}`,
      { method: "GET" },
      opcoes,
    );
    const falha = falhaMeta(r, msgLigacoes.metaTokenInvalido);
    if (falha) return falha;
    const numero = (lerTexto(r.corpo, "display_phone_number") ?? "").replace(/\D/g, "");
    if (numero.length < 8 || numero.length > 15) return msgLigacoes.metaSemNumero();
    const limite = lerTexto(r.corpo, "whatsapp_business_manager_messaging_limit")?.trim();
    const saude = lerTexto(r.corpo, "health_status", "can_send_message")?.trim().toUpperCase();
    return {
      ok: true,
      numero,
      limite: limite && /^[A-Z0-9_]{1,40}$/.test(limite) ? limite : null,
      saude: saude && /^[A-Z_]{1,40}$/.test(saude) ? saude : null,
    };
  } catch (e) {
    return falhaDoErroMeta(e);
  }
}

/**
 * D19: o número já tem ligações na Meta? Lê as configurações de chamada (sem as senhas) e recusa
 * (meta_sip_em_uso) se as chamadas ou o SIP estão ligados (calling.status ou sip.status ENABLED,
 * D33), qualquer que seja o servidor, inclusive o da ElevenLabs, que pode ser de outra conta. Com
 * nada ligado, ainda recusa servidor de outro endereço, salvo com o SIP desligado de forma
 * explícita (sip.status DISABLED, D31). null = livre (sem servidor, só o da ElevenLabs desligado,
 * ou o SIP de outro sistema desligado, que o da ElevenLabs substitui).
 */
export async function conferirSipMeta(
  token: string,
  phoneId: string,
  opcoes?: OpcoesValidacao,
): Promise<FalhaLigacoes | null> {
  if (!PHONE_ID.test(phoneId)) return msgLigacoes.metaTokenInvalido();
  try {
    const r = await chamar(token, `${urlDoNumero(phoneId)}/settings`, { method: "GET" }, opcoes);
    const falha = falhaMeta(r, msgLigacoes.metaRecusou);
    if (falha) return falha;
    const chamadas = (lerTexto(r.corpo, "calling", "status") ?? "").trim().toUpperCase();
    const sip = (lerTexto(r.corpo, "calling", "sip", "status") ?? "").trim().toUpperCase();
    // D33: ligações já ligadas, para qualquer servidor, ocupam o número
    if (chamadas === "ENABLED" || sip === "ENABLED") return msgLigacoes.metaSipEmUso();
    const servidores = ler(r.corpo, "calling", "sip", "servers");
    if (!Array.isArray(servidores)) return null;
    const outroServidor = servidores.some((s) => {
      const host = (lerTexto(s, "hostname") ?? "").trim().toLowerCase();
      return host !== "" && host !== SIP_ELEVENLABS.hostname;
    });
    if (!outroServidor) return null;
    // D31: só um SIP desligado de forma explícita libera o servidor de outro sistema; sem o
    // campo, ou com outro valor, o número conta como ocupado
    return sip === "DISABLED" ? null : msgLigacoes.metaSipEmUso();
  } catch (e) {
    return falhaDoErroMeta(e);
  }
}

/**
 * Liga o SIP com as chamadas desligadas (spec 2.6, passo 3; D18). Na falha, `aplicado` diz se a Meta pode ter
 * aplicado mesmo assim: "nao" numa recusa (4xx), "talvez" em tempo esgotado, rede ou 5xx, quando
 * a desmontagem precisa desligar por garantia.
 */
export async function ligarSipMeta(
  token: string,
  phoneId: string,
  opcoes?: OpcoesValidacao,
): Promise<{ ok: true } | (FalhaLigacoes & { aplicado: "nao" | "talvez" })> {
  if (!PHONE_ID.test(phoneId)) return { ...msgLigacoes.metaTokenInvalido(), aplicado: "nao" };
  try {
    const r = await chamar(
      token,
      `${urlDoNumero(phoneId)}/settings`,
      { method: "POST", corpo: CORPO_LIGAR_SIP },
      opcoes,
    );
    const falha = falhaMeta(r, msgLigacoes.metaRecusou);
    if (!falha) return { ok: true };
    return { ...falha, aplicado: r.status >= 500 ? "talvez" : "nao" };
  } catch (e) {
    return { ...falhaDoErroMeta(e), aplicado: "talvez" };
  }
}

/**
 * A senha SIP que a Meta gerou para o servidor da ElevenLabs (GET settings com
 * include_sip_credentials=true). Só em memória.
 */
export async function lerSenhaSipMeta(
  token: string,
  phoneId: string,
  opcoes?: OpcoesValidacao,
): Promise<{ ok: true; senha: string } | FalhaLigacoes> {
  if (!PHONE_ID.test(phoneId)) return msgLigacoes.metaTokenInvalido();
  try {
    const r = await chamar(
      token,
      `${urlDoNumero(phoneId)}/settings?include_sip_credentials=true`,
      { method: "GET" },
      opcoes,
    );
    const falha = falhaMeta(r, msgLigacoes.metaFora);
    if (falha) return falha;
    const servidores = ler(r.corpo, "calling", "sip", "servers");
    if (!Array.isArray(servidores)) return msgLigacoes.metaSemSenha();
    for (const s of servidores) {
      if (lerTexto(s, "hostname") !== SIP_ELEVENLABS.hostname) continue;
      const senha = lerTexto(s, "sip_user_password");
      if (senha && senha.trim()) return { ok: true, senha };
    }
    return msgLigacoes.metaSemSenha();
  } catch (e) {
    return falhaDoErroMeta(e);
  }
}

/**
 * Liga as chamadas (spec 2.6, passo 5; D18), com o tronco já pronto. Na falha, a desmontagem
 * desliga as chamadas e o SIP de todo jeito (o app já tinha ligado o SIP).
 */
export async function ligarChamadasMeta(
  token: string,
  phoneId: string,
  opcoes?: OpcoesValidacao,
): Promise<{ ok: true } | FalhaLigacoes> {
  if (!PHONE_ID.test(phoneId)) return msgLigacoes.metaTokenInvalido();
  try {
    const r = await chamar(
      token,
      `${urlDoNumero(phoneId)}/settings`,
      { method: "POST", corpo: CORPO_LIGAR_CHAMADAS },
      opcoes,
    );
    return falhaMeta(r, msgLigacoes.metaRecusou) ?? { ok: true };
  } catch (e) {
    return falhaDoErroMeta(e);
  }
}

/** Desliga as ligações e o SIP. true = a Meta confirmou; false = ficou ligado (pendência). */
export async function desligarSipMeta(
  token: string,
  phoneId: string,
  opcoes?: OpcoesValidacao,
): Promise<boolean> {
  if (!PHONE_ID.test(phoneId) || !token.trim()) return false;
  try {
    const r = await chamar(
      token,
      `${urlDoNumero(phoneId)}/settings`,
      { method: "POST", corpo: CORPO_DESLIGAR_SIP },
      opcoes,
    );
    return r.status >= 200 && r.status < 300;
  } catch {
    return false;
  }
}

// ---------- a ligação de saída (seção 3) ----------

/** A permissão do lead e o que a Meta deixa fazer agora (GET /<phone>/call_permissions). */
export type PermissaoMeta = {
  /** "permanent" também é o padrão dos números com ligação por qualidade (sem pedido gravado). */
  status: "permanent" | "temporary" | "no_permission";
  /** ISO 8601, na temporária. */
  expiraEm: string | null;
  /** start_call: dá para ligar agora; liberaEm = quando o limite acaba, se ele trava. */
  ligar: { pode: boolean; liberaEm: string | null };
  /** send_call_permission_request: dá para pedir agora. */
  pedir: { pode: boolean; liberaEm: string | null };
};

function isoDeUnix(v: unknown): string | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0
    ? new Date(n * 1000).toISOString()
    : null;
}

function lerAcao(corpo: unknown, nome: string): { pode: boolean; liberaEm: string | null } {
  const acoes = ler(corpo, "actions");
  const a = Array.isArray(acoes) ? acoes.find((x) => lerTexto(x, "action_name") === nome) : null;
  if (!a) return { pode: false, liberaEm: null };
  const pode = ler(a, "can_perform_action") === true;
  const limites = ler(a, "limits");
  let liberaEm: string | null = null;
  if (!pode && Array.isArray(limites)) {
    // o limite que trava por mais tempo é o que manda
    for (const l of limites) {
      const iso = isoDeUnix(ler(l, "limit_expiration_time"));
      if (iso && (!liberaEm || iso > liberaEm)) liberaEm = iso;
    }
  }
  return { pode, liberaEm };
}

/** A permissão do lead `waId` (só dígitos) para a empresa ligar. */
export async function consultarPermissaoMeta(
  token: string,
  phoneId: string,
  waId: string,
  opcoes?: OpcoesValidacao,
): Promise<({ ok: true } & PermissaoMeta) | FalhaLigacoes> {
  if (!PHONE_ID.test(phoneId) || !/^\d{8,15}$/.test(waId)) return msgLigacoes.metaTokenInvalido();
  const busca = new URLSearchParams({ user_wa_id: waId });
  try {
    const r = await chamar(
      token,
      `${urlDoNumero(phoneId)}/call_permissions?${busca.toString()}`,
      { method: "GET" },
      opcoes,
    );
    const falha = falhaMeta(r, msgLigacoes.metaRecusou);
    if (falha) return falha;
    const bruto = (lerTexto(r.corpo, "permission", "status") ?? "").trim().toLowerCase();
    const status =
      bruto === "permanent" || bruto === "temporary" ? bruto : ("no_permission" as const);
    const expiraEm =
      status === "temporary"
        ? (isoDeUnix(ler(r.corpo, "permission", "expiration_time")) ??
          isoDeUnix(ler(r.corpo, "permission", "expiration")))
        : null;
    return {
      ok: true,
      status,
      expiraEm,
      ligar: lerAcao(r.corpo, "start_call"),
      pedir: lerAcao(r.corpo, "send_call_permission_request"),
    };
  } catch (e) {
    return falhaDoErroMeta(e);
  }
}

/** O corpo da mensagem interativa que pede a permissão para ligar. */
export function corpoPedidoPermissao(para: string, texto: string) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: para,
    type: "interactive",
    interactive: {
      type: "call_permission_request",
      action: { name: "call_permission_request" },
      body: { text: texto },
    },
  };
}

/** Manda o pedido de permissão ao lead `para` (só dígitos). Devolve o wamid. */
export async function pedirPermissaoMeta(
  token: string,
  phoneId: string,
  para: string,
  texto: string,
  opcoes?: OpcoesValidacao,
): Promise<{ ok: true; wamid: string } | FalhaLigacoes> {
  if (!PHONE_ID.test(phoneId) || !/^\d{8,15}$/.test(para)) return msgLigacoes.metaTokenInvalido();
  try {
    const r = await chamar(
      token,
      `${urlDoNumero(phoneId)}/messages`,
      { method: "POST", corpo: corpoPedidoPermissao(para, texto) },
      opcoes,
    );
    const falha = falhaMeta(r, msgLigacoes.metaRecusou);
    if (falha) return falha;
    const msgs = ler(r.corpo, "messages");
    const wamid = Array.isArray(msgs) ? lerTexto(msgs[0], "id") : undefined;
    return wamid ? { ok: true, wamid } : msgLigacoes.metaFora();
  } catch (e) {
    return falhaDoErroMeta(e);
  }
}

/** O corpo que liga a permissão automática de 7 dias para quem ligou (callback). */
export const CORPO_LIGAR_CALLBACK = { calling: { callback_permission_status: "ENABLED" } } as const;

/** Liga o callback no número (o upgrade de quem ativou antes da ligação de saída). */
export async function ligarCallbackMeta(
  token: string,
  phoneId: string,
  opcoes?: OpcoesValidacao,
): Promise<{ ok: true } | FalhaLigacoes> {
  if (!PHONE_ID.test(phoneId)) return msgLigacoes.metaTokenInvalido();
  try {
    const r = await chamar(
      token,
      `${urlDoNumero(phoneId)}/settings`,
      { method: "POST", corpo: CORPO_LIGAR_CALLBACK },
      opcoes,
    );
    return falhaMeta(r, msgLigacoes.metaRecusou) ?? { ok: true };
  } catch (e) {
    return falhaDoErroMeta(e);
  }
}
