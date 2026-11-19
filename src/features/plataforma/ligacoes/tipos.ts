// Os tipos e as regras puras da área Ligações (2.1 e 2.3). São da tela, não
// do `types.ts`: o modo exemplo guarda estas formas, e a camada de dados do banco (dados/ligacoes.ts)
// converte as linhas de `ligacao_agentes` e `ligacoes` para elas.
// Sem React e sem servidor: o exemplo, a camada de dados e as telas importam daqui.

import { andamentoVencido } from "@/features/mensageria/ligacoes/registro";
import {
  SAUDACAO_AGENTE_LIGAR,
  SAUDACAO_AGENTE_PADRAO,
  USOS_AGENTE,
  type UsoAgente,
} from "@/features/mensageria/ligacoes/tipos";

import { diaLocal } from "../comum/tempo";

/** O objetivo do agente (enum `ligacao_objetivo`). */
export type ObjetivoAgente = "vendas" | "suporte" | "outro";
export const OBJETIVOS: readonly ObjetivoAgente[] = ["vendas", "suporte", "outro"];

/** O perfil de modelos do agente (enum `ligacao_perfil`, L6 e L13). */
export type PerfilAgente = "recomendado" | "rapido" | "caprichado";
export const PERFIS_AGENTE: readonly PerfilAgente[] = ["recomendado", "rapido", "caprichado"];

/** O que a tela mostra de cada perfil: o nome e uma linha de explicação, sem nome técnico de modelo. */
export const TEXTO_PERFIL: Record<PerfilAgente, { nome: string; linha: string }> = {
  recomendado: {
    nome: "Recomendado",
    linha: "O equilíbrio entre resposta rápida e conversa caprichada. Serve para quase tudo.",
  },
  rapido: {
    nome: "Mais rápido",
    linha: "Responde com a menor demora. Bom para conversas curtas e diretas.",
  },
  caprichado: {
    nome: "Mais caprichado",
    linha: "Pensa melhor antes de falar, com um pouco mais de demora. Bom para vendas complexas.",
  },
};

/**
 * O uso do agente (A1): Receptiva ("receber": recebe as ligações do
 * número; só ela pode atender) ou Ativa ("ligar": faz as ligações que a equipe pede na conversa).
 */
export type { UsoAgente };
export const USOS: readonly UsoAgente[] = USOS_AGENTE;

/** O que a tela mostra de cada uso: o selo, a explicação curta (acessível) e a linha do editor. */
export const TEXTO_USO: Record<UsoAgente, { nome: string; curto: string; linha: string }> = {
  receber: {
    nome: "Receptiva",
    curto: "recebe as ligações do número",
    linha: "Recebe as ligações do número. Só um agente Receptivo atende de cada vez.",
  },
  ligar: {
    nome: "Ativa",
    curto: "faz ligações",
    linha: "Faz as ligações que a equipe pede pelo botão Ligar da conversa.",
  },
};

/** O uso do "Novo agente" (A1): Ativa quando já há um agente atendendo; Receptiva quando não há. */
export function usoPadraoDoNovo(agentes: readonly Pick<AgenteLigacao, "atende">[]): UsoAgente {
  return agentes.some((a) => a.atende) ? "ligar" : "receber";
}

/**
 * Por que a opção Ativa está desabilitada no editor (null = pode escolher): o agente que atende fica
 * Receptivo, e o primeiro agente atende o número (as mesmas recusas do servidor).
 */
export function motivoSemAtiva(
  agente: Pick<AgenteLigacao, "atende"> | null,
  primeiro: boolean,
): string | null {
  if (agente?.atende)
    return "Este agente atende as ligações do número. Para ele ser Ativo, escolha outro para atender antes.";
  if (!agente && primeiro)
    return "O primeiro agente atende as ligações do número, então ele é Receptivo.";
  return null;
}

export const TEXTO_OBJETIVO: Record<ObjetivoAgente, string> = {
  vendas: "Vendas",
  suporte: "Suporte",
  outro: "Outro",
};

