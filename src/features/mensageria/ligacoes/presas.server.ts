// A ligação presa em "em andamento" ("Porte da vitrine"; trazido da Nina
// vitrine em 17/11/2026). Quando a ElevenLabs põe a ligação na fila (o limite de simultâneas) e a
// pessoa desiste, recusa a ligação sem mandar o call_initiation_failure, ou o pós-chamada se perde
// (as ligações foram desativadas no meio, e a rota já não tem o segredo para conferir a
// assinatura), a ligação ficava "em andamento" para sempre, sem resumo nem transcrição.
// O worker confere na ElevenLabs as que passaram de PRESA_DEPOIS_MS e fecha o que ela confirma:
// - a que falhou, que acabou sem durar nada ou que morreu sem terminar: "não completada" (e o aviso
//   no chat, se ainda servir);
// - a que durou e cujo pós-chamada não chegou até POS_CHAMADA_ATRASADO_MS depois do fim: fechada
//   com a conversa inteira lida da ElevenLabs, como o pós-chamada faria (resumo, transcrição e a
//   passagem para a equipe, se a ferramenta foi chamada).
// Tudo dentro do prazo da chamada do worker (fimEm): cada consulta só começa se cabe nele.
// Nunca lança e não loga ids nem telefones: a falha vira um código no log.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ELEVENLABS_API } from "@/features/servidor/ligacoes-elevenlabs";

import { lerChaveIA } from "../nucleo/conexoes.server";
import { acordarMotor } from "../nucleo/motor.server";
import {
  acharLigacao,
  avisarFalhaDaLigacao,
  encerrarLigacao,
  passarLigacaoParaEquipe,
  rearmarDepoisDaLigacao,
  type FimDaLigacao,
} from "./banco.server";
import { fimDaTranscricao, pediuEquipe } from "./rotas.server";
import { DURACAO_MAX_AGENTE_S, SESSAO_VALIDA_S } from "./tipos";

/** A ligação em andamento há mais que isto, sem pós-chamada, é conferida na ElevenLabs. */
export const PRESA_DEPOIS_MS = 2 * 60 * 1000;
/** Quantas consultas sozinhas (GET de uma conversa) o worker faz por chamada. */
export const MAX_CONSULTAS_POR_CHAMADA = 5;
/** Teto de cada consulta à ElevenLabs. */
export const PRAZO_CONSULTA_MS = 5_000;
/**
 * Passado isto do início, a conversa que a ElevenLabs ainda não deu como terminada sem durar nada
 * morreu lá (na Nina vitrine, conversas ficaram "initiated" e "in-progress" por dias): a duração
 * máxima de um agente mais a folga, o mesmo prazo da sessão da ligação.
 */
export const INICIADA_MORTA_MS = SESSAO_VALIDA_S * 1000;
/**
 * A ligação que durou e terminou espera o pós-chamada de sempre; passado isto do fim dela sem
 * ele, o worker a fecha pela ElevenLabs. Bem menos que a folga do teto da espera (2 min além da
 * duração máxima do agente, ligacao_teto): a ligação fica fechada antes de a conversa voltar, e a
 * rodada depois da ligação a encontra concluída.
 */
export const POS_CHAMADA_ATRASADO_MS = 60 * 1000;
/** Quantas ligações o worker fecha por chamada (o resto fica para a próxima). */
export const MAX_FECHADAS_POR_CHAMADA = 20;
/** O que cada fechamento (as gravações no banco) reserva do prazo da chamada. */
export const RESERVA_FECHAR_MS = 3_000;

/** O que a ElevenLabs diz da conversa (GET /v1/convai/conversations/{id} ou a lista). */
export type ConversaEleven = {
  status?: string;
  metadata?: {
    call_duration_secs?: number;
    start_time_unix_secs?: number;
    termination_reason?: string;
  };
};

/** O que fazer com uma ligação presa, pelo que a ElevenLabs diz. Pura. */
export type DecisaoDaPresa =
  { tipo: "nao_completada"; fim: FimDaLigacao } | { tipo: "ler_inteira" } | null;

/** O fim de uma ligação que não completou, agora. Pura. */
function fimNaoCompletada(agoraMs: number): FimDaLigacao {
  return {
    status: "nao_completada",
    encerradaEm: new Date(agoraMs).toISOString(),
    duracaoS: null,
    motivoFim: "nao_atendida",
    resumo: null,
    transcricao: [],
    custoCreditos: null,
  };
}

