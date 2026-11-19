import { describe, expect, it } from "vitest";

import {
  andamentoVencido,
  conversaDoIdExterno,
  duracaoLegivel,
  ehMensagemDeLigacao,
  ehRegistroAntigoDeLigacao,
  ehRegistroDeLigacao,
  falasDaLigacao,
  idExternoDaLigacao,
  MAX_FALAS,
  motivoDoFim,
  semMarcasDeEmocao,
  lerRegistroDeLigacao,
  MAX_TRANSCRICAO,
  MARCA_TRANSCRICAO_CORTADA,
  textoConcluida,
  textoEmAndamento,
  textoNaoCompletada,
  tituloDaLigacao,
  transcricaoDaLigacao,
} from "./registro";

describe("registro da ligação", () => {
  it("id_externo leva o prefixo e volta ao id da ElevenLabs", () => {
    expect(idExternoDaLigacao("conv_abc123")).toBe("ligacao:conv_abc123");
    expect(conversaDoIdExterno("ligacao:conv_abc123")).toBe("conv_abc123");
    expect(conversaDoIdExterno("wamid.XYZ")).toBeNull();
    expect(conversaDoIdExterno(null)).toBeNull();
  });

  it("os três textos são lidos de volta", () => {
    expect(lerRegistroDeLigacao(textoEmAndamento())).toEqual({ fase: "andamento" });
    expect(lerRegistroDeLigacao(textoNaoCompletada())).toEqual({ fase: "falhou" });
    expect(lerRegistroDeLigacao(textoConcluida(192, "Quer saber o preço."))).toEqual({
      fase: "concluida",
      segundos: 192,
      resumo: "Quer saber o preço.",
    });
    expect(lerRegistroDeLigacao(textoConcluida(45.6))).toEqual({ fase: "concluida", segundos: 46 });
    expect(lerRegistroDeLigacao(textoConcluida(30, "linha 1\nlinha 2"))?.resumo).toBe(
      "linha 1\nlinha 2",
    );
  });

  it("texto que não é de ligação não é lido", () => {
    expect(lerRegistroDeLigacao("[localização] Rua X")).toBeNull();
    expect(lerRegistroDeLigacao("oi")).toBeNull();
    expect(lerRegistroDeLigacao(null)).toBeNull();
    expect(lerRegistroDeLigacao("[ligação] algo estranho")).toBeNull();
  });

  it("só o tipo outro com o prefixo é registro de ligação", () => {
    expect(ehRegistroDeLigacao({ tipo: "outro", texto: textoEmAndamento() })).toBe(true);
    expect(ehRegistroDeLigacao({ tipo: "texto", texto: textoEmAndamento() })).toBe(false);
    expect(ehRegistroDeLigacao({ tipo: "outro", texto: "[contato] Ana" })).toBe(false);
    expect(ehRegistroDeLigacao({ tipo: "outro", texto: null })).toBe(false);
  });

  it("título de cada fase", () => {
    const agora = Date.parse("2026-11-11T12:00:00Z");
    expect(tituloDaLigacao({ fase: "concluida", segundos: 192 })).toBe("Ligação · 3 min 12 s");
    expect(tituloDaLigacao({ fase: "falhou" })).toBe("Ligação não completada");
    expect(tituloDaLigacao({ fase: "andamento" }, "2026-11-11T11:55:00Z", agora)).toBe(
      "Ligação em andamento",
    );
    // uma ligação de 30 min ainda está em andamento aos 20 e aos 34 (a duração máxima mais a folga)
    expect(tituloDaLigacao({ fase: "andamento" }, "2026-11-11T11:40:00Z", agora)).toBe(
      "Ligação em andamento",
    );
    expect(andamentoVencido("2026-11-11T11:26:00Z", agora)).toBe(false);
    expect(tituloDaLigacao({ fase: "andamento" }, "2026-11-11T11:20:00Z", agora)).toBe(
      "Ligação sem resumo",
    );
    expect(andamentoVencido("2026-11-11T11:24:59Z", agora)).toBe(true);
  });

  it("duração legível", () => {
    expect(duracaoLegivel(45)).toBe("45 s");
    expect(duracaoLegivel(600)).toBe("10 min");
    expect(duracaoLegivel(192)).toBe("3 min 12 s");
  });

  it("transcrição: uma linha por fala, sem vazias nem papéis desconhecidos", () => {
    const t = transcricaoDaLigacao([
      { role: "agent", message: "Oi! Aqui é a Nina." },
      { role: "user", message: "  quero   saber o preço " },
      { role: "agent", message: null, tool_calls: [{ tool_name: "nina_passar_para_equipe" }] },
      { role: "system", message: "x" },
      "lixo",
    ]);
    expect(t).toBe("Nina: Oi! Aqui é a Nina.\nLead: quero saber o preço");
    expect(transcricaoDaLigacao(undefined)).toBe("");
    const longa = transcricaoDaLigacao(
      Array.from({ length: 2000 }, () => ({ role: "user", message: "a".repeat(50) })),
    );
    expect(longa.length).toBe(MAX_TRANSCRICAO);
  });
});

