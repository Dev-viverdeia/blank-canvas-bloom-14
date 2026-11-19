import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, MessageSquareText, Phone, PhoneIncoming, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";

import { NinaSimbolo } from "@/components/nina/NinaSimbolo";
import { Botao, Campo, Chip } from "@/components/subido";

import { areaPorId } from "../areas";
import { Equalizador, TempoCorrendo } from "../comum/AoVivo";
import { AvatarLead } from "../comum/AvatarLead";
import { dataLonga, horaCurta, horaLista } from "../comum/tempo";
import { Carregando, ErroLeitura, Vazio } from "../dados/estados";
import type { Leitura } from "../dados/tipos";
import { telefoneLegivel } from "../exemplo/regras";
import { l } from "./estilos";
import { SeloDaLigacao } from "./pecas";
import {
  TEXTO_FILTRO,
  duracaoCurta,
  filtrarLigacoes,
  ligacaoEmAndamento,
  seloDaLigacao,
  tempoDaFala,
  textoMotivoFim,
  type FiltroLigacoes,
  type Ligacao,
} from "./tipos";

// A aba Histórico (2.3; todo membro): a lista à esquerda, no formato do Chat
// (contato, hora, duração, agente e o selo), com os filtros e a busca; e, ao abrir uma ligação, o
// resumo, a transcrição com o tempo de cada fala, quem atendeu, quanto durou, por que terminou e
// "Abrir conversa". A lista vem da camada de dados: no tempo real, "em andamento" vira "concluída"
// sem recarregar. Abaixo de 1.100 px, a ligação aberta ocupa o lugar da lista, com "Voltar".
// Sem transcrição ao vivo: a ElevenLabs só entrega as falas no fim (o acompanhamento em tempo real
// é do plano Enterprise). Enquanto a ligação acontece, a aberta mostra quem ligou, o agente que
// atende e o tempo correndo, segundo a segundo, num cartão vivo (com o equalizador); quando o tempo
// real a encerra, o corpo troca com uma transição curta.
// O movimento: os itens entram em cascata leve, a ligação aberta entra deslizando, e a transcrição
// é uma conversa (o lead à esquerda, o agente à direita, como no Chat), com o resumo em destaque no
// topo. Tudo some com o movimento reduzido (Ligacoes.module.css).
// A ligação de saída com objetivo (A3) mostra o objetivo que a equipe
// escreveu, antes do resumo.

const FILTROS: readonly FiltroLigacoes[] = ["todas", "equipe", "nao_completadas"];

/** O nome que a lista mostra: o do contato, ou o telefone, ou "Contato sem nome". */
export function nomeNaLista(lg: Pick<Ligacao, "nome" | "telefone">): string {
  return lg.nome ?? (lg.telefone ? telefoneLegivel(lg.telefone) : "Contato sem nome");
}

/** O id do botão da linha de uma ligação (o foco volta para ele no "Voltar"). */
export const idDaLinha = (id: string) => `lg-item-${id}`;
const ID_TITULO_DETALHE = "lg-detalhe-h";

interface Props {
  leitura: Leitura<Ligacao[]>;
  agora: number;
}

