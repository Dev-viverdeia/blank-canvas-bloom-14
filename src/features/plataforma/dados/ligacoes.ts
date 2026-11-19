import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  adotarAgenteDoTronco,
  apagarAgenteLigacao,
  atenderAgenteLigacao,
  atualizarAgentesLigacao,
  criarAgenteLigacao,
  salvarAgenteLigacao,
  salvarLimitesLigacoes,
  sincronizarContextoLigacao,
} from "@/features/mensageria/ligacoes.functions";
import { agenteAtrasDoContexto } from "@/features/mensageria/ligacoes/contexto";
import { semMarcasDeEmocao } from "@/features/mensageria/ligacoes/registro";
import { VERSAO_AGENTE } from "@/features/mensageria/ligacoes/tipos";

import { CHAVES } from "./chaves";
import type { ClienteSupabase } from "./colunas";
import { estadoLigacoesExemplo } from "./configuracao";
import { paraLeitura, pronta } from "./leitura";
import { RELER_SEM_TEMPO_REAL_MS, repetirSoFalha } from "./leituras";
import { useClienteDados, useDados, useModoDados } from "./ProvedorDados";
import type { Leitura, Resultado } from "./tipos";
import { VERSAO_AGENTE_EXEMPLO } from "../exemplo/ligacoes";
import { useExemplo } from "../exemplo/ProvedorExemplo";
import type { EstadoExemplo } from "../exemplo/tipos";
import {
  LIMITES_PADRAO,
  type AgenteLigacao,
  type CamposAgente,
  type FalaLigacao,
  type Ligacao,
  type LigacaoGuardada,
  type LimitesLigacoes,
} from "../ligacoes/tipos";

// As leituras e as ações da área Ligações (2.3; fase A2). A tela lê só
// daqui, como as outras áreas: `useHistoricoLigacoes`, `useAgentesLigacao`, `useLimitesLigacoes`,
// `useSituacaoLigacoes` e `useAcoesLigacoes`.
//
// - exemplo (os testes e a demo): o estado do ProvedorExemplo (os agentes, o histórico e os limites)
//   e as ações do reducer (exemplo/ligacoes.ts), assíncronas;
// - banco (fase B): as leituras pelo cliente do navegador, sob a RLS (todo membro lê): `ligacoes`
//   (as 300 mais recentes, com o contato pela conversa; no tempo real, o "em andamento" vira
//   "concluída" sem recarregar), `ligacao_agentes` (relida no foco e a cada 60 s; o "atrás do
//   Contexto" compara a sincronia com a versão mais recente do Contexto, L14) e os limites de
//   `configuracao`. As ações são as funções de servidor da área (mensageria/ligacoes.functions.ts,
//   só admin), que levam cada mudança para a ElevenLabs; depois de cada uma, tudo de CHAVES.ligacoes
//   é relido. A ativação e a desativação não passam por aqui: são as funções de servidor da
//   Configuração (dados/configuracao.ts).

/** Os agentes de voz e a versão da configuração que o código aplica hoje (L13). */
export interface AgentesLigacao {
  agentes: AgenteLigacao[];
  /** A versão "do código": agente com `versaoConfig` menor tem atualização (o aviso da aba Agentes). */
  versaoCodigo: number;
}

/** A situação das ligações no que todo membro lê (o topo do atendente, que não chama o servidor). */
export interface SituacaoLigacoes {
  ativas: boolean;
  /** O número com as ligações ativas (o nome da conexão). */
  numero: string | null;
}

export interface AcoesLigacoes {
  /** Só o admin. `id` = o agente novo (o primeiro agente já nasce atendendo). */
  criarAgente(campos: CamposAgente): Promise<Resultado>;
  /** Só o admin. Leva a configuração inteira para a ElevenLabs (L10). */
  salvarAgente(agenteId: string, campos: CamposAgente): Promise<Resultado>;
  /** Só o admin. Recusa `agente_que_atende` para o agente que atende (L10). */
  apagarAgente(agenteId: string): Promise<Resultado>;
  /** Só o admin. Este agente passa a atender as ligações (L11). */
  atender(agenteId: string): Promise<Resultado>;
  /** Só o admin. Leva os agentes para a versão do código (L13). */
  atualizarAgentes(): Promise<Resultado>;
  /** Só o admin. */
  salvarLimites(limites: LimitesLigacoes): Promise<Resultado>;
}

