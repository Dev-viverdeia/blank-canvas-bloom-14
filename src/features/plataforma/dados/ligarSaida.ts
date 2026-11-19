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
  agentesParaLigar,
  ligarParaLead,
  pedirPermissaoDeLigar,
  permissaoDeLigar,
} from "@/features/mensageria/configuracao.functions";
import {
  MAX_OBJETIVO_LIGACAO,
  OBJETIVOS_AGENTE,
  USOS_AGENTE,
  type AgenteIndisponivel,
  type AgenteParaLigar,
  type EstadoPermissaoDeLigar,
  type MotivoNaoLiga,
  type ObjetivoAgente,
  type PedidoDePermissao,
  type PermissaoDeLigar,
  type UsoAgente,
} from "@/features/mensageria/ligacoes/tipos";

import { useExemplo } from "../exemplo/ProvedorExemplo";
import { useModoDados } from "./ProvedorDados";

// A Nina ligando para o lead (seção 6): o botão "Ligar" da conversa lê
// e age só por aqui.
//
// - banco: as funções de servidor `permissaoDeLigar`, `pedirPermissaoDeLigar` e `ligarParaLead`
//   (todas com { conversaId }). A permissão só é lida quando o painel do botão abre (cada leitura
//   pode ir à Meta) e, com o pedido aguardando o lead, a cada 10 s enquanto o painel está aberto (o
//   servidor responde pelo banco nesse caso);
// - exemplo (a demo e os testes): uma simulação sem rede. A 1ª leitura pede permissão; o pedido
//   espera o lead; a leitura seguinte vem com a permissão de 7 dias; ligar dá certo.
//
// Ligar com um agente : a janela lê `agentesParaLigar` ao abrir (no
// exemplo, os agentes do estado) e o "Ligar agora" leva o agente escolhido e o objetivo.

const MOTIVOS: readonly MotivoNaoLiga[] = [
  "sem_ligacoes",
  "sem_telefone",
  "pedir",
  "aguardando_lead",
  "recusou",
  "fora_da_janela",
  "limite_de_pedidos",
  "meta_nao_deixa",
  "ligacao_em_andamento",
];
const PERMISSOES: readonly PermissaoDeLigar[] = ["permanente", "temporaria", "nenhuma"];

const texto = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

function pedidoDe(v: unknown): PedidoDePermissao | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const pedidoEm = texto(o["pedidoEm"]);
  if (!pedidoEm) return null;
  const resposta =
    o["resposta"] === "aceitou" || o["resposta"] === "recusou" ? o["resposta"] : null;
  return {
    pedidoEm,
    resposta,
    permanente: typeof o["permanente"] === "boolean" ? o["permanente"] : null,
    respondidoEm: texto(o["respondidoEm"]),
  };
}

/** O estado do botão que veio do servidor, conferido campo a campo; null fora do formato. */
export function estadoPermissaoDe(v: unknown): EstadoPermissaoDeLigar | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const permissao = o["permissao"];
  if (typeof permissao !== "string" || !(PERMISSOES as readonly string[]).includes(permissao))
    return null;
  const motivo = o["motivo"];
  return {
    permissao: permissao as PermissaoDeLigar,
    expiraEm: texto(o["expiraEm"]),
    podeLigar: o["podeLigar"] === true,
    podePedir: o["podePedir"] === true,
    dentroDaJanela: o["dentroDaJanela"] === true,
    motivo:
      typeof motivo === "string" && (MOTIVOS as readonly string[]).includes(motivo)
        ? (motivo as MotivoNaoLiga)
        : null,
    pedido: pedidoDe(o["pedido"]),
    pedirDeNovoEm: texto(o["pedirDeNovoEm"]),
  };
}

/** A recusa das três funções: o código e a frase pronta do servidor (nunca o texto cru de um erro). */
export interface FalhaSaida {
  erro: string;
  mensagem: string | null;
}

