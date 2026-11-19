// Ligações pelo WhatsApp na Configuração (2.6): ler o estado, ativar e
// desativar. Só o admin (membroAdmin).
//
// - estado: só lê o banco (nenhuma chamada externa).
// - estado: "ativando" parado há mais de 2 minutos aparece como "com_pendencias", com a lista do
//   que a ativação criou (D20).
// - verificar (seção 21): só lê. Confere os requisitos e, na Meta, o token, o limite de 2.000, a
//   saúde do número e que o número não manda as ligações para outro servidor SIP (D19); na
//   ElevenLabs, que a chave enxerga os agentes. Grava o resultado em
//   parametros.ligacoesElegibilidade, que o estado devolve.
// - ativar: faz a mesma verificação e, reprovada, devolve a falha do primeiro item com a lista.
//   Aprovada, liga o SIP na Meta com as chamadas desligadas e lê a senha SIP (antes da ElevenLabs:
//   se a Meta recusar, nada foi criado lá), cria, nesta ordem, o segredo, o webhook pós-chamada, a
//   ferramenta e o agente na ElevenLabs, cria o tronco, o liga ao agente e só então liga as
//   chamadas na Meta (D18). A recusa da Meta por limite ou pausa (138015, 138014) corrige a
//   verificação guardada. Cada recurso criado é gravado em parametros.ligacoes (situação
//   "ativando", com atualizadaEm novo) antes do passo seguinte. A primeira gravação é a trava do
//   duplo clique; as seguintes só valem com a conexão ativa e na mesma ativação (D21): senão a
//   ativação para e desmonta o que criou. Falha em qualquer passo desmonta o que já saiu e
//   devolve o erro do passo; o que não sair fica como pendência ("com_pendencias").
//   Antes de gravar "ativa", confere que a chave da voz guardada ainda é a que ela usou; se mudou
//   e a nova não lê o agente, desmonta com a chave da memória (D29).
// - desativar: Meta (só se o app ligou), depois a ordem da D17 (tronco, agente, ferramenta,
//   webhook, segredo). Tudo saiu: limpa parametros.ligacoes e os dois segredos. Senão grava
//   "com_pendencias" com a lista. Sem o token da Meta (a conexão já saiu), a Meta vira
//   "meta_manual", que só o desativar seguinte (o "Já desliguei") tira (D23). Com 401 da
//   ElevenLabs (chave revogada), o que ficou lá vira "eleven_manual", que só o desativar seguinte
//   (o "Já apaguei") tira (D30): com a chave guardada, ele tenta os DELETE antes (2xx, 404 e 401
//   confirmam; outra falha mantém a pendência).
// - desmontarLigacoes: a mesma desmontagem, para o Desconectar e o Trocar de WhatsApp (D15), com
//   um teto de tempo e sem nunca lançar.
// - Os agentes de voz (L2 e 2.2): a ativação cria a linha do agente
//   "Nina" (AGENTE_PADRAO, atende, sem voz própria: usa a do cartão Voz e acompanha a troca, L37)
//   se ainda não há nenhuma; numa reativação,
//   reaproveita as linhas. O agente que atende é criado na ElevenLabs no passo do agente, a partir
//   da linha, com os limites da conta e o Contexto inteiro (L14); o id dele fica em
//   parametros.ligacoes.eleven.agenteId (o agente ligado ao tronco). Os outros agentes são criados
//   depois de "ativa", sem bloquear a ativação (o que falhar fica em erro_sincronia). A
//   desmontagem apaga também os outros agentes (depois da Meta e do tronco, antes do agente do
//   tronco, da ferramenta, do webhook e do segredo) e zera o id_externo das linhas que saíram; as
//   linhas ficam. Sem conseguir ler as linhas, fica a pendência "agente".
// - D28: toda desmontagem fora da ativação marca o estado antes (uma gravação com a trava do
//   atualizadaEm lido): a ativação em curso perde a trava na próxima gravação e desmonta o que
//   criou. A gravação do fim também tem a trava: se alguém gravou depois, relê e junta as
//   pendências. A ativação que perde a trava para outra ativação desmonta só a ElevenLabs dela e
//   não desliga a Meta (que é da nova).
//
// A chave da ElevenLabs, o token da Meta, o ligacaoToken, o segredo HMAC e a senha SIP nunca
// voltam no resultado nem vão para o log: as mensagens são as fixas de ligacoes/mensagens.ts e o
// log só leva códigos.
import { formatarNumero } from "@/features/servidor/numero-whatsapp";
import { PRAZO_MS, type OpcoesValidacao } from "@/features/servidor/http";
import {
  apagarRecursoEleven,
  VERSAO_AGENTE,
  chaveLeAgente,
  conferirAcessoAgentes,
  criarAgente,
  criarFerramentaEquipe,
  criarSegredo,
  criarTronco,
  criarWebhookPosChamada,
  ligarSaidaDoTronco,
  ligarTroncoAoAgente,
  ORDEM_APAGAR,
  type RecursoEleven,
} from "@/features/servidor/ligacoes-elevenlabs";
import {
  conferirSipMeta,
  desligarSipMeta,
  ligarCallbackMeta,
  lerNumeroMeta,
  lerSenhaSipMeta,
  ligarChamadasMeta,
  ligarSipMeta,
} from "@/features/servidor/ligacoes-meta";

import { membroAdmin, type ContextoUsuario } from "../configuracao.server";
import {
  atenderAgente,
  gravarSincronia,
  inserirAgente,
  lerLimites,
  listarAgentes,
  zerarIdsExternos,
  type LinhaAgente,
} from "../ligacoes/agentes-banco.server";
import { lerContextoAtual } from "../ligacoes/banco.server";
import {
  avaliarElegibilidade,
  lerElegibilidade,
  reprovadaPelaMeta,
  type Avaliacao,
} from "../ligacoes/elegibilidade";
import { ativacaoAbandonada, criadosNaAtivacao, lerLigacoesGravadas } from "../ligacoes/gravadas";
import { msgLigacoes } from "../ligacoes/mensagens";
import {
  AGENTE_PADRAO,
  ATIVACAO_ABANDONADA_MS,
  CHAVE_ELEGIBILIDADE,
  requisitosCumpridos,
  urlDaLigacao,
  type Elegibilidade,
  type EstadoLigacoes,
  type FalhaLigacoes,
  type LigacoesGravadas,
  type PendenciaLigacoes,
  type RequisitosLigacoes,
  type ResultadoLigacoes,
} from "../ligacoes/tipos";
import { gerarSegredo } from "../nucleo/cifra";
import { carregarConexao, conexaoAtiva, lerChaveIA } from "../nucleo/conexoes.server";
import { ehOrigemDePrevia } from "../nucleo/origem";
import { segredosCompletos } from "../nucleo/segredos";
import type { ConexaoServidor } from "../nucleo/tipos";
import { ligacoesVigentes, sincronizarAgente, type Ambiente } from "./agentes-ligacao.server";
import { lerConfigVozTela, lerResumoChaveIA } from "./banco.server";
import {
  gravarElegibilidade,
  lerVersaoConexao,
  lerVersaoConexaoAtiva,
  type VersaoConexao,
  gravarLigacoes,
  gravarProgressoLigacoes,
  idConexaoComLigacoesPendentes,
  iniciarLigacoes,
  limparLigacoes,
} from "./ligacoes-banco.server";

