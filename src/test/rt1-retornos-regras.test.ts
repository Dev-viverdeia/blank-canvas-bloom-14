import { describe, expect, it } from "vitest";

import { linhaDoTempo } from "@/features/plataforma/chat/Conversa";
import {
  aberto,
  ancorar,
  avisoDoCancelar,
  cartaoDoRetorno,
  desde,
  diaEHora,
  faixaDoRetorno,
  lembreteVisivel,
  linhasDosRetornos,
  quandoMarcado,
  quandoPassado,
  referencia,
  retornoVisivel,
  textoDoMotivo,
  LEMBRETE_NA_FAIXA,
  type CondicoesLembrete,
} from "@/features/plataforma/comum/retornos";
import { diaComSemana, diaRelativo } from "@/features/plataforma/comum/tempo";
import type { MensagemDados, RetornoDados } from "@/features/plataforma/dados/tipos";

import { AGORA_TESTE, emBrasilia, lembreteDeTeste, retornoDeTeste } from "./retornos-fabrica";

// Retornos da Nina, as regras puras do Chat (mockup, quadros 1 a 16;
// 3.4): os formatadores de dia e hora de Brasília, a visibilidade do retorno
// e do lembrete, as linhas do histórico com o texto exato, a âncora na rodada e os avisos do cancelar.

const AGORA = AGORA_TESTE; // qua 18/11/2026 16:10 (Brasília)
const em = (data: string, hora: string) => emBrasilia(data, hora);
const nome = (id: string) =>
  id === "eu" ? "Você" : id === "marina" ? "Marina" : "Alguém da equipe";

describe("dia e hora em Brasília", () => {
  it("diaRelativo: hoje, amanhã, ontem e o dia da semana", () => {
    expect(diaRelativo(em("2026-11-18", "09:00"), AGORA)).toBe("hoje");
    expect(diaRelativo(em("2026-11-19", "09:00"), AGORA)).toBe("amanhã");
    expect(diaRelativo(em("2026-11-17", "23:00"), AGORA)).toBe("ontem");
    expect(diaRelativo(em("2026-11-20", "14:00"), AGORA)).toBe("sex, 20/11");
  });

  it("diaComSemana: minúsculo e abreviado; o ano só quando é outro que o da referência", () => {
    expect(diaComSemana(em("2026-11-19", "09:00"), AGORA)).toBe("qui, 19/11");
    expect(diaComSemana(em("2027-01-05", "09:00"), AGORA)).toBe("ter, 05/01/2027");
    expect(diaComSemana(em("2026-11-14", "09:00"), AGORA)).toBe("sáb, 14/11");
    expect(diaComSemana(em("2026-11-15", "09:00"), AGORA)).toBe("dom, 15/11");
  });

  it("quandoMarcado: a faixa e o cartão ('amanhã, 09:00', 'Amanhã, 09:00', 'sex, 20/11, 14:00')", () => {
    expect(quandoMarcado(em("2026-11-19", "09:00"), AGORA)).toBe("amanhã, 09:00");
    expect(quandoMarcado(em("2026-11-19", "09:00"), AGORA, true)).toBe("Amanhã, 09:00");
    expect(quandoMarcado(em("2026-11-20", "14:00"), AGORA)).toBe("sex, 20/11, 14:00");
    expect(quandoMarcado(em("2026-11-18", "09:00"), AGORA)).toBe("hoje, 09:00");
    expect(quandoMarcado(em("2026-11-17", "23:00"), AGORA)).toBe("ontem, 23:00");
  });

  it("caso 11, virada de dia: 'amanhã' vira 'hoje' à meia-noite, no relógio de Brasília", () => {
    const vence = em("2026-11-19", "09:00");
    expect(quandoMarcado(vence, Date.parse("2026-11-18T23:50:00-03:00"))).toBe("amanhã, 09:00");
    expect(quandoMarcado(vence, Date.parse("2026-11-19T00:10:00-03:00"))).toBe("hoje, 09:00");
  });

  it("caso 11: 02:30Z já é 23:30 de quarta em Brasília (UTC e Brasília em dias diferentes)", () => {
    const agora = Date.parse("2026-11-19T02:30:00Z");
    expect(quandoMarcado(em("2026-11-19", "09:00"), agora)).toBe("amanhã, 09:00");
    expect(quandoPassado(em("2026-11-18", "16:09"), agora)).toBe("hoje às 16:09");
  });

  it("diaEHora: sempre o dia da semana e a data ('qui, 19/11, às 09:00')", () => {
    expect(diaEHora(em("2026-11-19", "09:00"), em("2026-11-18", "16:09"))).toBe(
      "qui, 19/11, às 09:00",
    );
    expect(diaEHora(em("2026-11-18", "14:00"), em("2026-11-18", "16:09"))).toBe(
      "qua, 18/11, às 14:00",
    );
    expect(diaEHora(em("2027-01-05", "09:00"), em("2026-12-30", "16:09"))).toBe(
      "ter, 05/01/2027, às 09:00",
    );
  });

  it("quandoPassado: 'hoje às 16:09', 'ontem às 18:30' e a data", () => {
    expect(quandoPassado(em("2026-11-18", "16:09"), AGORA)).toBe("hoje às 16:09");
    expect(quandoPassado(em("2026-11-17", "18:30"), AGORA)).toBe("ontem às 18:30");
    expect(quandoPassado(em("2026-11-14", "16:09"), AGORA)).toBe("sáb, 14/11, às 16:09");
  });

  it("desde: 'desde as 09:00', 'desde ontem às 18:30' e a data", () => {
    expect(desde(em("2026-11-18", "09:00"), AGORA)).toBe("desde as 09:00");
    expect(desde(em("2026-11-17", "18:30"), AGORA)).toBe("desde ontem às 18:30");
    expect(desde(em("2026-11-14", "18:30"), AGORA)).toBe("desde sáb, 14/11, às 18:30");
  });

  it("referencia: 'das 09:00' no dia do fato; com o dia quando a hora marcada é de outro dia", () => {
    expect(referencia(em("2026-11-19", "09:00"), em("2026-11-19", "09:00"))).toBe("das 09:00");
    expect(referencia(em("2026-11-18", "23:00"), em("2026-11-19", "02:00"))).toBe(
      "de qua, 18/11, às 23:00",
    );
  });
});

