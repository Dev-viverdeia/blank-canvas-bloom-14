// Dublês para os testes da IA: um Supabase em memória (só o que a pasta ia/ usa) e passos
// prontos para o modelo falso do AI SDK. Não roda em produção: só os testes importam.
type Linha = Record<string, unknown>;
type RespostaRpc = { data: unknown; error: { code?: string; message?: string } | null };

export const banco = {
  tabelas: {} as Record<string, Linha[]>,
  rpcs: [] as { nome: string; args: Record<string, unknown> }[],
  respostaRpc: (_nome: string, _args: Record<string, unknown>): RespostaRpc => ({
    data: null,
    error: null,
  }),
};

export function limparBanco(tabelas: Record<string, Linha[]> = {}): void {
  banco.tabelas = structuredClone(tabelas);
  banco.rpcs = [];
  banco.respostaRpc = () => ({ data: null, error: null });
}

function comparar(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return (a as number | string) < (b as number | string) ? -1 : 1;
}

function from(tabela: string) {
  const q = {
    op: "select" as "select" | "insert" | "update",
    valores: null as Linha | Linha[] | null,
    filtros: [] as ((l: Linha) => boolean)[],
    ordens: [] as [string, boolean][],
    limite: null as number | null,
    unico: false,
    /** select(..., { count: "exact", head }) */
    contar: false,
    cabeca: false,
  };
  const executar = () => {
    const linhas = (banco.tabelas[tabela] ??= []);
    if (q.op === "insert") {
      const novas = (Array.isArray(q.valores) ? q.valores : [q.valores ?? {}]).map((v) => ({
        ...v,
      }));
      linhas.push(...novas);
      return { data: novas, error: null };
    }
    let alvo = linhas.filter((l) => q.filtros.every((f) => f(l)));
    if (q.op === "update") {
      alvo.forEach((l) => Object.assign(l, q.valores));
      return { data: alvo, error: null };
    }
    const total = alvo.length;
    alvo = [...alvo].sort((a, b) => {
      for (const [col, asc] of q.ordens) {
        const c = comparar(a[col], b[col]);
        if (c !== 0) return asc ? c : -c;
      }
      return 0;
    });
    if (q.limite !== null) alvo = alvo.slice(0, q.limite);
    if (q.contar) return { data: q.cabeca ? null : alvo, count: total, error: null };
    if (q.unico) return { data: alvo[0] ?? null, error: null };
    return { data: alvo, error: null };
  };
  const b: Record<string, unknown> = {
    select: (_colunas?: string, o?: { count?: string; head?: boolean }) => (
      (q.contar = o?.count === "exact"),
      (q.cabeca = o?.head === true),
      b
    ),
    insert: (v: Linha | Linha[]) => ((q.op = "insert"), (q.valores = v), b),
    update: (v: Linha) => ((q.op = "update"), (q.valores = v), b),
    eq: (c: string, v: unknown) => (q.filtros.push((l) => l[c] === v), b),
    neq: (c: string, v: unknown) => (q.filtros.push((l) => l[c] !== v), b),
    in: (c: string, lista: unknown[]) => (q.filtros.push((l) => lista.includes(l[c])), b),
    // só .not(col, "in", "(a,b)")
    not: (c: string, op: string, lista: string) => {
      if (op !== "in") throw new Error(`not não suportado: ${op}`);
      const valores = lista.replace(/^\(|\)$/g, "").split(",");
      q.filtros.push((l) => !valores.includes(String(l[c])));
      return b;
    },
    is: (c: string, v: unknown) => (q.filtros.push((l) => (l[c] ?? null) === v), b),
    lte: (c: string, v: unknown) => (q.filtros.push((l) => comparar(l[c], v) <= 0), b),
    gte: (c: string, v: unknown) => (
      q.filtros.push((l) => l[c] !== null && l[c] !== undefined && comparar(l[c], v) >= 0),
      b
    ),
    // só o curinga "%" no fim ("prefixo%")
    like: (c: string, padrao: string) => {
      const prefixo = padrao.replace(/%$/, "");
      if (prefixo.includes("%")) throw new Error(`like não suportado: ${padrao}`);
      q.filtros.push((l) => typeof l[c] === "string" && (l[c] as string).startsWith(prefixo));
      return b;
    },
    gt: (c: string, v: unknown) => (
      q.filtros.push((l) => l[c] !== null && l[c] !== undefined && comparar(l[c], v) > 0),
      b
    ),
    // só o formato "col.op.valor,col.op.\"valor\"" com eq, neq e lte
    or: (expr: string) => {
      const termos = (expr.match(/(?:[^,"]|"[^"]*")+/g) ?? []).map((t) => {
        const [, col, op, bruto] = /^([^.]+)\.(eq|neq|lte)\.(.*)$/.exec(t) ?? [];
        if (!col || !op || bruto === undefined) throw new Error(`or não suportado: ${t}`);
        const v = bruto.replace(/^"(.*)"$/, "$1");
        return (l: Linha) =>
          op === "eq" ? l[col] === v : op === "neq" ? l[col] !== v : comparar(l[col], v) <= 0;
      });
      q.filtros.push((l) => termos.some((f) => f(l)));
      return b;
    },
    order: (c: string, o?: { ascending?: boolean }) => (
      q.ordens.push([c, o?.ascending !== false]),
      b
    ),
    limit: (n: number) => ((q.limite = n), b),
    maybeSingle: () => ((q.unico = true), b),
    single: () => ((q.unico = true), b),
    then: (ok: (r: unknown) => unknown, erro?: (e: unknown) => unknown) =>
      Promise.resolve(executar()).then(ok, erro),
  };
  return b;
}

export const supabaseFalso = {
  from,
  rpc: async (nome: string, args: Record<string, unknown>) => {
    banco.rpcs.push({ nome, args });
    return banco.respostaRpc(nome, args);
  },
};

// ---------------------------------------------------------------------------
// Funções dos retornos (3.2 e 3.3): o banco falso responde o jsonb que
// as de verdade devolvem. Sem configurar, elas respondem como o banco sem retorno nenhum.
// ---------------------------------------------------------------------------

/** Erro P0001 de uma função nossa: a mensagem é o código curto (ex.: "rodada_sem_lead"). */
export function erroP0001(codigo: string): RespostaRpc {
  return { data: null, error: { code: "P0001", message: codigo } };
}

type Resposta = unknown | ((args: Record<string, unknown>) => RespostaRpc | Promise<RespostaRpc>);

/** Nomes das funções dos retornos que o servidor chama. */
export const FUNCOES_DE_RETORNO = [
  "nina_retorno_da_rodada",
  "nina_marcar_retorno",
  "nina_cancelar_retorno",
] as const;

/**
 * Liga as respostas das funções de retorno no banco falso (por cima do que já estiver em
 * banco.respostaRpc: as outras funções seguem iguais). Cada resposta é o jsonb devolvido, uma
 * função (args) => { data, error } ou erroP0001(...). Chame de novo para trocar uma resposta.
 */
export function funcoesDeRetorno(
  r: {
    /** nina_retorno_da_rodada: o jsonb (ou null: nenhum retorno). */
    daRodada?: Resposta;
    /** nina_marcar_retorno */
    marcar?: Resposta;
    /** nina_cancelar_retorno */
    cancelar?: Resposta;
  } = {},
): void {
  const anterior = banco.respostaRpc;
  const por: Record<string, Resposta | undefined> = {
    nina_retorno_da_rodada: r.daRodada,
    nina_marcar_retorno: r.marcar,
    nina_cancelar_retorno: r.cancelar,
  };
  banco.respostaRpc = (nome, args) => {
    if (!(nome in por)) return anterior(nome, args);
    const resposta = por[nome];
    if (typeof resposta === "function") {
      return (resposta as (a: Record<string, unknown>) => RespostaRpc)(args);
    }
    // já no formato { data, error } (ex.: erroP0001): vai como está
    if (
      resposta !== null &&
      typeof resposta === "object" &&
      "data" in resposta &&
      "error" in resposta
    ) {
      return resposta as RespostaRpc;
    }
    // padrão do banco sem retorno: a leitura devolve null, as ferramentas recusam por falta dele
    if (resposta === undefined) {
      if (nome === "nina_retorno_da_rodada") return { data: null, error: null };
      if (nome === "nina_cancelar_retorno") {
        return { data: { ok: false, erro: "sem_retorno" }, error: null };
      }
      return erroP0001("retornos_desligados");
    }
    return { data: resposta, error: null };
  };
}

/** Uma ou mais chamadas de ferramenta no mesmo passo (o modelo chama as duas juntas). */
export function passoComFerramentas(
  chamadas: [ferramenta: string, entrada: unknown][],
  extra: { uso?: UsoFalso } = {},
) {
  const [primeira, ...resto] = chamadas;
  if (!primeira) throw new Error("passoComFerramentas: sem chamadas");
  const base = passoFerramenta(primeira[0], primeira[1], extra);
  return {
    ...base,
    content: [
      ...base.content,
      ...resto.flatMap(([ferramenta, entrada]) => passoFerramenta(ferramenta, entrada).content),
    ],
  };
}

// ---------------------------------------------------------------------------
// Passos do modelo falso (LanguageModelV4)
// ---------------------------------------------------------------------------

export type UsoFalso = {
  entrada?: number;
  semCache?: number;
  cacheLeitura?: number;
  cacheEscrita?: number;
  saida?: number;
  bruto?: Record<string, unknown>;
};

export function uso(u: UsoFalso = {}) {
  const entrada = u.entrada ?? 100;
  return {
    inputTokens: {
      total: entrada,
      noCache: u.semCache ?? entrada - (u.cacheLeitura ?? 0) - (u.cacheEscrita ?? 0),
      cacheRead: u.cacheLeitura,
      cacheWrite: u.cacheEscrita,
    },
    outputTokens: { total: u.saida ?? 20, text: u.saida ?? 20, reasoning: undefined },
    ...(u.bruto ? { raw: u.bruto as never } : {}),
  };
}

let proximoId = 1;

export function passoFerramenta(
  ferramenta: string,
  entrada: unknown,
  extra: { uso?: UsoFalso; metadados?: Record<string, Record<string, unknown>> } = {},
) {
  return {
    content: [
      {
        type: "tool-call" as const,
        toolCallId: `chamada_${proximoId++}`,
        toolName: ferramenta,
        input: JSON.stringify(entrada),
      },
    ],
    finishReason: { unified: "tool-calls" as const, raw: undefined },
    usage: uso(extra.uso),
    warnings: [],
    response: { id: `resp_${proximoId}`, headers: { "request-id": `req_${proximoId}` } },
    ...(extra.metadados ? { providerMetadata: extra.metadados as never } : {}),
  };
}

export function passoTexto(texto: string, extra: { uso?: UsoFalso } = {}) {
  return {
    content: [{ type: "text" as const, text: texto }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: uso(extra.uso),
    warnings: [],
  };
}