/** Os limites de cada campo do agente (os checks da `ligacao_agentes`, spec 2.1). */
export const LIMITES_AGENTE = {
  nome: { min: 1, max: 60 },
  instrucoes: { max: 4000 },
  regrasEquipe: { min: 1, max: 2000 },
  saudacao: { min: 1, max: 300 },
  duracaoMaxS: { min: 180, max: 1800, passo: 60 },
  silencioS: { min: 10, max: 60, passo: 5 },
} as const;

/** A saudação padrão (L5). `{nome}` vira o nome do contato na hora da ligação. */
export const SAUDACAO_PADRAO = SAUDACAO_AGENTE_PADRAO;

/** A saudação padrão do agente Ativo (A4): quem liga se apresenta. */
export const SAUDACAO_LIGAR = SAUDACAO_AGENTE_LIGAR;

/** A saudação-modelo de cada uso. */
export const SAUDACAO_DO_USO: Record<UsoAgente, string> = {
  receber: SAUDACAO_PADRAO,
  ligar: SAUDACAO_LIGAR,
};

/**
 * A saudação depois de trocar o uso de um agente (novo ou não): a que ainda é um dos dois modelos
 * vira o modelo do uso novo; qualquer outra (a que o admin escreveu, até a vazia) fica como está.
 */
export function saudacaoAoTrocarUso(saudacao: string, uso: UsoAgente): string {
  const t = saudacao.trim();
  const modelo = t === SAUDACAO_PADRAO || t === SAUDACAO_LIGAR;
  return modelo ? SAUDACAO_DO_USO[uso] : saudacao;
}

/** Um agente de voz (uma linha de `ligacao_agentes`, na forma da tela). */
export interface AgenteLigacao {
  id: string;
  nome: string;
  /** Receptiva ou Ativa (A1 da spec). */
  uso: UsoAgente;
  objetivo: ObjetivoAgente;
  instrucoes: string;
  /** Nulo = as regras do Contexto ("Quando passar para humano"), as mesmas da Nina de texto (L8). */
  regrasEquipe: string | null;
  vozId: string | null;
  vozNome: string | null;
  perfil: PerfilAgente;
  saudacao: string;
  duracaoMaxS: number;
  silencioS: number;
  /** Este é o agente que atende as ligações do número (só um, L3). */
  atende: boolean;
  /** A versão da configuração aplicada na ElevenLabs (L13). */
  versaoConfig: number;
  /** O último erro ao levar o agente para a ElevenLabs (nulo = em dia). */
  erroSincronia: string | null;
  /**
   * O agente existe na ElevenLabs e está atrás do Contexto (L14): a última sincronia é de antes da
   * versão mais recente. O "Atualizar" da aba Agentes resolve. Ausente no exemplo.
   */
  atrasadoContexto?: boolean | undefined;
  /**
   * O agente ainda não existe na ElevenLabs (sem id_externo: as ligações desligadas, ou a criação
   * que falhou). A versão aplicada dele não conta para o aviso de atualização. Ausente no exemplo.
   */
  semAgenteLa?: boolean | undefined;
  criadoEm: string;
  atualizadoEm: string;
}

/** O que o editor do agente grava (o resto é do servidor). */
export type CamposAgente = Pick<
  AgenteLigacao,
  | "nome"
  | "uso"
  | "objetivo"
  | "instrucoes"
  | "regrasEquipe"
  | "vozId"
  | "vozNome"
  | "perfil"
  | "saudacao"
  | "duracaoMaxS"
  | "silencioS"
>;

/**
 * Os padrões de um agente novo (L5): a voz vem de fora (a voz escolhida da Nina, se houver), e o uso
 * também (usoPadraoDoNovo); a saudação é o modelo do uso.
 */
export function camposPadrao(
  voz: { id: string; nome: string } | null = null,
  uso: UsoAgente = "receber",
): CamposAgente {
  return {
    nome: "",
    uso,
    objetivo: "vendas",
    instrucoes: "",
    regrasEquipe: null,
    vozId: voz?.id ?? null,
    vozNome: voz?.nome ?? null,
    perfil: "recomendado",
    saudacao: SAUDACAO_DO_USO[uso],
    duracaoMaxS: 600,
    silencioS: 25,
  };
}