export function decidirPresa(
  c: ConversaEleven,
  agoraMs: number,
  iniciadaEm: string,
): DecisaoDaPresa {
  const duracao = c.metadata?.call_duration_secs ?? 0;
  const inicioMs = Date.parse(iniciadaEm);
  const idade = Number.isFinite(inicioMs) ? agoraMs - inicioMs : 0;
  const terminou = c.status === "done" || c.status === "failed";
  const morta = !terminou && idade > INICIADA_MORTA_MS;
  // morreu sem terminar depois de falar: fecha com o que a ElevenLabs tiver da conversa
  if (morta && duracao > 0) return { tipo: "ler_inteira" };
  if (c.status === "failed" || (c.status === "done" && duracao === 0) || morta) {
    return { tipo: "nao_completada", fim: fimNaoCompletada(agoraMs) };
  }
  // durou e terminou: o pós-chamada devia ter chegado até o fim mais a folga
  if (c.status === "done" && duracao > 0 && idade > duracao * 1000 + POS_CHAMADA_ATRASADO_MS) {
    return { tipo: "ler_inteira" };
  }
  return null;
}

export type ResultadoPresas = { conferidas: number; fechadas: number } | "nenhuma" | "falhou";

/** Quantas ligações presas o worker olha por chamada (no banco). */
export const MAX_CANDIDATAS = 200;
/** Páginas da lista de conversas da ElevenLabs por agente (100 por página). */
export const MAX_PAGINAS = 3;

type LinhaPresa = { id_externo: string; iniciada_em: string; agente_id: string | null };

/** O motivo da ligação de saída que a ElevenLabs nunca confirmou (spec da saída; Opus, PR #24). */
export const MOTIVO_SAIDA_NAO_CONFIRMADA = "saida_nao_confirmada";
/** A folga depois da duração máxima do agente (a mesma do ligacao_teto, base 0031). */
const FOLGA_TETO_MS = 2 * 60 * 1000;
type ItemDaLista = { conversation_id?: string; status?: string; call_duration_secs?: number };

/**
 * Confere e fecha as ligações presas. Uma ida à lista de conversas de cada agente traz o estado de
 * todas de uma vez; a que não aparece nela é consultada sozinha, sorteada, até
 * MAX_CONSULTAS_POR_CHAMADA (as mesmas mais antigas sempre deixariam as outras de fora). Nunca
 * lança.
 */
