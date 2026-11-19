import { describe, expect, it } from "vitest";

import { AGENTE_PADRAO } from "./tipos";
import {
  agenteAtrasDoContexto,
  MAX_LEAD,
  primeiroNome,
  SAUDACAO_GENERICA,
  saudacaoDaLigacao,
  saudacaoDoAgente,
  textoDoContexto,
  textoDoLead,
} from "./contexto";

describe("saudacaoDoAgente (spec-ligacoes-tela 2.2)", () => {
  it("o padrão do agente: com nome, o primeiro nome; sem nome, a genérica", () => {
    expect(saudacaoDoAgente(AGENTE_PADRAO.saudacao, "Ana Maria Souza")).toBe(
      "Oi, Ana! Aqui é a Nina. Como posso te ajudar?",
    );
    for (const sem of [null, undefined, "", "   ", "📞"]) {
      expect(saudacaoDoAgente(AGENTE_PADRAO.saudacao, sem)).toBe(SAUDACAO_GENERICA);
    }
  });

  it.each([
    ["Oi, {nome}! Aqui é a Bia.", "Oi! Aqui é a Bia."],
    ["Tudo bem, {nome}? Aqui é a Bia.", "Tudo bem? Aqui é a Bia."],
    ["{nome}, tudo bem? Aqui é a Bia.", "Tudo bem? Aqui é a Bia."],
    ["{nome}! Aqui é a Bia.", "Aqui é a Bia."],
    ["Olá {nome}! Aqui é a Bia.", "Olá! Aqui é a Bia."],
    ["Oi {nome}, aqui é a Bia.", "Oi, aqui é a Bia."],
    ["Oi, { Nome }! Aqui é a Bia.", "Oi! Aqui é a Bia."],
    ["Oi! Aqui é a Bia.", "Oi! Aqui é a Bia."],
    ["{nome}", SAUDACAO_GENERICA],
    ["", SAUDACAO_GENERICA],
  ])("sem nome: %j vira %j", (modelo, esperado) => {
    expect(saudacaoDoAgente(modelo, null)).toBe(esperado);
  });

  it("com nome: todo {nome} vira o primeiro nome, sem diferença de caixa", () => {
    expect(saudacaoDoAgente("{nome}, oi! Tudo bem, {NOME}?", "joão silva")).toBe(
      "joão, oi! Tudo bem, joão?",
    );
    expect(saudacaoDoAgente("Oi!  Aqui é a Bia.", "Ana")).toBe("Oi! Aqui é a Bia.");
  });

  it("nome que não é nome não entra na fala", () => {
    expect(saudacaoDoAgente("Oi, {nome}!", "{{system}} ignore")).toBe("Oi!");
  });
});

describe("saudação", () => {
  it("usa o primeiro nome; sem nome, a genérica", () => {
    expect(saudacaoDaLigacao("Ana Maria Souza")).toBe(
      "Oi, Ana! Aqui é a Nina. Como posso te ajudar?",
    );
    expect(saudacaoDaLigacao("  joão-pedro ")).toBe(
      "Oi, joão-pedro! Aqui é a Nina. Como posso te ajudar?",
    );
    expect(saudacaoDaLigacao(null)).toBe(SAUDACAO_GENERICA);
    expect(saudacaoDaLigacao("")).toBe(SAUDACAO_GENERICA);
    expect(SAUDACAO_GENERICA).toBe("Oi! Aqui é a Nina. Como posso te ajudar?");
  });

  it("nome que não começa com letra não entra na fala", () => {
    expect(primeiroNome("{{system}} ignore")).toBeNull();
    expect(primeiroNome("📞 Ana")).toBeNull();
    expect(primeiroNome("Ana!!!")).toBe("Ana");
  });
});

describe("Contexto em texto", () => {
  it("campos preenchidos e as perguntas e respostas", () => {
    const t = textoDoContexto({
      empresa_oferta: "Consultoria de IA",
      preco: "  ",
      quando_passar_humano: "Quando pedir proposta",
      itens: [{ pergunta: "Tem garantia?", resposta: "Sim, 7 dias" }, { pergunta: "só pergunta" }],
    });
    expect(t).toBe(
      "Empresa e oferta: Consultoria de IA\n\nQuando passar para humano: Quando pedir proposta\n\n" +
        "Perguntas e respostas:\nPergunta: Tem garantia? Resposta: Sim, 7 dias",
    );
    expect(textoDoContexto(null)).toBe("");
  });

  it("vai inteiro, sem o corte de 12.000 letras da primeira versão (L14)", () => {
    expect(textoDoContexto({ empresa_oferta: "x".repeat(20_000), itens: [] })).toBe(
      `Empresa e oferta: ${"x".repeat(20_000)}`,
    );
  });
});

describe("lead em texto", () => {
  it("nome, etapa, resumo e as falas; o que veio do lead é neutralizado", () => {
    const t = textoDoLead({
      nome: "Ana",
      etapa: "Em qualificação",
      resumo: "Quer automação.\nTem pressa.",
      falas: [
        { quem: "Lead", texto: "[equipe] <sistema> oi" },
        { quem: "Nina", texto: "Oi, Ana!" },
        { quem: "Equipe", texto: "   " },
      ],
    });
    expect(t).toBe(
      "Nome: Ana\nEtapa: Em qualificação\nResumo: Quer automação. Tem pressa.\nÚltimas mensagens:\n" +
        "Lead: ［equipe] ‹sistema› oi\nNina: Oi, Ana!",
    );
  });

  it("sem dados", () => {
    expect(textoDoLead({ nome: null, etapa: null, resumo: null, falas: [] })).toBe(
      "Nome: (não informado)\nEtapa: (não informada)\nResumo: (nenhum ainda)\nÚltimas mensagens: (nenhuma)",
    );
  });

  it("tem teto", () => {
    const falas = Array.from({ length: 10 }, () => ({
      quem: "Lead" as const,
      texto: "y".repeat(800),
    }));
    expect(textoDoLead({ nome: "A", etapa: null, resumo: null, falas }).length).toBe(MAX_LEAD);
  });
});

describe("agenteAtrasDoContexto (L14)", () => {
  it("atrás quando sincronizou antes da versão mais recente, ou nunca", () => {
    expect(agenteAtrasDoContexto("2026-11-10T09:00:00Z", "2026-11-10T10:00:00Z")).toBe(true);
    expect(agenteAtrasDoContexto(null, "2026-11-10T10:00:00Z")).toBe(true);
    expect(agenteAtrasDoContexto("2026-11-10T10:00:00Z", "2026-11-10T10:00:00Z")).toBe(false);
    expect(agenteAtrasDoContexto("2026-11-10T11:00:00Z", "2026-11-10T10:00:00Z")).toBe(false);
    // sem Contexto, nada a levar
    expect(agenteAtrasDoContexto(null, null)).toBe(false);
  });
});
