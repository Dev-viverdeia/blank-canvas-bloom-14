// O banco das rotas de ligação (2.2), pelo supabaseAdmin. As escritas
// são as funções do envio 3, uma transação cada (L17): o início (ligacao_iniciar: a mensagem do
// tipo "ligacao" na conversa e a linha do histórico, com o limite por contato), o fim
// (ligacao_encerrar) e a passagem para a equipe (ligacao_passar_para_equipe, uma vez por ligação).
// Erro do banco vira ErroBanco com um código curto, nunca com os detalhes do PostgREST.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";

import { marcadorDe, type MensagemHistorico } from "../ia/historico.server";
import { neutralizar, type ContextoNina } from "../ia/instrucoes";
import { ErroBanco } from "../nucleo/banco.server";
import { ehMensagemDeLigacao } from "./registro";
import type { Identificador } from "../nucleo/tipos";
import {
  MENSAGENS_DO_LEAD,
  textoDoAvisoDeFalha,
  textoDoContexto,
  textoDoLead,
  type FalaDoLead,
} from "./contexto";
import type { FalaGravada } from "./registro";
import type { UsoAgente } from "./tipos";

function erro(operacao: string, e: { code?: string; message?: string } | null): ErroBanco {
  // o P0001 das funções do banco traz um código curto na mensagem (ligacao_invalida etc.)
  const codigo =
    e?.code === "P0001" && /^[a-z_]{1,40}$/.test(e.message ?? "") ? e.message! : e?.code;
  return new ErroBanco(operacao, codigo ?? "desconhecido");
}

// ---------------------------------------------------------------------------
// O agente e o Contexto (lidos juntos no início)
// ---------------------------------------------------------------------------

export type AgenteDaLigacao = {
  id: string;
  /** O modelo da saudação ({nome} vira o primeiro nome do lead). */
  saudacao: string;
  /** A última sincronia com a ElevenLabs (o Contexto que está no prompt dele). */
  sincronizadoEm: string | null;
  /** A duração máxima da ligação, em segundos (a validade da sessão sai dela). */
  duracaoMaxS: number | null;
  /** Receptivo ou Ativo (A1). */
  uso: UsoAgente;
};

/** O agente da Nina que tem este id na ElevenLabs. null = nenhum (o agente da primeira versão). */
export async function lerAgenteDaLigacao(idExterno: string): Promise<AgenteDaLigacao | null> {
  const { data, error } = await supabaseAdmin
    .from("ligacao_agentes")
    .select("id, saudacao, sincronizado_em, duracao_max_s, uso")
    .eq("id_externo", idExterno)
    .maybeSingle();
  if (error) throw erro("ligacao_agente", error);
  if (!data) return null;
  return {
    id: data.id,
    saudacao: data.saudacao,
    sincronizadoEm: data.sincronizado_em,
    duracaoMaxS: typeof data.duracao_max_s === "number" ? data.duracao_max_s : null,
    uso: data.uso === "ligar" ? "ligar" : "receber",
  };
}

export type ContextoAtual = {
  /** O Contexto em texto corrido, inteiro (textoDoContexto). "" quando não há versão. */
  texto: string;
  /** Quando a versão mais recente foi gravada. null = ainda não há versão. */
  criadoEm: string | null;
};

/** A versão mais recente do Contexto (a de maior id, a mesma que a Nina de texto usa). */
export async function lerContextoAtual(): Promise<ContextoAtual> {
  const { data, error } = await supabaseAdmin
    .from("contexto_versoes")
    .select("*")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw erro("ligacao_contexto", error);
  const linha = (data as (Partial<ContextoNina> & { criado_em?: string }) | null) ?? null;
  return { texto: textoDoContexto(linha), criadoEm: linha?.criado_em ?? null };
}

// ---------------------------------------------------------------------------
// As funções do envio 3
// ---------------------------------------------------------------------------

export type InicioGravado = {
  ligacaoId: string | null;
  conversaId: string | null;
  permitida: boolean;
  /** "limite_por_contato" quando não é permitida. */
  motivo: string | null;
};

/**
 * ligacao_iniciar: a mensagem da ligação na conversa (pela registrar_entrada) e a linha do
 * histórico, numa transação, com o limite por contato. Idempotente pelo id da conversa na
 * ElevenLabs: o mesmo início de novo (ou o pós-chamada sem o início) devolve a mesma ligação.
 */
