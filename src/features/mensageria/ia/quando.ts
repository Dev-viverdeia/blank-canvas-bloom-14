// Datas e horas dos retornos (3.6; servidor-proposta, seção 7). Puro:
// não toca no banco nem no relógio, o instante vem por parâmetro. O modelo manda o que o lead
// disse ("amanha", "sexta", "manha", "9h") e é aqui que isso vira o dia do calendário e a hora de
// Brasília. O banco converte para instante e confere passado, 24 h e 30 dias com o now() dele; o
// servidor nunca soma -03:00, nunca compara instantes e nunca usa toISOString() para dia local.
// Brasília não tem horário de verão: o Intl com America/Sao_Paulo resolve.

/** Quando o lead não disse a hora (caso 2 do artefato): num lugar só. */
export const PERIODOS = { manha: "09:00", tarde: "14:00", noite: "19:00" } as const;

const FORMATO = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  weekday: "long",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export type DiaBrasilia = {
  ano: number;
  mes: number;
  dia: number;
  /** 0 = domingo ... 6 = sábado */
  semana: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  hora: number;
};

/** As partes de um instante em Brasília (a linha "Agora:" e as datas por extenso usam estas). */
export function partesEmBrasilia(
  ms: number,
): Partial<Record<Intl.DateTimeFormatPartTypes, string>> {
  return Object.fromEntries(FORMATO.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
}

/** O dia do calendário de Brasília em que o instante cai. */
export function diaEmBrasilia(ms: number): DiaBrasilia {
  const p = partesEmBrasilia(ms);
  const ano = Number(p.year);
  const mes = Number(p.month);
  const dia = Number(p.day);
  return {
    ano,
    mes,
    dia,
    semana: new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay() as DiaBrasilia["semana"],
    hora: Number(p.hour),
  };
}

const SEMANA: readonly { chave: string; nome: string }[] = [
  { chave: "domingo", nome: "domingo" },
  { chave: "segunda", nome: "segunda-feira" },
  { chave: "terca", nome: "terça-feira" },
  { chave: "quarta", nome: "quarta-feira" },
  { chave: "quinta", nome: "quinta-feira" },
  { chave: "sexta", nome: "sexta-feira" },
  { chave: "sabado", nome: "sábado" },
];

const DIA_MS = 24 * 3600_000;
/** Entrada de mais de 6 h antes do agora não serve de referência (devolução com entradas antigas). */
const JANELA_REFERENCIA_MS = 6 * 3600_000;

/**
 * O dia de onde "amanhã", "sexta" etc. são contados: o do último que o lead disse (o momento da
 * entrada, que na ligação é o começo da chamada), limitado ao agora. Sem entrada, sem momento
 * legível ou com a entrada de mais de 6 h antes (conversa devolvida à Nina), o agora.
 */
export function referenciaDaRodada(
  entradas: readonly { momento?: string | null }[],
  agoraMs: number,
): number {
  let maior = Number.NEGATIVE_INFINITY;
  for (const e of entradas) {
    const t = Date.parse(e.momento ?? "");
    if (Number.isFinite(t) && t > maior) maior = t;
  }
  if (!Number.isFinite(maior)) return agoraMs;
  const referencia = Math.min(maior, agoraMs);
  return agoraMs - referencia > JANELA_REFERENCIA_MS ? agoraMs : referencia;
}

const dois = (n: number) => String(n).padStart(2, "0");

function dataValida(ano: number, mes: number, dia: number): boolean {
  if (ano < 1000) return false;
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  return d.getUTCFullYear() === ano && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia;
}

function texto(ano: number, mes: number, dia: number): string {
  return `${String(ano).padStart(4, "0")}-${dois(mes)}-${dois(dia)}`;
}

/** Soma dias só no calendário (o fuso entrou uma vez, em diaEmBrasilia). */
function somarDias(d: DiaBrasilia, delta: number): string {
  const x = new Date(Date.UTC(d.ano, d.mes - 1, d.dia + delta));
  return texto(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate());
}

/** Minúsculas, sem acento, espaços e hífens viram "_", sem "_feira" no fim nem "na_", "no_"... */
function normalizarDia(valor: string): string {
  return valor
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_")
    .replace(/_feira$/, "")
    .replace(/^(na|no|nesta|neste|esta|este|essa|esse)_/, "");
}

export type ResultadoData =
  | { data: string; palavra: "amanha" | "outra" }
  | { erro: "data_invalida" }
  | { erro: "dia_ambiguo"; hoje: string; chave: string };

/**
 * O que o modelo mandou em "data" vira AAAA-MM-DD, a partir do dia de referência (em Brasília).
 * hoje, amanha, depois_de_amanha, dia da semana (o próximo; o de hoje é ambíguo e não vira a
 * semana seguinte calado), proxima_<dia> (estritamente o próximo), AAAA-MM-DD, DD/MM e DD/MM/AAAA.
 * O resto ("ontem", instante ISO, data que não existe) é data_invalida, sem ir ao banco.
 */
export function resolverData(valor: string, referenciaMs: number): ResultadoData {
  const bruto = valor.trim();
  const ref = diaEmBrasilia(referenciaMs);
  const invalida: ResultadoData = { erro: "data_invalida" };

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bruto);
  if (iso) {
    const [ano, mes, dia] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    return dataValida(ano, mes, dia) ? { data: bruto, palavra: "outra" } : invalida;
  }

  const barras = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(bruto);
  if (barras) {
    const dia = Number(barras[1]);
    const mes = Number(barras[2]);
    if (barras[3] !== undefined) {
      const ano = Number(barras[3]);
      return dataValida(ano, mes, dia)
        ? { data: texto(ano, mes, dia), palavra: "outra" }
        : invalida;
    }
    // sem o ano: o próximo dia e mês a partir da referência (29/02 pode pular alguns anos)
    const hoje = Date.UTC(ref.ano, ref.mes - 1, ref.dia);
    for (let k = 0; k <= 4; k++) {
      const ano = ref.ano + k;
      if (dataValida(ano, mes, dia) && Date.UTC(ano, mes - 1, dia) >= hoje) {
        return { data: texto(ano, mes, dia), palavra: "outra" };
      }
    }
    return invalida;
  }

  const chave = normalizarDia(bruto);
  if (chave === "hoje") return { data: somarDias(ref, 0), palavra: "outra" };
  if (chave === "amanha") return { data: somarDias(ref, 1), palavra: "amanha" };
  if (chave === "depois_de_amanha") return { data: somarDias(ref, 2), palavra: "outra" };

  const proximo = /^(?:proxima|proximo)_(.+)$/.exec(chave);
  const dia = proximo?.[1] ?? chave;
  const alvo = SEMANA.findIndex((s) => s.chave === dia);
  if (alvo < 0) return invalida;
  const delta = (alvo - ref.semana + 7) % 7;
  if (proximo) return { data: somarDias(ref, delta || 7), palavra: "outra" };
  if (delta === 0) {
    const hoje = SEMANA[ref.semana];
    return { erro: "dia_ambiguo", hoje: hoje?.nome ?? "", chave: hoje?.chave ?? "" };
  }
  return { data: somarDias(ref, delta), palavra: "outra" };
}

