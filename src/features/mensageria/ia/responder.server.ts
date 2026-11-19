// Resposta da Nina numa rodada (tarefa F2 da spec da mensageria). O ciclo do worker chama esta
// função para cada rodada que pegar_rodadas devolver. Ela termina a rodada sempre por
// concluir_rodada ou falhar_rodada e grava uma linha de custo por passo em ia_chamadas, mesmo
// quando a rodada falha. Se lançar erro, o ciclo marca a rodada como falha passageira.
// O ciclo passa o prazo absoluto da chamada do worker (fimEm): a IA tem até o menor entre 90 s e
// fimEm - 3 s (abortSignal). Com menos de 10 s para a IA, a rodada falha como passageira logo de
// saída, antes da lida e do "digitando" (o lead não vê "digitando..." seguido de silêncio). Se o
// prazo acabar no meio, a rodada falha como passageira (erro_provedor) e volta no minuto
// seguinte, em vez de ficar presa em "rodando"; o custo dos passos que já terminaram é gravado
// do mesmo jeito. O passo que estava em andamento no abort não grava linha de custo: o AI SDK
// não devolve uso de pedido abortado, e o provedor pode ter cobrado a entrada dele (limite
// conhecido). Se a Nina já passou para humano antes do abort, a rodada é concluída sem bolhas
// (a conversa já está com a equipe; falhar_rodada não faria nada nela). Isso vale também quando o
// abort chega com a ferramenta passar_para_humano em execução: a rodada espera as ferramentas que
// já começaram a gravar no passo interrompido e as põe na auditoria (rodadas.ferramentas).
// Nada do lead, da resposta nem da chave vai para log ou para o texto de um erro.
// Modo fala (C1): quando a Nina responde em áudio (deveFalar), as
// instruções ganham o bloco de fala, "responder" recebe { fala, textos? } e a IA cede 6 s do
// prazo (se ainda sobrarem 10 s). A fala vira um áudio no bucket midias (<conversa>/<id>) e o
// concluir_rodada recebe o item de áudio seguido dos textos. Se a fala ou a gravação falhar, a
// resposta vai em texto na hora (bolhasSemFala), sem nova tentativa.
// Áudio sem transcrição (decisão 1): com algo para ler junto, a
// rodada segue normal (o histórico marca "[áudio sem transcrição]"). Só áudio: a Nina pede em
// texto para o lead escrever (bolha fixa, sem o modelo, nunca no modo fala); se a rodada anterior
// dela já pediu e o lead mandou áudio de novo depois de a bolha do pedido sair (decisão 9), sem
// escrever, a conversa vai para a equipe. Áudio ainda pendente (a cópia ou a transcrição vai ser tentada de novo) não é áudio sem
// Escuta: a rodada falha como passageira e volta em 30 s; na 3ª tentativa vai para a equipe.
// Conexão desligada no meio da rodada (decisões 11 e 16): o concluir_rodada que dá
// sem_conexao_ativa é refeito sem respostas; a rodada conclui sem mandar nada e nada vai para a
// equipe, no Desconectar e no Trocar de WhatsApp.
// Ligação (D7): a rodada cujas entradas são todas registros de ligação
// conclui vazia logo depois de ler o banco, sem chave, IA, "lida" nem "digitando".
// Retornos : a rodada sabe o que é pelo rodadas.retorno_id e pelas entradas:
// sem retorno_id é a do lead; com retorno_id e sem entrada é a pura (hora do retorno combinado ou do
// lembrete: bloco próprio, só responder, atualizar_contato e sem_resposta, sem lida nem digitando,
// no máximo MAX_PASSOS_PURA passos); com retorno_id e entradas é a mista (o lead falou na hora do
// retorno e o banco o levou junto). Uma leitura sem gravar (nina_retorno_da_rodada) traz o retorno
// para o bloco do fim. O servidor nunca compara instantes: o banco diz se a hora passou (vencido).
// O p_passos de toda conclusão depois da IA é >= 1 (0 é "sem IA" para o banco), e o erro na rodada
// pura vai para falharRodada, nunca para concluir com a lista vazia (o retorno ficaria dispensado).
import { generateText, isStepCount, type StepResult, type StopCondition } from "ai";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";

import { adaptadorDe } from "../gateways";
import { conversaDoIdExterno, ehRegistroDeLigacao } from "../ligacoes/registro";
import { destinoDoContato, falharRodada } from "../nucleo/banco.server";
import { carregarConexao, conexaoAtiva, type ChaveIA } from "../nucleo/conexoes.server";
import { caminhoMidia, enviarArquivo } from "../nucleo/midia.server";
import type { ConexaoServidor } from "../nucleo/tipos";
import { lerChaveUtilizavel, marcarStatusChave, reativarChave } from "./chaves.server";
import { bolhasSemFala, deveFalar, MAX_TEXTOS_FALA, RESERVA_FALA_MS } from "./fala";
import { falar, lerConfigVoz, vozEmUso } from "./falar.server";
import {
  carregarPrecos,
  custoDoProvedor,
  custoPorTabela,
  gravarChamadas,
  limparUsoBruto,
  normalizarUso,
  type LinhaPreco,
  type NovaChamada,
} from "./custo.server";
import { ehBastidor } from "./bastidor";
import { classificarErroIA } from "./erros";
import {
  criarFerramentas,
  normalizarEspera,
  type EstadoDoPasso,
  type EtapaNina,
  type FerramentasNina,
  type ResultadoFerramenta,
} from "./ferramentas.server";
import {
  carregarHistorico,
  MARCADOR_LEMBRETE,
  MARCADOR_RETORNO,
  montarHistorico,
} from "./historico.server";
import {
  blocoDoContato,
  linhaDoAgora,
  linhasDoRetorno,
  MAX_BOLHAS,
  montarInstrucoes,
  type ContatoNina,
  type ContextoNina,
  type InfoRetorno,
} from "./instrucoes";
import { bolhasDaMarcacao, temMarcacaoDeFerramenta } from "./marcacao";
import { criarModelo, opcoesDoProvedor } from "./modelo.server";
import { referenciaDaRodada } from "./quando";

export type Rodada = Database["public"]["Tables"]["rodadas"]["Row"];
export type { InfoRetorno };
type Motivo = Database["public"]["Enums"]["motivo_humano"];

export const MAX_PASSOS = 6;
/** Teto de passos da rodada pura (retorno e lembrete): são só 3 ferramentas e uma mensagem curta. */
export const MAX_PASSOS_PURA = 4;
/** Teto do tempo total da IA; com prazo do worker, vale o menor entre este e fimEm - 3 s. */
export const TEMPO_TOTAL_MS = 90_000;
/** Folga antes do fim do prazo do worker, para gravar o custo e o fim da rodada. */
export const FOLGA_PRAZO_IA_MS = 3_000;
/** Mínimo de tempo para a IA (tempoDaIA) para começar a rodada, a lida e o "digitando". */
export const MIN_TEMPO_IA_MS = 10_000;
export const TEMPO_PASSO_MS = 40_000;
export const MAX_REPETICOES = 2;
/** Teto da espera por lida e digitando no fim da rodada (rodam em paralelo com a IA). */
export const TETO_LIDA_DIGITANDO_MS = 3_000;

type Passo = StepResult<FerramentasNina>;

// ---------------------------------------------------------------------------
// Leitura do banco
// ---------------------------------------------------------------------------

type DadosRodada = {
  conversa: {
    id: string;
    contato_id: string;
    conexao_id: string | null;
    devolvida_em: string | null;
  };
  contato: (ContatoNina & { etapa_id: string }) | null;
  contexto: ContextoNina | null;
  etapas: { id: string; chave: string | null; nome: string; nina_pode_mover: boolean }[];
  entradas: {
    id_externo: string | null;
    tipo: string;
    texto: string | null;
    transcricao: string | null;
    midia_status: string | null;
    criado_em: string;
    /** a hora do provedor; na ligação, o começo da chamada: de onde "amanhã" é contado */
    momento: string | null;
  }[];
};

