import { useId, useState } from "react";

import { AreaTexto, Aviso, Botao, Campo } from "@/components/subido";
import { ListaDeVozes, useListaVozes } from "@/features/onboarding/lista";
import type { ResultadoListaVozes } from "@/features/servidor/vozes-tipos";

import { AtalhoArea } from "../comum/AtalhoArea";
import { FecharGaveta } from "../comum/Gaveta";
import type { AcoesLigacoes } from "../dados/ligacoes";
import { l } from "./estilos";
import { Passo } from "./pecas";
import { textoFalhaAgente } from "./textos";
import {
  LIMITES_AGENTE,
  OBJETIVOS,
  PERFIS_AGENTE,
  TEXTO_OBJETIVO,
  TEXTO_PERFIL,
  TEXTO_USO,
  USOS,
  conferirCampos,
  motivoSemAtiva,
  saudacaoAoTrocarUso,
  type AgenteLigacao,
  type CamposAgente,
  type UsoAgente,
} from "./tipos";

// O editor de um agente de voz (2.3), na gaveta da aba Agentes: nome,
// objetivo e instruções, "O que ela sabe" (o Contexto, com o atalho), quando passar para a equipe (igual
// à Nina de texto ou regras próprias), a voz (a lista da conta, com "Ouvir"), o perfil em três opções,
// a saudação, a duração máxima e o desligar no silêncio (com − e +, como o Ritmo da Configuração).
// Agente novo nasce com os padrões (L5). Apagar só o que não atende (L10), com a confirmação no pé.
// "Para que serve" (A1 e A4): Receptiva ou Ativa. O que atende e o
// primeiro agente ficam Receptivos (a Ativa aparece desabilitada, com o motivo). No agente novo e
// no que já existe, trocar o uso troca a saudação-modelo, mas nunca a que o admin escreveu.

const ID_TITULO = "lg-editor-h";

/** A lista de vozes sem a chave da ElevenLabs: diz onde conectar, e não "confira a internet". */
export const VOZES_SEM_CHAVE =
  "Falta a chave da ElevenLabs. Conecte a chave na Configuração, no cartão Voz da Nina, para escolher a voz do agente.";

interface Props {
  /** O agente aberto; nulo = um agente novo. */
  agente: AgenteLigacao | null;
  inicial: CamposAgente;
  listarVozes: () => Promise<ResultadoListaVozes>;
  acoes: AcoesLigacoes;
  aoFechar: () => void;
  /** Gravou: o aviso curto e o agente (para o foco voltar para o cartão dele). */
  aoTerminar: (texto: string, agenteId: string | null) => void;
  /** Ainda não há agente: o novo vai atender o número, então é Receptivo. */
  primeiro?: boolean | undefined;
}