export async function iniciarLigacao(d: {
  conexaoId: string;
  ids: Identificador[];
  /** O id da conversa na ElevenLabs. */
  idExterno: string;
  agenteId: string | null;
  momento: string;
  /**
   * Confere os limites da conta (simultâneas e por dia, todos os agentes): só no início da ligação.
   * O pós-chamada que grava uma ligação que já aconteceu não confere (Sol, PR #26).
   */
  conferirConta?: boolean;
}): Promise<InicioGravado> {
  const args = {
    p_conexao: d.conexaoId,
    p_ids: d.ids as unknown as Json,
    p_nome_whatsapp: "",
    p_id_externo: d.idExterno,
    // o banco aceita nulo (o agente da primeira versão, sem linha)
    p_agente: d.agenteId as string,
    p_direcao: "entrada" as const,
    p_momento: d.momento,
  };
  // a versão de 8 argumentos (base 0039) só no início; a de 7, sem mudança, no pós-chamada
  const { data, error } = d.conferirConta
    ? await supabaseAdmin.rpc("ligacao_iniciar", { ...args, p_conferir_conta: true })
    : await supabaseAdmin.rpc("ligacao_iniciar", args);
  if (error) throw erro("ligacao_iniciar", error);
  const linha = Array.isArray(data) ? data[0] : data;
  if (!linha) throw new ErroBanco("ligacao_iniciar", "sem_linha");
  return {
    ligacaoId: linha.ligacao_id ?? null,
    conversaId: linha.conversa_id ?? null,
    permitida: linha.permitida === true,
    motivo: linha.motivo ?? null,
  };
}

export type FimDaLigacao = {
  status: "concluida" | "nao_completada";
  encerradaEm: string | null;
  duracaoS: number | null;
  motivoFim: string | null;
  resumo: string | null;
  transcricao: FalaGravada[];
  custoCreditos: number | null;
};

/**
 * ligacao_encerrar: o fim da ligação, o rótulo da mensagem e a prévia. null = a ligação não está
 * gravada (o início falhou): quem chama inicia e repete. Vazio não apaga o que já existe, e uma
 * falha atrasada não desfaz uma ligação concluída (o banco cuida).
 */
export async function encerrarLigacao(
  idExterno: string,
  fim: FimDaLigacao,
): Promise<{ ligacaoId: string; conversaId: string } | null> {
  const { data, error } = await supabaseAdmin.rpc("ligacao_encerrar", {
    p_id_externo: idExterno,
    p_status: fim.status,
    // o banco aceita nulo em todos estes (mantém o que já está gravado)
    p_encerrada_em: fim.encerradaEm as string,
    p_duracao_s: fim.duracaoS as number,
    p_motivo_fim: fim.motivoFim as string,
    p_resumo: fim.resumo as string,
    p_transcricao: fim.transcricao as unknown as Json,
    p_custo_creditos: fim.custoCreditos as number,
  });
  if (error) throw erro("ligacao_encerrar", error);
  const linha = Array.isArray(data) ? data[0] : data;
  if (!linha?.ligacao_id) return null;
  return { ligacaoId: linha.ligacao_id, conversaId: linha.conversa_id };
}

/** O id provisório da ligação de saída: "saida-<id da linha>" . */
const PROVISORIO = /^saida-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * A ligação pelo id da conversa na ElevenLabs. O id provisório da saída (o da sessão) acha a linha
 * pelo id dela, mesmo depois da confirmação. null = não gravada.
 */
export async function acharLigacao(idExterno: string): Promise<{ id: string } | null> {
  const provisorio = PROVISORIO.exec(idExterno);
  const consulta = supabaseAdmin.from("ligacoes").select("id");
  const { data, error } = await (
    provisorio
      ? consulta.eq("id", provisorio[1]!).eq("direcao", "saida")
      : consulta.eq("id_externo", idExterno)
  ).maybeSingle();
  if (error) throw erro("ligacao_achar", error);
  return data ? { id: data.id } : null;
}

/**
 * Depois de fechar uma ligação como concluída: se a rodada pegou o registro dela enquanto ela ainda
 * estava em andamento (passou do teto da espera) e terminou vazia, solta o registro e arma a
 * conversa (ligacao_rearmar_depois, base 0033): a rodada depois da ligação não se perde. Nunca
 * lança.
 */
