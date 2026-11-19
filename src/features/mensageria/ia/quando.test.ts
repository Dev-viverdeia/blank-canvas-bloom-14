import { describe, expect, it } from "vitest";

import {
  diaEmBrasilia,
  formatarMomento,
  partesEmBrasilia,
  PERIODOS,
  porExtenso,
  referenciaDaRodada,
  relativoA,
  resolverData,
  resolverHora,
} from "./quando";

// Brasília fica em UTC-3, sem horário de verão. 18/11/2026 é uma quarta-feira.
const brasilia = (dia: number, hora: number, min = 0, mes = 11, ano = 2026) =>
  Date.UTC(ano, mes - 1, dia, hora + 3, min);

/** qua 18/11/2026 16:09 (o caso 1 do artefato) */
const QUA_16_09 = brasilia(18, 16, 9);

describe("períodos sem hora dita (caso 2)", () => {
  it("manhã 09:00, tarde 14:00, noite 19:00", () => {
    expect(PERIODOS).toEqual({ manha: "09:00", tarde: "14:00", noite: "19:00" });
    expect(resolverHora("manha")).toEqual({ hora: "09:00" });
    expect(resolverHora("Manhã")).toEqual({ hora: "09:00" });
    expect(resolverHora("de manhã")).toEqual({ hora: "09:00" });
    expect(resolverHora("pela manhã")).toEqual({ hora: "09:00" });
    expect(resolverHora("tarde")).toEqual({ hora: "14:00" });
    expect(resolverHora("à tarde")).toEqual({ hora: "14:00" });
    expect(resolverHora("noite")).toEqual({ hora: "19:00" });
    expect(resolverHora("à noite")).toEqual({ hora: "19:00" });
    expect(resolverHora("meio-dia")).toEqual({ hora: "12:00" });
  });
});

describe("resolverHora", () => {
  it("completa para HH:MM", () => {
    expect(resolverHora("09:00")).toEqual({ hora: "09:00" });
    expect(resolverHora("9:00")).toEqual({ hora: "09:00" });
    expect(resolverHora("9h")).toEqual({ hora: "09:00" });
    expect(resolverHora("9h30")).toEqual({ hora: "09:30" });
    expect(resolverHora("14:30")).toEqual({ hora: "14:30" });
    expect(resolverHora(" 23:59 ")).toEqual({ hora: "23:59" });
    expect(resolverHora("00:00")).toEqual({ hora: "00:00" });
  });

  it("recusa o que não é hora", () => {
    for (const v of ["24:00", "9:60", "14:5", "", "abc", "2026-11-19T12:00Z", "12:00:00", "-1"]) {
      expect(resolverHora(v), v).toEqual({ erro: "hora_invalida" });
    }
  });
});

