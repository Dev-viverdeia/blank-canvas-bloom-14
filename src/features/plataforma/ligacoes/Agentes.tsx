import { PhoneIncoming, Plus } from "lucide-react";
import { useState, type CSSProperties } from "react";

import { NinaSimbolo } from "@/components/nina/NinaSimbolo";
import { Aviso, Botao } from "@/components/subido";
import type { ResultadoListaVozes } from "@/features/servidor/vozes-tipos";

import { Gaveta } from "../comum/Gaveta";
import type { AcoesLigacoes, AgentesLigacao } from "../dados/ligacoes";
import { Carregando, ErroLeitura } from "../dados/estados";
import type { Leitura } from "../dados/tipos";
import { EditorAgente } from "./EditorAgente";
import { l } from "./estilos";
import { SeloUso, type TomAvisoCurto } from "./pecas";
import { TEXTO_ATUALIZACAO, TEXTO_ATUALIZACAO_CONTEXTO, textoFalhaAgente } from "./textos";
import {
  TEXTO_OBJETIVO,
  TEXTO_PERFIL,
  camposPadrao,
  duracaoCurta,
  usoPadraoDoNovo,
  type AgenteLigacao,
} from "./tipos";

// A aba Agentes (L2, L3, L10, L13 e 2.3; só o admin): um cartão por agente,
// com nome, objetivo e "Atende as ligações" (selo) ou "Atender as ligações" (botão); "Novo agente", que
// nasce com os padrões; o editor numa gaveta; e o aviso "Há uma atualização para os agentes" quando a
// versão aplicada de algum é menor que a do código, ou quando algum está atrás do Contexto (L14). Só
// contam os agentes que já existem na ElevenLabs (com id_externo).
// O cartão tem o símbolo da Nina: acordado e falando em quem atende, em repouso nos outros. Trocar
// quem atende acorda um e põe o outro para descansar (a transição do próprio NinaSimbolo), e o selo
// "Atende as ligações" chega ao cartão novo com uma mola curta.
// O uso (A1): cada cartão tem o selo "Receptiva" ou "Ativa"; só o
// Receptivo tem o "Atender as ligações". O "Novo agente" nasce Ativo quando já há quem atenda.

/** O id do título do cartão de um agente (o foco volta para ele quando o editor fecha). */
const idCartao = (id: string) => `lg-agente-${id}`;
const ID_NOVO = "lg-novo-agente";

type Editando = { tipo: "novo" } | { tipo: "agente"; id: string } | null;

interface Props {
  leitura: Leitura<AgentesLigacao>;
  acoes: AcoesLigacoes;
  /** A voz escolhida da Nina (na Configuração): a voz de um agente novo. */
  vozPadrao: { id: string; nome: string } | null;
  /** As vozes da conta da ElevenLabs (a Configuração lista). */
  listarVozes: () => Promise<ResultadoListaVozes>;
  avisar: (texto: string, tom?: TomAvisoCurto) => void;
  /** As ligações estão ativas (o vazio não promete o "Nina" da ativação). */
  ativas?: boolean | undefined;
  /** O agente da primeira versão está sendo trazido para a lista (L43). */
  preparando?: boolean | undefined;
}

/** O vazio da aba, com as ligações ativas ou não (L43). */
export const VAZIO_AGENTES_DESLIGADAS =
  "Nenhum agente ainda. O agente “Nina” nasce quando você ativa as ligações; você também pode criar um agora.";
export const VAZIO_AGENTES_ATIVAS =
  "Nenhum agente na lista. As ligações já estão ativas: crie um agente e ele passa a atender o número.";

/** A voz do cartão: a própria, ou a da Nina (o cartão Voz) para quem não escolheu (L37). */
function textoVoz(a: AgenteLigacao, vozPadrao: { nome: string } | null): string {
  if (a.vozNome) return a.vozNome;
  if (a.vozId) return "Voz própria";
  return vozPadrao ? `${vozPadrao.nome} (a voz da Nina)` : "Sem voz escolhida";
}