export async function rearmarDepoisDaLigacao(ligacaoId: string): Promise<"armou" | "nao" | "erro"> {
  try {
    const { data, error } = await supabaseAdmin.rpc("ligacao_rearmar_depois", {
      p_ligacao: ligacaoId,
    });
    if (error) {
      console.error("ligacao_rearmar", erro("ligacao_rearmar", error).message);
      return "erro";
    }
    return data === true ? "armou" : "nao";
  } catch {
    return "erro";
  }
}

/** O modo da conversa ("nina" ou "humano"); null se ela não existe. */
export async function modoDaConversa(conversaId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("conversas")
    .select("modo")
    .eq("id", conversaId)
    .maybeSingle();
  if (error) throw erro("ligacao_modo", error);
  return data?.modo ?? null;
}

/** A linha que vai no nina_lead quando a conversa já está com a equipe. */
export const LEAD_COM_EQUIPE =
  "Esta conversa já está com a equipe: o que precisar ir por escrito, a equipe manda por mensagem neste WhatsApp.";

/**
 * A ligação de entrada que não completou vira mensagem no chat (envio nina_ligacao_aviso_falha):
 * o texto com o primeiro nome do contato, e a ligacao_avisar_falha decide se avisa (uma vez por
 * ligação, uma a cada 10 min por conversa, só entrada, nada se veio ligação mais nova, se o lead já
 * escreveu ou se a conversa está com a equipe). Nunca lança: quem chama está no meio de um webhook
 * ou do fechamento das presas. "avisada" = a mensagem ficou na fila (quem chama acorda o worker).
 */
export async function avisarFalhaDaLigacao(
  ligacaoId: string,
  conversaId: string,
): Promise<"avisada" | "nao" | "erro"> {
  try {
    const conversa = await supabaseAdmin
      .from("conversas")
      .select("contato_id")
      .eq("id", conversaId)
      .maybeSingle();
    if (conversa.error) throw erro("ligacao_aviso", conversa.error);
    let nome: string | null = null;
    if (conversa.data?.contato_id) {
      const contato = await supabaseAdmin
        .from("contatos")
        .select("nome, nome_whatsapp")
        .eq("id", conversa.data.contato_id)
        .maybeSingle();
      if (contato.error) throw erro("ligacao_aviso", contato.error);
      nome = contato.data?.nome ?? contato.data?.nome_whatsapp ?? null;
    }
    const { data, error } = await supabaseAdmin.rpc("ligacao_avisar_falha", {
      p_ligacao: ligacaoId,
      p_texto: textoDoAvisoDeFalha(nome),
    });
    if (error) throw erro("ligacao_aviso", error);
    return typeof data === "string" && data !== "" ? "avisada" : "nao";
  } catch (e) {
    console.error("ligacao_aviso", e instanceof ErroBanco ? e.message : "erro");
    return "erro";
  }
}

/**
 * ligacao_passar_para_equipe: o mesmo efeito da nina_passar_para_humano, sem rodada, uma vez por
 * ligação (D24 virou ligacoes.passou_equipe). true = a conversa mudou de mãos agora.
 */
export async function passarLigacaoParaEquipe(ligacaoId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("ligacao_passar_para_equipe", {
    p_ligacao: ligacaoId,
  });
  if (error) throw erro("ligacao_passar", error);
  return data === true;
}

// ---------------------------------------------------------------------------
// O lead (o nina_lead e o nome da saudação)
// ---------------------------------------------------------------------------

export type LeadDaLigacao = { nome: string | null; texto: string };

const SEM_LEAD = (): LeadDaLigacao => ({
  nome: null,
  texto: textoDoLead({ nome: null, etapa: null, resumo: null, falas: [] }),
});

/**
 * O lead da conversa: o nome para a saudação e o texto do nina_lead. A mensagem idExternoAtual (a
 * desta ligação) fica de fora das últimas mensagens. Duas idas ao banco: a conversa, as mensagens
 * e as etapas juntas; depois o contato e, se houver ligação entre as mensagens, o resumo dela
 * (L32: a ligação anterior entra como "[ligação] <rótulo>" e o resumo, com o teto de cada fala).
 */
