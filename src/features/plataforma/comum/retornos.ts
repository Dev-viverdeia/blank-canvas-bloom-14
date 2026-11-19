import type { AjusteLembrete, Resultado, RetornoDados } from "../dados/tipos";
import { diaComSemana, diaRelativo, horaCurta, type Instante } from "./tempo";

// As regras e os textos dos retornos da Nina nas telas (// 3.4). Tudo puro: o instante entra por parâmetro, e os dias e horas saem sempre no fuso de Brasília
// (nunca `toISOString()` para dia local). Quem usa: a faixa e as linhas do Chat (T7), o cartão do perfil
// e as linhas da aba Conversa e da gaveta do Kanban (T8).
//
// Nomes na tela: "retorno" é o combinado com o lead; "lembrete" é a cobrança automática. O lembrete NÃO
// tem faixa na conversa do Chat (decisão do Davi, artefato, "Decisões depois do levantamento do código"):
// ele aparece só no cartão do perfil e, quando sai, como uma linha no histórico.

/** O lembrete não tem faixa na conversa do Chat (decisão do Davi, 18/11/2026). Fica `false`. */
export const LEMBRETE_NA_FAIXA = false;

/** Os estados finais: o retorno some do aberto. Qualquer outro (inclusive `em_rodada` e `saindo`) conta como aberto. */
export const STATUS_FINAIS: readonly string[] = [
  "enviado",
  "dispensado",
  "cancelado",
  "nao_enviado",
];

/** O retorno ou lembrete ainda não terminou (só `pendente` mostra faixa e cartão). */
export function aberto(r: Pick<RetornoDados, "status">): boolean {
  return !STATUS_FINAIS.includes(r.status);
}

const HORA_MS = 3_600_000;
const SEM_RODADA = null;

/* =============================================================================
   Dia e hora compactos, em Brasília
   ============================================================================= */

const maiuscula = (t: string) => (t ? t[0]!.toUpperCase() + t.slice(1) : t);

/**
 * Quando está marcado, para a faixa e o cartão: "amanhã, 09:00", "hoje, 09:00", "sex, 20/11, 14:00".
 * Com `deInicio`, a 1ª letra maiúscula ("Amanhã, 09:00"). "amanhã" vira "hoje" à meia-noite de Brasília.
 */
export function quandoMarcado(vence: Instante, agora: Instante, deInicio = false): string {
  const t = `${diaRelativo(vence, agora)}, ${horaCurta(vence)}`;
  return deInicio ? maiuscula(t) : t;
}

/** O dia e a hora sempre por extenso curto, para o histórico: "qui, 19/11, às 09:00". `ref`: onde a frase fala (só o ano). */
export function diaEHora(vence: Instante, ref: Instante): string {
  return `${diaComSemana(vence, ref)}, às ${horaCurta(vence)}`;
}

/** Quando algo aconteceu, visto de agora: "hoje às 16:09", "ontem às 18:30", "qui, 19/11, às 16:09". */
export function quandoPassado(iso: Instante, agora: Instante): string {
  const dia = diaRelativo(iso, agora);
  return dia.includes(",") ? `${dia}, às ${horaCurta(iso)}` : `${dia} às ${horaCurta(iso)}`;
}

/** "desde as 09:00", "desde ontem às 18:30", "desde qui, 19/11, às 18:30". */
export function desde(iso: Instante, agora: Instante): string {
  const dia = diaRelativo(iso, agora);
  if (dia === "hoje") return `desde as ${horaCurta(iso)}`;
  return `desde ${quandoPassado(iso, agora)}`;
}

/**
 * A hora marcada de um retorno como se cita num fato: "das 09:00" no mesmo dia do fato; em outro dia,
 * "de qua, 18/11, às 23:00" (o retorno das 23:00 fechado de madrugada não diz "das 23:00" sem o dia).
 */
export function referencia(vence: Instante, fato: Instante): string {
  const mesmo = diaRelativo(vence, fato) === "hoje";
  return mesmo ? `das ${horaCurta(vence)}` : `de ${diaEHora(vence, fato)}`;
}

/* =============================================================================
   O que vale agora: o retorno e o lembrete
   ============================================================================= */

const em = (iso: string) => Date.parse(iso);