async function carregarDados(rodada: Rodada): Promise<DadosRodada | null> {
  const conversa = await supabaseAdmin
    .from("conversas")
    .select("id, contato_id, conexao_id, devolvida_em")
    .eq("id", rodada.conversa_id)
    .maybeSingle();
  if (conversa.error) throw new Error("banco_conversa");
  if (!conversa.data) return null;

  const contato = await supabaseAdmin
    .from("contatos")
    .select("nome, nome_whatsapp, telefone, email, empresa, resumo_nina, anotacoes_nina, etapa_id")
    .eq("id", conversa.data.contato_id)
    .maybeSingle();
  if (contato.error) throw new Error("banco_contato");

  const ctx =
    rodada.contexto_versao_id !== null
      ? supabaseAdmin
          .from("contexto_versoes")
          .select("*")
          .eq("id", rodada.contexto_versao_id)
          .maybeSingle()
      : supabaseAdmin
          .from("contexto_versoes")
          .select("*")
          .order("id", { ascending: false })
          .limit(1)
          .maybeSingle();
  const contexto = await ctx;
  if (contexto.error) throw new Error("banco_contexto");

  const etapas = await supabaseAdmin
    .from("etapas")
    .select("id, chave, nome, nina_pode_mover")
    .eq("arquivada", false)
    .order("ordem", { ascending: true });
  if (etapas.error) throw new Error("banco_etapas");

  const entradas = await supabaseAdmin
    .from("mensagens")
    .select("id_externo, tipo, texto, transcricao, midia_status, criado_em, momento")
    .eq("rodada_id", rodada.id)
    .eq("direcao", "entrada")
    // o último id é a entrada mais nova: a Meta marca como lida ela e as anteriores
    .order("momento", { ascending: true })
    .order("id", { ascending: true });
  if (entradas.error) throw new Error("banco_entradas");

  return {
    conversa: conversa.data,
    contato: contato.data ?? null,
    contexto: (contexto.data as ContextoNina | null) ?? null,
    etapas: etapas.data ?? [],
    entradas: entradas.data ?? [],
  };
}

// ---------------------------------------------------------------------------
// Áudio sem transcrição
// ---------------------------------------------------------------------------

/** A bolha fixa da rodada que é só áudio sem transcrição (sempre em texto). */
export const TEXTO_PEDIR_ESCRITA =
  "Não consigo ouvir áudio por aqui. Pode me escrever a sua mensagem?";

type Entrada = DadosRodada["entradas"][number];

function audioSemTranscricao(e: Entrada): boolean {
  return e.tipo === "audio" && (e.transcricao ?? "").trim() === "";
}

/**
 * Áudio que ainda vai ser baixado ou transcrito: o pegar_rodadas só espera a mídia pendente por
 * 2 min, e a 3ª tentativa dela pode cair depois disso.
 */
function audioPendente(e: Entrada): boolean {
  return audioSemTranscricao(e) && e.midia_status === "pendente";
}

/**
 * A rodada não tem nada que a Nina consiga ler: tem áudio sem transcrição e o resto é só texto
 * vazio. Imagem, documento, texto ou áudio transcrito junto = segue normal.
 */
function soAudioSemTranscricao(entradas: Entrada[]): boolean {
  return (
    entradas.some(audioSemTranscricao) &&
    entradas.every(
      (e) => audioSemTranscricao(e) || (e.tipo === "texto" && (e.texto ?? "").trim() === ""),
    )
  );
}

/** Teto da leitura dos textos do lead depois do pedido (basta um com conteúdo). */
const LIMITE_TEXTOS_DEPOIS = 50;

/** Quantas rodadas concluídas olhar para achar a última que não é de retorno nem de lembrete. */
const RODADAS_RECENTES = 10;

/** O que fazer com a rodada que é só áudio sem transcrição. */
type DepoisDoPedido =
  /** a Nina não pediu, ou o pedido não vale mais: pede em texto */
  | "pedir"
  /** pediu, e o lead mandou áudio de novo depois de a bolha do pedido sair: vai para a equipe */
  | "insistiu"
  /** pediu, mas os áudios desta rodada chegaram antes de a bolha do pedido sair: não repete a bolha */
  | "antes_do_pedido";

/** Status da bolha que já saiu para o lead (o concluir_envio grava momento = hora da saída). */
const SAIU = new Set(["enviada", "entregue", "lida"]);

/**
 * A rodada que tem a bolha do pedido: a própria rodada do pedir_texto ou, quando ela foi um
 * antes_do_pedido (concluiu sem bolha), a que ela aponta em entrada.pedido_rodada.
 */
function rodadaDaBolha(ferramentas: unknown, rodadaId: string): string | null {
  if (!Array.isArray(ferramentas)) return null;
  const pedido = ferramentas.find((c) => ehObjeto(c) && c["ferramenta"] === "pedir_texto");
  if (!ehObjeto(pedido)) return null;
  const entrada = pedido["entrada"];
  const aponta = ehObjeto(entrada) ? entrada["pedido_rodada"] : undefined;
  return typeof aponta === "string" && aponta !== "" ? aponta : rodadaId;
}

/**
 * Olha a última rodada concluída da Nina nesta conversa. O pedido (pedir_texto) só vale se veio
 * depois da última devolução para a Nina (devolvida_em, que também zera as tentativas no
 * pegar_rodadas), se a bolha dele existe, não foi cancelada nem falhou, e se o lead não mandou
 * texto depois. "Depois" do texto é pelo criado_em da rodada: as entradas que chegaram depois de
 * a rodada ser criada não são dela (pegar_rodadas liga as soltas na criação). Insistir é mandar
 * áudio depois de a bolha do pedido sair (decisão 9): com ela ainda na fila ou enviando, todo
 * áudio é antes_do_pedido; com ela enviada, entregue ou lida, o limite é o momento dela.
 * Devolve também a rodada da bolha, que o antes_do_pedido grava para a rodada seguinte.
 */
async function depoisDoPedido(
  rodada: Rodada,
  dados: DadosRodada,
): Promise<{ situacao: DepoisDoPedido; rodadaDaBolha: string | null }> {
  const pedir = { situacao: "pedir" as const, rodadaDaBolha: null };
  const recentes = await supabaseAdmin
    .from("rodadas")
    .select("id, ferramentas, criado_em, terminada_em, retorno_id")
    .eq("conversa_id", rodada.conversa_id)
    .eq("status", "concluida")
    .neq("id", rodada.id)
    .order("terminada_em", { ascending: false })
    .limit(RODADAS_RECENTES);
  if (recentes.error) throw new Error("banco_rodadas");
  // a rodada de retorno ou de lembrete PURA (retorno_id, sem entrada do lead) entre o pedido e o 2º
  // áudio não pediu nada: sem pular, o pedido de texto se repetia e a conversa só ia para a equipe
  // no 3º áudio. A mista (levou o retorno junto e respondeu ao lead, então tem entrada dele) conta
  // como rodada comum, e a que mandou o pedido tem o pedir_texto, e vale
  const recentesLista = recentes.data ?? [];
  const comRetorno = recentesLista.filter((r) => (r.retorno_id ?? null) !== null).map((r) => r.id);
  const comEntrada = new Set<string>();
  if (comRetorno.length > 0) {
    const entradas = await supabaseAdmin
      .from("mensagens")
      .select("rodada_id")
      .eq("conversa_id", rodada.conversa_id)
      .eq("direcao", "entrada")
      .neq("status", "cancelada")
      .in("rodada_id", comRetorno);
    if (entradas.error) throw new Error("banco_entradas");
    for (const m of entradas.data ?? []) if (m.rodada_id) comEntrada.add(m.rodada_id);
  }
  const r0 = recentesLista.find(
    (r) =>
      (r.retorno_id ?? null) === null ||
      comEntrada.has(r.id) ||
      rodadaDaBolha(r.ferramentas, r.id) !== null,
  );
  if (!r0) return pedir;
  const daBolha = rodadaDaBolha(r0.ferramentas, r0.id);
  if (daBolha === null) return pedir;

  const devolvida = dados.conversa.devolvida_em ?? null;
  if (devolvida !== null && Date.parse(r0.criado_em) <= Date.parse(devolvida)) return pedir;

  // a bolha do pedido que não chegou ao lead: nem foi criada (a rodada concluiu sem mandar),
  // cancelada no concluir_rodada ou falhou no envio
  const bolhas = await supabaseAdmin
    .from("mensagens")
    .select("status, momento")
    .eq("rodada_id", daBolha)
    .eq("direcao", "saida");
  if (bolhas.error) throw new Error("banco_entradas");
  const lista = bolhas.data ?? [];
  if (lista.length === 0 || lista.some((m) => m.status === "cancelada" || m.status === "falhou")) {
    return pedir;
  }

  const textos = await supabaseAdmin
    .from("mensagens")
    .select("texto")
    .eq("conversa_id", rodada.conversa_id)
    .eq("direcao", "entrada")
    .eq("tipo", "texto")
    .neq("status", "cancelada")
    .gt("criado_em", r0.criado_em)
    .limit(LIMITE_TEXTOS_DEPOIS);
  if (textos.error) throw new Error("banco_entradas");
  if ((textos.data ?? []).some((m) => (m.texto ?? "").trim() !== "")) return pedir;

  // a bolha ainda não saiu (na_fila ou enviando): o lead não viu o pedido
  const antes = { situacao: "antes_do_pedido" as const, rodadaDaBolha: daBolha };
  if (!lista.every((m) => SAIU.has(m.status))) return antes;
  const pedidoEm = Math.max(...lista.map((m) => Date.parse(m.momento)));
  return dados.entradas.some((e) => e.tipo === "audio" && Date.parse(e.criado_em) > pedidoEm)
    ? { situacao: "insistiu", rodadaDaBolha: daBolha }
    : antes;
}

