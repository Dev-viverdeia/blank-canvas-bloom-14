import { describe, expect, it } from "vitest";

import {
  avaliarElegibilidade,
  lerElegibilidade,
  limiteLigaChamadas,
  reprovadaPelaMeta,
} from "./elegibilidade";
import { msgLigacoes } from "./mensagens";
import { ITENS_ELEGIBILIDADE, type RequisitosLigacoes } from "./tipos";

const TUDO: RequisitosLigacoes = {
  conexaoMeta: true,
  chaveVoz: true,
  vozEscolhida: true,
  enderecoPublicado: true,
};
const AGORA = new Date("2026-11-17T15:00:00.000Z");
const NUMERO_OK = { ok: true as const, limite: "TIER_2K", saude: "AVAILABLE" };

function estados(a: ReturnType<typeof avaliarElegibilidade>) {
  return Object.fromEntries(a.elegibilidade.itens.map((i) => [i.id, i.estado]));
}

describe("avaliarElegibilidade", () => {
  it("tudo conferido e ok: elegível, sem falha, os 9 itens na ordem e com o dono", () => {
    const a = avaliarElegibilidade(
      { requisitos: TUDO, numero: NUMERO_OK, sip: null, agentes: null },
      AGORA,
    );
    expect(a.falha).toBeNull();
    expect(a.elegibilidade).toMatchObject({
      versao: 1,
      elegivel: true,
      limiteMeta: "TIER_2K",
      conferidaEm: AGORA.toISOString(),
    });
    expect(a.elegibilidade.itens.map((i) => i.id)).toEqual([...ITENS_ELEGIBILIDADE]);
    expect(a.elegibilidade.itens.find((i) => i.id === "meta_limite")).toEqual({
      id: "meta_limite",
      dono: "meta",
      estado: "ok",
      valor: "TIER_2K",
    });
    expect(a.elegibilidade.itens.find((i) => i.id === "chave_agentes")?.dono).toBe("elevenlabs");
    expect(a.elegibilidade.itens.find((i) => i.id === "voz")?.dono).toBe("nina");
  });

  it("número de 250: meta_limite falta com o tier, e a falha é meta_limite com a lista", () => {
    const a = avaliarElegibilidade(
      { requisitos: TUDO, numero: { ...NUMERO_OK, limite: "TIER_250" }, sip: null, agentes: null },
      AGORA,
    );
    expect(estados(a)["meta_limite"]).toBe("falta");
    expect(a.elegibilidade.itens.find((i) => i.id === "meta_limite")?.valor).toBe("TIER_250");
    expect(a.elegibilidade.elegivel).toBe(false);
    expect(a.falha).toMatchObject({ ok: false, erro: "meta_limite" });
    expect(a.falha?.elegibilidade).toEqual(a.elegibilidade);
  });

  it.each(["TIER_50", "TIER_250", "TIER_1K"])("%s não liga as chamadas", (t) => {
    expect(limiteLigaChamadas(t)).toBe(false);
  });

  // um tier novo ou desconhecido passa: quem decide é a Meta, no ligar do SIP, antes da ElevenLabs
  it.each(["TIER_2K", "TIER_10K", "TIER_100K", "TIER_UNLIMITED", "TIER_NOT_SET", "TIER_5K"])(
    "%s não reprova",
    (t) => {
      expect(limiteLigaChamadas(t)).toBe(true);
    },
  );

  it("sem tier (número de teste da Meta): ok, sem valor", () => {
    const a = avaliarElegibilidade(
      { requisitos: TUDO, numero: { ...NUMERO_OK, limite: null }, sip: null, agentes: null },
      AGORA,
    );
    expect(a.elegibilidade.itens.find((i) => i.id === "meta_limite")).toEqual({
      id: "meta_limite",
      dono: "meta",
      estado: "ok",
    });
    expect(a.falha).toBeNull();
  });

  it("número bloqueado: meta_numero falta com BLOCKED, a falha é meta_numero_bloqueado", () => {
    const a = avaliarElegibilidade(
      { requisitos: TUDO, numero: { ...NUMERO_OK, saude: "BLOCKED" }, sip: null, agentes: null },
      AGORA,
    );
    expect(a.elegibilidade.itens.find((i) => i.id === "meta_numero")).toMatchObject({
      estado: "falta",
      valor: "BLOCKED",
      erro: "meta_numero_bloqueado",
    });
    expect(a.falha?.erro).toBe("meta_numero_bloqueado");
  });

  it("LIMITED não reprova", () => {
    const a = avaliarElegibilidade(
      { requisitos: TUDO, numero: { ...NUMERO_OK, saude: "LIMITED" }, sip: null, agentes: null },
      AGORA,
    );
    expect(a.falha).toBeNull();
  });

  it("token recusado: meta_token falta, o resto da Meta não conferido, a ElevenLabs conferida", () => {
    const a = avaliarElegibilidade(
      { requisitos: TUDO, numero: msgLigacoes.metaTokenInvalido(), agentes: null },
      AGORA,
    );
    expect(estados(a)).toMatchObject({
      meta_token: "falta",
      meta_limite: "nao_conferido",
      meta_numero: "nao_conferido",
      meta_sip_livre: "nao_conferido",
      chave_agentes: "ok",
    });
    expect(a.falha?.erro).toBe("meta_token_invalido");
  });

  it("a Meta fora do ar: falhou (tentar de novo), não falta", () => {
    const a = avaliarElegibilidade(
      { requisitos: TUDO, numero: msgLigacoes.metaFora(), agentes: msgLigacoes.elevenTempo() },
      AGORA,
    );
    expect(estados(a)["meta_token"]).toBe("falhou");
    expect(estados(a)["chave_agentes"]).toBe("falhou");
    expect(a.falha?.erro).toBe("provedor_fora");
  });

  it("SIP em uso e chave sem agentes: os dois faltam, a falha é a do primeiro na ordem", () => {
    const a = avaliarElegibilidade(
      {
        requisitos: TUDO,
        numero: NUMERO_OK,
        sip: msgLigacoes.metaSipEmUso(),
        agentes: msgLigacoes.chaveSemAcessoAgentes(),
      },
      AGORA,
    );
    expect(estados(a)["meta_sip_livre"]).toBe("falta");
    expect(estados(a)["chave_agentes"]).toBe("falta");
    expect(a.falha?.erro).toBe("meta_sip_em_uso");
  });

  it("requisito da Nina faltando: a falha é a dele, e o que não deu para conferir fica nao_conferido", () => {
    const a = avaliarElegibilidade(
      { requisitos: { ...TUDO, conexaoMeta: false, vozEscolhida: false }, agentes: null },
      AGORA,
    );
    expect(estados(a)).toMatchObject({
      conexao_meta: "falta",
      chave_voz: "ok",
      voz: "falta",
      endereco: "ok",
      meta_token: "nao_conferido",
      chave_agentes: "ok",
    });
    expect(a.falha?.erro).toBe("sem_conexao_meta");
  });

  it("sem nenhum item faltando mas algo não conferido: não elegível, falha nao_elegivel", () => {
    const a = avaliarElegibilidade({ requisitos: TUDO, numero: NUMERO_OK, agentes: null }, AGORA);
    expect(estados(a)["meta_sip_livre"]).toBe("nao_conferido");
    expect(a.falha?.erro).toBe("nao_elegivel");
  });
});

