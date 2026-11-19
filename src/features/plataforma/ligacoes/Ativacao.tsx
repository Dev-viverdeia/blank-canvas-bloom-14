import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import { movimentoReduzido } from "@/components/nina/VooNina";
import { Botao, cx } from "@/components/subido";
import { s as lista, useDepois } from "@/features/onboarding/lista";
import { IC } from "@/features/onboarding/lista/dados";
import { type EstadoLigacoes, type PendenciaLigacoes } from "@/features/mensageria/ligacoes/tipos";

import { AtalhoArea } from "../comum/AtalhoArea";
import { FecharGaveta, Gaveta } from "../comum/Gaveta";
import { dataCurta, horaCurta } from "../comum/tempo";
import { comMinimo } from "../configuracao/dados";
import { c } from "../configuracao/estilos";
import {
  AvisoCartao,
  DialogoConfirmar,
  ICX,
  Ic,
  LinhaEstado,
  type Tom,
} from "../configuracao/pecas";
import { textoFalhaAcao } from "../configuracao/textos";
import type { AcoesConfiguracao } from "../dados/configuracao";
import { ListaElegibilidade } from "./Elegibilidade";
import {
  PASSOS_ATIVACAO,
  TEXTO_FASE,
  apoioDaFase,
  botaoDaFase,
  faseDoCartao,
  itensDoCartao,
  podeVerificar,
  resumoDaFase,
  tituloDaFase,
  type FaseCartao,
} from "./verificacao";
import { l } from "./estilos";

export { PASSOS_ATIVACAO };

export const DICA_TESTE_LIGACAO = "Para testar, ligue pelo WhatsApp para este número.";
/** A pendência da Meta sem o token da conexão (D23): só o painel da Meta desliga. */
export const TEXTO_META_MANUAL =
  "Desligue as ligações deste número no painel da Meta (WhatsApp Manager → o número → Ligações).";
/** A pendência da ElevenLabs com a chave revogada (D30): só o painel da ElevenLabs apaga. */
export const TEXTO_ELEVEN_MANUAL =
  "Apague no painel da ElevenLabs o que sobrou com o nome “Nina (ligações) …”: o agente, o número, a ferramenta, o webhook ou o segredo.";

/** O que cada pendência da desativação quer dizer. */
const NOME_PENDENCIA: Record<PendenciaLigacoes, string> = {
  meta: "As chamadas ligadas na Meta",
  meta_manual: "As chamadas ligadas na Meta",
  eleven_manual: "O que sobrou na ElevenLabs",
  tronco: "O número na ElevenLabs",
  agente: "O agente de voz na ElevenLabs",
  ferramenta: "A ferramenta de passar para a equipe na ElevenLabs",
  webhook: "O aviso de fim da ligação na ElevenLabs",
  segredo: "O segredo guardado na ElevenLabs",
};
export const nomePendencia = (p: PendenciaLigacoes) => NOME_PENDENCIA[p];

/**
 * A frase antes da lista de pendências: a ativação que parou no meio (D20) ou a desativação que não
 * terminou; sem lista, a frase não anuncia uma.
 */
function textoPendencias(abandonada: boolean, comLista: boolean): string {
  if (abandonada) {
    return comLista
      ? "A ativação parou no meio. Tentar de novo desfaz o que ela criou:"
      : "A ativação parou no meio, antes de criar qualquer coisa. Tentar de novo libera para ativar outra vez.";
  }
  return comLista
    ? "A desativação não terminou. Ficou para trás:"
    : "A desativação não terminou. Tentar de novo confere o que falta.";
}

/** O botão das pendências: as manuais (D23, D30) pedem a confirmação de que o admin já fez. */
function rotuloPendencias(metaManual: boolean, elevenManual: boolean): string {
  if (metaManual && elevenManual) return "Já fiz os dois";
  if (metaManual) return "Já desliguei";
  if (elevenManual) return "Já apaguei";
  return "Tentar de novo";
}

/**
 * O aviso de uma desativação que deixou pendências. Com a pendência manual (D23 e D30), ele repete
 * o pedido do cartão (o painel do provedor e o botão de confirmar), não um "Tente de novo".
 */