// ---------------------------------------------------------------------------
// Lida e digitando (melhor esforço: nunca derruba a rodada)
// ---------------------------------------------------------------------------

/** Espera a promessa até `ms`; depois segue sem ela (ela nunca lança). */
async function esperarComTeto(p: Promise<void>, ms: number): Promise<void> {
  let relogio: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([p, new Promise<void>((ok) => (relogio = setTimeout(ok, ms)))]);
  } finally {
    if (relogio !== undefined) clearTimeout(relogio);
  }
}

async function marcarLidaEDigitando(d: DadosRodada): Promise<void> {
  try {
    let conexao: ConexaoServidor | null = d.conversa.conexao_id
      ? await carregarConexao(d.conversa.conexao_id)
      : null;
    // conexão desativada fica sem segredos: usa a ativa
    if (!conexao || Object.keys(conexao.segredos).length === 0) conexao = await conexaoAtiva();
    if (!conexao) return;
    const adaptador = adaptadorDe(conexao.gateway);
    if (!adaptador) return;
    const destino = await destinoDoContato(d.conversa.id, conexao.id);
    if (destino.length === 0) return;
    // os registros de ligação ("ligacao:<id>") não são ids do gateway (D25 da spec-ligacoes)
    const ids_externos = d.entradas
      .map((e) => e.id_externo)
      .filter((v): v is string => typeof v === "string" && v !== "" && !conversaDoIdExterno(v));
    await adaptador.marcarLidaEDigitando({ destino, ids_externos }, conexao);
  } catch {
    // ignorado de propósito
  }
}

// ---------------------------------------------------------------------------
// Resultado
// ---------------------------------------------------------------------------

type Chamada = { passo: number; ferramenta: string; entrada: unknown; resultado: unknown };

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * A entrada de um responder com o espera_resposta normalizado: "sim" e "nao" em texto e minúsculo,
 * ou sem o campo. O banco só arma o lembrete com exatamente 'sim' (lembrete_ao_concluir): sem
 * isto, um "Sim" ou um true do modelo não armaria nada, e sem erro nenhum. O esquema já normaliza;
 * aqui é a garantia de que a auditoria nunca leva o valor cru.
 */
function entradaNormalizada(ferramenta: string, entrada: unknown): unknown {
  if (ferramenta !== "responder" || !ehObjeto(entrada) || !("espera_resposta" in entrada)) {
    return entrada;
  }
  const { espera_resposta, ...resto } = entrada;
  const valor = normalizarEspera(espera_resposta);
  return valor === "sim" || valor === "nao" ? { ...resto, espera_resposta: valor } : resto;
}

/** Chamadas de ferramenta de todos os passos, para rodadas.ferramentas (auditoria). */
function chamadasDe(passos: Passo[]): Chamada[] {
  const lista: Chamada[] = [];
  passos.forEach((passo, i) => {
    for (const parte of passo.content) {
      if (parte.type === "tool-result") {
        lista.push({
          passo: i + 1,
          ferramenta: parte.toolName,
          entrada: entradaNormalizada(parte.toolName, parte.input),
          resultado: parte.output,
        });
      } else if (parte.type === "tool-error") {
        lista.push({
          passo: i + 1,
          ferramenta: parte.toolName,
          entrada: parte.input,
          resultado: { erro: "entrada_invalida" },
        });
      }
    }
  });
  return lista;
}

/**
 * Põe o espaço que o modelo às vezes esquece entre duas frases da mesma bolha ("desconto.Se tiver",
 * visto no Haiku em 12/11/2026). Só depois de ponto, exclamação ou interrogação seguidos de letra
 * maiúscula, e nunca dentro de um link (www.Site.com) nem de um número (R$ 1.042).
 */
export function separarFrasesGrudadas(bolha: string): string {
  return bolha
    .split(/(\s+)/)
    .map((pedaco) =>
      /^(https?:\/\/|www\.)/i.test(pedaco)
        ? pedaco
        : pedaco.replace(/([a-zà-ÿ][.!?])(?=[A-ZÀ-Þ])/g, "$1 "),
    )
    .join("");
}

/** Bolhas da última chamada válida de responder (no máximo 3, sem vazias). */
export function bolhasDaFerramenta(chamadas: Chamada[]): string[] | null {
  for (let i = chamadas.length - 1; i >= 0; i--) {
    const c = chamadas[i];
    if (!c || c.ferramenta !== "responder") continue;
    if (!ehObjeto(c.resultado) || c.resultado["ok"] !== true) continue;
    const bolhas = ehObjeto(c.entrada) ? c.entrada["bolhas"] : null;
    if (!Array.isArray(bolhas)) continue;
    const limpas = bolhas
      .filter((b): b is string => typeof b === "string")
      .map((b) => separarFrasesGrudadas(b.trim()))
      .filter((b) => b !== "");
    if (limpas.length > 0) return limpas.slice(0, MAX_BOLHAS);
  }
  return null;
}

/** Fala e textos da última chamada válida de responder no modo fala. null = nenhuma. */
export function falaDaFerramenta(chamadas: Chamada[]): { fala: string; textos: string[] } | null {
  for (let i = chamadas.length - 1; i >= 0; i--) {
    const c = chamadas[i];
    if (!c || c.ferramenta !== "responder") continue;
    if (!ehObjeto(c.resultado) || c.resultado["ok"] !== true) continue;
    if (!ehObjeto(c.entrada)) continue;
    const fala = c.entrada["fala"];
    if (typeof fala !== "string" || fala.trim() === "") continue;
    const brutos = c.entrada["textos"];
    const textos = (Array.isArray(brutos) ? brutos : [])
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim())
      .filter((t) => t !== "")
      .slice(0, MAX_TEXTOS_FALA);
    return { fala: fala.trim(), textos };
  }
  return null;
}

/**
 * Texto final em até 3 bolhas, separadas por linha em branco (o excesso vai na 3ª). Se o texto traz
 * uma chamada de ferramenta escrita à mão (marcacao.ts), valem só as bolhas que dá para tirar dela;
 * sem isso, nenhuma: a rodada termina sem nada para dizer e tenta de novo, em vez de mandar o
 * código ao lead.
 */