/** Os campos limpos (aparados) ou o primeiro problema, em texto para a tela. */
export function conferirCampos(
  c: CamposAgente,
): { ok: true; campos: CamposAgente } | { ok: false; campo: keyof CamposAgente; texto: string } {
  const nome = c.nome.trim();
  if (nome.length < LIMITES_AGENTE.nome.min)
    return { ok: false, campo: "nome", texto: "Dê um nome ao agente." };
  if (nome.length > LIMITES_AGENTE.nome.max)
    return {
      ok: false,
      campo: "nome",
      texto: `O nome pode ter até ${LIMITES_AGENTE.nome.max} letras.`,
    };
  const instrucoes = c.instrucoes.trim();
  if (instrucoes.length > LIMITES_AGENTE.instrucoes.max)
    return {
      ok: false,
      campo: "instrucoes",
      texto: `As instruções podem ter até ${LIMITES_AGENTE.instrucoes.max} letras.`,
    };
  const regras = c.regrasEquipe === null ? null : c.regrasEquipe.trim();
  if (regras !== null && regras.length < LIMITES_AGENTE.regrasEquipe.min)
    return {
      ok: false,
      campo: "regrasEquipe",
      texto:
        "Escreva quando o agente passa para a equipe, ou use as mesmas regras da Nina de texto.",
    };
  if (regras !== null && regras.length > LIMITES_AGENTE.regrasEquipe.max)
    return {
      ok: false,
      campo: "regrasEquipe",
      texto: `As regras podem ter até ${LIMITES_AGENTE.regrasEquipe.max} letras.`,
    };
  const saudacao = c.saudacao.trim();
  if (saudacao.length < LIMITES_AGENTE.saudacao.min)
    return {
      ok: false,
      campo: "saudacao",
      texto: "Escreva a saudação: a primeira fala do agente na ligação.",
    };
  if (saudacao.length > LIMITES_AGENTE.saudacao.max)
    return {
      ok: false,
      campo: "saudacao",
      texto: `A saudação pode ter até ${LIMITES_AGENTE.saudacao.max} letras.`,
    };
  return {
    ok: true,
    campos: {
      ...c,
      nome,
      instrucoes,
      regrasEquipe: regras,
      saudacao,
      duracaoMaxS: noIntervalo(c.duracaoMaxS, LIMITES_AGENTE.duracaoMaxS),
      silencioS: noIntervalo(c.silencioS, LIMITES_AGENTE.silencioS),
    },
  };
}

/** Os limites das ligações da conta (colunas novas de `configuracao`, L19). */
export interface LimitesLigacoes {
  simultaneas: number;
  porDia: number;
  porContato: number;
}

export const LIMITES_PADRAO: LimitesLigacoes = { simultaneas: 2, porDia: 100, porContato: 10 };

/** A faixa e o passo do +/− de cada limite (os checks da `configuracao`, spec 2.1). */
export const FAIXA_LIMITES: Record<
  keyof LimitesLigacoes,
  { min: number; max: number; passo: number }
> = {
  simultaneas: { min: 1, max: 200, passo: 1 },
  porDia: { min: 1, max: 10_000, passo: 10 },
  porContato: { min: 1, max: 100, passo: 1 },
};

export function noIntervalo(v: number, faixa: { min: number; max: number }): number {
  if (!Number.isFinite(v)) return faixa.min;
  return Math.max(faixa.min, Math.min(faixa.max, Math.round(v)));
}

/** O +/− de um limite: anda o passo e fica na faixa (de 1, o "+10" do por dia vai para 10, não 11). */
export function mudarLimite(
  l: LimitesLigacoes,
  campo: keyof LimitesLigacoes,
  sinal: 1 | -1,
): LimitesLigacoes {
  const f = FAIXA_LIMITES[campo];
  const atual = l[campo];
  let novo = atual + sinal * f.passo;
  if (f.passo > 1 && atual % f.passo !== 0)
    novo = sinal > 0 ? Math.ceil(atual / f.passo) * f.passo : Math.floor(atual / f.passo) * f.passo;
  return { ...l, [campo]: noIntervalo(novo, f) };
}

