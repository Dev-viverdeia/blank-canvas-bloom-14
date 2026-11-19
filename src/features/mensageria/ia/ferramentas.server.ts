// Ferramentas da Nina numa rodada. As que gravam chamam as funções nina_* do banco, que
// conferem que a rodada ainda está rodando. Erro do banco vira resultado { erro: "<código>" }
// para o modelo, nunca exceção: a rodada segue. A trava da decisão 3 (etapa_travada) volta como
// recusa com orientação, e as chamadas seguintes de mover_etapa na rodada nem vão ao banco.
// No modo fala (P3), "responder" recebe { fala, textos? } em vez de
// { bolhas }: a fala vira o áudio e os textos (link, e-mail, chave PIX) vão em texto depois.
// Retornos : marcar_retorno e cancelar_retorno só existem na rodada em que o
// lead falou (D9); o "responder" ganha espera_resposta (só "sim" aceito arma o lembrete); a rodada
// pura de retorno e de lembrete tem só responder, atualizar_contato e sem_resposta. O modelo nunca faz
// conta de data: manda "amanha", "sexta", "manha" e quando.ts resolve o dia de Brasília; o banco
// converte para instante e recusa passado, 24 h e 30 dias. Ao modelo, nenhum nome de coluna, de
// status ou de função do banco: só "retorno" e "lembrete".
import { tool } from "ai";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";

import { ehBastidor } from "./bastidor";
import { MAX_CARACTERES_FALA, MAX_TEXTOS_FALA } from "./fala";
import { MAX_BOLHAS, MAX_MOTIVO_RETORNO } from "./instrucoes";
import {
  diaEmBrasilia,
  formatarMomento,
  partesEmBrasilia,
  porExtenso,
  resolverData,
  resolverHora,
} from "./quando";

export { MAX_MOTIVO_RETORNO };

export type EtapaNina = { id: string; chave: string; nome: string };

export type ResultadoFerramenta =
  | {
      ok: true;
      /** marcar_retorno: o dia e a hora por extenso, para o lead conferir */
      retorno?: string;
      /** marcar_retorno: o retorno anterior que foi trocado */
      substituiu?: string;
      /** cancelar_retorno: o retorno que foi cancelado */
      cancelado?: string;
      orientacao?: string;
    }
  | {
      erro: string;
      permitidas?: string[];
      orientacao?: string;
      /** recusa de marcar_retorno que depende de um limite (por extenso) */
      limite?: string;
    };

/** A rodada é a do lead (ou depois da ligação), a pura de retorno ou a pura de lembrete. */
export type TipoRodadaNina = "conversa" | "retorno" | "lembrete";

/**
 * Estado do passo em andamento (o AI SDK executa as ferramentas de um passo em série): um
 * marcar_retorno recusado deixa marcarRecusado ligado até o fim do passo (responder.server.ts zera
 * no onStepEnd). Sem o retorno marcado, a confirmação ao lead no mesmo passo seria uma promessa
 * que o sistema não cumpre.
 */
export type EstadoDoPasso = { marcarRecusado: boolean };

/**
 * Recusa de nina_mover_etapa (decisão 3): o lead está em Ganho ou Perdido, ou numa etapa que uma
 * pessoa escolheu e a conversa ainda não foi devolvida à Nina. Não é falha da rodada: volta ao
 * modelo como resultado, com a orientação de não insistir e seguir a conversa.
 */
export const ETAPA_TRAVADA = "etapa_travada";
export const ORIENTACAO_ETAPA_TRAVADA =
  "Este lead não pode ser movido agora (está em Ganho, em Perdido ou numa etapa escolhida por " +
  "uma pessoa da equipe). Não tente mover de novo nesta conversa; siga o atendimento normalmente.";

type ErroRpc = { code?: string; message?: string } | null;

/** Só códigos levantados pelas nossas funções (P0001 com nome curto); o resto, genérico. */
function codigoDoErro(erro: ErroRpc): string {
  const msg = erro?.message ?? "";
  if (erro?.code === "P0001" && /^[a-z_]{1,60}$/.test(msg)) return msg;
  return "erro_banco";
}

async function chamar(
  nome: "nina_mover_etapa" | "nina_passar_para_humano" | "nina_atualizar_contato",
  args: Record<string, unknown>,
): Promise<ResultadoFerramenta> {
  try {
    // os argumentos batem com a assinatura de cada função (types.ts)
    const { error } = await supabaseAdmin.rpc(nome, args as never);
    if (error) return { erro: codigoDoErro(error) };
    return { ok: true };
  } catch {
    return { erro: "erro_banco" };
  }
}

/** As ferramentas dos retornos devolvem jsonb: o dado volta junto, ou o código da recusa. */
async function chamarJson(
  nome: "nina_marcar_retorno" | "nina_cancelar_retorno",
  args: Record<string, unknown>,
): Promise<{ data: unknown } | { erro: string }> {
  try {
    const { data, error } = await supabaseAdmin.rpc(nome, args as never);
    if (error) return { erro: codigoDoErro(error) };
    return { data };
  } catch {
    return { erro: "erro_banco" };
  }
}