describe("reprovadaPelaMeta", () => {
  const aprovada = avaliarElegibilidade(
    { requisitos: TUDO, numero: NUMERO_OK, sip: null, agentes: null },
    AGORA,
  ).elegibilidade;

  it("138015 no fim: meta_limite passa a faltar, mantendo o tier lido", () => {
    const e = reprovadaPelaMeta(aprovada, msgLigacoes.metaLimite(), AGORA);
    expect(e?.elegivel).toBe(false);
    expect(e?.itens.find((i) => i.id === "meta_limite")).toMatchObject({
      estado: "falta",
      valor: "TIER_2K",
      erro: "meta_limite",
    });
  });

  it("138014 no fim: meta_numero passa a faltar, com o erro da pausa (não o do bloqueio)", () => {
    const e = reprovadaPelaMeta(aprovada, msgLigacoes.metaPausada(), AGORA);
    expect(e?.itens.find((i) => i.id === "meta_numero")).toMatchObject({
      estado: "falta",
      erro: "meta_pausada",
    });
  });

  it("outras falhas não mexem na verificação", () => {
    expect(reprovadaPelaMeta(aprovada, msgLigacoes.metaRecusou(), AGORA)).toBeNull();
    expect(reprovadaPelaMeta(aprovada, msgLigacoes.metaRequisitoTecnico(), AGORA)).toBeNull();
    expect(reprovadaPelaMeta(null, msgLigacoes.metaLimite(), AGORA)).toBeNull();
  });
});

describe("lerElegibilidade", () => {
  it("lê de volta o que foi gravado", () => {
    const a = avaliarElegibilidade(
      { requisitos: TUDO, numero: { ...NUMERO_OK, limite: "TIER_250" }, sip: null, agentes: null },
      AGORA,
    ).elegibilidade;
    expect(lerElegibilidade(JSON.parse(JSON.stringify(a)))).toEqual(a);
  });

  it.each([
    null,
    "x",
    [],
    { versao: 2, elegivel: true, limiteMeta: null, itens: [], conferidaEm: "" },
    { versao: 1, elegivel: "sim", limiteMeta: null, itens: [], conferidaEm: "" },
    { versao: 1, elegivel: true, limiteMeta: 3, itens: [], conferidaEm: "" },
    {
      versao: 1,
      elegivel: true,
      limiteMeta: null,
      itens: [{ id: "outro", estado: "ok" }],
      conferidaEm: "",
    },
    {
      versao: 1,
      elegivel: true,
      limiteMeta: null,
      itens: [{ id: "voz", estado: "talvez" }],
      conferidaEm: "",
    },
  ])("forma estranha vira null: %j", (v) => {
    expect(lerElegibilidade(v)).toBeNull();
  });
});
