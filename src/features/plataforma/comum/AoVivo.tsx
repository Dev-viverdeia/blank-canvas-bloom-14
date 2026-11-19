import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { movimentoReduzido } from "@/components/nina/VooNina";
import { cx, type Classes } from "@/components/subido/cx";

import { duracaoCurta } from "../ligacoes/tipos";
import estilos from "./AoVivo.module.css";

// As peças da ligação viva (L23), no Histórico, no topo da área Ligações
// e no bloco da ligação no Chat: o equalizador, o tempo correndo e a contagem suave dos números.

const s = estilos as Classes<"avEq">;

/** As barras de voz da ligação em andamento. Decoração: quem lê a tela ouve "Em andamento". */
export function Equalizador({
  tamanho = "p",
  className,
}: {
  tamanho?: "p" | "g" | undefined;
  className?: string | undefined;
}) {
  return (
    <span
      className={cx(s.avEq, className)}
      data-tamanho={tamanho}
      data-equalizador=""
      aria-hidden="true"
    >
      <i />
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

/** O tempo da ligação em andamento, segundo a segundo, desde o começo. */
export function TempoCorrendo({ desde }: { desde: string }) {
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setAgora(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const seg = Math.max(0, Math.floor((agora - Date.parse(desde)) / 1000));
  return (
    <span role="timer" aria-live="off" data-tempo-correndo="">
      {duracaoCurta(seg)} até agora
    </span>
  );
}

/** Quanto dura a contagem dos números (de onde estavam até o valor novo). */
export const CONTAGEM_MS = 420;

/**
 * O número que a tela mostra, contando suave até `alvo`: na primeira vez, de zero; depois, do valor
 * que estava. Com movimento reduzido (ou sem requestAnimationFrame), vai direto ao valor. O primeiro
 * desenho já é o valor final (o servidor e quem não anima veem o número certo).
 */
export function useContagem(alvo: number): number {
  const [mostrado, setMostrado] = useState(alvo);
  /** O que está na tela agora; null = ainda não contou nenhuma vez. */
  const atual = useRef<number | null>(null);
  useLayoutEffect(() => {
    const de = atual.current ?? 0;
    const mostrar = (n: number) => {
      atual.current = n;
      setMostrado(n);
    };
    if (de === alvo || movimentoReduzido() || typeof requestAnimationFrame === "undefined") {
      mostrar(alvo);
      return;
    }
    const inicio = performance.now();
    let quadro = 0;
    const passo = (t: number) => {
      const p = Math.min(1, Math.max(0, (t - inicio) / CONTAGEM_MS));
      const suave = 1 - (1 - p) ** 3;
      mostrar(Math.round(de + (alvo - de) * suave));
      if (p < 1) quadro = requestAnimationFrame(passo);
    };
    mostrar(de);
    quadro = requestAnimationFrame(passo);
    return () => cancelAnimationFrame(quadro);
  }, [alvo]);
  return mostrado;
}

/**
 * O movimento reduzido do sistema (prefers-reduced-motion), lido depois de montar e acompanhando a
 * troca. A área marca a raiz com ele: o CSS desliga as animações também por aqui.
 */
export function useMovimentoReduzido(): boolean {
  const [reduzido, setReduzido] = useState(false);
  useEffect(() => {
    setReduzido(movimentoReduzido());
    const consulta =
      typeof window !== "undefined"
        ? window.matchMedia?.("(prefers-reduced-motion: reduce)")
        : null;
    if (!consulta?.addEventListener) return;
    const mudar = () => setReduzido(movimentoReduzido());
    consulta.addEventListener("change", mudar);
    return () => consulta.removeEventListener("change", mudar);
  }, []);
  return reduzido;
}