describe("aberto e STATUS_FINAIS", () => {
  it("os 4 finais não são abertos; pendente, em_rodada, saindo e o desconhecido são", () => {
    for (const status of ["enviado", "dispensado", "cancelado", "nao_enviado"] as const) {
      expect(aberto({ status })).toBe(false);
    }
    for (const status of ["pendente", "em_rodada", "saindo"] as const)
      expect(aberto({ status })).toBe(true);
    // um estado que o banco venha a ganhar: conta como aberto (só `pendente` mostra faixa)
    expect(aberto({ status: "estado_novo" as RetornoDados["status"] })).toBe(true);
  });
});

describe("retornoVisivel: a faixa e o cartão", () => {
  it("só o retorno pendente, antes do expira_em", () => {
    const r = retornoDeTeste();
    expect(retornoVisivel([r], AGORA)).toBe(r);
    expect(retornoVisivel([], AGORA)).toBeNull();
  });

  it.each(["em_rodada", "saindo", "enviado", "dispensado", "cancelado", "nao_enviado"] as const)(
    "o estado %s esconde a faixa",
    (status) => {
      expect(retornoVisivel([retornoDeTeste({ status })], AGORA)).toBeNull();
    },
  );

  it("passou do expira_em: esconde (o retorno que ninguém fechou não diz 'ontem, 09:00' com Cancelar)", () => {
    const r = retornoDeTeste();
    expect(retornoVisivel([r], Date.parse(r.expira_em) - 1)).toBe(r);
    expect(retornoVisivel([r], Date.parse(r.expira_em))).toBeNull();
  });

  it("o retorno atrasado (depois da hora, antes do expira_em) continua visível (caso 12)", () => {
    const r = retornoDeTeste();
    expect(retornoVisivel([r], Date.parse("2026-11-19T10:30:00-03:00"))).toBe(r);
  });

  it("o lembrete nunca é o retorno visível", () => {
    expect(retornoVisivel([lembreteDeTeste()], AGORA)).toBeNull();
  });

  it("dois pendentes (corrida): vale o de marcado_em mais recente", () => {
    const velho = retornoDeTeste({ marcado_em: em("2026-11-18", "10:00") });
    const novo = retornoDeTeste({ marcado_em: em("2026-11-18", "16:09") });
    expect(retornoVisivel([novo, velho], AGORA)).toBe(novo);
    expect(retornoVisivel([velho, novo], AGORA)).toBe(novo);
  });
});

