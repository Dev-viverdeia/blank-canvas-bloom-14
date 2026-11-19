// Token de sessão da ligação (2.4). O início devolve o token na variável
// secreta da ElevenLabs; a ferramenta "passar para a equipe" o recebe de volta no cabeçalho
// X-Nina-Sessao e só mexe na conversa que ele diz. Formato:
//   base64url(JSON {v:1, c:<conversa_id>, l:<conversa na ElevenLabs>, e:<expira em segundos>})
//   + "." + HMAC-SHA256 hex do primeiro pedaço,
// com a chave derivada do ligacaoToken: HMAC(ligacaoToken, "nina-sessao-v1"). Vale 15 minutos.
// Puro (WebCrypto): nada aqui lança erro nem devolve o segredo.
import { iguaisEmTempoConstante } from "../gateways/meta/assinatura";
import { SESSAO_VALIDA_S } from "./tipos";

const codificador = new TextEncoder();
const ROTULO_CHAVE = "nina-sessao-v1";
/** Teto do token: o JSON tem dois ids curtos e um número. */
const MAX_TOKEN = 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Id da conversa na ElevenLabs (ex.: "conv_..."). */
export const ID_CONVERSA_ELEVEN = /^[A-Za-z0-9_-]{5,120}$/;

export type Sessao = { conversaId: string; conversaEleven: string; expiraEm: number };

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexParaBytes(texto: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(texto)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(texto.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function base64url(texto: string): string {
  const bytes = codificador.encode(texto);
  let binario = "";
  for (const b of bytes) binario += String.fromCharCode(b);
  return btoa(binario).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function deBase64url(texto: string): string | null {
  try {
    const binario = atob(texto.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binario, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function hmac(chave: Uint8Array<ArrayBuffer> | string, texto: string): Promise<ArrayBuffer> {
  const bruta = typeof chave === "string" ? codificador.encode(chave) : chave;
  const k = await crypto.subtle.importKey("raw", bruta, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return crypto.subtle.sign("HMAC", k, codificador.encode(texto));
}

async function chaveDaSessao(ligacaoToken: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await hmac(ligacaoToken, ROTULO_CHAVE));
}

/** Monta o token. agoraS = segundos desde 1970 (os testes fixam). */
export async function assinarSessao(
  ligacaoToken: string,
  conversaId: string,
  conversaEleven: string,
  agoraS: number = Math.floor(Date.now() / 1000),
  /** Quantos segundos vale (validadeDaSessao); nunca mais que SESSAO_VALIDA_S. */
  validadeS: number = SESSAO_VALIDA_S,
): Promise<string> {
  const vale = Math.max(1, Math.min(Math.floor(validadeS), SESSAO_VALIDA_S));
  const corpo = base64url(
    JSON.stringify({ v: 1, c: conversaId, l: conversaEleven, e: agoraS + vale }),
  );
  return `${corpo}.${hex(await hmac(await chaveDaSessao(ligacaoToken), corpo))}`;
}

/** Confere o token: assinatura, formato e validade. null = recusado (sem dizer por quê). */
export async function lerSessao(
  ligacaoToken: string | undefined,
  token: string | null | undefined,
  agoraS: number = Math.floor(Date.now() / 1000),
): Promise<Sessao | null> {
  if (!ligacaoToken || !token || token.length > MAX_TOKEN) return null;
  const partes = token.split(".");
  if (partes.length !== 2) return null;
  const [corpo, assinatura] = partes as [string, string];
  if (!/^[A-Za-z0-9_-]+$/.test(corpo)) return null;
  const recebida = hexParaBytes(assinatura);
  if (!recebida) return null;
  try {
    const esperada = new Uint8Array(await hmac(await chaveDaSessao(ligacaoToken), corpo));
    if (!iguaisEmTempoConstante(esperada, recebida)) return null;
  } catch {
    return null;
  }
  const json = deBase64url(corpo);
  if (json === null) return null;
  let valor: unknown;
  try {
    valor = JSON.parse(json);
  } catch {
    return null;
  }
  if (!valor || typeof valor !== "object" || Array.isArray(valor)) return null;
  const { v, c, l, e } = valor as Record<string, unknown>;
  if (v !== 1 || typeof c !== "string" || !UUID.test(c)) return null;
  if (typeof l !== "string" || !ID_CONVERSA_ELEVEN.test(l)) return null;
  if (typeof e !== "number" || !Number.isInteger(e)) return null;
  // vencido, ou com validade maior do que a que o servidor dá (folga de 1 minuto no relógio)
  if (e <= agoraS || e > agoraS + SESSAO_VALIDA_S + 60) return null;
  return { conversaId: c, conversaEleven: l, expiraEm: e };
}
