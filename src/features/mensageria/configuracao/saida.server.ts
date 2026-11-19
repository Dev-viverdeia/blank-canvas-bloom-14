// A Nina liga para o lead pelo WhatsApp (seções 3 e 4): o estado da
// permissão, o pedido de permissão e a ligação. Para qualquer membro ativo que vê a conversa (a
// leitura dela passa pela RLS do usuário). Ligar e pedir não tiram a conversa de ninguém.
//
// - permissaoDeLigar: só lê. Com um pedido de menos de 24 h sem resposta, responde pelo banco (a
//   tela consulta de 10 em 10 s enquanto espera o lead); senão, consulta a Meta.
// - pedirPermissaoDeLigar: só dentro da janela de 24 h e com o pedido liberado pela Meta; manda a
//   mensagem interativa e grava o pedido em ligacao_permissoes.
// - ligarParaLead: com a permissão da Meta, completa a saída do tronco se faltar (quem ativou antes
//   dela), registra a ligação (ligacao_iniciar_saida), manda a ElevenLabs ligar com todas as
//   variáveis (ela não chama o webhook de início na saída) e confirma o id da conversa dela.
//
// A chave da ElevenLabs, o token da Meta, o ligacaoToken e a senha SIP nunca voltam no resultado
// nem vão ao log: o log só leva códigos.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { PRAZO_MS, type Fetch } from "@/features/servidor/http";
import { ligarPeloTronco, ligarSaidaDoTronco } from "@/features/servidor/ligacoes-elevenlabs";
import {
  consultarPermissaoMeta,
  lerSenhaSipMeta,
  ligarCallbackMeta,
  pedirPermissaoMeta,
  type PermissaoMeta,
} from "@/features/servidor/ligacoes-meta";
import { emSegundoPlano } from "@/lib/segundo-plano";

import type { ContextoUsuario } from "../configuracao.server";
import {
  lerAgente as lerAgenteLinha,
  listarAgentes,
  type LinhaAgente,
} from "../ligacoes/agentes-banco.server";
import {
  confirmarLigacaoDeSaida,
  encerrarLigacao,
  LEAD_COM_EQUIPE,
  lerAgenteDaLigacao,
  lerContextoAtual,
  type AgenteDaLigacao,
  lerLeadDaLigacao,
  modoDaConversa,
} from "../ligacoes/banco.server";
import { agenteAtrasDoContexto, saudacaoDoAgente } from "../ligacoes/contexto";
import { lerLigacoesGravadas } from "../ligacoes/gravadas";
import { idExternoDaLigacao } from "../ligacoes/registro";
import { assinarSessao } from "../ligacoes/sessao";
import {
  DURACAO_MAX_AGENTE_S,
  MAX_OBJETIVO_LIGACAO,
  SEGREDO_TOKEN,
  VARIAVEL_LIGACAO,
  VARIAVEL_SESSAO,
  validadeDaSessao,
  type AgenteIndisponivel,
  type AgenteParaLigar,
  type EstadoPermissaoDeLigar,
  type FalhaLigarSaida,
  type ErroLigarSaida,
  type LigacoesGravadas,
  type MotivoNaoLiga,
  type PedidoDePermissao,
  type ResultadoAgentesParaLigar,
  type ResultadoLigarParaLead,
  type ResultadoPedirPermissao,
  type ResultadoPermissaoDeLigar,
} from "../ligacoes/tipos";
import { conexaoAtiva, lerChaveIA } from "../nucleo/conexoes.server";
import type { ConexaoServidor } from "../nucleo/tipos";
import { gravarLigacoes } from "./ligacoes-banco.server";

export type PedidoSaida = { conversaId: string; origem: string };
/** O pedido de ligar: o agente escolhido e o objetivo . */
export type PedidoLigarSaida = PedidoSaida & { agenteId?: string; objetivo?: string };
export type OpcoesSaida = { fetch?: Fetch; prazoMs?: number; agoraMs?: number };

/** A folga depois da duração máxima do agente (a mesma do ligacao_teto, base 0031). */
const FOLGA_TETO_MS = 2 * 60 * 1000;

/** A duração máxima (s) dos agentes destas ligações. Lança se o banco falhar. */
async function tetosDosAgentes(ligs: { agente_id: string | null }[]): Promise<Map<string, number>> {
  const ids = [...new Set(ligs.map((l) => l.agente_id).filter((x): x is string => !!x))];
  if (ids.length === 0) return new Map();
  const { data, error } = await supabaseAdmin
    .from("ligacao_agentes")
    .select("id, duracao_max_s")
    .in("id", ids);
  if (error) throw new Error("banco_ler_agentes");
  return new Map(
    ((data ?? []) as { id: string; duracao_max_s: number | null }[])
      .filter((a) => typeof a.duracao_max_s === "number" && a.duracao_max_s > 0)
      .map((a) => [a.id, a.duracao_max_s as number]),
  );
}

