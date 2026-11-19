// As variáveis dinâmicas que o início da ligação devolve à ElevenLabs (2.4
// e D9): a saudação, o Contexto atual em texto corrido (só quando o agente está atrás dele, L14 da
// a spec) e o que a Nina já sabe do lead. Puro: as
// leituras do banco ficam em banco.server.ts (lerContextoDaLigacao e lerLeadDaLigacao).
// O que veio do lead (nome, resumo, mensagens) passa por neutralizar, como no histórico da Nina
// de texto: não abre bloco do sistema nem finge "[equipe]".
import { CAMPOS_CONTEXTO, neutralizar, type ContextoNina } from "../ia/instrucoes";

/**
 * Teto do nina_lead. O Contexto não tem teto: ele vai inteiro no prompt do agente (L14 da
 * a spec); o limite do prompt é conferido em ligacoes-elevenlabs.ts.
 */
export const MAX_LEAD = 4_000;
/** Quantas mensagens recentes entram no nina_lead. */
export const MENSAGENS_DO_LEAD = 10;
const MAX_FALA = 500;
const MAX_NOME = 40;
const MAX_RESUMO = 1_000;

export const SAUDACAO_GENERICA = "Oi! Aqui é a Nina. Como posso te ajudar?";

function limpo(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function cortar(texto: string, max: number): string {
  return texto.length > max ? `${texto.slice(0, max - 1)}…` : texto;
}

/** O primeiro nome, só com letras (e hífen ou apóstrofo no meio); null se não houver. */
export function primeiroNome(nome: string | null | undefined): string | null {
  const primeiro = limpo(nome).split(/\s+/)[0] ?? "";
  const m = /^[\p{L}][\p{L}'’-]*/u.exec(primeiro);
  const so = m ? m[0].replace(/['’-]+$/, "") : "";
  if (!so) return null;
  return so.length > MAX_NOME ? so.slice(0, MAX_NOME) : so;
}

/** "Oi, <primeiro nome>! Aqui é a Nina. Como posso te ajudar?", ou a genérica sem nome. */
export function saudacaoDaLigacao(nome: string | null | undefined): string {
  const p = primeiroNome(nome);
  return p ? `Oi, ${p}! Aqui é a Nina. Como posso te ajudar?` : SAUDACAO_GENERICA;
}

/** O marcador do nome no modelo de saudação do agente ({nome}, sem diferença de caixa). */
const MARCADOR_NOME = String.raw`\{\s*nome\s*\}`;

/**
 * A saudação da ligação a partir do modelo do agente (2.2): {nome}
 * vira o primeiro nome do lead. Sem nome, o marcador sai com a vírgula ou o espaço que o prende
 * ("Oi, {nome}!" → "Oi!"; "{nome}, tudo bem?" → "Tudo bem?"). Modelo vazio, ou que só tinha o
 * nome, dá a genérica.
 */
/**
 * O aviso no chat da ligação de entrada que não completou: sem ele, a pessoa ligava, a ligação não
 * completava e nada mais acontecia. Sem o nome da empresa nem da Nina: vale para qualquer cópia.
 */
export function textoDoAvisoDeFalha(nome: string | null | undefined): string {
  const p = primeiroNome(nome);
  return (
    `${p ? `Oi, ${p}!` : "Oi!"} Vi que você me ligou, mas a ligação não completou. ` +
    "Pode me ligar de novo? Se preferir, me escreve aqui que eu te respondo por mensagem."
  );
}

export function saudacaoDoAgente(modelo: string, nome: string | null | undefined): string {
  const p = primeiroNome(nome);
  const limpar = (t: string) => t.replace(/[ \t]{2,}/g, " ").trim();
  if (p) return limpar(modelo.replace(new RegExp(MARCADOR_NOME, "gi"), p)) || SAUDACAO_GENERICA;
  const comecaPeloNome = new RegExp(String.raw`^\s*${MARCADOR_NOME}`, "i").test(modelo);
  let texto = limpar(
    modelo
      .replace(new RegExp(String.raw`\s*,\s*${MARCADOR_NOME}`, "gi"), "")
      .replace(new RegExp(String.raw`^\s*${MARCADOR_NOME}\s*[,!]?\s*`, "i"), "")
      .replace(new RegExp(String.raw`\s*${MARCADOR_NOME}`, "gi"), ""),
  );
  // a frase que começava pelo nome volta a começar com maiúscula
  if (comecaPeloNome && texto) texto = texto[0]!.toUpperCase() + texto.slice(1);
  return texto || SAUDACAO_GENERICA;
}

/** O Contexto em texto corrido, inteiro: um campo por parágrafo e as perguntas e respostas no fim. */
export function textoDoContexto(contexto: Partial<ContextoNina> | null | undefined): string {
  if (!contexto) return "";
  const partes: string[] = [];
  for (const [campo, rotulo] of CAMPOS_CONTEXTO) {
    const valor = limpo(contexto[campo]);
    if (valor) partes.push(`${rotulo}: ${valor}`);
  }
  const itens = Array.isArray(contexto.itens) ? contexto.itens : [];
  const qa: string[] = [];
  for (const item of itens) {
    if (!item || typeof item !== "object") continue;
    const pergunta = limpo((item as { pergunta?: unknown }).pergunta);
    const resposta = limpo((item as { resposta?: unknown }).resposta);
    if (pergunta && resposta) qa.push(`Pergunta: ${pergunta} Resposta: ${resposta}`);
  }
  if (qa.length > 0) partes.push(`Perguntas e respostas:\n${qa.join("\n")}`);
  return partes.join("\n\n");
}

/**
 * O agente está atrás do Contexto (L14 da spec): a última sincronia é de
 * antes da versão mais recente (ou nunca houve). Sem Contexto, nunca está atrás. O servidor (o
 * início da ligação e o Atualizar) e a tela (o aviso da aba Agentes) usam igual.
 */
export function agenteAtrasDoContexto(
  sincronizadoEm: string | null | undefined,
  contextoCriadoEm: string | null | undefined,
): boolean {
  if (!contextoCriadoEm) return false;
  if (!sincronizadoEm) return true;
  return Date.parse(sincronizadoEm) < Date.parse(contextoCriadoEm);
}

export type FalaDoLead = { quem: "Lead" | "Nina" | "Equipe"; texto: string };

export type DadosDoLead = {
  nome: string | null;
  etapa: string | null;
  resumo: string | null;
  /** Da mais antiga à mais nova; o texto já vem como o marcadorDe do histórico mostra. */
  falas: FalaDoLead[];
};

function umaLinha(texto: string): string {
  return neutralizar(texto.replace(/\s+/g, " ").trim());
}

/** O que a Nina já sabe do lead: nome, etapa, resumo e as últimas mensagens. */
export function textoDoLead(d: DadosDoLead): string {
  const linhas = [
    `Nome: ${cortar(umaLinha(d.nome ?? ""), 120) || "(não informado)"}`,
    `Etapa: ${cortar(umaLinha(d.etapa ?? ""), 120) || "(não informada)"}`,
    `Resumo: ${cortar(umaLinha(d.resumo ?? ""), MAX_RESUMO) || "(nenhum ainda)"}`,
  ];
  const falas = d.falas
    .map((f) => ({ quem: f.quem, texto: cortar(umaLinha(f.texto), MAX_FALA) }))
    .filter((f) => f.texto !== "");
  if (falas.length === 0) {
    linhas.push("Últimas mensagens: (nenhuma)");
  } else {
    linhas.push("Últimas mensagens:");
    for (const f of falas) linhas.push(`${f.quem}: ${f.texto}`);
  }
  return cortar(linhas.join("\n"), MAX_LEAD);
}