/* ---------- apoio ---------- */

/** O nome do contato como as listas mostram: o da ficha, ou o do WhatsApp; nulo sem nenhum. */
function nomeDoContato(
  c: { nome: string | null; nome_whatsapp: string | null } | undefined,
): string | null {
  return c?.nome?.trim() || c?.nome_whatsapp?.trim() || null;
}

/** As ligações guardadas com o contato (pela conversa) e o nome do agente. */
export function juntarLigacoes(
  guardadas: readonly LigacaoGuardada[],
  estado: Pick<EstadoExemplo, "conversas" | "contatos">,
  agentes: readonly AgenteLigacao[],
): Ligacao[] {
  const conversas = new Map(estado.conversas.map((c) => [c.id, c]));
  const contatos = new Map(estado.contatos.map((c) => [c.id, c]));
  const nomes = new Map(agentes.map((a) => [a.id, a.nome]));
  return (
    guardadas
      // a conversa apagada (cascade) leva a ligação junto
      .filter((l) => conversas.has(l.conversaId))
      .map((l) => {
        const contato = contatos.get(conversas.get(l.conversaId)!.contato_id);
        return {
          ...l,
          contatoId: contato?.id ?? null,
          nome: nomeDoContato(contato),
          telefone: contato?.telefone ?? null,
          agenteNome: l.agenteId ? (nomes.get(l.agenteId) ?? null) : null,
        };
      })
  );
}

/* ---------- modo exemplo ---------- */

function useHistoricoExemplo(): Leitura<Ligacao[]> {
  const { estado } = useExemplo();
  const { historicoLigacoes, conversas, contatos, ligacaoAgentes } = estado;
  return useMemo(
    () =>
      pronta(
        juntarLigacoes(historicoLigacoes ?? [], { conversas, contatos }, ligacaoAgentes ?? []),
      ),
    [historicoLigacoes, conversas, contatos, ligacaoAgentes],
  );
}

function useAgentesExemplo(): Leitura<AgentesLigacao> {
  const { estado } = useExemplo();
  const agentes = estado.ligacaoAgentes;
  return useMemo(
    () => pronta({ agentes: agentes ?? [], versaoCodigo: VERSAO_AGENTE_EXEMPLO }),
    [agentes],
  );
}

function useLimitesExemplo(): Leitura<LimitesLigacoes> {
  const { estado } = useExemplo();
  const limites = estado.limitesLigacoes;
  return useMemo(() => pronta(limites ?? LIMITES_PADRAO), [limites]);
}

function useSituacaoExemplo(): Leitura<SituacaoLigacoes | null> {
  const { estado } = useExemplo();
  const { conexao, chaves, configuracao, ligacoes } = estado;
  return useMemo(() => {
    const e = estadoLigacoesExemplo({ conexao, chaves, configuracao, ligacoes });
    return pronta({ ativas: e.situacao === "ativa", numero: e.numero });
  }, [conexao, chaves, configuracao, ligacoes]);
}

function useAcoesExemplo(): AcoesLigacoes {
  const { acoes } = useExemplo();
  return useMemo<AcoesLigacoes>(
    () => ({
      criarAgente: async (campos) => acoes.criarAgenteLigacao(campos, VERSAO_AGENTE_EXEMPLO),
      salvarAgente: async (id, campos) =>
        acoes.salvarAgenteLigacao(id, campos, VERSAO_AGENTE_EXEMPLO),
      apagarAgente: async (id) => acoes.apagarAgenteLigacao(id),
      atender: async (id) => acoes.atenderAgenteLigacao(id),
      atualizarAgentes: async () => acoes.atualizarAgentesLigacao(VERSAO_AGENTE_EXEMPLO),
      salvarLimites: async (limites) => acoes.salvarLimitesLigacoes(limites),
    }),
    [acoes],
  );
}

/* ---------- modo banco ---------- */

/** Quantas ligações o Histórico lê (as mais recentes). */
export const LIMITE_HISTORICO_LIGACOES = 300;

const VALE_MS = 15_000;

const COLUNAS_AGENTE =
  "id, nome, uso, objetivo, instrucoes, regras_equipe, voz_id, voz_nome, perfil, saudacao, duracao_max_s, " +
  "silencio_s, atende, id_externo, versao_config, sincronizado_em, erro_sincronia, criado_em, atualizado_em";

