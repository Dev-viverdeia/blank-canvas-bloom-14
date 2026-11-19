// @vitest-environment node
// A ligação presa em "em andamento" (presas.server.ts; trazido da Nina vitrine em 17/11/2026).
import { beforeEach, describe, expect, it, vi } from "vitest";

const banco = vi.hoisted(() => ({
  tabelas: {} as Record<string, unknown[]>,
  encerradas: [] as { id: string; status: string; resumo?: string | null; falas?: number }[],
  avisos: [] as string[],
  equipe: [] as string[],
  toques: 0,
}));
vi.mock("@/integrations/supabase/client.server", () => {
  type Linha = Record<string, unknown>;
  // os filtros do PostgREST aplicados de verdade, estritos: a linha do teste traz toda coluna
  // filtrada (sem ela, o filtro não casa, como no banco), e coluna que a tabela não tem lança
  // (o PostgREST recusa o pedido)
  const COLUNAS: Record<string, string[]> = {
    ligacao_agentes: ["id", "id_externo", "nome", "atende", "duracao_max_s"],
    ligacoes: [
      "agente_id",
      "atualizado_em",
      "aviso_falha_em",
      "conexao_id",
      "conversa_id",
      "criado_em",
      "custo_creditos",
      "direcao",
      "duracao_s",
      "encerrada_em",
      "id",
      "id_externo",
      "iniciada_em",
      "mensagem_id",
      "motivo_fim",
      "passou_equipe",
      "resumo",
      "status",
      "transcricao",
    ],
  };
  const conferir = (tabela: string, k: string) => {
    const cols = COLUNAS[tabela];
    if (cols && !cols.includes(k)) throw new Error(`coluna desconhecida: ${tabela}.${k}`);
  };
  const consulta = (tabela: string) => {
    const filtros: ((r: Linha) => boolean)[] = [];
    let colunas: string[] | null = null;
    let ordem: { k: string; asc: boolean } | null = null;
    let teto = Infinity;
    const resposta = async () => {
      let linhas = ((banco.tabelas[tabela] ?? []) as Linha[]).filter((r) =>
        filtros.every((f) => f(r)),
      );
      if (ordem) {
        const { k, asc } = ordem;
        linhas = [...linhas].sort(
          (a, b) => (String(a[k]) < String(b[k]) ? -1 : 1) * (asc ? 1 : -1),
        );
      }
      linhas = linhas.slice(0, teto);
      // o select devolve só as colunas pedidas, como o PostgREST
      const data = colunas
        ? linhas.map((r) => Object.fromEntries(colunas!.map((k) => [k, r[k] ?? null])))
        : linhas;
      return { data, error: null };
    };
    const c: Record<string, unknown> = {};
    const add = (f: (r: Linha) => boolean, ...cols: string[]) => {
      for (const k of cols) conferir(tabela, k);
      filtros.push(f);
      return c;
    };
    c["select"] = (lista: string) => {
      colunas = lista.split(",").map((k) => k.trim());
      for (const k of colunas) conferir(tabela, k);
      return c;
    };
    c["order"] = (k: string, o?: { ascending?: boolean }) => {
      conferir(tabela, k);
      ordem = { k, asc: o?.ascending !== false };
      return c;
    };
    c["eq"] = (k: string, v: unknown) => add((r) => r[k] === v, k);
    c["is"] = (k: string, v: unknown) => add((r) => (r[k] ?? null) === v, k);
    c["gte"] = (k: string, v: string) => add((r) => r[k] != null && String(r[k]) >= v, k);
    c["lt"] = (k: string, v: string) => add((r) => r[k] != null && String(r[k]) < v, k);
    c["like"] = (k: string, v: string) =>
      add((r) => r[k] != null && String(r[k]).startsWith(v.replace(/%$/, "")), k);
    c["in"] = (k: string, v: unknown[]) => add((r) => v.includes(r[k]), k);
    c["not"] = (k: string, op: string, v: unknown) =>
      add((r) => (op === "is" && v === null ? (r[k] ?? null) !== null : true), k);
    // or=(col.is.null,col.neq.valor): só a forma usada pelo código
    c["or"] = (expr: string) => {
      const partes = expr.split(",").map((p) => p.split("."));
      for (const [k] of partes) conferir(tabela, k!);
      return add((r) =>
        partes.some(([k, op, ...resto]) => {
          const v = resto.join(".");
          if (op === "is" && v === "null") return (r[k!] ?? null) === null;
          // como no Postgres: neq não devolve a linha com NULL
          if (op === "neq") return (r[k!] ?? null) !== null && r[k!] !== v;
          throw new Error(`or não suportado: ${expr}`);
        }),
      );
    };
    c["limit"] = (n: number) => {
      teto = n;
      return resposta();
    };
    c["then"] = (ok: (v: unknown) => unknown) => resposta().then(ok);
    return c;
  };
  return { supabaseAdmin: { from: consulta } };
});
vi.mock("../nucleo/motor.server", () => ({
  acordarMotor: async () => {
    banco.toques++;
    return "tocado";
  },
}));
vi.mock("../nucleo/conexoes.server", () => ({
  lerChaveIA: async () => ({ provedor: "elevenlabs", chave: "sk_teste" }),
}));
vi.mock("./banco.server", () => ({
  acharLigacao: async (id: string) => ({ id: `lig_${id}` }),
  encerrarLigacao: async (
    id: string,
    fim: { status: string; resumo: string | null; transcricao: unknown[] },
  ) => {
    banco.encerradas.push({
      id,
      status: fim.status,
      resumo: fim.resumo,
      falas: fim.transcricao.length,
    });
    return { ligacaoId: `lig_${id}`, conversaId: "c" };
  },
  avisarFalhaDaLigacao: async (ligacaoId: string) => {
    banco.avisos.push(ligacaoId);
    return "avisada";
  },
  rearmarDepoisDaLigacao: async () => true,
  passarLigacaoParaEquipe: async (ligacaoId: string) => {
    banco.equipe.push(ligacaoId);
    return true;
  },
}));

