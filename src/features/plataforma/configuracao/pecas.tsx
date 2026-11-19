import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Botao, cx } from "@/components/subido";
import { Icone, s as lista } from "@/features/onboarding/lista";
import { IC, type Provedor } from "@/features/onboarding/lista/dados";

import type { Transcritor } from "./dados";
import { c } from "./estilos";

/** Os ícones de traço do protótipo (viewBox 24) que o onboarding ainda não tem. */
export const ICX = {
  exclama: "M12 6v7M12 18h.01",
  check: "M20 6 9 17l-5-5",
  info: "M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0M12 16v-4M12 8h.01",
  relogio: "M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0M12 6v6l4 2",
  pulso: "M22 12h-4l-3 9L9 3l-3 9H2",
  menos: "M5 12h14",
  mais: "M12 5v14M5 12h14",
  fechar: "M18 6 6 18M6 6l12 12",
  /** O telefone do lucide (Phone), para o cartão das ligações. */
  telefone:
    "M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384",
} as const;

/** Ícone de traço (viewBox 24), decorativo. */
export function Ic({ d, tamanho = "n", className }: { d: string; tamanho?: "n" | "p" | "g"; className?: string | undefined }) {
  return (
    <svg
      className={cx(c.cfIc, tamanho === "p" && c.cfIcP, tamanho === "g" && c.cfIcG, className)}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {d ? <path d={d} /> : null}
    </svg>
  );
}

export type Tom = "ok" | "atencao" | "erro" | "info";

/** A linha de estado (texto + ícone, nunca só cor). Com `girando`, o giro no lugar do ícone. */
export function LinhaEstado({
  tom,
  icone,
  girando = false,
  children,
  vivo = false,
  className,
}: {
  tom?: Tom | undefined;
  icone: string;
  girando?: boolean | undefined;
  children: ReactNode;
  /** Anuncia a mudança (aria-live). */
  vivo?: boolean | undefined;
  className?: string | undefined;
}) {
  return (
    <p className={cx(c.cfEstado, className)} data-tom={tom} aria-live={vivo ? "polite" : undefined}>
      {girando ? <span className={c.cfGiro} aria-hidden="true" /> : <Ic d={icone} tamanho="p" />}
      <span>{children}</span>
    </p>
  );
}

/** O aviso do cartão: erro (vermelho), atenção (areia) ou informação (névoa). */
export function AvisoCartao({
  tom,
  icone,
  girando = false,
  titulo,
  children,
  papel,
}: {
  tom: "erro" | "atencao" | "info";
  icone?: string | undefined;
  girando?: boolean | undefined;
  titulo?: ReactNode;
  children?: ReactNode;
  papel?: "alert" | "status" | undefined;
}) {
  return (
    <div className={c.cfAviso} data-tom={tom} role={papel}>
      {girando ? <span className={c.cfGiro} aria-hidden="true" /> : <Ic d={icone ?? ""} />}
      <div className={c.cfAvisoCorpo}>
        {titulo ? <b>{titulo}</b> : null}
        {children}
      </div>
    </div>
  );
}

/**
 * O logo do gateway ou do motor num ladrilho que gira como a moeda da validação enquanto testa
 * (duas faces com o mesmo logo, o verso nunca espelhado). O nome vem escrito ao lado: o logo é
 * decoração.
 */
export function LogoMoeda({
  logo,
  escura,
  larga,
  gira = false,
}: {
  logo: string;
  escura?: boolean | undefined;
  larga?: boolean | undefined;
  gira?: boolean | undefined;
}) {
  const tile = cx(lista.logoTile, escura && lista.escura, larga && lista.larga);
  return (
    <span className={c.cfTilePalco} aria-hidden="true">
      <span className={c.cfTileMoeda} data-gira={gira || undefined}>
        <span className={tile}>
          <img src={logo} alt="" />
        </span>
        <span className={cx(tile, c.cfVerso)}>
          <img src={logo} alt="" />
        </span>
      </span>
    </span>
  );
}

/** O ladrilho do provedor do WhatsApp (o logo do onboarding). */
export function LogoGateway({ prov, gira }: { prov: Provedor; gira?: boolean | undefined }) {
  return <LogoMoeda logo={prov.logo} escura={prov.escura} larga={prov.larga} gira={gira} />;
}