/** A janela de 24 h da Meta para mensagens livres (e para o pedido de permissão interativo). */
const JANELA_MS = 24 * 60 * 60 * 1000;
/** Um pedido sem resposta conta como pendente por 24 h (depois, a Meta é consultada de novo). */
const PEDIDO_PENDENTE_MS = 24 * 60 * 60 * 1000;

/** O texto do pedido de permissão (white label: sem nome de empresa nem de produto). */
export const TEXTO_PEDIDO_PERMISSAO =
  "Podemos te ligar por aqui, pelo WhatsApp? Se puder, toque em permitir.";
/** A saudação da ligação feita pela empresa ({nome} vira o primeiro nome do lead). */
export const SAUDACAO_SAIDA = "Oi, {nome}! Aqui é a Nina, te ligando pelo WhatsApp. Tudo bem?";
/** A linha que o bloco do lead ganha na ligação de saída. */
export const LEAD_SAIDA =
  "Esta ligação foi feita pela empresa: a equipe pediu para a Nina ligar para o lead. Comece dizendo por que está ligando, com base na conversa, e confira se é uma boa hora.";

function falha(erro: ErroLigarSaida, mensagem: string): FalhaLigarSaida {
  return { ok: false, erro, mensagem };
}

export const msgSaida = {
  semAcesso: () => falha("sem_acesso", "Você não tem acesso a esta conversa."),
  conversaNaoEncontrada: () => falha("conversa_nao_encontrada", "Não achamos esta conversa."),
  semLigacoes: () =>
    falha(
      "sem_ligacoes",
      "As ligações pelo WhatsApp não estão ativas. Um admin ativa no cartão Ligações, na Configuração.",
    ),
  semTelefone: () =>
    falha("sem_telefone", "Este contato não tem um número de telefone para a Nina ligar."),
  semPermissao: () =>
    falha(
      "sem_permissao",
      "O lead ainda não deu permissão para a empresa ligar. Peça a permissão primeiro.",
    ),
  foraDaJanela: () =>
    falha(
      "fora_da_janela",
      "O lead não mandou mensagem nas últimas 24 horas. Por enquanto, a permissão para ligar só pode ser pedida dentro desse prazo.",
    ),
  limiteDePedidos: () =>
    falha(
      "limite_de_pedidos",
      "A Meta só deixa pedir a permissão 1 vez por dia e 2 vezes por semana para cada lead. Tente de novo mais tarde.",
    ),
  emAndamento: () =>
    falha("ligacao_em_andamento", "Já há uma ligação em andamento nesta conversa."),
  limitePorContato: () =>
    falha(
      "limite_por_contato",
      "Este contato já chegou ao limite de ligações das últimas 24 horas (Ajustes das ligações).",
    ),
  erroAoLer: () =>
    falha("erro_ao_ler", "Não conseguimos ler as ligações agora. Tente de novo em instantes."),
  talvezTenhaSaido: () =>
    falha(
      "tempo_esgotado",
      "A ElevenLabs não confirmou a ligação a tempo, e ela pode ter saído. Espere o fim dela (ou alguns minutos) antes de tentar de novo.",
    ),
  erroAoGravar: () =>
    falha("erro_ao_gravar", "Não conseguimos gravar a ligação agora. Tente de novo em instantes."),
  agenteNaoExiste: () =>
    falha("agente_indisponivel", "Este agente não existe mais. Escolha outro agente para ligar."),
  agenteNaoPronto: () =>
    falha(
      "agente_indisponivel",
      "Este agente ainda não está pronto na ElevenLabs. Um admin atualiza em Ligações → Agentes; enquanto isso, escolha outro.",
    ),
  limiteSimultaneas: () =>
    falha(
      "limite_da_conta",
      "A conta já está no limite de ligações ao mesmo tempo (Ajustes das ligações). Tente quando uma terminar.",
    ),
  limitePorDia: () =>
    falha(
      "limite_da_conta",
      "A conta já chegou ao limite de ligações de hoje (Ajustes das ligações).",
    ),
  objetivoGrande: () =>
    falha(
      "objetivo_invalido",
      `O objetivo da ligação pode ter até ${MAX_OBJETIVO_LIGACAO} caracteres.`,
    ),
};

/** A linha que o bloco do lead ganha com o objetivo da ligação (A3 de spec-ligar-com-agente). */
export function linhaDoObjetivo(objetivo: string): string {
  return `Objetivo desta ligação, definido pela equipe: ${objetivo}`;
}