const {
  decidirPresa,
  fecharLigacoesPresas,
  INICIADA_MORTA_MS,
  MAX_FECHADAS_POR_CHAMADA,
  POS_CHAMADA_ATRASADO_MS,
} = await import("./presas.server");

const AGORA = Date.parse("2026-11-16T12:00:00.000Z");
const haMin = (m: number) => new Date(AGORA - m * 60_000).toISOString();

beforeEach(() => {
  banco.tabelas = { ligacao_agentes: [{ id_externo: "agent_nina" }] };
  banco.encerradas = [];
  banco.avisos = [];
  banco.equipe = [];
  banco.toques = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("decidirPresa", () => {
  it("fecha como não completada a que falhou e a que acabou sem durar nada", () => {
    expect(decidirPresa({ status: "failed" }, AGORA, haMin(5))?.tipo).toBe("nao_completada");
    const d = decidirPresa(
      { status: "done", metadata: { call_duration_secs: 0 } },
      AGORA,
      haMin(5),
    );
    expect(d).toMatchObject({ tipo: "nao_completada", fim: { motivoFim: "nao_atendida" } });
  });

  it("a que ficou 'initiated' ou 'in-progress' sem durar nada morre só depois da duração máxima mais a folga", () => {
    const c = { status: "initiated", metadata: { call_duration_secs: 0 } };
    const limiteMin = INICIADA_MORTA_MS / 60_000;
    expect(decidirPresa(c, AGORA, haMin(limiteMin + 1))?.tipo).toBe("nao_completada");
    // um agente de 30 min ainda pode estar falando: não fecha antes
    expect(decidirPresa(c, AGORA, haMin(31))).toBeNull();
    const emCurso = { status: "in-progress", metadata: { call_duration_secs: 0 } };
    expect(decidirPresa(emCurso, AGORA, haMin(limiteMin + 1))?.tipo).toBe("nao_completada");
  });

  it("a que durou espera o pós-chamada até o fim mais a folga; depois, lê a conversa inteira", () => {
    const c = { status: "done", metadata: { call_duration_secs: 120 } };
    const folgaMin = POS_CHAMADA_ATRASADO_MS / 60_000;
    expect(decidirPresa(c, AGORA, haMin(2 + folgaMin - 1))).toBeNull();
    expect(decidirPresa(c, AGORA, haMin(2 + folgaMin + 1))).toEqual({ tipo: "ler_inteira" });
  });

  it("a que falou e ficou presa sem terminar, passada a duração máxima, é lida inteira e fechada", () => {
    const c = { status: "in-progress", metadata: { call_duration_secs: 95 } };
    expect(decidirPresa(c, AGORA, haMin(INICIADA_MORTA_MS / 60_000 + 1))).toEqual({
      tipo: "ler_inteira",
    });
  });

  it("não fecha a que está em curso", () => {
    expect(decidirPresa({ status: "in-progress" }, AGORA, haMin(5))).toBeNull();
    expect(decidirPresa({ status: "initiated" }, AGORA, haMin(5))).toBeNull();
  });
});

/** A ElevenLabs falsa: a lista do agente e as conversas sozinhas. */
function elevenFalsa(lista: object[], sozinhas: Record<string, object> = {}) {
  const urls: string[] = [];
  const f = (async (url: string, init: RequestInit) => {
    urls.push(url);
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("sk_teste");
    if (url.includes("?agent_id=")) {
      return new Response(JSON.stringify({ conversations: lista, has_more: false }));
    }
    const id = url.split("/").at(-1)!;
    const corpo = sozinhas[id];
    return corpo ? new Response(JSON.stringify(corpo)) : new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, urls };
}

describe("fecharLigacoesPresas", () => {
  it("num pico, acha a que falhou entre as que estão em curso, numa ida à lista, e pede o aviso", async () => {
    const vivas = [1, 2, 3, 4, 5].map((n) => ({
      status: "em_andamento",
      id_externo: `conv_viva${n}`,
      iniciada_em: haMin(10 - n),
    }));
    // fora de ordem: o código pede a mais antiga primeiro (o desde da lista sai dela)
    banco.tabelas["ligacoes"] = [
      { status: "em_andamento", id_externo: "conv_fila", iniciada_em: haMin(3) },
      ...vivas,
    ];
    const { f, urls } = elevenFalsa([
      ...vivas.map((v) => ({
        conversation_id: v.id_externo,
        status: "in-progress",
        call_duration_secs: 0,
      })),
      { conversation_id: "conv_fila", status: "done", call_duration_secs: 0 },
    ]);
    const r = await fecharLigacoesPresas({ agoraMs: AGORA, fetch: f });
    expect(r).toEqual({ conferidas: 6, fechadas: 1 });
    expect(banco.encerradas).toEqual([
      { id: "conv_fila", status: "nao_completada", resumo: null, falas: 0 },
    ]);
    expect(banco.avisos).toEqual(["lig_conv_fila"]);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/v1/convai/conversations?agent_id=agent_nina&page_size=100");
    const desde = Math.floor(Date.parse(haMin(9)) / 1000) - 60;
    expect(urls[0]).toContain(`call_start_after_unix=${desde}`);
  });

  it("não fecha a concluída nem a em andamento com menos de 2 min, mesmo que a lista diga falha", async () => {
    banco.tabelas["ligacoes"] = [
      { status: "concluida", id_externo: "conv_ja_fechada", iniciada_em: haMin(10) },
      { status: "em_andamento", id_externo: "conv_nova", iniciada_em: haMin(1) },
    ];
    const { f } = elevenFalsa([
      { conversation_id: "conv_ja_fechada", status: "failed" },
      { conversation_id: "conv_nova", status: "failed" },
    ]);
    expect(await fecharLigacoesPresas({ agoraMs: AGORA, fetch: f })).toBe("nenhuma");
    expect(banco.encerradas).toEqual([]);
  });

  it("a que durou e perdeu o pós-chamada fecha com a conversa inteira, e passa para a equipe se a ferramenta foi chamada", async () => {
    banco.tabelas["ligacoes"] = [
      { status: "em_andamento", id_externo: "conv_longa", iniciada_em: haMin(20) },
    ];
    const { f, urls } = elevenFalsa(
      [{ conversation_id: "conv_longa", status: "done", call_duration_secs: 180 }],
      {
        conv_longa: {
          conversation_id: "conv_longa",
          status: "done",
          metadata: { call_duration_secs: 180, termination_reason: "end_call" },
          analysis: { transcript_summary: "Quer saber o preço." },
          transcript: [
            { role: "user", message: "Quero falar com alguém.", time_in_call_secs: 1 },
            {
              role: "agent",
              message: "Já chamo a equipe.",
              time_in_call_secs: 3,
              tool_calls: [{ tool_name: "nina_passar_para_equipe" }],
            },
          ],
        },
      },
    );
    const r = await fecharLigacoesPresas({ agoraMs: AGORA, fetch: f });
    expect(r).toEqual({ conferidas: 1, fechadas: 1 });
    expect(banco.encerradas).toEqual([
      { id: "conv_longa", status: "concluida", resumo: "Quer saber o preço.", falas: 2 },
    ]);
    expect(banco.equipe).toEqual(["lig_conv_longa"]);
    expect(banco.avisos).toEqual([]);
    // a concluída solta a rodada depois da ligação: o worker é acordado com renovar
    expect(banco.toques).toBe(1);
    expect(urls.filter((u) => !u.includes("?agent_id="))).toHaveLength(1);
  });

  it("a que não está na lista é consultada sozinha; a que não deu para ler fica para depois", async () => {
    banco.tabelas["ligacoes"] = [
      { status: "em_andamento", id_externo: "conv_antiga", iniciada_em: haMin(2 * 24 * 60) },
      { status: "em_andamento", id_externo: "conv_sumida", iniciada_em: haMin(10) },
    ];
    const { f } = elevenFalsa([], {
      conv_antiga: { status: "initiated", metadata: { call_duration_secs: 0 } },
    });
    const r = await fecharLigacoesPresas({ agoraMs: AGORA, fetch: f });
    expect(r).toEqual({ conferidas: 2, fechadas: 1 });
    expect(banco.encerradas.map((e) => e.id)).toEqual(["conv_antiga"]);
  });

  it("fora da lista, as consultas sozinhas são sorteadas e limitadas a 5", async () => {
    const abertas = [1, 2, 3, 4, 5].map((n) => ({
      status: "em_andamento",
      id_externo: `conv_aberta${n}`,
      iniciada_em: haMin(20 - n),
    }));
    banco.tabelas["ligacoes"] = [
      ...abertas,
      { status: "em_andamento", id_externo: "conv_falhou", iniciada_em: haMin(10) },
    ];
    const sozinhas: Record<string, object> = { conv_falhou: { status: "failed" } };
    for (const a of abertas)
      sozinhas[a.id_externo] = { status: "in-progress", metadata: { call_duration_secs: 90 } };
    const { f, urls } = elevenFalsa([], sozinhas);
    const r = await fecharLigacoesPresas({
      agoraMs: AGORA,
      fetch: f,
      embaralhar: (xs) => [...xs].reverse(),
    });
    expect(r).toEqual({ conferidas: 6, fechadas: 1 });
    expect(banco.encerradas.map((e) => e.id)).toEqual(["conv_falhou"]);
    expect(urls.filter((u) => !u.includes("?agent_id="))).toHaveLength(5);
  });

  it("sem tempo no prazo da chamada, nenhuma consulta começa", async () => {
    banco.tabelas["ligacoes"] = [
      { status: "em_andamento", id_externo: "conv_x", iniciada_em: haMin(10) },
    ];
    const { f, urls } = elevenFalsa([], { conv_x: { status: "failed" } });
    const r = await fecharLigacoesPresas({ agoraMs: AGORA, fetch: f, fimEm: Date.now() + 1_000 });
    expect(r).toEqual({ conferidas: 1, fechadas: 0 });
    expect(urls).toHaveLength(0);
  });

  it("a conversa que a ElevenLabs não acha mais (404) fecha como não completada só depois da duração máxima, sem aviso", async () => {
    banco.tabelas["ligacoes"] = [
      {
        status: "em_andamento",
        id_externo: "conv_sumiu_velha",
        iniciada_em: haMin(INICIADA_MORTA_MS / 60_000 + 5),
      },
      { status: "em_andamento", id_externo: "conv_sumiu_nova", iniciada_em: haMin(10) },
    ];
    const { f } = elevenFalsa([]);
    const r = await fecharLigacoesPresas({ agoraMs: AGORA, fetch: f });
    expect(r).toEqual({ conferidas: 2, fechadas: 1 });
    expect(banco.encerradas.map((e) => [e.id, e.status])).toEqual([
      ["conv_sumiu_velha", "nao_completada"],
    ]);
    expect(banco.avisos).toEqual([]);
  });

  it("a ligação de saída nunca confirmada (id provisório) fecha depois do teto mais longo (30 min + 2), sem consultar a ElevenLabs, mesmo com o agente mais curto aqui (Sol, PR #26)", async () => {
    banco.tabelas["ligacao_agentes"] = [
      ...(banco.tabelas["ligacao_agentes"] ?? []),
      {
        id: "ag_curto",
        id_externo: "agent_curto",
        nome: "Curto",
        atende: false,
        duracao_max_s: 180,
      },
    ];
    banco.tabelas["ligacoes"] = [
      // 30 min + 2 = 32 min: a de 40 min fecha; a de 15 min espera, mesmo com o agente de 3 min
      // aqui (lá ele pode ter ficado com a duração antiga)
      {
        status: "em_andamento",
        id_externo: "saida-velha",
        iniciada_em: haMin(40),
        agente_id: "ag_curto",
      },
      {
        status: "em_andamento",
        id_externo: "saida-nova",
        iniciada_em: haMin(15),
        agente_id: "ag_curto",
      },
    ];
    const { f, urls } = elevenFalsa([]);
    const r = await fecharLigacoesPresas({ agoraMs: AGORA, fetch: f });
    expect(r).toEqual({ conferidas: 2, fechadas: 1 });
    expect(banco.encerradas.map((e) => [e.id, e.status])).toEqual([
      ["saida-velha", "nao_completada"],
    ]);
    expect(urls).toEqual([]);
    expect(banco.avisos).toEqual([]);
  });

  it("a de saída provisória sem a linha do agente usa a duração máxima da faixa (30 min)", async () => {
    banco.tabelas["ligacoes"] = [
      {
        status: "em_andamento",
        id_externo: "saida-sem-agente",
        iniciada_em: haMin(20),
        agente_id: null,
      },
    ];
    const { f } = elevenFalsa([]);
    const r = await fecharLigacoesPresas({ agoraMs: AGORA, fetch: f });
    expect(r).toEqual({ conferidas: 1, fechadas: 0 });
  });

  it("fecha no máximo MAX_FECHADAS_POR_CHAMADA por chamada; o resto fica para a próxima", async () => {
    banco.tabelas["ligacoes"] = Array.from({ length: 25 }, (_, i) => ({
      status: "em_andamento",
      id_externo: `conv_f${i}`,
      iniciada_em: haMin(10),
    }));
    const { f } = elevenFalsa(
      Array.from({ length: 25 }, (_, i) => ({ conversation_id: `conv_f${i}`, status: "failed" })),
    );
    const r = await fecharLigacoesPresas({ agoraMs: AGORA, fetch: f });
    expect(r).toEqual({ conferidas: 25, fechadas: MAX_FECHADAS_POR_CHAMADA });
  });

  it("sem tempo para fechar no prazo da chamada, não fecha (nem a que a lista já mostrou)", async () => {
    banco.tabelas["ligacoes"] = [
      { status: "em_andamento", id_externo: "conv_y", iniciada_em: haMin(10) },
    ];
    const { f } = elevenFalsa([{ conversation_id: "conv_y", status: "failed" }]);
    const r = await fecharLigacoesPresas({ agoraMs: AGORA, fetch: f, fimEm: Date.now() + 2_000 });
    expect(r).toEqual({ conferidas: 1, fechadas: 0 });
    expect(banco.encerradas).toEqual([]);
  });

  it("a nova tentativa do aviso roda sem ligação presa e cobre as falhas do pós-chamada", async () => {
    banco.tabelas["ligacoes"] = [
      {
        id: "lig_pos",
        id_externo: "conv_pos",
        conversa_id: "c_pos",
        status: "nao_completada",
        direcao: "entrada",
        motivo_fim: "erro",
        aviso_falha_em: null,
        iniciada_em: haMin(6),
        encerrada_em: haMin(3),
      },
      {
        id: "lig_sem_motivo",
        id_externo: "conv_sem_motivo",
        conversa_id: "c_nulo",
        status: "nao_completada",
        direcao: "entrada",
        motivo_fim: null,
        aviso_falha_em: null,
        iniciada_em: haMin(6),
        encerrada_em: haMin(3),
      },
    ];
    // fora da janela de 15 min, já avisada, ou de saída: nenhuma recebe a nova tentativa
    banco.tabelas["ligacoes"]!.push(
      {
        // ligação longa: começou há 40 min e fechou há 3 (a janela conta do fim)
        id: "lig_longa",
        id_externo: "conv_longa_falha",
        conversa_id: "c_longa",
        status: "nao_completada",
        direcao: "entrada",
        motivo_fim: "erro",
        aviso_falha_em: null,
        iniciada_em: haMin(40),
        encerrada_em: haMin(3),
      },
      {
        id: "lig_velha",
        id_externo: "conv_velha",
        conversa_id: "c_velha",
        status: "nao_completada",
        direcao: "entrada",
        motivo_fim: "erro",
        aviso_falha_em: null,
        iniciada_em: haMin(30),
        encerrada_em: haMin(20),
      },
      {
        id: "lig_saida",
        id_externo: "conv_saida",
        conversa_id: "c_saida",
        status: "nao_completada",
        direcao: "saida",
        motivo_fim: "erro",
        aviso_falha_em: null,
        iniciada_em: haMin(6),
        encerrada_em: haMin(3),
      },
      {
        id: "lig_concluida",
        id_externo: "conv_concluida",
        conversa_id: "c_conc",
        status: "concluida",
        direcao: "entrada",
        motivo_fim: "end_call",
        aviso_falha_em: null,
        iniciada_em: haMin(6),
        encerrada_em: haMin(3),
      },
    );
    const f = vi.fn() as unknown as typeof fetch;
    expect(await fecharLigacoesPresas({ agoraMs: AGORA, fetch: f })).toBe("nenhuma");
    expect(banco.avisos.sort()).toEqual(["lig_longa", "lig_pos", "lig_sem_motivo"]);
    expect(f).not.toHaveBeenCalled();
  });

  it("a nova tentativa não avisa a ligação sumida (404) nem a conversa que já teve aviso perto", async () => {
    const recente = haMin(3);
    banco.tabelas["ligacoes"] = [
      {
        id: "lig_sumida",
        id_externo: "conv_sumida",
        conversa_id: "c_a",
        status: "nao_completada",
        direcao: "entrada",
        motivo_fim: "nao_encontrada",
        aviso_falha_em: null,
        iniciada_em: haMin(40),
        encerrada_em: recente,
      },
      {
        id: "lig_avisada",
        id_externo: "conv_avisada",
        conversa_id: "c_b",
        status: "nao_completada",
        direcao: "entrada",
        motivo_fim: "nao_atendida",
        aviso_falha_em: new Date(AGORA - 8 * 60_000).toISOString(),
        iniciada_em: haMin(9),
        encerrada_em: recente,
      },
      {
        id: "lig_segunda",
        id_externo: "conv_segunda",
        conversa_id: "c_b",
        status: "nao_completada",
        direcao: "entrada",
        motivo_fim: "nao_atendida",
        aviso_falha_em: null,
        iniciada_em: haMin(5),
        encerrada_em: recente,
      },
    ];
    const f = vi.fn() as unknown as typeof fetch;
    await fecharLigacoesPresas({ agoraMs: AGORA, fetch: f });
    expect(banco.avisos).toEqual([]);
  });

  it("sem ligação presa, nem vai à ElevenLabs", async () => {
    banco.tabelas["ligacoes"] = [];
    const f = vi.fn() as unknown as typeof fetch;
    expect(await fecharLigacoesPresas({ agoraMs: AGORA, fetch: f })).toBe("nenhuma");
    expect(f).not.toHaveBeenCalled();
  });
});