export function avisoPendencias(pendencias: readonly PendenciaLigacoes[]): string {
  const metaManual = pendencias.includes("meta_manual");
  const elevenManual = pendencias.includes("eleven_manual");
  if (metaManual && elevenManual) {
    return "Falta desligar as ligações no painel da Meta e apagar o que sobrou no painel da ElevenLabs. Depois, clique em Já fiz os dois.";
  }
  if (metaManual) {
    return "Falta desligar as ligações no painel da Meta. Depois, clique em Já desliguei.";
  }
  if (elevenManual) {
    return "Falta apagar o que sobrou no painel da ElevenLabs. Depois, clique em Já apaguei.";
  }
  return "Algumas partes não saíram. Tente de novo.";
}

/** A leitura do estado falhou (rede, sessão) sem frase do servidor. */
export const LEITURA_FALHOU = "Não deu para ler o estado das ligações agora.";

/** De quanto em quanto tempo o passo da ativação anda na tela. */
const PASSO_MS = 2500;
/** Com a ativação no servidor ("ativando" lido de outra aba ou de um recarregar), relê a cada 5 s. */
const RELER_ATIVANDO_MS = 5000;

type Acoes = Pick<AcoesConfiguracao, "estadoLigacoes" | "ativarLigacoes" | "desativarLigacoes">;

/** O título do cartão (o foco volta para ele depois de uma ação que o deixa na tela). */
export const ID_TITULO_CARTAO = "lg-h-cartao";
/** O título do resumo do topo (o foco vai para ele quando as ligações ficam ativas). */
export const ID_TITULO_TOPO = "lg-h-topo";

interface OpcoesControle {
  acoes: Acoes;
  demo: boolean;
  /**
   * Muda quando algo que decide um requisito muda (a conexão, a chave da voz, a voz escolhida): o
   * estado é relido.
   */
  chaveDosRequisitos: string;
  /** Uma ação da tela em andamento: os botões do cartão ficam desligados. */
  bloqueado: boolean;
  /**
   * Falso enquanto as leituras que decidem os requisitos não chegaram: a 1ª leitura do estado espera
   * por elas (sem isto, a chave dos requisitos muda logo depois e o estado é lido duas vezes).
   */
  pronto?: boolean | undefined;
  aoAvisar: (texto: string, tom?: "ok" | "info") => void;
}

/** O estado das ligações e as ações, num lugar só: o topo e a aba Ajustes mostram o mesmo. */
export interface ControleLigacoes {
  estado: EstadoLigacoes | null;
  erroLeitura: string | null;
  erro: string | null;
  acao: "ativar" | "desativar" | null;
  passo: number;
  ocupado: boolean;
  bloqueado: boolean;
  demo: boolean;
  simular: boolean;
  setSimular: (v: boolean) => void;
  dialogo: boolean;
  setDialogo: (v: boolean) => void;
  /** A gaveta da verificação: abre ao ativar e em "Ver como liberar". */
  gaveta: boolean;
  setGaveta: (v: boolean) => void;
  ler: () => void;
  ativar: () => void;
  desativar: () => void;
  focar: (id: string) => void;
}

/**
 * As ligações pelo WhatsApp (2.7; na área Ligações desde a
 * spec-ligacoes-tela): lê o estado ao abrir a área, quando um requisito pode ter mudado e depois de
 * cada ação. O "ativando" lido do servidor relê a cada 5 s, mesmo depois de uma leitura que falhou:
 * parado, o servidor o devolve como "com_pendencias" com abandonada (D20). A ligação nunca para a
 * Nina de texto: nada daqui entra na Saúde da Configuração.
 */
