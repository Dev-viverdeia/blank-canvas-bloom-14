import { Phone, PhoneOff, TriangleAlert } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { Botao } from "@/components/subido";

import { idTituloArea, useEntradaUnica } from "../AreaVazia";
import { areaPorId } from "../areas";
import { useContagem, useMovimentoReduzido } from "../comum/AoVivo";
import { useDadosConfiguracao } from "../dados/configuracao";
import {
  useAcoesLigacoes,
  useAgentesLigacao,
  useHistoricoLigacoes,
  useLimitesLigacoes,
  useAdotarAgenteDoTronco,
  useSituacaoLigacoes,
} from "../dados/ligacoes";
import { usePapel } from "../papel";
import { Agentes } from "./Agentes";
import { Ajustes } from "./Ajustes";
import { CartaoLigacoes, ID_TITULO_TOPO, cartaoNoTopo, useControleLigacoes } from "./Ativacao";
import { l } from "./estilos";
import { Historico } from "./Historico";
import { AvisoNaTela, useAvisoCurto } from "./pecas";
import { numerosDasLigacoes, type Ligacao } from "./tipos";

// A área Ligações (L1, L9 e 2.3): o título, o topo e as abas.
// - O topo: com as ligações ativas, a situação em uma linha ("Ativas no … · quem atende: Nina") e três
//   números (ligações hoje, minutos no mês, em andamento agora). Antes de ativar, o admin vê ali o
//   passo a passo de ativar (o cartão que saiu da Configuração); com pendências, um aviso que leva aos
//   Ajustes. O atendente vê a situação e os números, sem ativar nada.
// - As abas: Histórico (abre primeiro; todo membro), Agentes e Ajustes (só o admin). O atendente só tem
//   o Histórico, sem a linha das abas.
// - O movimento: o indicador das abas desliza até a aba escolhida e o painel entra com um fade curto;
//   os números contam até o valor ao carregar e ao mudar; "em andamento" acima de zero pulsa. Com o
//   movimento reduzido, a raiz leva data-movimento="reduzido" e nada se mexe (os números vão direto).

type Aba = "historico" | "agentes" | "ajustes";

const ABAS: readonly { id: Aba; nome: string }[] = [
  { id: "historico", nome: "Histórico" },
  { id: "agentes", nome: "Agentes" },
  { id: "ajustes", nome: "Ajustes" },
];

const idAba = (a: Aba) => `lg-aba-${a}`;
const idPainel = (a: Aba) => `lg-painel-${a}`;

