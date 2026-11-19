import { Clock, ExternalLink, Phone, PhoneCall, TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { AncoraBotao, AreaTexto, Botao, Giro } from "@/components/subido";
import type { Classes } from "@/components/subido/cx";

import { useAgentesParaLigar, useLigarSaida } from "../dados/ligarSaida";
import { SeloUso } from "../ligacoes/pecas";
import estilos from "./BotaoLigar.module.css";
import {
  MAX_OBJETIVO_LIGACAO,
  TEXTO_DESATUALIZADO,
  TEXTO_ESCOLHIDO_SAIU,
  TEXTO_INDISPONIVEL,
  agenteEscolhido,
  agentePadrao,
  linkWhatsApp,
  objetivoDoPedido,
  objetivoPassou,
  podeRepetir,
  tamanhoObjetivo,
  textoDoPainel,
  textoFalhaSaida,
  textoLigando,
} from "./ligar";

const s = estilos as Classes<
  | "lgrRaiz"
  | "lgrBotao"
  | "lgrBotaoTexto"
  | "lgrPainel"
  | "lgrGrupo"
  | "lgrLegenda"
  | "lgrOpcoes"
  | "lgrOpcao"
  | "lgrOpcaoTexto"
  | "lgrOpcaoNome"
  | "lgrOpcaoLinha"
  | "lgrOpcaoMotivo"
  | "lgrPermissao"
  | "lgrCab"
  | "lgrIcone"
  | "lgrTitulo"
  | "lgrTexto"
  | "lgrDetalhe"
  | "lgrFalha"
  | "lgrPe"
  | "lgrLendo"
>;

interface Props {
  conversaId: string;
  /** O nome do lead ("Ligar para Juliana"). */
  nome: string;
  /** O telefone do lead (só dígitos, como no banco); nulo quando o contato só tem o BSUID. */
  telefone: string | null;
  /** O toast da tela. */
  aoAvisar: (texto: string) => void;
}

type Modo = "agente" | "eu";

/**
 * O botão "Ligar" da conversa (seção 6, e a spec).
 * Só aparece com as ligações ativas, para todo membro (ligar não tira a conversa de ninguém). A
 * janela abre ao clicar e pergunta "Como ligar":
 * - com um agente: a lista de `agentesParaLigar` (os Ativos primeiro; o indisponível desabilitado,
 *   com o motivo; o desatualizado com um aviso), o objetivo opcional (até 500 caracteres, aparado)
 *   e, abaixo, o painel de permissão de
 *   antes: ligar, pedir para ligar (dentro das 24 h), aguardando o lead (relê a cada 10 s), ou por que
 *   não dá agora. A permissão e os agentes só são lidos com a janela aberta;
 * - eu mesmo, pelo meu WhatsApp: o link `wa.me` do telefone do lead, numa aba nova. Não passa pela
 *   Nina nem pelo servidor; sem o telefone, a opção fica desabilitada.
 * Ligar fecha a janela e avisa com o nome do agente. Esc e o clique fora fecham.
 * O agente padrão só é marcado na primeira abertura (na conversa), sem nada marcado. Depois, a janela
 * nunca troca o agente sozinha: se o marcado sumir ou ficar indisponível ao reler, o "Ligar agora"
 * fica desabilitado e a janela pede para escolher outro. A recusa `agente_indisponivel` relê a lista.
 */
export function BotaoLigar({ conversaId, nome, telefone, aoAvisar }: Props) {
  const [aberto, setAberto] = useState(false);
  const [modo, setModo] = useState<Modo>("agente");
  // undefined = o padrão ainda não foi marcado; null = nada marcado
  const [marcado, setMarcado] = useState<string | null | undefined>(undefined);
  const [objetivo, setObjetivo] = useState("");
  const controle = useLigarSaida(conversaId, aberto);
  // a janela e a conversa de agora, para a resposta que chega depois de fechar ou trocar (Sol, PR #26)
  const atual = useRef({ aberto, conversaId });
  atual.current = { aberto, conversaId };
  const lista = useAgentesParaLigar(aberto);
  const { estado, agindo, falha } = controle;
  const raiz = useRef<HTMLDivElement>(null);
  const botao = useRef<HTMLButtonElement>(null);
  const primeiroFoco = useRef<HTMLInputElement>(null);
  const base = useId();
  const idPainel = `${base}-painel`;

  // trocar de conversa fecha a janela e começa do zero (o objetivo é de uma conversa só)
  useEffect(() => {
    setAberto(false);
    setModo("agente");
    setMarcado(undefined);
    setObjetivo("");
  }, [conversaId]);

  // ao abrir, o foco vai para o "Como ligar"
  useEffect(() => {
    if (aberto) primeiroFoco.current?.focus({ preventScroll: true });
  }, [aberto]);

  // Esc e o clique fora fecham (o foco volta para o botão no Esc)
  useEffect(() => {
    if (!aberto) return;
    const tecla = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || ev.defaultPrevented) return;
      ev.preventDefault();
      setAberto(false);
      botao.current?.focus();
    };
    const fora = (ev: PointerEvent) => {
      if (raiz.current && !raiz.current.contains(ev.target as Node)) setAberto(false);
    };
    document.addEventListener("keydown", tecla);
    document.addEventListener("pointerdown", fora);
    return () => {
      document.removeEventListener("keydown", tecla);
      document.removeEventListener("pointerdown", fora);
    };
  }, [aberto]);

  const wa = linkWhatsApp(telefone);
  const agentes = lista.agentes ?? [];
  // o padrão, uma vez só: na primeira lista lida com a janela aberta (o ajuste no render do React)
  if (marcado === undefined && aberto && lista.agentes && !lista.lendo)
    setMarcado(agentePadrao(lista.agentes));
  const { agente, saiu } = agenteEscolhido(agentes, marcado ?? null);
  const algumPronto = agentes.some((a) => a.indisponivel === null);
  const passou = objetivoPassou(objetivo);
  const tamanho = tamanhoObjetivo(objetivo);

  const ligar = async () => {
    if (!agente || passou) return;
    const daConversa = conversaId;
    const r = await controle.ligar({ agenteId: agente.id, objetivo: objetivoDoPedido(objetivo) });
    // fechada (ou outra conversa) enquanto ligava: nada a reler numa lista que já foi limpa
    const mesmaJanela = atual.current.aberto && atual.current.conversaId === daConversa;
    if (r.ok) {
      setAberto(false);
      setObjetivo("");
      aoAvisar(textoLigando(agente.nome, nome));
    } else if (r.erro === "agente_indisponivel" && mesmaJanela) {
      // o agente deixou de estar pronto: a lista nova mostra por quê (e não troca sozinha)
      lista.ler();
    }
  };

  const fecharEVoltar = () => {
    setAberto(false);
    botao.current?.focus();
  };

  const t = estado ? textoDoPainel(estado, nome) : null;
  const lendo = !estado && agindo === "lendo";
  // a ligação pode ter saído (a ElevenLabs não confirmou a tempo): sem convite para tentar já
  const acaoLiberada = podeRepetir(falha);
  const ocupado = agindo !== null && agindo !== "lendo";
  const Icone = !t
    ? Phone
    : t.tom === "ok"
      ? PhoneCall
      : t.tom === "espera"
        ? Clock
        : TriangleAlert;

  return (
    <div ref={raiz} className={s.lgrRaiz}>
      <button
        ref={botao}
        type="button"
        className={s.lgrBotao}
        aria-expanded={aberto}
        aria-controls={aberto ? idPainel : undefined}
        aria-label={`Ligar para ${nome}`}
        data-aberto={aberto || undefined}
        onClick={() => setAberto((a) => !a)}
      >
        <Phone size={16} aria-hidden="true" />
        <span className={s.lgrBotaoTexto}>Ligar</span>
      </button>

      {aberto && (
        <div
          id={idPainel}
          className={s.lgrPainel}
          role="dialog"
          aria-label={`Ligar para ${nome}`}
          data-lgr-painel=""
          aria-busy={agindo !== null || lista.lendo || undefined}
        >
          <fieldset className={s.lgrGrupo} data-lgr-modo="">
            <legend className={s.lgrTitulo}>Como ligar</legend>
            <div className={s.lgrOpcoes}>
              <label className={s.lgrOpcao}>
                <input
                  ref={modo === "agente" ? primeiroFoco : undefined}
                  type="radio"
                  name={`${base}-modo`}
                  value="agente"
                  checked={modo === "agente"}
                  onChange={() => setModo("agente")}
                />
                <span className={s.lgrOpcaoTexto}>
                  <span className={s.lgrOpcaoNome}>Com um agente</span>
                </span>
              </label>
              <label className={s.lgrOpcao}>
                <input
                  ref={modo === "eu" ? primeiroFoco : undefined}
                  type="radio"
                  name={`${base}-modo`}
                  value="eu"
                  checked={modo === "eu"}
                  disabled={!wa}
                  aria-describedby={wa ? undefined : `${base}-sem-tel`}
                  onChange={() => setModo("eu")}
                />
                <span className={s.lgrOpcaoTexto}>
                  <span className={s.lgrOpcaoNome}>Eu mesmo, pelo meu WhatsApp</span>
                  {wa ? null : (
                    <span className={s.lgrOpcaoMotivo} id={`${base}-sem-tel`}>
                      Sem o telefone do lead
                    </span>
                  )}
                </span>
              </label>
            </div>
          </fieldset>

          {modo === "eu" && wa ? (
            <div className={s.lgrPermissao} data-lgr-eu="">
              <p className={s.lgrTexto}>
                O WhatsApp abre numa aba nova (no celular, no app), com o número de {nome}. O lead
                vê o seu número, não o da empresa. Esta ligação não passa pela Nina e não fica na
                conversa.
              </p>
              <div className={s.lgrPe}>
                <AncoraBotao
                  href={wa}
                  externo
                  tamanho="compacto"
                  iconeDepois={<ExternalLink size={14} aria-hidden="true" />}
                  onClick={fecharEVoltar}
                >
                  Abrir o WhatsApp
                </AncoraBotao>
              </div>
            </div>
          ) : (
            <>
              <fieldset className={s.lgrGrupo} data-lgr-agentes="">
                <legend className={s.lgrLegenda}>Agente</legend>
                {lista.agentes === null && lista.falha ? (
                  <>
                    <p className={s.lgrFalha} role="alert">
                      {textoFalhaSaida(lista.falha)}
                    </p>
                    <div className={s.lgrPe}>
                      <Botao variante="contorno" tamanho="compacto" onClick={lista.ler}>
                        Tentar de novo
                      </Botao>
                    </div>
                  </>
                ) : lista.agentes === null ? (
                  <div className={s.lgrLendo}>
                    <Giro tamanho={16} />
                    <span>Carregando os agentes…</span>
                  </div>
                ) : agentes.length === 0 ? (
                  <p className={s.lgrDetalhe}>
                    Nenhum agente de voz ainda. Um admin cria em Ligações → Agentes.
                  </p>
                ) : (
                  <>
                    <div className={s.lgrOpcoes}>
                      {agentes.map((a) => {
                        const idMotivo = `${base}-motivo-${a.id}`;
                        const aviso = a.indisponivel !== null || a.desatualizado;
                        return (
                          <label
                            key={a.id}
                            className={s.lgrOpcao}
                            data-lgr-agente={a.id}
                            data-indisponivel={a.indisponivel ? "" : undefined}
                            data-desatualizado={a.desatualizado ? "" : undefined}
                          >
                            <input
                              type="radio"
                              name={`${base}-agente`}
                              value={a.id}
                              checked={marcado === a.id}
                              disabled={a.indisponivel !== null || ocupado}
                              aria-describedby={aviso ? idMotivo : undefined}
                              onChange={() => {
                                setMarcado(a.id);
                                // a recusa do agente anterior não vale para o novo; as outras falhas
                                // (a ligação que pode ter saído, a leitura) ficam (Opus, PR #26)
                                if (controle.falha?.erro === "agente_indisponivel") {
                                  controle.limparFalha();
                                }
                              }}
                            />
                            <span className={s.lgrOpcaoTexto}>
                              <span className={s.lgrOpcaoLinha}>
                                <span className={s.lgrOpcaoNome}>{a.nome}</span>
                                <SeloUso uso={a.uso} />
                              </span>
                              {a.indisponivel ? (
                                <span className={s.lgrOpcaoMotivo} id={idMotivo}>
                                  {TEXTO_INDISPONIVEL[a.indisponivel]}
                                </span>
                              ) : a.desatualizado ? (
                                <span className={s.lgrOpcaoMotivo} id={idMotivo}>
                                  {TEXTO_DESATUALIZADO}
                                </span>
                              ) : null}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                    {saiu ? (
                      <p className={s.lgrFalha} role="status" data-lgr-saiu="">
                        {TEXTO_ESCOLHIDO_SAIU}
                      </p>
                    ) : !algumPronto ? (
                      <p className={s.lgrDetalhe}>
                        Nenhum agente está pronto para ligar agora. Um admin confere em Ligações →
                        Agentes.
                      </p>
                    ) : agente ? null : (
                      <p className={s.lgrDetalhe}>Escolha o agente que vai ligar.</p>
                    )}
                  </>
                )}
              </fieldset>

              <AreaTexto
                id={`${base}-objetivo`}
                rotulo="Objetivo desta ligação (opcional)"
                linhas={2}
                placeholder="Ex.: retomar o orçamento de ontem e combinar a visita"
                value={objetivo}
                disabled={ocupado}
                erro={
                  passou
                    ? `O objetivo tem ${tamanho} caracteres; o limite é ${MAX_OBJETIVO_LIGACAO}. Encurte para ligar.`
                    : undefined
                }
                dica={`${tamanho}/${MAX_OBJETIVO_LIGACAO} · O agente recebe o objetivo junto das instruções dele.`}
                onChange={(ev) => setObjetivo(ev.target.value)}
              />

              <div className={s.lgrPermissao} data-lgr-permissao="">
                {lendo || (!t && !falha) ? (
                  <div className={s.lgrLendo}>
                    <Giro tamanho={16} />
                    <span>Conferindo a permissão do lead…</span>
                  </div>
                ) : (
                  <>
                    {t && (
                      <>
                        <div className={s.lgrCab}>
                          <span className={s.lgrIcone} data-tom={t.tom} aria-hidden="true">
                            <Icone size={16} />
                          </span>
                          <h3 className={s.lgrTitulo}>{t.titulo}</h3>
                        </div>
                        <p className={s.lgrTexto}>{t.texto}</p>
                        {t.detalhe && <p className={s.lgrDetalhe}>{t.detalhe}</p>}
                      </>
                    )}
                    {falha && (
                      <p className={s.lgrFalha} role="alert">
                        {textoFalhaSaida(falha)}
                      </p>
                    )}
                    <div className={s.lgrPe}>
                      {!t && falha ? (
                        <Botao variante="contorno" tamanho="compacto" onClick={controle.ler}>
                          Tentar de novo
                        </Botao>
                      ) : null}
                      {acaoLiberada && t?.acao === "ligar" && (
                        <Botao
                          tamanho="compacto"
                          carregando={agindo === "ligando"}
                          disabled={ocupado || !agente || passou}
                          onClick={() => void ligar()}
                        >
                          {agindo === "ligando" ? "Ligando…" : t.botao}
                        </Botao>
                      )}
                      {acaoLiberada && t?.acao === "pedir" && (
                        <Botao
                          tamanho="compacto"
                          carregando={agindo === "pedindo"}
                          disabled={ocupado}
                          onClick={controle.pedir}
                        >
                          {agindo === "pedindo" ? "Enviando…" : t.botao}
                        </Botao>
                      )}
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