/** O mais recente primeiro (a corrida de dois pendentes: vale o de `marcado_em` mais novo). */
const maisRecente = (a: RetornoDados, b: RetornoDados) =>
  em(b.marcado_em) - em(a.marcado_em) || (a.id < b.id ? 1 : -1);

/**
 * O retorno que vale agora: `tipo = 'retorno'`, `status = 'pendente'` e `agora < expira_em`. Os estados
 * `em_rodada` e `saindo` escondem (a faixa some na hora marcada); passado o `expira_em`, também (o retorno
 * que ninguém fechou não fica dizendo "ontem, 09:00" com "Cancelar"). Quem chama tira antes os que a
 * própria tela já escondeu ao cancelar.
 */
export function retornoVisivel(rs: readonly RetornoDados[], agora: number): RetornoDados | null {
  const candidatos = rs.filter(
    (r) => r.tipo === "retorno" && r.status === "pendente" && agora < em(r.expira_em),
  );
  return candidatos.sort(maisRecente)[0] ?? null;
}

export interface CondicoesLembrete {
  /** O ajuste lido; sem ele a tela não promete lembrete. */
  ajuste: AjusteLembrete | undefined;
  /** `conversa.modo === "nina"`. */
  comNina: boolean;
  /** A etapa do lead é do tipo `aberta` (fora de Ganho e Perdido). */
  etapaAberta: boolean;
  /** A conexão ativa e conectada, e a janela de 24 h aberta (`conexaoAtiva` e `!janelaFechada`). */
  podeEnviar: boolean;
  /** `conversas.ultima_do_lead_em`. */
  ultimaDoLeadEm: string | null;
  /** `conversas.devolvida_em`: devolver à Nina depois de armado apaga o lembrete (regra A5). */
  devolvidaEm: string | null;
  agora: number;
}

/**
 * O lembrete que vai mesmo sair, para o cartão do perfil: pendente, antes do `expira_em`, com o ajuste
 * ligado, a Nina na conversa, a etapa aberta, o WhatsApp enviando e o lead calado desde que a Nina
 * armou, sem a conversa ter sido devolvida à Nina depois disso (A5). Com um retorno visível, nenhum
 * (o retorno ganha). A expiração vem da própria linha: a tela não recalcula as 3 h nem as 20:00.
 */
export function lembreteVisivel(
  rs: readonly RetornoDados[],
  c: CondicoesLembrete,
): RetornoDados | null {
  if (!c.ajuste?.ligado || !c.comNina || !c.etapaAberta || !c.podeEnviar) return null;
  if (retornoVisivel(rs, c.agora)) return null;
  const candidatos = rs.filter(
    (r) =>
      r.tipo === "lembrete" &&
      r.status === "pendente" &&
      c.agora < em(r.expira_em) &&
      (c.ultimaDoLeadEm == null || !(em(c.ultimaDoLeadEm) > em(r.marcado_em))) &&
      (c.devolvidaEm == null || !(em(c.devolvidaEm) > em(r.marcado_em))),
  );
  return candidatos.sort(maisRecente)[0] ?? null;
}

/* =============================================================================
   Os 6 motivos de "não enviado"
   ============================================================================= */

/** O valor de `nao_enviado_motivo` e o texto que vem depois de "não enviado: ". */
export const MOTIVOS_NAO_ENVIADO: Readonly<Record<string, string>> = {
  com_equipe: "a conversa estava com a equipe",
  fora_24h: "passaram 24 h da última mensagem do lead",
  desconectado: "o WhatsApp estava desconectado",
  passou_do_prazo: "passou mais de 3 h da hora marcada",
  envio_recusado: "o WhatsApp recusou o envio",
  nina_falhou: "a Nina não conseguiu responder",
};

/** O texto do motivo; `null` para nulo ou um valor que a tela não conhece (nada se inventa). */
export function textoDoMotivo(motivo: string | null | undefined): string | null {
  return motivo != null && Object.hasOwn(MOTIVOS_NAO_ENVIADO, motivo)
    ? MOTIVOS_NAO_ENVIADO[motivo]!
    : null;
}

/* =============================================================================
   As linhas do histórico
   ============================================================================= */

