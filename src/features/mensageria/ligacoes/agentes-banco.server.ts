// Os agentes de voz e os limites das ligações no banco (2.1 e 2.2), pelo
// supabaseAdmin: ligacao_agentes (só o servidor grava; o membro lê pela RLS) e as colunas
// configuracao.ligacoes_*. Só entra pela lógica dos agentes e da ativação
// (mensageria/configuracao/agentes-ligacao.server.ts e ligacoes.server.ts). Erro do banco vira um
// Error com código curto, nunca com os detalhes do PostgREST.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

import type { AgenteVoz, LimitesLigacoes } from "./tipos";

/** Uma linha de ligacao_agentes, na forma do servidor. */
export type LinhaAgente = AgenteVoz & {
  id: string;
  atende: boolean;
  /** O id do agente na ElevenLabs; null = ainda não existe lá. */
  idExterno: string | null;
  versaoConfig: number;
  sincronizadoEm: string | null;
  erroSincronia: string | null;
  criadoEm: string;
  /**
   * A versão da linha (o gatilho a renova em toda mudança): a sincronia só grava se a linha ainda
   * está como ela leu (Sincronia.seAtualizadoEm).
   */
  atualizadoEm: string;
};

const COLUNAS =
  "id, nome, uso, objetivo, instrucoes, regras_equipe, voz_id, voz_nome, perfil, saudacao, duracao_max_s, " +
  "silencio_s, atende, id_externo, versao_config, sincronizado_em, erro_sincronia, criado_em, " +
  "atualizado_em";

type Linha = {
  id: string;
  nome: string;
  uso: AgenteVoz["uso"];
  objetivo: AgenteVoz["objetivo"];
  instrucoes: string;
  regras_equipe: string | null;
  voz_id: string | null;
  voz_nome: string | null;
  perfil: AgenteVoz["perfil"];
  saudacao: string;
  duracao_max_s: number;
  silencio_s: number;
  atende: boolean;
  id_externo: string | null;
  versao_config: number;
  sincronizado_em: string | null;
  erro_sincronia: string | null;
  criado_em: string;
  atualizado_em: string;
};

function falhaBanco(operacao: string, e?: { code?: string } | null): Error {
  return new Error(`banco_${operacao}${e?.code ? `:${e.code}` : ""}`);
}

function deLinha(l: Linha): LinhaAgente {
  return {
    id: l.id,
    nome: l.nome,
    uso: l.uso,
    objetivo: l.objetivo,
    instrucoes: l.instrucoes,
    regrasEquipe: l.regras_equipe,
    vozId: l.voz_id,
    vozNome: l.voz_nome,
    perfil: l.perfil,
    saudacao: l.saudacao,
    duracaoMaxS: l.duracao_max_s,
    silencioS: l.silencio_s,
    atende: l.atende,
    idExterno: l.id_externo,
    versaoConfig: l.versao_config,
    sincronizadoEm: l.sincronizado_em,
    erroSincronia: l.erro_sincronia,
    criadoEm: l.criado_em,
    atualizadoEm: l.atualizado_em,
  };
}

/** Os campos do agente como colunas (o que o admin edita). */
function colunasDe(a: AgenteVoz) {
  return {
    nome: a.nome,
    uso: a.uso,
    objetivo: a.objetivo,
    instrucoes: a.instrucoes,
    regras_equipe: a.regrasEquipe,
    voz_id: a.vozId,
    voz_nome: a.vozNome,
    perfil: a.perfil,
    saudacao: a.saudacao,
    duracao_max_s: a.duracaoMaxS,
    silencio_s: a.silencioS,
  };
}