/** O objetivo do pedido: sem espaços nas pontas; vazio = sem objetivo; grande demais = falha. */
export function lerObjetivo(
  bruto: string | undefined,
): { ok: true; objetivo: string | null } | FalhaLigarSaida {
  const t = (bruto ?? "").trim();
  if (t === "") return { ok: true, objetivo: null };
  if (t.length > MAX_OBJETIVO_LIGACAO) return msgSaida.objetivoGrande();
  return { ok: true, objetivo: t };
}

/**
 * Pronto para ligar: com o agente na ElevenLabs (A2). A última sincronia em erro não impede: o
 * agente lá liga com a configuração anterior (revisão do Opus no PR #26).
 */
function indisponivelDe(a: Pick<LinhaAgente, "idExterno">): AgenteIndisponivel | null {
  return a.idExterno ? null : "nao_sincronizado";
}

/**
 * Os agentes da janela do "Ligar" (A2): os Ativos primeiro, depois por nome. Para qualquer membro
 * ativo; só os campos que a janela mostra.
 */
export async function agentesParaLigarLogica(
  ctx: ContextoUsuario,
): Promise<ResultadoAgentesParaLigar> {
  try {
    if (!(await membroAtivo(ctx))) return msgSaida.semAcesso();
    const linhas = await listarAgentes();
    const agentes: AgenteParaLigar[] = linhas.map((a) => ({
      id: a.id,
      nome: a.nome,
      uso: a.uso,
      objetivo: a.objetivo,
      atende: a.atende,
      indisponivel: indisponivelDe(a),
      desatualizado: a.idExterno !== null && a.erroSincronia !== null,
    }));
    agentes.sort(
      (x, y) =>
        Number(x.uso !== "ligar") - Number(y.uso !== "ligar") ||
        x.nome.localeCompare(y.nome, "pt-BR"),
    );
    return { ok: true, agentes };
  } catch {
    return msgSaida.erroAoLer();
  }
}

// ---------- leitura ----------

/** id do membro ativo do usuário; null = sem acesso. */
async function membroAtivo(ctx: ContextoUsuario): Promise<string | null> {
  const membro = await ctx.supabase
    .from("membros")
    .select("id")
    .eq("user_id", ctx.userId)
    .eq("ativo", true)
    .maybeSingle();
  if (membro.error || !membro.data) return null;
  return membro.data.id;
}

type Base = {
  membroId: string;
  conversa: { id: string; contatoId: string; ultimaDoLeadEm: string | null };
  conexao: ConexaoServidor | null;
  ligacoes: LigacoesGravadas | null;
  telefone: string | null;
  emAndamento: boolean;
  /** O início da ligação mais recente da conversa (qualquer direção e status). */
  ultimaLigacaoEm: string | null;
  pedido: (PedidoDePermissao & { id: string }) | null;
};