export function EditorAgente({
  agente,
  inicial,
  listarVozes,
  acoes,
  aoFechar,
  aoTerminar,
  primeiro = false,
}: Props) {
  const base = useId();
  const [campos, setCampos] = useState<CamposAgente>(inicial);
  const [erroCampo, setErroCampo] = useState<{ campo: keyof CamposAgente; texto: string } | null>(
    null,
  );
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [confirmarApagar, setConfirmarApagar] = useState(false);
  // a lista da conta; sem a chave da ElevenLabs, o pedido diz onde conectar
  const [carregarVozes] = useState(() => async (): Promise<ResultadoListaVozes> => {
    const r = await listarVozes();
    return !r.ok && r.erro === "sem_chave" ? { ...r, mensagem: VOZES_SEM_CHAVE } : r;
  });
  const vozes = useListaVozes(carregarVozes);
  const novo = agente === null;

  const mudar = <K extends keyof CamposAgente>(campo: K, valor: CamposAgente[K]) => {
    setCampos((c) => ({ ...c, [campo]: valor }));
    if (erroCampo?.campo === campo) setErroCampo(null);
  };

  const semAtiva = motivoSemAtiva(agente, primeiro);

  const mudarUso = (uso: UsoAgente) => {
    if (uso === "ligar" && semAtiva) return;
    // a saudação-modelo acompanha o uso (a escrita pelo admin fica), no novo e ao editar
    setCampos((c) => ({ ...c, uso, saudacao: saudacaoAoTrocarUso(c.saudacao, uso) }));
    if (erroCampo?.campo === "uso" || erroCampo?.campo === "saudacao") setErroCampo(null);
  };

  const erroDe = (campo: keyof CamposAgente) =>
    erroCampo?.campo === campo ? erroCampo.texto : undefined;

  const salvar = () => {
    if (salvando) return;
    const c = conferirCampos(campos);
    if (!c.ok) {
      setErroCampo({ campo: c.campo, texto: c.texto });
      const alvo = c.campo === "regrasEquipe" ? `${base}-regras` : `${base}-${c.campo}`;
      setTimeout(() => document.getElementById(alvo)?.focus(), 0);
      return;
    }
    setErro(null);
    setSalvando(true);
    const pedido = novo ? acoes.criarAgente(c.campos) : acoes.salvarAgente(agente.id, c.campos);
    void pedido.then((r) => {
      setSalvando(false);
      if (!r.ok) {
        setErro(textoFalhaAgente(r));
        return;
      }
      aoTerminar(
        novo ? `Agente ${c.campos.nome} criado.` : "Agente salvo.",
        novo ? (r.id ?? null) : agente.id,
      );
    });
  };

  const apagar = () => {
    if (!agente || salvando) return;
    setErro(null);
    setSalvando(true);
    void acoes.apagarAgente(agente.id).then((r) => {
      setSalvando(false);
      setConfirmarApagar(false);
      if (!r.ok) {
        setErro(textoFalhaAgente(r));
        return;
      }
      aoTerminar(`Agente ${agente.nome} apagado.`, null);
    });
  };

  const { duracaoMaxS: D, silencioS: S } = LIMITES_AGENTE;
  const proprias = campos.regrasEquipe !== null;
  const minutos = campos.duracaoMaxS / 60;

  return (
    <div className={l.lgEditor} data-lg-editor={agente?.id ?? "novo"}>
      <div className={l.lgEditorCab}>
        <h2 id={ID_TITULO} className={l.lgEditorH}>
          {novo ? "Novo agente" : `Editar ${agente.nome}`}
        </h2>
        <FecharGaveta aoFechar={aoFechar} />
      </div>

      <div className={l.lgEditorCorpo}>
        {erro ? (
          <Aviso tom="erro" compacto>
            {erro}
          </Aviso>
        ) : null}

        <Campo
          id={`${base}-nome`}
          rotulo="Nome"
          data-autofocus=""
          value={campos.nome}
          maxLength={LIMITES_AGENTE.nome.max}
          erro={erroDe("nome")}
          dica="Só para você reconhecer o agente aqui. Ex.: Vendas, Suporte."
          onChange={(ev) => mudar("nome", ev.target.value)}
        />

        <fieldset className={l.lgGrupo} data-lg-uso="">
          <legend className={l.lgGrupoH}>Para que serve</legend>
          <div className={l.lgOpcoes}>
            {USOS.map((u) => {
              const travada = u === "ligar" && semAtiva !== null;
              return (
                <label key={u} className={l.lgOpcao}>
                  <input
                    type="radio"
                    name={`${base}-uso`}
                    value={u}
                    checked={campos.uso === u}
                    disabled={salvando || travada}
                    onChange={() => mudarUso(u)}
                    aria-describedby={
                      travada ? `${base}-uso-${u} ${base}-uso-motivo` : `${base}-uso-${u}`
                    }
                  />
                  <span className={l.lgOpcaoTexto}>
                    <span className={l.lgOpcaoNome}>{TEXTO_USO[u].nome}</span>
                    <span className={l.lgOpcaoLinha} id={`${base}-uso-${u}`}>
                      {TEXTO_USO[u].linha}
                    </span>
                    {travada ? (
                      <span className={l.lgOpcaoMotivo} id={`${base}-uso-motivo`}>
                        {semAtiva}
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <fieldset className={l.lgGrupo}>
          <legend className={l.lgGrupoH}>Objetivo</legend>
          <div className={l.lgOpcoes} data-linha="">
            {OBJETIVOS.map((o) => (
              <label key={o} className={l.lgOpcao}>
                <input
                  type="radio"
                  name={`${base}-objetivo`}
                  value={o}
                  checked={campos.objetivo === o}
                  onChange={() => mudar("objetivo", o)}
                />
                <span className={l.lgOpcaoTexto}>
                  <span className={l.lgOpcaoNome}>{TEXTO_OBJETIVO[o]}</span>
                </span>
              </label>
            ))}
          </div>
          <AreaTexto
            id={`${base}-instrucoes`}
            rotulo="Instruções"
            linhas={4}
            maxCaracteres={LIMITES_AGENTE.instrucoes.max}
            value={campos.instrucoes}
            erro={erroDe("instrucoes")}
            dica="O que este agente faz na ligação, com as suas palavras. Pode ficar em branco."
            onChange={(ev) => mudar("instrucoes", ev.target.value)}
          />
        </fieldset>

        <div className={l.lgGrupo}>
          <h3 className={l.lgGrupoH}>O que ela sabe</h3>
          <div className={l.lgSabe}>
            <span>Usa o Contexto: tudo o que a Nina sabe sobre a sua empresa.</span>
            <AtalhoArea para="/app/contexto" variante="discreto" tamanho="compacto">
              Abrir o Contexto
            </AtalhoArea>
          </div>
        </div>

        <fieldset className={l.lgGrupo}>
          <legend className={l.lgGrupoH}>Quando passar para a equipe</legend>
          <div className={l.lgOpcoes}>
            <label className={l.lgOpcao}>
              <input
                type="radio"
                name={`${base}-regras`}
                checked={!proprias}
                onChange={() => mudar("regrasEquipe", null)}
              />
              <span className={l.lgOpcaoTexto}>
                <span className={l.lgOpcaoNome}>Igual à Nina de texto</span>
                <span className={l.lgOpcaoLinha}>
                  As regras do Contexto, em “Quando passar para humano”.
                </span>
              </span>
            </label>
            <label className={l.lgOpcao}>
              <input
                type="radio"
                name={`${base}-regras`}
                checked={proprias}
                onChange={() => mudar("regrasEquipe", campos.regrasEquipe ?? "")}
              />
              <span className={l.lgOpcaoTexto}>
                <span className={l.lgOpcaoNome}>Regras próprias</span>
                <span className={l.lgOpcaoLinha}>Só para este agente, escritas por você.</span>
              </span>
            </label>
          </div>
          {proprias ? (
            <AreaTexto
              id={`${base}-regras`}
              rotulo="Quando este agente passa para a equipe"
              linhas={3}
              maxCaracteres={LIMITES_AGENTE.regrasEquipe.max}
              value={campos.regrasEquipe ?? ""}
              erro={erroDe("regrasEquipe")}
              onChange={(ev) => mudar("regrasEquipe", ev.target.value)}
            />
          ) : null}
        </fieldset>

        <div className={l.lgGrupo}>
          <h3 className={l.lgGrupoH} id={`${base}-voz-h`}>
            Voz
          </h3>
          <p className={l.lgAjuda}>
            {campos.vozNome ? `Agora: ${campos.vozNome}.` : "Nenhuma voz escolhida."} As vozes são
            as da sua conta da ElevenLabs.
          </p>
          <ListaDeVozes
            estado={vozes.estado}
            aoRecarregar={vozes.recarregar}
            valor={campos.vozId}
            aoMudar={(id) => {
              const v =
                vozes.estado.k === "pronta"
                  ? vozes.estado.vozes.find((x) => x.id === id)
                  : undefined;
              setCampos((c) => ({ ...c, vozId: id, vozNome: v?.nome ?? id }));
            }}
            rotulo="Voz do agente"
            idBase={`${base}-voz`}
            desligado={salvando}
          />
        </div>

        <fieldset className={l.lgGrupo}>
          <legend className={l.lgGrupoH}>Perfil</legend>
          <div className={l.lgOpcoes}>
            {PERFIS_AGENTE.map((p) => (
              <label key={p} className={l.lgOpcao}>
                <input
                  type="radio"
                  name={`${base}-perfil`}
                  value={p}
                  checked={campos.perfil === p}
                  onChange={() => mudar("perfil", p)}
                  aria-describedby={`${base}-perfil-${p}`}
                />
                <span className={l.lgOpcaoTexto}>
                  <span className={l.lgOpcaoNome}>{TEXTO_PERFIL[p].nome}</span>
                  <span className={l.lgOpcaoLinha} id={`${base}-perfil-${p}`}>
                    {TEXTO_PERFIL[p].linha}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <AreaTexto
          id={`${base}-saudacao`}
          rotulo="Saudação"
          linhas={2}
          maxCaracteres={LIMITES_AGENTE.saudacao.max}
          value={campos.saudacao}
          erro={erroDe("saudacao")}
          dica={
            campos.uso === "ligar"
              ? "O que o agente fala quando o lead atende a ligação. {nome} vira o nome do contato."
              : "O que o agente fala ao atender. {nome} vira o nome do contato."
          }
          onChange={(ev) => mudar("saudacao", ev.target.value)}
        />

        <div className={l.lgRegs}>
          <Passo
            id={`${base}-duracao`}
            rotulo="Duração máxima"
            valor={campos.duracaoMaxS}
            texto={{ numero: String(minutos), unidade: "min" }}
            ajuda="Passou disso, o agente se despede e desliga."
            noMinimo={salvando || campos.duracaoMaxS <= D.min}
            noMaximo={salvando || campos.duracaoMaxS >= D.max}
            menosAria="Diminuir a duração máxima em 1 minuto"
            maisAria="Aumentar a duração máxima em 1 minuto"
            aoMudar={(sinal) =>
              mudar(
                "duracaoMaxS",
                Math.max(D.min, Math.min(D.max, campos.duracaoMaxS + sinal * D.passo)),
              )
            }
          />
          <Passo
            id={`${base}-silencio`}
            rotulo="Desligar no silêncio"
            valor={campos.silencioS}
            unidade="s"
            ajuda="Antes, o agente pergunta uma vez se a pessoa ainda está aí."
            noMinimo={salvando || campos.silencioS <= S.min}
            noMaximo={salvando || campos.silencioS >= S.max}
            menosAria="Esperar 5 segundos a menos no silêncio"
            maisAria="Esperar 5 segundos a mais no silêncio"
            aoMudar={(sinal) =>
              mudar(
                "silencioS",
                Math.max(S.min, Math.min(S.max, campos.silencioS + sinal * S.passo)),
              )
            }
          />
        </div>
      </div>

      <div className={l.lgEditorPe}>
        {confirmarApagar && agente ? (
          <>
            <p className={l.lgAjuda} style={{ marginRight: "auto" }} role="alert">
              Apagar o agente {agente.nome}? As ligações dele continuam no histórico.
            </p>
            <Botao
              variante="discreto"
              disabled={salvando}
              onClick={() => setConfirmarApagar(false)}
            >
              Cancelar
            </Botao>
            <Botao variante="perigo" carregando={salvando} onClick={apagar}>
              Apagar
            </Botao>
          </>
        ) : (
          <>
            {agente && !agente.atende ? (
              <Botao
                variante="discreto"
                disabled={salvando}
                onClick={() => setConfirmarApagar(true)}
              >
                Apagar agente
              </Botao>
            ) : null}
            {agente?.atende ? (
              <p className={l.lgAjuda}>
                Este agente atende as ligações: para apagar, escolha outro antes.
              </p>
            ) : null}
            <span className={l.lgEmpurra} />
            <Botao variante="discreto" disabled={salvando} onClick={aoFechar}>
              Cancelar
            </Botao>
            <Botao carregando={salvando} onClick={salvar}>
              {novo ? "Criar agente" : "Salvar"}
            </Botao>
          </>
        )}
      </div>
    </div>
  );
}