const textoCurto = (max: number) => z.string().trim().min(1).max(max);

/** Motivo do movimento no Kanban: uma frase curta. */
export const MAX_MOTIVO_MOVER = 200;
/** Fatos e próximo passo (contatos.anotacoes_nina). */
export const MAX_FATOS = 20;
export const MAX_ROTULO_FATO = 60;
export const MAX_VALOR_FATO = 300;
export const MAX_TITULO_PASSO = 120;
export const MAX_TEXTO_PASSO = 500;

/**
 * Avisado no começo de cada execução, com a promessa do resultado. Serve para a rodada não
 * perder a auditoria de uma ferramenta que já gravou quando o prazo aborta antes do fim do
 * passo (o AI SDK não chama onStepEnd nesse caso), e para a rodada esperar por ela antes de
 * falhar (marcar_retorno e cancelar_retorno travam a conversa e depois a rodada, o contrário da
 * falhar_rodada: nunca falhar uma rodada com uma ferramenta dela ainda rodando).
 */
export type AoExecutar = (
  ferramenta: string,
  entrada: unknown,
  resultado: Promise<ResultadoFerramenta>,
) => void;

/** Cada texto que vai depois do áudio (link, e-mail, chave PIX). */
export const MAX_TEXTO_FALA = 500;

/** Entrada de "responder" nos dois modos: bolhas (texto) ou fala e textos (áudio). */
export type EntradaResponder = {
  bolhas?: string[] | undefined;
  fala?: string | undefined;
  textos?: string[] | undefined;
  /** "sim" arma o lembrete (a Nina fez uma pergunta e o atendimento fica parado) */
  espera_resposta?: "sim" | "nao" | undefined;
};

// ---------------------------------------------------------------------------
// espera_resposta
// ---------------------------------------------------------------------------

export const DESCRICAO_ESPERA =
  "sim: a sua mensagem termina numa pergunta ou num pedido que só o lead pode responder, e o " +
  "atendimento fica parado até ele responder. nao: você se despede ou agradece (despedida), " +
  "confirma um combinado, marca um retorno, passa a conversa para a equipe, ou o lead disse que " +
  "responde depois.";

/**
 * "Sim", "SIM", "Não", "nao", true e false são aceitos; vazio vira ausente. Chega ao banco já
 * normalizado ("sim" ou "nao"): a lembrete_ao_concluir só arma com exatamente 'sim'.
 */
export function normalizarEspera(v: unknown): unknown {
  if (v === true) return "sim";
  if (v === false) return "nao";
  if (typeof v !== "string") return v;
  const t = v.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase();
  return t === "" ? undefined : t;
}

/**
 * Qualquer outro valor ("talvez", número, null) vira ausente e nunca recusa o responder: a resposta
 * ao lead não pode depender de um campo opcional. O AI SDK mostra ao provedor o enum e a descrição.
 */
const ESPERA_RESPOSTA = z
  .preprocess(normalizarEspera, z.enum(["sim", "nao"]).optional())
  .catch(undefined)
  .describe(DESCRICAO_ESPERA);

const ESQUEMA_BOLHAS = z.object({
  bolhas: z.array(textoCurto(2000)).min(1).max(MAX_BOLHAS),
});
const ESQUEMA_FALA = z.object({
  fala: textoCurto(MAX_CARACTERES_FALA),
  textos: z.array(textoCurto(MAX_TEXTO_FALA)).max(MAX_TEXTOS_FALA).optional(),
});
const ESQUEMA_BOLHAS_ESPERA = ESQUEMA_BOLHAS.extend({ espera_resposta: ESPERA_RESPOSTA });
const ESQUEMA_FALA_ESPERA = ESQUEMA_FALA.extend({ espera_resposta: ESPERA_RESPOSTA });

/** O que a Nina escreveria ao lead nesta chamada de responder (bolhas, ou fala e textos). */
function partesDoResponder(e: EntradaResponder): string[] {
  if (typeof e.fala === "string") return [e.fala, ...(e.textos ?? [])];
  return e.bolhas ?? [];
}

export const ORIENTACAO_RESPOSTA_CEGA =
  "Esta resposta não foi enviada ao lead: marcar_retorno foi recusada neste mesmo passo. Leia a " +
  "recusa e chame responder de novo, sem confirmar o retorno, seguindo a orientação dela.";
export const ORIENTACAO_BASTIDOR =
  "Essa resposta fala do seu funcionamento e não vai ao lead. Se não há nada a mandar, chame " +
  "sem_resposta com o motivo; se há, escreva só a mensagem ao lead e chame responder de novo.";

// ---------------------------------------------------------------------------
// marcar_retorno e cancelar_retorno
// ---------------------------------------------------------------------------