export async function fecharLigacoesPresas(
  opcoes: {
    /** Prazo absoluto (ms) da chamada do worker: nenhuma consulta começa sem caber nele. */
    fimEm?: number;
    agoraMs?: number;
    fetch?: typeof fetch;
    embaralhar?: <T>(xs: T[]) => T[];
  } = {},
): Promise<ResultadoPresas> {
  const agoraMs = opcoes.agoraMs ?? Date.now();
  const fimEm = opcoes.fimEm ?? Number.POSITIVE_INFINITY;
  const buscar = opcoes.fetch ?? fetch;
  const embaralhar = opcoes.embaralhar ?? embaralharAoAcaso;
  const cabe = () => Date.now() + PRAZO_CONSULTA_MS <= fimEm;
  const cabeFechar = () =>
    Date.now() + RESERVA_FECHAR_MS <= fimEm && fechadas < MAX_FECHADAS_POR_CHAMADA;
  let fechadas = 0;
  let concluidas = 0;
  try {
    const { data, error } = await supabaseAdmin
      .from("ligacoes")
      .select("id_externo, iniciada_em, agente_id")
      .eq("status", "em_andamento")
      .lt("iniciada_em", new Date(agoraMs - PRESA_DEPOIS_MS).toISOString())
      .order("iniciada_em", { ascending: true })
      .limit(MAX_CANDIDATAS);
    if (error) return "falhou";
    const todas = (data ?? []).filter((l): l is LinhaPresa => Boolean(l.id_externo));
    // o aviso de falha que não gravou na primeira vez, mesmo sem nenhuma ligação presa agora
    await repetirAvisos(agoraMs);
    if (todas.length === 0) return "nenhuma";
    // a ligação de saída que a ElevenLabs nunca confirmou: o id dela lá não se sabe, então não há
    // o que consultar; passado o teto mais longo (30 min + 2, não o do agente, que é editável e pode
    // estar menor aqui que lá; Sol, PR #26), a chamada já acabou de todo jeito, e ela fecha como
    // não completada (um pós-chamada que chegue depois confirma pela nina_ligacao e conclui)
    const provisorias = todas.filter((l) => l.id_externo.startsWith("saida-"));
    if (provisorias.length > 0) {
      const teto = DURACAO_MAX_AGENTE_S * 1000 + FOLGA_TETO_MS;
      for (const l of provisorias) {
        if (!cabeFechar()) break;
        if (agoraMs - Date.parse(l.iniciada_em) <= teto) continue;
        await encerrarLigacao(l.id_externo, {
          ...fimNaoCompletada(agoraMs),
          motivoFim: MOTIVO_SAIDA_NAO_CONFIRMADA,
        });
        fechadas++;
      }
    }
    const linhas = todas.filter((l) => !l.id_externo.startsWith("saida-"));
    if (linhas.length === 0) return { conferidas: provisorias.length, fechadas };
    const k = await lerChaveIA("voz");
    if (!k || k.provedor !== "elevenlabs" || !k.chave.trim()) return "falhou";
    const desdeS = Math.floor(Date.parse(linhas[0]!.iniciada_em) / 1000) - 60;
    const lista = await estadosNaLista(k.chave, await agentesDaVoz(), desdeS, buscar, cabe);
    // as que a lista mostrou primeiro (decidem sem consulta, ou com a consulta que lê a conversa
    // inteira): as antigas que nunca se resolvem não tomam a vez delas
    linhas.sort((a, b) => Number(lista.has(b.id_externo)) - Number(lista.has(a.id_externo)));
    const sozinhas = new Set(
      embaralhar(linhas.filter((l) => !lista.has(l.id_externo)))
        .slice(0, MAX_CONSULTAS_POR_CHAMADA)
        .map((l) => l.id_externo),
    );
    let consultas = 0;
    for (const l of linhas) {
      if (!cabeFechar()) break;
      let c = lista.get(l.id_externo) ?? null;
      let inteira: Record<string, unknown> | null = null;
      if (!c) {
        if (!sozinhas.has(l.id_externo) || !cabe()) continue;
        consultas++;
        const lida = await consultarInteira(l.id_externo, k.chave, buscar);
        // a consulta gastou o prazo: as gravações ficam para a próxima chamada
        if (!cabeFechar()) break;
        if (!lida.ok) {
          // a ElevenLabs não acha mais a conversa (o agente foi apagado, ou ela sumiu): passada a
          // duração máxima mais a folga, fecha como não completada, sem aviso (já é tarde; o
          // motivo próprio a tira da nova tentativa de aviso)
          if (lida.status === 404 && agoraMs - Date.parse(l.iniciada_em) > INICIADA_MORTA_MS) {
            await encerrarLigacao(l.id_externo, {
              ...fimNaoCompletada(agoraMs),
              motivoFim: MOTIVO_NAO_ENCONTRADA,
            });
            fechadas++;
          } else console.error("ligacao_presa", "consulta_falhou");
          continue;
        }
        inteira = lida.dados;
        c = inteira as ConversaEleven;
      }
      const decisao = decidirPresa(c, agoraMs, l.iniciada_em);
      if (!decisao) continue;
      if (decisao.tipo === "nao_completada") {
        const gravada = await encerrarLigacao(l.id_externo, decisao.fim);
        fechadas++;
        // a que não completou vira mensagem no chat, se ainda servir (o banco decide)
        if (
          gravada &&
          (await avisarFalhaDaLigacao(gravada.ligacaoId, gravada.conversaId)) === "erro"
        )
          console.error("ligacao_presa", "aviso_falhou");
        continue;
      }
      // durou e o pós-chamada não veio: a conversa inteira, como o pós-chamada a traria
      if (!inteira) {
        if (consultas >= MAX_CONSULTAS_POR_CHAMADA || !cabe()) continue;
        consultas++;
        const lida = await consultarInteira(l.id_externo, k.chave, buscar);
        if (!lida.ok) {
          console.error("ligacao_presa", "consulta_falhou");
          continue;
        }
        inteira = lida.dados;
        // a consulta gastou o prazo: as gravações ficam para a próxima chamada
        if (!cabeFechar()) break;
      }
      // a passagem para a equipe antes do fechamento: se ela falhar, a ligação continua presa e a
      // próxima chamada repete as duas (o banco passa uma vez só por ligação)
      if (pediuEquipe(inteira["transcript"])) {
        const lig = await acharLigacao(l.id_externo);
        if (lig) await passarLigacaoParaEquipe(lig.id);
      }
      const fim = fimDaTranscricao({}, inteira, agoraMs);
      const fechada = await encerrarLigacao(l.id_externo, fim);
      fechadas++;
      if (fechada && fim.status === "concluida") {
        if ((await rearmarDepoisDaLigacao(fechada.ligacaoId)) === "erro") {
          console.error("ligacao_presa", "rearme_falhou");
        }
        concluidas++;
      }
    }
    // a ligação concluída solta a rodada que esperava por ela (a rodada depois da ligação): o
    // toque com renovar, porque a conversa armada desde o começo da ligação parece item preso
    if (concluidas > 0) await acordarMotor(null, { renovar: true }).catch(() => undefined);
    return { conferidas: linhas.length, fechadas };
  } catch (erro) {
    console.error("ligacao_presa", erro instanceof Error ? erro.message.slice(0, 60) : "erro");
    return "falhou";
  }
}

/** Quanto tempo depois do fim o aviso de falha que não gravou ainda é tentado de novo. */
export const REPETIR_AVISO_MS = 15 * 60 * 1000;
/** O motivo da ligação fechada porque a ElevenLabs não a acha mais: nunca recebe aviso. */
export const MOTIVO_NAO_ENCONTRADA = "nao_encontrada";

