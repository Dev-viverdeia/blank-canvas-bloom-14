import { useRouter } from "@tanstack/react-router";
import type { ComponentProps, MouseEvent } from "react";

import { AncoraBotao } from "@/components/subido";

import type { Area } from "../areas";

type PropsAtalho = Omit<ComponentProps<typeof AncoraBotao>, "href" | "onClick"> & {
  /** A rota da área (`/app/ligacoes`, `/app/contexto`…). */
  para: Area["rota"];
};

/**
 * Um atalho para outra área, com a cara de botão: um <a> de verdade (abre em outra aba, o leitor de
 * tela anuncia link) que, dentro do roteador, troca de área sem recarregar. Fora do roteador (uma tela
 * montada sozinha num teste), fica só o link.
 */
export function AtalhoArea({ para, ...resto }: PropsAtalho) {
  const router = useRouter({ warn: false });
  const clicar = (ev: MouseEvent<HTMLAnchorElement>) => {
    if (
      !router ||
      ev.defaultPrevented ||
      ev.button !== 0 ||
      ev.metaKey ||
      ev.ctrlKey ||
      ev.shiftKey ||
      ev.altKey
    )
      return;
    ev.preventDefault();
    void router.navigate({ to: para });
  };
  return <AncoraBotao {...resto} href={para} onClick={clicar} />;
}