export function bolhasDoTexto(texto: string): string[] {
  if (temMarcacaoDeFerramenta(texto)) return limitarBolhas(bolhasDaMarcacao(texto) ?? []);
  return limitarBolhas(
    texto
      .split(/\n\s*\n/)
      .map((p) => separarFrasesGrudadas(p.trim()))
      .filter((p) => p !== ""),
  );
}

function limitarBolhas(partes: string[]): string[] {
  if (partes.length <= MAX_BOLHAS) return partes;
  return [...partes.slice(0, MAX_BOLHAS - 1), partes.slice(MAX_BOLHAS - 1).join("\n\n")];
}

/** Ferramenta que começou a gravar num passo que ainda não terminou (onStepEnd). */
type Execucao = { ferramenta: string; entrada: unknown; resultado: Promise<ResultadoFerramenta> };

/** Espera as execuções do passo interrompido e as devolve como chamadas do passo seguinte. */
async function chamadasEmAndamento(execucoes: Execucao[], passo: number): Promise<Chamada[]> {
  return Promise.all(
    execucoes.map(async (e) => ({
      passo,
      ferramenta: e.ferramenta,
      entrada: e.entrada,
      resultado: await e.resultado.catch(() => ({ erro: "erro_banco" })),
    })),
  );
}

function passouParaHumano(chamadas: Chamada[]): boolean {
  return chamadas.some(
    (c) =>
      c.ferramenta === "passar_para_humano" && ehObjeto(c.resultado) && c.resultado["ok"] === true,
  );
}

/** Para quando o último passo tem um responder aceito (entrada válida e executada). */
const FECHOS = new Set(["responder", "sem_resposta"]);

type ParteDoPasso = { type: string; toolName?: string; output?: unknown };

/**
 * O passo tem um marcar_retorno recusado (ou de entrada inválida) e nenhum aceito. O responder do
 * mesmo passo, escrito antes de ler a recusa, confirmaria ao lead um retorno que não existe: o laço
 * não para, e o modelo vê a recusa e responde de novo. Pura.
 */
export function passoCego(content: readonly ParteDoPasso[]): boolean {
  const marcas = content.filter(
    (p) => (p.type === "tool-result" || p.type === "tool-error") && p.toolName === "marcar_retorno",
  );
  const aceita = marcas.some(
    (p) => p.type === "tool-result" && ehObjeto(p.output) && p.output["ok"] === true,
  );
  return marcas.length > 0 && !aceita;
}

/** Só um fecho aceito para o laço: o responder recusado (bastidor, passo cego) pede outro. */
const respondeu: StopCondition<FerramentasNina> = ({ steps }) => {
  const ultimo = steps.at(-1);
  if (!ultimo || passoCego(ultimo.content)) return false;
  return ultimo.content.some(
    (p) =>
      p.type === "tool-result" &&
      FECHOS.has(p.toolName) &&
      ehObjeto(p.output) &&
      p.output["ok"] === true,
  );
};

/**
 * O responder (ou sem_resposta) aceito num passo em que o marcar_retorno foi recusado, e que o
 * modelo chamou ANTES da marcação, não vai ao lead: fica registrado como recusado. Assim a
 * auditoria (p_ferramentas) não o conta como resposta aceita, e o banco não arma lembrete com ele
 * (lembrete_ao_concluir só lê o responder com resultado.ok). Puro.
 */
export function descartarCegas(chamadas: Chamada[]): Chamada[] {
  const porPasso = new Map<number, Chamada[]>();
  for (const c of chamadas) porPasso.set(c.passo, [...(porPasso.get(c.passo) ?? []), c]);
  const cegos = new Set<number>();
  for (const [passo, lista] of porPasso) {
    const marcas = lista.filter((c) => c.ferramenta === "marcar_retorno");
    const aceita = marcas.some((c) => ehObjeto(c.resultado) && c.resultado["ok"] === true);
    if (marcas.length > 0 && !aceita) cegos.add(passo);
  }
  if (cegos.size === 0) return chamadas;
  return chamadas.map((c) =>
    cegos.has(c.passo) &&
    FECHOS.has(c.ferramenta) &&
    ehObjeto(c.resultado) &&
    c.resultado["ok"] === true
      ? { ...c, resultado: { erro: "retorno_recusado" } }
      : c,
  );
}

/** A rodada depois da ligação terminou com sem_resposta aceito ({ ok: true }). */
function semResposta(chamadas: Chamada[]): boolean {
  return chamadas.some(
    (c) =>
      c.ferramenta === "sem_resposta" &&
      typeof c.resultado === "object" &&
      c.resultado !== null &&
      (c.resultado as { ok?: unknown }).ok === true,
  );
}

/**
 * Esta rodada vem depois de uma ligação concluída (seção 7)? Os registros de
 * ligação entre as entradas (o id_externo "ligacao:<conversa na ElevenLabs>") e o status da ligação
 * de cada um. Uma ligação que não completou não conta (o aviso de falha já foi para o chat).
 * Falha na leitura lança (a rodada falha passageira e volta), para nunca consumir calada o registro
 * de uma ligação concluída.
 */
export async function ligacaoConcluidaNaRodada(
  entradas: readonly { id_externo: string | null; tipo: string; texto: string | null }[],
  agora: number = Date.now(),
): Promise<boolean> {
  const conversas = entradas
    .filter(ehRegistroDeLigacao)
    .map((e) => conversaDoIdExterno(e.id_externo))
    .filter((c): c is string => c !== null);
  if (conversas.length === 0) return false;
  const { data, error } = await supabaseAdmin
    .from("ligacoes")
    .select("status, encerrada_em, atualizado_em, passou_equipe")
    .in("id_externo", conversas);
  if (error || !data) throw new Error("banco_ligacoes");
  // só a que acabou há pouco: o registro de uma ligação antiga (a conversa passou para a equipe e
  // voltou dias depois) não faz da rodada nova uma rodada depois da ligação
  // a ligação passada para a equipe: o que ficou combinado é da equipe (a conversa voltou depois)
  return data.some((l) => ligacaoElegivel(l, agora));
}

/**
 * A ligação que faz da rodada uma rodada depois da ligação: concluída, sem a equipe, e fechada há
 * até DEPOIS_DA_LIGACAO_MS. A janela conta de quando a ligação foi fechada aqui (atualizado_em),
 * não do fim da chamada: a fechada tarde pelas presas tem o encerrada_em de quando a chamada
 * acabou. Pura.
 */
function ligacaoElegivel(
  l: {
    status: string;
    encerrada_em: string | null;
    atualizado_em?: string | null;
    passou_equipe: boolean | null;
  },
  agora: number,
): boolean {
  if (l.status !== "concluida" || l.passou_equipe || l.encerrada_em === null) return false;
  const momentos = [Date.parse(l.encerrada_em), Date.parse(l.atualizado_em ?? "")].filter(
    Number.isFinite,
  );
  return momentos.length > 0 && agora - Math.max(...momentos) <= DEPOIS_DA_LIGACAO_MS;
}

/**
 * Depois da rodada vazia (D7): a ligação de algum registro dela fechou como concluída enquanto a
 * rodada rodava? A primeira leitura (ligacaoConcluidaNaRodada) não a achou elegível; se uma segunda
 * achar, ela mudou no meio, e o rearme do pós-chamada não soltou o registro de uma rodada que ainda
 * rodava: solta e arma agora. Só a elegível (concluída, sem a equipe, fechada há até 30 min): uma
 * ligação antiga nunca é rearmada, senão cada rodada vazia armaria a seguinte (laço sem fim).
 * Nunca lança: o erro vai para o log.
 */