export type PedidoLigacoes = { origem: string };

/** fetch e prazo de cada pedido (os testes passam um fetch falso). */
export type OpcoesLigacoes = OpcoesValidacao;

/** Teto da desmontagem no Desconectar e no Trocar (D15): o resto fica como pendência. */
export const TETO_DESMONTAR_LIGACOES_MS = 12_000;

// ---------- leitura ----------

type Alvo = { conexao: ConexaoServidor; ligacoes: LigacoesGravadas };

type Leitura = {
  requisitos: RequisitosLigacoes;
  /** a conexão ativa, se for da Meta com os segredos completos */
  meta: ConexaoServidor | null;
  /** a conexão que tem parametros.ligacoes: a ativa, ou uma antiga com pendências (D15) */
  alvo: Alvo | null;
  /**
   * a última verificação da conexão ativa (seção 21); null com a conexão caída (o que foi
   * conferido pode não valer mais)
   */
  elegibilidade: Elegibilidade | null;
  /** a versão da conexão ativa, lida antes de tudo: a verificação só é gravada nela */
  versao: VersaoConexao | null;
};

function ehConexaoMeta(c: ConexaoServidor | null): c is ConexaoServidor {
  return c !== null && c.gateway === "meta" && segredosCompletos("meta", c.segredos);
}

function enderecoPublicado(origem: string): boolean {
  return /^https:\/\//i.test(origem) && !ehOrigemDePrevia(origem);
}

function phoneIdDa(c: ConexaoServidor): string {
  const v = c.parametros["phoneId"];
  return typeof v === "string" && v.trim() ? v.trim() : c.id_externo;
}

/** Lê os requisitos e a conexão com ligações. Só banco; lança se o banco falhar. */
async function ler(pedido: PedidoLigacoes): Promise<Leitura> {
  // a versão antes do token (seção 21): qualquer escrita depois dela invalida o que for conferido
  const versao = await lerVersaoConexaoAtiva();
  const ativa = await conexaoAtiva();
  const resumo = await lerResumoChaveIA("voz");
  const voz = await lerConfigVozTela();
  const meta = ehConexaoMeta(ativa) ? ativa : null;
  const requisitos: RequisitosLigacoes = {
    conexaoMeta: meta !== null,
    chaveVoz:
      resumo !== null &&
      resumo.provedor === "elevenlabs" &&
      resumo.status === "ativa" &&
      resumo.temChave,
    vozEscolhida: voz.voz !== null,
    enderecoPublicado: enderecoPublicado(pedido.origem),
  };

  let alvo: Alvo | null = null;
  const daAtiva = ativa ? lerLigacoesGravadas(ativa.parametros) : null;
  if (ativa && daAtiva) {
    alvo = { conexao: ativa, ligacoes: daAtiva };
  } else {
    const id = await idConexaoComLigacoesPendentes();
    const antiga = id ? await carregarConexao(id) : null;
    const ligacoes = antiga ? lerLigacoesGravadas(antiga.parametros) : null;
    if (antiga && ligacoes) alvo = { conexao: antiga, ligacoes };
  }
  const conectada = !!ativa && versao?.id === ativa.id && versao.status === "conectada";
  const elegibilidade = conectada ? lerElegibilidade(ativa.parametros[CHAVE_ELEGIBILIDADE]) : null;
  return { requisitos, meta, alvo, elegibilidade, versao };
}

/** A ativação parada há mais de 2 minutos (D20), pelo relógio de agora. */
function abandonada(l: LigacoesGravadas): boolean {
  return ativacaoAbandonada(l, Date.now(), ATIVACAO_ABANDONADA_MS);
}

function montarEstado(
  requisitos: RequisitosLigacoes,
  l: LigacoesGravadas | null,
  elegibilidade: Elegibilidade | null = null,
): EstadoLigacoes {
  // D20: a ativação abandonada aparece com a lista do que criou, para o "Tentar de novo" desmontar
  if (l && abandonada(l)) {
    return {
      situacao: "com_pendencias",
      requisitos,
      elegibilidade,
      numero: null,
      ativadaEm: null,
      pendencias: criadosNaAtivacao(l),
      abandonada: true,
    };
  }
  const situacao = l ? l.situacao : requisitosCumpridos(requisitos) ? "pronta" : "indisponivel";
  return {
    situacao,
    requisitos,
    elegibilidade,
    numero: l?.situacao === "ativa" && l.numero ? formatarNumero(l.numero) : null,
    ativadaEm: l?.ativadaEm ?? null,
    pendencias: l?.pendencias ?? [],
  };
}

/** Um ISO novo para atualizadaEm, sempre diferente do anterior (a trava do progresso compara). */
function carimbo(anterior = ""): string {
  const agora = new Date().toISOString();
  return agora === anterior ? new Date(Date.parse(agora) + 1).toISOString() : agora;
}

async function estadoAtual(pedido: PedidoLigacoes): Promise<ResultadoLigacoes> {
  try {
    const leitura = await ler(pedido);
    return {
      ok: true,
      estado: montarEstado(
        leitura.requisitos,
        leitura.alvo?.ligacoes ?? null,
        leitura.elegibilidade,
      ),
    };
  } catch {
    return msgLigacoes.erroAoLer();
  }
}

/** A chave da ElevenLabs guardada (finalidade voz), decifrada. null = não há. Lança se não abriu. */
async function lerChaveDaVoz(): Promise<string | null> {
  const k = await lerChaveIA("voz");
  return k && k.provedor === "elevenlabs" && k.chave.trim() ? k.chave : null;
}

/** O mesmo, sem lançar: null = não há ou não abriu. */
async function chaveDaVoz(): Promise<string | null> {
  try {
    return await lerChaveDaVoz();
  } catch {
    return null;
  }
}

/** O estado das ligações da conexão como está agora no banco. null = não há. Lança se o banco falhar. */
async function lerGravadas(conexaoId: string): Promise<LigacoesGravadas | null> {
  const c = await carregarConexao(conexaoId);
  return c ? lerLigacoesGravadas(c.parametros) : null;
}

// ---------- desmontar (D17) ----------

const CAMPO_DO_RECURSO: Record<RecursoEleven, keyof LigacoesGravadas["eleven"]> = {
  tronco: "troncoId",
  agente: "agenteId",
  ferramenta: "ferramentaId",
  webhook: "webhookId",
  segredo: "segredoId",
};

/** As pendências que só o admin tira, no painel do provedor (D23 e D30). */
const META_MANUAL: PendenciaLigacoes = "meta_manual";
const ELEVEN_MANUAL: PendenciaLigacoes = "eleven_manual";

type Acesso = {
  /** a chave da ElevenLabs; null = sem chave (os recursos de lá ficam como pendência) */
  chave: string | null;
  /** o token da Meta; null = a conexão já perdeu os segredos (desconectada) */
  token: string | null;
  /**
   * true = o token vai sumir logo depois (Desconectar, Trocar): a Meta que não sair já vira
   * "meta_manual" (D34), porque ninguém vai conseguir tentar de novo pelo app
   */
  tokenVaiSumir?: boolean;
  phoneId: string;
};

