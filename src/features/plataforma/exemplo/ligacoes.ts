import {
  FAIXA_LIMITES,
  LIMITES_PADRAO,
  SAUDACAO_PADRAO,
  conferirCampos,
  noIntervalo,
  type AgenteLigacao,
  type LimitesLigacoes,
} from "../ligacoes/tipos";
import type { Reduzido } from "./reducer";
import type { AcaoExemplo, EstadoBase } from "./tipos";

// As ações da área Ligações no modo exemplo (L2, L3, L10, L13 e L19): o
// reducer principal confere o admin e chama daqui. As regras seguem as do banco da fase B: um agente
// só atende (índice único parcial), o que atende não é apagado, os campos ficam nas faixas dos checks
// e editar leva a configuração inteira (a versão aplicada passa a ser a do código). Só um agente
// Receptivo atende (A1): o Ativo não atende, o que atende não vira
// Ativo e o primeiro agente é Receptivo.

/**
 * A versão da configuração dos agentes "no código" do exemplo (L13). Os agentes de exemplo nascem na
 * versão 1, e a aba Agentes mostra o aviso de atualização até alguém clicar em "Atualizar".
 */
export const VERSAO_AGENTE_EXEMPLO = 2;

/** O id do agente "Nina" que a ativação cria (e o do exemplo). */
export const ID_AGENTE_NINA = "ag-nina";

/** O id do agente Ativo do exemplo ("Vendas – retorno"). */
export const ID_AGENTE_RETORNO = "ag-retorno";

type AcaoLigacoes = Extract<
  AcaoExemplo,
  {
    tipo:
      | "criarAgenteLigacao"
      | "salvarAgenteLigacao"
      | "apagarAgenteLigacao"
      | "atenderAgenteLigacao"
      | "atualizarAgentesLigacao"
      | "salvarLimitesLigacoes";
  }
>;

const recusa = (
  estado: EstadoBase,
  erro: "nao_encontrado" | "nome_vazio" | "agente_que_atende" | "uso_do_agente",
): Reduzido => ({
  estado,
  resultado: { ok: false, erro },
});
const igual = (estado: EstadoBase): Reduzido => ({ estado, resultado: { ok: true } });

/** O agente "Nina" que nasce na ativação (L2): segue as regras da Nina de texto, com a voz escolhida. */
export function agenteNina(
  estado: Pick<EstadoBase, "configuracao">,
  agora: string,
  versao = VERSAO_AGENTE_EXEMPLO,
): AgenteLigacao {
  const cfg = estado.configuracao;
  return {
    id: ID_AGENTE_NINA,
    nome: "Nina",
    // a Nina da ativação nasce Receptiva (A1 da spec)
    uso: "receber",
    objetivo: "vendas",
    instrucoes: "",
    regrasEquipe: null,
    vozId: cfg.voz_id ?? null,
    vozNome: cfg.voz_id ? (cfg.voz_nome ?? cfg.voz_id) : null,
    perfil: "recomendado",
    saudacao: SAUDACAO_PADRAO,
    duracaoMaxS: 600,
    silencioS: 25,
    atende: true,
    versaoConfig: versao,
    erroSincronia: null,
    criadoEm: agora,
    atualizadoEm: agora,
  };
}

/** Sem agente nenhum, cria o "Nina", que atende. Com algum, nada muda. */
export function comAgenteNina(estado: EstadoBase, agora: string): EstadoBase {
  if ((estado.ligacaoAgentes ?? []).length > 0) return estado;
  return { ...estado, ligacaoAgentes: [agenteNina(estado, agora)] };
}

function novoIdAgente(agentes: readonly AgenteLigacao[]): string {
  let n = agentes.length + 1;
  while (agentes.some((a) => a.id === `ag-${n}`)) n += 1;
  return `ag-${n}`;
}