export function Agentes({
  leitura,
  acoes,
  vozPadrao,
  listarVozes,
  avisar,
  ativas = false,
  preparando = false,
}: Props) {
  const [editando, setEditando] = useState<Editando>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const dados = leitura.dados;
  if (!dados) {
    if (leitura.erro)
      return (
        <ErroLeitura
          erro={leitura.erro}
          tentarDeNovo={leitura.tentarDeNovo}
          titulo="Não deu para carregar os agentes"
        />
      );
    return <Carregando forma="cartao" quantos={2} rotulo="Carregando os agentes" />;
  }

  const { agentes, versaoCodigo } = dados;
  // só conta quem já existe na ElevenLabs: o agente sem id_externo nasce com a versão 0, e o
  // "Atualizar" não muda nada nele com as ligações desligadas
  const atrasVersao = (a: AgenteLigacao) => !a.semAgenteLa && a.versaoConfig < versaoCodigo;
  const daVersao = agentes.filter(atrasVersao).length;
  const doContexto = agentes.filter((a) => a.atrasadoContexto).length;
  const desatualizados = agentes.filter((a) => atrasVersao(a) || a.atrasadoContexto).length;
  const aberto =
    editando?.tipo === "agente" ? (agentes.find((a) => a.id === editando.id) ?? null) : null;

  const atender = (a: AgenteLigacao) => {
    if (ocupado) return;
    setErro(null);
    setOcupado(`atender:${a.id}`);
    void acoes.atender(a.id).then((r) => {
      setOcupado(null);
      if (!r.ok) {
        setErro(textoFalhaAgente(r));
        return;
      }
      avisar(`Agora ${a.nome} atende as ligações.`);
      setTimeout(() => document.getElementById(idCartao(a.id))?.focus({ preventScroll: true }), 0);
    });
  };

  const atualizar = () => {
    if (ocupado) return;
    setErro(null);
    setOcupado("atualizar");
    void acoes.atualizarAgentes().then((r) => {
      setOcupado(null);
      if (!r.ok) {
        setErro(textoFalhaAgente(r));
        return;
      }
      avisar(desatualizados === 1 ? "Agente atualizado." : "Agentes atualizados.");
    });
  };

  const fechar = (foco: string | null) => {
    const anterior = editando;
    setEditando(null);
    const alvo = foco ?? (anterior?.tipo === "agente" ? idCartao(anterior.id) : ID_NOVO);
    setTimeout(() => document.getElementById(alvo)?.focus({ preventScroll: true }), 0);
  };

  return (
    <div className={l.lgAgentes}>
      {desatualizados > 0 ? (
        <Aviso
          tom="info"
          titulo="Há uma atualização para os agentes"
          acao={
            <Botao
              variante="contorno"
              tamanho="compacto"
              carregando={ocupado === "atualizar"}
              disabled={!!ocupado}
              onClick={atualizar}
            >
              Atualizar
            </Botao>
          }
        >
          {daVersao > 0 ? TEXTO_ATUALIZACAO : null}
          {daVersao > 0 && doContexto > 0 ? " " : null}
          {doContexto > 0 ? TEXTO_ATUALIZACAO_CONTEXTO : null}
        </Aviso>
      ) : null}

      {erro ? (
        <Aviso tom="erro" compacto aoFechar={() => setErro(null)}>
          {erro}
        </Aviso>
      ) : null}

      <div className={l.lgAgentesCab}>
        <p className={l.lgAjuda} style={{ maxWidth: "40rem" }}>
          Um agente Receptivo atende as ligações do número; os Ativos fazem as ligações que a equipe
          pede na conversa. Cada um tem o seu objetivo, a sua voz e o seu jeito de passar para a
          equipe. Trocar quem atende é um clique.
        </p>
        <Botao
          id={ID_NOVO}
          icone={<Plus size={16} strokeWidth={2} aria-hidden="true" />}
          onClick={() => setEditando({ tipo: "novo" })}
          disabled={!!ocupado || preparando}
        >
          Novo agente
        </Botao>
      </div>

      {agentes.length === 0 && preparando ? (
        <Carregando
          forma="cartao"
          quantos={1}
          rotulo="Trazendo o agente que já atende as ligações"
        />
      ) : agentes.length === 0 ? (
        <div className={l.lgVazioAgentes}>
          <NinaSimbolo estado="dormindo" tamanho={56} decorativo />
          <p className={l.lgVazioTexto}>
            {ativas ? VAZIO_AGENTES_ATIVAS : VAZIO_AGENTES_DESLIGADAS}
          </p>
        </div>
      ) : (
        <ul className={l.lgCartoes} aria-label="Agentes de voz">
          {agentes.map((a, i) => (
            <li
              key={a.id}
              className={l.lgCartao}
              data-atende={a.atende ? "" : undefined}
              data-agente={a.id}
              style={{ "--i": i } as CSSProperties}
            >
              <div className={l.lgCartaoCab}>
                <NinaSimbolo
                  estado={a.atende ? "fala" : "dormindo"}
                  tamanho={44}
                  decorativo
                  className={l.lgCartaoAvatar}
                />
                <div className={l.lgCartaoTitulo}>
                  <h3 id={idCartao(a.id)} tabIndex={-1} className={l.lgCartaoH}>
                    {a.nome}
                  </h3>
                  <div className={l.lgCartaoMeta}>
                    <SeloUso uso={a.uso} />
                    <p className={l.lgMeta} data-objetivo="">
                      <span className={l.lgSr}>Objetivo: </span>
                      {TEXTO_OBJETIVO[a.objetivo]}
                    </p>
                  </div>
                </div>
              </div>
              <dl className={l.lgCartaoDl}>
                <dt>Voz</dt>
                <dd>{textoVoz(a, vozPadrao)}</dd>
                <dt>Perfil</dt>
                <dd>{TEXTO_PERFIL[a.perfil].nome}</dd>
                <dt>Duração</dt>
                <dd>até {duracaoCurta(a.duracaoMaxS)}</dd>
              </dl>
              {a.erroSincronia ? (
                <p className={l.lgCartaoErro}>
                  Não deu para levar a última mudança: {a.erroSincronia}
                </p>
              ) : null}
              <div className={l.lgCartaoPe}>
                {a.atende ? (
                  <span className={l.lgAtende} data-selo-atende="">
                    <PhoneIncoming size={16} strokeWidth={2} aria-hidden="true" />
                    Atende as ligações
                  </span>
                ) : a.uso !== "receber" ? null : (
                  <Botao
                    variante="contorno"
                    tamanho="compacto"
                    carregando={ocupado === `atender:${a.id}`}
                    disabled={!!ocupado}
                    onClick={() => atender(a)}
                    aria-label={`Atender as ligações com ${a.nome}`}
                  >
                    Atender as ligações
                  </Botao>
                )}
                <Botao
                  variante="discreto"
                  tamanho="compacto"
                  className={l.lgEmpurra}
                  onClick={() => setEditando({ tipo: "agente", id: a.id })}
                  aria-label={`Editar ${a.nome}`}
                >
                  Editar
                </Botao>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Gaveta
        aberta={editando !== null && (editando.tipo === "novo" || aberto !== null)}
        aoFechar={() => fechar(null)}
        largura={560}
        rotulo={editando?.tipo === "novo" ? "Novo agente" : `Editar ${aberto?.nome ?? "agente"}`}
      >
        {editando ? (
          <EditorAgente
            key={editando.tipo === "novo" ? "novo" : editando.id}
            agente={aberto}
            inicial={aberto ?? camposPadrao(vozPadrao, usoPadraoDoNovo(agentes))}
            primeiro={agentes.length === 0}
            listarVozes={listarVozes}
            acoes={acoes}
            aoFechar={() => fechar(null)}
            aoTerminar={(texto, id) => {
              avisar(texto);
              fechar(id ? idCartao(id) : ID_NOVO);
            }}
          />
        ) : null}
      </Gaveta>
    </div>
  );
}