describe("as duas formas da ligação na conversa (L16)", () => {
  it("a nova é a mensagem do tipo ligacao; a antiga, o tipo outro com [ligação]", () => {
    const nova = { tipo: "ligacao", texto: "Ligação · 2 min 54 s" };
    const antiga = { tipo: "outro", texto: textoEmAndamento() };
    expect(ehMensagemDeLigacao(nova)).toBe(true);
    expect(ehRegistroAntigoDeLigacao(nova)).toBe(false);
    expect(ehRegistroDeLigacao(nova)).toBe(true);
    expect(ehMensagemDeLigacao(antiga)).toBe(false);
    expect(ehRegistroAntigoDeLigacao(antiga)).toBe(true);
    expect(ehRegistroDeLigacao(antiga)).toBe(true);
    expect(ehRegistroDeLigacao({ tipo: "texto", texto: "Ligação" })).toBe(false);
  });
});

describe("semMarcasDeEmocao", () => {
  it.each([
    ["[excited] Que ótimo!", "Que ótimo!"],
    ["Claro [happy], posso te ajudar.", "Claro, posso te ajudar."],
    ["[slow] Vamos [laugh] lá", "Vamos lá"],
    ["Hmm [short pause] deixa eu ver", "Hmm deixa eu ver"],
    ["[warmly] Oi, Ana!", "Oi, Ana!"],
    ["[whispering] um segredo", "um segredo"],
  ])("tira a marca: %s", (antes, depois) => {
    expect(semMarcasDeEmocao(antes)).toBe(depois);
  });

  it.each([
    "Veja o [link do contrato] que mandei",
    "[ligação] concluída",
    "O plano [Pro] custa mais",
    "Item [1] e item [2]",
    "Use [Ctrl] e [C]",
    "[preço sob consulta]",
  ])("não tira texto legítimo entre colchetes: %s", (texto) => {
    expect(semMarcasDeEmocao(texto)).toBe(texto);
  });
});

describe("falasDaLigacao", () => {
  it("papel, texto sem marcas e segundos; sem falas vazias nem de outros papéis", () => {
    expect(
      falasDaLigacao([
        { role: "agent", message: "[excited] Oi, Ana!", time_in_call_secs: 0 },
        { role: "user", message: "  Quanto   custa? ", time_in_call_secs: 4.7 },
        { role: "agent", message: "[laugh]", time_in_call_secs: 6 },
        { role: "tool", message: "x", time_in_call_secs: 7 },
        { role: "agent", message: null, time_in_call_secs: 8 },
        { role: "agent", message: "A partir de mil reais.", time_in_call_secs: 9 },
      ]),
    ).toEqual([
      { papel: "nina", texto: "Oi, Ana!", segundos: 0 },
      { papel: "lead", texto: "Quanto custa?", segundos: 4 },
      { papel: "nina", texto: "A partir de mil reais.", segundos: 9 },
    ]);
    expect(falasDaLigacao(null)).toEqual([]);
  });

  it("tem teto de falas e de letras, e o corte fica marcado na última fala", () => {
    const muitas = Array.from({ length: MAX_FALAS + 50 }, (_, i) => ({
      role: "user",
      message: `fala ${i}`,
      time_in_call_secs: i,
    }));
    const cortadas = falasDaLigacao(muitas);
    expect(cortadas).toHaveLength(MAX_FALAS);
    expect(cortadas.at(-1)!.texto).toBe(`fala ${MAX_FALAS - 1} ${MARCA_TRANSCRICAO_CORTADA}`);
    const longas = Array.from({ length: 100 }, () => ({
      role: "user",
      message: "x".repeat(1_500),
    }));
    const gravadas = falasDaLigacao(longas);
    const total = gravadas.reduce((n, f) => n + f.texto.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_TRANSCRICAO + MARCA_TRANSCRICAO_CORTADA.length + 1);
    expect(gravadas.at(-1)!.texto.endsWith(MARCA_TRANSCRICAO_CORTADA)).toBe(true);
  });

  it("uma ligação de 30 min (400 falas, ~36.000 letras) cabe inteira, sem marca de corte", () => {
    const meiaHora = Array.from({ length: 400 }, (_, i) => ({
      role: i % 2 ? "user" : "agent",
      message: `Fala número ${i} da conversa, com umas frases de tamanho normal pra ligação.`,
      time_in_call_secs: i * 4.5,
    }));
    const falas = falasDaLigacao(meiaHora);
    expect(falas).toHaveLength(400);
    expect(falas.some((f) => f.texto.includes(MARCA_TRANSCRICAO_CORTADA))).toBe(false);
  });
});

describe("motivoDoFim", () => {
  it.each([
    ["end_call tool was called.", "agent_ended"],
    ["Call ended by remote party", "client_ended"],
    ["Client disconnected: 1000", "client_ended"],
    ["Maximum duration exceeded", "max_duration"],
    ["Silence timeout", "silence"],
    // o silêncio também cita o end_call: tem de ganhar dele
    ["silence_end_call_timeout", "silence"],
    ["Conversation ended due to silence_end_call_timeout", "silence"],
    ["Inactivity timeout", "silence"],
    ["Max duration exceeded (max_duration_seconds)", "max_duration"],
    ["Agent ended the call", "agent_ended"],
    ["", null],
    [undefined, null],
    ["algo novo", null],
  ])("%s → %s", (entrada, codigo) => {
    expect(motivoDoFim(entrada)).toBe(codigo);
  });
});