/**
 * A lista de pendências de um estado: "meta" (ou "meta_manual") se a Meta ficou ligada, e cada
 * recurso da ElevenLabs que ainda tem id, na ordem da D17 (ou só "eleven_manual", D30).
 */
function pendenciasDo(
  e: LigacoesGravadas,
  manuais: { meta: boolean; eleven: boolean },
): PendenciaLigacoes[] {
  const lista: PendenciaLigacoes[] = [];
  if (e.metaSip) lista.push(manuais.meta ? META_MANUAL : "meta");
  const restam = ORDEM_APAGAR.filter((r) => e.eleven[CAMPO_DO_RECURSO[r]]);
  if (restam.length > 0) lista.push(...(manuais.eleven ? [ELEVEN_MANUAL] : restam));
  return lista;
}

/**
 * Apaga o que o estado diz que existe, na ordem: Meta (só se metaSip), tronco, agente, ferramenta,
 * webhook e segredo. 404 conta como apagado. Devolve o estado com os ids que saíram em null e a
 * lista do que ficou. Com `limite` (Date.now() de quando parar), um passo sem tempo vira pendência
 * sem chamar ninguém. Um 401 da ElevenLabs (a chave foi revogada) para os pedidos de lá, e o que
 * ficou vira "eleven_manual" (D30). `depoisDoTronco` roda uma vez, logo depois do passo do tronco
 * (os outros agentes de voz, L26: o número já não chega a eles, e a Meta saiu antes de tudo). Com `confirmar` (o desativar do admin), um "eleven_manual" já
 * gravado é o "Já apaguei": com a chave guardada, os DELETE da D17 confirmam (2xx, 404 e 401 tiram
 * o id; outra falha mantém o "eleven_manual"); sem chave, os ids saem sem chamar ninguém. Nunca
 * lança.
 */
async function desmontar(
  estado: LigacoesGravadas,
  acesso: Acesso,
  opcoes: OpcoesLigacoes | undefined,
  limite?: number,
  confirmar = false,
  depoisDoTronco?: () => Promise<void>,
): Promise<LigacoesGravadas> {
  const e: LigacoesGravadas = { ...estado, eleven: { ...estado.eleven } };
  /** o prazo de um pedido; null = o teto acabou */
  const prazo = (): number | null => {
    const base = opcoes?.prazoMs ?? PRAZO_MS;
    if (limite === undefined) return base;
    const sobra = limite - Date.now();
    return sobra > 0 ? Math.min(base, sobra) : null;
  };

  let metaManual = false;
  if (e.metaSip) {
    if (acesso.token === null) {
      // a conexão já perdeu o token (Desconectar): o app não alcança mais a Meta, e as ligações
      // só saem pelo painel da Meta (D23). A primeira vez vira "meta_manual"; o desativar seguinte,
      // com "meta_manual" já gravado, é o "Já desliguei" do admin e tira a pendência.
      if (estado.pendencias.includes(META_MANUAL)) e.metaSip = false;
      else metaManual = true;
    } else {
      const ms = prazo();
      const saiu =
        ms !== null &&
        (await desligarSipMeta(acesso.token, acesso.phoneId, { ...opcoes, prazoMs: ms }));
      if (saiu) e.metaSip = false;
      // o "Já desliguei" do admin (desativar com "meta_manual" gravado): vale a palavra dele
      else if (confirmar && estado.pendencias.includes(META_MANUAL)) e.metaSip = false;
      // D34: o token vai sumir (Desconectar, Trocar), então só o painel da Meta desliga; e um
      // "meta_manual" já gravado (outra desmontagem chegou antes) não volta a ser "meta"
      else if (acesso.tokenVaiSumir || estado.pendencias.includes(META_MANUAL)) metaManual = true;
    }
  }

  let elevenManual = false;
  if (confirmar && estado.pendencias.includes(ELEVEN_MANUAL)) {
    // o "Já apaguei" (D30): o admin diz que apagou no painel da ElevenLabs. Com a chave guardada,
    // os DELETE da D17 confirmam: 2xx e 404 (já não existe) e 401 (a chave não alcança a conta:
    // vale a palavra do admin, para este e os próximos) tiram o id; outra falha, ou o teto de
    // tempo, mantém a pendência manual. Sem chave, vale a palavra do admin.
    let palavraDoAdmin = false;
    for (const recurso of ORDEM_APAGAR) {
      if (recurso === "agente" && depoisDoTronco) await depoisDoTronco();
      const campo = CAMPO_DO_RECURSO[recurso];
      const id = e.eleven[campo];
      if (!id) continue;
      if (palavraDoAdmin || acesso.chave === null) {
        e.eleven[campo] = null;
        continue;
      }
      const ms = prazo();
      if (ms === null) {
        elevenManual = true;
        continue;
      }
      const fim = await apagarRecursoEleven(acesso.chave, recurso, id, { ...opcoes, prazoMs: ms });
      if (fim === "ficou") {
        elevenManual = true;
        continue;
      }
      e.eleven[campo] = null;
      if (fim === "chave_recusada") palavraDoAdmin = true;
    }
  } else {
    for (const recurso of ORDEM_APAGAR) {
      if (recurso === "agente" && depoisDoTronco) await depoisDoTronco();
      const campo = CAMPO_DO_RECURSO[recurso];
      const id = e.eleven[campo];
      if (!id || acesso.chave === null || elevenManual) continue;
      const ms = prazo();
      if (ms === null) continue;
      const fim = await apagarRecursoEleven(acesso.chave, recurso, id, { ...opcoes, prazoMs: ms });
      if (fim === "saiu") e.eleven[campo] = null;
      // a chave foi revogada: os outros pedidos dariam o mesmo 401 (D30)
      else if (fim === "chave_recusada") elevenManual = true;
    }
  }

  e.pendencias = pendenciasDo(e, { meta: metaManual, eleven: elevenManual });
  if (e.pendencias.length > 0) e.situacao = "com_pendencias";
  return e;
}

/** Quantas vezes uma gravação com trava relê e tenta de novo (cada perda é alguém que gravou no meio). */
const TENTATIVAS_TRAVA = 4;

/**
 * D28: marca o estado antes de desmontar, com a trava do atualizadaEm lido. A ativação em curso
 * perde a trava na próxima gravação dela. Perdeu a trava (alguém gravou depois da leitura): relê e
 * marca de novo, com o estado novo. Devolve o estado marcado (o atualizadaEm dele é a trava do
 * fim) ou null se as ligações já saíram. Lança se o banco falhar.
 */
async function invalidar(
  conexaoId: string,
  lida: LigacoesGravadas,
): Promise<LigacoesGravadas | null> {
  let atual: LigacoesGravadas | null = lida;
  for (let i = 0; i < TENTATIVAS_TRAVA && atual; i++) {
    const jaPendente = atual.situacao === "com_pendencias";
    const marcado: LigacoesGravadas = {
      ...atual,
      situacao: "com_pendencias",
      // as pendências gravadas ficam (o "meta_manual" e o "eleven_manual" dependem delas)
      pendencias: jaPendente ? atual.pendencias : criadosNaAtivacao(atual),
      atualizadaEm: carimbo(atual.atualizadaEm),
    };
    if (await gravarLigacoes(conexaoId, marcado, atual.atualizadaEm)) return marcado;
    atual = await lerGravadas(conexaoId);
  }
  if (atual) throw new Error("ligacoes_trava_disputada");
  return null;
}