const COLUNAS_LIGACAO =
  "id, conversa_id, mensagem_id, agente_id, direcao, status, iniciada_em, encerrada_em, duracao_s, " +
  "motivo_fim, resumo, transcricao, passou_equipe, objetivo";

/** Uma linha de `ligacao_agentes` como o banco devolve. */
export interface LinhaAgenteBanco {
  id: string;
  nome: string;
  /** Receptivo ou Ativo (A1); ausente = Receptivo (o padrão do banco). */
  uso?: AgenteLigacao["uso"] | undefined;
  objetivo: AgenteLigacao["objetivo"];
  instrucoes: string;
  regras_equipe: string | null;
  voz_id: string | null;
  voz_nome: string | null;
  perfil: AgenteLigacao["perfil"];
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
}

/** Uma linha de `ligacoes` como o banco devolve (com o contato, pela conversa, no Histórico). */
export interface LinhaLigacaoBanco {
  id: string;
  conversa_id: string;
  mensagem_id: string | null;
  agente_id: string | null;
  direcao: Ligacao["direcao"];
  status: Ligacao["status"];
  iniciada_em: string;
  encerrada_em: string | null;
  duracao_s: number | null;
  motivo_fim: string | null;
  resumo: string | null;
  transcricao: unknown;
  passou_equipe: boolean;
  /** O objetivo da ligação de saída (A3); nulo sem objetivo. */
  objetivo?: string | null | undefined;
  conversas?: {
    contato_id: string;
    contatos: {
      id: string;
      nome: string | null;
      nome_whatsapp: string | null;
      telefone: string | null;
    } | null;
  } | null;
}

/** O agente na forma da tela; `contextoEm` é a versão mais recente do Contexto (L14). */
export function agenteDaLinha(l: LinhaAgenteBanco, contextoEm: string | null): AgenteLigacao {
  return {
    id: l.id,
    nome: l.nome,
    uso: l.uso === "ligar" ? "ligar" : "receber",
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
    versaoConfig: l.versao_config,
    erroSincronia: l.erro_sincronia,
    atrasadoContexto: !!l.id_externo && agenteAtrasDoContexto(l.sincronizado_em, contextoEm),
    semAgenteLa: !l.id_externo,
    criadoEm: l.criado_em,
    atualizadoEm: l.atualizado_em,
  };
}

/**
 * As falas gravadas (`[{papel: "lead"|"nina", texto, segundos}]`) na forma da tela, sem as marcas de
 * emoção (as ligações gravadas antes da limpeza também saem limpas). O que vier fora do formato sai.
 */
export function falasDaLinha(json: unknown): FalaLigacao[] {
  if (!Array.isArray(json)) return [];
  const falas: FalaLigacao[] = [];
  for (const f of json) {
    if (!f || typeof f !== "object") continue;
    const o = f as Record<string, unknown>;
    const papel = o["papel"] === "lead" ? "lead" : o["papel"] === "nina" ? "agente" : null;
    const texto = typeof o["texto"] === "string" ? semMarcasDeEmocao(o["texto"]) : "";
    if (!papel || !texto) continue;
    const seg = o["segundos"];
    falas.push({
      papel,
      texto,
      segundos: typeof seg === "number" && Number.isFinite(seg) && seg > 0 ? Math.floor(seg) : 0,
    });
  }
  return falas;
}

/** A ligação na forma da tela, com o contato (pela conversa) e o nome do agente. */
export function ligacaoDaLinha(
  l: LinhaLigacaoBanco,
  nomesAgentes: ReadonlyMap<string, string>,
): Ligacao {
  const contato = l.conversas?.contatos ?? null;
  return {
    id: l.id,
    conversaId: l.conversa_id,
    mensagemId: l.mensagem_id,
    agenteId: l.agente_id,
    direcao: l.direcao,
    status: l.status,
    iniciadaEm: l.iniciada_em,
    encerradaEm: l.encerrada_em,
    duracaoS: l.duracao_s,
    motivoFim: l.motivo_fim,
    resumo: l.resumo,
    transcricao: falasDaLinha(l.transcricao),
    passouEquipe: l.passou_equipe,
    objetivo: typeof l.objetivo === "string" && l.objetivo.trim() ? l.objetivo.trim() : null,
    contatoId: contato?.id ?? l.conversas?.contato_id ?? null,
    nome: nomeDoContato(contato ?? undefined),
    telefone: contato?.telefone ?? null,
    agenteNome: l.agente_id ? (nomesAgentes.get(l.agente_id) ?? null) : null,
  };
}

