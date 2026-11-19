import { Botao, cx } from "@/components/subido";
import { s as lista } from "@/features/onboarding/lista";
import { IC } from "@/features/onboarding/lista/dados";

import { Carregando, ErroLeitura } from "../dados/estados";
import type { AjusteLembrete, Leitura } from "../dados/tipos";
import { LIMITES_RITMO } from "../exemplo";
import { c } from "./estilos";
import { ICX, Ic, LinhaEstado } from "./pecas";

export interface Ritmo {
  espera: number;
  teto: number;
}

/** O passo de cada ajuste: a espera anda de 1 em 1 s, o teto de 5 em 5 s. */
export const PASSO_RITMO = { espera: 1, teto: 5 } as const;

/** Muda o rascunho dentro dos limites (o teto fica sempre 5 s acima da espera). */
export function mudarRitmo(r: Ritmo, campo: keyof Ritmo, delta: number): Ritmo {
  const { espera: E, teto: T, folga } = LIMITES_RITMO;
  if (campo === "espera") return { ...r, espera: Math.max(E.min, Math.min(Math.min(E.max, r.teto - folga), r.espera + delta)) };
  return { ...r, teto: Math.max(Math.max(T.min, r.espera + folga), Math.min(T.max, r.teto + delta)) };
}

/** As horas do lembrete vão de 1 a 23 (cópia do `LIMITES_RITMO.lembreteHoras` do servidor, como o ritmo). */
export const LIMITES_LEMBRETE = { min: 1, max: 23 } as const;

/** Muda as horas do rascunho do lembrete dentro dos limites, sem tocar no interruptor. */
export function mudarHoras(a: AjusteLembrete, delta: 1 | -1): AjusteLembrete {
  const { min, max } = LIMITES_LEMBRETE;
  return { ...a, horas: Math.max(min, Math.min(max, a.horas + delta)) };
}

const AJUDA_LIGADO = "Se o lead não responder à Nina nesse tempo, ela manda um lembrete. Uma vez só, entre 8h e 20h.";
const AJUDA_DESLIGADO = "A Nina não lembra quem parou de responder. Os retornos combinados com o lead continuam valendo.";

/** O símbolo da Nina pequeno e parado (o da linha do tempo e da legenda). */
function NinaPequena({ tamanho }: { tamanho: number }) {
  return (
    <svg width={tamanho} height={tamanho} viewBox="0 0 48 48" aria-hidden="true" style={{ display: "block", flex: "none" }}>
      <circle cx="24" cy="24" r="24" fill="var(--sb-navy)" />
      <path d="M24 13a11 11 0 1 1 0 22H13V24a11 11 0 0 1 11-11z" fill="var(--sb-azul)" />
    </svg>
  );
}

/**
 * A linha do tempo do "Ver como funciona": o lead manda 3 mensagens em 5 s e a Nina responde
 * depois da espera (ou no teto). Eixo quebrado: os primeiros segundos em escala real, um corte
 * "…" e o teto no fim.
 */