/**
 * O que a desmontagem (`antes` → `fim`) sabe, somado ao que outra gravou depois (`gravada`): um id
 * que esta tentou apagar fica como ela terminou (saiu ou ficou); um que ela não conhecia fica como
 * o outro gravou. O mesmo para a Meta. As pendências manuais de qualquer um dos dois continuam.
 */
function juntarFim(
  antes: LigacoesGravadas,
  fim: LigacoesGravadas,
  gravada: LigacoesGravadas,
): LigacoesGravadas {
  const eleven = { ...gravada.eleven };
  for (const campo of Object.keys(eleven) as (keyof LigacoesGravadas["eleven"])[]) {
    const nosso = antes.eleven[campo];
    const deles = gravada.eleven[campo];
    // um id diferente do nosso no mesmo campo: o deles fica, a não ser que o nosso também ficou
    if (nosso)
      eleven[campo] = deles && deles !== nosso ? (fim.eleven[campo] ?? deles) : fim.eleven[campo];
  }
  const metaSip = antes.metaSip ? fim.metaSip : gravada.metaSip;
  const manual = (p: PendenciaLigacoes) =>
    fim.pendencias.includes(p) || gravada.pendencias.includes(p);
  const juntado: LigacoesGravadas = { ...gravada, eleven, metaSip };
  return {
    ...juntado,
    pendencias: pendenciasDo(juntado, { meta: manual(META_MANUAL), eleven: manual(ELEVEN_MANUAL) }),
  };
}

/**
 * Grava o fim da desmontagem (`antes` → `fim`), com a trava `anterior` (o atualizadaEm que a
 * desmontagem leu ou marcou; null = a conexão estava sem ligações): sem pendência, limpa
 * parametros.ligacoes e os dois segredos; com pendência, grava "com_pendencias". Se alguém gravou
 * depois (D28), relê: um "com_pendencias" é outra desmontagem (o Desconectar, a ativação que
 * desfez) e as duas se juntam; sem ligações, só grava se ainda ficou algo; um "ativando" ou "ativa"
 * é outra ativação, e nada é gravado por cima dela. `nossos` são outros atualizadaEm que esta
 * desmontagem pode ter gravado (a gravação da ativação que entrou mas voltou com erro). Devolve
 * o que ficou em parametros.ligacoes: o atualizadaEm do "com_pendencias" gravado, null (sem
 * ligações) ou undefined (não gravou: outra ativação está lá). Lança se o banco falhar.
 */
async function gravarFim(
  conexaoId: string,
  antes: LigacoesGravadas,
  fim: LigacoesGravadas,
  anterior: string | null,
  nossos: readonly string[] = [],
): Promise<string | null | undefined> {
  let alvo = fim;
  let trava = anterior;
  for (let i = 0; i < TENTATIVAS_TRAVA; i++) {
    let gravou: boolean;
    let atualizadaEm: string | null = null;
    if (alvo.pendencias.length === 0) {
      // sem ligações e nada ficou: nada a gravar
      if (trava === null) return null;
      gravou = await limparLigacoes(conexaoId, trava);
    } else {
      atualizadaEm = carimbo(trava ?? "");
      gravou = await gravarLigacoes(
        conexaoId,
        { ...alvo, situacao: "com_pendencias", atualizadaEm },
        trava,
      );
    }
    if (gravou) return atualizadaEm;
    const agora = await lerGravadas(conexaoId);
    if (agora === null) trava = null;
    else if (nossos.includes(agora.atualizadaEm)) trava = agora.atualizadaEm;
    else if (agora.situacao === "com_pendencias") {
      alvo = juntarFim(antes, alvo, agora);
      trava = agora.atualizadaEm;
    } else {
      if (alvo.pendencias.length > 0) console.error("ligacoes_pendencias_sem_registro");
      return undefined;
    }
  }
  throw new Error("ligacoes_trava_disputada");
}

/**
 * O estado da ativação que parou somado ao que a conexão tem agora (as pendências que a
 * desmontagem do Desconectar ou do desativar gravou): um id de qualquer um dos dois ainda existe.
 */
function juntar(nossa: LigacoesGravadas, gravada: LigacoesGravadas): LigacoesGravadas {
  const eleven = { ...nossa.eleven };
  for (const campo of Object.keys(eleven) as (keyof LigacoesGravadas["eleven"])[]) {
    eleven[campo] = nossa.eleven[campo] ?? gravada.eleven[campo];
  }
  return {
    ...gravada,
    eleven,
    metaSip: nossa.metaSip || gravada.metaSip,
  };
}

function acessoDa(c: ConexaoServidor, chave: string | null): Acesso {
  const token = c.segredos["token"];
  return {
    chave,
    token: typeof token === "string" && token.trim() ? token : null,
    phoneId: phoneIdDa(c),
  };
}

type Desmontagem = { antes: LigacoesGravadas; fim: LigacoesGravadas };

/**
 * A desmontagem fora da ativação (desativar, Desconectar, Trocar), com a D28: marca o estado antes
 * de ler a chave e desmontar. Se a marca falhar no banco, desmonta mesmo assim, pelo estado lido
 * (o Desconectar não pode deixar a Meta ligada por isso). Quem chama grava o fim (gravarFim) com a
 * trava da marca. null = as ligações já tinham saído. Nunca lança.
 */
async function desmontarMarcando(
  conexao: ConexaoServidor,
  lida: LigacoesGravadas,
  opcoes: OpcoesLigacoes | undefined,
  limite: number | undefined,
  modo: "desativar" | "desconectar",
): Promise<Desmontagem | null> {
  let antes: LigacoesGravadas | null;
  try {
    antes = await invalidar(conexao.id, lida);
  } catch {
    console.error("ligacoes_marcar_falhou");
    antes = lida;
  }
  if (!antes) return null;
  // a chave é lida só depois da marca: o que a ativação criar daqui em diante, ela mesma desfaz
  const acesso = acessoDa(conexao, await chaveDaVoz());
  // o desativar do admin confirma o "Já apaguei" (D30); o Desconectar e o Trocar levam o token
  // embora logo depois (D34)
  const desativar = modo === "desativar";
  // a Meta e o tronco primeiro (o número para de receber ligações, mesmo se o teto acabar depois);
  // os outros agentes de voz logo depois do tronco, antes do agente dele, da ferramenta, do webhook
  // e do segredo (L26)
  let outros: OutrosAgentes = { apagados: [], ficaram: false, recusada: false };
  let fim = await desmontar(
    antes,
    { ...acesso, tokenVaiSumir: !desativar },
    opcoes,
    limite,
    desativar,
    async () => {
      outros = await apagarOutrosAgentes(antes, acesso.chave, opcoes, limite);
    },
  );
  const saiu = antes.eleven.agenteId && !fim.eleven.agenteId ? [antes.eleven.agenteId] : [];
  try {
    // as linhas ficam (a reativação recria a partir delas); só o id da ElevenLabs sai
    await zerarIdsExternos([...outros.apagados, ...saiu]);
  } catch {
    console.error("ligacoes_zerar_agentes_falhou");
  }
  const falta: PendenciaLigacoes[] = [];
  if (outros.recusada && !fim.pendencias.includes(ELEVEN_MANUAL)) falta.push(ELEVEN_MANUAL);
  else if (outros.ficaram && !fim.pendencias.includes("agente")) falta.push("agente");
  if (falta.length > 0)
    fim = { ...fim, situacao: "com_pendencias", pendencias: [...fim.pendencias, ...falta] };
  return { antes, fim };
}