function exigirCliente(cliente: ClienteSupabase | null, quem: string): ClienteSupabase {
  if (!cliente) throw new Error(`${quem} só funciona no <ProvedorDados fonte="banco">.`);
  return cliente;
}

export function opcoesAgentesLigacao(cliente: ClienteSupabase) {
  return queryOptions({
    queryKey: [...CHAVES.ligacoes, "agentes"] as const,
    queryFn: async (): Promise<LinhaAgenteBanco[]> => {
      const { data, error } = await cliente
        .from("ligacao_agentes")
        .select(COLUNAS_AGENTE)
        .order("criado_em", { ascending: true })
        .order("id", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as LinhaAgenteBanco[];
    },
    staleTime: VALE_MS,
    retry: repetirSoFalha,
    // ligacao_agentes não está no tempo real: relê no foco e a cada 60 s
    refetchInterval: RELER_SEM_TEMPO_REAL_MS,
    refetchOnWindowFocus: "always",
  });
}

export function opcoesHistoricoLigacoes(cliente: ClienteSupabase) {
  return queryOptions({
    queryKey: [...CHAVES.ligacoes, "historico"] as const,
    queryFn: async (): Promise<LinhaLigacaoBanco[]> => {
      const { data, error } = await cliente
        .from("ligacoes")
        .select(
          `${COLUNAS_LIGACAO}, conversas(contato_id, contatos(id, nome, nome_whatsapp, telefone))`,
        )
        .order("iniciada_em", { ascending: false })
        .order("id", { ascending: false })
        .limit(LIMITE_HISTORICO_LIGACOES);
      if (error) throw error;
      return (data ?? []) as unknown as LinhaLigacaoBanco[];
    },
    staleTime: VALE_MS,
    retry: repetirSoFalha,
  });
}

export function opcoesLimitesLigacoes(cliente: ClienteSupabase) {
  return queryOptions({
    queryKey: [...CHAVES.ligacoes, "limites"] as const,
    queryFn: async (): Promise<LimitesLigacoes> => {
      const { data, error } = await cliente
        .from("configuracao")
        .select("ligacoes_simultaneas, ligacoes_por_dia, ligacoes_por_contato")
        .eq("id", 1)
        .maybeSingle();
      if (error) throw error;
      // sem a linha, ou com uma coluna fora do formato, o padrão daquele limite
      const n = (v: unknown, padrao: number) => (Number.isInteger(v) ? (v as number) : padrao);
      return {
        simultaneas: n(data?.ligacoes_simultaneas, LIMITES_PADRAO.simultaneas),
        porDia: n(data?.ligacoes_por_dia, LIMITES_PADRAO.porDia),
        porContato: n(data?.ligacoes_por_contato, LIMITES_PADRAO.porContato),
      };
    },
    staleTime: VALE_MS,
    retry: repetirSoFalha,
  });
}

/** A ligação de uma mensagem do tipo "ligacao" (o bloco do Chat). Nula = não achada. */
export function opcoesLigacaoDaMensagem(cliente: ClienteSupabase, mensagemId: string) {
  return queryOptions({
    queryKey: [...CHAVES.ligacoes, "da-mensagem", mensagemId] as const,
    queryFn: async (): Promise<LigacaoDaMensagem | null> => {
      const { data, error } = await cliente
        .from("ligacoes")
        .select(
          "id, status, iniciada_em, duracao_s, resumo, transcricao, passou_equipe, ligacao_agentes(nome)",
        )
        .eq("mensagem_id", mensagemId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const l = data as unknown as {
        id: string;
        status: Ligacao["status"];
        iniciada_em: string;
        duracao_s: number | null;
        resumo: string | null;
        transcricao: unknown;
        passou_equipe: boolean;
        ligacao_agentes: { nome: string } | null;
      };
      return {
        id: l.id,
        status: l.status,
        iniciadaEm: l.iniciada_em,
        duracaoS: l.duracao_s,
        resumo: l.resumo,
        transcricao: falasDaLinha(l.transcricao),
        passouEquipe: l.passou_equipe,
        agenteNome: l.ligacao_agentes?.nome ?? null,
      };
    },
    staleTime: VALE_MS,
    retry: repetirSoFalha,
  });
}

/** A data da versão mais recente do Contexto (o "em dia" dos agentes, L14). */
function useContextoEm(): string | null {
  const contexto = useDados().useContextoAtual();
  return contexto.dados?.criado_em ?? null;
}

function useAgentesBanco(): Leitura<AgentesLigacao> {
  const cliente = exigirCliente(useClienteDados(), "useAgentesLigacao()");
  const q = useQuery(opcoesAgentesLigacao(cliente));
  const contextoEm = useContextoEm();
  const leitura = paraLeitura(q);
  const dados = useMemo(
    () =>
      q.data
        ? { agentes: q.data.map((l) => agenteDaLinha(l, contextoEm)), versaoCodigo: VERSAO_AGENTE }
        : undefined,
    [q.data, contextoEm],
  );
  return { ...leitura, dados };
}

function useHistoricoBanco(): Leitura<Ligacao[]> {
  const cliente = exigirCliente(useClienteDados(), "useHistoricoLigacoes()");
  const q = useQuery(opcoesHistoricoLigacoes(cliente));
  const agentes = useQuery(opcoesAgentesLigacao(cliente));
  const leitura = paraLeitura(q);
  const dados = useMemo(() => {
    if (!q.data) return undefined;
    const nomes = new Map((agentes.data ?? []).map((a) => [a.id, a.nome]));
    return q.data.map((l) => ligacaoDaLinha(l, nomes));
  }, [q.data, agentes.data]);
  return { ...leitura, dados };
}

function useLimitesBanco(): Leitura<LimitesLigacoes> {
  const cliente = exigirCliente(useClienteDados(), "useLimitesLigacoes()");
  return paraLeitura(useQuery(opcoesLimitesLigacoes(cliente)));
}

/**
 * O que todo membro lê (o membro não lê `conexoes.parametros`): as ligações estão ativas quando o
 * agente que atende existe na ElevenLabs (a desativação zera o id_externo); o número é o nome da
 * conexão ativa.
 */
function useSituacaoBanco(): Leitura<SituacaoLigacoes | null> {
  const cliente = exigirCliente(useClienteDados(), "useSituacaoLigacoes()");
  const q = useQuery(opcoesAgentesLigacao(cliente));
  const conexao = useDados().useConexaoAtiva();
  const leitura = paraLeitura(q);
  const nome = conexao.dados?.nome ?? null;
  const dados = useMemo(() => {
    if (!q.data) return undefined;
    const ativas = q.data.some((a) => a.atende && !!a.id_externo);
    return { ativas, numero: ativas ? nome : null };
  }, [q.data, nome]);
  return { ...leitura, dados };
}

/** As funções de servidor da área (troca nos testes por ServidorLigacoesContexto). */
export interface ServidorLigacoes {
  criarAgente(campos: CamposAgente): Promise<unknown>;
  salvarAgente(agenteId: string, campos: CamposAgente): Promise<unknown>;
  apagarAgente(agenteId: string): Promise<unknown>;
  atender(agenteId: string): Promise<unknown>;
  atualizarAgentes(): Promise<unknown>;
  sincronizarContexto(): Promise<unknown>;
  salvarLimites(limites: LimitesLigacoes): Promise<unknown>;
  adotarAgenteDoTronco(): Promise<unknown>;
}

export const SERVIDOR_LIGACOES: ServidorLigacoes = {
  criarAgente: (campos) => criarAgenteLigacao({ data: { campos: { ...campos } } }),
  salvarAgente: (agenteId, campos) =>
    salvarAgenteLigacao({ data: { agenteId, campos: { ...campos } } }),
  apagarAgente: (agenteId) => apagarAgenteLigacao({ data: { agenteId } }),
  atender: (agenteId) => atenderAgenteLigacao({ data: { agenteId } }),
  atualizarAgentes: () => atualizarAgentesLigacao({ data: {} }),
  sincronizarContexto: () => sincronizarContextoLigacao({ data: {} }),
  salvarLimites: (limites) => salvarLimitesLigacoes({ data: { limites: { ...limites } } }),
  adotarAgenteDoTronco: () => adotarAgenteDoTronco({ data: {} }),
};

/** Troca as funções de servidor (testes). Sem provedor, valem as de verdade. */
export const ServidorLigacoesContexto = createContext<ServidorLigacoes>(SERVIDOR_LIGACOES);

/**
 * A resposta de uma função de servidor como `Resultado`. As recusas que a tela conhece ficam com o
 * código; as outras vão como `falha`, com a frase fixa do servidor no `detalhe` (nunca o texto cru
 * de um erro de rede).
 */
export function resultadoDoServidor(r: unknown): Resultado {
  if (!r || typeof r !== "object") return { ok: false, erro: "falha" };
  const o = r as Record<string, unknown>;
  if (o["ok"] === true)
    return typeof o["id"] === "string" ? { ok: true, id: o["id"] } : { ok: true };
  const erro = typeof o["erro"] === "string" ? o["erro"] : "falha";
  const mensagem =
    typeof o["mensagem"] === "string" && o["mensagem"].trim() ? o["mensagem"] : undefined;
  if (erro === "sem_acesso" || erro === "nao_encontrado" || erro === "agente_que_atende")
    return mensagem ? { ok: false, erro, detalhe: mensagem } : { ok: false, erro };
  return mensagem ? { ok: false, erro: "falha", detalhe: mensagem } : { ok: false, erro: "falha" };
}

function useAcoesBanco(): AcoesLigacoes {
  const servidor = useContext(ServidorLigacoesContexto);
  const qc = useQueryClient();
  return useMemo<AcoesLigacoes>(() => {
    const chamar = async (f: () => Promise<unknown>): Promise<Resultado> => {
      let r: Resultado;
      try {
        r = resultadoDoServidor(await f());
      } catch {
        // nunca o texto cru: pode citar a entrada
        r = { ok: false, erro: "falha" };
      }
      // a recusa também pode ter mudado a linha (o erro_sincronia): relê sempre
      await qc.invalidateQueries({ queryKey: CHAVES.ligacoes });
      if (!r.ok && r.erro === "sem_acesso") void qc.invalidateQueries({ queryKey: CHAVES.eu });
      return r;
    };
    return {
      criarAgente: (campos) => chamar(() => servidor.criarAgente(campos)),
      salvarAgente: (id, campos) => chamar(() => servidor.salvarAgente(id, campos)),
      apagarAgente: (id) => chamar(() => servidor.apagarAgente(id)),
      atender: (id) => chamar(() => servidor.atender(id)),
      atualizarAgentes: () => chamar(() => servidor.atualizarAgentes()),
      salvarLimites: (limites) => chamar(() => servidor.salvarLimites(limites)),
    };
  }, [servidor, qc]);
}

/**
 * Depois de salvar o Contexto pela tela (L14): os agentes atrás dele recebem o Contexto novo, sem
 * bloquear quem salvou. Um erro fica no erro_sincronia do agente (a aba Agentes avisa). No exemplo,
 * não faz nada.
 */
export function useSincronizarAgentesComContexto(): () => void {
  const servidor = useContext(ServidorLigacoesContexto);
  const qc = useQueryClient();
  const modo = useModoDados();
  return useCallback(() => {
    if (modo !== "banco") return;
    void servidor
      .sincronizarContexto()
      .catch(() => undefined)
      .then(() => qc.invalidateQueries({ queryKey: CHAVES.ligacoes }));
  }, [servidor, qc, modo]);
}

/**
 * As ligações da primeira versão (L43): ativas e sem o agente que atende na lista (nenhuma linha,
 * ou a que atende sem o agente lá). O admin, ao abrir a área, chama `adotarAgenteDoTronco` uma vez:
 * nasce a linha "Nina", ligada ao agente que já está no número. Devolve true enquanto prepara (a aba
 * Agentes mostra o carregando no lugar do "nenhum agente"). Uma vez por montagem: o que falhar fica
 * no cartão (erro_sincronia) e a próxima abertura tenta de novo. No exemplo, não faz nada.
 */
export function useAdotarAgenteDoTronco(
  ativas: boolean,
  agentes: readonly AgenteLigacao[] | undefined,
): boolean {
  return ADOTAR[useModoDados()](ativas, agentes);
}

function useAdotarBanco(ativas: boolean, agentes: readonly AgenteLigacao[] | undefined): boolean {
  const servidor = useContext(ServidorLigacoesContexto);
  const qc = useQueryClient();
  const tentou = useRef(false);
  const vivo = useRef(true);
  const [preparando, setPreparando] = useState(false);
  const falta = ativas && !!agentes && !agentes.some((a) => a.atende && !a.semAgenteLa);
  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);
  useEffect(() => {
    if (!falta || tentou.current) return;
    tentou.current = true;
    setPreparando(true);
    void servidor
      .adotarAgenteDoTronco()
      .catch(() => undefined)
      .then(() => qc.invalidateQueries({ queryKey: CHAVES.ligacoes }))
      .finally(() => {
        if (vivo.current) setPreparando(false);
      });
  }, [falta, servidor, qc]);
  return preparando;
}

const ADOTAR = { banco: useAdotarBanco, exemplo: () => false } as const;

/* ---------- a ligação de uma mensagem do Chat ---------- */

/** O que o bloco da ligação no Chat mostra (a linha de `ligacoes` da mensagem do tipo "ligacao"). */
export interface LigacaoDaMensagem {
  id: string;
  status: Ligacao["status"];
  iniciadaEm: string;
  duracaoS: number | null;
  resumo: string | null;
  transcricao: FalaLigacao[];
  passouEquipe: boolean;
  agenteNome: string | null;
}

function useLigacaoDaMensagemBanco(mensagemId: string): Leitura<LigacaoDaMensagem | null> {
  const cliente = exigirCliente(useClienteDados(), "useLigacaoDaMensagem()");
  return paraLeitura(useQuery(opcoesLigacaoDaMensagem(cliente, mensagemId)));
}

function useLigacaoDaMensagemExemplo(mensagemId: string): Leitura<LigacaoDaMensagem | null> {
  const { estado } = useExemplo();
  const { historicoLigacoes, ligacaoAgentes } = estado;
  return useMemo(() => {
    const l = (historicoLigacoes ?? []).find((x) => x.mensagemId === mensagemId);
    if (!l) return pronta(null);
    const agente = (ligacaoAgentes ?? []).find((a) => a.id === l.agenteId);
    return pronta({
      id: l.id,
      status: l.status,
      iniciadaEm: l.iniciadaEm,
      duracaoS: l.duracaoS,
      resumo: l.resumo,
      transcricao: l.transcricao,
      passouEquipe: l.passouEquipe,
      agenteNome: agente?.nome ?? null,
    });
  }, [historicoLigacoes, ligacaoAgentes, mensagemId]);
}

/* ---------- o que a tela usa ---------- */

const HISTORICO = { banco: useHistoricoBanco, exemplo: useHistoricoExemplo } as const;
const AGENTES = { banco: useAgentesBanco, exemplo: useAgentesExemplo } as const;
const LIMITES = { banco: useLimitesBanco, exemplo: useLimitesExemplo } as const;
const SITUACAO = { banco: useSituacaoBanco, exemplo: useSituacaoExemplo } as const;
const AGIR = { banco: useAcoesBanco, exemplo: useAcoesExemplo } as const;
const DA_MENSAGEM = {
  banco: useLigacaoDaMensagemBanco,
  exemplo: useLigacaoDaMensagemExemplo,
} as const;

/** O histórico das ligações, com o contato e o agente (todo membro). */
export function useHistoricoLigacoes(): Leitura<Ligacao[]> {
  return HISTORICO[useModoDados()]();
}

/** Os agentes de voz e a versão do código. */
export function useAgentesLigacao(): Leitura<AgentesLigacao> {
  return AGENTES[useModoDados()]();
}

/** Os limites das ligações da conta. */
export function useLimitesLigacoes(): Leitura<LimitesLigacoes> {
  return LIMITES[useModoDados()]();
}

/**
 * A situação das ligações como todo membro lê (o topo do atendente). O admin lê pelo servidor
 * (`estadoLigacoes`, com os requisitos e as pendências).
 */
export function useSituacaoLigacoes(): Leitura<SituacaoLigacoes | null> {
  return SITUACAO[useModoDados()]();
}

/** As ações da área. Nunca lançam: a recusada devolve o erro. */
export function useAcoesLigacoes(): AcoesLigacoes {
  return AGIR[useModoDados()]();
}

/** A ligação de uma mensagem do tipo "ligacao" (o bloco do Chat). Nula = não achada. */
export function useLigacaoDaMensagem(mensagemId: string): Leitura<LigacaoDaMensagem | null> {
  return DA_MENSAGEM[useModoDados()](mensagemId);
}