describe("lembreteVisivel: o lembrete só vale o cartão do perfil", () => {
  const ok = (extra: Partial<CondicoesLembrete> = {}): CondicoesLembrete => ({
    ajuste: { ligado: true, horas: 3 },
    comNina: true,
    etapaAberta: true,
    podeEnviar: true,
    ultimaDoLeadEm: em("2026-11-18", "08:50"),
    devolvidaEm: null,
    agora: AGORA,
    ...extra,
  });

  it("com todas as condições, devolve o lembrete pendente", () => {
    const l = lembreteDeTeste();
    expect(lembreteVisivel([l], ok())).toBe(l);
  });

  it("sem condição nenhuma falhando, e com o lead sem nunca ter escrito (nulo), vale", () => {
    const l = lembreteDeTeste();
    expect(lembreteVisivel([l], ok({ ultimaDoLeadEm: null }))).toBe(l);
  });

  it.each<[string, Partial<CondicoesLembrete>]>([
    ["sem o ajuste lido", { ajuste: undefined }],
    ["ajuste desligado", { ajuste: { ligado: false, horas: 3 } }],
    ["conversa fora da Nina", { comNina: false }],
    ["lead em Ganho ou Perdido", { etapaAberta: false }],
    ["WhatsApp que não envia (desconectado ou janela fechada)", { podeEnviar: false }],
    ["lead que escreveu depois de armado", { ultimaDoLeadEm: em("2026-11-18", "11:30") }],
    ["passou do expira_em", { agora: Date.parse("2026-11-18T20:00:00-03:00") }],
  ])("esconde: %s", (_caso, extra) => {
    expect(lembreteVisivel([lembreteDeTeste()], ok(extra))).toBeNull();
  });

  it("devolvida à Nina depois de armado esconde (A5); devolvida antes de armado, mostra", () => {
    const l = lembreteDeTeste(); // marcado_em 09:00
    expect(lembreteVisivel([l], ok({ devolvidaEm: em("2026-11-18", "10:00") }))).toBeNull();
    expect(lembreteVisivel([l], ok({ devolvidaEm: em("2026-11-18", "08:00") }))).toBe(l);
    expect(lembreteVisivel([l], ok({ devolvidaEm: em("2026-11-18", "09:00") }))).toBe(l);
    expect(lembreteVisivel([l], ok({ devolvidaEm: null }))).toBe(l);
  });

  it("o retorno ganha: com retorno visível, nenhum lembrete", () => {
    expect(lembreteVisivel([lembreteDeTeste(), retornoDeTeste()], ok())).toBeNull();
  });

  it("só o pendente conta", () => {
    expect(lembreteVisivel([lembreteDeTeste({ status: "enviado" })], ok())).toBeNull();
  });
});

describe("faixaDoRetorno: o conteúdo da faixa (quadros 1, 9 e 15)", () => {
  it("com a Nina: o título, o motivo na mesma linha e os nomes do link", () => {
    const f = faixaDoRetorno({
      retorno: retornoDeTeste({ id: "r1" }),
      comNina: true,
      agora: AGORA,
    });
    expect(f).not.toBeNull();
    expect(f!.id).toBe("r1");
    expect(f!.forte).toBe("Retorno marcado para amanhã, 09:00");
    expect(f!.motivo).toBe(
      "Retomar a proposta do plano anual, depois da conversa dela com o sócio",
    );
    expect(f!.nota).toBeNull();
    expect(f!.frase).toBe(
      "Retorno marcado para amanhã, 09:00 · Retomar a proposta do plano anual, depois da conversa dela com o sócio",
    );
    expect(f!.rotuloCancelar).toBe("Cancelar o retorno de amanhã, 09:00");
    expect(f!.rotuloCancelando).toBe("Cancelando o retorno de amanhã, 09:00");
  });

  it("com outra pessoa (quadro 9): a nota no lugar do motivo", () => {
    const f = faixaDoRetorno({ retorno: retornoDeTeste(), comNina: false, agora: AGORA })!;
    expect(f.motivo).toBeNull();
    expect(f.nota).toBe("A Nina só envia se a conversa voltar para ela antes da hora.");
    expect(f.frase).toBe(
      "Retorno marcado para amanhã, 09:00 · A Nina só envia se a conversa voltar para ela antes da hora.",
    );
  });

  it("sem motivo gravado: só o título", () => {
    const f = faixaDoRetorno({
      retorno: retornoDeTeste({ motivo: null }),
      comNina: true,
      agora: AGORA,
    })!;
    expect(f.motivo).toBeNull();
    expect(f.frase).toBe("Retorno marcado para amanhã, 09:00");
  });

  it("sem retorno visível, nenhuma faixa (quadro 14); e o lembrete nunca tem faixa no Chat", () => {
    expect(faixaDoRetorno({ retorno: null, comNina: true, agora: AGORA })).toBeNull();
    expect(LEMBRETE_NA_FAIXA).toBe(false);
  });

  it("o retorno atrasado continua dizendo a hora marcada (hoje, 09:00)", () => {
    const f = faixaDoRetorno({
      retorno: retornoDeTeste(),
      comNina: true,
      agora: Date.parse("2026-11-19T09:20:00-03:00"),
    })!;
    expect(f.forte).toBe("Retorno marcado para hoje, 09:00");
  });
});