/** Toda recusa do marcar_retorno termina com este aviso: os dois sinais ao modelo ficam coerentes. */
export const AVISO_RESPOSTA_DESCARTADA =
  "Se você chamou responder junto com esta chamada, aquela resposta não vai ao lead: mande outra.";

const ORIENTACAO_NAO_DEU =
  "Não deu para marcar o retorno agora. Nada foi marcado: não confirme o retorno ao lead nem " +
  "prometa escrever depois.";

const ORIENTACAO_DESLIGADOS =
  "Não dá para marcar retorno agora. Nada foi marcado: não prometa retorno nem diga ao lead que " +
  "vai escrever depois. Se ele quiser retomar, diga que pode chamar quando quiser.";

const TEXTO_DATA_INVALIDA =
  "Não entendi a data. Em data, mande hoje, amanha, depois_de_amanha, um dia da semana (segunda a " +
  "domingo), proxima_ e o dia da semana, ou AAAA-MM-DD. Se o lead não disse o dia, pergunte antes " +
  "de marcar. Nada foi marcado.";

const TEXTO_HORA_INVALIDA =
  "Não entendi a hora. Em hora, mande HH:MM entre 00:00 e 23:59, no horário de Brasília, ou manha, " +
  "tarde ou noite se o lead não disse a hora. Nada foi marcado.";

function recusa(erro: string, orientacao: string, limite?: string): ResultadoFerramenta {
  return {
    erro,
    ...(limite === undefined ? {} : { limite }),
    orientacao: `${orientacao} ${AVISO_RESPOSTA_DESCARTADA}`,
  };
}

/** A recusa do marcar_retorno traduzida para o modelo, por código (o do servidor ou o do banco). */
function recusaDoMarcar(
  erro: string,
  limite: number | null,
  c: { agora: number },
  extra: { hoje?: string; chave?: string } = {},
): ResultadoFerramenta {
  const limiteTexto = limite === null ? undefined : porExtenso(limite, c.agora);
  switch (erro) {
    case "data_invalida":
      return recusa(erro, TEXTO_DATA_INVALIDA);
    case "hora_invalida":
      return recusa(erro, TEXTO_HORA_INVALIDA);
    case "dia_ambiguo":
      return recusa(
        erro,
        `Hoje já é ${extra.hoje ?? "esse dia"}. Se o lead quis dizer hoje, mande hoje; se quis a da ` +
          `semana que vem, mande proxima_${extra.chave ?? "o dia"}. Nada foi marcado.`,
      );
    case "motivo_invalido":
      return recusa(
        erro,
        "O assunto do retorno está vazio ou longo demais. Escreva o assunto numa frase curta. Nada foi marcado.",
      );
    case "no_passado":
      return recusa(
        erro,
        "Esse dia e essa hora já passaram (veja a linha Agora:). Confira com o lead o dia e a hora. " +
          "Nada foi marcado.",
      );
    case "fora_das_24h":
      return recusa(
        erro,
        "Nada foi marcado. Neste WhatsApp você só consegue escrever a este lead " +
          (limiteTexto ? `até ${limiteTexto}, ` : "até ") +
          "24 horas depois da última mensagem dele. Ofereça um horário até lá ou peça que ele " +
          "mande uma mensagem quando quiser retomar. Não confirme o horário pedido.",
        limiteTexto,
      );
    case "longe_demais":
      return recusa(
        erro,
        "Nada foi marcado. O retorno pode ser marcado no máximo " +
          (limiteTexto ? `até ${limiteTexto}, ` : "") +
          "30 dias à frente. Combine uma data até lá ou diga que ele pode chamar quando quiser.",
        limiteTexto,
      );
    case "retornos_desligados":
      return recusa(erro, ORIENTACAO_DESLIGADOS);
    default:
      // rodada_sem_lead, rodada_nao_rodando, erro_banco e qualquer outro código
      return recusa(erro, ORIENTACAO_NAO_DEU);
  }
}

const RECUSAS_COM_DADO = new Set(["no_passado", "longe_demais", "fora_das_24h"]);