describe("resolverData (referência: qua 18/11/2026)", () => {
  const dia = (v: string, ref = QUA_16_09) => resolverData(v, ref);

  it("hoje, amanhã e depois de amanhã", () => {
    expect(dia("hoje")).toEqual({ data: "2026-11-18", palavra: "outra" });
    expect(dia("amanha")).toEqual({ data: "2026-11-19", palavra: "amanha" });
    expect(dia("Amanhã")).toEqual({ data: "2026-11-19", palavra: "amanha" });
    expect(dia("depois_de_amanha")).toEqual({ data: "2026-11-20", palavra: "outra" });
    expect(dia("depois de amanhã")).toEqual({ data: "2026-11-20", palavra: "outra" });
  });

  it("dia da semana: o próximo depois da referência", () => {
    expect(dia("sexta")).toEqual({ data: "2026-11-20", palavra: "outra" });
    expect(dia("Sexta-feira")).toEqual({ data: "2026-11-20", palavra: "outra" });
    expect(dia("na sexta")).toEqual({ data: "2026-11-20", palavra: "outra" });
    expect(dia("terça-feira")).toEqual({ data: "2026-11-24", palavra: "outra" });
    expect(dia("terca")).toEqual({ data: "2026-11-24", palavra: "outra" });
    expect(dia("sábado")).toEqual({ data: "2026-11-21", palavra: "outra" });
    expect(dia("domingo")).toEqual({ data: "2026-11-22", palavra: "outra" });
    expect(dia("segunda")).toEqual({ data: "2026-11-23", palavra: "outra" });
  });

  it("o dia da semana de hoje é ambíguo: não vira a semana seguinte calado", () => {
    expect(dia("quarta")).toEqual({ erro: "dia_ambiguo", hoje: "quarta-feira", chave: "quarta" });
    // sexta dito na sexta
    expect(dia("sexta", brasilia(20, 10))).toEqual({
      erro: "dia_ambiguo",
      hoje: "sexta-feira",
      chave: "sexta",
    });
    expect(dia("sabado", brasilia(21, 10))).toEqual({
      erro: "dia_ambiguo",
      hoje: "sábado",
      chave: "sabado",
    });
  });

  it("proxima_<dia> é estritamente a próxima", () => {
    expect(dia("proxima_quarta")).toEqual({ data: "2026-11-25", palavra: "outra" });
    expect(dia("próxima quarta-feira")).toEqual({ data: "2026-11-25", palavra: "outra" });
    expect(dia("proximo_sabado")).toEqual({ data: "2026-11-21", palavra: "outra" });
    // na sexta, a próxima sexta é a da semana que vem
    expect(dia("proxima_sexta", brasilia(20, 10))).toEqual({
      data: "2026-11-27",
      palavra: "outra",
    });
  });

  it("proxima_<dia> só muda algo quando hoje já é o dia: numa quarta, proxima_sexta é a sexta desta semana", () => {
    // a descrição do campo data diz isso ao modelo; a sexta da semana que vem pede a data AAAA-MM-DD
    expect(dia("proxima_sexta")).toEqual({ data: "2026-11-20", palavra: "outra" });
    expect(dia("sexta")).toEqual({ data: "2026-11-20", palavra: "outra" });
    expect(dia("2026-11-27")).toEqual({ data: "2026-11-27", palavra: "outra" });
  });

  it("virada do mês sem conta do modelo (seg 30/11, quarta)", () => {
    expect(dia("quarta", brasilia(30, 10))).toEqual({ data: "2026-12-02", palavra: "outra" });
    expect(dia("amanha", brasilia(31, 10, 0, 12))).toEqual({
      data: "2027-01-01",
      palavra: "amanha",
    });
  });

  it("datas escritas: AAAA-MM-DD, DD/MM e DD/MM/AAAA", () => {
    expect(dia("2026-11-25")).toEqual({ data: "2026-11-25", palavra: "outra" });
    expect(dia("25/11")).toEqual({ data: "2026-11-25", palavra: "outra" });
    expect(dia("18/11")).toEqual({ data: "2026-11-18", palavra: "outra" });
    // o dia que já passou neste ano vai para o ano que vem
    expect(dia("01/11")).toEqual({ data: "2027-11-01", palavra: "outra" });
    expect(dia("30/11/2026")).toEqual({ data: "2026-11-30", palavra: "outra" });
  });

  it("data inválida: sem ir ao banco (caso 10)", () => {
    for (const v of [
      "2026-02-31",
      "2026-13-01",
      "ontem",
      "2026-11-19T12:00Z",
      "2026-11-19T12:00:00-03:00",
      "",
      "semana que vem",
      "31/02",
      "32/01/2026",
    ]) {
      expect(dia(v), v).toEqual({ erro: "data_invalida" });
    }
  });
});

describe("virada de dia (caso 11): o dia é o de Brasília", () => {
  it("23:50 de 18/11, 'amanhã às 9h': 19/11 09:00", () => {
    const ref = brasilia(18, 23, 50);
    expect(resolverData("amanha", ref)).toEqual({ data: "2026-11-19", palavra: "amanha" });
    expect(resolverHora("9h")).toEqual({ hora: "09:00" });
  });

  it("00:10 de 19/11, 'hoje às 9h': 19/11 09:00", () => {
    const ref = brasilia(19, 0, 10);
    expect(ref).toBe(Date.UTC(2026, 10, 19, 3, 10));
    expect(resolverData("hoje", ref)).toEqual({ data: "2026-11-19", palavra: "outra" });
  });

  it("02:30 UTC de 19/11 ainda é 18/11 em Brasília", () => {
    const ms = Date.UTC(2026, 10, 19, 2, 30);
    expect(diaEmBrasilia(ms)).toEqual({ ano: 2026, mes: 11, dia: 18, semana: 3, hora: 23 });
    expect(resolverData("amanha", ms)).toEqual({ data: "2026-11-19", palavra: "amanha" });
  });
});