describe("cartaoDoRetorno: o que a T8 desenha no perfil (quadros 17 e 18)", () => {
  it("retorno (quadro 17)", () => {
    const c = cartaoDoRetorno({
      retorno: retornoDeTeste({ id: "r1" }),
      lembrete: null,
      comNina: true,
      agora: AGORA,
    });
    expect(c).toEqual({
      tipo: "retorno",
      id: "r1",
      titulo: "Retorno marcado",
      quem: "pela Nina, hoje às 16:09",
      sub: null,
      quando: "Amanhã, 09:00",
      texto: "Retomar a proposta do plano anual, depois da conversa dela com o sócio",
      nota: null,
      botao: "Cancelar retorno",
    });
  });

  it("retorno fora da Nina: a nota", () => {
    const c = cartaoDoRetorno({
      retorno: retornoDeTeste(),
      lembrete: null,
      comNina: false,
      agora: AGORA,
    });
    expect(c?.nota).toBe("A Nina só envia se a conversa voltar para ela antes da hora.");
  });

  it("lembrete (quadro 18)", () => {
    const c = cartaoDoRetorno({
      retorno: null,
      lembrete: lembreteDeTeste({ id: "l1" }),
      comNina: true,
      agora: Date.parse("2026-11-18T10:00:00-03:00"),
    });
    expect(c).toEqual({
      tipo: "lembrete",
      id: "l1",
      titulo: "Lembrete automático",
      quem: null,
      sub: "se o lead não responder",
      quando: "Hoje, 12:00",
      texto: "A Nina espera a resposta do lead desde as 09:00.",
      nota: null,
      botao: "Cancelar lembrete",
    });
  });

  it("nada, nenhum cartão (quadro 19); o retorno ganha do lembrete", () => {
    expect(
      cartaoDoRetorno({ retorno: null, lembrete: null, comNina: true, agora: AGORA }),
    ).toBeNull();
    expect(
      cartaoDoRetorno({
        retorno: retornoDeTeste(),
        lembrete: lembreteDeTeste(),
        comNina: true,
        agora: AGORA,
      })?.tipo,
    ).toBe("retorno");
  });
});

describe("avisoDoCancelar: os textos do quadro 7, 12 e 13", () => {
  it("deu certo (some, tom ok)", () => {
    expect(avisoDoCancelar("retorno", { ok: true })).toEqual({
      texto: "Retorno cancelado. A Nina não vai chamar o lead.",
      tom: "ok",
      some: true,
    });
    expect(avisoDoCancelar("lembrete", { ok: true })).toEqual({
      texto: "Lembrete cancelado. A Nina não vai mandar o lembrete.",
      tom: "ok",
      some: true,
    });
  });

  it.each(["retorno_nao_pendente", "nao_encontrado"] as const)(
    "já saiu (%s): some, tom erro",
    (erro) => {
      expect(avisoDoCancelar("retorno", { ok: false, erro })).toEqual({
        texto: "Esse retorno já saiu ou já foi cancelado.",
        tom: "erro",
        some: true,
      });
      expect(avisoDoCancelar("lembrete", { ok: false, erro }).texto).toBe(
        "Esse lembrete já saiu ou já foi cancelado.",
      );
    },
  );

  it.each(["sem_acesso", "sem_permissao"] as const)(
    "%s: o aviso de acesso de hoje, a faixa fica",
    (erro) => {
      expect(avisoDoCancelar("retorno", { ok: false, erro })).toEqual({
        texto: "Sua conta não tem mais acesso a isto. Peça ao admin para conferir o seu convite.",
        tom: "erro",
        some: false,
      });
    },
  );

  it.each(["falha", "limite_tamanho"] as const)(
    "qualquer outro (%s): tente de novo, a faixa fica",
    (erro) => {
      expect(avisoDoCancelar("retorno", { ok: false, erro })).toEqual({
        texto: "Não deu para cancelar agora. Tente de novo.",
        tom: "erro",
        some: false,
      });
    },
  );
});

describe("os 6 motivos de 'não enviado'", () => {
  it.each([
    ["com_equipe", "a conversa estava com a equipe"],
    ["fora_24h", "passaram 24 h da última mensagem do lead"],
    ["desconectado", "o WhatsApp estava desconectado"],
    ["passou_do_prazo", "passou mais de 3 h da hora marcada"],
    ["envio_recusado", "o WhatsApp recusou o envio"],
    ["nina_falhou", "a Nina não conseguiu responder"],
  ])("%s", (motivo, texto) => {
    expect(textoDoMotivo(motivo)).toBe(texto);
  });

  it("nulo ou desconhecido: nenhum texto inventado", () => {
    expect(textoDoMotivo(null)).toBeNull();
    expect(textoDoMotivo("motivo_novo")).toBeNull();
  });
});

