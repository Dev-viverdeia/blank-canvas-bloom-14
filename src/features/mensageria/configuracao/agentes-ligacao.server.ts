// Os agentes de voz e os limites das ligações (L2, L3, L10, L11, L13,
// L14 e L19; 2.2). Só o admin (membroAdmin). As leituras são da tela, pela RLS.
//
// - Com as ligações ativas, cada agente é um agente na ElevenLabs (id_externo): criar cria lá,
//   salvar atualiza lá (PATCH) e apagar apaga lá. A sincronia monta a configuração inteira
//   (montarConfigAgente: o agente, os limites, os recursos da conexão e o Contexto inteiro, L14) e
//   grava id_externo, versao_config, sincronizado_em (o criado_em da versão do Contexto que foi
//   no prompt) e erro_sincronia.
// - Sincronias do mesmo agente ao mesmo tempo (L33): a gravação só vale se a linha ainda está como
//   a sincronia leu (atualizado_em). Se outra mudança gravou no meio, ela relê a linha e o
//   Contexto e refaz o PATCH; assim o último PATCH é sempre o de quem gravou por último.
// - A linha que atende sem id_externo (as ligações da primeira versão, ou o passo 8 da ativação que
//   não gravou) adota o agente do tronco (eleven.agenteId) em vez de criar outro (L34).
// - Um agente criado lá que não chega a uma linha, ou que nasce depois de as ligações saírem, é
//   apagado (L36).
// - Sem as ligações ativas, só a linha muda: a ativação cria os agentes a partir das linhas.
// - Atender (L11): o tronco passa para o agente (PATCH do número), a ligacao_agente_atender grava, e
//   parametros.ligacoes.eleven.agenteId acompanha (o agente ligado ao tronco, que a desmontagem
//   apaga na ordem da D17 e que a troca da chave confere, D29).
// - Atualizar (L13 e L14): leva todos os agentes para a versão do código e para o Contexto atual.
//   É o mesmo caminho que roda quando o Contexto é salvo pela tela.
// - Limites: grava configuracao.ligacoes_* e aplica call_limits a todos os agentes.
// - A voz do cartão Voz mudou (L37): os agentes sem voz própria recebem a voz nova.
// - As ligações da primeira versão (L43): ativas, com o agente no tronco e sem nenhuma linha. Ao
//   abrir a área, o admin chama adotarAgenteDoTronco: nasce a linha "Nina", que adota o agente do
//   tronco e o leva para a configuração nova. Sem desativar e ativar de novo.
// Nenhuma chave, token ou segredo volta no resultado: as mensagens são as fixas.
import { PRAZO_MS, type OpcoesValidacao } from "@/features/servidor/http";
import {
  apagarRecursoEleven,
  apontarTronco,
  atualizarAgente,
  criarAgente,
  montarConfigAgente,
  VERSAO_AGENTE,
  type RecursosDoAgente,
} from "@/features/servidor/ligacoes-elevenlabs";

import { membroAdmin, type ContextoUsuario } from "../configuracao.server";
import {
  apagarLinhaAgente,
  atenderAgente,
  atualizarCamposAgente,
  gravarLimites,
  gravarSincronia,
  inserirAgente,
  lerAgente,
  lerLimites,
  listarAgentes,
  soltarAgente,
  type LinhaAgente,
} from "../ligacoes/agentes-banco.server";
import { lerContextoAtual } from "../ligacoes/banco.server";
import { agenteAtrasDoContexto } from "../ligacoes/contexto";
import { lerLigacoesGravadas } from "../ligacoes/gravadas";
import { msgLigacoes } from "../ligacoes/mensagens";
import {
  AGENTE_PADRAO,
  FAIXAS_AGENTE,
  FAIXAS_LIMITES,
  OBJETIVOS_AGENTE,
  PERFIS_AGENTE,
  urlDaLigacao,
  USOS_AGENTE,
  type AgenteVoz,
  type ErroLigacoes,
  type FalhaLigacoes,
  type LigacoesGravadas,
  type LimitesLigacoes,
} from "../ligacoes/tipos";
import { conexaoAtiva, lerChaveIA } from "../nucleo/conexoes.server";
import { lerConfigVozTela } from "./banco.server";
import { gravarLigacoes } from "./ligacoes-banco.server";

export type ErroAgentes =
  ErroLigacoes | "nao_encontrado" | "agente_que_atende" | "campos_invalidos";
export type FalhaAgentes = { ok: false; erro: ErroAgentes; mensagem: string };
export type ResultadoAgentes = { ok: true; id?: string } | FalhaAgentes;

/**
 * O admin e de onde veio o pedido. naPrevia: o pedido chegou pela prévia (ou pelo localhost), que
 * roda o código da prévia. O agente de voz é um só, o do endereço publicado: pela prévia, o que é
 * dado fica salvo no banco (que também é um só), mas nada vai à ElevenLabs. Sem o campo (testes),
 * vale como o endereço publicado.
 */
export type ContextoAgentes = ContextoUsuario & { naPrevia?: boolean };

/** fetch e prazo de cada pedido (os testes passam um fetch falso). */
export type OpcoesAgentes = OpcoesValidacao;

const falha = (erro: ErroAgentes, mensagem: string): FalhaAgentes => ({
  ok: false,
  erro,
  mensagem,
});