export async function lerLeadDaLigacao(
  conversaId: string,
  idExternoAtual?: string,
): Promise<LeadDaLigacao> {
  const [conversa, msgs, etapas] = await Promise.all([
    supabaseAdmin.from("conversas").select("contato_id").eq("id", conversaId).maybeSingle(),
    supabaseAdmin
      .from("mensagens")
      .select(
        "id, id_externo, direcao, origem, tipo, texto, transcricao, midia_caminho, midia_mime, " +
          "midia_nome, midia_status, momento",
      )
      .eq("conversa_id", conversaId)
      .not("status", "in", "(cancelada,falhou)")
      .is("apagada_em", null)
      .order("momento", { ascending: false })
      .limit(MENSAGENS_DO_LEAD + 1),
    // as etapas são poucas (o kanban): ler todas evita uma terceira ida
    supabaseAdmin.from("etapas").select("id, nome"),
  ]);
  if (conversa.error) throw erro("ligacao_lead", conversa.error);
  if (msgs.error) throw erro("ligacao_lead", msgs.error);
  if (etapas.error) throw erro("ligacao_lead", etapas.error);
  if (!conversa.data) return SEM_LEAD();

  type Linha = MensagemHistorico & { id_externo: string | null };
  const linhas = ((msgs.data ?? []) as unknown as Linha[])
    .filter((m) => !idExternoAtual || m.id_externo !== idExternoAtual)
    .slice(0, MENSAGENS_DO_LEAD)
    .reverse();
  const deLigacao = linhas.filter(ehMensagemDeLigacao).map((m) => m.id);

  const [contato, resumos] = await Promise.all([
    supabaseAdmin
      .from("contatos")
      .select("nome, nome_whatsapp, resumo_nina, etapa_id")
      .eq("id", conversa.data.contato_id)
      .maybeSingle(),
    deLigacao.length > 0
      ? supabaseAdmin
          .from("ligacoes")
          .select("mensagem_id, resumo, direcao")
          .in("mensagem_id", deLigacao)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (contato.error) throw erro("ligacao_lead", contato.error);
  if (resumos.error) throw erro("ligacao_lead", resumos.error);
  type Resumo = { mensagem_id: string | null; resumo: string | null; direcao?: string | null };
  const resumoDa = new Map(
    ((resumos.data ?? []) as Resumo[]).filter((l) => l.mensagem_id).map((l) => [l.mensagem_id!, l]),
  );

  const etapaId = contato.data?.etapa_id ?? null;
  const etapa = etapaId
    ? (((etapas.data ?? []) as { id: string; nome: string }[]).find((e) => e.id === etapaId)
        ?.nome ?? null)
    : null;

  const falas: FalaDoLead[] = linhas.map((l) => {
    // a ligação anterior leva o resumo dela (as falas não: o teto de cada fala as cortaria)
    const lig = ehMensagemDeLigacao(l) ? resumoDa.get(l.id) : undefined;
    const saida = lig?.direcao === "saida";
    const m: MensagemHistorico = ehMensagemDeLigacao(l)
      ? {
          ...l,
          ligacao: { resumo: lig?.resumo ?? null, transcricao: [], ...(saida ? { saida } : {}) },
        }
      : l;
    // a ligação feita pela empresa é gravada como entrada, mas quem ligou foi a Nina (Opus, PR #24)
    if (saida) return { quem: "Nina", texto: marcadorDe(m, neutralizar) };
    if (m.direcao === "entrada") return { quem: "Lead", texto: marcadorDe(m, neutralizar) };
    if (m.origem === "nina" && m.tipo === "audio") {
      return { quem: "Nina", texto: (m.transcricao ?? "").trim() };
    }
    return { quem: m.origem === "nina" ? "Nina" : "Equipe", texto: marcadorDe(m) };
  });

  const nome = contato.data?.nome ?? contato.data?.nome_whatsapp ?? null;
  return {
    nome,
    texto: textoDoLead({ nome, etapa, resumo: contato.data?.resumo_nina ?? null, falas }),
  };
}

/**
 * A ligação de saída ganha o id da conversa na ElevenLabs (ligacao_saida_confirmar, base 0035).
 * false = não é uma ligação de saída com o id provisório (ou já tem outro). Lança se o banco falhar.
 */
export async function confirmarLigacaoDeSaida(
  ligacaoId: string,
  conversaEleven: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("ligacao_saida_confirmar", {
    p_ligacao: ligacaoId,
    p_id_externo: conversaEleven,
  });
  if (error) throw erro("ligacao_saida_confirmar", error);
  return data === true;
}