async function rearmarSeFechou(
  entradas: readonly { id_externo: string | null; tipo: string; texto: string | null }[],
  agora: number,
): Promise<void> {
  const conversas = entradas
    .filter(ehRegistroDeLigacao)
    .map((e) => conversaDoIdExterno(e.id_externo))
    .filter((c): c is string => c !== null);
  if (conversas.length === 0) return;
  try {
    const { data, error } = await supabaseAdmin
      .from("ligacoes")
      .select("id, status, encerrada_em, atualizado_em, passou_equipe")
      .in("id_externo", conversas);
    if (error) {
      console.error("rodada_rearmar_falhou", error.code ?? "ler");
      return;
    }
    for (const l of data ?? []) {
      if (!ligacaoElegivel(l, agora)) continue;
      const r = await supabaseAdmin.rpc("ligacao_rearmar_depois", { p_ligacao: l.id });
      if (r.error) console.error("rodada_rearmar_falhou", r.error.code ?? "rpc");
    }
  } catch {
    console.error("rodada_rearmar_falhou");
  }
}

/** Até quando depois do fim da ligação a rodada ainda é a rodada depois da ligação. */
export const DEPOIS_DA_LIGACAO_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Custo
// ---------------------------------------------------------------------------

function idDoPedido(passo: Passo): string | null {
  const h = passo.response.headers ?? {};
  return h["request-id"] ?? h["x-request-id"] ?? (passo.response.id || null);
}

/**
 * Custo do passo na OpenRouter: usage.cost (o que ela cobrou em créditos) mais, com chave
 * própria do provedor (BYOK), o custo upstream, que o provedor cobra direto e que não está no
 * usage.cost.
 */
export function custoDoOpenRouter(passo: Pick<Passo, "providerMetadata">): unknown {
  const meta = passo.providerMetadata?.["openrouter"];
  const uso = ehObjeto(meta) ? meta["usage"] : null;
  if (!ehObjeto(uso)) return undefined;
  const custo = uso["cost"];
  const detalhes = uso["costDetails"];
  const upstream = ehObjeto(detalhes) ? detalhes["upstreamInferenceCost"] : undefined;
  if (typeof upstream === "number" && Number.isFinite(upstream) && upstream > 0) {
    return (
      (typeof custo === "number" && Number.isFinite(custo) && custo > 0 ? custo : 0) + upstream
    );
  }
  return custo;
}

function linhasDeCusto(
  rodadaId: string,
  chave: ChaveIA,
  passos: Passo[],
  precos: LinhaPreco[],
): NovaChamada[] {
  return passos.map((passo, i) => {
    const uso = normalizarUso(passo.usage);
    const custo =
      chave.provedor === "openrouter"
        ? custoDoProvedor(custoDoOpenRouter(passo))
        : custoPorTabela(precos, uso, passo.usage.raw);
    return {
      rodada_id: rodadaId,
      tipo: "resposta",
      provedor: chave.provedor,
      modelo: chave.modelo,
      passo: i + 1,
      tokens_entrada: uso.entrada,
      tokens_cache_leitura: uso.cacheLeitura,
      tokens_cache_escrita: uso.cacheEscrita,
      tokens_saida: uso.saida,
      tokens_raciocinio: uso.raciocinio,
      custo_usd: custo.custo_usd,
      custo_origem: custo.custo_origem,
      preco_id: custo.preco_id,
      request_id: idDoPedido(passo),
      uso_bruto: limparUsoBruto(passo.usage.raw ?? null),
    };
  });
}

async function registrarCusto(rodadaId: string, chave: ChaveIA, passos: Passo[]): Promise<void> {
  if (passos.length === 0) return;
  try {
    const precos =
      chave.provedor === "openrouter" ? [] : await carregarPrecos(chave.provedor, chave.modelo);
    await gravarChamadas(linhasDeCusto(rodadaId, chave, passos, precos));
  } catch {
    // custo é registro; não derruba a rodada
  }
}

// ---------------------------------------------------------------------------
// Fim da rodada
// ---------------------------------------------------------------------------

/** O áudio da Nina, no formato do item de áudio do concluir_rodada (migration 0014). */
export type RespostaAudio = {
  tipo: "audio";
  id: string;
  transcricao: string;
  midia_caminho: string;
  midia_mime: string;
  midia_tamanho: number;
  midia_duracao_s: number | null;
};
export type RespostaRodada = { texto: string } | RespostaAudio;

async function concluir(
  rodadaId: string,
  respostas: RespostaRodada[],
  chamadas: Chamada[],
  passos: number,
): Promise<void> {
  const chamar = (itens: RespostaRodada[]) =>
    supabaseAdmin.rpc("concluir_rodada", {
      p_rodada: rodadaId,
      // os itens de texto nunca levam "tipo" (o concluir_rodada trata como texto)
      p_respostas: itens.map((r) => ("tipo" in r ? r : { texto: r.texto })) as Json,
      p_ferramentas: chamadas as unknown as Json,
      p_passos: passos,
    });
  const { error } = await chamar(respostas);
  if (!error) return;
  // conexão desligada no meio da rodada (decisões 11 e 16): conclui sem mandar nada (sem
  // respostas, o gatilho do insert não roda) e nada vai para a equipe, também no Trocar de
  // WhatsApp, que para a fila da antiga em silêncio. Se a conclusão vazia falhar, segue como antes
  if (error.message === "sem_conexao_ativa" && respostas.length > 0) {
    const vazia = await chamar([]);
    if (!vazia.error) return;
  }
  // gatilho do insert: não adianta repetir (comentário de concluir_rodada na migration 0002)
  if (error.message === "sem_conexao_ativa" || error.message === "janela_fechada") {
    await falharRodada(rodadaId, "erro_provedor", false);
    return;
  }
  throw new Error("banco_concluir_rodada");
}

async function falhar(rodadaId: string, motivo: Motivo, passageiro: boolean): Promise<void> {
  await falharRodada(rodadaId, motivo, passageiro);
}

// ---------------------------------------------------------------------------
// Rodada
// ---------------------------------------------------------------------------

export type OpcoesRodada = {
  /** Prazo absoluto da chamada do worker (Date.now()), vindo do ciclo. */
  fimEm?: number;
  /** Relógio da linha "Agora:" (ms desde 1970); sem ele, Date.now(). Os testes fixam a hora. */
  agora?: number;
};

/**
 * Tempo total da IA: o teto de 90 s, cortado pelo prazo do worker menos 3 s. No modo fala, a IA
 * cede 6 s para a fala caber no prazo, se ainda sobrarem 10 s; senão fica com o tempo de hoje.
 */
export function tempoDaIA(fimEm: number | undefined, modoFala = false): number {
  const base =
    fimEm === undefined || !Number.isFinite(fimEm)
      ? TEMPO_TOTAL_MS
      : Math.min(TEMPO_TOTAL_MS, fimEm - Date.now() - FOLGA_PRAZO_IA_MS);
  if (modoFala && base - RESERVA_FALA_MS >= MIN_TEMPO_IA_MS) return base - RESERVA_FALA_MS;
  return base;
}

/** Folga entre o fim da fala e o prazo do worker, para gravar o áudio e concluir a rodada. */
export const FOLGA_FALA_MS = 2_000;

/** A gravação do áudio no bucket termina até 1 s antes do prazo do worker, ou a resposta vai em texto. */
const TETO_GRAVACAO_ANTES_DO_FIM_MS = 1_000;

// O teste do bastidor (ehBastidor) mora em bastidor.ts: a ferramenta responder também o usa. O
// teste importa daqui.
export { ehBastidor };

/**
 * A resposta inteira da rodada é bastidor: tudo o que iria ao lead (a fala e os textos do modo
 * fala, as bolhas do responder ou o texto final) é raciocínio. Puro.
 */
export function respostaDeBastidor(chamadas: Chamada[], textoFinal: string): boolean {
  const daFala = falaDaFerramenta(chamadas);
  const partes = daFala
    ? [daFala.fala, ...daFala.textos]
    : (bolhasDaFerramenta(chamadas) ?? bolhasDoTexto(textoFinal));
  return partes.length > 0 && partes.every(ehBastidor);
}