/** O que saiu dos outros agentes de voz; `ficaram` = algum pode ter ficado lá (vira a pendência "agente"). */
type OutrosAgentes = { apagados: string[]; ficaram: boolean; recusada: boolean };

/**
 * Apaga na ElevenLabs os agentes de voz que não são o do tronco (os que o admin criou na área
 * Ligações): os das linhas com id_externo, menos o eleven.agenteId (que a desmontagem apaga na
 * ordem da D17). 404 conta como apagado; 401 (a chave foi revogada) também sai da linha, e o que
 * ficou lá vira "eleven_manual" (D30). Sem conseguir ler as linhas, não dá para saber se sobrou
 * algum: conta como "ficaram" (a pendência "agente"; o "Tentar de novo" relê). Nunca lança.
 */
async function apagarOutrosAgentes(
  antes: LigacoesGravadas,
  chave: string | null,
  opcoes: OpcoesLigacoes | undefined,
  limite: number | undefined,
): Promise<OutrosAgentes> {
  let ids: string[];
  try {
    ids = (await listarAgentes())
      .map((a) => a.idExterno)
      .filter((id): id is string => !!id && id !== antes.eleven.agenteId);
  } catch {
    console.error("ligacoes_ler_agentes_falhou");
    return { apagados: [], ficaram: true, recusada: false };
  }
  const r: OutrosAgentes = { apagados: [], ficaram: false, recusada: false };
  if (ids.length === 0) return r;
  if (chave === null) return { ...r, ficaram: true };
  for (const id of ids) {
    const base = opcoes?.prazoMs ?? PRAZO_MS;
    const ms = limite === undefined ? base : Math.min(base, limite - Date.now());
    if (ms <= 0) {
      r.ficaram = true;
      continue;
    }
    const fim = await apagarRecursoEleven(chave, "agente", id, { ...opcoes, prazoMs: ms });
    if (fim === "ficou") r.ficaram = true;
    else {
      r.apagados.push(id);
      if (fim === "chave_recusada") r.recusada = true;
    }
  }
  return r;
}

/**
 * A desmontagem das ligações da conexão que sai (D15: Desconectar e Trocar de WhatsApp), antes de
 * ela perder os segredos. Sem bloquear: nunca lança, e o que não sair dentro do teto fica como
 * pendência no cartão. Devolve a lista de pendências (vazia = saiu tudo, ou não havia ligações).
 */
export async function desmontarLigacoes(
  conexao: ConexaoServidor,
  opcoes?: OpcoesLigacoes & { tetoMs?: number },
): Promise<string[]> {
  const ligacoes = lerLigacoesGravadas(conexao.parametros);
  if (!ligacoes) return [];
  try {
    const limite = Date.now() + (opcoes?.tetoMs ?? TETO_DESMONTAR_LIGACOES_MS);
    const r = await desmontarMarcando(conexao, ligacoes, opcoes, limite, "desconectar");
    if (!r) return [];
    try {
      await gravarFim(conexao.id, r.antes, r.fim, r.antes.atualizadaEm);
    } catch {
      console.error("ligacoes_desmontar_gravar_falhou");
    }
    return r.fim.pendencias;
  } catch {
    console.error("ligacoes_desmontar_falhou");
    return ["erro"];
  }
}

/** O mesmo, pelo id (o Trocar de WhatsApp só tem o id da anterior). Nunca lança. */
export async function desmontarLigacoesDaConexao(
  conexaoId: string,
  opcoes?: OpcoesLigacoes & { tetoMs?: number },
): Promise<string[]> {
  let conexao: ConexaoServidor | null;
  try {
    conexao = await carregarConexao(conexaoId);
  } catch {
    console.error("ligacoes_desmontar_ler_falhou");
    return ["erro"];
  }
  return conexao ? desmontarLigacoes(conexao, opcoes) : [];
}

// ---------- funções da Configuração ----------

export async function estadoLigacoesLogica(
  ctx: ContextoUsuario,
  pedido: PedidoLigacoes,
): Promise<ResultadoLigacoes> {
  const membroId = await membroAdmin(ctx);
  if (!membroId) return msgLigacoes.semAcesso();
  return estadoAtual(pedido);
}

/**
 * A verificação (seção 21): os requisitos da Nina e, na Meta, o token, o limite, a saúde do número
 * e o SIP livre; na ElevenLabs, se a chave cria agentes. Só lê: nada é criado em lugar nenhum.
 * Sem a conexão da Meta, os itens da Meta ficam "nao_conferido"; sem a chave, o da ElevenLabs.
 */
async function conferir(
  leitura: Leitura,
  chave: string | null,
  opcoes: OpcoesLigacoes | undefined,
): Promise<Avaliacao & { numero: string | null }> {
  const requisitos = { ...leitura.requisitos, chaveVoz: leitura.requisitos.chaveVoz && !!chave };
  const conexao = leitura.meta;
  let numero: Awaited<ReturnType<typeof lerNumeroMeta>> | undefined;
  let sip: FalhaLigacoes | null | undefined;
  if (conexao) {
    const token = conexao.segredos["token"] ?? "";
    const phoneId = phoneIdDa(conexao);
    numero = await lerNumeroMeta(token, phoneId, opcoes);
    if (numero.ok) sip = await conferirSipMeta(token, phoneId, opcoes);
  }
  const agentes = chave ? await conferirAcessoAgentes(chave, opcoes) : undefined;
  const avaliacao = avaliarElegibilidade({
    requisitos,
    ...(numero !== undefined ? { numero } : {}),
    ...(sip !== undefined ? { sip } : {}),
    ...(agentes !== undefined ? { agentes } : {}),
  });
  return { ...avaliacao, numero: numero?.ok ? numero.numero : null };
}

/** Grava a verificação sem lançar (é só a memória do cartão). */
/**
 * Grava a verificação sem lançar (é só a memória do cartão), se a conexão ainda está na versão
 * lida antes de conferir (null = não leu: não grava).
 */
async function guardarElegibilidade(
  versao: VersaoConexao | null,
  conexaoId: string,
  e: Elegibilidade,
  seLigacoes?: string | null,
  seConferidaEm?: string,
): Promise<void> {
  if (!versao || versao.id !== conexaoId) return;
  try {
    await gravarElegibilidade(versao, e, seLigacoes, seConferidaEm);
  } catch {
    console.error("ligacoes_elegibilidade_gravar_falhou");
  }
}