/* ---------- o histórico ---------- */

/** Enum `ligacao_status`. */
export type StatusLigacao = "em_andamento" | "concluida" | "nao_completada";
/** Enum `ligacao_direcao` (por enquanto só entram ligações recebidas). */
export type DirecaoLigacao = "entrada" | "saida";

/**
 * Uma fala da transcrição. No banco, o jsonb é `[{papel: "lead"|"nina", texto, segundos}]`; a tela
 * chama o lado da empresa de "agente" (quem atendeu).
 */
export interface FalaLigacao {
  papel: "lead" | "agente";
  texto: string;
  /** Segundos desde o começo da ligação. */
  segundos: number;
}

/** Uma ligação como fica guardada (uma linha de `ligacoes`, sem o contato). */
export interface LigacaoGuardada {
  id: string;
  conversaId: string;
  /** A mensagem do tipo "ligacao" na conversa (o bloco do Chat lê a ligação por ela). */
  mensagemId?: string | null | undefined;
  agenteId: string | null;
  direcao: DirecaoLigacao;
  status: StatusLigacao;
  iniciadaEm: string;
  encerradaEm: string | null;
  duracaoS: number | null;
  /** Por que terminou, como a ElevenLabs conta (ex.: "client_ended", "max_duration"). */
  motivoFim: string | null;
  resumo: string | null;
  transcricao: FalaLigacao[];
  passouEquipe: boolean;
  /**
   * O objetivo desta ligação, escrito por quem pediu a ligação de saída (A3 de
   * a spec); nulo sem objetivo. Ausente nas ligações antigas do exemplo.
   */
  objetivo?: string | null | undefined;
}

/** Uma ligação como a tela mostra: a guardada mais o contato e o nome do agente. */
export interface Ligacao extends LigacaoGuardada {
  contatoId: string | null;
  /** O nome do contato (o da ficha, ou o do WhatsApp); nulo sem nome. */
  nome: string | null;
  telefone: string | null;
  /** O nome do agente que atendeu (nulo quando o agente foi apagado). */
  agenteNome: string | null;
}

/** O selo da ligação na lista (spec 2.3): passou para a equipe vale mais que concluída. */
export type SeloLigacao = "andamento" | "sem_resumo" | "concluida" | "equipe" | "nao_completada";

/**
 * A ligação ainda está acontecendo: "em_andamento" e dentro da duração máxima mais a folga (L38).
 * Passou disso, o pós-chamada não veio: ela não conta mais como em andamento (nem no topo).
 */
export function ligacaoEmAndamento(
  l: Pick<LigacaoGuardada, "status"> & { iniciadaEm?: string | undefined },
  agoraMs: number = Date.now(),
): boolean {
  return l.status === "em_andamento" && !(l.iniciadaEm && andamentoVencido(l.iniciadaEm, agoraMs));
}

export function seloDaLigacao(
  l: Pick<LigacaoGuardada, "status" | "passouEquipe"> & { iniciadaEm?: string | undefined },
  agoraMs: number = Date.now(),
): SeloLigacao {
  if (l.passouEquipe) return "equipe";
  if (l.status === "em_andamento")
    return ligacaoEmAndamento(l, agoraMs) ? "andamento" : "sem_resumo";
  if (l.status === "nao_completada") return "nao_completada";
  return "concluida";
}

export const TEXTO_SELO: Record<SeloLigacao, string> = {
  andamento: "Em andamento",
  sem_resumo: "Sem resumo",
  concluida: "Concluída",
  equipe: "Passou para a equipe",
  nao_completada: "Não completada",
};

/** Os filtros do Histórico (spec 2.3). */
export type FiltroLigacoes = "todas" | "equipe" | "nao_completadas";

export const TEXTO_FILTRO: Record<FiltroLigacoes, string> = {
  todas: "Todas",
  equipe: "Passaram para a equipe",
  nao_completadas: "Não completadas",
};

