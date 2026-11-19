// As rotas que a ElevenLabs chama durante uma ligação (2.2 e 2.4; gravando
// pelas funções do banco da tela de Ligações, 2.2):
// POST /api/public/ligacoes/<conexão>/<ação>, com ação "inicio", "equipe" ou "pos-chamada".
// O servidor nunca toca no áudio (D1): só responde a estes pedidos curtos.
// - O agente: o agent_id do pedido é o de uma linha de ligacao_agentes (id_externo) ou, das
//   ligações ativadas antes da tela, o eleven.agenteId de parametros.ligacoes.
// - início: o agente e o Contexto juntos; a ligacao_iniciar (que já aplica o limite por contato);
//   depois o lead. O Contexto vai no nina_contexto só quando o agente está atrás da versão mais
//   recente (L14): o prompt dele já tem o Contexto inteiro, então o teto estourado perde só o lead.
// - pós-chamada: a ligacao_encerrar primeiro, pelo id da conversa da ElevenLabs (a assinatura já
//   autentica): a ligação de um agente apagado, ou que termina depois da desativação, também sai de
//   "em andamento" (L38). Sem a ligação gravada (o início falhou), confere o agente e então a
//   ligacao_iniciar e de novo a ligacao_encerrar. A transcrição vai como [{papel, texto, segundos}],
//   sem as marcas de emoção.
// Respostas sempre em JSON, com Cache-Control: no-store. 404 sem detalhe (ação ou conexão
// errada, conexão sem parametros.ligacoes, de outro gateway ou sem o segredo da ação), 405 (não
// POST), 401 (autorização), 403 (recusada), 400 (corpo), 413 (corpo grande demais).
// - início: o teto de 4 s conta desde a chegada do pedido e cobre a leitura da conexão (D26, D32).
//   Sem ter autenticado até lá (a conexão demorou), 503. Depois de autenticar, nunca 4xx: a
//   ElevenLabs atende de qualquer jeito, e sem o nina_saudacao a ligação fica muda (medido na Nina
//   vitrine em 13/11/2026). Recusa vira despedida (200, com a saudação de despedida e o contexto
//   que manda encerrar). Falha do banco ou o teto estourado responde 200 com a saudação genérica,
//   contexto e lead vazios e uma sessão pelo id da conversa da ElevenLabs: o trabalho de banco
//   segue depois da resposta (lib/segundo-plano.ts) e grava a ligação, e a ferramenta da equipe
//   funciona assim que ela estiver gravada (a ferramenta acha a ligação por esse id);
// - equipe: falha do banco responde 503 (o agente avisa que não conseguiu);
// - pós-chamada: falha do banco responde 500, para a ElevenLabs reenviar (tudo é idempotente). O
//   cabeçalho da assinatura (formato e horário) é conferido antes de ler o corpo (até 8 MB). A
//   ligação que não chega a ser encerrada por aqui (o pós-chamada não veio) o worker fecha pela
//   ElevenLabs (presas.server.ts).
// Log só com códigos fixos: nada de corpo, cabeçalho, segredo, telefone nem id de conversa.
import { ELEVENLABS_API } from "@/features/servidor/ligacoes-elevenlabs";
import { emSegundoPlano } from "@/lib/segundo-plano";

import { ErroBanco } from "../nucleo/banco.server";
import { carregarConexao, lerChaveIA } from "../nucleo/conexoes.server";
import type { ConexaoServidor, Identificador } from "../nucleo/tipos";
import {
  assinaturaPosChamadaConfere,
  bearerConfere,
  cabecalhoPosChamadaPlausivel,
} from "./assinatura";
import {
  acharLigacao,
  confirmarLigacaoDeSaida,
  avisarFalhaDaLigacao,
  encerrarLigacao,
  iniciarLigacao,
  lerAgenteDaLigacao,
  lerContextoAtual,
  lerLeadDaLigacao,
  LEAD_COM_EQUIPE,
  modoDaConversa,
  passarLigacaoParaEquipe,
  rearmarDepoisDaLigacao,
  type AgenteDaLigacao,
  type FimDaLigacao,
} from "./banco.server";
import { agenteAtrasDoContexto, SAUDACAO_GENERICA, saudacaoDoAgente } from "./contexto";
import { ehObjeto, lerLigacoesGravadas } from "./gravadas";
import { falasDaLigacao, idExternoDaLigacao, motivoDoFim } from "./registro";
import { assinarSessao, ID_CONVERSA_ELEVEN, lerSessao } from "./sessao";
import {
  ACOES_LIGACAO,
  CABECALHO_SESSAO,
  FERRAMENTA_EQUIPE,
  SAUDACAO_AGENTE_PADRAO,
  SEGREDO_HMAC,
  SEGREDO_TOKEN,
  TETO_INICIO_MS,
  validadeDaSessao,
  VARIAVEL_LIGACAO,
  VARIAVEL_SESSAO,
  type AcaoLigacao,
  type LigacoesGravadas,
} from "./tipos";