/**
 * O "Verificar" da tela (seção 21): confere tudo, grava o resultado na conexão ativa e devolve o
 * estado com a elegibilidade. Com as ligações já ativas, ativando ou com pendências, não confere
 * nada (o SIP da Meta já é o delas) e devolve o estado como está.
 */
export async function verificarLigacoesLogica(
  ctx: ContextoUsuario,
  pedido: PedidoLigacoes,
  opcoes?: OpcoesLigacoes,
): Promise<ResultadoLigacoes> {
  const membroId = await membroAdmin(ctx);
  if (!membroId) return msgLigacoes.semAcesso();
  let leitura: Leitura;
  try {
    leitura = await ler(pedido);
  } catch {
    return msgLigacoes.erroAoLer();
  }
  if (leitura.alvo) {
    return {
      ok: true,
      estado: montarEstado(leitura.requisitos, leitura.alvo.ligacoes, leitura.elegibilidade),
    };
  }
  const chave = leitura.requisitos.chaveVoz ? await chaveDaVoz() : null;
  const { elegibilidade } = await conferir(leitura, chave, opcoes);
  if (leitura.meta) await guardarElegibilidade(leitura.versao, leitura.meta.id, elegibilidade);
  return { ok: true, estado: montarEstado(leitura.requisitos, null, elegibilidade) };
}