describe("diaEmBrasilia e partesEmBrasilia", () => {
  it("dia, semana e hora de Brasília", () => {
    expect(diaEmBrasilia(QUA_16_09)).toEqual({ ano: 2026, mes: 11, dia: 18, semana: 3, hora: 16 });
    expect(diaEmBrasilia(Date.UTC(2026, 10, 19, 3, 0))).toEqual({
      ano: 2026,
      mes: 11,
      dia: 19,
      semana: 4,
      hora: 0,
    });
    // domingo
    expect(diaEmBrasilia(brasilia(22, 12)).semana).toBe(0);
  });

  it("as partes que a linha Agora: usa", () => {
    expect(partesEmBrasilia(QUA_16_09)).toMatchObject({
      weekday: "quarta-feira",
      day: "18",
      month: "11",
      year: "2026",
      hour: "16",
      minute: "09",
    });
  });
});

describe("por extenso, para o lead conferir", () => {
  it("formatarMomento", () => {
    expect(formatarMomento(brasilia(19, 9))).toBe("quinta-feira, 19/11/2026, às 09:00");
    expect(formatarMomento(brasilia(20, 14, 30))).toBe("sexta-feira, 20/11/2026, às 14:30");
  });

  it("relativoA conta do dia do Agora: em Brasília", () => {
    expect(relativoA(brasilia(18, 20), QUA_16_09)).toBe("hoje");
    expect(relativoA(brasilia(19, 9), QUA_16_09)).toBe("amanhã");
    expect(relativoA(brasilia(20, 9), QUA_16_09)).toBe("depois de amanhã");
    expect(relativoA(brasilia(21, 9), QUA_16_09)).toBeNull();
    expect(relativoA(brasilia(17, 9), QUA_16_09)).toBeNull();
    // 23:50 e 00:10 estão em dias diferentes
    expect(relativoA(brasilia(19, 9), brasilia(18, 23, 50))).toBe("amanhã");
    expect(relativoA(brasilia(19, 9), brasilia(19, 0, 10))).toBe("hoje");
  });

  it("porExtenso (caso 1)", () => {
    expect(porExtenso(brasilia(19, 9), QUA_16_09)).toBe(
      "quinta-feira, 19/11/2026, às 09:00 (amanhã)",
    );
    expect(porExtenso(brasilia(21, 9), QUA_16_09)).toBe("sábado, 21/11/2026, às 09:00");
    // caso 9: o limite de 07:50 da oficial
    expect(porExtenso(brasilia(19, 7, 50), brasilia(18, 8))).toBe(
      "quinta-feira, 19/11/2026, às 07:50 (amanhã)",
    );
  });
});

describe("referenciaDaRodada", () => {
  const agora = brasilia(19, 0, 1);

  it("o maior momento das entradas, limitado ao agora", () => {
    const m = (min: number) => ({ momento: new Date(brasilia(18, 23, min)).toISOString() });
    expect(referenciaDaRodada([m(50), m(58)], agora)).toBe(brasilia(18, 23, 58));
    const futuro = { momento: new Date(brasilia(19, 5)).toISOString() };
    expect(referenciaDaRodada([futuro], agora)).toBe(agora);
  });

  it("sem entrada, sem momento ou com entrada de mais de 6 h: o agora", () => {
    expect(referenciaDaRodada([], agora)).toBe(agora);
    expect(referenciaDaRodada([{ momento: null }, {}], agora)).toBe(agora);
    expect(referenciaDaRodada([{ momento: "lixo" }], agora)).toBe(agora);
    const velha = { momento: new Date(agora - 6 * 3600_000 - 1000).toISOString() };
    expect(referenciaDaRodada([velha], agora)).toBe(agora);
    const recente = { momento: new Date(agora - 6 * 3600_000 + 1000).toISOString() };
    expect(referenciaDaRodada([recente], agora)).toBe(agora - 6 * 3600_000 + 1000);
  });
});
