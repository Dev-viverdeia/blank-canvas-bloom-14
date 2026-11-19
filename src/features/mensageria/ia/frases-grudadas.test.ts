// O espaço que o modelo esquece entre duas frases da mesma bolha ("desconto.Se tiver"), visto no
// Haiku em 12/11/2026: o lead recebia as frases grudadas.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

const { bolhasDaFerramenta, bolhasDoTexto, separarFrasesGrudadas } = await import("./responder.server");

describe("frases grudadas na bolha", () => {
  it("põe o espaço depois de ponto, exclamação e interrogação", () => {
    expect(separarFrasesGrudadas("total de R$ 450 antes de qualquer desconto.Se tiver condição")).toBe(
      "total de R$ 450 antes de qualquer desconto. Se tiver condição",
    );
    expect(separarFrasesGrudadas("Fechado!Te mando o link.Quer o Pix?Ótimo")).toBe(
      "Fechado! Te mando o link. Quer o Pix? Ótimo",
    );
  });

  it("não mexe em número, link, sigla nem no que já está certo", () => {
    for (const intacto of [
      "Dá R$ 1.042 no total.",
      "Fonte: https://www.cxtrends.com.br/ e www.Site.com.br",
      "Atendo no WhatsApp. Pode me ligar.",
      "Use o e-mail contato@Empresa.com",
      "Segue o CNPJ 12.345.678/0001-90.",
    ]) {
      expect(separarFrasesGrudadas(intacto)).toBe(intacto);
    }
  });

  it("vale para as bolhas da ferramenta e para o texto final", () => {
    const chamadas = [
      {
        passo: 0,
        ferramenta: "responder",
        entrada: { bolhas: ["Anotei.Fica pronto amanhã.", "  Valeu!  "] },
        resultado: { ok: true },
      },
    ];
    expect(bolhasDaFerramenta(chamadas as never)).toEqual(["Anotei. Fica pronto amanhã.", "Valeu!"]);
    expect(bolhasDoTexto("Oi.Tudo bem?\n\nPode mandar.")).toEqual(["Oi. Tudo bem?", "Pode mandar."]);
  });
});
