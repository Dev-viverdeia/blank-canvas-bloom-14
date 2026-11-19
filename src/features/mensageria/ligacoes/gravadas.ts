// O estado gravado em conexoes.parametros.ligacoes (2.1): ler com
// segurança e manter nos caminhos que regravam a conexão. Puro: nada aqui toca no banco nem na
// rede.
import {
  CHAVE_ELEGIBILIDADE,
  CHAVE_PARAMETROS,
  ehPendenciaLigacoes,
  SEGREDOS_LIGACOES,
  type LigacoesGravadas,
  type PendenciaLigacoes,
} from "./tipos";

const SITUACOES = ["ativando", "ativa", "com_pendencias"] as const;

/** Um objeto JSON (não null, não lista). Os arquivos das ligações leem o que vem de fora por ele. */
export function ehObjeto(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function textoOuNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * O estado das ligações guardado nos parametros da conexão. null = não há (ou não é um objeto).
 * Campo fora do formato vira o valor neutro (id null, lista vazia), para a desmontagem seguir.
 */
export function lerLigacoesGravadas(parametros: unknown): LigacoesGravadas | null {
  if (!ehObjeto(parametros)) return null;
  const l = parametros[CHAVE_PARAMETROS];
  if (!ehObjeto(l)) return null;
  const eleven = ehObjeto(l["eleven"]) ? l["eleven"] : {};
  const situacao = (SITUACOES as readonly unknown[]).includes(l["situacao"])
    ? (l["situacao"] as LigacoesGravadas["situacao"])
    : "com_pendencias";
  const pendencias = Array.isArray(l["pendencias"])
    ? l["pendencias"].filter(ehPendenciaLigacoes)
    : [];
  return {
    versao: 1,
    situacao,
    origem: typeof l["origem"] === "string" ? l["origem"] : "",
    numero: typeof l["numero"] === "string" ? l["numero"].replace(/\D/g, "") : "",
    limiteMeta: textoOuNull(l["limiteMeta"]),
    ativadaEm: textoOuNull(l["ativadaEm"]),
    eleven: {
      segredoId: textoOuNull(eleven["segredoId"]),
      webhookId: textoOuNull(eleven["webhookId"]),
      ferramentaId: textoOuNull(eleven["ferramentaId"]),
      agenteId: textoOuNull(eleven["agenteId"]),
      troncoId: textoOuNull(eleven["troncoId"]),
    },
    metaSip: l["metaSip"] === true,
    // a ligação de saída : o tronco tem a saída e o callback está ligado
    ...(l["saida"] === true ? { saida: true } : {}),
    pendencias,
    // sem o campo (gravado antes da D20), conta como antigo
    atualizadaEm: textoOuNull(l["atualizadaEm"]) ?? "",
  };
}

/** Os recursos que o estado diz que existem, na ordem da desmontagem (D17), com a Meta antes. */
const RECURSOS: readonly [keyof LigacoesGravadas["eleven"], PendenciaLigacoes][] = [
  ["troncoId", "tronco"],
  ["agenteId", "agente"],
  ["ferramentaId", "ferramenta"],
  ["webhookId", "webhook"],
  ["segredoId", "segredo"],
];

/**
 * Uma ativação parada (D20): "ativando" sem gravação há mais de `limiteMs`. O estado sem
 * atualizadaEm (ou com uma data que não se lê) conta como antigo.
 */
export function ativacaoAbandonada(
  l: LigacoesGravadas,
  agoraMs: number,
  limiteMs: number,
): boolean {
  if (l.situacao !== "ativando") return false;
  const em = Date.parse(l.atualizadaEm);
  return !Number.isFinite(em) || agoraMs - em > limiteMs;
}

/** O que a ativação já criou: "meta" (o SIP ligado pelo app) e os ids não nulos (D20). */
export function criadosNaAtivacao(l: LigacoesGravadas): PendenciaLigacoes[] {
  const lista: PendenciaLigacoes[] = l.metaSip ? ["meta"] : [];
  for (const [campo, nome] of RECURSOS) if (l.eleven[campo]) lista.push(nome);
  return lista;
}

/**
 * Os parametros e os segredos novos de uma conexão que vai ser regravada (consertar um campo,
 * conferir, salvar o mesmo número), com o estado das ligações e os dois segredos delas mantidos
 * como estavam (spec 2.1). Os segredos podem estar em texto puro ou já cifrados: só são copiados.
 * A última verificação das ligações (seção 21) fica só se o que ela conferiu não mudou: o mesmo
 * phoneId e o mesmo token, comparados como vieram (cifrado de novo conta como mudado).
 */
export function manterLigacoes<S extends string>(
  antigos: { parametros: Record<string, unknown>; segredos: Record<string, S> },
  novos: { parametros: Record<string, unknown>; segredos: Record<string, S> },
): { parametros: Record<string, unknown>; segredos: Record<string, S> } {
  const parametros = { ...novos.parametros };
  if (CHAVE_PARAMETROS in antigos.parametros && !(CHAVE_PARAMETROS in parametros)) {
    parametros[CHAVE_PARAMETROS] = antigos.parametros[CHAVE_PARAMETROS];
  }
  const mesmoNumero =
    antigos.parametros["phoneId"] !== undefined &&
    antigos.parametros["phoneId"] === parametros["phoneId"] &&
    antigos.segredos["token"] !== undefined &&
    antigos.segredos["token"] === novos.segredos["token"];
  if (CHAVE_ELEGIBILIDADE in antigos.parametros && !(CHAVE_ELEGIBILIDADE in parametros)) {
    if (mesmoNumero) parametros[CHAVE_ELEGIBILIDADE] = antigos.parametros[CHAVE_ELEGIBILIDADE];
  }
  const segredos = { ...novos.segredos };
  for (const nome of SEGREDOS_LIGACOES) {
    const valor = antigos.segredos[nome];
    if (valor !== undefined && segredos[nome] === undefined) segredos[nome] = valor;
  }
  return { parametros, segredos };
}