function LinhaDoTempo({ r }: { r: Ritmo }) {
  const ultimo = 5;
  const resp = Math.min(ultimo + r.espera, r.teto);
  const L = Math.max(16, resp + 3);
  const ESCALA = 80;
  const corte = resp < r.teto && r.teto > L + 6;
  const pct = (x: number) =>
    corte ? (x >= r.teto ? 100 : Math.min(ESCALA, (x / L) * ESCALA)) : Math.max(0, Math.min(100, (x / r.teto) * 100));
  const f2 = (n: number) => n.toFixed(2);
  const pIni = pct(ultimo);
  const pResp = pct(resp);
  const legenda = `Exemplo: o lead manda 3 mensagens em 5 s. A Nina responde ${
    resp < r.teto ? `${resp} s depois da primeira.` : `no limite de ${r.teto} s.`
  }`;
  return (
    <figure className={c.cfTempo} id="cfg-tempo">
      <figcaption className={c.cfApoio}>{legenda}</figcaption>
      <div className={c.cfTempoTrilho} aria-hidden="true">
        <span className={c.cfTempoBase} />
        <span className={c.cfTgTeto} style={{ left: "100%" }} />
        {corte && (
          <span className={c.cfTgCorte} style={{ left: `${f2((ESCALA + 100) / 2)}%` }}>
            …
          </span>
        )}
        {[0, 3, 5].map((x) => (
          <span key={x} className={c.cfTgLead} style={{ left: `${f2(pct(x))}%` }} />
        ))}
        <span className={c.cfTgCapa} style={{ transform: `translateX(${f2(pIni)}%)` }}>
          <span className={c.cfTgEspLinha} style={{ transform: `scaleX(${((pResp - pIni) / 100).toFixed(4)})` }} />
          <span className={c.cfTgEspPe} />
          <span className={c.cfTgCapa} style={{ transform: `translateX(${f2(pResp - pIni)}%)` }}>
            <span className={c.cfTgEspPe} />
          </span>
          <span className={c.cfTgCapa} style={{ transform: `translateX(${f2((pResp - pIni) / 2)}%)` }}>
            <b className={c.cfTgEspRot}>{resp - ultimo} s</b>
          </span>
        </span>
        <span className={c.cfTgCapa} style={{ transform: `translateX(${f2(pResp)}%)` }}>
          <span className={c.cfTgNina}>
            <NinaPequena tamanho={22} />
          </span>
        </span>
      </div>
      <div className={c.cfTempoEscala} aria-hidden="true">
        <span className={c.cfEIni}>0 s</span>
        <span className={c.cfEMeio} style={{ left: `${corte ? ESCALA : 50}%` }}>
          {corte ? `${L} s` : `${Math.round(r.teto / 2)} s`}
        </span>
        <span className={c.cfEFim}>{r.teto} s</span>
      </div>
      <div className={c.cfTempoLegenda} aria-hidden="true">
        <span>
          <i className={c.cfLgLead} />
          Mensagem do lead
        </span>
        <span>
          <NinaPequena tamanho={12} />
          Resposta da Nina
        </span>
        <span>
          <i className={c.cfLgTeto} />
          Tempo máximo
        </span>
      </div>
    </figure>
  );
}

interface PropsRegulador {
  campo: string;
  valor: number;
  unidade: string;
  noMinimo: boolean;
  noMaximo: boolean;
  menosAria: string;
  maisAria: string;
  aoMenos: () => void;
  aoMais: () => void;
  admin: boolean;
}

/** O "− valor +" de um ajuste. A atendente só vê o valor, sem os botões. */
function Regulador(p: PropsRegulador) {
  // aria-disabled, não disabled: no limite o botão continua focado (o foco não cai no body)
  return (
    <div className={c.cfRegLinha}>
      {p.admin && (
        <button
          type="button"
          className={c.cfBtnIcone}
          aria-disabled={p.noMinimo || undefined}
          aria-label={p.menosAria}
          onClick={() => {
            if (p.noMinimo) return;
            p.aoMenos();
          }}
        >
          <Ic d={ICX.menos} tamanho="g" />
        </button>
      )}
      <p className={c.cfRegValor} aria-live="polite" data-testid={`cfg-valor-${p.campo}`}>
        <span className={c.cfRegNum}>{p.valor}</span>
        <span className={c.cfRegUn}>{p.unidade}</span>
      </p>
      {p.admin && (
        <button
          type="button"
          className={c.cfBtnIcone}
          aria-disabled={p.noMaximo || undefined}
          aria-label={p.maisAria}
          onClick={() => {
            if (p.noMaximo) return;
            p.aoMais();
          }}
        >
          <Ic d={ICX.mais} tamanho="g" />
        </button>
      )}
    </div>
  );
}

/** O lembrete que a tela passa ao cartão (opcional: sem ele, o cartão fica como era). */
export interface PropsLembrete {
  /** A leitura do ajuste salvo: carregando, erro ou dados. */
  leitura: Leitura<AjusteLembrete>;
  /** Admin: o rascunho ou, sem rascunho, o salvo. Atendente: o salvo. */
  atual: AjusteLembrete | undefined;
  /** O rascunho difere do salvo. */
  mudou: boolean;
  aoAlternar: () => void;
  aoMudarHoras: (delta: 1 | -1) => void;
}