/** O que as três funções leem. Uma falha, ou lança se o banco falhar. */
async function lerBase(
  ctx: ContextoUsuario,
  conversaId: string,
  agoraMs: number,
): Promise<Base | FalhaLigarSaida> {
  const membroId = await membroAtivo(ctx);
  if (!membroId) return msgSaida.semAcesso();
  // a conversa pela RLS do usuário: quem não a vê não liga para ela
  const visivel = await ctx.supabase
    .from("conversas")
    .select("id, contato_id, ultima_do_lead_em")
    .eq("id", conversaId)
    .maybeSingle();
  if (visivel.error) throw new Error("banco_ler_conversa");
  if (!visivel.data) return msgSaida.conversaNaoEncontrada();
  const conversa = {
    id: visivel.data.id,
    contatoId: visivel.data.contato_id,
    ultimaDoLeadEm: visivel.data.ultima_do_lead_em,
  };

  const [conexao, tel, lig, ped] = await Promise.all([
    conexaoAtiva(),
    supabaseAdmin
      .from("contato_identificadores")
      .select("valor")
      .eq("contato_id", conversa.contatoId)
      .eq("tipo", "telefone")
      .limit(1),
    supabaseAdmin
      .from("ligacoes")
      .select("status, iniciada_em, agente_id")
      .eq("conversa_id", conversa.id)
      .order("iniciada_em", { ascending: false })
      .limit(20),
    supabaseAdmin
      .from("ligacao_permissoes")
      .select("id, pedido_em, resposta, permanente, respondido_em")
      .eq("conversa_id", conversa.id)
      .order("pedido_em", { ascending: false })
      .limit(1),
  ]);
  if (tel.error || lig.error || ped.error) throw new Error("banco_ler_saida");
  const meta = conexao && conexao.gateway === "meta" ? conexao : null;
  const ligacoes = meta ? lerLigacoesGravadas(meta.parametros) : null;
  const telefone = (tel.data?.[0]?.valor ?? "").replace(/\D/g, "") || null;
  const ligs = lig.data ?? [];
  // em andamento até o teto do agente (a duração máxima dele mais 2 min), o mesmo do banco
  // (ligacao_teto, que o ligacao_iniciar_saida usa): passado o teto, a chamada já acabou, mesmo
  // que as presas ainda não a tenham fechado (numa conversa com a equipe, o worker pode só passar
  // no relógio de hora em hora; Sol, PR #24)
  const abertas = ligs.filter((l) => l.status === "em_andamento");
  const tetos = abertas.length > 0 ? await tetosDosAgentes(abertas) : new Map<string, number>();
  const emAndamento = abertas.some((l) => {
    const teto = (tetos.get(l.agente_id ?? "") ?? DURACAO_MAX_AGENTE_S) * 1000 + FOLGA_TETO_MS;
    return agoraMs - Date.parse(l.iniciada_em) <= teto;
  });
  const ultimaLigacaoEm = ligs[0]?.iniciada_em ?? null;
  const p = ped.data?.[0];
  const pedido: Base["pedido"] = p
    ? {
        id: p.id,
        pedidoEm: p.pedido_em,
        resposta:
          p.resposta === "aceitou" || p.resposta === "recusou"
            ? (p.resposta as "aceitou" | "recusou")
            : null,
        permanente: p.permanente,
        respondidoEm: p.respondido_em,
      }
    : null;
  return {
    membroId,
    conversa,
    conexao: meta,
    ligacoes,
    telefone,
    emAndamento,
    ultimaLigacaoEm,
    pedido,
  };
}

function dentroDaJanela(ultimaDoLeadEm: string | null, agoraMs: number): boolean {
  const t = ultimaDoLeadEm ? Date.parse(ultimaDoLeadEm) : NaN;
  return Number.isFinite(t) && agoraMs - t < JANELA_MS;
}

/**
 * O pedido sem resposta de menos de 24 h, que responde pelo banco. Uma ligação depois do pedido
 * (o lead ligou em vez de tocar no aceite: a Meta dá a permissão automática, que não cita o
 * pedido) faz consultar a Meta de novo (Sol, PR #24).
 */
function pedidoPendente(b: Pick<Base, "pedido" | "ultimaLigacaoEm">, agoraMs: number): boolean {
  const p = b.pedido;
  if (!p || p.resposta !== null || agoraMs - Date.parse(p.pedidoEm) >= PEDIDO_PENDENTE_MS) {
    return false;
  }
  return !(b.ultimaLigacaoEm && Date.parse(b.ultimaLigacaoEm) > Date.parse(p.pedidoEm));
}

function semPedido(b: Base, motivo: MotivoNaoLiga, agoraMs: number): EstadoPermissaoDeLigar {
  return {
    permissao: "nenhuma",
    expiraEm: null,
    podeLigar: false,
    podePedir: false,
    dentroDaJanela: dentroDaJanela(b.conversa.ultimaDoLeadEm, agoraMs),
    motivo,
    pedido: b.pedido ? semId(b.pedido) : null,
    pedirDeNovoEm: null,
  };
}

function semId(p: PedidoDePermissao & { id: string }): PedidoDePermissao {
  const { id: _id, ...resto } = p;
  return resto;
}

/** Quando dá para pedir de novo, pela regra da Meta (1 a cada 24 h), se ela não disse. */
function pedirDeNovoPelaRegra(p: Base["pedido"]): string | null {
  if (!p) return null;
  const t = Date.parse(p.pedidoEm);
  return Number.isFinite(t) ? new Date(t + JANELA_MS).toISOString() : null;
}

/** O estado do botão a partir da consulta à Meta. Pura. */
export function estadoDaPermissao(
  b: Pick<Base, "conversa" | "pedido">,
  m: PermissaoMeta,
  agoraMs: number,
): EstadoPermissaoDeLigar {
  const janela = dentroDaJanela(b.conversa.ultimaDoLeadEm, agoraMs);
  const permissao =
    m.status === "permanent" ? "permanente" : m.status === "temporary" ? "temporaria" : "nenhuma";
  const podeLigar = permissao !== "nenhuma" && m.ligar.pode;
  const podePedir = permissao === "nenhuma" && janela && m.pedir.pode;
  let motivo: MotivoNaoLiga | null = null;
  if (!podeLigar) {
    if (permissao !== "nenhuma") motivo = "meta_nao_deixa";
    else if (b.pedido?.resposta === "recusou" && !m.pedir.pode) motivo = "recusou";
    else if (!janela) motivo = "fora_da_janela";
    else if (!m.pedir.pode) motivo = "limite_de_pedidos";
    else motivo = "pedir";
  }
  const pedirDeNovoEm =
    motivo === "recusou" || motivo === "limite_de_pedidos"
      ? (m.pedir.liberaEm ?? pedirDeNovoPelaRegra(b.pedido ?? null))
      : null;
  return {
    permissao,
    expiraEm: permissao === "temporaria" ? m.expiraEm : null,
    podeLigar,
    podePedir,
    dentroDaJanela: janela,
    motivo,
    pedido: b.pedido ? semId(b.pedido as PedidoDePermissao & { id: string }) : null,
    pedirDeNovoEm,
  };
}

