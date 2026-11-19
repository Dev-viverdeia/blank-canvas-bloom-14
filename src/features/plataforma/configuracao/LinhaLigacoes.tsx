import { cx } from "@/components/subido";
import { s as lista } from "@/features/onboarding/lista";

import { AtalhoArea } from "../comum/AtalhoArea";
import { c } from "./estilos";
import { ICX, Ic } from "./pecas";

/** O que a linha diz sobre a área nova. */
export const TEXTO_LINHA_LIGACOES =
  "A ativação, os agentes de voz e o histórico das ligações ficam na área Ligações, no menu.";

/**
 * As ligações pelo WhatsApp na Configuração (L1 e 2.3): o cartão saiu para a
 * área Ligações; aqui fica uma linha com o atalho "Abrir Ligações", no lugar dele (depois da Voz).
 */
export function LinhaLigacoes({ oculto }: { oculto: boolean }) {
  return (
    <section
      id="cfg-linha-ligacoes"
      className={cx(c.cfCartao, c.cfBlk, oculto && c.cfOculto)}
      aria-labelledby="cfg-m-ligacoes cfg-h-ligacoes"
    >
      <header className={c.cfBlkCab}>
        <span className={lista.linhaIcone} aria-hidden="true">
          <Ic d={ICX.telefone} tamanho="g" />
        </span>
        <div className={c.cfBlkTitulo}>
          <p className={c.cfMeta} id="cfg-m-ligacoes">
            Ligações pelo WhatsApp
          </p>
          <h2 id="cfg-h-ligacoes" tabIndex={-1} className={c.cfBlkH}>
            Agora numa área própria
          </h2>
        </div>
        <AtalhoArea para="/app/ligacoes" variante="contorno" className={c.cfBtnC}>
          Abrir Ligações
        </AtalhoArea>
      </header>
      <p className={c.cfApoio}>{TEXTO_LINHA_LIGACOES}</p>
    </section>
  );
}
