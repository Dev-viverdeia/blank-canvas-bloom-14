// O registro da ligação na conversa. Duas formas convivem:
// - a da primeira versão (2.3): uma mensagem de entrada do tipo "outro", com
//   o texto começando por "[ligação]" e a transcrição na coluna transcricao. Nada novo é gravado
//   assim, mas as antigas continuam aparecendo;
// - a da tela de Ligações (L16): uma mensagem do tipo "ligacao", com o
//   rótulo no texto ("Ligação · 2 min 54 s"); resumo e transcrição moram na linha de `ligacoes`.
// Puro: o servidor e a tela usam igual.
import { DURACAO_MAX_AGENTE_S, FOLGA_LIGACAO_S } from "./tipos";

export const PREFIXO_LIGACAO = "[ligação]";
/** O começo do id_externo de um registro de ligação (nunca é um id do gateway). */
export const PREFIXO_ID_LIGACAO = "ligacao:";
const PREFIXO_ID = PREFIXO_ID_LIGACAO;

/**
 * Depois disso, um registro "em andamento" é mostrado como sem resumo (o pós-chamada não veio): a
 * duração máxima que um agente aceita (30 min) mais a folga (L38). Uma ligação de verdade nunca
 * passa disso.
 */
export const ANDAMENTO_MAX_MS = (DURACAO_MAX_AGENTE_S + FOLGA_LIGACAO_S) * 1000;
/**
 * Teto das letras da transcrição gravada (L39): uma ligação de 30 min tem umas 30.000 letras de
 * fala (cerca de 150 palavras por minuto); 100.000 cabe com folga. Passando, o corte fica marcado.
 */
export const MAX_TRANSCRICAO = 100_000;
/** O que fecha a última fala de uma transcrição cortada no teto. */
export const MARCA_TRANSCRICAO_CORTADA =
  "(transcrição cortada: a ligação passou do tamanho gravado)";
/** Teto do resumo gravado no texto. */
export const MAX_RESUMO = 2_000;

export type FaseLigacao = "andamento" | "concluida" | "falhou";
export type RegistroLido = { fase: FaseLigacao; segundos?: number; resumo?: string };

/** id_externo do registro: o id da conversa na ElevenLabs, com o prefixo. */
export function idExternoDaLigacao(conversaEleven: string): string {
  return PREFIXO_ID + conversaEleven;
}

/** O id da conversa na ElevenLabs, a partir do id_externo; null se não for de ligação. */
export function conversaDoIdExterno(idExterno: string | null | undefined): string | null {
  return idExterno && idExterno.startsWith(PREFIXO_ID) ? idExterno.slice(PREFIXO_ID.length) : null;
}

export function textoEmAndamento(): string {
  return `${PREFIXO_LIGACAO} em andamento`;
}

export function textoConcluida(segundos: number, resumo?: string | null): string {
  const s = Number.isFinite(segundos) && segundos > 0 ? Math.round(segundos) : 0;
  const r = (resumo ?? "").trim().slice(0, MAX_RESUMO);
  return r
    ? `${PREFIXO_LIGACAO} concluída (${s} s)\n${r}`
    : `${PREFIXO_LIGACAO} concluída (${s} s)`;
}

export function textoNaoCompletada(): string {
  return `${PREFIXO_LIGACAO} não completada`;
}

/** A mensagem de ligação da primeira versão: tipo "outro" com o texto "[ligação] …". */
export function ehRegistroAntigoDeLigacao(m: {
  tipo: string | null | undefined;
  texto: string | null | undefined;
}): boolean {
  return m.tipo === "outro" && typeof m.texto === "string" && m.texto.startsWith(PREFIXO_LIGACAO);
}

/** A mensagem de ligação da tela de Ligações (L16): tipo "ligacao", com o rótulo no texto. */
export function ehMensagemDeLigacao(m: { tipo: string | null | undefined }): boolean {
  return m.tipo === "ligacao";
}

/** Uma ligação na conversa, de qualquer das duas formas. */
export function ehRegistroDeLigacao(m: {
  tipo: string | null | undefined;
  texto: string | null | undefined;
}): boolean {
  return ehMensagemDeLigacao(m) || ehRegistroAntigoDeLigacao(m);
}