/** Bolhas de texto no formato de concluir, sem bolha de bastidor (ehBastidor). */
function emTexto(bolhas: string[]): RespostaRodada[] {
  return bolhas.filter((t) => t !== "" && !ehBastidor(t)).map((texto) => ({ texto }));
}

/**
 * Se esta rodada responde em áudio, a voz escolhida; senão null. Erro na leitura = texto (a
 * fala nunca derruba a rodada).
 */
async function vozDaRodada(dados: DadosRodada): Promise<string | null> {
  try {
    const [config, emUso] = await Promise.all([lerConfigVoz(), vozEmUso()]);
    const sim = deveFalar({
      modo: config.modo,
      vozId: config.vozId,
      chaveEmUso: emUso,
      entradas: dados.entradas,
    });
    return sim ? config.vozId : null;
  } catch {
    return null;
  }
}

/**
 * Transforma a fala em áudio e o grava no bucket. Devolve as respostas da rodada: o áudio
 * seguido dos textos ou, se a fala ou a gravação falhar, tudo em texto (bolhasSemFala).
 */
async function respostasComFala(
  rodada: Rodada,
  vozId: string,
  fala: string,
  textos: string[],
  fimEm: number | undefined,
): Promise<RespostaRodada[]> {
  // a fala de bastidor nunca vira áudio: vão só os textos (já filtrados em emTexto)
  if (ehBastidor(fala)) return emTexto(textos);
  const emBolhas = () => emTexto(bolhasSemFala(fala, textos, MAX_BOLHAS));
  const r = await falar(fala, {
    vozId,
    rodadaId: rodada.id,
    conversaId: rodada.conversa_id,
    ...(fimEm === undefined ? {} : { fimEm: fimEm - FOLGA_FALA_MS }),
  });
  if (!r.ok) return emBolhas();
  const id = crypto.randomUUID();
  let caminho: string;
  let relogio: ReturnType<typeof setTimeout> | undefined;
  try {
    caminho = caminhoMidia(rodada.conversa_id, id);
    const envio = enviarArquivo(caminho, r.bytes, r.mime);
    if (fimEm === undefined) {
      await envio;
    } else {
      // teto da gravação: o concluir tem de caber antes do corte do worker. Estourou, a resposta
      // vai em texto; o arquivo que ainda chegar fica órfão no bucket (limite aceito na P5)
      envio.catch(() => undefined);
      const teto = Math.max(0, fimEm - TETO_GRAVACAO_ANTES_DO_FIM_MS - Date.now());
      const gravou = await Promise.race([
        envio.then(() => true),
        new Promise<boolean>((ok) => (relogio = setTimeout(() => ok(false), teto))),
      ]);
      if (!gravou) return emBolhas();
    }
  } catch {
    // o arquivo não ficou no bucket: a resposta vai em texto
    return emBolhas();
  } finally {
    if (relogio !== undefined) clearTimeout(relogio);
  }
  const audio: RespostaAudio = {
    tipo: "audio",
    id,
    transcricao: fala,
    midia_caminho: caminho,
    midia_mime: r.mime,
    midia_tamanho: r.bytes.byteLength,
    midia_duracao_s: r.duracaoS,
  };
  return [audio, ...emTexto(textos)];
}

// ---------------------------------------------------------------------------
// O retorno da rodada (3.3)
// ---------------------------------------------------------------------------

/** O jsonb de nina_retorno_da_rodada, validado campo a campo. */
type LeituraDoRetorno = {
  daRodada: boolean;
  retornoId: string;
  tipo: "retorno" | "lembrete";
  venceEm: number;
  motivo: string | null;
  marcadoEm: number;
  vencido: boolean;
};

/**
 * Uma ida ao banco, sem gravar (nina_retorno_da_rodada). null = nenhum retorno. Erro de banco ou
 * forma estranha lança "banco_retorno": quem chama decide o que fazer (a rodada pura e a mista
 * falham passageiras; a comum segue sem a linha). O servidor nunca compara instantes: quem decide
 * se a hora passou (vencido) é o banco.
 */
async function lerRetornoDoBanco(rodadaId: string): Promise<LeituraDoRetorno | null> {
  let resposta;
  try {
    resposta = await supabaseAdmin.rpc("nina_retorno_da_rodada", { p_rodada: rodadaId });
  } catch {
    throw new Error("banco_retorno");
  }
  if (resposta.error) throw new Error("banco_retorno");
  const j: unknown = resposta.data;
  if (j === null || j === undefined) return null;
  if (!ehObjeto(j)) throw new Error("banco_retorno");
  const tipo = j["tipo"];
  const retornoId = j["retorno_id"];
  const venceEm = typeof j["vence_em"] === "string" ? Date.parse(j["vence_em"]) : Number.NaN;
  const marcadoEm = typeof j["marcado_em"] === "string" ? Date.parse(j["marcado_em"]) : Number.NaN;
  const motivo = j["motivo"];
  const vencido = j["vencido"];
  if (
    typeof j["da_rodada"] !== "boolean" ||
    typeof retornoId !== "string" ||
    retornoId === "" ||
    (tipo !== "retorno" && tipo !== "lembrete") ||
    !Number.isFinite(venceEm) ||
    !Number.isFinite(marcadoEm) ||
    (motivo !== null && motivo !== undefined && typeof motivo !== "string") ||
    (vencido !== undefined && typeof vencido !== "boolean")
  ) {
    throw new Error("banco_retorno");
  }
  return {
    daRodada: j["da_rodada"],
    retornoId,
    tipo,
    venceEm,
    motivo: typeof motivo === "string" ? motivo : null,
    marcadoEm,
    vencido: vencido === true,
  };
}

/** O retorno que a rodada leva (da_rodada: true), ou nenhum. Lança banco_retorno. */
async function lerRetornoDaRodadaComRetorno(rodadaId: string): Promise<InfoRetorno> {
  const l = await lerRetornoDoBanco(rodadaId);
  if (!l?.daRodada) return { estado: "nenhum" };
  return {
    estado: "da_rodada",
    retornoId: l.retornoId,
    tipo: l.tipo,
    venceEm: l.venceEm,
    motivo: l.motivo,
    marcadoEm: l.marcadoEm,
    vencido: l.vencido,
  };
}

/**
 * Rodada sem retorno_id: o retorno pendente da conversa (da_rodada: false), se houver. O erro vai só
 * para o log e a rodada segue como hoje, sem a linha: um defeito na leitura nunca leva conversa
 * nenhuma para a equipe.
 */
async function lerRetornoDaRodadaComum(rodadaId: string): Promise<InfoRetorno> {
  try {
    const l = await lerRetornoDoBanco(rodadaId);
    if (l === null || l.daRodada || l.tipo !== "retorno") return { estado: "nenhum" };
    return {
      estado: "marcado",
      retornoId: l.retornoId,
      venceEm: l.venceEm,
      motivo: l.motivo,
      vencido: l.vencido,
    };
  } catch {
    console.error("rodada_retorno_falhou");
    return { estado: "desconhecido" };
  }
}