interface Props {
  admin: boolean;
  salvo: Ritmo;
  rascunho: Ritmo;
  salvando: boolean;
  aoMudar: (campo: keyof Ritmo, delta: number) => void;
  aoDesfazer: () => void;
  aoSalvar: () => void;
  verTempo: boolean;
  aoAlternarTempo: () => void;
  realce: "flash" | "nasce" | null;
  oculto: boolean;
  /** A Nina está atendendo (a Saúde): sem isso, o estado sai do verde. */
  saudavel?: boolean | undefined;
  /** Só o atraso do motor (a Nina segue respondendo, com demora): "Atrasada agora", antes do `saudavel`. */
  atrasada?: boolean | undefined;
  /** O interruptor e as horas do lembrete automático (quadros 20 a 24). */
  lembrete?: PropsLembrete | undefined;
}

/** O 3º bloco, largo: "Lembrete para quem parou de responder" (o interruptor e as horas). */
function BlocoLembrete({ admin, salvando, lembrete }: { admin: boolean; salvando: boolean; lembrete: PropsLembrete }) {
  const a = lembrete.atual;
  const { min, max } = LIMITES_LEMBRETE;
  return (
    <div className={cx(c.cfReg, c.cfRegLarga)} role="group" aria-labelledby="cfg-rot-lembrete">
      <div className={c.cfRegCab}>
        <p className={c.cfCampoRotulo} id="cfg-rot-lembrete">
          Lembrete para quem parou de responder
        </p>
        {a &&
          (admin ? (
            <button
              type="button"
              role="switch"
              className={c.cfChave}
              aria-checked={a.ligado}
              aria-labelledby="cfg-rot-lembrete"
              aria-describedby="cfg-ajuda-lembrete"
              aria-disabled={salvando || undefined}
              onClick={() => {
                if (salvando) return;
                lembrete.aoAlternar();
              }}
            >
              <span className={c.cfChaveTrilho} aria-hidden="true">
                <span className={c.cfChaveBola} />
              </span>
              <span className={c.cfChaveRot} aria-hidden="true">
                {a.ligado ? "Ligado" : "Desligado"}
              </span>
            </button>
          ) : (
            <span className={c.cfChaveRot} data-so="">
              {a.ligado ? "Ligado" : "Desligado"}
            </span>
          ))}
      </div>
      {a ? (
        <>
          {a.ligado && (
            <Regulador
              campo="horas"
              valor={a.horas}
              unidade="h"
              noMinimo={salvando || a.horas <= min}
              noMaximo={salvando || a.horas >= max}
              menosAria="Esperar 1 hora a menos para o lembrete"
              maisAria="Esperar 1 hora a mais para o lembrete"
              aoMenos={() => lembrete.aoMudarHoras(-1)}
              aoMais={() => lembrete.aoMudarHoras(1)}
              admin={admin}
            />
          )}
          <p className={c.cfAjuda} id="cfg-ajuda-lembrete">
            {a.ligado ? AJUDA_LIGADO : AJUDA_DESLIGADO}
          </p>
        </>
      ) : lembrete.leitura.erro ? (
        <ErroLeitura
          erro={lembrete.leitura.erro}
          titulo="Não deu para carregar o lembrete"
          tentarDeNovo={lembrete.leitura.tentarDeNovo}
          compacto
        />
      ) : (
        <Carregando forma="texto" quantos={1} rotulo="Carregando o lembrete" />
      )}
    </div>
  );
}

/**
 * 4 · Atendimento (o ritmo): 24 horas, todos os dias. A espera depois da última mensagem e o tempo
 * máximo, explicados em linguagem simples; o admin ajusta e salva, a atendente só vê.
 */