function falhaDe(r: unknown): FalhaSaida {
  if (!r || typeof r !== "object") return { erro: "falha", mensagem: null };
  const o = r as Record<string, unknown>;
  return {
    erro: typeof o["erro"] === "string" ? o["erro"] : "falha",
    mensagem: texto(o["mensagem"]),
  };
}

export type ResultadoEstadoSaida =
  { ok: true; estado: EstadoPermissaoDeLigar } | ({ ok: false } & FalhaSaida);
export type ResultadoLigarSaida = { ok: true } | ({ ok: false } & FalhaSaida);
export type ResultadoAgentesSaida =
  { ok: true; agentes: AgenteParaLigar[] } | ({ ok: false } & FalhaSaida);

const INDISPONIVEIS: readonly AgenteIndisponivel[] = ["nao_sincronizado"];

/** Um agente da janela que veio do servidor, conferido campo a campo; null fora do formato. */
export function agenteParaLigarDe(v: unknown): AgenteParaLigar | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const id = texto(o["id"]);
  const nome = texto(o["nome"]);
  const uso = o["uso"];
  if (!id || !nome || typeof uso !== "string" || !(USOS_AGENTE as readonly string[]).includes(uso))
    return null;
  const objetivo = o["objetivo"];
  const indisponivel = o["indisponivel"];
  return {
    id,
    nome,
    uso: uso as UsoAgente,
    objetivo:
      typeof objetivo === "string" && (OBJETIVOS_AGENTE as readonly string[]).includes(objetivo)
        ? (objetivo as ObjetivoAgente)
        : "outro",
    atende: o["atende"] === true,
    // um motivo desconhecido também deixa o agente de fora: na dúvida, não liga
    indisponivel:
      indisponivel === null || indisponivel === undefined
        ? null
        : (INDISPONIVEIS as readonly unknown[]).includes(indisponivel)
          ? (indisponivel as AgenteIndisponivel)
          : "nao_sincronizado",
    // a última atualização falhou: ele liga com a configuração anterior (só um aviso)
    desatualizado: o["desatualizado"] === true,
  };
}

/** A ordem da janela (A2): os Ativos primeiro, depois por nome. */
export function ordenarAgentesParaLigar(agentes: readonly AgenteParaLigar[]): AgenteParaLigar[] {
  return [...agentes].sort(
    (a, b) =>
      (a.uso === "ligar" ? 0 : 1) - (b.uso === "ligar" ? 0 : 1) ||
      a.nome.localeCompare(b.nome, "pt-BR"),
  );
}

async function comoAgentes(p: Promise<unknown>): Promise<ResultadoAgentesSaida> {
  try {
    const r = await p;
    if (r && typeof r === "object" && (r as Record<string, unknown>)["ok"] === true) {
      const lista = (r as Record<string, unknown>)["agentes"];
      if (!Array.isArray(lista)) return { ok: false, erro: "falha", mensagem: null };
      const agentes = lista.map(agenteParaLigarDe).filter((a): a is AgenteParaLigar => !!a);
      return { ok: true, agentes: ordenarAgentesParaLigar(agentes) };
    }
    return { ok: false, ...falhaDe(r) };
  } catch {
    return { ok: false, erro: "falha", mensagem: null };
  }
}

/** O que o "Ligar agora" leva além da conversa: o agente e o objetivo (sem eles, o servidor usa o que atende). */
export interface PedidoLigarTela {
  agenteId?: string | undefined;
  objetivo?: string | undefined;
}

/** As funções de servidor (os testes trocam por ServidorSaidaContexto). */
export interface ServidorSaida {
  permissao(conversaId: string): Promise<unknown>;
  pedir(conversaId: string): Promise<unknown>;
  ligar(conversaId: string, pedido?: PedidoLigarTela): Promise<unknown>;
  agentes(): Promise<unknown>;
}