function tokenEPhone(c: ConexaoServidor): { token: string; phoneId: string } {
  const v = c.parametros["phoneId"];
  return {
    token: c.segredos["token"] ?? "",
    phoneId: typeof v === "string" && v.trim() ? v.trim() : c.id_externo,
  };
}

function opcoesHttp(o: OpcoesSaida | undefined) {
  return { ...(o?.fetch ? { fetch: o.fetch } : {}), prazoMs: o?.prazoMs ?? PRAZO_MS };
}

/** O que impede antes de ir à Meta (null = nada). */
function travaLocal(b: Base, agoraMs: number): EstadoPermissaoDeLigar | null {
  if (!b.conexao || b.ligacoes?.situacao !== "ativa") return semPedido(b, "sem_ligacoes", agoraMs);
  if (!b.telefone) return semPedido(b, "sem_telefone", agoraMs);
  if (b.emAndamento) return semPedido(b, "ligacao_em_andamento", agoraMs);
  if (pedidoPendente(b, agoraMs)) return semPedido(b, "aguardando_lead", agoraMs);
  return null;
}

async function consultar(
  b: Base,
  opcoes: OpcoesSaida | undefined,
): Promise<({ ok: true } & PermissaoMeta) | FalhaLigarSaida> {
  const { token, phoneId } = tokenEPhone(b.conexao!);
  const r = await consultarPermissaoMeta(token, phoneId, b.telefone!, opcoesHttp(opcoes));
  if (r.ok) return r;
  return falha(
    r.erro === "meta_token_invalido"
      ? "meta_token_invalido"
      : r.erro === "tempo_esgotado"
        ? "tempo_esgotado"
        : "provedor_fora",
    r.mensagem,
  );
}

// ---------- as três funções ----------

export async function permissaoDeLigarLogica(
  ctx: ContextoUsuario,
  pedido: PedidoSaida,
  opcoes?: OpcoesSaida,
): Promise<ResultadoPermissaoDeLigar> {
  const agoraMs = opcoes?.agoraMs ?? Date.now();
  let b: Base | FalhaLigarSaida;
  try {
    b = await lerBase(ctx, pedido.conversaId, agoraMs);
  } catch {
    return msgSaida.erroAoLer();
  }
  if ("ok" in b) return b;
  const local = travaLocal(b, agoraMs);
  if (local) return { ok: true, estado: local };
  const m = await consultar(b, opcoes);
  if (!m.ok) return m;
  return { ok: true, estado: estadoDaPermissao(b, m, agoraMs) };
}

export async function pedirPermissaoDeLigarLogica(
  ctx: ContextoUsuario,
  pedido: PedidoSaida,
  opcoes?: OpcoesSaida,
): Promise<ResultadoPedirPermissao> {
  const agoraMs = opcoes?.agoraMs ?? Date.now();
  let b: Base | FalhaLigarSaida;
  try {
    b = await lerBase(ctx, pedido.conversaId, agoraMs);
  } catch {
    return msgSaida.erroAoLer();
  }
  if ("ok" in b) return b;
  const local = travaLocal(b, agoraMs);
  if (local) return falhaDoMotivo(local.motivo);
  const m = await consultar(b, opcoes);
  if (!m.ok) return m;
  const estado = estadoDaPermissao(b, m, agoraMs);
  if (!estado.podePedir) return falhaDoMotivo(estado.motivo);

  const { token, phoneId } = tokenEPhone(b.conexao!);
  const enviado = await pedirPermissaoMeta(
    token,
    phoneId,
    b.telefone!,
    TEXTO_PEDIDO_PERMISSAO,
    opcoesHttp(opcoes),
  );
  if (!enviado.ok) {
    return falha(
      enviado.erro === "meta_token_invalido" ? "meta_token_invalido" : "provedor_fora",
      enviado.mensagem,
    );
  }
  const pedidoEm = new Date(agoraMs).toISOString();
  const { error } = await supabaseAdmin.from("ligacao_permissoes").insert({
    conversa_id: b.conversa.id,
    conexao_id: b.conexao!.id,
    id_gateway: enviado.wamid,
    pedido_por: b.membroId,
    pedido_em: pedidoEm,
  });
  if (error) {
    // o pedido saiu: a tela mostra "aguardando" mesmo assim; a resposta do lead, sem o pedido
    // gravado, só aparece pela consulta à Meta
    console.error("ligacao_saida_pedido_gravar_falhou");
  }
  return {
    ok: true,
    estado: {
      ...estado,
      podePedir: false,
      motivo: "aguardando_lead",
      pedido: { pedidoEm, resposta: null, permanente: null, respondidoEm: null },
      pedirDeNovoEm: null,
    },
  };
}