describe("linhasDosRetornos: as linhas do histórico (quadros 1 a 10)", () => {
  const una = (rs: Parameters<typeof linhasDosRetornos>[0]) => linhasDosRetornos(rs, nome);
  const texto = (l: { antes: string; forte: string | null }) => `${l.antes}${l.forte ?? ""}`;

  it("quadro 1: 'A Nina marcou um retorno para qui, 19/11, às 09:00', na hora do marcado_em, depois da rodada de origem", () => {
    const [l, ...resto] = una([retornoDeTeste({ id: "r1", rodada_origem_id: "rod-1" })]);
    expect(resto).toEqual([]);
    expect(l).toEqual({
      id: "r1:inicio",
      momento: em("2026-11-18", "16:09"),
      antes: "A Nina marcou um retorno para ",
      forte: "qui, 19/11, às 09:00",
      tom: "normal",
      ancora: { rodadaId: "rod-1", lado: "depois" },
    });
  });

  it("sem rodada de origem, sem âncora", () => {
    const [l] = una([retornoDeTeste({ rodada_origem_id: null })]);
    expect(l?.ancora).toBeNull();
  });

  it("quadro 5: a remarcação diz 'remarcou'; o substituído fica com a linha de marcação e sem linha de fim", () => {
    const velho = retornoDeTeste({
      id: "velho",
      status: "cancelado",
      fechado_por_rodada: "rod-2",
      resolvido_em: em("2026-11-18", "16:20"),
    });
    const novo = retornoDeTeste({
      id: "novo",
      substitui_id: "velho",
      vence_em: em("2026-11-20", "14:00"),
      marcado_em: em("2026-11-18", "16:20"),
      rodada_origem_id: "rod-2",
    });
    const ls = una([velho, novo]);
    expect(ls.map((l) => l.id)).toEqual(["velho:inicio", "novo:inicio"]);
    expect(texto(ls[0]!)).toBe("A Nina marcou um retorno para qui, 19/11, às 09:00");
    expect(texto(ls[1]!)).toBe("A Nina remarcou o retorno para sex, 20/11, às 14:00");
  });

  it("quadro 6: a Nina cancelou (depois da rodada que cancelou), sem motivo anotado", () => {
    const ls = una([
      retornoDeTeste({
        id: "r1",
        vence_em: em("2026-11-20", "14:00"),
        status: "cancelado",
        fechado_por_rodada: "rod-9",
        resolvido_em: em("2026-11-18", "17:40"),
      }),
    ]);
    const fim = ls.find((l) => l.id === "r1:fim")!;
    expect(texto(fim)).toBe("A Nina cancelou o retorno de sex, 20/11, às 14:00");
    expect(fim.momento).toBe(em("2026-11-18", "17:40"));
    expect(fim.tom).toBe("normal");
    expect(fim.ancora).toEqual({ rodadaId: "rod-9", lado: "depois" });
  });

  it("a Nina cancelou com o porquê anotado (F2): ': ' e o porquê, sem o ponto final", () => {
    const [, fim] = una([
      retornoDeTeste({
        status: "cancelado",
        fechado_por_rodada: "rod-9",
        resolvido_em: em("2026-11-18", "17:40"),
        nota_fim: "o lead já fechou pelo site.",
      }),
    ]);
    expect(texto(fim!)).toBe(
      "A Nina cancelou o retorno de qui, 19/11, às 09:00: o lead já fechou pelo site",
    );
  });

  it("quadro 7: a equipe cancelou ('Você', o nome ou 'Alguém da equipe'), sem âncora", () => {
    const cancelado = (por: string | null) =>
      retornoDeTeste({
        status: "cancelado",
        cancelado_por: por,
        resolvido_em: em("2026-11-18", "17:02"),
      });
    const eu = una([cancelado("eu")])[1]!;
    expect(texto(eu)).toBe("Você cancelou o retorno de qui, 19/11, às 09:00");
    expect(eu.ancora).toBeNull();
    expect(eu.momento).toBe(em("2026-11-18", "17:02"));
    expect(texto(una([cancelado("marina")])[1]!)).toBe(
      "Marina cancelou o retorno de qui, 19/11, às 09:00",
    );
    expect(texto(una([cancelado("apagado")])[1]!)).toBe(
      "Alguém da equipe cancelou o retorno de qui, 19/11, às 09:00",
    );
  });

  it("I5: cancelado sem membro e sem rodada (o membro foi apagado): 'A equipe cancelou'", () => {
    const [, fim] = una([
      retornoDeTeste({
        status: "cancelado",
        cancelado_por: null,
        fechado_por_rodada: null,
        resolvido_em: em("2026-11-18", "17:02"),
      }),
    ]);
    expect(texto(fim!)).toBe("A equipe cancelou o retorno de qui, 19/11, às 09:00");
  });

  it("quadros 2 e 13: enviado, antes da rodada que escreveu, na hora do enviado_em", () => {
    const [, fim] = una([
      retornoDeTeste({
        status: "enviado",
        rodada_id: "rod-7",
        enviado_em: em("2026-11-19", "09:00"),
        resolvido_em: em("2026-11-19", "09:00"),
      }),
    ]);
    expect(fim).toEqual({
      id: expect.stringMatching(/:fim$/),
      momento: em("2026-11-19", "09:00"),
      antes: "Retorno combinado: a Nina voltou a falar com o lead",
      forte: null,
      tom: "normal",
      ancora: { rodadaId: "rod-7", lado: "antes" },
    });
  });

  it("quadro 8 (F2): dispensado com o porquê da Nina", () => {
    const [, fim] = una([
      retornoDeTeste({
        status: "dispensado",
        vence_em: em("2026-11-19", "09:00"),
        resolvido_em: em("2026-11-19", "09:00"),
        nota_fim: "o lead já fechou pelo site",
      }),
    ]);
    expect(texto(fim!)).toBe("A Nina dispensou o retorno das 09:00: o lead já fechou pelo site");
    expect(fim!.tom).toBe("normal");
    expect(fim!.ancora).toBeNull();
  });

  it("quadro 8 (F2): dispensado sem porquê anotado", () => {
    const [, fim] = una([
      retornoDeTeste({
        status: "dispensado",
        resolvido_em: em("2026-11-19", "09:00"),
        nota_fim: "  ",
      }),
    ]);
    expect(texto(fim!)).toBe("A Nina releu a conversa e não mandou o retorno das 09:00");
  });

  it.each([
    ["com_equipe", "Retorno das 09:00 não enviado: a conversa estava com a equipe"],
    ["fora_24h", "Retorno das 09:00 não enviado: passaram 24 h da última mensagem do lead"],
    ["desconectado", "Retorno das 09:00 não enviado: o WhatsApp estava desconectado"],
    ["passou_do_prazo", "Retorno das 09:00 não enviado: passou mais de 3 h da hora marcada"],
    ["envio_recusado", "Retorno das 09:00 não enviado: o WhatsApp recusou o envio"],
    ["nina_falhou", "Retorno das 09:00 não enviado: a Nina não conseguiu responder"],
  ])("quadro 10: não enviado, %s, em vermelho", (motivo, frase) => {
    const [, fim] = una([
      retornoDeTeste({
        status: "nao_enviado",
        nao_enviado_motivo: motivo,
        rodada_id: "rod-3",
        resolvido_em: em("2026-11-19", "09:00"),
      }),
    ]);
    expect(texto(fim!)).toBe(frase);
    expect(fim!.tom).toBe("falha");
    expect(fim!.momento).toBe(em("2026-11-19", "09:00"));
    // só o envio recusado fica depois da bolha que falhou
    expect(fim!.ancora).toEqual(
      motivo === "envio_recusado" ? { rodadaId: "rod-3", lado: "depois" } : null,
    );
  });

  it("não enviado sem motivo, ou com um motivo que a tela não conhece: só 'não enviado', sem inventar", () => {
    const fim = (m: string | null) =>
      una([
        retornoDeTeste({
          status: "nao_enviado",
          nao_enviado_motivo: m,
          resolvido_em: em("2026-11-19", "09:00"),
        }),
      ])[1]!;
    expect(texto(fim(null))).toBe("Retorno das 09:00 não enviado");
    expect(texto(fim("motivo_novo"))).toBe("Retorno das 09:00 não enviado");
  });

  it("não enviado de madrugada, de um retorno de outro dia: a referência traz o dia", () => {
    const [, fim] = una([
      retornoDeTeste({
        status: "nao_enviado",
        nao_enviado_motivo: "passou_do_prazo",
        vence_em: em("2026-11-18", "23:00"),
        resolvido_em: em("2026-11-19", "02:00"),
      }),
    ]);
    expect(texto(fim!)).toBe(
      "Retorno de qua, 18/11, às 23:00 não enviado: passou mais de 3 h da hora marcada",
    );
  });

  it("retorno aberto (pendente, em_rodada, saindo): só a linha de marcação", () => {
    for (const status of [
      "pendente",
      "em_rodada",
      "saindo",
      "estado_novo",
    ] as RetornoDados["status"][]) {
      expect(una([retornoDeTeste({ status })])).toHaveLength(1);
    }
  });

  it("quadro 3: o lembrete enviado diz 'havia N h' pela própria linha, antes da rodada", () => {
    const [l, ...resto] = una([
      lembreteDeTeste({
        id: "l1",
        status: "enviado",
        rodada_id: "rod-l",
        enviado_em: em("2026-11-18", "12:00"),
        resolvido_em: em("2026-11-18", "12:00"),
      }),
    ]);
    expect(resto).toEqual([]);
    expect(l).toEqual({
      id: "l1:fim",
      momento: em("2026-11-18", "12:00"),
      antes: "Lembrete automático: o lead não respondia havia 3 h",
      forte: null,
      tom: "normal",
      ancora: { rodadaId: "rod-l", lado: "antes" },
    });
  });

  it("caso 18: a pergunta das 18:30 empurrada para as 08:00 diz 'havia 13 h'; nunca menos de 1 h", () => {
    const l = (marcado: string, vence: string) =>
      una([
        lembreteDeTeste({
          status: "enviado",
          marcado_em: marcado,
          vence_em: vence,
          enviado_em: vence,
        }),
      ])[0]!;
    expect(l(em("2026-11-18", "18:30"), em("2026-11-19", "08:00")).antes).toBe(
      "Lembrete automático: o lead não respondia havia 13 h",
    );
    expect(l(em("2026-11-18", "18:30"), em("2026-11-18", "18:50")).antes).toBe(
      "Lembrete automático: o lead não respondia havia 1 h",
    );
  });

  it("lembrete em qualquer outro status: nenhuma linha (armar, cancelar, expirar e desligar não aparecem)", () => {
    for (const status of [
      "pendente",
      "em_rodada",
      "cancelado",
      "dispensado",
      "nao_enviado",
      "saindo",
    ] as const) {
      expect(una([lembreteDeTeste({ status })])).toEqual([]);
    }
  });
});