export function Historico({ leitura, agora }: Props) {
  const navigate = useNavigate();
  const base = useId();
  const [filtro, setFiltro] = useState<FiltroLigacoes>("todas");
  const [busca, setBusca] = useState("");
  const [aberta, setAberta] = useState<string | null>(null);
  const focarDetalhe = useRef(false);

  const todas = leitura.dados;
  const lista = useMemo(
    () => (todas ? filtrarLigacoes(todas, filtro, busca) : []),
    [todas, filtro, busca],
  );
  const contagem = useMemo(
    () =>
      todas
        ? Object.fromEntries(FILTROS.map((f) => [f, filtrarLigacoes(todas, f, busca).length]))
        : {},
    [todas, busca],
  ) as Partial<Record<FiltroLigacoes, number>>;
  // a ligação aberta continua aberta mesmo fora do filtro (ela some da lista, não do detalhe)
  const ligacao = aberta ? (todas?.find((x) => x.id === aberta) ?? null) : null;

  useEffect(() => {
    if (!ligacao || !focarDetalhe.current) return;
    focarDetalhe.current = false;
    document.getElementById(ID_TITULO_DETALHE)?.focus({ preventScroll: true });
  }, [ligacao]);

  if (!todas) {
    if (leitura.erro)
      return (
        <ErroLeitura
          erro={leitura.erro}
          tentarDeNovo={leitura.tentarDeNovo}
          titulo="Não deu para carregar as ligações"
        />
      );
    return <Carregando forma="lista" quantos={5} rotulo="Carregando as ligações" />;
  }

  if (todas.length === 0) {
    const area = areaPorId("ligacoes");
    return (
      <Vazio
        oQueFalta={area.vazio.titulo}
        porQueImporta={area.vazio.texto}
        forma="lista"
        acao={null}
        nivelTitulo={2}
      />
    );
  }

  const abrir = (id: string) => {
    focarDetalhe.current = true;
    setAberta(id);
  };

  const voltar = () => {
    const id = aberta;
    setAberta(null);
    if (id)
      setTimeout(() => document.getElementById(idDaLinha(id))?.focus({ preventScroll: true }), 0);
  };

  const filtrado = filtro !== "todas" || busca.trim() !== "";

  return (
    <div className={l.lgHist} data-aberta={ligacao ? "" : undefined}>
      <section className={l.lgLista} aria-label="Ligações" data-lg-lista="">
        <div className={l.lgListaCab}>
          <Campo
            id={`${base}-busca`}
            rotulo="Buscar por nome ou número"
            rotuloOculto
            type="search"
            placeholder="Buscar por nome ou número"
            prefixo={<Search size={16} strokeWidth={2} aria-hidden="true" />}
            value={busca}
            onChange={(ev) => setBusca(ev.target.value)}
          />
          <div className={l.lgFiltros} role="group" aria-label="Filtrar as ligações">
            {FILTROS.map((f) => (
              <Chip
                key={f}
                rotulo={TEXTO_FILTRO[f]}
                selecionado={filtro === f}
                aoClicar={() => setFiltro(f)}
                total={contagem[f]}
              />
            ))}
          </div>
        </div>
        {lista.length === 0 ? (
          <div>
            <p className={l.lgNada}>
              {filtrado ? "Nenhuma ligação com esse filtro." : "Nenhuma ligação ainda."}
            </p>
            {filtrado ? (
              <div style={{ display: "flex", justifyContent: "center", paddingBottom: 16 }}>
                <Botao
                  variante="discreto"
                  tamanho="compacto"
                  onClick={() => {
                    setFiltro("todas");
                    setBusca("");
                  }}
                >
                  Limpar filtro e busca
                </Botao>
              </div>
            ) : null}
          </div>
        ) : (
          <ul className={l.lgItens}>
            {lista.map((lg, i) => {
              const nome = nomeNaLista(lg);
              const selo = seloDaLigacao(lg, agora);
              const hora = horaLista(lg.iniciadaEm, agora);
              const dur = lg.duracaoS ? duracaoCurta(lg.duracaoS) : null;
              const partes = [
                nome,
                TEXTO_SELO_ARIA[selo],
                hora,
                dur,
                lg.agenteNome ? `atendida por ${lg.agenteNome}` : null,
              ];
              return (
                <li key={lg.id} style={{ "--i": i } as CSSProperties}>
                  <button
                    type="button"
                    id={idDaLinha(lg.id)}
                    className={l.lgItem}
                    aria-current={aberta === lg.id ? "true" : undefined}
                    aria-label={partes.filter(Boolean).join(", ")}
                    onClick={() => abrir(lg.id)}
                    data-ligacao={lg.id}
                    data-selo={selo}
                  >
                    <AvatarLead nome={lg.nome ?? nome} chave={lg.contatoId ?? lg.id} tamanho="m" />
                    <span className={l.lgItemTxt}>
                      <span className={l.lgItemL1}>
                        <span className={l.lgItemNome}>{nome}</span>
                        <span className={l.lgItemHora}>{hora}</span>
                      </span>
                      <span className={l.lgItemL2}>
                        <SeloDaLigacao selo={selo} />
                        {selo === "andamento" ? <Equalizador /> : null}
                        {dur ? <span>{dur}</span> : null}
                        {lg.agenteNome ? <span>{lg.agenteNome}</span> : null}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {ligacao ? (
        <DetalheLigacao
          key={ligacao.id}
          ligacao={ligacao}
          agora={agora}
          aoVoltar={voltar}
          aoAbrirConversa={() =>
            void navigate({ to: "/app/chat", search: { conversa: ligacao.conversaId } })
          }
        />
      ) : (
        <section className={`${l.lgDetalhe} ${l.lgDetalheVazio}`} aria-label="Ligação aberta">
          <span className={l.lgVazioIcone} aria-hidden="true">
            <PhoneIncoming size={22} strokeWidth={1.75} />
          </span>
          <p>Escolha uma ligação para ver o resumo e a conversa.</p>
        </section>
      )}
    </div>
  );
}

/** O selo no nome acessível da linha (em minúsculas, no meio da frase). */
const TEXTO_SELO_ARIA = {
  andamento: "em andamento",
  sem_resumo: "sem resumo",
  concluida: "concluída",
  equipe: "passou para a equipe",
  nao_completada: "não completada",
} as const;

interface PropsDetalhe {
  ligacao: Ligacao;
  agora: number;
  aoVoltar: () => void;
  aoAbrirConversa: () => void;
}

/** A ligação aberta: o resumo, a transcrição, os fatos e "Abrir conversa". */
export function DetalheLigacao({ ligacao: lg, agora, aoVoltar, aoAbrirConversa }: PropsDetalhe) {
  const nome = nomeNaLista(lg);
  const primeiro = lg.nome?.trim().split(/\s+/)[0] ?? "Contato";
  const agente = lg.agenteNome ?? "Agente apagado";
  const selo = seloDaLigacao(lg, agora);
  const quando = `${dataLonga(lg.iniciadaEm)}, às ${horaCurta(lg.iniciadaEm)}`;
  // passou da duração máxima mais a folga sem o pós-chamada: não está mais em andamento (L38)
  const andamento = ligacaoEmAndamento(lg, agora);
  const duracao = lg.duracaoS ? duracaoCurta(lg.duracaoS) : "Não chegou a começar";

  return (
    <section
      className={l.lgDetalhe}
      aria-labelledby={ID_TITULO_DETALHE}
      data-lg-detalhe={lg.id}
      data-andamento={andamento ? "" : undefined}
    >
      <div className={l.lgDetalheCab}>
        <div className={l.lgDetalheTitulo}>
          <Botao
            variante="discreto"
            tamanho="compacto"
            className={l.lgVoltar}
            icone={<ArrowLeft size={16} strokeWidth={2} aria-hidden="true" />}
            onClick={aoVoltar}
          >
            Voltar
          </Botao>
          <h2 id={ID_TITULO_DETALHE} tabIndex={-1} className={l.lgDetalheH}>
            {nome}
          </h2>
          <p className={l.lgMeta}>
            {quando}
            {lg.nome && lg.telefone ? ` · ${telefoneLegivel(lg.telefone)}` : ""}
          </p>
        </div>
        <Botao
          variante="contorno"
          icone={<MessageSquareText size={16} strokeWidth={2} aria-hidden="true" />}
          onClick={aoAbrirConversa}
        >
          Abrir conversa
        </Botao>
      </div>

      <div key={andamento ? "viva" : "fim"} className={l.lgDetalheCorpo}>
        {andamento ? (
          <div className={l.lgVivo} data-lg-vivo="">
            <span className={l.lgVivoIcone} aria-hidden="true">
              <Phone size={20} strokeWidth={2} />
            </span>
            <div className={l.lgVivoTexto}>
              <p className={l.lgVivoRotulo}>Em andamento</p>
              <dl className={l.lgVivoDl}>
                <div>
                  <dt>Quem atende</dt>
                  <dd>{agente}</dd>
                </div>
                <div>
                  <dt>Duração</dt>
                  <dd className={l.lgVivoTempo}>
                    <TempoCorrendo desde={lg.iniciadaEm} />
                  </dd>
                </div>
              </dl>
            </div>
            <Equalizador tamanho="g" className={l.lgVivoEq} />
          </div>
        ) : null}

        {lg.objetivo ? (
          <div className={`${l.lgBloco} ${l.lgObjetivoLigacao}`} data-lg-objetivo="">
            <h3 className={l.lgBlocoH}>Objetivo desta ligação</h3>
            <p className={l.lgResumo}>{lg.objetivo}</p>
          </div>
        ) : null}

        <div className={l.lgResumoDestaque} data-vazio={lg.resumo ? undefined : ""}>
          <NinaSimbolo estado={lg.resumo ? "acordada" : "dormindo"} tamanho={28} decorativo />
          <div className={l.lgBloco}>
            <h3 className={l.lgBlocoH}>Resumo</h3>
            <p className={l.lgResumo}>
              {lg.resumo ??
                (andamento
                  ? "O resumo aparece aqui quando a ligação terminar."
                  : lg.status === "nao_completada"
                    ? "A ligação não se completou, então não há resumo."
                    : "Esta ligação ficou sem resumo.")}
            </p>
          </div>
        </div>

        {andamento ? null : (
          <dl className={l.lgFatos}>
            <div className={l.lgFato}>
              <dt>Situação</dt>
              <dd>
                <SeloDaLigacao selo={selo} />
              </dd>
            </div>
            <div className={l.lgFato}>
              <dt>Quem atendeu</dt>
              <dd>{agente}</dd>
            </div>
            <div className={l.lgFato}>
              <dt>Duração</dt>
              <dd>{duracao}</dd>
            </div>
            <div className={l.lgFato}>
              <dt>Por que terminou</dt>
              <dd>{textoMotivoFim(lg, agora)}</dd>
            </div>
          </dl>
        )}

        <div className={l.lgBloco}>
          <h3 className={l.lgBlocoH}>Transcrição</h3>
          {lg.transcricao.length === 0 ? (
            <p className={l.lgAjuda}>
              {andamento
                ? "A transcrição aparece quando a ligação terminar: a ElevenLabs entrega as falas só no fim."
                : "Sem transcrição."}
            </p>
          ) : (
            <ol className={l.lgFalas} aria-label="Falas da ligação">
              {lg.transcricao.map((f, i) => (
                <li
                  key={i}
                  className={l.lgFala}
                  data-papel={f.papel}
                  style={{ "--i": i } as CSSProperties}
                >
                  <span className={l.lgFalaTempo}>{tempoDaFala(f.segundos)}</span>
                  <span className={l.lgFalaQuem}>{f.papel === "agente" ? agente : primeiro}</span>
                  <p className={l.lgFalaTexto}>{f.texto}</p>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}