export const SERVIDOR_SAIDA: ServidorSaida = {
  permissao: (conversaId) => permissaoDeLigar({ data: { conversaId } }),
  pedir: (conversaId) => pedirPermissaoDeLigar({ data: { conversaId } }),
  ligar: (conversaId, pedido = {}) =>
    ligarParaLead({
      data: {
        conversaId,
        ...(pedido.agenteId ? { agenteId: pedido.agenteId } : {}),
        ...(pedido.objetivo ? { objetivo: pedido.objetivo } : {}),
      },
    }),
  agentes: () => agentesParaLigar({ data: {} }),
};

export const ServidorSaidaContexto = createContext<ServidorSaida>(SERVIDOR_SAIDA);

async function comoEstado(p: Promise<unknown>): Promise<ResultadoEstadoSaida> {
  try {
    const r = await p;
    if (r && typeof r === "object" && (r as Record<string, unknown>)["ok"] === true) {
      const estado = estadoPermissaoDe((r as Record<string, unknown>)["estado"]);
      return estado ? { ok: true, estado } : { ok: false, erro: "falha", mensagem: null };
    }
    return { ok: false, ...falhaDe(r) };
  } catch {
    return { ok: false, erro: "falha", mensagem: null };
  }
}

async function comoLigar(p: Promise<unknown>): Promise<ResultadoLigarSaida> {
  try {
    const r = await p;
    if (r && typeof r === "object" && (r as Record<string, unknown>)["ok"] === true)
      return { ok: true };
    return { ok: false, ...falhaDe(r) };
  } catch {
    return { ok: false, erro: "falha", mensagem: null };
  }
}

/** As ações do botão "Ligar". Nunca lançam: a recusada devolve o erro. */
export interface AcoesSaida {
  permissao(conversaId: string): Promise<ResultadoEstadoSaida>;
  pedir(conversaId: string): Promise<ResultadoEstadoSaida>;
  ligar(conversaId: string, pedido?: PedidoLigarTela): Promise<ResultadoLigarSaida>;
}

function useAcoesBanco(): AcoesSaida {
  const servidor = useContext(ServidorSaidaContexto);
  return useMemo<AcoesSaida>(
    () => ({
      permissao: (id) => comoEstado(servidor.permissao(id)),
      pedir: (id) => comoEstado(servidor.pedir(id)),
      ligar: (id, pedido) => comoLigar(servidor.ligar(id, pedido)),
    }),
    [servidor],
  );
}

/** O estado da demo para uma conversa (fora do React: sobrevive a abrir e fechar o painel). */
const demo = new Map<string, EstadoPermissaoDeLigar>();

/** O estado inicial da demo: sem permissão, dentro da janela, com o pedido liberado. */
export function estadoInicialExemplo(): EstadoPermissaoDeLigar {
  return {
    permissao: "nenhuma",
    expiraEm: null,
    podeLigar: false,
    podePedir: true,
    dentroDaJanela: true,
    motivo: "pedir",
    pedido: null,
    pedirDeNovoEm: null,
  };
}

/** Limpa a demo (os testes). */
export function limparDemoSaida(): void {
  demo.clear();
}