export async function ativarLigacoesLogica(
  ctx: ContextoUsuario,
  pedido: PedidoLigacoes,
  opcoes?: OpcoesLigacoes,
): Promise<ResultadoLigacoes> {
  const membroId = await membroAdmin(ctx);
  if (!membroId) return msgLigacoes.semAcesso();

  let leitura: Leitura;
  try {
    leitura = await ler(pedido);
  } catch {
    return msgLigacoes.erroAoLer();
  }
  // duplo clique, uma ativação parada (D20) ou uma desativação que deixou pendências: ninguém é
  // chamado
  if (leitura.alvo) {
    const l = leitura.alvo.ligacoes;
    if (abandonada(l)) return msgLigacoes.ativacaoAbandonada();
    return l.situacao === "com_pendencias" ? msgLigacoes.comPendencias() : msgLigacoes.jaAtiva();
  }
  const { requisitos } = leitura;

  // 1. a verificação (seção 21), antes de criar qualquer coisa: os requisitos da Nina; na Meta, o
  // token, o limite de 2.000, a saúde do número e nenhum outro servidor SIP (D19); na ElevenLabs,
  // a chave enxerga os agentes. Reprovada, devolve a falha do primeiro item, com a lista.
  const chave = requisitos.chaveVoz ? await chaveDaVoz() : null;
  const avaliacao = await conferir(leitura, chave, opcoes);
  const conexao = leitura.meta;
  if (conexao) await guardarElegibilidade(leitura.versao, conexao.id, avaliacao.elegibilidade);
  if (avaliacao.falha) return avaliacao.falha;
  if (!conexao || !chave || avaliacao.numero === null) return msgLigacoes.naoElegivel();
  const numeroMeta = avaliacao.numero;
  const limiteMeta = avaliacao.elegibilidade.limiteMeta;

  let vozId: string;
  try {
    const voz = (await lerConfigVozTela()).voz;
    if (!voz) return msgLigacoes.semVoz();
    vozId = voz.id;
  } catch {
    return msgLigacoes.erroAoLer();
  }
  const token = conexao.segredos["token"] ?? "";
  const phoneId = phoneIdDa(conexao);
  const origem = pedido.origem.replace(/\/+$/, "");

  // os agentes de voz: a linha do "Nina" nasce aqui (L2); numa reativação, as linhas ficam
  let atende: LinhaAgente;
  try {
    atende = await garantirAgenteQueAtende(membroId);
  } catch {
    return msgLigacoes.erroAoGravar();
  }
  let limites: Awaited<ReturnType<typeof lerLimites>>;
  let contexto: string;
  /** o criado_em da versão do Contexto que vai no prompt: o sincronizado_em do agente (L35) */
  let contextoEm: string | null;
  try {
    const [l, c] = await Promise.all([lerLimites(), lerContextoAtual()]);
    limites = l;
    contexto = c.texto;
    contextoEm = c.criadoEm;
  } catch {
    return msgLigacoes.erroAoLer();
  }

  const ligacaoToken = gerarSegredo();
  let e: LigacoesGravadas = {
    versao: 1,
    situacao: "ativando",
    origem,
    numero: numeroMeta,
    limiteMeta,
    ativadaEm: null,
    eleven: {
      segredoId: null,
      webhookId: null,
      ferramentaId: null,
      agenteId: null,
      troncoId: null,
    },
    metaSip: false,
    pendencias: [],
    atualizadaEm: carimbo(),
  };
  try {
    if (!(await iniciarLigacoes(conexao.id, e, ligacaoToken))) {
      // a trava perdeu: outra ativação começou antes, ou a conexão saiu (Desconectar, Trocar)
      const agora = await conexaoAtiva();
      return agora?.id === conexao.id ? msgLigacoes.jaAtiva() : msgLigacoes.semConexaoMeta();
    }
  } catch {
    return msgLigacoes.erroAoGravar();
  }
  /** O atualizadaEm da última gravação desta ativação (a trava do progresso, D21). */
  let gravadoEm = e.atualizadaEm;

  // a chave e o token ficam em memória: a desmontagem os usa mesmo se a conexão saiu no meio (D21)
  const acesso: Acesso = { chave, token, phoneId };
  /**
   * Falha num passo, ou a ativação perdeu a trava (D21, D28): desmonta o que saiu e devolve o
   * erro. Se a conexão ainda tem esta ativação, grava o fim por cima. Se uma desmontagem de outro
   * caminho (Desconectar, desativar) marcou ou gravou pendências, junta as duas. Se começou outra
   * ativação depois, desmonta só a ElevenLabs desta (a Meta é da nova) e não grava nada por cima.
   */
  /**
   * O que o desfazer deixou em parametros.ligacoes (gravarFim): a recusa tardia só corrige a
   * verificação guardada se a linha ainda está assim (Sol, rodada 3: senão é outra ativação).
   */
  let fimGravado: string | null | undefined;
  const desfazer = async (falha: FalhaLigacoes): Promise<FalhaLigacoes> => {
    // a última gravação desta ativação, ou a que ela mandou e voltou com erro (pode ter entrado)
    const nossos = [gravadoEm, e.atualizadaEm];
    let gravada: LigacoesGravadas | null;
    try {
      gravada = await lerGravadas(conexao.id);
    } catch {
      // sem a leitura, desmonta e grava o fim como se ainda fosse esta ativação
      gravada = { ...e, atualizadaEm: gravadoEm };
    }
    const nossa =
      gravada !== null &&
      gravada.situacao !== "com_pendencias" &&
      nossos.includes(gravada.atualizadaEm);
    if (gravada !== null && !nossa && gravada.situacao !== "com_pendencias") {
      // D28: outra ativação; a Meta pode já ser dela
      const fim = await desmontar({ ...e, metaSip: false }, acesso, opcoes);
      if (fim.pendencias.length > 0) console.error("ligacoes_ativar_pendencias_sem_registro");
      return falha;
    }
    const antes = gravada && !nossa ? juntar(e, gravada) : e;
    const fim = await desmontar(antes, acesso, opcoes);
    try {
      fimGravado = await gravarFim(conexao.id, antes, fim, gravada?.atualizadaEm ?? null, nossos);
    } catch {
      console.error("ligacoes_ativar_desfazer_gravar_falhou");
    }
    return falha;
  };
  /**
   * Grava o progresso, só se a conexão continua ativa e nesta ativação (D21). Se perdeu, ou se o
   * banco falhar, desfaz tudo. null = gravou.
   */
  const progresso = async (segredos?: { ligacaoHmac?: string }): Promise<FalhaLigacoes | null> => {
    e = { ...e, atualizadaEm: carimbo(gravadoEm) };
    let valeu: boolean;
    try {
      valeu = await gravarProgressoLigacoes(conexao.id, e, gravadoEm, segredos);
    } catch {
      return desfazer(msgLigacoes.erroAoGravar());
    }
    if (!valeu) return desfazer(msgLigacoes.ativacaoInterrompida());
    gravadoEm = e.atualizadaEm;
    return null;
  };
  /**
   * Uma recusa da Meta no ligar (138015 ou 138014, seção 21): desfaz e corrige a verificação
   * guardada, para o cartão mostrar o motivo. As outras falhas só desfazem.
   */
  const recusaDaMeta = async (falha: FalhaLigacoes): Promise<FalhaLigacoes> => {
    const fim = await desfazer(falha);
    const elegibilidade = reprovadaPelaMeta(avaliacao.elegibilidade, falha);
    if (!elegibilidade) return fim;
    // a recusa vale para o número e o token desta ativação: só grava se a conexão ainda usa os
    // mesmos (consertar o token no meio faz a recusa não valer mais)
    try {
      const agora = fimGravado === undefined ? null : await lerVersaoConexao(conexao.id);
      const atual = agora ? await carregarConexao(conexao.id) : null;
      if (atual && phoneIdDa(atual) === phoneId && (atual.segredos["token"] ?? "") === token) {
        // só por cima do que este desfazer deixou: outra ativação depois dele fica como está
        // e só por cima da verificação que esta ativação gravou: outra, depois dela, fica (Sol,
        // rodada 4)
        await guardarElegibilidade(
          agora,
          conexao.id,
          elegibilidade,
          fimGravado,
          avaliacao.elegibilidade.conferidaEm,
        );
      }
    } catch {
      console.error("ligacoes_elegibilidade_gravar_falhou");
    }
    return { ...fim, elegibilidade };
  };
  const url = (acao: "inicio" | "equipe" | "pos-chamada") => urlDaLigacao(origem, conexao.id, acao);

  // 2. Meta: liga o SIP com as chamadas desligadas (D18), antes de criar qualquer coisa na
  // ElevenLabs (o endereço SIP de lá é fixo): se a Meta recusar, nada foi criado lá. Gravado
  // antes: se o pedido cair no meio, a desmontagem desliga. Depois, lê a senha.
  e = { ...e, metaSip: true };
  let falhou = await progresso();
  if (falhou) return falhou;
  const ligou = await ligarSipMeta(token, phoneId, opcoes);
  if (!ligou.ok) {
    // recusa clara: a Meta não mudou nada, e a desmontagem não desliga o que não ligou
    if (ligou.aplicado === "nao") e = { ...e, metaSip: false };
    const { aplicado: _aplicado, ...falha } = ligou;
    return recusaDaMeta(falha);
  }
  const senha = await lerSenhaSipMeta(token, phoneId, opcoes);
  if (!senha.ok) return desfazer(senha);

  // 3. ElevenLabs: segredo, webhook pós-chamada, ferramenta e agente
  const segredo = await criarSegredo(chave, { conexaoId: conexao.id, token: ligacaoToken }, opcoes);
  if (!segredo.ok) return desfazer(segredo);
  e = { ...e, eleven: { ...e.eleven, segredoId: segredo.segredoId } };
  falhou = await progresso();
  if (falhou) return falhou;

  const webhook = await criarWebhookPosChamada(
    chave,
    { conexaoId: conexao.id, url: url("pos-chamada") },
    opcoes,
  );
  if (!webhook.ok) return desfazer(webhook);
  e = { ...e, eleven: { ...e.eleven, webhookId: webhook.webhookId } };
  if (!webhook.hmac) {
    // criou sem devolver o segredo da assinatura: o pós-chamada não teria como conferir
    falhou = await progresso();
    return falhou ?? desfazer(msgLigacoes.elevenFora());
  }
  falhou = await progresso({ ligacaoHmac: webhook.hmac });
  if (falhou) return falhou;

  const ferramenta = await criarFerramentaEquipe(
    chave,
    { urlEquipe: url("equipe"), segredoId: segredo.segredoId },
    opcoes,
  );
  if (!ferramenta.ok) return desfazer(ferramenta);
  e = { ...e, eleven: { ...e.eleven, ferramentaId: ferramenta.ferramentaId } };
  falhou = await progresso();
  if (falhou) return falhou;

  // o agente que atende, a partir da linha dele (a voz própria ou a do cartão Voz), com os limites
  // da conta e o Contexto inteiro (L2, L14 e L19)
  const recursos = {
    conexaoId: conexao.id,
    urlInicio: url("inicio"),
    segredoId: segredo.segredoId,
    webhookId: webhook.webhookId,
    ferramentaId: ferramenta.ferramentaId,
  };
  const agente = await criarAgente(
    chave,
    { agente: { ...atende, vozId: atende.vozId ?? vozId }, limites, recursos, contexto },
    opcoes,
  );
  if (!agente.ok) return desfazer(agente);
  e = { ...e, eleven: { ...e.eleven, agenteId: agente.agenteId } };
  falhou = await progresso();
  if (falhou) return falhou;

  // 4. ElevenLabs: o tronco com a senha da Meta (só em memória) e ligado ao agente
  const tronco = await criarTronco(
    chave,
    { conexaoId: conexao.id, numero: e.numero, senha: senha.senha },
    opcoes,
  );
  if (!tronco.ok) return desfazer(tronco);
  e = { ...e, eleven: { ...e.eleven, troncoId: tronco.troncoId } };
  falhou = await progresso();
  if (falhou) return falhou;
  const ligado = await ligarTroncoAoAgente(chave, tronco.troncoId, agente.agenteId, opcoes);
  if (ligado) return desfazer(ligado);
  // a saída do tronco (seção 1). Se falhar, a ativação segue: a
  // entrada não depende dela, e o primeiro "Ligar" completa
  const saidaDoTronco = await ligarSaidaDoTronco(
    chave,
    tronco.troncoId,
    { numero: e.numero, senha: senha.senha },
    opcoes,
  );
  if (saidaDoTronco) console.error("ligacoes_ativar_saida_falhou", saidaDoTronco.erro);

  // 5. Meta: as chamadas, só agora, com o tronco pronto (D18)
  const chamadas = await ligarChamadasMeta(token, phoneId, opcoes);
  if (!chamadas.ok) return recusaDaMeta(chamadas);
  // o callback de 7 dias para quem ligou (spec da saída, seção 1), à parte e sem travar a
  // ativação, mesmo se a saída do tronco falhou (quem liga ganha os 7 dias de todo jeito). A marca
  // só com os dois; sem ela, o primeiro "Ligar" refaz (Opus e Sol, PR #24)
  const callback = await ligarCallbackMeta(token, phoneId, opcoes);
  if (!callback.ok) console.error("ligacoes_ativar_callback_falhou", callback.erro);
  if (!saidaDoTronco && callback.ok) e = { ...e, saida: true };

  // 6. a chave da voz ainda é a usada (D29): trocada por uma que não lê o agente (outra conta),
  // desmonta com a chave da memória
  let guardada: string | null;
  try {
    guardada = await lerChaveDaVoz();
  } catch {
    return desfazer(msgLigacoes.erroAoLer());
  }
  if (guardada !== chave) {
    const mesmaConta =
      guardada !== null && (await chaveLeAgente(guardada, agente.agenteId, opcoes));
    if (!mesmaConta) return desfazer(msgLigacoes.chaveTrocada());
  }

  // 7. ativa
  e = { ...e, situacao: "ativa", ativadaEm: new Date().toISOString() };
  falhou = await progresso();
  if (falhou) return falhou;
  // a aprovação desta ativação é a prova mais nova: grava de novo, presa ao estado "ativa" que ela
  // acabou de gravar (a recusa tardia de outra ativação pode ter passado por cima no meio; Opus,
  // rodada 4)
  try {
    const versaoFim = await lerVersaoConexao(conexao.id);
    await guardarElegibilidade(versaoFim, conexao.id, avaliacao.elegibilidade, gravadoEm);
  } catch {
    console.error("ligacoes_elegibilidade_gravar_falhou");
  }

  // 8. as linhas dos agentes: o que atende ganha o id da ElevenLabs; os outros são criados agora
  // (sem bloquear: o que falhar fica em erro_sincronia, e o "Atualizar" da área Ligações refaz)
  await registrarAgentesDaAtivacao(
    atende,
    agente.agenteId,
    {
      chave,
      conexaoId: conexao.id,
      ligacoes: e,
      recursos,
      limites,
      contexto,
      vozPadrao: vozId,
      contextoEm,
    },
    opcoes,
  );
  return { ok: true, estado: montarEstado(requisitos, e, avaliacao.elegibilidade) };
}