/** O ladrilho de quem transcreve: o logo, ou o monograma "G" da Groq (sem logo enviado). */
export function LogoTranscritor({ t, mini = false }: { t: Transcritor; mini?: boolean | undefined }) {
  return (
    <span className={cx(lista.logoTile, mini && lista.mini)} aria-hidden="true">
      {t.logo ? (
        <img src={t.logo} alt="" />
      ) : (
        <span className={c.cfMonoLogo} data-mini={mini || undefined}>
          G
        </span>
      )}
    </span>
  );
}

/**
 * A linha da lista do fluxo (cópia da Linha do onboarding): os selos ("Fácil", "Em uso") vão ao
 * lado do nome, como no protótipo, em vez de numa terceira linha abaixo da frase.
 */
export function LinhaFluxo({
  id,
  inicio,
  nome,
  frase,
  selos,
  aoEscolher,
}: {
  id: string;
  inicio: ReactNode;
  nome: string;
  frase: string;
  selos?: ReactNode;
  aoEscolher: () => void;
}) {
  return (
    <button type="button" id={id} className={lista.linha} onClick={aoEscolher}>
      {inicio}
      <span className={lista.linhaTexto}>
        <span className={cx(lista.linhaNome, c.cfLinhaNome)}>
          <span>{nome}</span>
          {selos}
        </span>
        <span className={lista.linhaFrase}>{frase}</span>
      </span>
      <Icone d={IC.chevronDireita} className={lista.linhaSeta} />
    </button>
  );
}

/** Uma linha do quadro de detalhes do cartão. */
export function LinhaDl({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  return (
    <div className={c.cfDlLinha}>
      <dt>{rotulo}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export interface PropsDialogo {
  titulo: string;
  texto: string;
  /** O botão de perigo ("Desconectar", "Remover"). */
  acao: string;
  aoCancelar: () => void;
  aoConfirmar: () => void;
}

/** A confirmação de uma ação que para alguma peça: o foco preso, Esc e o véu cancelam. */
export function DialogoConfirmar({ titulo, texto, acao, aoCancelar, aoConfirmar }: PropsDialogo) {
  const caixa = useRef<HTMLElement>(null);
  useEffect(() => {
    const t = setTimeout(() => document.getElementById("cfg-dlg-cancelar")?.focus({ preventScroll: true }), 30);
    return () => clearTimeout(t);
  }, []);

  const tecla = (ev: KeyboardEvent<HTMLElement>) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      aoCancelar();
      return;
    }
    if (ev.key !== "Tab" || !caixa.current) return;
    const bts = caixa.current.querySelectorAll<HTMLButtonElement>("button");
    if (!bts.length) return;
    const primeiro = bts[0]!;
    const ultimo = bts[bts.length - 1]!;
    if (ev.shiftKey && document.activeElement === primeiro) {
      ev.preventDefault();
      ultimo.focus();
    } else if (!ev.shiftKey && document.activeElement === ultimo) {
      ev.preventDefault();
      primeiro.focus();
    }
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    // o véu vai para o <body>, fora do [data-identidade] da página: leva a identidade para herdar a fonte
    <div className={c.cfVeu} data-identidade="subido" onClick={aoCancelar}>
      <section
        ref={caixa}
        className={c.cfDialogo}
        role="alertdialog"
        aria-modal="true"
        tabIndex={-1}
        aria-labelledby="cfg-dlg-titulo"
        aria-describedby="cfg-dlg-texto"
        onKeyDown={tecla}
        onClick={(ev) => ev.stopPropagation()}
      >
        <h2 id="cfg-dlg-titulo" className={c.cfHCartao}>
          {titulo}
        </h2>
        <p id="cfg-dlg-texto" className={c.cfDialogoTexto}>
          {texto}
        </p>
        <div className={c.cfDialogoAcoes}>
          <Botao id="cfg-dlg-cancelar" variante="contorno" onClick={aoCancelar}>
            Cancelar
          </Botao>
          <Botao variante="perigo" onClick={aoConfirmar}>
            {acao}
          </Botao>
        </div>
      </section>
    </div>,
    document.body,
  );
}