const ACOES_EXEMPLO: AcoesSaida = {
  permissao: async (id) => {
    const atual = demo.get(id) ?? estadoInicialExemplo();
    // a demo responde ao pedido na leitura seguinte: o lead permitiu por 7 dias
    if (atual.motivo === "aguardando_lead" && atual.pedido) {
      const agora = new Date();
      const novo: EstadoPermissaoDeLigar = {
        ...atual,
        permissao: "temporaria",
        expiraEm: new Date(agora.getTime() + 7 * 86_400_000).toISOString(),
        podeLigar: true,
        podePedir: false,
        motivo: null,
        pedido: {
          ...atual.pedido,
          resposta: "aceitou",
          permanente: false,
          respondidoEm: agora.toISOString(),
        },
      };
      demo.set(id, novo);
      return { ok: true, estado: novo };
    }
    demo.set(id, atual);
    return { ok: true, estado: atual };
  },
  pedir: async (id) => {
    const atual = demo.get(id) ?? estadoInicialExemplo();
    const novo: EstadoPermissaoDeLigar = {
      ...atual,
      podePedir: false,
      motivo: "aguardando_lead",
      pedido: {
        pedidoEm: new Date().toISOString(),
        resposta: null,
        permanente: null,
        respondidoEm: null,
      },
    };
    demo.set(id, novo);
    return { ok: true, estado: novo };
  },
  // como o servidor: o objetivo acima do limite é recusado (a janela já não deixa chegar aqui)
  ligar: async (_id, pedido) =>
    (pedido?.objetivo?.trim().length ?? 0) > MAX_OBJETIVO_LIGACAO
      ? {
          ok: false,
          erro: "objetivo_invalido",
          mensagem: `O objetivo pode ter até ${MAX_OBJETIVO_LIGACAO} caracteres.`,
        }
      : { ok: true },
};

export function useAcoesSaida(): AcoesSaida {
  const modo = useModoDados();
  const banco = useAcoesBanco();
  return modo === "banco" ? banco : ACOES_EXEMPLO;
}

/** De quanto em quanto tempo o painel relê a permissão enquanto o pedido espera o lead. */
export const RELER_AGUARDANDO_MS = 10_000;

export interface ControleSaida {
  estado: EstadoPermissaoDeLigar | null;
  /** Lendo, pedindo ou ligando. */
  agindo: "lendo" | "pedindo" | "ligando" | null;
  falha: FalhaSaida | null;
  ler(): void;
  pedir(): void;
  /** Liga com o agente e o objetivo; o resultado diz se saiu (a falha também fica em `falha`). */
  ligar(pedido?: PedidoLigarTela): Promise<ResultadoLigarSaida>;
  /** Tira a falha da tela (ex.: outro agente foi escolhido depois de uma recusa). */
  limparFalha(): void;
}

/**
 * O estado do botão "Ligar" de uma conversa. Só lê com `aberto` (o painel aberto): ao abrir, e a
 * cada 10 s enquanto o pedido espera o lead. Trocar de conversa zera tudo.
 */
export function useLigarSaida(conversaId: string, aberto: boolean): ControleSaida {
  const acoes = useAcoesSaida();
  const [estado, setEstado] = useState<EstadoPermissaoDeLigar | null>(null);
  const [agindo, setAgindo] = useState<ControleSaida["agindo"]>(null);
  const [falha, setFalha] = useState<FalhaSaida | null>(null);
  const vivo = useRef(true);
  const seq = useRef(0);

  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  useEffect(() => {
    seq.current += 1;
    setEstado(null);
    setFalha(null);
    setAgindo(null);
  }, [conversaId]);

  const ler = useCallback(() => {
    seq.current += 1;
    const minha = seq.current;
    setAgindo((a) => a ?? "lendo");
    void acoes.permissao(conversaId).then((r) => {
      if (!vivo.current || minha !== seq.current) return;
      setAgindo((a) => (a === "lendo" ? null : a));
      if (r.ok) {
        setEstado(r.estado);
        setFalha(null);
      } else setFalha({ erro: r.erro, mensagem: r.mensagem });
    });
  }, [acoes, conversaId]);

  useEffect(() => {
    if (aberto) ler();
  }, [aberto, ler]);

  const aguardando = estado?.motivo === "aguardando_lead";
  useEffect(() => {
    if (!aberto || !aguardando) return;
    const t = setInterval(ler, RELER_AGUARDANDO_MS);
    return () => clearInterval(t);
  }, [aberto, aguardando, ler]);

  const pedir = useCallback(() => {
    seq.current += 1;
    setAgindo("pedindo");
    setFalha(null);
    void acoes.pedir(conversaId).then((r) => {
      if (!vivo.current) return;
      setAgindo(null);
      if (r.ok) setEstado(r.estado);
      else setFalha({ erro: r.erro, mensagem: r.mensagem });
    });
  }, [acoes, conversaId]);

  const ligar = useCallback(
    async (pedido?: PedidoLigarTela) => {
      seq.current += 1;
      setAgindo("ligando");
      setFalha(null);
      const r = await acoes.ligar(conversaId, pedido);
      if (!vivo.current) return r;
      setAgindo(null);
      if (!r.ok) setFalha({ erro: r.erro, mensagem: r.mensagem });
      return r;
    },
    [acoes, conversaId],
  );

  const limparFalha = useCallback(() => setFalha(null), []);

  return { estado, agindo, falha, ler, pedir, ligar, limparFalha };
}