/**
 * O agente que atende as ligações (L2, L3): sem nenhuma linha, nasce o "Nina" com os padrões, sem
 * voz própria (a do cartão Voz, que ele acompanha quando a voz do cartão muda, L37); com linhas e
 * nenhuma atendendo, a mais antiga passa a atender. Lança se o banco falhar.
 */
async function garantirAgenteQueAtende(membroId: string): Promise<LinhaAgente> {
  const agentes = await listarAgentes();
  const ja = agentes.find((a) => a.atende);
  if (ja) return ja;
  const primeiro = agentes[0];
  if (!primeiro) {
    return inserirAgente({ ...AGENTE_PADRAO }, { atende: true, criadoPor: membroId });
  }
  await atenderAgente(primeiro.id);
  return { ...primeiro, atende: true };
}

/**
 * O passo 8 da ativação. Nunca lança: a ativação já terminou.
 * - O agente do tronco vai para a linha que atende agora, relida (um Atender no meio, que sem as
 *   ligações ativas só muda a linha, ganha o tronco). Se é a linha de que o agente nasceu, só grava;
 *   se é outra, ou se a linha mudou desde a leitura, a sincronia leva a configuração dela ao agente
 *   do tronco (L34).
 * - Se a gravação falha, o erro fica em erro_sincronia: o "Atualizar" adota o agente do tronco.
 * - Os outros nascem agora (sem bloquear: o que falhar fica em erro_sincronia).
 * - Se as ligações saíram no meio (Desconectar, desativar), o id não fica na linha (L36).
 */
async function registrarAgentesDaAtivacao(
  atende: LinhaAgente,
  agenteId: string,
  amb: Ambiente,
  opcoes: OpcoesLigacoes | undefined,
): Promise<void> {
  let agentes: LinhaAgente[];
  try {
    agentes = await listarAgentes();
  } catch {
    console.error("ligacoes_agentes_ativacao_falhou");
    return;
  }
  const quem = agentes.find((a) => a.atende) ?? agentes.find((a) => a.id === atende.id);
  if (quem) {
    try {
      const mesma = quem.id === atende.id;
      const gravou =
        mesma &&
        (await gravarSincronia(quem.id, {
          idExterno: agenteId,
          versaoConfig: VERSAO_AGENTE,
          sincronizadoEm: amb.contextoEm,
          erroSincronia: null,
          seAtualizadoEm: quem.atualizadoEm,
        }));
      if (!gravou) {
        // outra linha atende agora, ou a linha mudou: a configuração dela vai ao agente do tronco
        await sincronizarAgente({ ...quem, idExterno: null }, amb, opcoes, {
          adotarDoTronco: true,
        });
      } else if (!(await ligacoesVigentes(amb))) {
        await gravarSincronia(quem.id, {
          idExterno: null,
          sincronizadoEm: null,
          erroSincronia: null,
          seIdExterno: agenteId,
        });
      }
    } catch {
      console.error("ligacoes_agente_tronco_falhou");
      try {
        await gravarSincronia(quem.id, { erroSincronia: msgLigacoes.erroAoGravar().mensagem });
      } catch {
        console.error("ligacoes_agente_tronco_erro_falhou");
      }
    }
  }
  // o id_externo antigo (de uma ativação anterior) já não existe lá: cada um nasce de novo
  for (const a of agentes) {
    if (a.id === quem?.id) continue;
    try {
      await sincronizarAgente({ ...a, idExterno: null }, amb, opcoes);
    } catch {
      console.error("ligacoes_agentes_ativacao_falhou");
    }
  }
}

export async function desativarLigacoesLogica(
  ctx: ContextoUsuario,
  pedido: PedidoLigacoes,
  opcoes?: OpcoesLigacoes,
): Promise<ResultadoLigacoes> {
  const membroId = await membroAdmin(ctx);
  if (!membroId) return msgLigacoes.semAcesso();

  let leitura: Leitura;
  try {
    leitura = await ler(pedido);
  } catch {
    return msgLigacoes.erroAoLer();
  }
  // nada a desativar: devolve o estado como está (o segundo clique não é erro)
  if (!leitura.alvo)
    return { ok: true, estado: montarEstado(leitura.requisitos, null, leitura.elegibilidade) };

  const { conexao, ligacoes } = leitura.alvo;
  // o desativar é o do admin: confirma as pendências manuais ("Já desliguei", "Já apaguei")
  const r = await desmontarMarcando(conexao, ligacoes, opcoes, undefined, "desativar");
  if (!r)
    return { ok: true, estado: montarEstado(leitura.requisitos, null, leitura.elegibilidade) };
  try {
    await gravarFim(conexao.id, r.antes, r.fim, r.antes.atualizadaEm);
  } catch {
    return msgLigacoes.erroAoGravar();
  }
  const { fim } = r;
  return {
    ok: true,
    estado: montarEstado(
      leitura.requisitos,
      fim.pendencias.length > 0 ? fim : null,
      leitura.elegibilidade,
    ),
  };
}