/* ---------- a âncora na rodada ---------- */

type Bolha = { momento: string; origem?: string; rodada_id?: string | null };
const bolha = (hora: string, rodada: string | null, origem = "nina"): Bolha => ({
  momento: em("2026-11-19", hora),
  origem,
  rodada_id: rodada,
});

describe("ancorar: a linha encaixada na rodada (C1)", () => {
  const linha = (
    id: string,
    momento: string,
    ancora: { rodadaId: string; lado: "antes" | "depois" } | null,
  ) => ({
    id,
    momento,
    antes: "x",
    forte: null,
    tom: "normal" as const,
    ancora,
  });

  it("quadros 1, 5 e 6: a linha 'depois' vai atrás da última bolha da rodada, mesmo com o fato antes dela", () => {
    const [a] = ancorar(
      [linha("a", em("2026-11-19", "09:00:01"), { rodadaId: "r1", lado: "depois" })],
      [bolha("09:00:05", "r1"), bolha("09:00:09", "r1")],
    );
    expect(a).toMatchObject({ em: em("2026-11-19", "09:00:09"), peso: 1 });
    expect(a?.momento).toBe(em("2026-11-19", "09:00:01")); // a hora mostrada é a do fato
  });

  it("quadros 2 e 3: a linha 'antes' vai à frente da primeira bolha da rodada", () => {
    const [a] = ancorar(
      [linha("a", em("2026-11-19", "09:00:07"), { rodadaId: "r1", lado: "antes" })],
      [bolha("09:00:05", "r1"), bolha("09:00:09", "r1")],
    );
    expect(a).toMatchObject({ em: em("2026-11-19", "09:00:05"), peso: -1 });
  });

  it("o fato depois da última bolha (ou antes da primeira) fica no instante do fato, no lado certo", () => {
    const [depois] = ancorar(
      [linha("a", em("2026-11-19", "10:00"), { rodadaId: "r1", lado: "depois" })],
      [bolha("09:00:05", "r1")],
    );
    expect(depois).toMatchObject({ em: em("2026-11-19", "10:00"), peso: 1 });
    const [antes] = ancorar(
      [linha("a", em("2026-11-19", "08:00"), { rodadaId: "r1", lado: "antes" })],
      [bolha("09:00:05", "r1")],
    );
    expect(antes).toMatchObject({ em: em("2026-11-19", "08:00"), peso: -1 });
  });

  it("sem a rodada nas mensagens carregadas, ou sem âncora: fica pelo tempo, peso 0", () => {
    const ls = ancorar(
      [
        linha("a", em("2026-11-19", "09:00"), { rodadaId: "outra", lado: "antes" }),
        linha("b", em("2026-11-19", "09:30"), null),
      ],
      [bolha("09:00:05", "r1")],
    );
    expect(ls.map((l) => [l.em, l.peso])).toEqual([
      [em("2026-11-19", "09:00"), 0],
      [em("2026-11-19", "09:30"), 0],
    ]);
  });

  it("C1: só as bolhas da Nina contam; a fala do lead da mesma rodada não puxa a linha para cima", () => {
    // o lead falou às 08:55:00 (a mensagem tem o rodada_id da rodada mista); a bolha da Nina saiu às 08:55:12
    const [a] = ancorar(
      [linha("a", em("2026-11-19", "08:55:12"), { rodadaId: "r1", lado: "antes" })],
      [bolha("08:55:00", "r1", "lead"), bolha("08:55:12", "r1", "nina")],
    );
    expect(a).toMatchObject({ em: em("2026-11-19", "08:55:12"), peso: -1 });
  });

  it("virada de dia: o 'depois' acompanha a bolha que saiu depois da meia-noite", () => {
    const [a] = ancorar(
      [linha("a", em("2026-11-18", "23:59:58"), { rodadaId: "r1", lado: "depois" })],
      [{ momento: em("2026-11-19", "00:00:05"), origem: "nina", rodada_id: "r1" }],
    );
    expect(a?.em).toBe(em("2026-11-19", "00:00:05"));
  });
});