export async function responderRodada(rodada: Rodada, opcoes: OpcoesRodada = {}): Promise<void> {
  // 1. Dados e chave
  const dados = await carregarDados(rodada);
  if (!dados) {
    await falhar(rodada.id, "erro_provedor", false);
    return;
  }

  // O tipo da rodada: sem retorno_id é a do lead; com retorno_id e sem entrada é a pura (nasceu da
  // hora do retorno ou do lembrete); com retorno_id e entradas é a mista (o lead falou na hora em
  // que o retorno venceu e o banco o levou junto).
  const comRetorno = (rodada.retorno_id ?? null) !== null;
  const pura = comRetorno && dados.entradas.length === 0;
  let info: InfoRetorno = { estado: "nenhum" };
  if (pura) {
    // antes da chave: o retorno cancelado depois de pego não gasta nada. Erro de banco lança
    // (falha passageira pelo catch do ciclo)
    info = await lerRetornoDaRodadaComRetorno(rodada.id);
    if (info.estado !== "da_rodada") {
      // o banco só fecha a rodada (p_passos 0: sem IA)
      await concluir(rodada.id, [], [], 0);
      return;
    }
  }

  // Depois de uma ligação concluída (seção 7): a rodada só começa quando a
  // ligação termina (uma Nina por vez, no banco) e manda o que a voz combinou mandar por escrito,
  // ou termina sem mensagem (sem_resposta). Só registros de ligação que não terminaram bem (D7):
  // a rodada termina vazia, sem IA, sem chave, sem "lida" e sem "digitando".
  const depoisDaLigacao = await ligacaoConcluidaNaRodada(
    dados.entradas,
    opcoes.agora ?? Date.now(),
  );
  if (!depoisDaLigacao && dados.entradas.length > 0 && dados.entradas.every(ehRegistroDeLigacao)) {
    await concluir(rodada.id, [], [], 0);
    // a ligação pode ter fechado como concluída enquanto esta rodada rodava (o rearme do
    // pós-chamada não solta registro de rodada que ainda roda): confere de novo, já concluída
    await rearmarSeFechou(dados.entradas, opcoes.agora ?? Date.now());
    return;
  }

  const lida = await lerChaveUtilizavel("resposta");
  if (!lida.ok) {
    if (lida.motivo === "cifra_invalida" && lida.id) {
      await marcarStatusChave(lida.id, "invalida", "cifra_invalida");
    }
    await falhar(rodada.id, "chave_invalida", false);
    return;
  }
  const chave = lida.chave;

  // 2. Só áudio sem transcrição: a Nina pede em texto para o lead escrever (a lida e o
  // "digitando" como numa resposta normal, sem o modelo e sem custo de IA). Se ela já pediu na
  // rodada anterior e o lead mandou áudio de novo depois do pedido, sem escrever, vai para a
  // equipe (sem "digitando"). Áudio que chegou antes de a bolha do pedido sair não é insistência:
  // conclui sem bolha nova e grava o pedir_texto de novo, apontando a rodada da bolha
  // (pedido_rodada), para o próximo áudio depois da saída dela ir para a equipe.
  if (soAudioSemTranscricao(dados.entradas)) {
    // a transcrição ainda pode chegar: volta em 30 s (religa as entradas) em vez de pedir
    if (dados.entradas.some(audioPendente)) {
      await falhar(rodada.id, "audio_sem_transcricao", true);
      return;
    }
    const { situacao, rodadaDaBolha: daBolha } = await depoisDoPedido(rodada, dados);
    if (situacao === "insistiu") {
      await falhar(rodada.id, "audio_sem_transcricao", false);
      return;
    }
    const pedido: Chamada = {
      passo: 0,
      ferramenta: "pedir_texto",
      entrada: { motivo: "audio_sem_transcricao" },
      resultado: null,
    };
    if (situacao === "antes_do_pedido") {
      const apontado: Chamada = {
        ...pedido,
        entrada: { motivo: "audio_sem_transcricao", pedido_rodada: daBolha },
      };
      await concluir(rodada.id, [], [apontado], 0);
      return;
    }
    const lidaDigitando = marcarLidaEDigitando(dados);
    try {
      await concluir(rodada.id, emTexto([TEXTO_PEDIR_ESCRITA]), [pedido], 0);
    } finally {
      await esperarComTeto(lidaDigitando, TETO_LIDA_DIGITANDO_MS);
    }
    return;
  }

  // Prazo: com menos de 10 s para a IA, volta no minuto seguinte sem marcar lida nem mostrar
  // "digitando" e sem montar o histórico.
  if (tempoDaIA(opcoes.fimEm) < MIN_TEMPO_IA_MS) {
    await falhar(rodada.id, "erro_provedor", true);
    return;
  }

  // O retorno da rodada do lead: a pendente lê o retorno marcado da conversa; a mista lê o que o
  // banco levou junto (sem os dados, a Nina não saberia do retorno que o banco vai fechar como
  // "saiu": erro lança, falha passageira). Depois dos ramos de hoje, que terminam sem IA e sem ligar
  // o retorno: ele continua pendente para a faixa dos retornos.
  if (!pura) {
    info = comRetorno
      ? await lerRetornoDaRodadaComRetorno(rodada.id)
      : await lerRetornoDaRodadaComum(rodada.id);
  }

  // Modo fala: a voz escolhida, se esta rodada responde em áudio (senão, texto como sempre)
  const vozId = await vozDaRodada(dados);

  // 3. Lida e digitando: começa agora, em paralelo com a IA (sem esperar antes de chamá-la), e
  // só é esperado no fim, com teto de 3 s (o gateway pode segurar o pedido por segundos). Depois da
  // ligação, não: muitas vezes não sobra nada a mandar (sem_resposta), e o lead veria "digitando…"
  // seguido de silêncio (teste real da Nina vitrine, 13/11/2026). Na rodada pura também não: não
  // há mensagem do lead para marcar como lida, e "digitando…" seguido de sem_resposta seria silêncio.
  const lidaDigitando = depoisDaLigacao || pura ? Promise.resolve() : marcarLidaEDigitando(dados);
  try {
    await responderComIA(rodada, dados, lida, chave, opcoes, vozId, {
      depoisDaLigacao,
      pura,
      comRetorno,
      info,
    });
  } finally {
    await esperarComTeto(lidaDigitando, TETO_LIDA_DIGITANDO_MS);
  }
}

/** O que a rodada é, para as instruções, as ferramentas e o fim dela. */
type ModoDaRodada = {
  depoisDaLigacao: boolean;
  /** retorno_id e nenhuma entrada */
  pura: boolean;
  /** tem retorno_id (pura ou mista) */
  comRetorno: boolean;
  info: InfoRetorno;
};