export function useControleLigacoes({
  acoes,
  demo,
  chaveDosRequisitos,
  bloqueado,
  pronto = true,
  aoAvisar,
}: OpcoesControle): ControleLigacoes {
  const { focar: focarDepois } = useDepois();
  const mov = !movimentoReduzido();
  const [estado, setEstado] = useState<EstadoLigacoes | null>(null);
  const [erroLeitura, setErroLeitura] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [acao, setAcao] = useState<"ativar" | "desativar" | null>(null);
  const [passo, setPasso] = useState(0);
  const [dialogo, setDialogo] = useState(false);
  const [gaveta, setGaveta] = useState(false);
  const [simular, setSimular] = useState(false);
  /** Conta as leituras que voltaram (certas ou não): a releitura do "ativando" rearma a cada uma. */
  const [lidas, setLidas] = useState(0);
  const vivo = useRef(true);
  /** Só a leitura mais nova vale (uma ação ou um requisito novo pede outra antes da anterior voltar). */
  const seq = useRef(0);

  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  const focar = useCallback((id: string) => focarDepois(id), [focarDepois]);

  const ler = useCallback(() => {
    seq.current += 1;
    const minha = seq.current;
    void acoes.estadoLigacoes().then((r) => {
      if (!vivo.current || minha !== seq.current) return;
      setLidas((n) => n + 1);
      if (r.ok) {
        setEstado(r.estado);
        setErroLeitura(null);
      } else
        setErroLeitura(
          r.mensagem?.trim() || (r.erro === "sem_acesso" ? textoFalhaAcao(r.erro) : LEITURA_FALHOU),
        );
    });
  }, [acoes]);

  // ao abrir a área (com as leituras dos requisitos já chegadas) e quando um requisito pode ter mudado
  useEffect(() => {
    if (pronto) ler();
  }, [ler, chaveDosRequisitos, pronto]);

  // os passos andam enquanto a ativação roda (o último espera a resposta)
  useEffect(() => {
    if (acao !== "ativar") return;
    setPasso(0);
    const t = setInterval(
      () => setPasso((p) => Math.min(p + 1, PASSOS_ATIVACAO.length - 1)),
      PASSO_MS,
    );
    return () => clearInterval(t);
  }, [acao]);

  // a ativação que roda fora desta tela: relê até ela terminar (também depois de uma leitura que
  // falhou: o "ativando" que ficou na tela continua sendo conferido)
  const ativandoFora = !acao && estado?.situacao === "ativando";
  useEffect(() => {
    if (!ativandoFora) return;
    const t = setTimeout(ler, RELER_ATIVANDO_MS);
    return () => clearTimeout(t);
  }, [ativandoFora, ler, estado, lidas]);

  const ocupado = bloqueado || acao !== null;

  const ativar = () => {
    // com a conexão da Meta já dá para verificar: o servidor confere tudo e não cria nada
    if (ocupado || !estado || !podeVerificar(estado)) return;
    setErro(null);
    setAcao("ativar");
    // a verificação acontece aqui, na hora de ativar: a gaveta mostra os passos e, reprovada, a lista
    setGaveta(true);
    // na demo, os passos aparecem um pouco antes de a resposta (imediata) chegar
    void comMinimo(
      acoes.ativarLigacoes(demo ? { falhar: simular } : undefined),
      demo && mov ? PASSO_MS * 2 : 0,
    ).then((r) => {
      if (!vivo.current) return;
      setAcao(null);
      if (!r.ok) {
        // reprovada na verificação: a lista diz o que falta e como resolver (não é erro)
        const eleg = r.elegibilidade;
        if (eleg) {
          seq.current += 1;
          setEstado((e) => (e ? { ...e, elegibilidade: eleg } : e));
          setErroLeitura(null);
        } else setErro(textoFalhaAcao(r.erro, r.mensagem));
        if (!eleg) ler();
        focar(ID_TITULO_CARTAO);
        return;
      }
      seq.current += 1;
      setEstado(r.estado);
      setErroLeitura(null);
      setGaveta(false);
      aoAvisar(
        r.estado.numero
          ? `Ligações ativadas. A Nina atende no ${r.estado.numero}.`
          : "Ligações ativadas.",
      );
      focar(r.estado.situacao === "ativa" ? ID_TITULO_TOPO : ID_TITULO_CARTAO);
    });
  };

  const desativar = () => {
    setDialogo(false);
    if (ocupado) return;
    setErro(null);
    setAcao("desativar");
    // na demo, a falha simulada só vale saindo de "ativa": o "Tentar de novo" das pendências termina
    const falhar = simular && estado?.situacao === "ativa";
    void acoes.desativarLigacoes(demo ? { falhar } : undefined).then((r) => {
      if (!vivo.current) return;
      setAcao(null);
      if (!r.ok) {
        setErro(textoFalhaAcao(r.erro, r.mensagem));
        ler();
        focar(ID_TITULO_CARTAO);
        return;
      }
      seq.current += 1;
      setEstado(r.estado);
      setErroLeitura(null);
      if (r.estado.situacao === "com_pendencias")
        aoAvisar(avisoPendencias(r.estado.pendencias), "info");
      else aoAvisar("Ligações desativadas.", "info");
      focar(ID_TITULO_CARTAO);
    });
  };

  return {
    estado,
    erroLeitura,
    erro,
    acao,
    passo,
    ocupado,
    bloqueado,
    demo,
    simular,
    setSimular,
    dialogo,
    setDialogo,
    gaveta,
    setGaveta,
    ler,
    ativar,
    desativar,
    focar,
  };
}

