import { Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Selo } from "@/components/subido";

import { l } from "./estilos";
import { TEXTO_SELO, TEXTO_USO, type SeloLigacao, type UsoAgente } from "./tipos";

// As peças pequenas da área Ligações: o selo da ligação, o +/− (no estilo do Ritmo da Configuração) e
// o aviso curto (o toast da Configuração); e o selo do uso do agente (Receptiva ou Ativa).

export function SeloDaLigacao({ selo }: { selo: SeloLigacao }) {
  return (
    <span className={l.lgSelo} data-selo={selo}>
      {TEXTO_SELO[selo]}
    </span>
  );
}

/**
 * O selo do uso do agente (A1): "Receptiva" ou "Ativa" na tela, e a
 * explicação curta para o leitor de tela ("recebe as ligações do número" / "faz ligações"). A aba
 * Agentes e a janela do "Ligar" da conversa usam.
 */
export function SeloUso({ uso }: { uso: UsoAgente }) {
  const t = TEXTO_USO[uso];
  return (
    <Selo tom={uso === "receber" ? "menta" : "areia"} compacto>
      <span data-selo-uso={uso}>
        {t.nome}
        <span className={l.lgSr}>: {t.curto}</span>
      </span>
    </Selo>
  );
}

interface PropsPasso {
  id: string;
  rotulo: string;
  valor: number;
  /** O que aparece no lugar do número ("10 min"); sem ele, o número e a `unidade`. */
  texto?: { numero: string; unidade: string } | undefined;
  unidade?: string | undefined;
  ajuda?: string | undefined;
  noMinimo: boolean;
  noMaximo: boolean;
  menosAria: string;
  maisAria: string;
  aoMudar: (sinal: 1 | -1) => void;
}

/**
 * Um valor com − e + (o Ritmo da Configuração). No limite, o botão fica com aria-disabled e não
 * disabled: o foco continua nele (não cai no body).
 */
export function Passo({
  id,
  rotulo,
  valor,
  texto,
  unidade = "",
  ajuda,
  noMinimo,
  noMaximo,
  menosAria,
  maisAria,
  aoMudar,
}: PropsPasso) {
  return (
    <div className={l.lgReg} role="group" aria-labelledby={`${id}-rotulo`}>
      <p className={l.lgRegRotulo} id={`${id}-rotulo`}>
        {rotulo}
      </p>
      <div className={l.lgRegLinha}>
        <button
          type="button"
          className={l.lgBtnIcone}
          aria-disabled={noMinimo || undefined}
          aria-label={menosAria}
          onClick={() => {
            if (!noMinimo) aoMudar(-1);
          }}
        >
          <Minus size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <p className={l.lgRegValor} aria-live="polite" data-testid={`${id}-valor`}>
          <span className={l.lgRegNum}>{texto ? texto.numero : valor}</span>
          <span className={l.lgRegUn}>{texto ? texto.unidade : unidade}</span>
        </p>
        <button
          type="button"
          className={l.lgBtnIcone}
          aria-disabled={noMaximo || undefined}
          aria-label={maisAria}
          onClick={() => {
            if (!noMaximo) aoMudar(1);
          }}
        >
          <Plus size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      {ajuda ? <p className={l.lgAjuda}>{ajuda}</p> : null}
    </div>
  );
}

export type TomAvisoCurto = "ok" | "info" | "erro";
type AvisoCurto = { texto: string; tom: TomAvisoCurto; id: number } | null;

/** Quanto o aviso curto fica na tela (o da Configuração). */
export const AVISO_MS = 4500;

/** O aviso curto da área: `avisar(texto)` mostra; some sozinho. */
export function useAvisoCurto(): {
  aviso: AvisoCurto;
  avisar: (texto: string, tom?: TomAvisoCurto) => void;
} {
  const [aviso, setAviso] = useState<AvisoCurto>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const avisar = useCallback((texto: string, tom: TomAvisoCurto = "ok") => {
    if (timer.current) clearTimeout(timer.current);
    seq.current += 1;
    setAviso({ texto, tom, id: seq.current });
    timer.current = setTimeout(() => {
      timer.current = null;
      setAviso(null);
    }, AVISO_MS);
  }, []);
  return { aviso, avisar };
}

/** O aviso na tela (fora da área, por portal) e o mesmo texto para o leitor de tela. */
export function AvisoNaTela({ aviso }: { aviso: AvisoCurto }) {
  return (
    <>
      <p className={l.lgSr} role="status" aria-live="polite">
        {aviso?.texto ?? ""}
      </p>
      {aviso && typeof document !== "undefined"
        ? createPortal(
            // fora do [data-identidade] da página: o contêiner leva a identidade para herdar a fonte
            <div data-identidade="subido" key={aviso.id}>
              <div
                className={l.lgToast}
                data-tom={aviso.tom}
                aria-hidden="true"
                data-aviso-ligacoes=""
              >
                {aviso.texto}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