async function responderComIA(
  rodada: Rodada,
  dados: DadosRodada,
  lida: Extract<Awaited<ReturnType<typeof lerChaveUtilizavel>>, { ok: true }>,
  chave: ChaveIA,
  opcoes: OpcoesRodada,
  vozId: string | null,
  modo: ModoDaRodada,
): Promise<void> {
  const { fimEm } = opcoes;
  const { depoisDaLigacao, pura, comRetorno, info } = modo;
  const agora = opcoes.agora ?? Date.now();
  const modoFala = vozId !== null;
  // a rodada pura é de retorno ou de lembrete pelo que o banco devolveu
  const tipoPura: "retorno" | "lembrete" = info.estado === "da_rodada" ? info.tipo : "retorno";
  const tipoRodada = pura ? tipoPura : "conversa";
  // D9: marcar_retorno e cancelar_retorno só onde o lead falou (a mensagem dele ou a ligação)
  const marcarRetorno = !pura && dados.entradas.length > 0;
  // o retorno que esta rodada leva (mista): o igual contra ele quer dizer "esta resposta é ele"
  const retornoDaRodada =
    !pura && info.estado === "da_rodada" && info.tipo === "retorno" ? info.retornoId : undefined;
  const maxPassos = pura ? MAX_PASSOS_PURA : MAX_PASSOS;
  // toda conclusão depois da IA de uma rodada com retorno_id leva p_passos >= 1: o banco lê
  // p_passos = 0 como "rodada sem IA" (a bolha fixa do áudio) e devolveria o retorno à fila
  const passosDaIA = (n: number) => (comRetorno ? Math.max(1, n) : n);
  // 4. Instruções (só regras, Contexto e etapas; no modo fala, o bloco de fala no fim) e
  // histórico (com os dados do contato no fim)
  const permitidas: EtapaNina[] = pura
    ? []
    : dados.etapas
        .filter((e) => e.nina_pode_mover)
        .map((e) => ({ id: e.id, chave: e.chave ?? e.id, nome: e.nome }));
  const etapaAtual = dados.etapas.find((e) => e.id === dados.contato?.etapa_id)?.nome ?? null;
  const instructions = montarInstrucoes({
    contexto: dados.contexto,
    etapasPermitidas: permitidas.map(({ chave: c, nome }) => ({ chave: c, nome })),
    falar: modoFala,
    depoisDaLigacao,
    ...(pura ? { rodadaDe: tipoPura } : {}),
  });
  const historico = await carregarHistorico(
    rodada.conversa_id,
    rodada.id,
    // a rodada pura não tem entrada: o início dela corta o que o lead escrever enquanto ela roda
    pura ? rodada.iniciada_em : undefined,
  );
  const mensagens = await montarHistorico(historico, {
    // a data e a hora vão aqui, no fim, e não nas instruções: o começo do pedido fica igual. O
    // retorno marcado também (linhas dentro de <dados_do_contato>, depois do próximo passo)
    dadosContato:
      `${linhaDoAgora(agora)}\n` +
      blocoDoContato(
        dados.contato,
        etapaAtual,
        linhasDoRetorno(info, agora, { pura, cancelar: marcarRetorno }),
      ),
    rodadaId: rodada.id,
    ...(pura
      ? { marcadorSemMensagem: tipoPura === "lembrete" ? MARCADOR_LEMBRETE : MARCADOR_RETORNO }
      : {}),
  });

  // 5. Modelo e laço de ferramentas
  let modelo;
  try {
    modelo = criarModelo(chave);
  } catch {
    await falhar(rodada.id, "chave_invalida", false);
    return;
  }

  // Prazo: sem tempo para a IA, a rodada volta no minuto seguinte sem chamar o modelo.
  const tempoTotal = tempoDaIA(fimEm, modoFala);
  if (tempoTotal <= 0) {
    await falhar(rodada.id, "erro_provedor", true);
    return;
  }
  const prazo = new AbortController();
  const relogio = setTimeout(() => prazo.abort(), tempoTotal);

  const passos: Passo[] = [];
  // execuções do passo em andamento; o fim do passo (onStepEnd) já as traz em passo.content
  let emAndamento: Execucao[] = [];
  // o passo em andamento: um marcar_retorno recusado vale até o fim dele (a guarda do passo cego)
  const estadoDoPasso: EstadoDoPasso = { marcarRecusado: false };
  let resultado: Awaited<ReturnType<typeof generateText<FerramentasNina>>>;
  try {
    resultado = await generateText({
      model: modelo,
      instructions,
      messages: mensagens,
      tools: criarFerramentas({
        rodadaId: rodada.id,
        etapas: permitidas,
        falar: modoFala,
        tipo: tipoRodada,
        depoisDaLigacao,
        marcarRetorno,
        agora,
        referencia: referenciaDaRodada(dados.entradas, agora),
        passo: estadoDoPasso,
        retornoDaRodada,
        aoExecutar: (ferramenta, entrada, r) => {
          emAndamento.push({ ferramenta, entrada, resultado: r });
        },
      }),
      stopWhen: [isStepCount(maxPassos), respondeu],
      toolCallConcurrency: 1,
      // o tempo total é o do abortSignal (prazo); o de cada passo continua 40 s
      abortSignal: prazo.signal,
      timeout: { stepMs: TEMPO_PASSO_MS },
      maxRetries: MAX_REPETICOES,
      providerOptions: opcoesDoProvedor(chave.provedor),
      onStepEnd: (passo) => {
        passos.push(passo);
        emAndamento = [];
        estadoDoPasso.marcarRecusado = false;
      },
    });
  } catch (erro) {
    // 6. Custo do que já rodou, mesmo com a rodada falhando
    await registrarCusto(rodada.id, chave, passos);
    const abortou = prazo.signal.aborted;
    // 8. Erros do provedor (o prazo é do worker, não do provedor: não marca a chave)
    // a chave de resposta nunca é da ElevenLabs (checks da 0012), mas o tipo do banco não sabe disso
    const provedorErro = chave.provedor === "elevenlabs" ? undefined : chave.provedor;
    const classe = abortou ? null : classificarErroIA(erro, provedorErro);
    if (classe?.statusChave) await marcarStatusChave(chave.id, classe.statusChave, classe.codigo);
    // Já passou para humano (nina_passar_para_humano gravou modo = 'humano'): falhar_rodada não
    // mexeria na conversa e a auditoria se perderia. Conclui sem bolhas, como "passou sem se
    // despedir". O abort pode chegar com uma ferramenta gravando (o pedido ao banco segue até o
    // fim): espera por ela e a junta à auditoria, como chamada do passo interrompido.
    const chamadas = descartarCegas([
      ...chamadasDe(passos),
      ...(await chamadasEmAndamento(emAndamento, passos.length + 1)),
    ]);
    if (passouParaHumano(chamadas)) {
      await concluir(rodada.id, [], chamadas, passosDaIA(passos.length));
      return;
    }
    // Prazo esgotado: falha passageira, a conversa volta no minuto seguinte
    if (!classe) {
      await falhar(rodada.id, "erro_provedor", true);
      return;
    }
    await falhar(rodada.id, classe.motivo, classe.passageiro);
    return;
  } finally {
    clearTimeout(relogio);
  }

  const todos = resultado.steps.length > 0 ? resultado.steps : passos;
  await registrarCusto(rodada.id, chave, todos);
  // a chamada deu certo: o saldo voltou
  if (lida.status === "sem_credito") await reativarChave(chave.id);

  // 7. Fim. A resposta que o modelo escreveu antes de ler a recusa do marcar_retorno não vale
  const chamadas = descartarCegas(chamadasDe(todos));
  const passosFeitos = passosDaIA(todos.length);
  // sem nada a mandar (depois da ligação, e na hora do retorno e do lembrete): conclui sem
  // mensagem. Na rodada pura, o motivo do sem_resposta vira o porquê no histórico
  if (semResposta(chamadas) && !bolhasDaFerramenta(chamadas) && !falaDaFerramenta(chamadas)) {
    await concluir(rodada.id, [], chamadas, passosFeitos);
    return;
  }
  // o raciocínio da rodada nunca vai ao lead: conclui sem mensagem (falhar repetiria a rodada e,
  // na 3ª vez, levaria a conversa para a equipe sem motivo). Na rodada pura, a ferramenta já
  // recusou o bastidor uma vez; só a insistência chega aqui
  if (!passouParaHumano(chamadas) && respostaDeBastidor(chamadas, todos.at(-1)?.text ?? "")) {
    console.error("rodada_bastidor");
    await concluir(rodada.id, [], chamadas, passosFeitos);
    return;
  }
  // modo fala: a fala vira áudio (ou texto, se a fala falhar), os textos vão depois
  const daFala = vozId !== null ? falaDaFerramenta(chamadas) : null;
  if (vozId !== null && daFala) {
    const respostas = await respostasComFala(rodada, vozId, daFala.fala, daFala.textos, fimEm);
    await concluir(rodada.id, respostas, chamadas, passosFeitos);
    return;
  }
  const daFerramenta = bolhasDaFerramenta(chamadas);
  if (daFerramenta) {
    await concluir(rodada.id, emTexto(daFerramenta), chamadas, passosFeitos);
    return;
  }
  const ultimo = todos.at(-1);
  const terminou = ultimo !== undefined && ultimo.toolCalls.length === 0;
  const doTexto = terminou ? bolhasDoTexto(ultimo.text) : [];
  if (doTexto.length > 0) {
    await concluir(rodada.id, emTexto(doTexto), chamadas, passosFeitos);
    return;
  }
  if (passouParaHumano(chamadas)) {
    // passou sem se despedir: conclui sem bolhas (a conversa já está com a equipe)
    await concluir(rodada.id, [], chamadas, passosFeitos);
    return;
  }
  // daqui para baixo, na rodada pura, é erro e nunca conclusão vazia: concluir([]) fecharia o
  // retorno como "dispensado" e ele não sairia. Vai para falhar_rodada, que o repete ou o fecha
  if (todos.length >= maxPassos) {
    await falhar(rodada.id, "limite_passos", false);
    return;
  }
  // terminou sem nada para dizer: tenta de novo
  await falhar(rodada.id, "erro_provedor", true);
}