export const msgAgentes = {
  semAcesso: () => falha("sem_acesso", "Só um admin pode mudar os agentes e os limites."),
  naoEncontrado: () => falha("nao_encontrado", "Este agente não existe mais. Atualize a página."),
  agenteQueAtende: () =>
    falha(
      "agente_que_atende",
      "Este agente atende as ligações. Escolha outro para atender antes de apagar.",
    ),
  camposInvalidos: (texto: string) => falha("campos_invalidos", texto),
  /** Só um agente Receptivo atende o número (A1). */
  ativoNaoAtende: () =>
    falha(
      "campos_invalidos",
      "Este agente é Ativo: ele faz ligações e não atende o número. Mude para Receptiva para ele atender.",
    ),
  queAtendeFicaReceptivo: () =>
    falha(
      "campos_invalidos",
      "Este agente atende as ligações do número, então ele fica Receptivo. Escolha outro para atender antes de mudar.",
    ),
  recriadoNoMeio: () =>
    falha(
      "erro_ao_gravar",
      "Outra mudança neste agente chegou ao mesmo tempo, e ele voltou para a ElevenLabs. Tente apagar de novo.",
    ),
  ficouNaEleven: () =>
    falha(
      "provedor_fora",
      "O agente saiu da Nina, mas não deu para apagá-lo na ElevenLabs. Apague o agente por lá, em Agents.",
    ),
  emLigacao: () =>
    falha(
      "agente_que_atende",
      "Este agente está numa ligação agora. Apague depois que ela terminar.",
    ),
  usoMudouNoMeio: () =>
    falha(
      "campos_invalidos",
      "Só um agente Receptivo atende o número, e este agente mudou ao mesmo tempo. Atualize a página e tente de novo.",
    ),
  primeiroReceptivo: () =>
    falha(
      "campos_invalidos",
      "O primeiro agente atende as ligações do número, então ele tem de ser Receptivo.",
    ),
  naoApagou: () =>
    falha(
      "provedor_fora",
      "Não deu para apagar o agente na ElevenLabs agora. Tente de novo em alguns minutos.",
    ),
  /** O pedido veio da prévia, e o agente de voz é o do endereço publicado. */
  previa: () =>
    falha(
      "endereco_de_previa",
      "A prévia não mexe no agente de voz, que é o do endereço publicado. Abra o app pelo endereço publicado e clique em Atualizar na aba Agentes.",
    ),
  /** O que ficou salvo na Nina e não chegou à ElevenLabs. */
  salvoSemSincronia: (f: { erro: ErroAgentes; mensagem: string }) =>
    falha(f.erro, `A mudança ficou salva, mas não chegou ao agente de voz. ${f.mensagem}`),
  /** A linha mudou a cada tentativa: a sincronia desistiu (o agente fica marcado como atrás). */
  mudouNoMeio: (): FalhaLigacoes => ({
    ok: false,
    erro: "erro_ao_gravar",
    mensagem:
      "Outra mudança neste agente chegou ao mesmo tempo. Clique em Atualizar para levar a última.",
  }),
  algunsSemSincronia: (n: number, f: { erro: ErroLigacoes; mensagem: string }) =>
    falha(
      f.erro,
      n === 1
        ? `Um agente não foi atualizado. ${f.mensagem}`
        : `${n} agentes não foram atualizados. ${f.mensagem}`,
    ),
};

// ---------- conferência dos campos (as faixas dos checks da ligacao_agentes) ----------

function textoLimpo(v: unknown): string | null {
  return typeof v === "string" ? v.trim() : null;
}

function inteiroNa(v: unknown, faixa: { min: number; max: number }): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= faixa.min && v <= faixa.max
    ? v
    : null;
}