/**
 * O progresso da ativação, acima dos passos: enche até a metade do passo atual (o último espera a
 * resposta do servidor). Ativando fora desta tela, o passo não é conhecido: a barra corre sem fim.
 */
function BarraAtivacao({ atual }: { atual: number }) {
  const n = PASSOS_ATIVACAO.length;
  const conhecido = atual >= 0;
  return (
    <div
      className={l.lgProgresso}
      role="progressbar"
      aria-label="Progresso da ativação"
      aria-valuemin={0}
      aria-valuemax={n}
      aria-valuenow={conhecido ? atual : undefined}
      aria-valuetext={conhecido ? `Passo ${atual + 1} de ${n}` : "Ativando"}
      data-indeterminado={conhecido ? undefined : ""}
      style={{ "--lg-progresso": conhecido ? (atual + 0.5) / n : 0.35 } as CSSProperties}
    >
      <span />
    </div>
  );
}

/** O cartão fica no topo (antes de ativar) ou na aba Ajustes (ativas ou com pendências)? */
export function cartaoNoTopo(controle: Pick<ControleLigacoes, "estado" | "acao">): boolean {
  if (controle.acao === "ativar") return true;
  const s = controle.estado?.situacao;
  return s !== "ativa" && s !== "com_pendencias";
}

/**
 * O cartão das ligações (2.7 e seção 21): antes de ativar, um resumo curto da
 * fase (título, pílula, uma linha e o botão). A lista da verificação fica na gaveta, que abre ao
 * ativar (o servidor verifica e, passando, já ativa) e em "Ver como liberar"; reprovada, não é erro.
 * Ativando por outra aba, os passos esperam aqui; ativa (desde quando, a dica de teste e "Desativar ligações", com confirmação); com
 * pendências ("Tentar de novo" desativa de novo; com "meta_manual", o texto do painel da Meta e "Já
 * desliguei"; com "eleven_manual", o do painel da ElevenLabs e "Já apaguei"; os dois também
 * desativam); e o erro da última ação com a frase do servidor. Antes de ativar, fica no topo da área;
 * ativas ou com pendências, na aba Ajustes (spec-ligacoes-tela, 2.3).
 */