function falhaDoMotivo(motivo: MotivoNaoLiga | null): FalhaLigarSaida {
  switch (motivo) {
    case "sem_ligacoes":
      return msgSaida.semLigacoes();
    case "sem_telefone":
      return msgSaida.semTelefone();
    case "ligacao_em_andamento":
      return msgSaida.emAndamento();
    case "fora_da_janela":
      return msgSaida.foraDaJanela();
    case "limite_de_pedidos":
    case "recusou":
    case "aguardando_lead":
      return msgSaida.limiteDePedidos();
    default:
      return msgSaida.semPermissao();
  }
}

/**
 * A saída do tronco para quem ativou antes dela (spec seção 1): a senha SIP da Meta, o PATCH no
 * tronco, o callback e a marca em parametros.ligacoes (com a trava do atualizadaEm).
 */
async function completarSaida(
  conexao: ConexaoServidor,
  ligacoes: LigacoesGravadas,
  chave: string,
  opcoes: OpcoesSaida | undefined,
): Promise<FalhaLigarSaida | null> {
  const troncoId = ligacoes.eleven.troncoId;
  if (!troncoId) return msgSaida.semLigacoes();
  const { token, phoneId } = tokenEPhone(conexao);
  const http = opcoesHttp(opcoes);
  const senha = await lerSenhaSipMeta(token, phoneId, http);
  if (!senha.ok) return falha("provedor_fora", senha.mensagem);
  const tronco = await ligarSaidaDoTronco(
    chave,
    troncoId,
    { numero: ligacoes.numero, senha: senha.senha },
    http,
  );
  if (tronco) return falha("provedor_fora", tronco.mensagem);
  // o callback não é preciso para esta ligação: sem ele, a marca não é gravada, e o próximo
  // "Ligar" refaz o upgrade (o PATCH do tronco é idempotente) até o callback ligar (Sol, PR #24)
  const callback = await ligarCallbackMeta(token, phoneId, http);
  if (!callback.ok) {
    console.error("ligacao_saida_callback_falhou", callback.erro);
    return null;
  }
  let gravou: boolean;
  try {
    gravou = await gravarLigacoes(
      conexao.id,
      { ...ligacoes, saida: true, atualizadaEm: new Date().toISOString() },
      ligacoes.atualizadaEm || "",
    );
  } catch {
    console.error("ligacao_saida_marca_falhou");
    return null;
  }
  if (gravou) return null;
  // perdeu a trava: alguém mudou as ligações no meio (Desativar, outra ativação). Só segue se
  // elas continuam ativas com o mesmo tronco (Sol, PR #24)
  try {
    const agora = await conexaoAtiva();
    const l = agora?.id === conexao.id ? lerLigacoesGravadas(agora.parametros) : null;
    if (
      l?.situacao === "ativa" &&
      l.eleven.troncoId === troncoId &&
      l.eleven.agenteId === ligacoes.eleven.agenteId
    ) {
      return null;
    }
  } catch {
    return msgSaida.erroAoLer();
  }
  return msgSaida.semLigacoes();
}