// ---------------------------------------------------------------------------
// Os agentes da janela (A2)
// ---------------------------------------------------------------------------

export interface LeituraAgentesSaida {
  /** Os agentes, os Ativos primeiro; null enquanto lê (ou depois de uma falha). */
  agentes: AgenteParaLigar[] | null;
  lendo: boolean;
  falha: FalhaSaida | null;
  ler(): void;
}

/** No banco: `agentesParaLigar`, a cada vez que a janela abre (a sincronia pode ter mudado). */
function useAgentesBanco(aberto: boolean): LeituraAgentesSaida {
  const servidor = useContext(ServidorSaidaContexto);
  const [agentes, setAgentes] = useState<AgenteParaLigar[] | null>(null);
  const [lendo, setLendo] = useState(false);
  const [falha, setFalha] = useState<FalhaSaida | null>(null);
  const seq = useRef(0);
  const vivo = useRef(true);

  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  const ler = useCallback(() => {
    seq.current += 1;
    const minha = seq.current;
    setLendo(true);
    setFalha(null);
    void comoAgentes(servidor.agentes()).then((r) => {
      if (!vivo.current || minha !== seq.current) return;
      setLendo(false);
      if (r.ok) setAgentes(r.agentes);
      else setFalha({ erro: r.erro, mensagem: r.mensagem });
    });
  }, [servidor]);

  // a cada abertura, a lista começa do zero (a janela só marca o padrão na lista lida agora); o
  // "Tentar de novo" e a releitura depois de uma recusa mantêm a lista na tela enquanto leem
  useEffect(() => {
    if (aberto) ler();
    else {
      seq.current += 1;
      setAgentes(null);
      setFalha(null);
      setLendo(false);
    }
  }, [aberto, ler]);

  return { agentes: falha ? null : agentes, lendo, falha, ler };
}

/**
 * No exemplo: os agentes do estado, sem rede. Sem o agente na ElevenLabs, indisponível; com o erro
 * da última atualização, desatualizado (liga com a configuração anterior).
 */
function useAgentesExemplo(): LeituraAgentesSaida {
  const { estado } = useExemplo();
  const lista = estado.ligacaoAgentes;
  const agentes = useMemo(
    () =>
      ordenarAgentesParaLigar(
        (lista ?? []).map((a) => ({
          id: a.id,
          nome: a.nome,
          uso: a.uso,
          objetivo: a.objetivo,
          atende: a.atende,
          indisponivel: a.semAgenteLa ? ("nao_sincronizado" as const) : null,
          desatualizado: !a.semAgenteLa && !!a.erroSincronia,
        })),
      ),
    [lista],
  );
  return useMemo(() => ({ agentes, lendo: false, falha: null, ler: () => {} }), [agentes]);
}

const AGENTES_SAIDA = { banco: useAgentesBanco, exemplo: useAgentesExemplo } as const;

/** Os agentes que a janela do "Ligar" oferece. Só lê com a janela aberta. */
export function useAgentesParaLigar(aberto: boolean): LeituraAgentesSaida {
  return AGENTES_SAIDA[useModoDados()](aberto);
}