export function CartaoRitmo(props: Props) {
  const { admin, salvo, rascunho, salvando, realce, oculto } = props;
  const r = admin ? rascunho : salvo;
  const mudou = admin && (rascunho.espera !== salvo.espera || rascunho.teto !== salvo.teto || !!props.lembrete?.mudou);
  const { espera: E, teto: T, folga } = LIMITES_RITMO;
  const regs = [
    {
      campo: "espera" as const,
      rotulo: "Espera depois da última mensagem",
      valor: r.espera,
      ajuda: "Se o lead mandar outra mensagem nesse tempo, a Nina espera de novo.",
      noMinimo: salvando || r.espera <= E.min,
      noMaximo: salvando || r.espera >= Math.min(E.max, r.teto - folga),
      menosAria: "Esperar 1 segundo a menos",
      maisAria: "Esperar 1 segundo a mais",
    },
    {
      campo: "teto" as const,
      rotulo: "Tempo máximo de espera",
      valor: r.teto,
      ajuda: "Contado da primeira mensagem. Passou disso, ela responde mesmo que o lead continue escrevendo.",
      noMinimo: salvando || r.teto <= Math.max(T.min, r.espera + folga),
      noMaximo: salvando || r.teto >= T.max,
      menosAria: "Diminuir o tempo máximo em 5 segundos",
      maisAria: "Aumentar o tempo máximo em 5 segundos",
    },
  ];

  return (
    <section
      id="cfg-card-ritmo"
      className={cx(c.cfCartao, c.cfBlk, oculto && c.cfOculto)}
      data-realce={realce ?? undefined}
      aria-labelledby="cfg-m-ritmo cfg-h-ritmo"
    >
      <header className={c.cfBlkCab}>
        <span className={lista.linhaIcone} aria-hidden="true">
          <Ic d={ICX.relogio} tamanho="g" />
        </span>
        <div className={c.cfBlkTitulo}>
          <p className={c.cfMeta} id="cfg-m-ritmo">
            Atendimento
          </p>
          <h2 id="cfg-h-ritmo" tabIndex={-1} className={c.cfBlkH}>
            24 horas, todos os dias
          </h2>
        </div>
        {/* o verde depende da Saúde (decisão 10d): com a Nina parada, o "24 horas" não está valendo */}
        {props.atrasada ? (
          <LinhaEstado tom="atencao" icone={IC.triangulo}>
            Atrasada agora
          </LinhaEstado>
        ) : props.saudavel === false ? (
          <LinhaEstado tom="atencao" icone={IC.triangulo}>
            Parada agora
          </LinhaEstado>
        ) : (
          <LinhaEstado tom="ok" icone={IC.ok}>
            Sempre ligada
          </LinhaEstado>
        )}
      </header>
      <p className={c.cfApoio}>
        A Nina junta as mensagens que o lead manda em sequência e responde tudo de uma vez, como uma pessoa faria.
      </p>
      <div className={c.cfRegs}>
        {regs.map((g) => (
          <div key={g.campo} className={c.cfReg} role="group" aria-labelledby={`cfg-rot-${g.campo}`}>
            <p className={c.cfCampoRotulo} id={`cfg-rot-${g.campo}`}>
              {g.rotulo}
            </p>
            <Regulador
              campo={g.campo}
              valor={g.valor}
              unidade="s"
              noMinimo={g.noMinimo}
              noMaximo={g.noMaximo}
              menosAria={g.menosAria}
              maisAria={g.maisAria}
              aoMenos={() => props.aoMudar(g.campo, -PASSO_RITMO[g.campo])}
              aoMais={() => props.aoMudar(g.campo, PASSO_RITMO[g.campo])}
              admin={admin}
            />
            <p className={c.cfAjuda}>{g.ajuda}</p>
          </div>
        ))}
        {props.lembrete && <BlocoLembrete admin={admin} salvando={salvando} lembrete={props.lembrete} />}
      </div>
      <div className={c.cfAbre}>
        <button
          type="button"
          className={c.cfAbreBotao}
          aria-expanded={props.verTempo}
          aria-controls="cfg-tempo"
          onClick={props.aoAlternarTempo}
        >
          <Ic d={IC.chevronDireita} tamanho="p" />
          <span>{props.verTempo ? "Esconder o exemplo" : "Ver como funciona"}</span>
        </button>
        {props.verTempo && <LinhaDoTempo r={r} />}
      </div>
      {mudou && (
        <div className={c.cfBlkPe}>
          <p className={c.cfMeta}>Mudanças ainda não salvas</p>
          <div className={c.cfDir}>
            <Botao variante="discreto" disabled={salvando} onClick={props.aoDesfazer}>
              Desfazer
            </Botao>
            <Botao carregando={salvando} onClick={props.aoSalvar}>
              Salvar o ritmo
            </Botao>
          </div>
        </div>
      )}
    </section>
  );
}