/** Só os dígitos (a busca por número ignora espaço, parêntese e traço). */
const digitos = (t: string) => t.replace(/\D/g, "");

/** Sem acento e em minúsculas (a busca por nome ignora acento). */
const semAcento = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** As ligações do filtro e da busca (nome ou número), na ordem: a mais recente primeiro. */
export function filtrarLigacoes(
  lista: readonly Ligacao[],
  filtro: FiltroLigacoes,
  busca: string,
): Ligacao[] {
  const termo = busca.trim();
  const termoTexto = semAcento(termo);
  const termoNum = digitos(termo);
  return lista
    .filter((l) =>
      filtro === "equipe"
        ? l.passouEquipe
        : filtro === "nao_completadas"
          ? l.status === "nao_completada"
          : true,
    )
    .filter((l) => {
      if (!termo) return true;
      if (l.nome && semAcento(l.nome).includes(termoTexto)) return true;
      return termoNum.length >= 3 && !!l.telefone && digitos(l.telefone).includes(termoNum);
    })
    .sort((a, b) => Date.parse(b.iniciadaEm) - Date.parse(a.iniciadaEm));
}

/** "2 min 54 s", "45 s", "10 min". */
export function duracaoCurta(segundos: number): string {
  const s = Math.max(0, Math.round(segundos));
  const min = Math.floor(s / 60);
  const resto = s % 60;
  if (min === 0) return `${resto} s`;
  return resto ? `${min} min ${resto} s` : `${min} min`;
}

/** O tempo de uma fala: "0:05", "2:41". */
export function tempoDaFala(segundos: number): string {
  const s = Math.max(0, Math.floor(segundos));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Por que a ligação terminou, em português (o motivo da ElevenLabs; o que não for conhecido fica genérico). */
export function textoMotivoFim(
  l: Pick<LigacaoGuardada, "motivoFim" | "status" | "passouEquipe"> & {
    iniciadaEm?: string | undefined;
  },
  agoraMs: number = Date.now(),
): string {
  if (l.status === "em_andamento")
    return ligacaoEmAndamento(l, agoraMs)
      ? "Ainda não terminou"
      : "O fim da ligação não chegou da ElevenLabs";
  switch (l.motivoFim) {
    case "client_ended":
    case "cliente_desligou":
      return "O contato desligou";
    case "agent_ended":
    case "agente_desligou":
      return l.passouEquipe
        ? "O agente desligou depois de passar para a equipe"
        : "O agente encerrou a conversa";
    case "max_duration":
    case "duracao_maxima":
      return "Chegou à duração máxima";
    case "silence":
    case "silencio":
      return "Ficou em silêncio por muito tempo";
    case "nao_atendida":
      return "A ligação caiu antes de começar";
    case "erro":
      return "Um erro interrompeu a ligação";
    default:
      return l.status === "nao_completada" ? "A ligação não se completou" : "A ligação terminou";
  }
}

/* ---------- o topo ---------- */

/** Os três números do topo (spec 2.3). */
export interface NumerosLigacoes {
  hoje: number;
  minutosNoMes: number;
  emAndamento: number;
}

/** Ligações hoje, minutos no mês (as que terminaram, arredondado para cima) e em andamento agora. */
export function numerosDasLigacoes(
  lista: readonly LigacaoGuardada[],
  agoraMs: number,
): NumerosLigacoes {
  const hoje = diaLocal(agoraMs);
  const mes = hoje.slice(0, 7);
  let nHoje = 0;
  let segundosMes = 0;
  let andamento = 0;
  for (const l of lista) {
    const dia = diaLocal(l.iniciadaEm);
    if (dia === hoje) nHoje += 1;
    if (dia.slice(0, 7) === mes) segundosMes += l.duracaoS ?? 0;
    if (ligacaoEmAndamento(l, agoraMs)) andamento += 1;
  }
  return { hoje: nHoje, minutosNoMes: Math.ceil(segundosMes / 60), emAndamento: andamento };
}
