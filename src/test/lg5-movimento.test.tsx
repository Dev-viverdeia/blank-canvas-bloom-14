import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONTAGEM_MS,
  Equalizador,
  useContagem,
  useMovimentoReduzido,
} from "@/features/plataforma/comum/AoVivo";

// O movimento da área Ligações (2.3): os números contam até o valor, e
// com prefers-reduced-motion vão direto; a área lê a preferência (e acompanha a troca) para marcar
// a raiz. Sem o mock do movimentoReduzido: aqui vale o matchMedia.

type Ouvinte = () => void;

/** O matchMedia de prefers-reduced-motion, com a troca que o sistema avisa. */
function preferencia(reduzir: boolean) {
  const ouvintes = new Set<Ouvinte>();
  const estado = { reduzir };
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      get matches() {
        return query.includes("prefers-reduced-motion") && estado.reduzir;
      },
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_: string, f: Ouvinte) => ouvintes.add(f),
      removeEventListener: (_: string, f: Ouvinte) => ouvintes.delete(f),
      dispatchEvent: () => false,
    }),
  });
  return {
    mudar(v: boolean) {
      estado.reduzir = v;
      for (const f of ouvintes) f();
    },
  };
}

afterEach(() => {
  cleanup();
  preferencia(false);
});

describe("a contagem dos números", () => {
  it("com movimento: conta de zero até o valor, sem pular direto", async () => {
    preferencia(false);
    const vistos: number[] = [];
    const { result } = renderHook(() => {
      const n = useContagem(40);
      vistos.push(n);
      return n;
    });
    await waitFor(() => expect(result.current).toBe(40), { timeout: CONTAGEM_MS * 4 });
    // passou por valores do meio
    expect(vistos.some((n) => n > 0 && n < 40)).toBe(true);
    expect(vistos).toContain(0);
  });

  it("com movimento reduzido: o valor final de primeira, também quando muda", () => {
    preferencia(true);
    const vistos: number[] = [];
    const { result, rerender } = renderHook(
      ({ alvo }) => {
        const n = useContagem(alvo);
        vistos.push(n);
        return n;
      },
      { initialProps: { alvo: 12 } },
    );
    expect(result.current).toBe(12);
    rerender({ alvo: 30 });
    expect(result.current).toBe(30);
    expect(vistos.every((n) => n === 12 || n === 30)).toBe(true);
  });
});

describe("a preferência de movimento", () => {
  it("lê depois de montar e acompanha a troca do sistema", () => {
    const sistema = preferencia(false);
    const { result } = renderHook(() => useMovimentoReduzido());
    expect(result.current).toBe(false);
    act(() => sistema.mudar(true));
    expect(result.current).toBe(true);
    act(() => sistema.mudar(false));
    expect(result.current).toBe(false);
  });
});

describe("o equalizador", () => {
  it("é decoração: fica fora da leitura de tela", () => {
    render(
      <p>
        Em andamento <Equalizador />
      </p>,
    );
    const eq = document.querySelector("[data-equalizador]")!;
    expect(eq).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Em andamento")).toBeInTheDocument();
  });
});