/** Lê o texto do registro. null quando não é um registro de ligação reconhecível. */
export function lerRegistroDeLigacao(texto: string | null | undefined): RegistroLido | null {
  if (typeof texto !== "string" || !texto.startsWith(PREFIXO_LIGACAO)) return null;
  const resto = texto.slice(PREFIXO_LIGACAO.length).trimStart();
  if (resto.startsWith("em andamento")) return { fase: "andamento" };
  if (resto.startsWith("não completada")) return { fase: "falhou" };
  const m = /^concluída \((\d+) s\)(?:\n([\s\S]*))?$/.exec(resto);
  if (!m) return null;
  const resumo = (m[2] ?? "").trim();
  return resumo
    ? { fase: "concluida", segundos: Number(m[1]), resumo }
    : { fase: "concluida", segundos: Number(m[1]) };
}

/** Em andamento há tempo demais: o pós-chamada não chegou. */
export function andamentoVencido(momento: string, agoraMs: number = Date.now()): boolean {
  const t = Date.parse(momento);
  return Number.isFinite(t) && agoraMs - t > ANDAMENTO_MAX_MS;
}

/** "3 min 12 s", "45 s", "10 min". */
export function duracaoLegivel(segundos: number): string {
  const s = Math.max(0, Math.round(segundos));
  const min = Math.floor(s / 60);
  const resto = s % 60;
  if (min === 0) return `${resto} s`;
  return resto === 0 ? `${min} min` : `${min} min ${resto} s`;
}

/** O título curto do registro, para o bloco da conversa e a prévia da lista. */
export function tituloDaLigacao(lido: RegistroLido, momento?: string, agoraMs?: number): string {
  if (lido.fase === "falhou") return "Ligação não completada";
  if (lido.fase === "andamento") {
    return momento && andamentoVencido(momento, agoraMs)
      ? "Ligação sem resumo"
      : "Ligação em andamento";
  }
  return lido.segundos ? `Ligação · ${duracaoLegivel(lido.segundos)}` : "Ligação";
}

type FalaEleven = { role?: unknown; message?: unknown; time_in_call_secs?: unknown };

// ---------- as marcas de emoção ----------

/**
 * As marcas de emoção e de jeito de falar que o modelo de voz da ElevenLabs lê (as "audio tags":
 * "[excited]", "[laughs]", "[short pause]"): em inglês, minúsculas, entre colchetes. A fala gravada
 * vem com elas, e elas não são texto da conversa.
 */
const MARCAS_DE_EMOCAO = new Set([
  "excited",
  "happy",
  "sad",
  "slow",
  "fast",
  "calm",
  "curious",
  "serious",
  "friendly",
  "warm",
  "cheerful",
  "thoughtful",
  "surprised",
  "nervous",
  "frustrated",
  "annoyed",
  "angry",
  "confused",
  "sarcastic",
  "playful",
  "mischievous",
  "empathetic",
  "reassuring",
  "concerned",
  "enthusiastic",
  "professional",
  "relieved",
  "hesitant",
  "sympathetic",
  "apologetic",
  "amused",
  "impressed",
  "laugh",
  "laughs",
  "laughing",
  "chuckle",
  "chuckles",
  "giggle",
  "giggles",
  "sigh",
  "sighs",
  "gasp",
  "gasps",
  "whisper",
  "whispers",
  "shout",
  "shouts",
  "cry",
  "cries",
  "crying",
  "sniff",
  "exhales",
  "inhales",
  "clears throat",
  "pause",
  "short pause",
  "long pause",
  "breathes",
  "smiles",
  "smiling",
  "nods",
  "hmm",
  "um",
  "uh",
  "emphasis",
  "softly",
  "quietly",
  "loudly",
]);

/** Uma palavra ou locução em inglês, minúsculas, de 1 a 3 palavras (o formato de uma marca). */
const FORMATO_MARCA = /^[a-z]+(?:[ -][a-z]+){0,2}$/;

/** O conteúdo entre colchetes é uma marca: da lista, ou um advérbio ou gerúndio em inglês ("[warmly]", "[whispering]"). */
function ehMarcaDeEmocao(dentro: string): boolean {
  const t = dentro.trim();
  if (!FORMATO_MARCA.test(t)) return false;
  if (MARCAS_DE_EMOCAO.has(t)) return true;
  // sem acento e terminado em -ly ou -ing: não é português
  return t.split(/[ -]/).some((p) => /^[a-z]{3,}(?:ly|ing)$/.test(p));
}