export function CartaoLigacoes({
  controle,
  meta = "Ligações pelo WhatsApp",
}: {
  controle: ControleLigacoes;
  meta?: string;
}) {
  const {
    estado,
    erroLeitura,
    erro,
    acao,
    passo,
    ocupado,
    bloqueado,
    demo,
    simular,
    setSimular,
    dialogo,
    setDialogo,
    setGaveta,
    ler,
    ativar,
    desativar,
    focar,
  } = controle;
  const situacao = estado?.situacao ?? null;
  // D23 e D30: só o "Já desliguei" ou o "Já apaguei" (um desativar) tira a pendência manual
  const pendente = situacao === "com_pendencias" ? (estado?.pendencias ?? []) : [];
  const metaManual = pendente.includes("meta_manual");
  const elevenManual = pendente.includes("eleven_manual");
  // D20: a ativação que parou no meio, não uma desativação
  const abandonada = situacao === "com_pendencias" && !!estado?.abandonada;
  const ativando = acao === "ativar" || situacao === "ativando";
  // antes de ativar: a fase da verificação (spec-ligacoes, seção 21)
  const antes = !!estado && (situacao === "indisponivel" || situacao === "pronta");
  const fase = estado && antes ? faseDoCartao(estado) : null;
  const itens = estado && antes ? itensDoCartao(estado) : [];
  const tf = fase ? TEXTO_FASE[fase] : null;
  const titulo = ativando
    ? acao === "ativar"
      ? "Verificando e ativando"
      : "Ativando as ligações"
    : !estado
      ? erroLeitura
        ? "Não deu para ler as ligações"
        : "Lendo as ligações…"
      : situacao === "ativa"
        ? estado.numero
          ? `Ativas no número ${estado.numero}`
          : "Ativas"
        : situacao === "com_pendencias"
          ? abandonada
            ? "A ativação não terminou"
            : "Desativação incompleta"
          : fase && estado
            ? tituloDaFase(fase, estado)
            : "";
  const linha: { texto: string; tom?: Tom; icone: string; girando?: boolean } = ativando
    ? { texto: acao === "ativar" ? "Verificando" : "Ativando", icone: "", girando: true }
    : !estado
      ? erroLeitura
        ? { texto: "Sem leitura", tom: "atencao", icone: IC.triangulo }
        : { texto: "Lendo", icone: "", girando: true }
      : situacao === "ativa"
        ? { texto: "Ativas", tom: "ok", icone: IC.ok }
        : situacao === "com_pendencias"
          ? { texto: "Com pendências", tom: "atencao", icone: IC.triangulo }
          : {
              texto: tf?.linha ?? "",
              ...(tf?.tom ? { tom: tf.tom } : {}),
              icone: tf?.tom === "ok" ? IC.ok : tf?.tom === "atencao" ? IC.triangulo : IC.pendente,
            };

  // o "Simular" da demo: no cartão e na gaveta (um id para cada, para o rótulo apontar certo)
  const simuladorCom = (id: string) =>
    demo && ((antes && !!estado && podeVerificar(estado)) || situacao === "ativa") && !ativando ? (
      <label className={c.cfSim} htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={simular}
          disabled={ocupado}
          onChange={(ev) => setSimular(ev.target.checked)}
        />
        <span>
          {situacao === "ativa" ? "Simular falha na demo" : "Simular limite de 250 na demo"}
        </span>
      </label>
    ) : null;
  const simulador = simuladorCom("lg-sim");

  return (
    <section
      id="lg-cartao"
      className={cx(c.cfCartao, c.cfBlk)}
      data-situacao={ativando ? "ativando" : (situacao ?? undefined)}
      aria-labelledby={`lg-m-cartao ${ID_TITULO_CARTAO}`}
      aria-busy={acao !== null || undefined}
    >
      <header className={c.cfBlkCab}>
        <span className={lista.linhaIcone} aria-hidden="true">
          <Ic d={ICX.telefone} tamanho="g" />
        </span>
        <div className={c.cfBlkTitulo}>
          <p className={c.cfMeta} id="lg-m-cartao">
            {meta}
          </p>
          <h2 id={ID_TITULO_CARTAO} tabIndex={-1} className={c.cfBlkH}>
            {titulo}
          </h2>
        </div>
        <LinhaEstado tom={linha.tom} icone={linha.icone} girando={linha.girando}>
          {linha.texto}
        </LinhaEstado>
      </header>

      {erro && (
        <AvisoCartao tom="erro" icone={IC.alerta} papel="alert">
          <span>{erro}</span>
        </AvisoCartao>
      )}

      {!estado && erroLeitura && !ativando && (
        <>
          <AvisoCartao tom="atencao" icone={IC.triangulo}>
            <span>{erroLeitura}</span>
          </AvisoCartao>
          <div className={c.cfBlkPe}>
            <div className={c.cfDir}>
              <Botao id="lg-reler" variante="contorno" disabled={bloqueado} onClick={ler}>
                Ler de novo
              </Botao>
            </div>
          </div>
        </>
      )}

      {/* na ativação desta tela, a barra e os passos ficam na gaveta; aqui, só a de fora */}
      {ativando && acao !== "ativar" && <BarraAtivacao atual={-1} />}

      {ativando && acao !== "ativar" && (
        <ol className={c.cfReqs} aria-label="Passos da ativação" aria-live="polite">
          {/* ativando fora desta tela, o passo não é conhecido: todos esperam juntos */}
          {PASSOS_ATIVACAO.map((p) => (
            <li key={p} className={cx(c.cfReq, l.lgPasso)} data-estado="agora" aria-current="step">
              <span className={c.cfGiro} aria-hidden="true" />
              <span>{p}</span>
            </li>
          ))}
        </ol>
      )}

      {estado && !ativando && antes && fase && (
        <>
          <p className={c.cfApoio}>{resumoDaFase(fase, estado, itens)}</p>
          <div className={c.cfBlkPe}>
            {simulador}
            <div className={c.cfDir}>
              {!podeVerificar(estado) ? (
                <AtalhoArea para="/app/configuracao" variante="discreto" tamanho="compacto">
                  Abrir a Configuração
                </AtalhoArea>
              ) : (
                <>
                  {estado.elegibilidade && fase !== "verificar" && fase !== "liberada" && (
                    <Botao
                      id="lg-detalhes"
                      variante="contorno"
                      disabled={ocupado}
                      onClick={() => setGaveta(true)}
                    >
                      {fase === "bloqueada_meta" ? "Ver como liberar" : "Ver detalhes"}
                    </Botao>
                  )}
                  <Botao id="lg-ativar" disabled={ocupado} onClick={ativar}>
                    {botaoDaFase(fase, estado)}
                  </Botao>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {estado && !ativando && situacao === "ativa" && (
        <>
          {estado.ativadaEm && (
            <p className={c.cfApoio}>Desde {dataCurta(estado.ativadaEm, true)}</p>
          )}
          <AvisoCartao tom="info" icone={ICX.info}>
            <span>{DICA_TESTE_LIGACAO}</span>
          </AvisoCartao>
          <div className={c.cfBlkPe}>
            {simulador}
            <div className={c.cfDir}>
              <Botao
                id="lg-desativar"
                variante="perigo"
                className={cx(c.cfBtnC, c.cfPerigoLeve)}
                carregando={acao === "desativar"}
                disabled={ocupado}
                onClick={() => setDialogo(true)}
              >
                {acao === "desativar" ? "Desativando…" : "Desativar ligações"}
              </Botao>
            </div>
          </div>
        </>
      )}

      {estado && !ativando && situacao === "com_pendencias" && (
        <>
          <p className={c.cfApoio}>{textoPendencias(abandonada, estado.pendencias.length > 0)}</p>
          {estado.pendencias.length > 0 && (
            <ul className={c.cfReqs} aria-label="O que ficou para trás">
              {estado.pendencias.map((p) => (
                <li key={p} className={c.cfReq} data-estado="falta">
                  <Ic d={IC.triangulo} tamanho="p" />
                  <span>{nomePendencia(p)}</span>
                </li>
              ))}
            </ul>
          )}
          {metaManual && (
            <AvisoCartao tom="atencao" icone={IC.triangulo}>
              <span>{TEXTO_META_MANUAL}</span>
            </AvisoCartao>
          )}
          {elevenManual && (
            <AvisoCartao tom="atencao" icone={IC.triangulo}>
              <span>{TEXTO_ELEVEN_MANUAL}</span>
            </AvisoCartao>
          )}
          <div className={c.cfBlkPe}>
            <div className={c.cfDir}>
              <Botao
                id="lg-desativar"
                variante="contorno"
                carregando={acao === "desativar"}
                disabled={ocupado}
                onClick={desativar}
              >
                {rotuloPendencias(metaManual, elevenManual)}
              </Botao>
            </div>
          </div>
        </>
      )}

      {estado && antes && fase && (
        <GavetaVerificacao
          controle={controle}
          fase={fase}
          itens={itens}
          simulador={simuladorCom("lg-sim-gaveta")}
        />
      )}

      {dialogo && (
        <DialogoConfirmar
          titulo="Desativar as ligações?"
          texto="A Nina deixa de atender ligações neste número. Dá para ativar de novo quando quiser."
          acao="Desativar"
          aoCancelar={() => {
            setDialogo(false);
            focar("lg-desativar");
          }}
          aoConfirmar={desativar}
        />
      )}
    </section>
  );
}

/** O título da gaveta da verificação. */
export const ID_TITULO_GAVETA = "lg-h-gaveta";

/**
 * A gaveta da verificação (spec-ligacoes, seção 21): abre ao ativar, com os passos enquanto o
 * servidor verifica e ativa; reprovada, mostra a lista inteira (de quem é cada regra e o que fazer) e
 * "Verificar de novo". Também abre por "Ver como liberar", sem verificar. A lista não fica no cartão:
 * o cliente só a vê quando vai ativar ou quando quer conferir.
 */
function GavetaVerificacao({
  controle,
  fase,
  itens,
  simulador,
}: {
  controle: ControleLigacoes;
  fase: FaseCartao;
  itens: ReturnType<typeof itensDoCartao>;
  simulador: React.ReactNode;
}) {
  const { estado, erro, acao, passo, ocupado, gaveta, setGaveta, ativar, focar } = controle;
  const verificando = acao === "ativar";
  const fechar = () => {
    if (verificando) return;
    setGaveta(false);
    focar(ID_TITULO_CARTAO);
  };
  if (!estado) return null;
  return (
    <Gaveta aberta={gaveta} aoFechar={fechar} largura={560} rotulo="Verificação das ligações">
      <div className={l.lgEditor} data-lg-gaveta="verificacao" aria-busy={verificando || undefined}>
        <div className={l.lgEditorCab}>
          <h2 id={ID_TITULO_GAVETA} className={l.lgEditorH} tabIndex={-1}>
            {verificando ? "Verificando e ativando" : TEXTO_FASE[fase].titulo}
          </h2>
          <FecharGaveta aoFechar={fechar} />
        </div>
        <div className={l.lgEditorCorpo}>
          {verificando ? (
            <>
              <BarraAtivacao atual={passo} />
              <ol className={c.cfReqs} aria-label="Passos da ativação" aria-live="polite">
                {PASSOS_ATIVACAO.map((p, i) => {
                  const est = i < passo ? "ok" : i === passo ? "agora" : "depois";
                  return (
                    <li
                      key={p}
                      className={cx(c.cfReq, l.lgPasso)}
                      data-estado={est}
                      aria-current={est === "agora" ? "step" : undefined}
                    >
                      {est === "agora" ? (
                        <span className={c.cfGiro} aria-hidden="true" />
                      ) : (
                        <Ic d={est === "ok" ? IC.ok : IC.pendente} tamanho="p" />
                      )}
                      <span>{p}</span>
                      {est === "ok" && <span className={c.cfSr}> (feito)</span>}
                    </li>
                  );
                })}
              </ol>
            </>
          ) : (
            <>
              {erro && (
                <AvisoCartao tom="erro" icone={IC.alerta} papel="alert">
                  <span>{erro}</span>
                </AvisoCartao>
              )}
              <p className={c.cfApoio}>{apoioDaFase(fase, itens)}</p>
              <ListaElegibilidade itens={itens} />
              {estado.elegibilidade && (
                <p className={l.lgElegConferida}>
                  Conferido em {dataCurta(estado.elegibilidade.conferidaEm, true)} às{" "}
                  {horaCurta(estado.elegibilidade.conferidaEm)}
                </p>
              )}
            </>
          )}
        </div>
        {!verificando && (
          <div className={l.lgEditorPe}>
            {simulador}
            <Botao variante="discreto" className={l.lgEmpurra} onClick={fechar}>
              Fechar
            </Botao>
            {podeVerificar(estado) && (
              <Botao id="lg-gaveta-ativar" disabled={ocupado} onClick={ativar}>
                {botaoDaFase(fase, estado)}
              </Botao>
            )}
          </div>
        )}
      </div>
    </Gaveta>
  );
}