const VOZ_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Os campos do agente vindos da tela, conferidos; ou o texto do primeiro problema. Sem o uso (uma
 * aba aberta antes da versão que o trouxe), vale `usoPadrao`: o atual do agente, ao salvar
 * (Opus, PR #26).
 */
export function lerCamposAgente(
  v: unknown,
  usoPadrao: AgenteVoz["uso"] = "receber",
): { ok: true; campos: AgenteVoz } | FalhaAgentes {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const ruim = (t: string) => msgAgentes.camposInvalidos(t);
  const nome = textoLimpo(o["nome"]);
  if (!nome || nome.length > FAIXAS_AGENTE.nome.max)
    return ruim("Dê um nome ao agente, de até 60 letras.");
  const uso = o["uso"] === undefined ? usoPadrao : o["uso"];
  if (typeof uso !== "string" || !(USOS_AGENTE as readonly string[]).includes(uso))
    return ruim("Escolha para que serve o agente: Receptiva ou Ativa.");
  const objetivo = o["objetivo"];
  if (typeof objetivo !== "string" || !(OBJETIVOS_AGENTE as readonly string[]).includes(objetivo))
    return ruim("Escolha o objetivo do agente.");
  const instrucoes = textoLimpo(o["instrucoes"] ?? "");
  if (instrucoes === null || instrucoes.length > FAIXAS_AGENTE.instrucoes.max)
    return ruim("As instruções podem ter até 4.000 letras.");
  let regrasEquipe: string | null = null;
  if (o["regrasEquipe"] !== null && o["regrasEquipe"] !== undefined) {
    const r = textoLimpo(o["regrasEquipe"]);
    if (!r || r.length > FAIXAS_AGENTE.regrasEquipe.max)
      return ruim("As regras para passar para a equipe têm de ter de 1 a 2.000 letras.");
    regrasEquipe = r;
  }
  const vozId = o["vozId"] === null || o["vozId"] === undefined ? null : o["vozId"];
  if (vozId !== null && (typeof vozId !== "string" || !VOZ_ID.test(vozId)))
    return ruim("Escolha uma voz da lista.");
  const vozNomeBruto = vozId === null ? null : textoLimpo(o["vozNome"]);
  const vozNome = vozNomeBruto ? vozNomeBruto.slice(0, 120) : null;
  const perfil = o["perfil"];
  if (typeof perfil !== "string" || !(PERFIS_AGENTE as readonly string[]).includes(perfil))
    return ruim("Escolha o perfil do agente.");
  const saudacao = textoLimpo(o["saudacao"]);
  if (!saudacao || saudacao.length > FAIXAS_AGENTE.saudacao.max)
    return ruim("Escreva a saudação, de até 300 letras.");
  const duracaoMaxS = inteiroNa(o["duracaoMaxS"], FAIXAS_AGENTE.duracaoMaxS);
  if (duracaoMaxS === null) return ruim("A duração máxima vai de 3 a 30 minutos.");
  const silencioS = inteiroNa(o["silencioS"], FAIXAS_AGENTE.silencioS);
  if (silencioS === null) return ruim("O silêncio vai de 10 a 60 segundos.");
  return {
    ok: true,
    campos: {
      nome,
      uso: uso as AgenteVoz["uso"],
      objetivo: objetivo as AgenteVoz["objetivo"],
      instrucoes,
      regrasEquipe,
      vozId: vozId as string | null,
      vozNome,
      perfil: perfil as AgenteVoz["perfil"],
      saudacao,
      duracaoMaxS,
      silencioS,
    },
  };
}

/** Os limites vindos da tela, conferidos (as faixas dos checks da configuracao). */
export function lerLimitesEntrada(
  v: unknown,
): { ok: true; limites: LimitesLigacoes } | FalhaAgentes {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const simultaneas = inteiroNa(o["simultaneas"], FAIXAS_LIMITES.simultaneas);
  const porDia = inteiroNa(o["porDia"], FAIXAS_LIMITES.porDia);
  const porContato = inteiroNa(o["porContato"], FAIXAS_LIMITES.porContato);
  if (simultaneas === null || porDia === null || porContato === null)
    return msgAgentes.camposInvalidos("Confira os limites: algum ficou fora da faixa.");
  return { ok: true, limites: { simultaneas, porDia, porContato } };
}

// ---------- o ambiente da sincronia ----------

/** O que a sincronia com a ElevenLabs precisa, com as ligações ativas. */
export type Ambiente = {
  chave: string;
  conexaoId: string;
  ligacoes: LigacoesGravadas;
  recursos: RecursosDoAgente;
  limites: LimitesLigacoes;
  /** O Contexto inteiro em texto (L14). */
  contexto: string;
  /** A voz do cartão Voz (a de quem não escolheu voz própria). */
  vozPadrao: string | null;
  /**
   * O criado_em da versão do Contexto que vai no prompt: é o sincronizado_em gravado (L14, L35).
   * Um relógio só (o do banco): se o Contexto mudar no meio, a versão nova é mais recente e o
   * agente aparece atrás. null = ainda não há Contexto.
   */
  contextoEm: string | null;
};

/**
 * As ligações ativas com tudo o que a sincronia precisa. null = as ligações não estão ativas (só a
 * linha muda). Falha = estão ativas, mas falta a chave. Lança se o banco falhar.
 */
export async function lerAmbiente(): Promise<Ambiente | null | FalhaLigacoes> {
  const conexao = await conexaoAtiva();
  const ligacoes = conexao ? lerLigacoesGravadas(conexao.parametros) : null;
  if (!conexao || !ligacoes || ligacoes.situacao !== "ativa") return null;
  const { segredoId, webhookId, ferramentaId } = ligacoes.eleven;
  if (!segredoId || !webhookId || !ferramentaId) return null;
  const k = await lerChaveIA("voz");
  if (!k || k.provedor !== "elevenlabs" || !k.chave.trim()) return msgLigacoes.semChaveVoz();
  const [limites, contexto, voz] = await Promise.all([
    lerLimites(),
    lerContextoAtual(),
    lerConfigVozTela(),
  ]);
  return {
    chave: k.chave,
    conexaoId: conexao.id,
    ligacoes,
    recursos: {
      conexaoId: conexao.id,
      urlInicio: urlDaLigacao(ligacoes.origem, conexao.id, "inicio"),
      segredoId,
      webhookId,
      ferramentaId,
    },
    limites,
    contexto: contexto.texto,
    vozPadrao: voz.voz?.id ?? null,
    contextoEm: contexto.criadoEm,
  };
}

/** As ligações do ambiente continuam ativas, na mesma conexão (nada as desmontou no meio). */
export async function ligacoesVigentes(amb: Pick<Ambiente, "conexaoId">): Promise<boolean> {
  const conexao = await conexaoAtiva();
  if (!conexao || conexao.id !== amb.conexaoId) return false;
  return lerLigacoesGravadas(conexao.parametros)?.situacao === "ativa";
}

function ehFalha(v: unknown): v is FalhaLigacoes {
  return !!v && typeof v === "object" && (v as { ok?: unknown }).ok === false;
}

type FalhaSincronia = { erro: ErroLigacoes; mensagem: string };

/** Quantas vezes uma gravação com trava relê e tenta de novo (cada perda é alguém que gravou no meio). */
const TENTATIVAS = 4;

/** Apaga lá um agente que não ficou em nenhuma linha. Nunca lança; o que não sair vai para o log. */
async function apagarAgenteSolto(chave: string, idExterno: string, opcoes?: OpcoesAgentes) {
  const fim = await apagarRecursoEleven(chave, "agente", idExterno, {
    ...opcoes,
    prazoMs: opcoes?.prazoMs ?? PRAZO_MS,
  });
  if (fim !== "saiu") console.error("ligacoes_agente_solto_ficou");
}

/**
 * Leva um agente para a ElevenLabs: PATCH se ele já existe lá, criar se não. Grava o resultado na
 * linha (id_externo, versao_config, sincronizado_em; ou erro_sincronia). null = deu certo (ou as
 * ligações saíram no meio, e só a linha ficou). Nunca lança por causa da rede; lança se o banco
 * falhar.
 *
 * - A gravação só vale se a linha ainda está como foi lida (atualizado_em, L33). Se outra mudança
 *   gravou no meio (outra sincronia, o admin salvou, o Atender), relê a linha e o ambiente e refaz
 *   o PATCH com o que está gravado agora. Desistindo, a linha fica marcada como atrás (versão 0 e
 *   sem sincronizado_em): o início da ligação manda o Contexto, e a aba Agentes oferece Atualizar.
 * - A linha que atende sem id_externo adota o agente do tronco (eleven.agenteId), em vez de criar
 *   outro fora do tronco (L34). `adotarDoTronco` faz o mesmo para uma linha que ainda não atende
 *   (o primeiro agente criado com as ligações da primeira versão ativas).
 * - O agente criado aqui que não chega a uma linha sai lá. Depois de gravar um id novo, confere que
 *   as ligações continuam ativas; se a desmontagem passou no meio, desfaz (L36).
 */
export async function sincronizarAgente(
  linha: LinhaAgente,
  amb: Ambiente,
  opcoes?: OpcoesAgentes,
  modo: { adotarDoTronco?: boolean } = {},
): Promise<FalhaSincronia | null> {
  let atual = linha;
  let ambiente = amb;
  /** O agente que esta sincronia criou lá e que ainda não está gravado em nenhuma linha. */
  let solto: string | null = null;
  /** Algum PATCH ou criação desta sincronia pode ter chegado lá sem a gravação correspondente. */
  let mexeuLa = false;
  const largarSolto = async () => {
    if (solto) await apagarAgenteSolto(ambiente.chave, solto, opcoes);
    solto = null;
  };
  const gravarFalha = async (f: FalhaSincronia) => {
    // um PATCH desta sincronia pode ter passado por cima de um mais novo: marca como atrás
    await gravarSincronia(
      atual.id,
      mexeuLa
        ? { erroSincronia: f.mensagem, versaoConfig: 0, sincronizadoEm: null }
        : { erroSincronia: f.mensagem },
    );
  };

  for (let tentativa = 0; tentativa < TENTATIVAS; tentativa++) {
    if (tentativa > 0) {
      // a linha mudou no meio: relê a linha e, depois dela, o ambiente (o Contexto lido depois da
      // linha nunca é mais velho que o de quem gravou nela)
      const relida = await lerAgente(atual.id);
      const novo = relida ? await lerAmbiente() : null;
      if (!relida || !novo || ehFalha(novo)) {
        // a linha saiu, ou as ligações saíram: nada mais a levar lá
        await largarSolto();
        return ehFalha(novo) ? novo : null;
      }
      // o apagar soltou o agente no meio (ligacao_agente_soltar): nada a recriar lá (Opus, PR #26)
      if (atual.idExterno && !relida.idExterno) {
        await largarSolto();
        return null;
      }
      atual = relida;
      ambiente = novo;
      // outra sincronia já criou e gravou o agente desta linha: o daqui sobra
      if (solto && atual.idExterno && atual.idExterno !== solto) await largarSolto();
    }

    const vozId = atual.vozId ?? ambiente.vozPadrao;
    if (!vozId) {
      await largarSolto();
      const f = msgLigacoes.semVoz();
      await gravarFalha(f);
      return f;
    }
    const dados = {
      agente: { ...atual, vozId },
      limites: ambiente.limites,
      recursos: ambiente.recursos,
      contexto: ambiente.contexto,
    };
    let idExterno = atual.idExterno ?? solto;
    const doTronco = ambiente.ligacoes.eleven.agenteId;
    const adotou = !idExterno && (atual.atende || !!modo.adotarDoTronco) && !!doTronco;
    if (adotou) idExterno = doTronco;
    if (idExterno) {
      const f = await atualizarAgente(ambiente.chave, idExterno, montarConfigAgente(dados), opcoes);
      if (f) {
        await largarSolto();
        await gravarFalha(f);
        return f;
      }
    } else {
      const r = await criarAgente(ambiente.chave, dados, opcoes);
      if (!r.ok) {
        await gravarFalha(r);
        return r;
      }
      idExterno = r.agenteId;
      solto = r.agenteId;
    }
    mexeuLa = true;

    let gravou: boolean;
    try {
      gravou = await gravarSincronia(atual.id, {
        idExterno,
        versaoConfig: VERSAO_AGENTE,
        sincronizadoEm: ambiente.contextoEm,
        erroSincronia: null,
        seAtualizadoEm: atual.atualizadoEm,
      });
    } catch (e) {
      // não se sabe se gravou: confere; sem como conferir, o agente criado aqui sai
      if (solto) {
        const conferida = await lerAgente(atual.id).catch(() => null);
        if (conferida?.idExterno !== solto) await largarSolto();
      }
      throw e;
    }
    if (!gravou) continue;

    const idNovo = idExterno !== atual.idExterno;
    const criadoAqui = solto === idExterno;
    solto = null;
    // um id novo na linha (criado ou adotado): a desmontagem pode ter passado no meio (L36)
    if (idNovo && !(await ligacoesVigentes(ambiente))) {
      if (criadoAqui) await apagarAgenteSolto(ambiente.chave, idExterno, opcoes);
      await gravarSincronia(atual.id, {
        idExterno: null,
        sincronizadoEm: null,
        erroSincronia: null,
        seIdExterno: idExterno,
      });
    }
    return null;
  }

  await largarSolto();
  const f = msgAgentes.mudouNoMeio();
  await gravarFalha(f);
  return f;
}

/** Um ISO novo para atualizadaEm, sempre diferente do anterior (a trava das ligações compara). */
function carimbo(anterior = ""): string {
  const agora = new Date().toISOString();
  return agora === anterior ? new Date(Date.parse(agora) + 1).toISOString() : agora;
}

/**
 * parametros.ligacoes.eleven.agenteId passa a ser o agente ligado ao tronco (L24), com a trava do
 * atualizadaEm: perdeu, relê e tenta de novo. Para sem gravar quando não há mais o que espelhar:
 * as ligações não estão mais ativas (a desmontagem cuida dos dois agentes), ou a linha não atende
 * mais (uma troca posterior, que espelha o dela). false = desistiu (a trava foi disputada demais).
 * Lança se o banco falhar.
 */
async function espelharAgenteDoTronco(
  conexaoId: string,
  linhaId: string,
  idExterno: string,
): Promise<boolean> {
  for (let i = 0; i < TENTATIVAS; i++) {
    const conexao = await conexaoAtiva();
    const l = conexao?.id === conexaoId ? lerLigacoesGravadas(conexao.parametros) : null;
    if (!l || l.situacao !== "ativa") return true;
    if (l.eleven.agenteId === idExterno) return true;
    if (!(await lerAgente(linhaId))?.atende) return true;
    const novo: LigacoesGravadas = {
      ...l,
      eleven: { ...l.eleven, agenteId: idExterno },
      atualizadaEm: carimbo(l.atualizadaEm),
    };
    if (await gravarLigacoes(conexaoId, novo, l.atualizadaEm)) return true;
  }
  return false;
}

/**
 * O agente passa a atender (L11): o tronco aponta para ele, a ligacao_agente_atender grava e
 * parametros.ligacoes acompanha. A troca só conta como feita com as três; repetir reconcilia o que
 * faltou (o tronco é um PATCH idempotente). Se o banco falhar depois do PATCH do tronco, o tronco
 * volta para quem estava nele.
 */
async function trocarQuemAtende(
  novo: LinhaAgente,
  amb: Ambiente,
  opcoes?: OpcoesAgentes,
): Promise<ResultadoAgentes> {
  const troncoId = amb.ligacoes.eleven.troncoId;
  if (!troncoId) return msgLigacoes.elevenFora();
  // o agente ainda não existe lá (a criação falhou antes): cria agora
  let idExterno = novo.idExterno;
  if (!idExterno) {
    const f = await sincronizarAgente(novo, amb, opcoes);
    if (f) return { ok: false, ...f };
    idExterno = (await lerAgente(novo.id))?.idExterno ?? null;
    if (!idExterno) return msgAgentes.naoEncontrado();
  }
  const noTronco = amb.ligacoes.eleven.agenteId;
  // 1. o número passa para o agente (PATCH do tronco), se ainda não é dele
  if (noTronco !== idExterno || novo.atende) {
    const f = await apontarTronco(amb.chave, troncoId, idExterno, opcoes);
    if (f) return f;
  }
  // 2. o banco; se falhar, o número volta para quem estava no tronco
  if (!novo.atende) {
    try {
      await atenderAgente(novo.id);
    } catch (e) {
      if (noTronco && noTronco !== idExterno)
        await apontarTronco(amb.chave, troncoId, noTronco, opcoes);
      throw e;
    }
  }
  // 3. parametros.ligacoes acompanha o agente do tronco
  if (!(await espelharAgenteDoTronco(amb.conexaoId, novo.id, idExterno)))
    return msgLigacoes.erroAoGravar();
  return { ok: true, id: novo.id };
}

/** O eleven.agenteId das ligações da conexão ativa (o agente ligado ao tronco); null = nenhum. */
async function agenteDoTronco(): Promise<string | null> {
  const conexao = await conexaoAtiva();
  const l = conexao ? lerLigacoesGravadas(conexao.parametros) : null;
  return l?.eleven.agenteId ?? null;
}

// ---------- as funções da área ----------

type Acao<T> = (membroId: string) => Promise<T>;

/** Confere o admin e transforma uma falha do banco na mensagem fixa. */
async function comoAdmin(
  ctx: ContextoAgentes,
  acao: Acao<ResultadoAgentes>,
): Promise<ResultadoAgentes> {
  const membroId = await membroAdmin(ctx);
  if (!membroId) return msgAgentes.semAcesso();
  try {
    return await acao(membroId);
  } catch (e) {
    // o check ligacao_agentes_atende_recebe (23514): o uso e o "atende" mudaram ao mesmo tempo
    // (salvar e Atender juntos); a mensagem diz o que aconteceu (Opus, PR #26)
    if (e instanceof Error && e.message.endsWith(":23514")) return msgAgentes.usoMudouNoMeio();
    console.error("ligacoes_agentes_banco");
    return msgLigacoes.erroAoGravar();
  }
}

export async function criarAgenteLigacaoLogica(
  ctx: ContextoAgentes,
  entrada: unknown,
  opcoes?: OpcoesAgentes,
): Promise<ResultadoAgentes> {
  const lido = lerCamposAgente(entrada);
  return comoAdmin(ctx, async (membroId) => {
    if (!lido.ok) return lido;
    const amb = await lerAmbiente();
    if (ehFalha(amb)) return amb;
    // com as ligações ativas, criar é criar lá também (L10): a prévia não cria
    if (amb && ctx.naPrevia) return msgAgentes.previa();
    // o primeiro agente atende (o número precisa de um); com as ligações ativas, só depois de ter
    // o tronco (L34): até lá, o tronco continua no agente que já atende
    const primeiro = (await listarAgentes()).length === 0;
    if (primeiro && lido.campos.uso !== "receber") return msgAgentes.primeiroReceptivo();
    const linha = await inserirAgente(lido.campos, {
      atende: primeiro && !amb,
      criadoPor: membroId,
    });
    if (!amb) return { ok: true, id: linha.id };
    // o primeiro, com as ligações da primeira versão ativas (sem linha), adota o agente do tronco
    const f = await sincronizarAgente(linha, amb, opcoes, { adotarDoTronco: primeiro });
    if (f) {
      // criar na tela cria lá (L10): sem o agente lá, a linha sai (mesmo se já atende)
      await apagarLinhaAgente(linha.id, { mesmoQueAtende: true });
      return { ok: false, ...f };
    }
    if (primeiro) {
      const relida = await lerAgente(linha.id);
      if (!relida) return msgAgentes.naoEncontrado();
      // as ligações saíram no meio (só a linha ficou): ela atende como sem as ligações
      if (!relida.idExterno) await atenderAgente(relida.id);
      else {
        const r = await trocarQuemAtende(relida, amb, opcoes);
        if (!r.ok) return r;
      }
    }
    return { ok: true, id: linha.id };
  });
}

export async function salvarAgenteLigacaoLogica(
  ctx: ContextoAgentes,
  agenteId: string,
  entrada: unknown,
  opcoes?: OpcoesAgentes,
): Promise<ResultadoAgentes> {
  return comoAdmin(ctx, async () => {
    const antes = await lerAgente(agenteId);
    if (!antes) return msgAgentes.naoEncontrado();
    const lido = lerCamposAgente(entrada, antes.uso);
    if (!lido.ok) return lido;
    // com as ligações ativas, a prévia não salva: a duração e os limites que ficassem no banco
    // valeriam já no teto da espera e na sessão, sem estar no agente da ElevenLabs
    if (ctx.naPrevia) {
      const ativas = await lerAmbiente();
      if (ehFalha(ativas)) return ativas;
      if (ativas) return msgAgentes.previa();
    }
    // só um Receptivo atende (A1): o que atende não vira Ativo (o check do banco também recusa), nem o
    // que ainda está ligado ao tronco (um Atender pela metade; Opus, PR #26)
    if (lido.campos.uso !== "receber") {
      if (antes.atende) return msgAgentes.queAtendeFicaReceptivo();
      if (antes.idExterno && antes.idExterno === (await agenteDoTronco())) {
        return msgAgentes.queAtendeFicaReceptivo();
      }
    }
    const linha = await atualizarCamposAgente(agenteId, lido.campos);
    if (!linha) return msgAgentes.naoEncontrado();
    const amb = await lerAmbiente();
    if (ehFalha(amb)) return msgAgentes.salvoSemSincronia(amb);
    if (amb) {
      const f = await sincronizarAgente(linha, amb, opcoes);
      if (f) return msgAgentes.salvoSemSincronia(f);
    }
    return { ok: true, id: linha.id };
  });
}

export async function apagarAgenteLigacaoLogica(
  ctx: ContextoAgentes,
  agenteId: string,
  opcoes?: OpcoesAgentes,
): Promise<ResultadoAgentes> {
  return comoAdmin(ctx, async () => {
    const linha = await lerAgente(agenteId);
    if (!linha) return msgAgentes.naoEncontrado();
    if (linha.atende) return msgAgentes.agenteQueAtende();
    // o agente ainda ligado ao tronco (um Atender no meio) também não sai
    if (linha.idExterno && linha.idExterno === (await agenteDoTronco())) {
      return msgAgentes.agenteQueAtende();
    }
    if (linha.idExterno && ctx.naPrevia) return msgAgentes.previa();
    // solta o agente na mesma transação que confere que ele não atende nem está numa ligação: uma
    // saída com ele espera ou recusa, e o apagar lá não derruba ligação nenhuma (Sol, PR #26)
    const solto = await soltarAgente(linha.id);
    if (!solto.ok) {
      if (solto.motivo === "nao_encontrado") return msgAgentes.naoEncontrado();
      if (solto.motivo === "atende") return msgAgentes.agenteQueAtende();
      return msgAgentes.emLigacao();
    }
    if (solto.idExterno) {
      const idExterno = solto.idExterno;
      const k = await lerChaveIA("voz");
      const chave = k && k.provedor === "elevenlabs" && k.chave.trim() ? k.chave : null;
      // sem a chave, o agente lá fica fora do alcance do app (nada a fazer por aqui)
      if (chave) {
        const fim = await apagarRecursoEleven(chave, "agente", idExterno, {
          ...opcoes,
          prazoMs: opcoes?.prazoMs ?? PRAZO_MS,
        });
        if (fim === "ficou" || fim === "chave_recusada") {
          // o agente continua lá: o id volta para a linha (sem carimbo: fica marcado como atrás)
          const voltou = await gravarSincronia(linha.id, {
            idExterno,
            // o aviso de desatualizado de antes continua (Opus, PR #26)
            erroSincronia: linha.erroSincronia,
            seIdExterno: null,
          });
          // o id não voltou: a linha saiu no meio (outro admin apagou ao mesmo tempo) ou ganhou outro
          // agente (uma sincronia recriou). O agente antigo ficou lá, sem linha aqui, e quem apagou
          // precisa saber (Sol e Opus, PR #26)
          if (!voltou) {
            console.error("ligacoes_agente_orfao");
            return msgAgentes.ficouNaEleven();
          }
          return fim === "ficou" ? msgAgentes.naoApagou() : msgLigacoes.chaveInvalida();
        }
      }
    }
    // só a linha ainda sem agente lá: se uma sincronia recriou o agente no meio, ele não fica órfão
    // (Opus, PR #26)
    if (!(await apagarLinhaAgente(linha.id, { soSemId: true }))) {
      const agora = await lerAgente(linha.id);
      if (!agora) return msgAgentes.naoEncontrado();
      console.error("ligacoes_agente_recriado");
      return msgAgentes.recriadoNoMeio();
    }
    return { ok: true, id: linha.id };
  });
}

export async function atenderAgenteLigacaoLogica(
  ctx: ContextoAgentes,
  agenteId: string,
  opcoes?: OpcoesAgentes,
): Promise<ResultadoAgentes> {
  return comoAdmin(ctx, async () => {
    const novo = await lerAgente(agenteId);
    if (!novo) return msgAgentes.naoEncontrado();
    if (novo.uso !== "receber") return msgAgentes.ativoNaoAtende();
    const amb = await lerAmbiente();
    if (ehFalha(amb)) return amb;
    if (!amb) {
      if (!novo.atende) await atenderAgente(novo.id);
      return { ok: true, id: novo.id };
    }
    if (ctx.naPrevia) return msgAgentes.previa();
    // já atende e o tronco já é dele: nada a fazer. Já atende e o espelho não gravou: reconcilia
    if (novo.atende && novo.idExterno && amb.ligacoes.eleven.agenteId === novo.idExterno)
      return { ok: true, id: novo.id };
    return trocarQuemAtende(novo, amb, opcoes);
  });
}

/**
 * Leva os agentes para a versão do código e para o Contexto atual (L13 e L14). Com as ligações
 * ativas, todos os agentes: os que já existem lá recebem o PATCH; os que não existem são criados.
 * Sem as ligações ativas, nada a fazer.
 */
export async function atualizarAgentesLigacaoLogica(
  ctx: ContextoAgentes,
  opcoes?: OpcoesAgentes,
): Promise<ResultadoAgentes> {
  return comoAdmin(ctx, async () => {
    const amb = await lerAmbiente();
    if (ehFalha(amb)) return amb;
    if (!amb) return { ok: true };
    if (ctx.naPrevia) return msgAgentes.previa();
    return sincronizarTodos(amb, await listarAgentes(), opcoes);
  });
}

async function sincronizarTodos(
  amb: Ambiente,
  agentes: readonly LinhaAgente[],
  opcoes?: OpcoesAgentes,
): Promise<ResultadoAgentes> {
  let falhas = 0;
  let ultima: { erro: ErroLigacoes; mensagem: string } | null = null;
  for (const a of agentes) {
    const f = await sincronizarAgente(a, amb, opcoes);
    if (f) {
      falhas += 1;
      ultima = f;
    }
  }
  return ultima ? msgAgentes.algunsSemSincronia(falhas, ultima) : { ok: true };
}

/**
 * O Contexto foi salvo pela tela (L14): os agentes que existem na ElevenLabs e estão atrás dele
 * recebem o Contexto novo. Não bloqueia o salvar: um erro vira erro_sincronia, que a aba Agentes
 * mostra. Também só o admin (quem salva o Contexto).
 */
export async function sincronizarContextoLigacaoLogica(
  ctx: ContextoAgentes,
  opcoes?: OpcoesAgentes,
): Promise<ResultadoAgentes> {
  return comoAdmin(ctx, async () => {
    const amb = await lerAmbiente();
    if (ehFalha(amb)) return amb;
    if (!amb) return { ok: true };
    // o Contexto já ficou salvo; o início manda o Contexto novo enquanto o agente estiver atrás
    if (ctx.naPrevia) return msgAgentes.previa();
    const contexto = await lerContextoAtual();
    const atras = (await listarAgentes()).filter(
      (a) => a.idExterno && agenteAtrasDoContexto(a.sincronizadoEm, contexto.criadoEm),
    );
    return sincronizarTodos(amb, atras, opcoes);
  });
}

/**
 * A voz do cartão Voz mudou (L37): os agentes que existem na ElevenLabs e usam a voz do cartão
 * (voz_id nulo) recebem o PATCH com a voz nova. Como o do Contexto: não bloqueia o salvar da voz, e
 * um erro vira erro_sincronia, que a aba Agentes mostra. Só o admin (quem escolhe a voz).
 */
export async function sincronizarVozLigacaoLogica(
  ctx: ContextoAgentes,
  opcoes?: OpcoesAgentes,
): Promise<ResultadoAgentes> {
  return comoAdmin(ctx, async () => {
    const amb = await lerAmbiente();
    if (ehFalha(amb)) return amb;
    if (!amb) return { ok: true };
    if (ctx.naPrevia) return msgAgentes.previa();
    const daVozDoCartao = (await listarAgentes()).filter((a) => a.idExterno && !a.vozId);
    return sincronizarTodos(amb, daVozDoCartao, opcoes);
  });
}

/**
 * As ligações da primeira versão, ativadas antes de existir ligacao_agentes (L43): estão ativas, o
 * agente está no tronco (eleven.agenteId), e nenhuma linha. Nasce a linha "Nina" (AGENTE_PADRAO,
 * atende, sem voz própria: a do cartão Voz, L37), que adota o agente do tronco (L34): o PATCH leva a
 * configuração nova e o Contexto, e o id_externo dela passa a ser o agente do tronco. Também conserta
 * a linha que atende sem id_externo (o passo 8 que não gravou).
 *
 * A tela do admin chama ao abrir a área; repetir não faz nada (com a linha que atende já lá, nem vai
 * à rede). Duas abas ao mesmo tempo: o índice único do `atende` deixa uma linha só (a outra relê e
 * segue com ela), e as duas sincronias da mesma linha se acertam pela trava do atualizado_em (L33).
 * Se a ElevenLabs recusar, a linha fica, com o erro_sincronia no cartão, e a próxima abertura tenta
 * de novo.
 */
export async function adotarAgenteDoTroncoLogica(
  ctx: ContextoAgentes,
  opcoes?: OpcoesAgentes,
): Promise<ResultadoAgentes> {
  return comoAdmin(ctx, async (membroId) => {
    const amb = await lerAmbiente();
    if (ehFalha(amb)) return amb;
    if (!amb || !amb.ligacoes.eleven.agenteId) return { ok: true };
    if (ctx.naPrevia) return { ok: true };
    let agentes = await listarAgentes();
    if (agentes.length === 0) {
      try {
        await inserirAgente({ ...AGENTE_PADRAO }, { atende: true, criadoPor: membroId });
      } catch (e) {
        // outra aba criou a linha no meio (o índice único do atende): vale a dela
        if ((await listarAgentes()).length === 0) throw e;
      }
      agentes = await listarAgentes();
    }
    const quem = agentes.find((a) => a.atende);
    if (!quem || quem.idExterno) return { ok: true };
    const f = await sincronizarAgente(quem, amb, opcoes);
    return f ? { ok: false, ...f } : { ok: true, id: quem.id };
  });
}

export async function salvarLimitesLigacoesLogica(
  ctx: ContextoAgentes,
  entrada: unknown,
  opcoes?: OpcoesAgentes,
): Promise<ResultadoAgentes> {
  const lido = lerLimitesEntrada(entrada);
  return comoAdmin(ctx, async () => {
    if (!lido.ok) return lido;
    if (ctx.naPrevia) {
      const ativas = await lerAmbiente();
      if (ehFalha(ativas)) return ativas;
      if (ativas) return msgAgentes.previa();
    }
    await gravarLimites(lido.limites);
    const amb = await lerAmbiente();
    if (ehFalha(amb)) return msgAgentes.salvoSemSincronia(amb);
    if (!amb) return { ok: true };
    // os limites vão a todos os agentes que já existem lá (call_limits)
    const r = await sincronizarTodos(
      { ...amb, limites: lido.limites },
      (await listarAgentes()).filter((a) => a.idExterno),
      opcoes,
    );
    return r.ok ? r : msgAgentes.salvoSemSincronia(r);
  });
}