/**
 * Tira as marcas de emoção ("[excited]", "[short pause]") de uma fala, sem mexer em outro texto
 * entre colchetes ("[ligação]", "[link do contrato]"). Junta os espaços que sobram.
 */
export function semMarcasDeEmocao(texto: string): string {
  return texto
    .replace(/\[([^[\]\n]{1,40})\]/g, (inteiro, dentro: string) =>
      ehMarcaDeEmocao(dentro) ? " " : inteiro,
    )
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

// ---------- a transcrição ----------

/** Uma fala da transcrição gravada em `ligacoes.transcricao` (2.1). */
export type FalaGravada = { papel: "lead" | "nina"; texto: string; segundos: number };

/** Teto de falas gravadas (uma ligação de 30 minutos tem bem menos). */
export const MAX_FALAS = 1_500;
const MAX_FALA = 2_000;

/**
 * As falas do transcript da ElevenLabs no formato gravado: `user` vira "lead", `agent` vira "nina",
 * `time_in_call_secs` vira os segundos. Sem as marcas de emoção, sem falas vazias e com teto (o
 * total de letras em MAX_TRANSCRICAO, MAX_FALAS falas). Cortada no teto, a última fala gravada
 * termina com MARCA_TRANSCRICAO_CORTADA.
 */
export function falasDaLigacao(transcript: unknown): FalaGravada[] {
  if (!Array.isArray(transcript)) return [];
  const falas: FalaGravada[] = [];
  let total = 0;
  let cortada = false;
  for (const item of transcript as FalaEleven[]) {
    if (!item || typeof item !== "object") continue;
    const papel = item.role === "agent" ? "nina" : item.role === "user" ? "lead" : null;
    if (!papel) continue;
    const bruto = typeof item.message === "string" ? item.message.replace(/\s+/g, " ") : "";
    const texto = semMarcasDeEmocao(bruto).slice(0, MAX_FALA);
    if (!texto) continue;
    if (total + texto.length > MAX_TRANSCRICAO || falas.length >= MAX_FALAS) {
      cortada = true;
      break;
    }
    total += texto.length;
    const t = item.time_in_call_secs;
    const segundos = typeof t === "number" && Number.isFinite(t) && t > 0 ? Math.floor(t) : 0;
    falas.push({ papel, texto, segundos });
  }
  const ultima = falas[falas.length - 1];
  if (cortada && ultima) ultima.texto = `${ultima.texto} ${MARCA_TRANSCRICAO_CORTADA}`;
  return falas;
}

/**
 * Por que a ligação terminou, num código curto que a tela conhece (o `metadata.termination_reason`
 * da ElevenLabs é uma frase em inglês, sem lista fechada na documentação). Fora do que se
 * reconhece, null. A ordem importa: o silêncio e a duração vêm antes do "end_call", porque o
 * encerramento por silêncio também cita o end_call ("silence_end_call_timeout").
 */
export function motivoDoFim(motivo: unknown): string | null {
  if (typeof motivo !== "string" || !motivo.trim()) return null;
  const m = motivo.toLowerCase();
  if (m.includes("silence") || m.includes("inactiv")) return "silence";
  if (m.includes("duration") || m.includes("maximum")) return "max_duration";
  if (m.includes("end_call") || m.includes("end call") || m.includes("agent")) return "agent_ended";
  if (/client|user|remote|hang|disconnect/.test(m)) return "client_ended";
  if (m.includes("error") || m.includes("fail")) return "erro";
  return null;
}

/** Uma linha por fala ("Lead: …" ou "Nina: …"), sem falas vazias, cortada em MAX_TRANSCRICAO. */
export function transcricaoDaLigacao(transcript: unknown): string {
  if (!Array.isArray(transcript)) return "";
  const linhas: string[] = [];
  for (const item of transcript as FalaEleven[]) {
    if (!item || typeof item !== "object") continue;
    const fala =
      typeof item.message === "string" ? semMarcasDeEmocao(item.message.replace(/\s+/g, " ")) : "";
    if (!fala) continue;
    const quem = item.role === "agent" ? "Nina" : item.role === "user" ? "Lead" : null;
    if (!quem) continue;
    linhas.push(`${quem}: ${fala}`);
  }
  const texto = linhas.join("\n");
  return texto.length > MAX_TRANSCRICAO ? texto.slice(0, MAX_TRANSCRICAO) : texto;
}