/** O relógio da área: anda a cada 30 s (a hora da lista e o "até agora" da ligação em andamento). */
function useAgora(): number {
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setAgora(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return agora;
}

export function TelaLigacoes() {
  const { papel } = usePapel();
  return papel === "admin" ? <LigacoesAdmin /> : <LigacoesAtendente />;
}

/** O título e a frase da área, e o que vem embaixo. */
function Moldura({ children }: { children: ReactNode }) {
  const area = areaPorId("ligacoes");
  const anima = useEntradaUnica("ligacoes");
  const reduzido = useMovimentoReduzido();
  return (
    <section
      className={l.lgTela}
      aria-labelledby={idTituloArea("ligacoes")}
      data-area="ligacoes"
      data-sem-entrada={anima ? undefined : ""}
      data-movimento={reduzido ? "reduzido" : undefined}
    >
      <div className={l.lgCab}>
        <h1 id={idTituloArea("ligacoes")} tabIndex={-1} className={l.lgTitulo}>
          {area.nome}
        </h1>
        <p className={l.lgDesc}>{area.descricao}</p>
      </div>
      {children}
    </section>
  );
}

function LigacoesAdmin() {
  const cfg = useDadosConfiguracao();
  const historico = useHistoricoLigacoes();
  const agentes = useAgentesLigacao();
  const limites = useLimitesLigacoes();
  const acoes = useAcoesLigacoes();
  const { aviso, avisar } = useAvisoCurto();
  const agora = useAgora();
  const [aba, setAba] = useState<Aba>("historico");

  // o que pode mudar um requisito das ligações: o estado é relido quando muda
  const conexao = cfg.conexao.dados?.conexao ?? null;
  const chaveVoz = cfg.chaves.dados?.find((k) => k.finalidade === "voz") ?? null;
  const configuracao = cfg.configuracao.dados;
  const chaveDosRequisitos = [
    conexao?.id ?? "",
    conexao?.gateway ?? "",
    conexao?.ativa ? "ativa" : "",
    chaveVoz?.provedor ?? "",
    chaveVoz?.status ?? "",
    configuracao?.voz_id ?? "",
  ].join("|");

  // as três leituras chegaram (ou falharam): a 1ª leitura do estado das ligações espera por elas
  const lida = (x: { dados: unknown; erro: unknown }) => x.dados !== undefined || x.erro !== null;
  const controle = useControleLigacoes({
    acoes: cfg.acoes,
    demo: cfg.modo === "exemplo",
    chaveDosRequisitos,
    bloqueado: false,
    pronto: lida(cfg.conexao) && lida(cfg.chaves) && lida(cfg.configuracao),
    aoAvisar: avisar,
  });

  const quemAtende = agentes.dados?.agentes.find((a) => a.atende)?.nome ?? null;
  const vozPadrao = configuracao?.voz_id
    ? { id: configuracao.voz_id, nome: configuracao.voz_nome || configuracao.voz_id }
    : null;
  const situacao = controle.estado?.situacao ?? null;
  // as ligações da primeira versão: o agente que já atende vira a linha "Nina" (L43)
  const preparando = useAdotarAgenteDoTronco(situacao === "ativa", agentes.dados?.agentes);

  let topo: ReactNode;
  if (cartaoNoTopo(controle)) topo = <CartaoLigacoes controle={controle} />;
  else if (situacao === "ativa")
    topo = (
      <TopoAtivas
        numero={controle.estado?.numero ?? null}
        quemAtende={quemAtende}
        lista={historico.dados}
        agora={agora}
      />
    );
  else
    topo = (
      <TopoPendencias
        abandonada={!!controle.estado?.abandonada}
        aoVer={() => {
          setAba("ajustes");
          setTimeout(() => document.getElementById(idAba("ajustes"))?.focus(), 0);
        }}
      />
    );

  return (
    <Moldura>
      {topo}
      <Abas aba={aba} aoTrocar={setAba} />
      <div
        key={aba}
        role="tabpanel"
        id={idPainel(aba)}
        aria-labelledby={idAba(aba)}
        className={l.lgPainel}
        tabIndex={-1}
        data-painel={aba}
      >
        {aba === "historico" ? <Historico leitura={historico} agora={agora} /> : null}
        {aba === "agentes" ? (
          <Agentes
            leitura={agentes}
            acoes={acoes}
            vozPadrao={vozPadrao}
            listarVozes={cfg.acoes.listarVozes}
            avisar={avisar}
            ativas={situacao === "ativa"}
            preparando={preparando}
          />
        ) : null}
        {aba === "ajustes" ? (
          <Ajustes controle={controle} limites={limites} acoes={acoes} avisar={avisar} />
        ) : null}
      </div>
      <AvisoNaTela aviso={aviso} />
    </Moldura>
  );
}

function LigacoesAtendente() {
  const historico = useHistoricoLigacoes();
  const agentes = useAgentesLigacao();
  const situacao = useSituacaoLigacoes();
  const agora = useAgora();
  const quemAtende = agentes.dados?.agentes.find((a) => a.atende)?.nome ?? null;
  const s = situacao.dados;

  return (
    <Moldura>
      {s && !s.ativas ? (
        <section className={l.lgTopo} aria-labelledby={ID_TITULO_TOPO} data-lg-topo="desligadas">
          <div className={l.lgSituacao}>
            <span className={l.lgSituacaoIcone} data-tom="desligadas" aria-hidden="true">
              <PhoneOff size={20} strokeWidth={1.75} />
            </span>
            <div className={l.lgSituacaoTexto}>
              <h2 id={ID_TITULO_TOPO} tabIndex={-1} className={l.lgSituacaoH}>
                Ligações desligadas
              </h2>
              <p className={l.lgMeta}>Quem ativa as ligações pelo WhatsApp é um admin.</p>
            </div>
          </div>
        </section>
      ) : (
        <TopoAtivas
          numero={s?.numero ?? null}
          quemAtende={quemAtende}
          lista={historico.dados}
          agora={agora}
          conhecida={!!s}
        />
      )}
      <div className={l.lgPainel} data-painel="historico">
        <Historico leitura={historico} agora={agora} />
      </div>
    </Moldura>
  );
}

/** A linha das abas (só o admin): setas trocam de aba, como o padrão do WAI-ARIA. */
function Abas({ aba, aoTrocar }: { aba: Aba; aoTrocar: (a: Aba) => void }) {
  const refs = useRef(new Map<Aba, HTMLButtonElement>());
  const linha = useRef<HTMLDivElement>(null);
  // o indicador que desliza: a posição e a largura da aba escolhida (sem medida, a própria aba pinta)
  const [indicador, setIndicador] = useState<{ x: number; w: number } | null>(null);
  const [desliza, setDesliza] = useState(false);
  useLayoutEffect(() => {
    const medir = () => {
      const b = refs.current.get(aba);
      setIndicador(b && b.offsetWidth > 0 ? { x: b.offsetLeft, w: b.offsetWidth } : null);
    };
    medir();
    if (typeof ResizeObserver === "undefined" || !linha.current) return;
    const ro = new ResizeObserver(medir);
    ro.observe(linha.current);
    return () => ro.disconnect();
  }, [aba]);
  // a primeira medida só posiciona; deslizar, só depois dela
  useEffect(() => {
    if (!indicador || desliza || typeof requestAnimationFrame === "undefined") return;
    const q = requestAnimationFrame(() => setDesliza(true));
    return () => cancelAnimationFrame(q);
  }, [indicador, desliza]);
  const tecla = (ev: KeyboardEvent<HTMLDivElement>) => {
    const i = ABAS.findIndex((a) => a.id === aba);
    const j =
      ev.key === "ArrowRight"
        ? (i + 1) % ABAS.length
        : ev.key === "ArrowLeft"
          ? (i - 1 + ABAS.length) % ABAS.length
          : ev.key === "Home"
            ? 0
            : ev.key === "End"
              ? ABAS.length - 1
              : -1;
    if (j < 0) return;
    ev.preventDefault();
    const destino = ABAS[j]!.id;
    aoTrocar(destino);
    refs.current.get(destino)?.focus();
  };
  return (
    <div
      ref={linha}
      className={l.lgAbas}
      role="tablist"
      aria-label="Partes das ligações"
      onKeyDown={tecla}
      data-medido={indicador ? "" : undefined}
      data-desliza={desliza ? "" : undefined}
      style={
        indicador
          ? ({
              "--lg-ind-x": `${indicador.x}px`,
              "--lg-ind-w": `${indicador.w}px`,
            } as CSSProperties)
          : undefined
      }
    >
      <span className={l.lgAbaIndicador} aria-hidden="true" />
      {ABAS.map((a) => (
        <button
          key={a.id}
          ref={(el) => {
            if (el) refs.current.set(a.id, el);
            else refs.current.delete(a.id);
          }}
          type="button"
          role="tab"
          id={idAba(a.id)}
          className={l.lgAba}
          aria-selected={aba === a.id}
          aria-controls={idPainel(a.id)}
          tabIndex={aba === a.id ? 0 : -1}
          onClick={() => aoTrocar(a.id)}
        >
          {a.nome}
        </button>
      ))}
    </div>
  );
}

/** Um dos três números do topo, contando até o valor. */
function Numero({ rotulo, valor, vivo }: { rotulo: string; valor: number; vivo?: boolean }) {
  const mostrado = useContagem(valor);
  return (
    <div className={l.lgNumero} data-vivo={vivo ? "" : undefined}>
      <dt>{rotulo}</dt>
      <dd>{mostrado}</dd>
    </div>
  );
}

interface PropsTopoAtivas {
  numero: string | null;
  quemAtende: string | null;
  lista: readonly Ligacao[] | undefined;
  agora: number;
  /** A situação é conhecida (falso: o banco do atendente, até a fase B). */
  conhecida?: boolean | undefined;
}

/** O topo com as ligações ativas: a situação em uma linha e os três números. */
function TopoAtivas({ numero, quemAtende, lista, agora, conhecida = true }: PropsTopoAtivas) {
  const numeros = useMemo(() => (lista ? numerosDasLigacoes(lista, agora) : null), [lista, agora]);
  const titulo = !conhecida
    ? "Ligações pelo WhatsApp"
    : [numero ? `Ativas no ${numero}` : "Ativas", quemAtende ? `quem atende: ${quemAtende}` : null]
        .filter(Boolean)
        .join(" · ");
  return (
    <section className={l.lgTopo} aria-labelledby={ID_TITULO_TOPO} data-lg-topo="ativas">
      <div className={l.lgSituacao}>
        <span
          className={l.lgSituacaoIcone}
          aria-hidden="true"
          data-vivo={numeros && numeros.emAndamento > 0 ? "" : undefined}
        >
          <Phone size={20} strokeWidth={1.75} />
        </span>
        <div className={l.lgSituacaoTexto}>
          <h2 id={ID_TITULO_TOPO} tabIndex={-1} className={l.lgSituacaoH}>
            {titulo}
          </h2>
          {conhecida ? (
            <p className={l.lgMeta}>Ligue pelo WhatsApp para este número para testar.</p>
          ) : null}
        </div>
      </div>
      {numeros ? (
        <dl className={l.lgNumeros} aria-label="As ligações em números">
          <Numero rotulo="Ligações hoje" valor={numeros.hoje} />
          <Numero rotulo="Minutos no mês" valor={numeros.minutosNoMes} />
          <Numero
            rotulo="Em andamento"
            valor={numeros.emAndamento}
            vivo={numeros.emAndamento > 0}
          />
        </dl>
      ) : null}
    </section>
  );
}

/** O topo com pendências da desativação (ou da ativação que parou no meio): o que fazer fica nos Ajustes. */
function TopoPendencias({ abandonada, aoVer }: { abandonada: boolean; aoVer: () => void }) {
  return (
    <section className={l.lgTopo} aria-labelledby={ID_TITULO_TOPO} data-lg-topo="pendencias">
      <div className={l.lgSituacao}>
        <span className={l.lgSituacaoIcone} data-tom="desligadas" aria-hidden="true">
          <TriangleAlert size={20} strokeWidth={1.75} />
        </span>
        <div className={l.lgSituacaoTexto}>
          <h2 id={ID_TITULO_TOPO} tabIndex={-1} className={l.lgSituacaoH}>
            {abandonada ? "A ativação não terminou" : "A desativação não terminou"}
          </h2>
          <p className={l.lgMeta}>O que falta fazer está nos Ajustes.</p>
        </div>
      </div>
      <Botao variante="contorno" onClick={aoVer}>
        Ver nos Ajustes
      </Botao>
    </section>
  );
}