/** Uma linha do histórico antes de entrar na linha do tempo. */
export interface LinhaRetorno {
  /** `${retorno.id}:inicio` ou `${retorno.id}:fim`. */
  id: string;
  /** A hora do fato, mostrada em mono (nunca a hora marcada). */
  momento: string;
  /** O texto antes do negrito (a frase inteira, se não houver `forte`). */
  antes: string;
  /** O trecho em negrito, ou `null`. */
  forte: string | null;
  tom: "normal" | "falha";
  /** Onde a linha se encaixa: perto das bolhas da rodada da Nina que fez o fato. */
  ancora: { rodadaId: string; lado: "antes" | "depois" } | null;
}

/** A rodada em que a linha saiu de aberta pela mão da Nina: `fechado_por_rodada ?? rodada_id`. */
const rodadaDeFim = (r: RetornoDados): string | null =>
  r.fechado_por_rodada ?? r.rodada_id ?? SEM_RODADA;

/** O porquê que a Nina anotou, sem o ponto final (ele entra depois de "…: "); `null` se vazio. */
function porque(nota: string | null): string | null {
  const t = (nota ?? "").trim().replace(/[\s.]+$/, "");
  return t || null;
}

/**
 * As linhas do histórico a partir dos retornos e lembretes da conversa (uma ou duas por retorno; o
 * lembrete só ganha a linha de quando saiu). `nomeDe(membroId)` diz quem da equipe cancelou: "Você",
 * o nome ou "Alguém da equipe".
 */
export function linhasDosRetornos(
  rs: readonly RetornoDados[],
  nomeDe: (membroId: string) => string,
): LinhaRetorno[] {
  const substituidos = new Set(rs.map((r) => r.substitui_id).filter((id): id is string => !!id));
  const linhas: LinhaRetorno[] = [];

  for (const r of rs) {
    if (r.tipo === "lembrete") {
      if (r.status !== "enviado") continue;
      const horas = Math.max(1, Math.floor((em(r.vence_em) - em(r.marcado_em)) / HORA_MS));
      const fato = r.enviado_em ?? r.resolvido_em ?? r.vence_em;
      const rodada = rodadaDeFim(r);
      linhas.push({
        id: `${r.id}:fim`,
        momento: fato,
        antes: `Lembrete automático: o lead não respondia havia ${horas} h`,
        forte: null,
        tom: "normal",
        ancora: rodada ? { rodadaId: rodada, lado: "antes" } : null,
      });
      continue;
    }

    // a marcação (ou a remarcação): vale para qualquer estado
    linhas.push({
      id: `${r.id}:inicio`,
      momento: r.marcado_em,
      antes: r.substitui_id ? "A Nina remarcou o retorno para " : "A Nina marcou um retorno para ",
      forte: diaEHora(r.vence_em, r.marcado_em),
      tom: "normal",
      ancora: r.rodada_origem_id ? { rodadaId: r.rodada_origem_id, lado: "depois" } : null,
    });

    const fim = r.resolvido_em ?? r.enviado_em ?? r.marcado_em;
    const rodada = rodadaDeFim(r);
    const nota = porque(r.nota_fim);

    switch (r.status) {
      case "enviado":
        linhas.push({
          id: `${r.id}:fim`,
          momento: r.enviado_em ?? fim,
          antes: "Retorno combinado: a Nina voltou a falar com o lead",
          forte: null,
          tom: "normal",
          ancora: rodada ? { rodadaId: rodada, lado: "antes" } : null,
        });
        break;
      case "cancelado": {
        // o substituído não tem linha de fim: a "remarcou" do novo já conta
        if (substituidos.has(r.id)) break;
        const dia = diaEHora(r.vence_em, fim);
        let antes: string;
        let ancora: LinhaRetorno["ancora"] = null;
        if (r.cancelado_por) {
          antes = `${nomeDe(r.cancelado_por) || "Alguém da equipe"} cancelou o retorno de ${dia}`;
        } else if (r.fechado_por_rodada) {
          antes = `A Nina cancelou o retorno de ${dia}${nota ? `: ${nota}` : ""}`;
          ancora = { rodadaId: r.fechado_por_rodada, lado: "depois" };
        } else {
          // o membro que cancelou foi apagado depois: ninguém para nomear
          antes = `A equipe cancelou o retorno de ${dia}`;
        }
        linhas.push({ id: `${r.id}:fim`, momento: fim, antes, forte: null, tom: "normal", ancora });
        break;
      }
      case "dispensado":
        linhas.push({
          id: `${r.id}:fim`,
          momento: fim,
          antes: nota
            ? `A Nina dispensou o retorno ${referencia(r.vence_em, fim)}: ${nota}`
            : `A Nina releu a conversa e não mandou o retorno ${referencia(r.vence_em, fim)}`,
          forte: null,
          tom: "normal",
          ancora: null,
        });
        break;
      case "nao_enviado": {
        const motivo = textoDoMotivo(r.nao_enviado_motivo);
        linhas.push({
          id: `${r.id}:fim`,
          momento: fim,
          antes: `Retorno ${referencia(r.vence_em, fim)} não enviado${motivo ? `: ${motivo}` : ""}`,
          forte: null,
          tom: "falha",
          // o envio recusado fica depois da bolha que falhou; os outros motivos não têm bolha
          ancora:
            r.nao_enviado_motivo === "envio_recusado" && rodada
              ? { rodadaId: rodada, lado: "depois" }
              : null,
        });
        break;
      }
      default:
        // pendente, em_rodada, saindo ou um estado novo: só a linha de marcação
        break;
    }
  }
  return linhas;
}

