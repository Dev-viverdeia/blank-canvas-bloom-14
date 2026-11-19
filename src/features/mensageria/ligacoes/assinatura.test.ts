// @vitest-environment node
import { describe, expect, it } from "vitest";

import { assinarPosChamada, assinaturaPosChamadaConfere, bearerConfere } from "./assinatura";
import { TOLERANCIA_ASSINATURA_S } from "./tipos";

const SEGREDO = "wsec_segredo-do-webhook-0123456789";
const AGORA = 1_800_000_000;
const CORPO = JSON.stringify({ type: "post_call_transcription", data: { agent_id: "agent_1" } });

describe("Bearer", () => {
  it("confere só o valor exato", () => {
    expect(bearerConfere("Bearer abc123", "abc123")).toBe(true);
    expect(bearerConfere("Bearer abc124", "abc123")).toBe(false);
    expect(bearerConfere("bearer abc123", "abc123")).toBe(false);
    expect(bearerConfere("abc123", "abc123")).toBe(false);
    expect(bearerConfere(null, "abc123")).toBe(false);
    expect(bearerConfere("Bearer ", "")).toBe(false);
    expect(bearerConfere("Bearer undefined", undefined)).toBe(false);
  });
});

describe("ElevenLabs-Signature", () => {
  it("confere a assinatura do corpo cru dentro da tolerância", async () => {
    const cab = await assinarPosChamada(SEGREDO, CORPO, AGORA);
    expect(cab).toMatch(/^t=\d+,v0=[0-9a-f]{64}$/);
    expect(await assinaturaPosChamadaConfere(cab, CORPO, SEGREDO, AGORA)).toBe(true);
    expect(
      await assinaturaPosChamadaConfere(cab, CORPO, SEGREDO, AGORA + TOLERANCIA_ASSINATURA_S),
    ).toBe(true);
    expect(
      await assinaturaPosChamadaConfere(cab, CORPO, SEGREDO, AGORA - TOLERANCIA_ASSINATURA_S),
    ).toBe(true);
  });

  it("recusa fora da tolerância, outro corpo, outro segredo e cabeçalho torto", async () => {
    const cab = await assinarPosChamada(SEGREDO, CORPO, AGORA);
    expect(
      await assinaturaPosChamadaConfere(cab, CORPO, SEGREDO, AGORA + TOLERANCIA_ASSINATURA_S + 1),
    ).toBe(false);
    expect(await assinaturaPosChamadaConfere(cab, `${CORPO} `, SEGREDO, AGORA)).toBe(false);
    expect(await assinaturaPosChamadaConfere(cab, CORPO, "outro", AGORA)).toBe(false);
    expect(await assinaturaPosChamadaConfere(cab, CORPO, undefined, AGORA)).toBe(false);
    expect(await assinaturaPosChamadaConfere(null, CORPO, SEGREDO, AGORA)).toBe(false);
    expect(await assinaturaPosChamadaConfere(`t=${AGORA}`, CORPO, SEGREDO, AGORA)).toBe(false);
    expect(await assinaturaPosChamadaConfere(`${cab},t=${AGORA}`, CORPO, SEGREDO, AGORA)).toBe(
      false,
    );
    expect(await assinaturaPosChamadaConfere("x".repeat(600), CORPO, SEGREDO, AGORA)).toBe(false);
  });

  it("aceita a certa no meio de outras (troca de segredo)", async () => {
    const cab = await assinarPosChamada(SEGREDO, CORPO, AGORA);
    const v0 = cab.split(",")[1]!;
    const falsa = `v0=${"0".repeat(64)}`;
    expect(
      await assinaturaPosChamadaConfere(`t=${AGORA},${falsa},${v0}`, CORPO, SEGREDO, AGORA),
    ).toBe(true);
    expect(await assinaturaPosChamadaConfere(`t=${AGORA},${falsa}`, CORPO, SEGREDO, AGORA)).toBe(
      false,
    );
  });
});