export type ResultadoHora = { hora: string } | { erro: "hora_invalida" };

/**
 * O que o modelo mandou em "hora" vira HH:MM de Brasília. Aceita manha, tarde e noite (PERIODOS),
 * meio-dia e as horas escritas: "9h" é 09:00, "9h30" é 09:30, "14:00". "14:5", "24:00", instante
 * ISO e o resto são hora_invalida.
 */
export function resolverHora(valor: string): ResultadoHora {
  const t = valor.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, "");
  if (t === "manha" || t === "demanha" || t === "pelamanha") return { hora: PERIODOS.manha };
  if (t === "tarde" || t === "atarde" || t === "detarde") return { hora: PERIODOS.tarde };
  if (t === "noite" || t === "anoite" || t === "denoite") return { hora: PERIODOS.noite };
  if (t === "meiodia" || t === "meio-dia") return { hora: "12:00" };
  const m = /^(\d{1,2})(?:[:h](\d{2}))?h?$/.exec(t);
  if (!m) return { erro: "hora_invalida" };
  const hora = Number(m[1]);
  const minuto = Number(m[2] ?? "0");
  if (hora > 23 || minuto > 59) return { erro: "hora_invalida" };
  return { hora: `${dois(hora)}:${dois(minuto)}` };
}

/** "quinta-feira, 19/11/2026, às 09:00": o instante em Brasília, por extenso. */
export function formatarMomento(ms: number): string {
  const p = partesEmBrasilia(ms);
  return `${p.weekday}, ${p.day}/${p.month}/${p.year}, às ${p.hour}:${p.minute}`;
}

/** O dia do instante em relação ao dia do "Agora:" (o mesmo relógio que o modelo leu). */
export function relativoA(
  ms: number,
  agoraMs: number,
): "hoje" | "amanhã" | "depois de amanhã" | null {
  const a = diaEmBrasilia(ms);
  const b = diaEmBrasilia(agoraMs);
  const dias = Math.round(
    (Date.UTC(a.ano, a.mes - 1, a.dia) - Date.UTC(b.ano, b.mes - 1, b.dia)) / DIA_MS,
  );
  return dias === 0 ? "hoje" : dias === 1 ? "amanhã" : dias === 2 ? "depois de amanhã" : null;
}

/** formatarMomento mais o dia relativo: "quinta-feira, 19/11/2026, às 09:00 (amanhã)". */
export function porExtenso(ms: number, agoraMs: number): string {
  const relativo = relativoA(ms, agoraMs);
  return relativo ? `${formatarMomento(ms)} (${relativo})` : formatarMomento(ms);
}
