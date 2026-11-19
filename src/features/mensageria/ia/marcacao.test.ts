import { describe, expect, it } from "vitest";

import { bolhasDaMarcacao, temMarcacaoDeFerramenta } from "./marcacao";

// As tags são montadas por partes para o próprio arquivo de teste não parecer uma chamada.
const abre = (nome: string, attrs = "") => `<${nome}${attrs ? " " + attrs : ""}>`;
const fecha = (nome: string) => `</${nome}>`;
const chamada = (bolhas: string, prefixo = "") =>
  abre(`${prefixo}invoke`, 'name="responder"') +
  "\n" +
  abre(`${prefixo}parameter`, 'name="bolhas"') +
  bolhas +
  fecha(`${prefixo}parameter`) +
  "\n" +
  fecha(`${prefixo}invoke`);

// O texto que vazou no teste de 12/11/2026: a chamada de "responder" escrita como texto.
const VAZOU = chamada(
  '["Não, Fábio, integração com o Google Agenda não é o que eu faço hoje.", "Eu anoto o horário e entrego pronto."]',
);

describe("marcação de ferramenta escrita como texto", () => {
  it("reconhece as formas que o modelo escreve", () => {
    expect(temMarcacaoDeFerramenta(VAZOU)).toBe(true);
    expect(temMarcacaoDeFerramenta(abre("invoke", 'name="responder"'))).toBe(true);
    expect(temMarcacaoDeFerramenta(abre("function_calls"))).toBe(true);
    expect(temMarcacaoDeFerramenta(fecha("parameter"))).toBe(true);
    expect(temMarcacaoDeFerramenta(abre("tool_call") + "{}" + fecha("tool_call"))).toBe(true);
    expect(temMarcacaoDeFerramenta(chamada('["oi"]', "x:"))).toBe(true);
  });

  it("não confunde texto comum com marcação", () => {
    expect(temMarcacaoDeFerramenta("Oi! Tudo bem?")).toBe(false);
    expect(temMarcacaoDeFerramenta("3 < 5 e o parâmetro foi invocado")).toBe(false);
    expect(temMarcacaoDeFerramenta(abre("b") + "negrito" + fecha("b"))).toBe(false);
  });

  it("tira as bolhas que o modelo quis mandar", () => {
    expect(bolhasDaMarcacao(VAZOU)).toEqual([
      "Não, Fábio, integração com o Google Agenda não é o que eu faço hoje.",
      "Eu anoto o horário e entrego pronto.",
    ]);
    expect(bolhasDaMarcacao("Claro! " + chamada('[" oi ", ""]'))).toEqual(["oi"]);
    expect(bolhasDaMarcacao(chamada('["com prefixo"]', "x:"))).toEqual(["com prefixo"]);
  });

  it("devolve null quando não dá para tirar com segurança", () => {
    expect(bolhasDaMarcacao(abre("invoke", 'name="responder"'))).toBeNull();
    expect(bolhasDaMarcacao(chamada("oi, sem JSON"))).toBeNull();
    expect(bolhasDaMarcacao(chamada('{"bolhas": "não é lista"}'))).toBeNull();
    expect(bolhasDaMarcacao(chamada("[]"))).toBeNull();
    expect(bolhasDaMarcacao(chamada(JSON.stringify(["ok", fecha("parameter")])))).toBeNull();
  });
});