export function reduzirLigacoes(estado: EstadoBase, acao: AcaoLigacoes, agora: string): Reduzido {
  const agentes = estado.ligacaoAgentes ?? [];
  const achar = (id: string) => agentes.find((a) => a.id === id);

  switch (acao.tipo) {
    case "criarAgenteLigacao": {
      const c = conferirCampos(acao.campos);
      if (!c.ok) return recusa(estado, "nome_vazio");
      // o primeiro agente atende o número, então ele é Receptivo (A1)
      if (agentes.length === 0 && c.campos.uso !== "receber")
        return recusa(estado, "uso_do_agente");
      const id = novoIdAgente(agentes);
      const novo: AgenteLigacao = {
        ...c.campos,
        id,
        // o primeiro agente atende (o número precisa de um)
        atende: agentes.length === 0,
        versaoConfig: acao.versao,
        erroSincronia: null,
        criadoEm: agora,
        atualizadoEm: agora,
      };
      return {
        estado: { ...estado, ligacaoAgentes: [...agentes, novo] },
        resultado: { ok: true, id },
      };
    }

    case "salvarAgenteLigacao": {
      const a = achar(acao.agenteId);
      if (!a) return recusa(estado, "nao_encontrado");
      const c = conferirCampos(acao.campos);
      if (!c.ok) return recusa(estado, "nome_vazio");
      // o que atende fica Receptivo (A1; o check do banco também recusa)
      if (a.atende && c.campos.uso !== "receber") return recusa(estado, "uso_do_agente");
      const novo: AgenteLigacao = {
        ...a,
        ...c.campos,
        versaoConfig: acao.versao,
        erroSincronia: null,
        atualizadoEm: agora,
      };
      return {
        estado: { ...estado, ligacaoAgentes: agentes.map((x) => (x.id === a.id ? novo : x)) },
        resultado: { ok: true },
      };
    }

    case "apagarAgenteLigacao": {
      const a = achar(acao.agenteId);
      if (!a) return recusa(estado, "nao_encontrado");
      if (a.atende) return recusa(estado, "agente_que_atende");
      // o histórico fica (agente_id → set null): a ligação perde só o nome do agente
      const historico = (estado.historicoLigacoes ?? []).map((l) =>
        l.agenteId === a.id ? { ...l, agenteId: null } : l,
      );
      return {
        estado: {
          ...estado,
          ligacaoAgentes: agentes.filter((x) => x.id !== a.id),
          historicoLigacoes: historico,
        },
        resultado: { ok: true },
      };
    }

    case "atenderAgenteLigacao": {
      const a = achar(acao.agenteId);
      if (!a) return recusa(estado, "nao_encontrado");
      // só um agente Receptivo atende o número (A1)
      if (a.uso !== "receber") return recusa(estado, "uso_do_agente");
      if (a.atende) return igual(estado);
      return {
        estado: {
          ...estado,
          ligacaoAgentes: agentes.map((x) =>
            x.id === a.id
              ? { ...x, atende: true, atualizadoEm: agora }
              : x.atende
                ? { ...x, atende: false, atualizadoEm: agora }
                : x,
          ),
        },
        resultado: { ok: true },
      };
    }

    case "atualizarAgentesLigacao": {
      if (!agentes.some((a) => a.versaoConfig < acao.versao)) return igual(estado);
      return {
        estado: {
          ...estado,
          ligacaoAgentes: agentes.map((a) =>
            a.versaoConfig < acao.versao
              ? { ...a, versaoConfig: acao.versao, atualizadoEm: agora }
              : a,
          ),
        },
        resultado: { ok: true },
      };
    }

    case "salvarLimitesLigacoes": {
      const atual = estado.limitesLigacoes ?? LIMITES_PADRAO;
      const novo: LimitesLigacoes = {
        simultaneas: noIntervalo(acao.limites.simultaneas, FAIXA_LIMITES.simultaneas),
        porDia: noIntervalo(acao.limites.porDia, FAIXA_LIMITES.porDia),
        porContato: noIntervalo(acao.limites.porContato, FAIXA_LIMITES.porContato),
      };
      if (
        novo.simultaneas === atual.simultaneas &&
        novo.porDia === atual.porDia &&
        novo.porContato === atual.porContato
      )
        return igual(estado);
      return { estado: { ...estado, limitesLigacoes: novo }, resultado: { ok: true } };
    }
  }
}