/** Uma linha com a chave de ordem (`em`) e o peso do desempate. */
export type LinhaAncorada = LinhaRetorno & { em: string; peso: -1 | 0 | 1 };

/**
 * Encaixa cada linha na rodada pela `mensagens.rodada_id`, só com as bolhas da NINA (a fala do lead que a
 * rodada mista leu também leva o `rodada_id`, e puxaria a linha para antes dela). `em` ordena e decide o
 * separador de dia; `momento` é a hora mostrada.
 * - "depois": `em` é o mais tarde entre o fato e a última bolha da rodada, peso +1;
 * - "antes": `em` é o mais cedo entre o fato e a primeira bolha da rodada, peso -1;
 * - sem âncora, ou sem a rodada nas mensagens carregadas: `em` é o fato e o peso, 0 (a ordem cai para o tempo).
 * Copia a string de `momento`; não usa `toISOString()`.
 */
export function ancorar(
  ls: readonly LinhaRetorno[],
  ms: readonly { momento: string; origem?: string; rodada_id?: string | null }[],
): LinhaAncorada[] {
  const faixa = new Map<string, { primeira: string; ultima: string }>();
  for (const m of ms) {
    if (m.origem !== "nina" || !m.rodada_id || !Number.isFinite(em(m.momento))) continue;
    const f = faixa.get(m.rodada_id);
    if (!f) faixa.set(m.rodada_id, { primeira: m.momento, ultima: m.momento });
    else {
      if (em(m.momento) < em(f.primeira)) f.primeira = m.momento;
      if (em(m.momento) > em(f.ultima)) f.ultima = m.momento;
    }
  }
  return ls.map((l): LinhaAncorada => {
    const f = l.ancora ? faixa.get(l.ancora.rodadaId) : undefined;
    if (!l.ancora || !f || !Number.isFinite(em(l.momento))) return { ...l, em: l.momento, peso: 0 };
    if (l.ancora.lado === "depois") {
      return { ...l, em: em(l.momento) < em(f.ultima) ? f.ultima : l.momento, peso: 1 };
    }
    return { ...l, em: em(l.momento) > em(f.primeira) ? f.primeira : l.momento, peso: -1 };
  });
}

/* =============================================================================
   A faixa do Chat e o cartão do perfil
   ============================================================================= */

/** Quando a conversa não está com a Nina: ela só envia se voltar antes da hora. */
const NOTA_FORA_DA_NINA = "A Nina só envia se a conversa voltar para ela antes da hora.";

export interface ConteudoFaixaRetorno {
  id: string;
  /** "Retorno marcado para amanhã, 09:00" (em negrito). */
  forte: string;
  /** Com a Nina: o motivo, na mesma linha, depois de " · ". */
  motivo: string | null;
  /** Fora da Nina: a nota, em linha própria, no lugar do motivo. */
  nota: string | null;
  /** O texto inteiro, para o `title` (a faixa corta em 2 linhas). */
  frase: string;
  /** O nome do link, que começa pelo texto visível (WCAG 2.5.3). */
  rotuloCancelar: string;
  rotuloCancelando: string;
}

