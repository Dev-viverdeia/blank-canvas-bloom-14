// Conferência das chamadas da ElevenLabs (D13). Puro (WebCrypto), sempre
// em tempo constante; nada aqui lança erro nem devolve o segredo.
// - início e ferramenta: "Authorization: Bearer <ligacaoToken>";
// - pós-chamada: "ElevenLabs-Signature: t=<segundos>,v0=<hex>", HMAC-SHA256 de "<t>.<corpo cru>"
//   com o ligacaoHmac, aceito até TOLERANCIA_ASSINATURA_S do relógio (a ElevenLabs reenvia).
import { iguaisEmTempoConstante, textosIguais } from "../gateways/meta/assinatura";
import { TOLERANCIA_ASSINATURA_S } from "./tipos";

const codificador = new TextEncoder();
/** Teto do cabeçalho de assinatura (um "t=" e até 3 "v0="). */
const MAX_CABECALHO = 512;
const MAX_ASSINATURAS = 3;

/** O cabeçalho Authorization é exatamente "Bearer <token>". Token vazio nunca confere. */
export function bearerConfere(
  cabecalho: string | null | undefined,
  token: string | undefined,
): boolean {
  if (!cabecalho || !token || token.trim() === "") return false;
  return textosIguais(cabecalho, `Bearer ${token}`);
}

function hexParaBytes(texto: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(texto)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(texto.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function hmac(segredo: string, texto: string): Promise<Uint8Array> {
  const chave = await crypto.subtle.importKey(
    "raw",
    codificador.encode(segredo),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", chave, codificador.encode(texto)));
}

/** Monta o cabeçalho como a ElevenLabs manda (os testes usam para assinar o corpo). */
export async function assinarPosChamada(
  segredo: string,
  corpoCru: string,
  t: number,
): Promise<string> {
  const assinatura = await hmac(segredo, `${t}.${corpoCru}`);
  return `t=${t},v0=${Array.from(assinatura, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

type CabecalhoLido = { t: string; assinaturas: string[] };

/** O formato e o horário do ElevenLabs-Signature, sem o corpo. null = recusado. */
function lerCabecalho(cabecalho: string | null | undefined, agoraS: number): CabecalhoLido | null {
  if (!cabecalho || cabecalho.length > MAX_CABECALHO) return null;
  const pedacos = cabecalho.split(",").map((p) => p.trim());
  const tempos = pedacos.filter((p) => p.startsWith("t="));
  const assinaturas = pedacos.filter((p) => p.startsWith("v0="));
  if (tempos.length !== 1 || assinaturas.length < 1 || assinaturas.length > MAX_ASSINATURAS) {
    return null;
  }
  const t = tempos[0]!.slice(2);
  if (!/^\d{9,11}$/.test(t)) return null;
  if (Math.abs(agoraS - Number(t)) > TOLERANCIA_ASSINATURA_S) return null;
  if (!assinaturas.some((a) => hexParaBytes(a.slice(3)) !== null)) return null;
  return { t, assinaturas };
}

/**
 * O cabeçalho tem o formato e o horário de uma assinatura válida? Roda antes de ler o corpo (até
 * 8 MB): quem só sabe a URL não faz o servidor ler o corpo inteiro. Não confere o HMAC.
 */
export function cabecalhoPosChamadaPlausivel(
  cabecalho: string | null | undefined,
  agoraS: number = Math.floor(Date.now() / 1000),
): boolean {
  return lerCabecalho(cabecalho, agoraS) !== null;
}

/** Confere o ElevenLabs-Signature contra o corpo cru. agoraS = segundos desde 1970. */
export async function assinaturaPosChamadaConfere(
  cabecalho: string | null | undefined,
  corpoCru: string,
  segredo: string | undefined,
  agoraS: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!segredo) return false;
  const lido = lerCabecalho(cabecalho, agoraS);
  if (!lido) return false;
  const { t, assinaturas } = lido;
  try {
    // o "t" exatamente como veio, que é o que a ElevenLabs assinou
    const esperada = await hmac(segredo, `${t}.${corpoCru}`);
    let confere = false;
    // todas comparadas, sem parar na primeira que confere
    for (const a of assinaturas) {
      const recebida = hexParaBytes(a.slice(3));
      if (recebida && iguaisEmTempoConstante(esperada, recebida)) confere = true;
    }
    return confere;
  } catch {
    return false;
  }
}