function instante(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Contexto de data de uma chamada de marcar_retorno (ver quando.ts). */
export type ContextoMarcar = {
  /** o relógio do "Agora:" desta rodada */
  agora: number;
  /** o dia de onde "amanhã" é contado (o momento do que o lead disse) */
  referencia: number;
  /** "amanha" quando o modelo mandou amanha (o aviso de madrugada) */
  palavra: "amanha" | "outra";
  /** o retorno que esta rodada leva (mista): o igual contra ele quer dizer "esta resposta é ele" */
  retornoDaRodada?: string | undefined;
};

/** Avisos sobre o dia: a meia-noite no meio da conversa e a madrugada. */
function complementosDeData(c: ContextoMarcar): string {
  const ref = diaEmBrasilia(c.referencia);
  const agora = diaEmBrasilia(c.agora);
  let t = "";
  if (c.palavra === "amanha" && ref.hora < 5) {
    t += " É madrugada: na confirmação, diga o dia da semana e a data, para o lead conferir.";
  }
  if (ref.ano !== agora.ano || ref.mes !== agora.mes || ref.dia !== agora.dia) {
    const p = partesEmBrasilia(c.referencia);
    t +=
      ` O dia foi contado a partir de quando o lead falou (${p.weekday}, ${p.day}/${p.month}/${p.year}),` +
      " antes da meia-noite.";
  }
  return t;
}

/**
 * O jsonb de nina_marcar_retorno (ou o código do erro) vira o resultado ao modelo. Lista fechada de
 * campos (ok, retorno_id, vence_em, substituido_vence_em, igual, erro, limite): qualquer outra
 * forma vira erro_banco, e nada do banco vai cru ao modelo nem à auditoria. Pura.
 */
export function resultadoDoMarcar(
  resposta: { data: unknown } | { erro: string },
  c: ContextoMarcar,
): ResultadoFerramenta {
  const falhou = () => recusaDoMarcar("erro_banco", null, c);
  if ("erro" in resposta) return recusaDoMarcar(resposta.erro, null, c);
  const d = resposta.data;
  if (d === null || typeof d !== "object" || Array.isArray(d)) return falhou();
  const j = d as Record<string, unknown>;

  if (j["ok"] === false) {
    const erro = j["erro"];
    if (typeof erro !== "string" || !RECUSAS_COM_DADO.has(erro)) return falhou();
    const bruto = j["limite"];
    const limite = bruto === null || bruto === undefined ? null : instante(bruto);
    if (bruto !== null && bruto !== undefined && limite === null) return falhou();
    return recusaDoMarcar(erro, limite, c);
  }

  if (j["ok"] !== true) return falhou();
  const venceEm = instante(j["vence_em"]);
  if (venceEm === null) return falhou();
  const trocado = j["substituido_vence_em"];
  const substituido = trocado === null || trocado === undefined ? null : instante(trocado);
  if (trocado !== null && trocado !== undefined && substituido === null) return falhou();
  const igual = j["igual"];
  if (igual !== undefined && typeof igual !== "boolean") return falhou();
  const retornoId = typeof j["retorno_id"] === "string" ? j["retorno_id"] : undefined;
  const retorno = porExtenso(venceEm, c.agora);

  if (igual === true) {
    if (retornoId !== undefined && retornoId === c.retornoDaRodada) {
      // o retorno levado nesta rodada: a promessa de "te escrevo às 9" é esta resposta
      return {
        ok: true,
        retorno,
        orientacao:
          "Este é o retorno combinado, e esta resposta é ele: a hora dele já chegou, então trate do " +
          "assunto agora, sem marcar de novo e sem confirmar horário. Não diga ao lead que vai " +
          "escrever de novo nessa hora.",
      };
    }
    return {
      ok: true,
      retorno,
      orientacao:
        "Esse retorno já estava marcado; nada mudou. Se você já o confirmou ao lead, não precisa " +
        "confirmar de novo.",
    };
  }
  const complementos = complementosDeData(c);
  if (substituido !== null) {
    return {
      ok: true,
      retorno,
      substituiu: formatarMomento(substituido),
      orientacao:
        "Retorno trocado: o anterior (em substituiu) não vale mais, só existe um por conversa. " +
        `Confirme ao lead o novo dia e a nova hora.${complementos}`,
    };
  }
  return {
    ok: true,
    retorno,
    orientacao:
      "Retorno marcado. Confirme ao lead pelo responder com o dia da semana, a data e a hora (por " +
      `exemplo: quinta, 19/11, às 9h).${complementos}`,
  };
}

/** O jsonb de nina_cancelar_retorno (ou o código do erro) vira o resultado ao modelo. Pura. */
export function resultadoDoCancelar(
  resposta: { data: unknown } | { erro: string },
  agora: number,
): ResultadoFerramenta {
  const naoDeu = (erro: string): ResultadoFerramenta => ({
    erro,
    orientacao:
      "Não deu para cancelar agora: o retorno continua marcado. Não diga ao lead que cancelou.",
  });
  if ("erro" in resposta) return naoDeu(resposta.erro);
  const d = resposta.data;
  if (d === null || typeof d !== "object" || Array.isArray(d)) return naoDeu("erro_banco");
  const j = d as Record<string, unknown>;
  if (j["ok"] === false && j["erro"] === "sem_retorno") {
    return {
      erro: "sem_retorno",
      orientacao:
        "Não há retorno marcado nesta conversa: não há o que cancelar. Não diga ao lead que cancelou.",
    };
  }
  const venceEm = instante(j["vence_em"]);
  if (j["ok"] !== true || venceEm === null) return naoDeu("erro_banco");
  return {
    ok: true,
    cancelado: porExtenso(venceEm, agora),
    orientacao:
      "Retorno cancelado: você não vai escrever ao lead na hora que estava marcada. Não prometa " +
      "escrever depois. Se o próximo passo guardado só falava desse retorno, apague-o com " +
      "atualizar_contato (proximo_passo null).",
  };
}

const DESCRICAO_MARCAR =
  "Marca o retorno combinado com o lead: no dia e na hora marcados, você volta a escrever a ele aqui " +
  "no WhatsApp, sozinha, depois de reler a conversa. Use quando o lead pedir para falar depois " +
  '("me chama amanhã de manhã", "fala comigo sexta") ou combinar com você um dia para retomar. ' +
  "Nunca prometa escrever ao lead em outro dia ou hora sem marcar. Existe um retorno por conversa: " +
  'marcar de novo troca o anterior, que aparece em <dados_do_contato>, na linha "Retorno marcado". ' +
  "Chame antes do responder e só confirme ao lead depois do ok, com o dia e a hora que voltarem no " +
  'resultado; se vier recusa, nada foi marcado: siga a orientação dela. Se a linha "Retorno ' +
  'marcado" traz um retorno que você ainda não confirmou ao lead na conversa, confirme-o. O ' +
  "horário de atendimento do Contexto é o da equipe e não limita o retorno.";

const DESCRICAO_CANCELAR =
  'Cancela o retorno marcado nesta conversa (a linha "Retorno marcado" em <dados_do_contato>). Use ' +
  "só quando o lead disser que não precisa mais, desistir ou resolver na conversa o assunto do " +
  'retorno. Uma despedida ("valeu, até amanhã") ou o lead escrever antes da hora não cancela: o ' +
  "retorno continua valendo. Para mudar o dia ou a hora, use marcar_retorno, que troca o anterior.";

/** Muda de propósito junto com o texto de BLOCO_DEPOIS_DA_LIGACAO; ver a pergunta 2 ao Davi. */
export const CONFIRMAR_RETORNO_DA_LIGACAO = true;

// ---------------------------------------------------------------------------
// criarFerramentas
// ---------------------------------------------------------------------------

export function criarFerramentas(p: {
  rodadaId: string;
  etapas: EtapaNina[];
  aoExecutar?: AoExecutar;
  /** Esta resposta vai em áudio: "responder" recebe fala e textos. */
  falar?: boolean;
  /** A rodada do lead (padrão), a pura de retorno ou a pura de lembrete. */
  tipo?: TipoRodadaNina;
  /** A rodada depois da ligação pode terminar sem mensagem (a ferramenta sem_resposta). */
  depoisDaLigacao?: boolean;
  /** D9: o lead falou nesta rodada (mensagem dele ou ligação concluída): marcar e cancelar existem. */
  marcarRetorno?: boolean;
  /** O relógio do "Agora:" desta rodada (ms); sem ele, Date.now(). */
  agora?: number;
  /** O dia de onde "amanhã" é contado (ms); sem ele, o agora. */
  referencia?: number;
  /** Estado do passo em andamento; responder.server.ts zera no onStepEnd. */
  passo?: EstadoDoPasso;
  /** O retorno que esta rodada leva (mista): o igual contra ele quer dizer "esta resposta é ele". */
  retornoDaRodada?: string | undefined;
}) {
  const tipo: TipoRodadaNina = p.tipo ?? "conversa";
  const pura = tipo !== "conversa";
  const porChave = new Map(p.etapas.map((e) => [e.chave, e]));
  const chaves = p.etapas.map((e) => e.chave);
  const agoraDe = () => p.agora ?? Date.now();
  /** true depois de um etapa_travada nesta rodada. */
  let travada = false;
  /** Estado por rodada dos retornos. */
  let recusouNaRodada = false;
  let marcouNaRodada = false;
  /** Gravou um retorno novo ou trocou o anterior (o igual não grava nada): vale para o cancelar. */
  let gravouNaRodada = false;
  let bastidorAvisado = false;
  let retornosDesligados = false;
  const avisar = (
    ferramenta: string,
    entrada: unknown,
    resultado: Promise<ResultadoFerramenta>,
  ): Promise<ResultadoFerramenta> => {
    p.aoExecutar?.(ferramenta, entrada, resultado);
    return resultado;
  };

  // o esquema é escolhido aqui, mas o tipo é um só: FerramentasNina não muda com o modo. A rodada
  // de lembrete não tem espera_resposta (um lembrete por silêncio)
  const comEspera = tipo !== "lembrete";
  const esquemaResponder: z.ZodType<EntradaResponder, z.ZodTypeDef, unknown> = p.falar
    ? comEspera
      ? ESQUEMA_FALA_ESPERA
      : ESQUEMA_FALA
    : comEspera
      ? ESQUEMA_BOLHAS_ESPERA
      : ESQUEMA_BOLHAS;

  const descricaoResponder =
    (p.falar
      ? "Envia a resposta ao lead em áudio: em fala, o que você vai dizer (vira um áudio com a " +
        `sua voz); em textos, até ${MAX_TEXTOS_FALA} bolhas só com o que o lead precisa ler ou ` +
        "copiar (link, e-mail, chave PIX). Chame uma vez, no fim da rodada."
      : `Envia a resposta ao lead em 1 a ${MAX_BOLHAS} bolhas curtas de WhatsApp. ` +
        "Chame uma vez, no fim da rodada.") + (comEspera ? " Mande sempre espera_resposta." : "");

  /** marcar_retorno recusado: liga o estado do passo e da rodada. */
  const recusouMarcar = (r: ResultadoFerramenta): ResultadoFerramenta => {
    if (p.passo) p.passo.marcarRecusado = true;
    recusouNaRodada = true;
    return r;
  };

  const marcar_retorno = tool({
    description: DESCRICAO_MARCAR,
    // texto livre de propósito: um regex no zod viraria tool-error sem passar pela guarda, com
    // mensagem em inglês; a conferência é do quando.ts (data_invalida, hora_invalida)
    inputSchema: z.object({
      data: z
        .string()
        .trim()
        .describe(
          "O dia, no horário de Brasília: hoje, amanha, depois_de_amanha, um dia da semana " +
            "(segunda, terca, quarta, quinta, sexta, sabado, domingo: o próximo desse dia; " +
            "proxima_ e o dia, como proxima_sexta, só muda algo quando hoje já é esse dia, e aí é o " +
            "da semana que vem) ou a data AAAA-MM-DD. Para um dia que não é o próximo desse dia da " +
            "semana (por exemplo, a sexta da semana que vem, quando hoje não é sexta), mande a " +
            "data AAAA-MM-DD. Mande a palavra que o lead usou: o sistema faz a conta. Se o lead " +
            "não disse o dia, pergunte antes de marcar.",
        ),
      hora: z
        .string()
        .trim()
        .describe(
          "A hora, no horário de Brasília, em HH:MM. Se o lead não disse a hora: manha, tarde ou noite.",
        ),
      motivo: z
        .string()
        .trim()
        .describe(
          "O assunto a retomar, numa frase curta de até " +
            MAX_MOTIVO_RETORNO +
            " letras (a equipe lê). " +
            "Exemplo: Retomar a proposta do plano anual depois da conversa com o sócio.",
        ),
    }),
    execute: async (entrada): Promise<ResultadoFerramenta> => {
      const agora = agoraDe();
      const referencia = p.referencia ?? agora;
      // com os retornos desligados no banco, a 2ª chamada nem vai lá
      if (retornosDesligados)
        return recusouMarcar(recusaDoMarcar("retornos_desligados", null, { agora }));
      // a conferência é aqui, e não no esquema: o esquema recusado vira tool-error sem o aviso e sem
      // ligar o marcarRecusado, e o responder do mesmo passo pareceria aceito ao modelo
      if (entrada.motivo === "" || entrada.motivo.length > MAX_MOTIVO_RETORNO) {
        return recusouMarcar(recusaDoMarcar("motivo_invalido", null, { agora }));
      }
      const dia = resolverData(entrada.data, referencia);
      if ("erro" in dia) {
        const extra = dia.erro === "dia_ambiguo" ? { hoje: dia.hoje, chave: dia.chave } : {};
        return recusouMarcar(recusaDoMarcar(dia.erro, null, { agora }, extra));
      }
      const hora = resolverHora(entrada.hora);
      if ("erro" in hora) return recusouMarcar(recusaDoMarcar(hora.erro, null, { agora }));
      const contexto: ContextoMarcar = {
        agora,
        referencia,
        palavra: dia.palavra,
        retornoDaRodada: p.retornoDaRodada,
      };
      const resultado = chamarJson("nina_marcar_retorno", {
        p_rodada: p.rodadaId,
        p_data: dia.data,
        p_hora: hora.hora,
        p_motivo: entrada.motivo,
      }).then((r): ResultadoFerramenta => {
        const res = resultadoDoMarcar(r, contexto);
        if ("erro" in res) {
          if (res.erro === "retornos_desligados") retornosDesligados = true;
          return recusouMarcar(res);
        }
        if (p.passo) p.passo.marcarRecusado = false;
        recusouNaRodada = false;
        marcouNaRodada = true;
        // o igual não gravou nada: o cancelar seguinte cancela o retorno que já existia
        const bruto = (r as { data?: unknown }).data;
        const igual =
          bruto !== null &&
          typeof bruto === "object" &&
          (bruto as Record<string, unknown>)["igual"] === true;
        if (!igual) gravouNaRodada = true;
        return res;
      });
      // o abort no meio não perde a auditoria, e a rodada espera por ela antes de falhar
      return avisar("marcar_retorno", entrada, resultado);
    },
  });

  const cancelar_retorno = tool({
    description: DESCRICAO_CANCELAR,
    inputSchema: z.object({
      motivo: textoCurto(MAX_MOTIVO_RETORNO).describe(
        "Por que cancelou, numa frase curta (a equipe lê).",
      ),
    }),
    execute: async (entrada): Promise<ResultadoFerramenta> => {
      // fora da mista, o banco cancelaria o retorno que esta mesma rodada acabou de marcar
      // (recados 6 e 14): o marcar_retorno já trocou o anterior, não há o que cancelar
      if (gravouNaRodada && p.retornoDaRodada === undefined) {
        return {
          erro: "retorno_ja_trocado",
          orientacao:
            "Não há o que cancelar agora: o marcar_retorno desta resposta já trocou o retorno " +
            "anterior. Se o lead desistiu de vez, não confirme dia nem hora; na hora marcada você " +
            "relê a conversa e pode não mandar nada.",
        };
      }
      const resultado = chamarJson("nina_cancelar_retorno", {
        p_rodada: p.rodadaId,
        p_motivo: entrada.motivo,
      }).then((r) => resultadoDoCancelar(r, agoraDe()));
      return avisar("cancelar_retorno", entrada, resultado);
    },
  });

  return {
    responder: tool({
      description: descricaoResponder,
      inputSchema: esquemaResponder,
      execute: async (entrada: EntradaResponder): Promise<ResultadoFerramenta> => {
        // a marcação recusada neste passo: a confirmação não vai (o laço segue e o modelo vê a recusa)
        if (p.passo?.marcarRecusado) {
          return { erro: "retorno_recusado", orientacao: ORIENTACAO_RESPOSTA_CEGA };
        }
        // na rodada pura, o raciocínio escrito como resposta é recusado uma vez, apontando o
        // sem_resposta; da 2ª vez vale, e a rodada conclui vazia
        if (pura && !bastidorAvisado) {
          const partes = partesDoResponder(entrada);
          if (partes.length > 0 && partes.every(ehBastidor)) {
            bastidorAvisado = true;
            return { erro: "bastidor", orientacao: ORIENTACAO_BASTIDOR };
          }
        }
        return { ok: true };
      },
    }),

    ...(pura
      ? {}
      : {
          mover_etapa: tool({
            description:
              "Move o lead no funil para uma das etapas permitidas, pela chave. Em motivo, diga numa " +
              "frase curta por que está movendo (a equipe lê no Kanban).",
            inputSchema: z.object({
              etapa: z.string().trim().min(1).max(100),
              motivo: textoCurto(MAX_MOTIVO_MOVER),
            }),
            execute: async ({ etapa, motivo }): Promise<ResultadoFerramenta> => {
              const alvo = porChave.get(etapa);
              if (!alvo) return { erro: "etapa_nao_permitida", permitidas: chaves };
              // já recusado nesta rodada: o banco recusaria de novo
              if (travada) return { erro: ETAPA_TRAVADA, orientacao: ORIENTACAO_ETAPA_TRAVADA };
              const resultado = chamar("nina_mover_etapa", {
                p_rodada: p.rodadaId,
                p_etapa: alvo.id,
              }).then((r): ResultadoFerramenta => {
                if ("erro" in r && r.erro === ETAPA_TRAVADA) {
                  travada = true;
                  return { erro: ETAPA_TRAVADA, orientacao: ORIENTACAO_ETAPA_TRAVADA };
                }
                return r;
              });
              // o motivo fica na entrada gravada em rodadas.ferramentas (o Kanban lê por lá)
              return avisar("mover_etapa", { etapa, motivo }, resultado);
            },
          }),
        }),

    atualizar_contato: tool({
      description:
        "Guarda dados que o lead informou (nome, e-mail, empresa; só entram se ainda estiverem " +
        "vazios no cadastro), um resumo curto do que você já sabe dele, os fatos importantes " +
        '(rótulo e valor) e o próximo passo da venda (uma ação, como "Mandar o contrato"; o ' +
        "retorno combinado com o lead nunca vai aqui, ele é guardado à parte). Mande só os campos " +
        "que mudaram; em fatos, mande a lista completa e atualizada; proximo_passo null apaga o que " +
        "estava guardado.",
      inputSchema: z.object({
        nome: textoCurto(200).optional(),
        email: textoCurto(320).optional(),
        empresa: textoCurto(200).optional(),
        resumo: textoCurto(2000).optional(),
        fatos: z
          .array(
            z.object({ rotulo: textoCurto(MAX_ROTULO_FATO), valor: textoCurto(MAX_VALOR_FATO) }),
          )
          .min(1)
          .max(MAX_FATOS)
          .optional(),
        proximo_passo: z
          .object({ titulo: textoCurto(MAX_TITULO_PASSO), texto: textoCurto(MAX_TEXTO_PASSO) })
          .nullable()
          .optional(),
      }),
      execute: async (campos): Promise<ResultadoFerramenta> => {
        const p_campos: Record<string, Json> = {};
        if (campos.nome) p_campos["nome"] = campos.nome;
        if (campos.email) p_campos["email"] = campos.email;
        if (campos.empresa) p_campos["empresa"] = campos.empresa;
        if (campos.resumo) p_campos["resumo_nina"] = campos.resumo;
        if (campos.fatos && campos.fatos.length > 0) {
          p_campos["fatos"] = campos.fatos.map((f) => ({ rotulo: f.rotulo, valor: f.valor }));
        }
        // null apaga o próximo passo guardado (o banco já aceita: nina_atualizar_contato)
        if (campos.proximo_passo !== undefined) {
          p_campos["proximo_passo"] =
            campos.proximo_passo === null
              ? null
              : { titulo: campos.proximo_passo.titulo, texto: campos.proximo_passo.texto };
        }
        if (Object.keys(p_campos).length === 0) return { erro: "nada_para_atualizar" };
        // o nina_atualizar_contato do pacote (0006) aceita fatos e proximo_passo no formato que o
        // inputSchema já garante; uma recusa volta ao modelo como as outras
        const resultado = chamar("nina_atualizar_contato", { p_rodada: p.rodadaId, p_campos });
        return avisar("atualizar_contato", campos, resultado);
      },
    }),

    ...(pura
      ? {}
      : {
          passar_para_humano: tool({
            description:
              "Passa a conversa para a equipe. Depois, despeça-se do lead pela ferramenta responder.",
            inputSchema: z.object({ motivo: textoCurto(500) }),
            execute: async (entrada): Promise<ResultadoFerramenta> =>
              avisar(
                "passar_para_humano",
                entrada,
                chamar("nina_passar_para_humano", { p_rodada: p.rodadaId }),
              ),
          }),
        }),

    ...(p.marcarRetorno && !pura ? { marcar_retorno, cancelar_retorno } : {}),

    ...(pura || p.depoisDaLigacao
      ? {
          sem_resposta: ferramentaSemResposta(pura ? tipo : "ligacao", () => ({
            passoRecusado: p.passo?.marcarRecusado === true,
            recusou: recusouNaRodada,
            marcou: marcouNaRodada,
          })),
        }
      : {}),
  };
}

type VarianteSemResposta = "ligacao" | "retorno" | "lembrete";

const DESCRICAO_SEM_RESPOSTA: Record<VarianteSemResposta, string> = {
  ligacao:
    "Termina sem mandar nada ao lead. Use só quando não há nada combinado na ligação para mandar " +
    "por escrito e nada que o lead escreveu ficou sem resposta. Se nesta vez você marcou um " +
    "retorno, ou tentou e ele foi recusado, use responder. Em motivo, uma frase curta (fica no " +
    "registro da rodada, o lead não vê).",
  retorno:
    "Termina sem mandar nada ao lead na hora do retorno: use quando, relendo a conversa, o retorno " +
    "não faz mais sentido (o lead já resolveu, desistiu, pediu para não ser chamado ou a equipe já " +
    "cuidou do assunto). Em motivo, uma frase curta com o porquê (a equipe lê no histórico; o lead " +
    "não vê).",
  lembrete:
    "Termina sem mandar o lembrete: use quando, relendo a conversa, lembrar o lead não faz sentido " +
    "(ele se despediu, recusou, disse que não tem interesse ou que responde depois). Em motivo, " +
    "uma frase curta (fica no registro da rodada; o lead não vê).",
};

/**
 * Termina a rodada sem mensagem (depois da ligação, e nas rodadas puras). O nome é contrato com
 * os fechos do laço, com a rodada e com o banco (o motivo do retorno dispensado vem daqui). As
 * recusas existem para a ligação: a voz já prometeu ao lead que a Nina escreve.
 */
function ferramentaSemResposta(
  variante: VarianteSemResposta,
  estado: () => { passoRecusado: boolean; recusou: boolean; marcou: boolean },
) {
  return tool({
    description: DESCRICAO_SEM_RESPOSTA[variante],
    inputSchema: z.object({ motivo: textoCurto(200) }),
    execute: async (): Promise<ResultadoFerramenta> => {
      const e = estado();
      if (e.passoRecusado) {
        return {
          erro: "retorno_recusado",
          orientacao:
            "A rodada não terminou: marcar_retorno foi recusada neste mesmo passo. Avise o lead " +
            "pelo responder, seguindo a orientação da recusa.",
        };
      }
      if (variante === "ligacao" && e.recusou) {
        return {
          erro: "retorno_recusado",
          orientacao:
            "A marcação do retorno foi recusada, e o lead ouviu na ligação que você ia escrever. " +
            "Explique a ele pelo responder e combine outra coisa.",
        };
      }
      if (variante === "ligacao" && e.marcou && CONFIRMAR_RETORNO_DA_LIGACAO) {
        return {
          erro: "confirme_o_retorno",
          orientacao:
            "Você marcou um retorno pedido na ligação: confirme ao lead pelo responder, numa " +
            "mensagem curta, com o dia e a hora. A transcrição pode ter errado, e a mensagem deixa " +
            "o lead corrigir.",
        };
      }
      return { ok: true };
    },
  });
}

export type FerramentasNina = ReturnType<typeof criarFerramentas>;
