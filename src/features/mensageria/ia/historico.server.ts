// Histórico que a Nina lê: as últimas 30 mensagens da conversa, sem as canceladas e sem as
// apagadas, em ordem de momento. Lead = user; Nina e equipe = assistant (equipe marcada com
// "[equipe]"). Raciocínio de rodadas antigas nunca entra: o histórico sai só das mensagens.
// O texto do lead passa por neutralizar (não abre bloco do sistema nem finge "[equipe]").
import type { ModelMessage } from "ai";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";

import {
  ehMensagemDeLigacao,
  ehRegistroDeLigacao,
  lerRegistroDeLigacao,
  PREFIXO_LIGACAO,
  textoConcluida,
  textoEmAndamento,
  textoNaoCompletada,
  type FalaGravada,
} from "../ligacoes/registro";
import { baixarArquivo } from "../nucleo/midia.server";
import { neutralizar } from "./instrucoes";

type Mensagem = Database["public"]["Tables"]["mensagens"]["Row"];

/** O que a linha de `ligacoes` acrescenta à mensagem do tipo "ligacao" (o resumo e as falas). */
export type LigacaoDoHistorico = {
  resumo: string | null;
  transcricao: FalaGravada[];
  /** A ligação desta rodada (a rodada depois da ligação): as falas vão até MAX_TRANSCRICAO_LIGACAO. */
  daRodada?: boolean;
  /**
   * A ligação foi feita pela empresa : o registro fica gravado como o
   * da entrada, mas não é fala do lead; o marcador diz quem ligou (Opus, PR #24).
   */
  saida?: boolean;
};

/** O começo do registro da ligação feita pela empresa (no lugar de "[ligação]"). */
export const PREFIXO_LIGACAO_SAIDA = "[ligação feita pela empresa]";

export type MensagemHistorico = Partial<Pick<Mensagem, "rodada_id">> & {
  /** Só na mensagem do tipo "ligacao": a linha de `ligacoes` dela (L16). */
  ligacao?: LigacaoDoHistorico | null;
} & Pick<
    Mensagem,
    | "id"
    | "direcao"
    | "origem"
    | "tipo"
    | "texto"
    | "transcricao"
    | "midia_caminho"
    | "midia_mime"
    | "midia_nome"
    | "midia_status"
  >;

export const LIMITE_HISTORICO = 30;
const COLUNAS =
  "id, direcao, origem, tipo, texto, transcricao, " +
  "midia_caminho, midia_mime, midia_nome, midia_status, rodada_id, momento";
/** Tipos de imagem que os três provedores aceitam em base64. */
const IMAGENS_ACEITAS = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
/** Acima disso a imagem vira marcador (limite de imagem da Anthropic em base64). */
const MAX_BYTES_IMAGEM = 5 * 1024 * 1024;
/**
 * Imagens que vão inteiras ao provedor: as desta rodada e, sem elas, as 2 mais recentes do
 * lead. As outras entram como "[imagem] <legenda>": baixar todas a cada rodada pesaria na
 * memória do Worker (3 rodadas em paralelo) e no tempo.
 */
export const MAX_IMAGENS_ANTIGAS = 2;
/** Teto da soma dos bytes das imagens mandadas numa rodada. */
export const MAX_BYTES_IMAGENS_RODADA = 8 * 1024 * 1024;

type LinhaHistorico = MensagemHistorico & Pick<Mensagem, "momento">;