/**
 * As ligações de entrada que fecharam como não completadas há pouco, sem o aviso no chat: tenta de
 * novo (o banco avisa uma vez só por ligação e decide se ainda serve). Nunca lança.
 */
async function repetirAvisos(agoraMs: number): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin
      .from("ligacoes")
      .select("id, conversa_id, iniciada_em")
      .eq("status", "nao_completada")
      .eq("direcao", "entrada")
      // todas as falhas, menos a ligação sumida (404), que fecha sem aviso
      .or(`motivo_fim.is.null,motivo_fim.neq.${MOTIVO_NAO_ENCONTRADA}`)
      .is("aviso_falha_em", null)
      .gte("encerrada_em", new Date(agoraMs - REPETIR_AVISO_MS).toISOString())
      .limit(10);
    if (error || !data || data.length === 0) return;
    // a conversa que já recebeu um aviso perto desta ligação não recebe outro (a trava de 10 min
    // do banco conta de agora: na nova tentativa, ela viraria só um atraso)
    const ids = [...new Set(data.map((l) => l.conversa_id).filter((x): x is string => !!x))];
    const { data: avisadas, error: e2 } = await supabaseAdmin
      .from("ligacoes")
      .select("conversa_id, aviso_falha_em")
      .in("conversa_id", ids)
      .not("aviso_falha_em", "is", null);
    if (e2) return;
    for (const l of data) {
      if (!l.conversa_id) continue;
      const inicio = Date.parse(l.iniciada_em);
      const perto = (avisadas ?? []).some(
        (a) =>
          a.conversa_id === l.conversa_id &&
          Date.parse(a.aviso_falha_em ?? "") >= inicio - 10 * 60 * 1000,
      );
      if (!perto) await avisarFalhaDaLigacao(l.id, l.conversa_id);
    }
  } catch {
    // fica para a próxima chamada
  }
}

/** Uma cópia da lista em ordem sorteada (Fisher-Yates). */
function embaralharAoAcaso<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Os ids dos agentes de voz na ElevenLabs (as linhas de ligacao_agentes). Falha = nenhum. */
async function agentesDaVoz(): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("ligacao_agentes")
    .select("id_externo")
    .not("id_externo", "is", null);
  if (error) return [];
  return (data ?? []).map((a) => a.id_externo).filter((x): x is string => !!x);
}

/** O estado das conversas recentes de cada agente, pela lista da ElevenLabs. Falha = o que leu. */
async function estadosNaLista(
  chave: string,
  agentes: string[],
  desdeS: number,
  buscar: typeof fetch,
  cabe: () => boolean,
): Promise<Map<string, ConversaEleven>> {
  const mapa = new Map<string, ConversaEleven>();
  for (const agente of agentes) {
    let cursor: string | null = null;
    for (let p = 0; p < MAX_PAGINAS; p++) {
      if (!cabe()) return mapa;
      const url =
        `${ELEVENLABS_API}/v1/convai/conversations?agent_id=${encodeURIComponent(agente)}` +
        `&page_size=100&call_start_after_unix=${desdeS}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      try {
        const r = await buscar(url, {
          headers: { "xi-api-key": chave },
          signal: AbortSignal.timeout(PRAZO_CONSULTA_MS),
        });
        if (!r.ok) break;
        const d = (await r.json()) as {
          conversations?: ItemDaLista[];
          has_more?: boolean;
          next_cursor?: string | null;
        };
        for (const c of d.conversations ?? []) {
          if (c.conversation_id)
            mapa.set(c.conversation_id, {
              ...(c.status ? { status: c.status } : {}),
              metadata: { call_duration_secs: c.call_duration_secs ?? 0 },
            });
        }
        if (!d.has_more || !d.next_cursor) break;
        cursor = d.next_cursor;
      } catch {
        break;
      }
    }
  }
  return mapa;
}

type Consulta = { ok: true; dados: Record<string, unknown> } | { ok: false; status: number };

/** A conversa inteira (GET /v1/convai/conversations/{id}), no formato do pós-chamada. */
async function consultarInteira(
  id: string,
  chave: string,
  buscar: typeof fetch,
): Promise<Consulta> {
  try {
    const r = await buscar(`${ELEVENLABS_API}/v1/convai/conversations/${encodeURIComponent(id)}`, {
      headers: { "xi-api-key": chave },
      signal: AbortSignal.timeout(PRAZO_CONSULTA_MS),
    });
    if (!r.ok) return { ok: false, status: r.status };
    const d: unknown = await r.json();
    return d && typeof d === "object" && !Array.isArray(d)
      ? { ok: true, dados: d as Record<string, unknown> }
      : { ok: false, status: 0 };
  } catch {
    return { ok: false, status: 0 };
  }
}
