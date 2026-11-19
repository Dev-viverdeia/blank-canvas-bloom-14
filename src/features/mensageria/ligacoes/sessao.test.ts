// @vitest-environment node
import { describe, expect, it } from "vitest";

import { assinarSessao, lerSessao } from "./sessao";
import { FOLGA_LIGACAO_S, SESSAO_VALIDA_S, validadeDaSessao } from "./tipos";

const TOKEN = "token-da-ligacao-0123456789abcdef0123456789abcdef";
const CONVERSA = "11111111-2222-4333-8444-555555555555";
const AGORA = 1_800_000_000;

describe("token de sessão", () => {
  it("assina e lê de volta a conversa e o id da ElevenLabs", async () => {
    const t = await assinarSessao(TOKEN, CONVERSA, "conv_abc123", AGORA);
    expect(t).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    expect(await lerSessao(TOKEN, t, AGORA + 60)).toEqual({
      conversaId: CONVERSA,
      conversaEleven: "conv_abc123",
      expiraEm: AGORA + SESSAO_VALIDA_S,
    });
  });

  it("o formato do corpo é o da spec: {v, c, l, e} em base64url", async () => {
    const t = await assinarSessao(TOKEN, CONVERSA, "conv_abc123", AGORA);
    const corpo = t.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/");
    expect(JSON.parse(atob(corpo))).toEqual({
      v: 1,
      c: CONVERSA,
      l: "conv_abc123",
      e: AGORA + SESSAO_VALIDA_S,
    });
  });

  it("sem validade, vale a ligação mais longa (30 min) mais a folga: o lead que pede uma pessoa aos 29 min passa", async () => {
    const t = await assinarSessao(TOKEN, CONVERSA, "conv_abc123", AGORA);
    expect(await lerSessao(TOKEN, t, AGORA + 29 * 60)).not.toBeNull();
    expect(await lerSessao(TOKEN, t, AGORA + SESSAO_VALIDA_S - 1)).not.toBeNull();
    expect(await lerSessao(TOKEN, t, AGORA + SESSAO_VALIDA_S)).toBeNull();
  });

  it("com a validade do agente: a duração máxima dele mais a folga, nunca acima do teto", async () => {
    expect(validadeDaSessao(600)).toBe(600 + FOLGA_LIGACAO_S);
    expect(validadeDaSessao(null)).toBe(SESSAO_VALIDA_S);
    expect(validadeDaSessao(99_999)).toBe(SESSAO_VALIDA_S);
    const t = await assinarSessao(TOKEN, CONVERSA, "conv_abc123", AGORA, validadeDaSessao(600));
    expect(await lerSessao(TOKEN, t, AGORA + 600 + FOLGA_LIGACAO_S - 1)).not.toBeNull();
    expect(await lerSessao(TOKEN, t, AGORA + 600 + FOLGA_LIGACAO_S)).toBeNull();
    const longa = await assinarSessao(TOKEN, CONVERSA, "conv_abc123", AGORA, 99_999);
    expect(await lerSessao(TOKEN, longa, AGORA)).toMatchObject({
      expiraEm: AGORA + SESSAO_VALIDA_S,
    });
  });

  it("recusa outra chave, assinatura mexida, corpo trocado e lixo", async () => {
    const t = await assinarSessao(TOKEN, CONVERSA, "conv_abc123", AGORA);
    expect(await lerSessao("outro-token", t, AGORA)).toBeNull();
    const [corpo, assinatura] = t.split(".") as [string, string];
    const virada = (assinatura[0] === "a" ? "b" : "a") + assinatura.slice(1);
    expect(await lerSessao(TOKEN, `${corpo}.${virada}`, AGORA)).toBeNull();
    const outra = await assinarSessao(
      TOKEN,
      "99999999-2222-4333-8444-555555555555",
      "conv_x1234",
      AGORA,
    );
    expect(await lerSessao(TOKEN, `${outra.split(".")[0]}.${assinatura}`, AGORA)).toBeNull();
    for (const lixo of ["", "a.b", "a.b.c", null, undefined, "x".repeat(2000)]) {
      expect(await lerSessao(TOKEN, lixo, AGORA)).toBeNull();
    }
    expect(await lerSessao(undefined, t, AGORA)).toBeNull();
    expect(await lerSessao("", t, AGORA)).toBeNull();
  });

  it("recusa validade maior do que a que o servidor dá", async () => {
    // assinado "no futuro": e = agora + 15 min + 1 h
    const t = await assinarSessao(TOKEN, CONVERSA, "conv_abc123", AGORA + 3600);
    expect(await lerSessao(TOKEN, t, AGORA)).toBeNull();
  });
});