/** Momento da última entrada do lead que é desta rodada. null = a rodada não tem entrada. */
async function limiteDaRodada(conversaId: string, rodadaId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("mensagens")
    .select("momento")
    .eq("conversa_id", conversaId)
    .eq("rodada_id", rodadaId)
    .eq("direcao", "entrada")
    .neq("status", "cancelada")
    .is("apagada_em", null)
    .order("momento", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("banco_historico");
  return (data as { momento?: string } | null)?.momento ?? null;
}

/**
 * Últimas mensagens da conversa. Com a rodada, as entradas do lead que chegaram depois da
 * última entrada desta rodada (sem rodada_id: vão para a rodada seguinte) ficam de fora, para
 * não serem respondidas duas vezes. O filtro roda no banco, antes do limite: uma rajada de
 * mensagens novas não encurta o histórico.
 * A rodada pura (retorno ou lembrete) não tem entrada: sem o corte, a mensagem que o lead mandar
 * enquanto ela roda entraria no histórico e seria respondida duas vezes (aqui e na rodada que essa
 * mensagem abre). `corteSemEntrada` (o início da rodada) faz o papel da última entrada: as entradas
 * com momento depois dele ficam de fora. Só vale quando a rodada não tem entrada.
 */
export async function carregarHistorico(
  conversaId: string,
  rodadaId?: string,
  corteSemEntrada?: string | null,
): Promise<MensagemHistorico[]> {
  const limite = rodadaId
    ? ((await limiteDaRodada(conversaId, rodadaId)) ?? corteSemEntrada ?? null)
    : null;
  // falhou: a bolha nunca chegou ao lead (a entrada nunca tem esse status)
  let consulta = supabaseAdmin
    .from("mensagens")
    .select(COLUNAS)
    .eq("conversa_id", conversaId)
    .not("status", "in", "(cancelada,falhou)")
    .is("apagada_em", null);
  if (rodadaId && limite) {
    // aspas: o momento tem ":" e "." e o id vem do banco
    consulta = consulta.or(
      `direcao.neq.entrada,rodada_id.eq."${rodadaId}",momento.lte."${limite}"`,
    );
  }
  const { data, error } = await consulta
    .order("momento", { ascending: false })
    .order("criado_em", { ascending: false })
    .limit(LIMITE_HISTORICO);
  if (error) throw new Error("banco_historico");
  let linhas = ((data ?? []) as unknown as LinhaHistorico[]).slice().reverse();
  if (rodadaId) linhas = await comRegistrosDaRodada(linhas, rodadaId);
  const comFalas = await comLigacoes(
    rodadaId ? entradasDaRodadaPorUltimo(linhas, rodadaId) : linhas,
  );
  return comFalas.map((m) =>
    m.ligacao && rodadaId && m.rodada_id === rodadaId
      ? { ...m, ligacao: { ...m.ligacao, daRodada: true } }
      : m,
  );
}

/**
 * O registro de ligação desta rodada sempre entra, mesmo fora das últimas LIMITE_HISTORICO: o
 * momento dele é o começo da ligação, e o lead que escreve muito durante ela o empurrava para fora
 * (a rodada depois da ligação ficava sem o combinado). Entra na ordem do momento.
 */
async function comRegistrosDaRodada(
  linhas: LinhaHistorico[],
  rodadaId: string,
): Promise<LinhaHistorico[]> {
  const { data, error } = await supabaseAdmin
    .from("mensagens")
    .select(COLUNAS)
    .eq("rodada_id", rodadaId)
    .eq("direcao", "entrada")
    .eq("tipo", "ligacao")
    .is("apagada_em", null);
  if (error) throw new Error("banco_historico");
  const ja = new Set(linhas.map((m) => m.id));
  const faltam = ((data ?? []) as unknown as LinhaHistorico[]).filter((m) => !ja.has(m.id));
  if (faltam.length === 0) return linhas;
  const momento = (m: LinhaHistorico) => Date.parse(String(m.momento ?? ""));
  return [...linhas, ...faltam].sort((a, b) => momento(a) - momento(b));
}

/**
 * As entradas desta rodada vão para o fim do histórico, na ordem delas. A que chega enquanto a
 * rodada anterior roda tem o momento anterior à resposta daquela rodada: pela ordem do momento, o
 * histórico terminava na Nina, ganhava o "[sem mensagem nova do lead]", e a Nina escrevia ao lead
 * que não havia mensagem nova (na Nina vitrine, 29 mensagens em 21 conversas, 13 a 15/11/2026).
 * Nada desta rodada foi respondido ainda: o que a Nina mandou depois delas responde a outra coisa.
 * Puro.
 */
export function entradasDaRodadaPorUltimo<
  T extends Pick<MensagemHistorico, "direcao" | "rodada_id" | "origem">,
>(linhas: T[], rodadaId: string): T[] {
  // só as que vêm depois da última resposta de fora da Nina (a equipe, pelo app ou pelo celular):
  // as anteriores a ela a equipe já respondeu (a conversa devolvida à Nina traz para a rodada nova
  // todas as entradas soltas do tempo com a equipe) e ficam no lugar delas
  let corte = -1;
  linhas.forEach((m, i) => {
    if (m.direcao === "saida" && m.origem !== "nina") corte = i;
  });
  const vai = new Set(
    linhas
      .map((m, i) => (i > corte && m.direcao === "entrada" && m.rodada_id === rodadaId ? i : -1))
      .filter((i) => i >= 0),
  );
  return [...linhas.filter((_, i) => !vai.has(i)), ...linhas.filter((_, i) => vai.has(i))];
}

/**
 * As mensagens do tipo "ligacao" ganham o resumo e as falas da linha de `ligacoes` (L16): a Nina de
 * texto continua sabendo o que foi dito na ligação (D3). Uma ida ao banco, só quando há ligação.
 */
async function comLigacoes<T extends MensagemHistorico>(linhas: T[]): Promise<T[]> {
  const ids = linhas.filter(ehMensagemDeLigacao).map((m) => m.id);
  if (ids.length === 0) return linhas;
  const { data, error } = await supabaseAdmin
    .from("ligacoes")
    .select("mensagem_id, resumo, transcricao, direcao")
    .in("mensagem_id", ids);
  if (error) throw new Error("banco_historico");
  const porMensagem = new Map(
    (
      (data ?? []) as {
        mensagem_id: string | null;
        resumo: string | null;
        transcricao: unknown;
        direcao?: string | null;
      }[]
    )
      .filter((l) => l.mensagem_id)
      .map((l) => [
        l.mensagem_id!,
        {
          resumo: l.resumo,
          transcricao: Array.isArray(l.transcricao) ? (l.transcricao as FalaGravada[]) : [],
          ...(l.direcao === "saida" ? { saida: true } : {}),
        },
      ]),
  );
  return linhas.map((m) =>
    ehMensagemDeLigacao(m) ? { ...m, ligacao: porMensagem.get(m.id) ?? null } : m,
  );
}

type Parte = { type: "text"; text: string } | { type: "file"; data: Uint8Array; mediaType: string };

function textoDe(m: MensagemHistorico): string {
  return (m.texto ?? "").trim();
}

type Limpeza = (texto: string) => string;
const igual: Limpeza = (t) => t;

/** Teto da transcrição de uma ligação no histórico (2.7). */
export const MAX_TRANSCRICAO_HISTORICO = 4_000;
/**
 * As falas de uma ligação no histórico: uma ligação de 10 a 30 min passa de 4 mil letras, e a
 * rodada depois da ligação precisa do que ficou combinado (cortado com o começo e o fim).
 */
export const MAX_TRANSCRICAO_LIGACAO = 12_000;

/**
 * O registro de uma ligação (2.7): a linha "[ligação] …" (montada aqui,
 * nunca o texto cru), o resumo e, havendo, "Transcrição:" com a transcrição cortada. O resumo e a
 * transcrição saem da fala do lead: passam por `limpar`.
 */
function marcadorDaLigacao(m: MensagemHistorico, limpar: Limpeza): string {
  const lido = lerRegistroDeLigacao(m.texto);
  const cabeca = !lido
    ? PREFIXO_LIGACAO
    : lido.fase === "andamento"
      ? textoEmAndamento()
      : lido.fase === "falhou"
        ? textoNaoCompletada()
        : textoConcluida(lido.segundos ?? 0);
  const partes = [cabeca];
  const resumo = limpar((lido?.resumo ?? "").trim());
  if (resumo) partes.push(resumo);
  const transcricao = (m.transcricao ?? "").trim().slice(0, MAX_TRANSCRICAO_HISTORICO);
  if (transcricao) partes.push(`Transcrição:\n${limpar(transcricao)}`);
  return partes.join("\n");
}

/**
 * A ligação da tela de Ligações (L16): "[ligação]" com o rótulo da mensagem ("2 min 54 s", "em
 * andamento", "não completada"), o resumo e as falas da linha de `ligacoes`, cortadas.
 */
function marcadorDaLigacaoNova(m: MensagemHistorico, limpar: Limpeza): string {
  const rotulo = textoDe(m)
    .replace(/^Ligação\s*·?\s*/, "")
    .trim();
  const prefixo = m.ligacao?.saida ? PREFIXO_LIGACAO_SAIDA : PREFIXO_LIGACAO;
  const partes = [rotulo ? `${prefixo} ${rotulo}` : prefixo];
  const resumo = limpar((m.ligacao?.resumo ?? "").trim());
  if (resumo) partes.push(resumo);
  const falas = cortarComecoEFim(
    (m.ligacao?.transcricao ?? [])
      .filter((f) => f && typeof f.texto === "string" && f.texto.trim())
      .map((f) => `${f.papel === "nina" ? "Nina" : "Lead"}: ${f.texto.trim()}`)
      .join("\n"),
    // a ligação desta rodada com as falas longas; as outras, no teto de sempre (custo de cada rodada)
    m.ligacao?.daRodada ? MAX_TRANSCRICAO_LIGACAO : MAX_TRANSCRICAO_HISTORICO,
  );
  if (falas) partes.push(`Transcrição:\n${limpar(falas)}`);
  return partes.join("\n");
}

/**
 * O texto longo cortado com o começo e o fim: numa ligação longa, o que foi combinado costuma estar
 * no fim (a rodada depois da ligação manda o que a voz combinou). Puro.
 */
export function cortarComecoEFim(texto: string, max: number): string {
  if (texto.length <= max) return texto;
  const marca = "\n[…]\n";
  const comeco = Math.floor((max - marca.length) * 0.4);
  const fim = max - marca.length - comeco;
  return `${texto.slice(0, comeco)}${marca}${texto.slice(texto.length - fim)}`;
}

/** Nome de arquivo do lead dentro do marcador: sem colchetes nem quebra de linha. */
function nomeSeguro(nome: string): string {
  return neutralizar(nome.replace(/\s+/g, " "))
    .replace(/\[/g, "［")
    .replace(/\]/g, "］")
    .slice(0, 120);
}

/**
 * Texto que representa a mensagem (sem a imagem). Com `limpar`, o texto, a transcrição e o
 * nome do arquivo (o que veio do lead) passam por ela; os marcadores, não.
 */
export function marcadorDe(m: MensagemHistorico, limpar: Limpeza = igual): string {
  const texto = limpar(textoDe(m));
  const legenda = texto ? ` ${texto}` : "";
  switch (m.tipo) {
    case "texto":
      return texto;
    case "audio": {
      const t = limpar((m.transcricao ?? "").trim());
      return t ? `[áudio] ${t}` : "[áudio sem transcrição]";
    }
    case "imagem":
      return `[imagem]${legenda}`;
    case "documento": {
      const nome = (m.midia_nome ?? "").trim();
      const exibido = limpar === igual ? nome : nomeSeguro(nome);
      return `[documento: ${exibido || "sem nome"}]${legenda}`;
    }
    case "video":
      return `[vídeo]${legenda}`;
    case "figurinha":
      return "[figurinha]";
    default:
      if (ehMensagemDeLigacao(m)) return marcadorDaLigacaoNova(m, limpar);
      return ehRegistroDeLigacao(m) ? marcadorDaLigacao(m, limpar) : "[mensagem não suportada]";
  }
}

type Orcamento = { bytes: number };

function imagemCopiada(m: MensagemHistorico): boolean {
  return m.tipo === "imagem" && m.midia_status === "copiada" && Boolean(m.midia_caminho);
}

/** Ids das imagens que podem ir inteiras: as da rodada; sem elas, as 2 mais recentes. */
export function imagensParaMandar(mensagens: MensagemHistorico[], rodadaId?: string): Set<string> {
  const doLead = mensagens.filter((m) => m.direcao === "entrada" && imagemCopiada(m));
  const daRodada = rodadaId ? doLead.filter((m) => m.rodada_id === rodadaId) : [];
  const escolhidas = daRodada.length > 0 ? daRodada : doLead.slice(-MAX_IMAGENS_ANTIGAS);
  return new Set(escolhidas.map((m) => m.id));
}

async function partesDoLead(
  m: MensagemHistorico,
  mandar: Set<string>,
  orcamento: Orcamento,
): Promise<Parte[]> {
  if (imagemCopiada(m) && m.midia_caminho && mandar.has(m.id)) {
    try {
      const arquivo = await baixarArquivo(m.midia_caminho);
      const mime = (m.midia_mime || arquivo.mime || "").split(";")[0]?.trim().toLowerCase() ?? "";
      const tamanho = arquivo.bytes.byteLength;
      if (
        IMAGENS_ACEITAS.has(mime) &&
        tamanho <= MAX_BYTES_IMAGEM &&
        orcamento.bytes + tamanho <= MAX_BYTES_IMAGENS_RODADA
      ) {
        orcamento.bytes += tamanho;
        const partes: Parte[] = [{ type: "file", data: arquivo.bytes, mediaType: mime }];
        const legenda = neutralizar(textoDe(m));
        if (legenda) partes.push({ type: "text", text: legenda });
        return partes;
      }
    } catch {
      // sem a imagem, a Nina vê o marcador
    }
  }
  const texto = marcadorDe(m, neutralizar);
  return texto ? [{ type: "text", text: texto }] : [];
}

function textoDaEquipe(m: MensagemHistorico): string {
  // o áudio da Nina (a voz dela) entra como o texto falado, sem "[áudio]": o marcador descreve
  // o que o lead mandou (P6). O áudio da equipe continua com o marcador.
  if (m.origem === "nina" && m.tipo === "audio") return (m.transcricao ?? "").trim();
  const texto = marcadorDe(m);
  if (!texto) return "";
  return m.origem === "nina" ? texto : `[equipe] ${texto}`;
}

/**
 * O fim do histórico da rodada pura de retorno: o aviso do sistema no lugar do "[sem mensagem nova
 * do lead]", que o modelo repetia ao lead como bastidor. O lead não finge este marcador: o "[" do
 * começo de linha do texto dele vira "［" (instrucoes.ts, neutralizar).
 */
export const MARCADOR_RETORNO = "[o lead não escreveu de novo: chegou a hora do retorno combinado]";
/** O mesmo, na rodada pura de lembrete. */
export const MARCADOR_LEMBRETE =
  "[o lead não respondeu à sua última mensagem: chegou a hora do lembrete]";

export type OpcoesHistorico = {
  /** Rodada atual: as imagens dela vão inteiras ao provedor; as outras, como marcador. */
  rodadaId?: string;
  /**
   * Linha "Agora:" e bloco <dados_do_contato>, que entram como 1ª parte da última mensagem do
   * lado do lead.
   */
  dadosContato?: string;
  /**
   * O aviso que fecha o histórico da rodada pura (MARCADOR_RETORNO, MARCADOR_LEMBRETE). Sem ele,
   * o histórico que termina na Nina fecha com "[sem mensagem nova do lead]", como sempre. Com ele,
   * o aviso entra sempre no fim, também quando o histórico já termina no lead (as instruções da
   * rodada dizem que o histórico termina com o aviso do sistema).
   */
  marcadorSemMensagem?: string;
};

/**
 * Monta as mensagens do modelo. Mensagens seguidas do mesmo lado viram uma só (com várias
 * partes). A conversa sempre começa e termina com o lead, para nenhum provedor tratar a última
 * fala da Nina como começo de resposta. Os dados do contato vão no fim (e não nas instruções
 * nem no começo), para o começo do pedido ficar igual entre rodadas e aproveitar o cache.
 */
export async function montarHistorico(
  mensagens: MensagemHistorico[],
  opcoes: OpcoesHistorico = {},
): Promise<ModelMessage[]> {
  const blocos: { papel: "user" | "assistant"; partes: Parte[] }[] = [];
  const mandar = imagensParaMandar(mensagens, opcoes.rodadaId);
  const orcamento: Orcamento = { bytes: 0 };
  for (const m of mensagens) {
    const papel = m.direcao === "entrada" ? "user" : "assistant";
    const partes: Parte[] =
      papel === "user"
        ? await partesDoLead(m, mandar, orcamento)
        : (() => {
            const t = textoDaEquipe(m);
            return t ? [{ type: "text" as const, text: t }] : [];
          })();
    if (partes.length === 0) continue;
    const ultimo = blocos.at(-1);
    if (ultimo && ultimo.papel === papel) ultimo.partes.push(...partes);
    else blocos.push({ papel, partes });
  }

  if (blocos[0]?.papel !== "user") {
    blocos.unshift({ papel: "user", partes: [{ type: "text", text: "[início da conversa]" }] });
  }
  const aviso = opcoes.marcadorSemMensagem;
  if (blocos.at(-1)?.papel !== "user") {
    blocos.push({
      papel: "user",
      partes: [{ type: "text", text: aviso ?? "[sem mensagem nova do lead]" }],
    });
  } else if (aviso) {
    blocos.at(-1)?.partes.push({ type: "text", text: aviso });
  }
  if (opcoes.dadosContato) {
    blocos.at(-1)?.partes.unshift({ type: "text", text: opcoes.dadosContato });
  }

  return blocos.map((b): ModelMessage => {
    if (b.papel === "user") return { role: "user", content: b.partes };
    const textos = b.partes.filter((p): p is { type: "text"; text: string } => p.type === "text");
    return { role: "assistant", content: textos };
  });
}