export async function ligarParaLeadLogica(
  ctx: ContextoUsuario,
  pedido: PedidoLigarSaida,
  opcoes?: OpcoesSaida,
): Promise<ResultadoLigarParaLead> {
  const agoraMs = opcoes?.agoraMs ?? Date.now();
  const lidoObjetivo = lerObjetivo(pedido.objetivo);
  if (!lidoObjetivo.ok) return lidoObjetivo;
  const objetivo = lidoObjetivo.objetivo;
  let b: Base | FalhaLigarSaida;
  try {
    b = await lerBase(ctx, pedido.conversaId, agoraMs);
  } catch {
    return msgSaida.erroAoLer();
  }
  if ("ok" in b) return b;
  // o agente escolhido (A2): pronto, ou a falha antes de consultar a Meta
  let escolhido: LinhaAgente | null = null;
  if (pedido.agenteId) {
    try {
      escolhido = await lerAgenteLinha(pedido.agenteId);
    } catch {
      return msgSaida.erroAoLer();
    }
    if (!escolhido) return msgSaida.agenteNaoExiste();
    if (indisponivelDe(escolhido)) return msgSaida.agenteNaoPronto();
  }
  const local = travaLocal(b, agoraMs);
  if (local && local.motivo !== "aguardando_lead") return falhaDoMotivo(local.motivo);
  const m = await consultar(b, opcoes);
  if (!m.ok) return m;
  const estado = estadoDaPermissao(b, m, agoraMs);
  if (!estado.podeLigar) {
    return estado.motivo === "meta_nao_deixa" || estado.motivo === null
      ? msgSaida.semPermissao()
      : falhaDoMotivo(estado.motivo);
  }

  const conexao = b.conexao!;
  const ligacoes = b.ligacoes!;
  const troncoId = ligacoes.eleven.troncoId;
  const ligacaoToken = conexao.segredos[SEGREDO_TOKEN];
  if (!ligacoes.eleven.agenteId || !troncoId || !ligacaoToken) return msgSaida.semLigacoes();
  let chave: string | null;
  try {
    const k = await lerChaveIA("voz");
    chave = k && k.provedor === "elevenlabs" && k.chave.trim() ? k.chave : null;
  } catch {
    chave = null;
  }
  if (!chave) return msgSaida.semLigacoes();

  if (!ligacoes.saida) {
    const falhou = await completarSaida(conexao, ligacoes, chave, opcoes);
    if (falhou) return falhou;
  }

  // o agente de novo, depois das idas à Meta e à ElevenLabs (Sol, PR #26): o admin pode ter mudado
  // ou apagado o agente nesse meio; a ligação sai com a linha como ela está agora
  if (pedido.agenteId) {
    try {
      escolhido = await lerAgenteLinha(pedido.agenteId);
    } catch {
      return msgSaida.erroAoLer();
    }
    if (!escolhido) return msgSaida.agenteNaoExiste();
    if (indisponivelDe(escolhido)) return msgSaida.agenteNaoPronto();
  } else {
    // sem agente escolhido, o que atende agora (A6), relido depois das idas à rede (Sol, PR #26);
    // sem nenhuma linha (a primeira versão das ligações), o do tronco
    let quemAtende: LinhaAgente | null;
    try {
      quemAtende = (await listarAgentes()).find((a) => a.atende) ?? null;
    } catch {
      return msgSaida.erroAoLer();
    }
    if (quemAtende) {
      if (indisponivelDe(quemAtende)) return msgSaida.agenteNaoPronto();
      escolhido = quemAtende;
    }
  }
  // sem linha nenhuma, o agente do tronco, como antes (A6)
  const agenteEleven = escolhido?.idExterno ?? ligacoes.eleven.agenteId;

  // o registro, com o objetivo e os limites (do contato e da conta), numa transação
  let agente: AgenteDaLigacao | null;
  let registro:
    | {
        ligacao_id: string | null;
        id_externo: string | null;
        permitida: boolean;
        motivo: string | null;
      }
    | undefined;
  try {
    agente = escolhido
      ? {
          id: escolhido.id,
          saudacao: escolhido.saudacao,
          sincronizadoEm: escolhido.sincronizadoEm,
          duracaoMaxS: escolhido.duracaoMaxS,
          uso: escolhido.uso,
        }
      : await lerAgenteDaLigacao(agenteEleven);
  } catch {
    return msgSaida.erroAoLer();
  }
  try {
    const { data, error } = await supabaseAdmin.rpc("ligacao_iniciar_saida", {
      p_conversa: b.conversa.id,
      // sem a linha do agente (a primeira versão das ligações), nulo, como na entrada (Opus, PR #24)
      p_agente: (agente?.id ?? null) as string,
      p_momento: new Date(agoraMs).toISOString(),
      // gravado junto com a reserva (Sol, PR #26): nunca uma ligação com objetivo que some
      p_objetivo: (objetivo ?? null) as string,
    });
    if (error) {
      if (error.message === "objetivo_invalido") return msgSaida.objetivoGrande();
      // o agente apagado entre a releitura e o registro: a chave estrangeira (Opus, PR #26)
      if (error.code === "23503") return msgSaida.agenteNaoExiste();
      throw new Error("banco_ligacao_iniciar_saida");
    }
    registro = Array.isArray(data) ? data[0] : undefined;
  } catch {
    return msgSaida.erroAoGravar();
  }
  if (!registro?.permitida || !registro.ligacao_id || !registro.id_externo) {
    if (registro?.motivo === "limite_por_contato") return msgSaida.limitePorContato();
    if (registro?.motivo === "ligacao_em_andamento") return msgSaida.emAndamento();
    if (registro?.motivo === "limite_simultaneas") return msgSaida.limiteSimultaneas();
    if (registro?.motivo === "limite_por_dia") return msgSaida.limitePorDia();
    // o agente apagado ou solto entre a releitura e o registro (Sol, PR #26)
    if (registro?.motivo === "agente_indisponivel") return msgSaida.agenteNaoPronto();
    if (registro?.motivo === "sem_conexao" || registro?.motivo === "sem_ligacoes") {
      return msgSaida.semLigacoes();
    }
    return msgSaida.erroAoGravar();
  }
  const ligacaoId = registro.ligacao_id;
  const provisorio = registro.id_externo;

  // as variáveis da conversa: a ElevenLabs não chama o webhook de início na saída
  let variaveis: Record<string, string>;
  try {
    const [contexto, leadLido, modo] = await Promise.all([
      lerContextoAtual(),
      lerLeadDaLigacao(b.conversa.id, idExternoDaLigacao(provisorio)),
      modoDaConversa(b.conversa.id),
    ]);
    const extra = [
      LEAD_SAIDA,
      objetivo ? linhaDoObjetivo(objetivo) : "",
      modo && modo !== "nina" ? LEAD_COM_EQUIPE : "",
    ].filter(Boolean);
    const lead = [leadLido.texto, ...extra].filter(Boolean).join("\n\n");
    const sessao = await assinarSessao(
      ligacaoToken,
      b.conversa.id,
      provisorio,
      Math.floor(agoraMs / 1000),
      validadeDaSessao(agente?.duracaoMaxS),
    );
    const mandarContexto =
      !agente || agenteAtrasDoContexto(agente.sincronizadoEm, contexto.criadoEm);
    variaveis = {
      // o agente Ativo se apresenta com a saudação dele; o Receptivo, com a de quem liga (A4)
      nina_saudacao: saudacaoDoAgente(
        agente?.uso === "ligar" ? agente.saudacao : SAUDACAO_SAIDA,
        leadLido.nome,
      ),
      nina_contexto: mandarContexto ? contexto.texto : "",
      nina_lead: lead,
      [VARIAVEL_LIGACAO]: ligacaoId,
      [VARIAVEL_SESSAO]: sessao,
    };
  } catch {
    await fecharSemSair(provisorio, agoraMs);
    return msgSaida.erroAoLer();
  }

  const chamada = await ligarPeloTronco(
    chave,
    { agenteId: agenteEleven, troncoId, para: b.telefone!, variaveis },
    opcoesHttp(opcoes),
  );
  if (!chamada.ok && chamada.incerto) {
    // a ligação pode ter saído (Sol, PR #24): a reserva fica (a conversa segue em andamento, e a
    // ligação conta no limite) até o pós-chamada confirmar pela nina_ligacao, ou as presas a
    // fecharem depois do teto; o worker acordado confere
    emSegundoPlano(acordar(pedido.origem));
    return msgSaida.talvezTenhaSaido();
  }
  if (!chamada.ok) {
    await fecharSemSair(provisorio, agoraMs);
    return falha(
      chamada.erro === "tempo_esgotado" ? "tempo_esgotado" : "provedor_fora",
      chamada.mensagem,
    );
  }
  try {
    await confirmarLigacaoDeSaida(ligacaoId, chamada.conversaEleven);
  } catch {
    // o pós-chamada confirma pela variável nina_ligacao; a ferramenta da equipe acha pelo provisório
    console.error("ligacao_saida_confirmar_falhou");
  }
  // o worker acordado desde o começo: ele confere as presas durante a ligação
  emSegundoPlano(acordar(pedido.origem));
  return { ok: true, ligacaoId };
}

/** A chamada não saiu: a linha fecha como não completada. Nunca lança. */
async function fecharSemSair(provisorio: string, agoraMs: number): Promise<void> {
  try {
    await encerrarLigacao(provisorio, {
      status: "nao_completada",
      encerradaEm: new Date(agoraMs).toISOString(),
      duracaoS: 0,
      motivoFim: "nao_saiu",
      resumo: null,
      transcricao: [],
      custoCreditos: null,
    });
  } catch {
    console.error("ligacao_saida_fechar_falhou");
  }
}

async function acordar(origem: string): Promise<void> {
  const { acordarMotor } = await import("../nucleo/motor.server");
  await acordarMotor(origem, { renovar: true }).catch(() => undefined);
}
