// A ligação nas telas. Duas formas (ligacoes/registro.ts):
// - a da primeira versão (2.3 e 2.7): o texto cru "[ligação] …", que a
//   conversa e a prévia da lista trocam pelo título curto;
// - a da tela de Ligações (L16): a mensagem do tipo "ligacao", com o
//   rótulo já no texto ("Ligação · 2 min 54 s"); resumo e transcrição vêm da linha de `ligacoes`.

import {
  PREFIXO_LIGACAO,
  andamentoVencido,
  duracaoLegivel,
  ehMensagemDeLigacao,
  ehRegistroDeLigacao,
  lerRegistroDeLigacao,
  tituloDaLigacao,
  type RegistroLido,
} from "@/features/mensageria/ligacoes/registro";

export { ehMensagemDeLigacao, ehRegistroDeLigacao };

/** O texto começa como um registro de ligação (a prévia gravada no banco não guarda o tipo). */
export function textoDeLigacao(texto: string | null | undefined): boolean {
  return typeof texto === "string" && texto.trimStart().startsWith(PREFIXO_LIGACAO);
}

/** O registro lido; o texto de ligação fora do formato (a prévia cortada) vale como "Ligação" sem dados. */
export function lerLigacao(texto: string | null | undefined): RegistroLido | null {
  return lerRegistroDeLigacao(typeof texto === "string" ? texto.trimStart() : texto);
}

/**
 * O título do registro: "Ligação · 3 min 12 s", "Ligação em andamento", "Ligação sem resumo" ou
 * "Ligação não completada". Fora do formato, só "Ligação". null quando o texto não é de ligação.
 */
export function tituloDoRegistro(
  texto: string | null | undefined,
  momento?: string | null | undefined,
  agoraMs: number = Date.now(),
): string | null {
  if (!textoDeLigacao(texto)) return null;
  const lido = lerLigacao(texto);
  return lido ? tituloDaLigacao(lido, momento ?? undefined, agoraMs) : "Ligação";
}

/**
 * O título de uma mensagem de ligação, das duas formas: a do tipo "ligacao" já tem o rótulo no texto
 * (o "em andamento" velho vira "Ligação sem resumo", como na primeira versão); a antiga é lida do
 * texto cru. null quando não é ligação.
 */
export function tituloDaMensagemDeLigacao(
  m: {
    tipo: string | null | undefined;
    texto: string | null | undefined;
    momento?: string | null | undefined;
  },
  agoraMs: number = Date.now(),
): string | null {
  if (ehMensagemDeLigacao(m)) {
    const texto = (m.texto ?? "").trim() || "Ligação";
    return texto === "Ligação em andamento" && m.momento && andamentoVencido(m.momento, agoraMs)
      ? "Ligação sem resumo"
      : texto;
  }
  if (!ehRegistroDeLigacao(m)) return null;
  return tituloDoRegistro(m.texto, m.momento, agoraMs) ?? "Ligação";
}

/** O título a partir da linha de `ligacoes` (o bloco do Chat, quando ela já chegou). */
export function tituloDaLinhaDeLigacao(
  l: {
    status: "em_andamento" | "concluida" | "nao_completada";
    duracaoS: number | null;
    iniciadaEm: string;
  },
  agoraMs: number = Date.now(),
): string {
  if (l.status === "nao_completada") return "Ligação não completada";
  if (l.status === "em_andamento")
    return andamentoVencido(l.iniciadaEm, agoraMs) ? "Ligação sem resumo" : "Ligação em andamento";
  return l.duracaoS ? `Ligação · ${duracaoLegivel(l.duracaoS)}` : "Ligação";
}

/** A prévia gravada (conversas.ultima_mensagem_preview) para a lista: a de ligação vira o título. */
export function previaLegivel(
  previa: string | null | undefined,
  momento?: string | null | undefined,
): string | null | undefined {
  return tituloDoRegistro(previa, momento) ?? previa;
}

export type FalaLigacao = { quem: string; fala: string };

/** A transcrição gravada ("Lead: …" / "Nina: …", uma fala por linha) em falas; linha sem quem vai inteira. */
export function falasDaTranscricao(transcricao: string): FalaLigacao[] {
  const falas: FalaLigacao[] = [];
  for (const linha of transcricao.split("\n")) {
    const t = linha.trim();
    if (!t) continue;
    const m = /^(Lead|Nina):\s*(.*)$/.exec(t);
    falas.push(m ? { quem: m[1]!, fala: m[2]! } : { quem: "", fala: t });
  }
  return falas;
}