/**
 * O que a faixa do retorno diz. Só o retorno combinado: o lembrete nunca tem faixa no Chat (a constante
 * `LEMBRETE_NA_FAIXA`). `retorno` é o já visível (`retornoVisivel`, sem os que a tela escondeu).
 */
export function faixaDoRetorno(p: {
  retorno: RetornoDados | null;
  comNina: boolean;
  agora: number;
}): ConteudoFaixaRetorno | null {
  const r = p.retorno;
  if (!r) return null;
  const quando = quandoMarcado(r.vence_em, p.agora);
  const forte = `Retorno marcado para ${quando}`;
  const motivo = p.comNina ? (r.motivo ?? "").trim() || null : null;
  const nota = p.comNina ? null : NOTA_FORA_DA_NINA;
  const resto = motivo ?? nota;
  return {
    id: r.id,
    forte,
    motivo,
    nota,
    frase: resto ? `${forte} · ${resto}` : forte,
    rotuloCancelar: `Cancelar o retorno de ${quando}`,
    rotuloCancelando: `Cancelando o retorno de ${quando}`,
  };
}

/** O que o cartão do perfil desenha (quadros 17 e 18). */
export type ConteudoCartao =
  | {
      tipo: "retorno";
      id: string;
      titulo: "Retorno marcado";
      quem: string;
      sub: null;
      quando: string;
      texto: string;
      nota: string | null;
      botao: "Cancelar retorno";
    }
  | {
      tipo: "lembrete";
      id: string;
      titulo: "Lembrete automático";
      quem: null;
      sub: "se o lead não responder";
      quando: string;
      texto: string;
      nota: null;
      botao: "Cancelar lembrete";
    };

/** O cartão do perfil: o retorno visível ou, sem ele, o lembrete visível; nenhum se não houver. */
export function cartaoDoRetorno(p: {
  retorno: RetornoDados | null;
  lembrete: RetornoDados | null;
  comNina: boolean;
  agora: number;
}): ConteudoCartao | null {
  if (p.retorno) {
    const r = p.retorno;
    return {
      tipo: "retorno",
      id: r.id,
      titulo: "Retorno marcado",
      quem: `pela Nina, ${quandoPassado(r.marcado_em, p.agora)}`,
      sub: null,
      quando: quandoMarcado(r.vence_em, p.agora, true),
      texto: (r.motivo ?? "").trim(),
      nota: p.comNina ? null : NOTA_FORA_DA_NINA,
      botao: "Cancelar retorno",
    };
  }
  if (p.lembrete) {
    const l = p.lembrete;
    return {
      tipo: "lembrete",
      id: l.id,
      titulo: "Lembrete automático",
      quem: null,
      sub: "se o lead não responder",
      quando: quandoMarcado(l.vence_em, p.agora, true),
      texto: `A Nina espera a resposta do lead ${desde(l.marcado_em, p.agora)}.`,
      nota: null,
      botao: "Cancelar lembrete",
    };
  }
  return null;
}

/* =============================================================================
   Os avisos do cancelar (iguais no Chat e no perfil)
   ============================================================================= */

/**
 * O aviso curto depois de cancelar e o que a tela faz: `some` diz se a faixa ou o cartão saem na hora
 * (deu certo, ou o retorno já tinha saído ou sido cancelado). Nos outros erros, o controle fica e a
 * pessoa tenta de novo.
 */
export function avisoDoCancelar(
  tipo: "retorno" | "lembrete",
  r: Resultado<unknown>,
): { texto: string; tom: "ok" | "erro"; some: boolean } {
  if (r.ok) {
    return {
      texto:
        tipo === "retorno"
          ? "Retorno cancelado. A Nina não vai chamar o lead."
          : "Lembrete cancelado. A Nina não vai mandar o lembrete.",
      tom: "ok",
      some: true,
    };
  }
  switch (r.erro) {
    case "retorno_nao_pendente":
    case "nao_encontrado":
      return { texto: `Esse ${tipo} já saiu ou já foi cancelado.`, tom: "erro", some: true };
    case "sem_acesso":
    case "sem_permissao":
      return {
        texto: "Sua conta não tem mais acesso a isto. Peça ao admin para conferir o seu convite.",
        tom: "erro",
        some: false,
      };
    default:
      return { texto: "Não deu para cancelar agora. Tente de novo.", tom: "erro", some: false };
  }
}