/** Todos os agentes, do mais antigo ao mais novo. */
export async function listarAgentes(): Promise<LinhaAgente[]> {
  const { data, error } = await supabaseAdmin
    .from("ligacao_agentes")
    .select(COLUNAS)
    .order("criado_em", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw falhaBanco("ler_agentes", error);
  return ((data ?? []) as unknown as Linha[]).map(deLinha);
}

export async function lerAgente(id: string): Promise<LinhaAgente | null> {
  const { data, error } = await supabaseAdmin
    .from("ligacao_agentes")
    .select(COLUNAS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw falhaBanco("ler_agente", error);
  return data ? deLinha(data as unknown as Linha) : null;
}

/** Cria a linha do agente. `atende` só para o primeiro (o índice único parcial confere). */
export async function inserirAgente(
  campos: AgenteVoz,
  d: { atende: boolean; criadoPor: string | null },
): Promise<LinhaAgente> {
  const { data, error } = await supabaseAdmin
    .from("ligacao_agentes")
    .insert({ ...colunasDe(campos), atende: d.atende, criado_por: d.criadoPor })
    .select(COLUNAS)
    .single();
  if (error || !data) throw falhaBanco("criar_agente", error);
  return deLinha(data as unknown as Linha);
}

/**
 * Solta o agente antes de apagá-lo lá (ligacao_agente_soltar, base 0039): na mesma transação que
 * confere que ele não atende e não tem ligação em andamento, o id dele sai da linha; a reserva de
 * uma saída com ele espera ou recusa (Sol, PR #26). Devolve o motivo da recusa ou o id que saiu.
 */
export async function soltarAgente(
  id: string,
): Promise<
  | { ok: true; idExterno: string | null }
  | { ok: false; motivo: "nao_encontrado" | "atende" | "em_ligacao" }
> {
  const { data, error } = await supabaseAdmin.rpc("ligacao_agente_soltar", { p_agente: id });
  if (error) throw falhaBanco("soltar_agente", error);
  const linha = (Array.isArray(data) ? data[0] : data) as
    { motivo: string | null; id_externo: string | null } | undefined;
  if (!linha) throw falhaBanco("soltar_agente");
  if (
    linha.motivo === "nao_encontrado" ||
    linha.motivo === "atende" ||
    linha.motivo === "em_ligacao"
  )
    return { ok: false, motivo: linha.motivo };
  return { ok: true, idExterno: linha.id_externo };
}

/** Grava os campos do admin. null = o agente não existe mais. */
export async function atualizarCamposAgente(
  id: string,
  campos: AgenteVoz,
): Promise<LinhaAgente | null> {
  const { data, error } = await supabaseAdmin
    .from("ligacao_agentes")
    .update(colunasDe(campos))
    .eq("id", id)
    .select(COLUNAS);
  if (error) throw falhaBanco("salvar_agente", error);
  const linha = (data ?? [])[0] as unknown as Linha | undefined;
  return linha ? deLinha(linha) : null;
}

/** O que a sincronia com a ElevenLabs grava na linha. Campo ausente fica como está. */
export type Sincronia = {
  idExterno?: string | null;
  versaoConfig?: number;
  sincronizadoEm?: string | null;
  erroSincronia: string | null;
  /** Só grava se a linha ainda tem este atualizado_em (ninguém mudou a linha desde a leitura). */
  seAtualizadoEm?: string;
  /** Só grava se a linha ainda tem este id_externo (null = sem id). */
  seIdExterno?: string | null;
};

/**
 * Grava o resultado da sincronia. false = 0 linhas: o agente não existe mais, ou a linha não está
 * mais como a condição pede (seAtualizadoEm, seIdExterno).
 */
export async function gravarSincronia(id: string, s: Sincronia): Promise<boolean> {
  const campos: {
    erro_sincronia: string | null;
    id_externo?: string | null;
    versao_config?: number;
    sincronizado_em?: string | null;
  } = { erro_sincronia: s.erroSincronia === null ? null : s.erroSincronia.slice(0, 500) };
  if (s.idExterno !== undefined) campos.id_externo = s.idExterno;
  if (s.versaoConfig !== undefined) campos.versao_config = s.versaoConfig;
  if (s.sincronizadoEm !== undefined) campos.sincronizado_em = s.sincronizadoEm;
  let consulta = supabaseAdmin.from("ligacao_agentes").update(campos).eq("id", id);
  if (s.seAtualizadoEm !== undefined) consulta = consulta.eq("atualizado_em", s.seAtualizadoEm);
  if (s.seIdExterno === null) consulta = consulta.is("id_externo", null);
  else if (s.seIdExterno !== undefined) consulta = consulta.eq("id_externo", s.seIdExterno);
  const { data, error } = await consulta.select("id");
  if (error) throw falhaBanco("sincronia_agente", error);
  return (data ?? []).length === 1;
}

/**
 * Apaga a linha (o histórico fica: ligacoes.agente_id vira nulo). false = já não existia. A que
 * atende só sai com `mesmoQueAtende` (o desfazer de uma linha que acabou de nascer).
 */
export async function apagarLinhaAgente(
  id: string,
  opcoes: {
    mesmoQueAtende?: boolean;
    /** Só se a linha continua sem o agente lá (o apagar soltou; uma sincronia não recriou). */
    soSemId?: boolean;
  } = {},
): Promise<boolean> {
  let consulta = supabaseAdmin.from("ligacao_agentes").delete().eq("id", id);
  if (!opcoes.mesmoQueAtende) consulta = consulta.eq("atende", false);
  if (opcoes.soSemId) consulta = consulta.is("id_externo", null);
  const { data, error } = await consulta.select("id");
  if (error) throw falhaBanco("apagar_agente", error);
  return (data ?? []).length === 1;
}

/** ligacao_agente_atender: este agente passa a atender, numa transação (L11). */
export async function atenderAgente(id: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc("ligacao_agente_atender", { p_agente: id });
  if (error) throw falhaBanco("atender_agente", error);
}

/**
 * Os agentes apagados na ElevenLabs (a desativação): id_externo volta a nulo, sem apagar as linhas.
 * Na reativação, os agentes são recriados a partir delas.
 */
export async function zerarIdsExternos(idsExternos: readonly string[]): Promise<void> {
  const ids = [...new Set(idsExternos.filter((x) => x))];
  if (ids.length === 0) return;
  const { error } = await supabaseAdmin
    .from("ligacao_agentes")
    .update({ id_externo: null, sincronizado_em: null, erro_sincronia: null })
    .in("id_externo", ids);
  if (error) throw falhaBanco("zerar_agentes", error);
}

/** Os limites da conta (L19). */
export async function lerLimites(): Promise<LimitesLigacoes> {
  const { data, error } = await supabaseAdmin
    .from("configuracao")
    .select("ligacoes_simultaneas, ligacoes_por_dia, ligacoes_por_contato")
    .eq("id", 1)
    .maybeSingle();
  if (error || !data) throw falhaBanco("ler_limites", error);
  return {
    simultaneas: data.ligacoes_simultaneas,
    porDia: data.ligacoes_por_dia,
    porContato: data.ligacoes_por_contato,
  };
}

export async function gravarLimites(l: LimitesLigacoes): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("configuracao")
    .update({
      ligacoes_simultaneas: l.simultaneas,
      ligacoes_por_dia: l.porDia,
      ligacoes_por_contato: l.porContato,
    })
    .eq("id", 1)
    .select("id");
  if (error) throw falhaBanco("gravar_limites", error);
  if ((data ?? []).length !== 1) throw falhaBanco("gravar_limites");
}