/* ---------- a linha do tempo ---------- */

function msg(
  id: string,
  momento: string,
  origem: "lead" | "nina",
  rodada: string | null = null,
): MensagemDados {
  return {
    id,
    conversa_id: "conv-1",
    conexao_id: null,
    direcao: origem === "lead" ? "entrada" : "saida",
    origem,
    tipo: "texto",
    status: origem === "lead" ? "recebida" : "entregue",
    texto: id,
    transcricao: null,
    momento,
    autor_membro_id: null,
    midia_nome: null,
    midia_mime: null,
    midia_tamanho: null,
    midia_caminho: null,
    midia_status: null,
    editada: false,
    apagada_em: null,
    erro: null,
    id_externo: null,
    id_gateway: null,
    criado_em: momento,
    responde_a_id: null,
    midia_duracao_s: null,
    rodada_id: rodada,
  } as unknown as MensagemDados;
}

describe("linhaDoTempo com as linhas dos retornos", () => {
  const ids = (itens: ReturnType<typeof linhaDoTempo>) => itens.map((i) => i.id);

  it("quadro 1: 'marcou' fica depois da bolha da Nina, mesmo com o marcado_em segundos antes dela", () => {
    const r = retornoDeTeste({
      id: "r1",
      marcado_em: em("2026-11-18", "16:09:01"),
      rodada_origem_id: "rod-1",
    });
    const mensagens = [
      msg("lead", em("2026-11-18", "16:08:00"), "lead", "rod-1"),
      msg("nina", em("2026-11-18", "16:09:05"), "nina", "rod-1"),
    ];
    expect(ids(linhaDoTempo(mensagens, [], false, linhasDosRetornos([r], nome)))).toEqual([
      "lead",
      "nina",
      "r1:inicio",
    ]);
  });

  it("quadros 2 e 3 (C1): 'Retorno combinado' fica logo antes da 1ª bolha da Nina, entre a fala do lead e a resposta", () => {
    const r = retornoDeTeste({
      id: "r1",
      status: "enviado",
      rodada_id: "rod-7",
      enviado_em: em("2026-11-19", "08:55:12"),
      resolvido_em: em("2026-11-19", "08:55:12"),
      marcado_em: em("2026-11-18", "10:00"),
      rodada_origem_id: null,
    });
    const mensagens = [
      msg("lead", em("2026-11-19", "08:55:00"), "lead", "rod-7"),
      msg("nina1", em("2026-11-19", "08:55:12"), "nina", "rod-7"),
      msg("nina2", em("2026-11-19", "08:55:14"), "nina", "rod-7"),
    ];
    expect(ids(linhaDoTempo(mensagens, [], false, linhasDosRetornos([r], nome)))).toEqual([
      "r1:inicio",
      "lead",
      "r1:fim",
      "nina1",
      "nina2",
    ]);
  });

  it("quadro 3: 'Lembrete automático' antes da bolha do lembrete", () => {
    const l = lembreteDeTeste({
      id: "l1",
      status: "enviado",
      rodada_id: "rod-l",
      enviado_em: em("2026-11-18", "12:00:03"),
      marcado_em: em("2026-11-18", "09:00"),
    });
    const mensagens = [
      msg("pergunta", em("2026-11-18", "09:00:00"), "nina", "rod-p"),
      msg("lembrete", em("2026-11-18", "12:00:03"), "nina", "rod-l"),
    ];
    expect(ids(linhaDoTempo(mensagens, [], false, linhasDosRetornos([l], nome)))).toEqual([
      "pergunta",
      "l1:fim",
      "lembrete",
    ]);
  });

  it("sem linhas, o resultado é o de hoje (o 4º parâmetro é opcional)", () => {
    const mensagens = [
      msg("a", em("2026-11-18", "16:00"), "lead"),
      msg("b", em("2026-11-18", "16:01"), "nina"),
    ];
    expect(ids(linhaDoTempo(mensagens, []))).toEqual(["a", "b"]);
    expect(ids(linhaDoTempo(mensagens, [], false, []))).toEqual(["a", "b"]);
  });

  it("com mensagens mais antigas por carregar, a linha de antes da mensagem mais antiga espera a página dela", () => {
    const r = retornoDeTeste({
      id: "r1",
      marcado_em: em("2026-11-10", "10:00"),
      rodada_origem_id: null,
    });
    const mensagens = [msg("a", em("2026-11-18", "16:00"), "lead")];
    expect(ids(linhaDoTempo(mensagens, [], true, linhasDosRetornos([r], nome)))).toEqual(["a"]);
    expect(ids(linhaDoTempo(mensagens, [], false, linhasDosRetornos([r], nome)))).toEqual([
      "r1:inicio",
      "a",
    ]);
  });

  it("a linha sem mensagem na rodada (dispensado, cancelado pela equipe) fica pelo tempo (quadros 7, 8 e 10)", () => {
    const r = retornoDeTeste({
      id: "r1",
      status: "nao_enviado",
      nao_enviado_motivo: "com_equipe",
      resolvido_em: em("2026-11-19", "09:00"),
      marcado_em: em("2026-11-18", "10:00"),
      rodada_origem_id: null,
    });
    const mensagens = [
      msg("marina", em("2026-11-18", "16:30"), "nina"),
      msg("depois", em("2026-11-19", "10:00"), "lead"),
    ];
    expect(ids(linhaDoTempo(mensagens, [], false, linhasDosRetornos([r], nome)))).toEqual([
      "r1:inicio",
      "marina",
      "r1:fim",
      "depois",
    ]);
  });
});