/** Tetos do corpo (spec 2.4). */
export const MAX_CORPO = 16 * 1024;
/**
 * O pós-chamada de uma ligação de 30 minutos (a duração máxima) traz centenas de falas, cada uma
 * com metadados (L39): 8 MB cabe com folga, fica muito abaixo do limite de corpo da plataforma
 * (100 MB nos Workers da Cloudflare) e da memória do Worker (128 MB) mesmo com o JSON lido.
 */
export const MAX_CORPO_POS_CHAMADA = 8 * 1024 * 1024;

/**
 * A despedida da ligação recusada depois de autenticar (agente de outra conta, ligações desligadas,
 * corpo sem identidade): a ElevenLabs atende de qualquer jeito e, sem o nina_saudacao, a ligação
 * fica muda. A Nina atende, diz numa frase que continua pelo WhatsApp e encerra. O contexto vai no
 * nina_contexto, que vale no lugar do contexto da empresa. Sem nome da empresa nem da Nina: vale
 * para qualquer cópia.
 */
export const SAUDACAO_RECUSADA =
  "Oi! Agora não consigo seguir por ligação. Me escreve aqui pelo WhatsApp que eu te respondo por mensagem. Até já!";
/** O contato que passou do limite de ligações em 24 h (configuracao.ligacoes_por_contato). */
export const SAUDACAO_LIMITE =
  "Oi! Hoje a gente já se falou bastante por ligação. Vamos continuar pelo WhatsApp: é só me escrever por lá. Até já!";
export const CONTEXTO_ENCERRAR =
  "Esta ligação não continua. Você já se despediu na saudação. Não converse nem responda perguntas: se a pessoa falar, diga numa frase que vocês continuam pelo WhatsApp, por mensagem, e use end_call na mesma hora.";
/**
 * A conversa da Nina ainda desconhecida na sessão da resposta degradada (o teto estourou antes de
 * a ligação ser gravada). A ferramenta da equipe acha a ligação pelo id da conversa da ElevenLabs,
 * que vai na sessão; este campo nunca é usado para escolher a conversa.
 */
export const CONVERSA_PENDENTE = "00000000-0000-0000-0000-000000000000";

export const MENSAGEM_EQUIPE =
  "Avisei a equipe. Alguém continua com você por mensagem neste WhatsApp.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** BSUID da Meta (o formato que a Nina Subido aceita em produção). */
const BSUID = /^[A-Z]{2}\.[A-Za-z0-9.]{1,132}$/;
/** Um id de agente da ElevenLabs, antes de ir ao banco. */
const ID_AGENTE = /^[A-Za-z0-9_-]{1,128}$/;

export type OpcoesLigacao = {
  /** Relógio (ms desde 1970); sem ele, Date.now(). Os testes fixam a hora. */
  agoraMs?: number;
  /** Teto do início, desde a chegada do pedido (D26, D32); sem ele, TETO_INICIO_MS. */
  tetoInicioMs?: number;
};

type Obj = Record<string, unknown>;

function json(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

const naoEncontrado = () => json(404, { erro: "nao_encontrado" });
const naoAutorizado = () => json(401, { erro: "nao_autorizado" });
const corpoInvalido = () => json(400, { erro: "corpo_invalido" });
const ignorado = () => json(200, { ignorado: true });

/** Código curto e seguro para o log (ErroBanco já é "<operação>:<código>"). */
function codigo(erro: unknown): string {
  const msg = erro instanceof Error ? erro.message : "";
  return erro instanceof ErroBanco || /^[a-z0-9_]{1,40}(:[a-z0-9_]{1,60})?$/i.test(msg)
    ? msg
    : "erro_interno";
}

type Corpo = { ok: true; texto: string } | { ok: false; resposta: Response };

/** Lê o corpo com teto: o Content-Length declarado e o que chega de fato. */
async function lerCorpo(req: Request, max: number): Promise<Corpo> {
  const grande = (): Corpo => ({ ok: false, resposta: json(413, { erro: "corpo_grande" }) });
  const declarado = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declarado) && declarado > max) return grande();
  if (!req.body) return { ok: true, texto: "" };
  const leitor = req.body.getReader();
  const pedacos: Uint8Array[] = [];
  let tamanho = 0;
  try {
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      tamanho += value.byteLength;
      if (tamanho > max) {
        await leitor.cancel().catch(() => undefined);
        return grande();
      }
      pedacos.push(value);
    }
  } catch {
    return { ok: false, resposta: corpoInvalido() };
  }
  const bytes = new Uint8Array(tamanho);
  let pos = 0;
  for (const p of pedacos) {
    bytes.set(p, pos);
    pos += p.byteLength;
  }
  try {
    return { ok: true, texto: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, resposta: corpoInvalido() };
  }
}

function lerJson(texto: string): Obj | null {
  try {
    const v: unknown = JSON.parse(texto);
    return ehObjeto(v) ? v : null;
  } catch {
    return null;
  }
}

