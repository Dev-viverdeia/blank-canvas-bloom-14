// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { comContextoDeExecucao, emSegundoPlano } from "./segundo-plano";

describe("emSegundoPlano", () => {
  it("entrega a promessa ao waitUntil do contexto da requisição, sem rejeitar", async () => {
    const waitUntil = vi.fn();
    const falha = Promise.reject(new Error("x"));
    comContextoDeExecucao({ waitUntil }, () => emSegundoPlano(falha));
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await expect(waitUntil.mock.calls[0]![0]).resolves.toBeUndefined();
  });

  it("sem contexto (testes, Node), a promessa só corre", async () => {
    let correu = false;
    emSegundoPlano(
      Promise.resolve().then(() => {
        correu = true;
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(correu).toBe(true);
  });

  it("um waitUntil que lança não derruba quem chamou", () => {
    const waitUntil = () => {
      throw new Error("fora da requisição");
    };
    expect(() =>
      comContextoDeExecucao({ waitUntil }, () => emSegundoPlano(Promise.resolve())),
    ).not.toThrow();
  });
});