/** Só dígitos (8 a 15), a partir de "+55 11 91234-5678" e parecidos; null se não for telefone. */
export function telefoneDe(v: unknown): string | null {
  if (typeof v !== "string" || !/^\+?[\d\s().-]{8,30}$/.test(v.trim())) return null;
  const digitos = v.replace(/\D/g, "");
  return /^[1-9]\d{7,14}$/.test(digitos) ? digitos : null;
}

function bsuidDe(v: unknown): string | null {
  return typeof v === "string" && BSUID.test(v.trim()) ? v.trim() : null;
}

/** Os cabeçalhos SIP com o nome em minúsculas; só os valores de texto curtos. */
function cabecalhosSip(v: unknown): Map<string, string> {
  const mapa = new Map<string, string>();
  if (!ehObjeto(v)) return mapa;
  for (const [nome, valor] of Object.entries(v)) {
    if (typeof valor === "string" && valor.length <= 2048)
      mapa.set(nome.toLowerCase(), valor.trim());
  }
  return mapa;
}

function semRepetir(ids: Identificador[]): Identificador[] {
  const vistos = new Set<string>();
  return ids.filter((i) => {
    const chave = `${i.tipo}:${i.valor}`;
    if (vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  });
}

type Identidade = { ok: true; ids: Identificador[] } | { ok: false };

/**
 * Quem liga (D12): o BSUID do cabeçalho x-wa-meta-user-id e o telefone do caller_id. O
 * x-wa-meta-phone-number-id, quando vem, tem de ser o número da conexão.
 */
export function identidadeDoInicio(corpo: Obj, conexao: ConexaoServidor): Identidade {
  const sip = cabecalhosSip(corpo["sip_headers"]);
  const numero = sip.get("x-wa-meta-phone-number-id");
  if (numero !== undefined && numero !== conexao.id_externo) return { ok: false };
  const ids: Identificador[] = [];
  const bsuid = bsuidDe(sip.get("x-wa-meta-user-id"));
  if (bsuid) ids.push({ tipo: "bsuid", valor: bsuid });
  const tel = telefoneDe(corpo["caller_id"]);
  if (tel) ids.push({ tipo: "telefone", valor: tel });
  return ids.length > 0 ? { ok: true, ids } : { ok: false };
}

/** Os identificadores que o pós-chamada traz (para criar o registro que o início não criou). */
export function identidadeDoPosChamada(data: Obj): Identificador[] {
  const ids: Identificador[] = [];
  const meta = ehObjeto(data["metadata"]) ? data["metadata"] : {};
  const tel = telefoneDe(
    ehObjeto(meta["phone_call"]) ? meta["phone_call"]["external_number"] : null,
  );
  if (tel) ids.push({ tipo: "telefone", valor: tel });
  const inicio = ehObjeto(data["conversation_initiation_client_data"])
    ? data["conversation_initiation_client_data"]
    : {};
  const vars = ehObjeto(inicio["dynamic_variables"]) ? inicio["dynamic_variables"] : {};
  const chamador = vars["system__caller_id"];
  const telChamador = telefoneDe(chamador);
  if (telChamador) ids.push({ tipo: "telefone", valor: telChamador });
  const bsuid = bsuidDe(chamador);
  if (bsuid) ids.push({ tipo: "bsuid", valor: bsuid });
  return semRepetir(ids);
}

/**
 * A direção da ligação no pós-chamada (metadata.phone_call.direction da ElevenLabs: "inbound" ou
 * "outbound"); sem o campo, entrada (o único caminho desta versão).
 */
export function direcaoDaLigacao(data: Obj): "entrada" | "saida" {
  const meta = ehObjeto(data["metadata"]) ? data["metadata"] : {};
  const tel = ehObjeto(meta["phone_call"]) ? meta["phone_call"] : {};
  return tel["direction"] === "outbound" ? "saida" : "entrada";
}

/** O id da linha da ligação de saída, que o servidor manda na variável nina_ligacao ao ligar. */
export function ligacaoDaSaida(data: Obj): string | null {
  const inicio = ehObjeto(data["conversation_initiation_client_data"])
    ? data["conversation_initiation_client_data"]
    : {};
  const vars = ehObjeto(inicio["dynamic_variables"]) ? inicio["dynamic_variables"] : {};
  const v = vars[VARIAVEL_LIGACAO];
  return typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
    ? v.toLowerCase()
    : null;
}

/**
 * O id da ligação de saída pela conversa na ElevenLabs (GET da conversa: as variáveis que o
 * servidor mandou ao ligar). null = não é de saída, não deu para ler, ou a chave não está lá.
 * Nunca lança.
 */
async function ligacaoDaSaidaNaEleven(conversaEleven: string): Promise<string | null> {
  try {
    const k = await lerChaveIA("voz");
    if (!k || k.provedor !== "elevenlabs" || !k.chave.trim()) return null;
    const r = await fetch(
      `${ELEVENLABS_API}/v1/convai/conversations/${encodeURIComponent(conversaEleven)}`,
      { headers: { "xi-api-key": k.chave }, signal: AbortSignal.timeout(5_000) },
    );
    if (!r.ok) return null;
    const d: unknown = await r.json();
    return ehObjeto(d) ? ligacaoDaSaida(d) : null;
  } catch {
    return null;
  }
}

/** O transcript tem chamada da ferramenta de passar para a equipe. */
export function pediuEquipe(transcript: unknown): boolean {
  if (!Array.isArray(transcript)) return false;
  return transcript.some(
    (fala) =>
      ehObjeto(fala) &&
      Array.isArray(fala["tool_calls"]) &&
      fala["tool_calls"].some((c) => ehObjeto(c) && c["tool_name"] === FERRAMENTA_EQUIPE),
  );
}

function respostaDoInicio(saudacao: string, contexto: string, lead: string, sessao: string) {
  return {
    type: "conversation_initiation_client_data",
    dynamic_variables: {
      nina_saudacao: saudacao,
      nina_contexto: contexto,
      nina_lead: lead,
      [VARIAVEL_SESSAO]: sessao,
    },
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Um teto aberto na chegada do pedido (D32): `correr` devolve a promessa ou, passado o teto, um
 * erro com código curto (o trabalho de banco segue sozinho). Vale para todos os passos juntos.
 */
type Teto = { correr<T>(p: Promise<T>): Promise<T>; encerrar(): void };

function abrirTeto(ms: number): Teto {
  let relogio: ReturnType<typeof setTimeout> | undefined;
  const estouro = new Promise<never>((_ok, falhar) => {
    relogio = setTimeout(() => falhar(new Error("tempo_esgotado")), ms);
  });
  // ninguém esperando o estouro não é erro
  estouro.catch(() => undefined);
  return {
    correr: (p) => Promise.race([p, estouro]),
    encerrar: () => {
      if (relogio !== undefined) clearTimeout(relogio);
    },
  };
}

// ---------------------------------------------------------------------------
// Ações
// ---------------------------------------------------------------------------

function despedida(saudacao: string): Response {
  return json(200, respostaDoInicio(saudacao, CONTEXTO_ENCERRAR, "", ""));
}

/**
 * A ligação que o início recusou (a despedida: limite por contato ou da conta, agente
 * desconhecido): o nina_contexto que ela levou é o CONTEXTO_ENCERRAR. O pós-chamada dela não grava
 * nada (Opus, PR #26).
 */
export function foiDespedida(data: Obj): boolean {
  const inicio = ehObjeto(data["conversation_initiation_client_data"])
    ? data["conversation_initiation_client_data"]
    : {};
  const vars = ehObjeto(inicio["dynamic_variables"]) ? inicio["dynamic_variables"] : {};
  return vars["nina_contexto"] === CONTEXTO_ENCERRAR;
}

async function inicio(
  req: Request,
  conexao: ConexaoServidor,
  ligacoes: LigacoesGravadas,
  agoraMs: number,
  teto: Teto,
): Promise<Response> {
  const token = conexao.segredos[SEGREDO_TOKEN];
  if (!bearerConfere(req.headers.get("authorization"), token)) return naoAutorizado();
  // autenticado: daqui em diante, nunca 4xx (a ligação ficaria muda); recusa vira despedida
  let pedido: PedidoDoInicio;
  try {
    pedido = await teto.correr(lerPedidoDoInicio(req, conexao, ligacoes));
  } catch (erro) {
    console.error("ligacao_inicio", codigo(erro));
    return json(200, respostaDoInicio(SAUDACAO_GENERICA, "", "", ""));
  }
  if (!pedido.ok) {
    console.error("ligacao_inicio", pedido.motivo);
    return despedida(SAUDACAO_RECUSADA);
  }
  // o trabalho de banco segue depois da resposta, se o teto estourar (D26): a ligação fica gravada
  const trabalho = inicioNoBanco(
    pedido,
    conexao,
    ligacoes,
    agoraMs,
    token!,
    new URL(req.url).origin,
  );
  emSegundoPlano(trabalho);
  try {
    return await teto.correr(trabalho);
  } catch (erro) {
    console.error("ligacao_inicio", codigo(erro));
    // a sessão pelo id da conversa da ElevenLabs: a ferramenta da equipe acha a ligação por ele
    // assim que o trabalho de banco a gravar
    const sessao = await assinarSessao(
      token!,
      CONVERSA_PENDENTE,
      pedido.conversaEleven,
      Math.floor(agoraMs / 1000),
      validadeDaSessao(null),
    ).catch(() => "");
    return json(200, respostaDoInicio(SAUDACAO_GENERICA, "", "", sessao));
  }
}

type PedidoDoInicio =
  | { ok: true; agenteEleven: string; conversaEleven: string; ids: Identificador[] }
  | { ok: false; motivo: string };

/** O corpo do início, sem ir ao banco: o agente, a conversa da ElevenLabs e quem liga (D12). */
async function lerPedidoDoInicio(
  req: Request,
  conexao: ConexaoServidor,
  ligacoes: LigacoesGravadas,
): Promise<PedidoDoInicio> {
  const lido = await lerCorpo(req, MAX_CORPO);
  if (!lido.ok) return { ok: false, motivo: "corpo_invalido" };
  const corpo = lerJson(lido.texto);
  if (!corpo) return { ok: false, motivo: "corpo_invalido" };
  const agenteEleven = corpo["agent_id"];
  if (
    ligacoes.situacao !== "ativa" ||
    typeof agenteEleven !== "string" ||
    !ID_AGENTE.test(agenteEleven)
  ) {
    return { ok: false, motivo: "recusada" };
  }
  const conversaEleven = corpo["conversation_id"];
  if (typeof conversaEleven !== "string" || !ID_CONVERSA_ELEVEN.test(conversaEleven)) {
    return { ok: false, motivo: "corpo_invalido" };
  }
  const identidade = identidadeDoInicio(corpo, conexao);
  if (!identidade.ok) return { ok: false, motivo: "sem_identidade" };
  return { ok: true, agenteEleven, conversaEleven, ids: identidade.ids };
}

/** O início no banco: o agente e o Contexto, a ligação (com o limite por contato) e o lead. */
async function inicioNoBanco(
  pedido: Extract<PedidoDoInicio, { ok: true }>,
  conexao: ConexaoServidor,
  ligacoes: LigacoesGravadas,
  agoraMs: number,
  token: string,
  origem: string,
): Promise<Response> {
  const { agenteEleven, conversaEleven } = pedido;
  // 1. o agente e o Contexto, juntos
  const [agente, contexto] = await Promise.all([
    lerAgenteDaLigacao(agenteEleven),
    lerContextoAtual(),
  ]);
  if (!agenteDaConexao(agente, agenteEleven, ligacoes)) {
    console.error("ligacao_inicio", "agente_desconhecido");
    return despedida(SAUDACAO_RECUSADA);
  }
  // 2. a ligação, com o limite por contato e os da conta (uma transação; a recusa da conta cai na
  // despedida de sempre)
  const gravada = await iniciarLigacao({
    conexaoId: conexao.id,
    ids: pedido.ids,
    idExterno: conversaEleven,
    agenteId: agente?.id ?? null,
    momento: iso(agoraMs),
    conferirConta: true,
  });
  if (!gravada.permitida) {
    console.error("ligacao_inicio", gravada.motivo ?? "recusada");
    return despedida(gravada.motivo === "limite_por_contato" ? SAUDACAO_LIMITE : SAUDACAO_RECUSADA);
  }
  if (!gravada.conversaId) throw new ErroBanco("ligacao_inicio", "sem_conversa");
  // o worker acordado desde o começo: ele confere as presas durante a ligação (a espera na
  // motor_pendencias o mantém acordado), mesmo se o pós-chamada nunca chegar
  emSegundoPlano(acordar(origem));
  // 3. o lead e o modo da conversa: com a equipe, ninguém roda a rodada depois da ligação, então
  // a voz não promete mandar ela mesma (a equipe manda)
  const [leadLido, modo] = await Promise.all([
    lerLeadDaLigacao(gravada.conversaId, idExternoDaLigacao(conversaEleven)),
    modoDaConversa(gravada.conversaId),
  ]);
  const lead =
    modo && modo !== "nina"
      ? { ...leadLido, texto: [leadLido.texto, LEAD_COM_EQUIPE].filter(Boolean).join("\n\n") }
      : leadLido;
  // a sessão vale a ligação inteira: a duração máxima do agente mais a folga (L40)
  const sessao = await assinarSessao(
    token,
    gravada.conversaId,
    conversaEleven,
    Math.floor(agoraMs / 1000),
    validadeDaSessao(agente?.duracaoMaxS),
  );
  // o agente da primeira versão (sem linha) não tem o Contexto no prompt: ele vai sempre
  const mandarContexto = !agente || agenteAtrasDoContexto(agente.sincronizadoEm, contexto.criadoEm);
  const saudacao = saudacaoDoAgente(agente?.saudacao ?? SAUDACAO_AGENTE_PADRAO, lead.nome);
  return json(
    200,
    respostaDoInicio(saudacao, mandarContexto ? contexto.texto : "", lead.texto, sessao),
  );
}

/**
 * O agent_id é um agente desta conta: o de uma linha de ligacao_agentes, ou o eleven.agenteId de
 * parametros.ligacoes (as ligações ativadas antes da tela de Ligações).
 */
function agenteDaConexao(
  agente: AgenteDaLigacao | null,
  agenteEleven: unknown,
  ligacoes: LigacoesGravadas,
): boolean {
  if (agente) return true;
  const daAtivacao = ligacoes.eleven?.agenteId;
  return !!daAtivacao && agenteEleven === daAtivacao;
}

async function equipe(req: Request, conexao: ConexaoServidor, agoraMs: number): Promise<Response> {
  const token = conexao.segredos[SEGREDO_TOKEN];
  if (!bearerConfere(req.headers.get("authorization"), token)) return naoAutorizado();
  const lido = await lerCorpo(req, MAX_CORPO);
  if (!lido.ok) return lido.resposta;
  // a ferramenta não tem parâmetros: corpo vazio vale; o que vier tem de ser um objeto JSON
  if (lido.texto.trim() !== "" && !lerJson(lido.texto)) return corpoInvalido();
  const sessao = await lerSessao(
    token,
    req.headers.get(CABECALHO_SESSAO),
    Math.floor(agoraMs / 1000),
  );
  if (!sessao) return naoAutorizado();
  try {
    // a ligação da sessão (gravada no início, que devolveu a sessão)
    const ligacao = await acharLigacao(sessao.conversaEleven);
    if (!ligacao) throw new ErroBanco("ligacao_equipe", "sem_ligacao");
    await passarLigacaoParaEquipe(ligacao.id);
    return json(200, { ok: true, mensagem: MENSAGEM_EQUIPE });
  } catch (erro) {
    console.error("ligacao_equipe", codigo(erro));
    return json(503, { ok: false, erro: "indisponivel" });
  }
}

function numeroOuNulo(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** O momento da ligação criada no pós-chamada: o começo dela. */
function momentoDaLigacao(corpo: Obj, data: Obj, agoraMs: number): string {
  const meta = ehObjeto(data["metadata"]) ? data["metadata"] : {};
  const comeco = numeroOuNulo(meta["start_time_unix_secs"]);
  if (comeco !== null && comeco > 0) return iso(comeco * 1000);
  const evento = numeroOuNulo(corpo["event_timestamp"]);
  const duracao = numeroOuNulo(meta["call_duration_secs"]) ?? 0;
  if (evento !== null && evento > 0) return iso((evento - duracao) * 1000);
  return iso(agoraMs);
}

/** O fim: o começo mais a duração; sem o começo, a hora do evento; sem nada, agora. */
function encerradaEm(corpo: Obj, data: Obj, agoraMs: number): string {
  const meta = ehObjeto(data["metadata"]) ? data["metadata"] : {};
  const comeco = numeroOuNulo(meta["start_time_unix_secs"]);
  const duracao = numeroOuNulo(meta["call_duration_secs"]);
  if (comeco !== null && comeco > 0 && duracao !== null) return iso((comeco + duracao) * 1000);
  const evento = numeroOuNulo(corpo["event_timestamp"]);
  return iso(evento !== null && evento > 0 ? evento * 1000 : agoraMs);
}

function inteiroOuNulo(v: unknown): number | null {
  const n = numeroOuNulo(v);
  return n === null ? null : Math.round(n);
}

/** O fim da ligação no formato da ligacao_encerrar, a partir do post_call_transcription. */
export function fimDaTranscricao(corpo: Obj, data: Obj, agoraMs: number): FimDaLigacao {
  const meta = ehObjeto(data["metadata"]) ? data["metadata"] : {};
  const analise = ehObjeto(data["analysis"]) ? data["analysis"] : {};
  const resumo =
    typeof analise["transcript_summary"] === "string" ? analise["transcript_summary"].trim() : "";
  return {
    // done com 0 s não aconteceu (as presas tratam igual): sem aviso de concluída nem rodada depois
    status:
      data["status"] === "failed" || inteiroOuNulo(meta["call_duration_secs"]) === 0
        ? "nao_completada"
        : "concluida",
    encerradaEm: encerradaEm(corpo, data, agoraMs),
    duracaoS: inteiroOuNulo(meta["call_duration_secs"]),
    motivoFim: motivoDoFim(meta["termination_reason"]),
    resumo: resumo || null,
    transcricao: falasDaLigacao(data["transcript"]),
    custoCreditos: inteiroOuNulo(meta["cost"]),
  };
}

async function posTranscricao(
  conexao: ConexaoServidor,
  ligacoes: LigacoesGravadas,
  corpo: Obj,
  data: Obj,
  agoraMs: number,
  origem: string,
): Promise<Response> {
  const conversaEleven = data["conversation_id"];
  if (typeof conversaEleven !== "string" || !ID_CONVERSA_ELEVEN.test(conversaEleven)) {
    return corpoInvalido();
  }
  const fim = fimDaTranscricao(corpo, data, agoraMs);
  const pediu = pediuEquipe(data["transcript"]);
  // a passagem para a equipe antes do fechamento (D24, uma vez só por ligação): fechada, a
  // ligação solta a conversa, e o worker em cadeia poderia rodar a rodada depois da ligação antes
  // de um reenvio que passasse para a equipe
  let existente = await acharLigacao(conversaEleven);
  // a ligação de saída cujo pós-chamada chegou antes da confirmação (// seção 4): o id da linha volta nas variáveis que o servidor mandou ao ligar
  const daSaida = direcaoDaLigacao(data) === "saida" ? ligacaoDaSaida(data) : null;
  if (!existente && daSaida && (await confirmarLigacaoDeSaida(daSaida, conversaEleven))) {
    existente = await acharLigacao(conversaEleven);
  }
  if (existente && pediu) await passarLigacaoParaEquipe(existente.id);
  // a ligação gravada sai de "em andamento" mesmo se o agente já foi apagado ou as ligações
  // foram desativadas (L38): o id da conversa da ElevenLabs a acha, e a assinatura autentica
  let gravada = existente ? await encerrarLigacao(conversaEleven, fim) : null;
  if (!gravada) {
    // o início falhou (ou não chegou): cria a ligação, só se o agente é desta conta e se ela é de
    // entrada (a ligação que a Nina fizer, quando vier, terá o próprio caminho: aqui ela viraria um
    // contato errado, com quem atendeu no lugar de quem ligou)
    if (direcaoDaLigacao(data) === "saida") return ignorado();
    // a que o início recusou e se despediu (os limites da conta, o por contato): não vira histórico
    // nem arma a Nina depois (Opus, PR #26)
    if (foiDespedida(data)) return ignorado();
    const agenteEleven = data["agent_id"];
    if (typeof agenteEleven !== "string" || !ID_AGENTE.test(agenteEleven)) return ignorado();
    const agente = await lerAgenteDaLigacao(agenteEleven);
    if (!agenteDaConexao(agente, agenteEleven, ligacoes)) return ignorado();
    // com quem a ElevenLabs diz que ligou
    const ids = identidadeDoPosChamada(data);
    if (ids.length === 0) return ignorado();
    const inicio = await iniciarLigacao({
      conexaoId: conexao.id,
      ids,
      idExterno: conversaEleven,
      agenteId: agente?.id ?? null,
      momento: momentoDaLigacao(corpo, data, agoraMs),
    });
    if (!inicio.permitida) {
      // o limite por contato: a ligação não fica no histórico (o início também teria recusado)
      console.error("ligacao_pos_chamada", "limite_por_contato");
      return ignorado();
    }
    if (pediu && inicio.ligacaoId) await passarLigacaoParaEquipe(inicio.ligacaoId);
    gravada = await encerrarLigacao(conversaEleven, fim);
    if (!gravada) throw new ErroBanco("ligacao_pos_chamada", "sem_ligacao");
  }
  // a que não completou vira mensagem no chat (o banco decide se ainda serve); a concluída solta a
  // rodada que esperava a ligação (uma Nina por vez): ela manda o que a voz combinou por escrito
  if (fim.status === "nao_completada") await avisarEAcordar(gravada, origem);
  else {
    // o rearme que falha no banco: 500, para o reenvio repetir (o fechamento é idempotente)
    if ((await rearmarDepoisDaLigacao(gravada.ligacaoId)) === "erro") {
      throw new ErroBanco("ligacao_rearmar", "falhou");
    }
    await acordar(origem);
  }
  return json(200, { ok: true });
}

/**
 * Pede uma passada do worker, com renovar: a conversa que esperava a ligação ficou armada desde o
 * começo dela e pode parecer um item preso (vencido há mais de 10 min) para a chamada em curso,
 * que então não a pegaria nem pediria a próxima. Nunca lança.
 */
async function acordar(origem: string): Promise<void> {
  const { acordarMotor } = await import("../nucleo/motor.server");
  await acordarMotor(origem, { renovar: true }).catch(() => undefined);
}

/**
 * O aviso da falha no chat e, se ele ficou na fila, o toque no worker que o manda. O aviso que
 * falhou no banco lança: o pós-chamada responde 500 e a ElevenLabs reenvia (o fim é idempotente,
 * e o banco avisa uma vez só por ligação).
 */
async function avisarEAcordar(
  gravada: { ligacaoId: string; conversaId: string },
  origem: string,
): Promise<void> {
  const r = await avisarFalhaDaLigacao(gravada.ligacaoId, gravada.conversaId);
  if (r === "erro") throw new ErroBanco("ligacao_aviso", "falhou");
  if (r === "avisada") await acordar(origem);
}

async function falhaNoInicio(
  data: Obj,
  corpo: Obj,
  agoraMs: number,
  origem: string,
): Promise<Response> {
  const conversaEleven = data["conversation_id"];
  if (typeof conversaEleven !== "string" || !ID_CONVERSA_ELEVEN.test(conversaEleven)) {
    return corpoInvalido();
  }
  // só marca a ligação que já existe; uma concluída continua concluída (o banco cuida)
  const fim: FimDaLigacao = {
    status: "nao_completada",
    encerradaEm: encerradaEm(corpo, data, agoraMs),
    duracaoS: null,
    motivoFim: "nao_atendida",
    resumo: null,
    transcricao: [],
    custoCreditos: null,
  };
  const gravada = await encerrarLigacao(conversaEleven, fim);
  if (!gravada) {
    // a ligação de saída ainda com o id provisório (a ElevenLabs não confirmou a tempo, e o lead
    // não atendeu): confirma pela nina_ligacao, do corpo ou da conversa na ElevenLabs, e fecha
    // (Opus, PR #24). A de saída não ganha o aviso de falha (o banco só avisa a de entrada)
    const lig = ligacaoDaSaida(data) ?? (await ligacaoDaSaidaNaEleven(conversaEleven));
    if (!lig || !(await confirmarLigacaoDeSaida(lig, conversaEleven))) return ignorado();
    if (!(await encerrarLigacao(conversaEleven, fim))) return ignorado();
    await acordar(origem);
    return json(200, { ok: true });
  }
  // a pessoa ligou e não foi atendida: a mensagem no chat pede para ligar de novo
  await avisarEAcordar(gravada, origem);
  return json(200, { ok: true });
}

async function posChamada(
  req: Request,
  conexao: ConexaoServidor,
  ligacoes: LigacoesGravadas,
  agoraMs: number,
): Promise<Response> {
  // o formato e o horário da assinatura antes de ler o corpo (até 8 MB)
  const assinatura = req.headers.get("elevenlabs-signature");
  if (!cabecalhoPosChamadaPlausivel(assinatura, Math.floor(agoraMs / 1000))) return naoAutorizado();
  const lido = await lerCorpo(req, MAX_CORPO_POS_CHAMADA);
  if (!lido.ok) return lido.resposta;
  const confere = await assinaturaPosChamadaConfere(
    assinatura,
    lido.texto,
    conexao.segredos[SEGREDO_HMAC],
    Math.floor(agoraMs / 1000),
  );
  if (!confere) return naoAutorizado();
  const corpo = lerJson(lido.texto);
  if (!corpo || !ehObjeto(corpo["data"])) return corpoInvalido();
  const data = corpo["data"];
  const origem = new URL(req.url).origin;
  try {
    if (corpo["type"] !== "post_call_transcription" && corpo["type"] !== "call_initiation_failure")
      return ignorado();
    if (corpo["type"] === "post_call_transcription") {
      return await posTranscricao(conexao, ligacoes, corpo, data, agoraMs, origem);
    }
    // só marca a ligação que já existe (pelo id da conversa): não precisa conferir o agente
    return await falhaNoInicio(data, corpo, agoraMs, origem);
  } catch (erro) {
    console.error("ligacao_pos_chamada", codigo(erro));
    return json(500, { erro: "erro" });
  }
}

/** Ponto de entrada da rota src/routes/api/public/ligacoes/$conexao/$acao.ts. */
export async function processarLigacao(
  req: Request,
  conexaoId: string,
  acao: string,
  opcoes: OpcoesLigacao = {},
): Promise<Response> {
  if (!(ACOES_LIGACAO as readonly string[]).includes(acao) || !UUID.test(conexaoId)) {
    return naoEncontrado();
  }
  if (req.method !== "POST") return json(405, { erro: "metodo_nao_permitido" });

  // o teto do início conta desde a chegada (D32): a leitura da conexão entra nele
  const teto = acao === "inicio" ? abrirTeto(opcoes.tetoInicioMs ?? TETO_INICIO_MS) : null;
  try {
    return await processarAcao(req, conexaoId, acao as AcaoLigacao, opcoes, teto);
  } finally {
    teto?.encerrar();
  }
}

async function processarAcao(
  req: Request,
  conexaoId: string,
  acao: AcaoLigacao,
  opcoes: OpcoesLigacao,
  teto: Teto | null,
): Promise<Response> {
  let conexao: ConexaoServidor | null;
  try {
    const lendo = carregarConexao(conexaoId);
    conexao = await (teto ? teto.correr(lendo) : lendo);
  } catch (erro) {
    // sem a conexão não há como autenticar: a ElevenLabs recebe 503, não a saudação (D32)
    console.error("ligacao_conexao", codigo(erro));
    return json(503, { erro: "indisponivel" });
  }
  // parametros.ligacoes, lido pela mesma função da Configuração
  const ligacoes = conexao?.gateway === "meta" ? lerLigacoesGravadas(conexao.parametros) : null;
  if (!conexao || !ligacoes) return naoEncontrado();
  // sem o segredo da ação (a conexão desativada perde os segredos): nem confere
  const segredo = acao === "pos-chamada" ? SEGREDO_HMAC : SEGREDO_TOKEN;
  if (!(conexao.segredos[segredo] ?? "").trim()) return naoEncontrado();

  const agoraMs = opcoes.agoraMs ?? Date.now();
  switch (acao) {
    case "inicio":
      // o teto sempre existe no início (aberto em processarLigacao)
      return inicio(req, conexao, ligacoes, agoraMs, teto!);
    case "equipe":
      return equipe(req, conexao, agoraMs);
    case "pos-chamada":
      return posChamada(req, conexao, ligacoes, agoraMs);
  }
}
