import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createContext, useContext, useMemo, useRef } from "react";

import { modelosDo } from "@/features/ia/modelos";
import {
  ativarLigacoes,
  conferirConexao,
  consertarCampoConexao,
  desativarLigacoes,
  desconectarConexao,
  escolherVoz,
  estadoLigacoes,
  listarModelosDaChave,
  listarVozes,
  removerChaveIA,
  revalidarChaveIA,
  salvarChaveIA,
  salvarConexao,
  salvarModoVoz,
  salvarRitmo,
  trocarModeloIA,
  usarChaveElevenLabs,
  verSegredoGerado,
  type AvisoConexao,
  type AvisoDesconectar,
  type CampoConsertoMeta,
  type EntradaUsarChaveElevenLabs,
  type ResultadoUsarChaveElevenLabs,
  type VozConferida,
} from "@/features/mensageria/configuracao.functions";
import { sincronizarVozLigacao } from "@/features/mensageria/ligacoes.functions";

import {
  DONO_ITEM_ELEGIBILIDADE,
  ITENS_ELEGIBILIDADE,
  ehPendenciaLigacoes,
  requisitosCumpridos,
  type Elegibilidade,
  type ErroLigacoes,
  type EstadoItemElegibilidade,
  type EstadoLigacoes,
  type IdItemElegibilidade,
  type ItemElegibilidade,
  type RequisitosLigacoes,
  type SituacaoLigacoes,
} from "@/features/mensageria/ligacoes/tipos";
import {
  desconectarCelular,
  pedirQrConexao,
  pedirQrConexaoGuardada,
  type GatewayQr,
  type PedidoQr,
} from "@/features/mensageria/qr.functions";
import type { ProvedorIA as ProvedorListavel } from "@/features/servidor/chave-ia";
import { listarModelos } from "@/features/servidor/listar-modelos.functions";
import type { ModeloListado } from "@/features/servidor/listar-modelos";
import {
  MODOS_VOZ,
  VOZ_ID,
  type ModoVoz,
  type ResultadoListaVozes,
  type VozDaConta,
  type VozEscolhida,
} from "@/features/servidor/vozes-tipos";

import { VOZES_EXEMPLO } from "../exemplo/dados";
import { useExemplo } from "../exemplo/ProvedorExemplo";
import type { ChaveIA, Conexao, EstadoExemplo, FinalidadeIA, Gateway, ProvedorIA, StatusConexao } from "../exemplo/tipos";
import { CHAVES, type ChaveRaiz } from "./chaves";
import { COLUNAS_CONEXAO, type ClienteSupabase } from "./colunas";
import { RELER_SEM_TEMPO_REAL_MS, repetirSoFalha } from "./leituras";
import { pronta, paraLeitura } from "./leitura";
import { useClienteDados, useDados, useModoDados } from "./ProvedorDados";
import type { AjusteLembrete, ConfiguracaoDados, Leitura, ModoDados } from "./tipos";

// As leituras e as ações da Configuração (spec de ligar as telas ao banco, task C5). As leituras
// comuns (chaves e configuração) vêm do useDados(); a conexão da Configuração é a mais recente, ativa
// ou desligada pela Configuração (conexao_eventos), para o cartão saber dizer "Você desconectou este
// número" (desligada) e não confundir com a queda (ativa e desconectada). As ações chamam as funções
// de servidor da mensageria (src/features/mensageria/configuracao.functions.ts, só admin) e
// invalidam o que mudou. No modo exemplo, as mesmas ações mexem no estado em memória.

/* ---------- tipos ---------- */

/** A conexão que a Configuração mostra. `desligada` só quando a conexão saiu de ativa (ativa_para false). */
export interface ConexaoConfiguracao {
  /** A ativa; senão, a última desligada pela Configuração; senão, nula. */
  conexao: Conexao | null;
  /** Quem desligou (nulo quando foi o servidor, como no desconectarConexao) e quando. */
  desligada: { ator_membro_id: string | null; em: string } | null;
}

/** A recusa de uma ação da Configuração: o código, e a frase pronta do servidor quando ele manda. */
export interface FalhaConfiguracao {
  ok: false;
  erro: string;
  mensagem?: string | undefined;
  /** O campo do formulário que o gateway recusou. */
  campo?: string | undefined;
  /** O status que a conferência deixou na conexão ou na chave. */
  status?: string | undefined;
  /** numero_diferente (spec-qr-whatsapp, seção 8): o número do celular que leu o QR, formatado. */
  numeroConectado?: string | undefined;
  /** numero_diferente no salvar: o número que a pessoa informou, formatado. */
  numeroInformado?: string | undefined;
  /** numero_diferente no conserto: o número salvo na conexão, formatado. */
  numeroSalvo?: string | undefined;
  /** numero_diferente no conserto: o celular de outro número saiu da instância. */
  desconectado?: boolean | undefined;
  /** O ativar das ligações reprovado na verificação (spec-ligacoes, seção 21): o que faltou. */
  elegibilidade?: Elegibilidade | undefined;
}

export type ResultadoConfiguracao<T extends object = object> = ({ ok: true } & T) | FalhaConfiguracao;

/** Só o modo exemplo usa: o "Simular" da demo e o número de exemplo. O banco ignora. */
export interface SimulacaoExemplo {
  falhar?: boolean | undefined;
  nome?: string | undefined;
}

export interface ModelosDaChave {
  modelos: ModeloListado[];
  origem: "provedor" | "lista_curada";
}

export interface ConexaoSalva {
  nome: string;
  gateway: Gateway;
  /** O endereço do webhook (vazio no exemplo). */
  urlWebhook: string;
  /** Só a Meta: o token de verificação para colar no painel dela. */
  verifyToken: string | null;
  avisos: AvisoConexao[];
  /**
   * O Trocar (decisão 10 das lacunas): o webhook da conexão que saiu ficou no provedor (Meta e Z-API:
   * tirar no painel; ou o desligar falhou). Ausente = não havia outra, desligou ou é o exemplo.
   */
  anterior?: { gateway: Gateway; aviso: AvisoDesconectar };
}

/** O aviso do webhook da conexão anterior que o salvarConexao devolve; null = sem aviso ou fora do formato. */
function avisoAnterior(v: unknown): { gateway: Gateway; aviso: AvisoDesconectar } | null {
  if (!v || typeof v !== "object") return null;
  const gateway = (v as Record<string, unknown>)["gateway"];
  const aviso = (v as Record<string, unknown>)["aviso"];
  const gatewayOk = gateway === "meta" || gateway === "zapi" || gateway === "evolution" || gateway === "zernio";
  const avisoOk = aviso === "webhook_no_painel" || aviso === "webhook_nao_desligado";
  return gatewayOk && avisoOk ? { gateway, aviso } : null;
}

/** O passo do QR (Z-API e Evolution): conectado, ou a imagem (nula enquanto não vem) e o passkey. */
export interface EstadoQr {
  conectado: boolean;
  qr: string | null;
  passkey: boolean;
}

export interface AcoesConfiguracao {
  salvarConexao(gateway: Gateway, campos: Record<string, string>, sim?: SimulacaoExemplo): Promise<ResultadoConfiguracao<ConexaoSalva>>;
  /** Só a Meta: troca um campo guardado (token, appSecret ou wabaId) e confere de novo. */
  consertarCampo(campo: CampoConsertoMeta, valor: string, sim?: SimulacaoExemplo): Promise<ResultadoConfiguracao<{ nome: string }>>;
  /** A conferência grátis com os dados guardados (decisão 10b). */
  conferirConexao(sim?: SimulacaoExemplo): Promise<ResultadoConfiguracao<{ nome: string }>>;
  /** aviso: o webhook ficou no provedor (Meta e Z-API: tirar no painel; ou o desligar falhou). */
  desconectar(): Promise<ResultadoConfiguracao<{ aviso?: AvisoDesconectar }>>;
  /** O verify token guardado da conexão da Meta. */
  verVerifyToken(conexaoId: string): Promise<ResultadoConfiguracao<{ valor: string }>>;
  salvarChave(
    finalidade: FinalidadeIA,
    provedor: ProvedorIA,
    modelo: string,
    chave: string,
    sim?: SimulacaoExemplo,
  ): Promise<ResultadoConfiguracao<{ ultimos4: string }>>;
  /** Confere uma chave nova (ainda não gravada) pedindo a lista de modelos ao provedor. */
  conferirChaveNova(provedor: ProvedorIA, chave: string, sim?: SimulacaoExemplo): Promise<ResultadoConfiguracao<ModelosDaChave>>;
  /**
   * Testa de novo a chave guardada, com a conferência grátis (decisão 10b). Na voz, o servidor também
   * confere a voz escolhida (`voz`: "ok", "nao_encontrada" ou "sem_voz"; P12 do uso da voz).
   */
  revalidarChave(finalidade: FinalidadeIA, sim?: SimulacaoExemplo): Promise<ResultadoConfiguracao<{ voz?: VozConferida }>>;
  listarModelosDaChave(finalidade: FinalidadeIA): Promise<ResultadoConfiguracao<ModelosDaChave>>;
  trocarModelo(finalidade: FinalidadeIA, modelo: string): Promise<ResultadoConfiguracao<{ modelo: string }>>;
  /** Só a chave de áudio: sem ela, a transcrição volta a usar a do cérebro (quando ela transcreve). */
  removerChaveAudio(): Promise<ResultadoConfiguracao>;
  /** A chave da voz (ElevenLabs): sem ela, a Nina fica sem voz. */
  removerChaveVoz(): Promise<ResultadoConfiguracao>;
  /**
   * Só o admin. Com `lembrete` (o interruptor e as horas, de 1 a 23), grava também o lembrete
   * automático; sem ele, só o ritmo, como sempre. Devolve o que o servidor gravou.
   */
  salvarRitmo(
    espera: number,
    teto: number,
    lembrete?: AjusteLembrete,
  ): Promise<ResultadoConfiguracao<{ espera: number; teto: number; lembrete?: AjusteLembrete }>>;
  /** As vozes da conta da chave guardada e a escolhida hoje (spec-voz-uso, C3). Não grava nem relê nada. */
  listarVozes(): Promise<ResultadoListaVozes>;
  /** Grava a voz (o servidor confere na ElevenLabs e guarda o nome que veio de lá). */
  escolherVoz(vozId: string): Promise<ResultadoConfiguracao<{ voz: VozEscolhida }>>;
  /** Quando a Nina responde em áudio. */
  salvarModoVoz(modo: ModoVoz): Promise<ResultadoConfiguracao<{ modo: ModoVoz }>>;
  /**
   * Usa a chave da ElevenLabs do outro cartão também neste (`para`: a voz copia da escuta, e a escuta
   * da voz; spec da escuta com a ElevenLabs, E2). A cópia é no servidor: a chave nunca vem à tela.
   * `ultimos4` nulo = nada foi copiado.
   */
  usarChaveElevenLabs(para: "voz" | "transcricao"): Promise<ResultadoConfiguracao<{ ultimos4: string | null }>>;
  /** O QR com os campos colados (troca de WhatsApp). Não grava nem relê nada. */
  pedirQr(
    gateway: GatewayQr,
    campos: Record<string, string>,
    pedir: PedidoQr,
  ): Promise<ResultadoConfiguracao<EstadoQr>>;
  /** O QR com os dados guardados da conexão ativa (conserto do número caído). Não grava nem relê nada. */
  pedirQrGuardada(pedir: PedidoQr): Promise<ResultadoConfiguracao<EstadoQr>>;
  /** Tira o celular da instância com os campos colados ("Desconectar e ler de novo"). Não grava nem relê nada. */
  desconectarCelular(gateway: GatewayQr, campos: Record<string, string>): Promise<ResultadoConfiguracao>;
  /** As ligações pelo WhatsApp (2.6): o estado e os requisitos. Só lê. */
  estadoLigacoes(): Promise<ResultadoConfiguracao<{ estado: EstadoLigacoes }>>;
  /** Monta o atendimento por voz (ElevenLabs e Meta). No exemplo, `sim.falhar` simula a recusa da Meta. */
  ativarLigacoes(sim?: SimulacaoExemplo): Promise<ResultadoConfiguracao<{ estado: EstadoLigacoes }>>;
  /** Desmonta; o que não sair volta em `estado.pendencias`. No exemplo, `sim.falhar` deixa uma pendência. */
  desativarLigacoes(sim?: SimulacaoExemplo): Promise<ResultadoConfiguracao<{ estado: EstadoLigacoes }>>;
}

export interface DadosConfiguracao {
  modo: ModoDados;
  /** O id do membro de quem usa (para "Você desconectou"). */
  euId: string;
  conexao: Leitura<ConexaoConfiguracao>;
  chaves: Leitura<ChaveIA[]>;
  configuracao: Leitura<ConfiguracaoDados>;
  acoes: AcoesConfiguracao;
}

/* ---------- as funções de servidor (testes trocam por falsas) ---------- */

type Resposta = { ok: boolean } & Record<string, unknown>;

/** As funções de servidor que a Configuração chama, com a entrada de cada uma. */
export interface ServidorConfiguracao {
  salvarConexao(d: { gateway: string; campos: Record<string, string> }): Promise<Resposta>;
  verSegredoGerado(d: { conexao_id: string; nome: "verifyToken" }): Promise<Resposta>;
  desconectarConexao(): Promise<Resposta>;
  conferirConexao(): Promise<Resposta>;
  consertarCampoConexao(d: { campo: CampoConsertoMeta; valor: string }): Promise<Resposta>;
  salvarChaveIA(d: { finalidade: FinalidadeIA; provedor: ProvedorIA; modelo: string; chave: string }): Promise<Resposta>;
  revalidarChaveIA(d: { finalidade: FinalidadeIA }): Promise<Resposta>;
  listarModelosDaChave(d: { finalidade: FinalidadeIA }): Promise<Resposta>;
  trocarModeloIA(d: { finalidade: FinalidadeIA; modelo: string }): Promise<Resposta>;
  removerChaveIA(d: { finalidade: FinalidadeIA }): Promise<Resposta>;
  salvarRitmo(d: { espera: number; teto: number; lembrete?: AjusteLembrete }): Promise<Resposta>;
  listarModelos(d: { provedor: ProvedorListavel; chave: string }): Promise<Resposta>;
  pedirQrConexao(d: {
    gateway: GatewayQr;
    campos: Record<string, string>;
    pedir: PedidoQr;
  }): Promise<Resposta>;
  pedirQrConexaoGuardada(d: { pedir: PedidoQr }): Promise<Resposta>;
  listarVozes(): Promise<Resposta>;
  escolherVoz(d: { vozId: string }): Promise<Resposta>;
  salvarModoVoz(d: { modo: ModoVoz }): Promise<Resposta>;
  desconectarCelular(d: { gateway: GatewayQr; campos: Record<string, string> }): Promise<Resposta>;
  usarChaveElevenLabs(d: EntradaUsarChaveElevenLabs): Promise<ResultadoUsarChaveElevenLabs>;
  estadoLigacoes(): Promise<Resposta>;
  ativarLigacoes(): Promise<Resposta>;
  desativarLigacoes(): Promise<Resposta>;
  /**
   * Depois de escolher a voz (L37): os agentes de voz sem voz própria recebem a voz nova, sem
   * bloquear. Opcional: sem ele (testes antigos), nada é chamado.
   */
  sincronizarVozLigacao?(): Promise<unknown>;
}

const comoResposta = (p: Promise<unknown>) => p as Promise<Resposta>;

/** As funções de servidor de verdade (createServerFn: no navegador, viram uma chamada ao servidor). */
export const SERVIDOR_CONFIGURACAO: ServidorConfiguracao = {
  salvarConexao: (data) => comoResposta(salvarConexao({ data })),
  verSegredoGerado: (data) => comoResposta(verSegredoGerado({ data })),
  desconectarConexao: () => comoResposta(desconectarConexao({ data: {} })),
  conferirConexao: () => comoResposta(conferirConexao({ data: {} })),
  consertarCampoConexao: (data) => comoResposta(consertarCampoConexao({ data })),
  salvarChaveIA: (data) => comoResposta(salvarChaveIA({ data })),
  revalidarChaveIA: (data) => comoResposta(revalidarChaveIA({ data })),
  listarModelosDaChave: (data) => comoResposta(listarModelosDaChave({ data })),
  trocarModeloIA: (data) => comoResposta(trocarModeloIA({ data })),
  removerChaveIA: (data) => comoResposta(removerChaveIA({ data })),
  salvarRitmo: (data) => comoResposta(salvarRitmo({ data })),
  listarModelos: (data) => comoResposta(listarModelos({ data })),
  pedirQrConexao: (data) => comoResposta(pedirQrConexao({ data })),
  pedirQrConexaoGuardada: (data) => comoResposta(pedirQrConexaoGuardada({ data })),
  listarVozes: () => comoResposta(listarVozes({ data: {} })),
  escolherVoz: (data) => comoResposta(escolherVoz({ data })),
  salvarModoVoz: (data) => comoResposta(salvarModoVoz({ data })),
  desconectarCelular: (data) => comoResposta(desconectarCelular({ data })),
  usarChaveElevenLabs: (data) => usarChaveElevenLabs({ data }),
  estadoLigacoes: () => comoResposta(estadoLigacoes({ data: {} })),
  ativarLigacoes: () => comoResposta(ativarLigacoes({ data: {} })),
  desativarLigacoes: () => comoResposta(desativarLigacoes({ data: {} })),
  sincronizarVozLigacao: () => sincronizarVozLigacao({ data: {} }),
};

/** Troca as funções de servidor (testes). Sem provedor, valem as de verdade. */
export const ServidorConfiguracaoContexto = createContext<ServidorConfiguracao>(SERVIDOR_CONFIGURACAO);

/* ---------- leitura da conexão ---------- */

const VALE_MS = 15_000;

/**
 * A conexão da Configuração: a ativa; sem ela, a mais recente, se o último evento dela foi sair de
 * ativa (conexao_eventos, ativa_de true → ativa_para false). Inativa sem esse evento conta como
 * nenhuma. conexoes não está no tempo real: relê no foco e a cada 60 s.
 */
export function opcoesConexaoConfiguracao(cliente: ClienteSupabase) {
  return queryOptions({
    queryKey: [...CHAVES.conexao, "configuracao"] as const,
    queryFn: async (): Promise<ConexaoConfiguracao> => {
      const { data, error } = await cliente
        .from("conexoes")
        .select(COLUNAS_CONEXAO)
        .order("ativa", { ascending: false })
        .order("atualizado_em", { ascending: false })
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data) return { conexao: null, desligada: null };
      if (data.ativa) return { conexao: data, desligada: null };
      const ev = await cliente
        .from("conexao_eventos")
        .select("id, ator_membro_id, criado_em")
        .eq("conexao_id", data.id)
        .eq("ativa_de", true)
        .eq("ativa_para", false)
        .order("criado_em", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (ev.error) throw ev.error;
      if (!ev.data) return { conexao: null, desligada: null };
      // O desconectar do servidor desliga com a chave de serviço, e o gatilho grava o ator nulo. Quem
      // desligou fica na auditoria (conexao_desativada, alvo = id da conexão), que só o admin lê; a
      // Configuração é só do admin. Sem achar, o ator continua nulo e a frase sai neutra.
      let ator = ev.data.ator_membro_id;
      if (ator === null) {
        const au = await cliente
          .from("auditoria")
          .select("ator_membro_id")
          .eq("acao", "conexao_desativada")
          .eq("alvo", data.id)
          .order("criado_em", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!au.error && au.data) ator = au.data.ator_membro_id;
      }
      return { conexao: data, desligada: { ator_membro_id: ator, em: ev.data.criado_em } };
    },
    staleTime: VALE_MS,
    retry: repetirSoFalha,
    refetchInterval: RELER_SEM_TEMPO_REAL_MS,
    refetchOnWindowFocus: "always",
  });
}

/* ---------- apoio ---------- */

/** O que cada ação deixa velho (sempre, mesmo na recusa: a conferência que falha muda o status). */
const RELER: Record<"conexao" | "chaves" | "configuracao" | "voz" | "ligacoes", readonly ChaveRaiz[]> = {
  conexao: ["conexao", "auditoria"],
  // ativar e desativar as ligações gravam em conexoes.parametros (a tela não lê, mas a conexão muda)
  // e nos agentes de voz (a linha "Nina" nasce; o id_externo entra e sai)
  ligacoes: ["conexao", "auditoria", "ligacoes"],
  chaves: ["chaves", "auditoria"],
  configuracao: ["configuracao", "auditoria"],
  // a conferência da chave da voz também grava ou limpa configuracao.voz_erro (P12)
  voz: ["chaves", "configuracao", "auditoria"],
};

/** O lembrete que o servidor devolveu ({ ligado, horas }); fora do formato, o que a tela pediu. */
function lerLembreteDaResposta(v: unknown, pedido: AjusteLembrete): AjusteLembrete {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return {
    ligado: typeof o["ligado"] === "boolean" ? o["ligado"] : pedido.ligado,
    horas: typeof o["horas"] === "number" && Number.isInteger(o["horas"]) ? o["horas"] : pedido.horas,
  };
}

function falha(erro: string, mensagem?: string, extra: Partial<FalhaConfiguracao> = {}): FalhaConfiguracao {
  return { ok: false, erro, ...(mensagem ? { mensagem } : {}), ...extra };
}

/** A resposta de uma função de servidor como recusa (só código, frase, campo e status: nada de segredo). */
function recusaDe(r: Resposta): FalhaConfiguracao {
  const erro = typeof r["erro"] === "string" ? (r["erro"] as string) : "falha";
  const extra: Partial<FalhaConfiguracao> = {};
  if (typeof r["campo"] === "string") extra.campo = r["campo"] as string;
  if (typeof r["status"] === "string") extra.status = r["status"] as string;
  // numero_diferente (spec-qr-whatsapp, seção 8): os números já vêm formatados do servidor
  if (typeof r["numero_conectado"] === "string") extra.numeroConectado = r["numero_conectado"] as string;
  if (typeof r["numero_informado"] === "string") extra.numeroInformado = r["numero_informado"] as string;
  if (typeof r["numero_salvo"] === "string") extra.numeroSalvo = r["numero_salvo"] as string;
  if (typeof r["desconectado"] === "boolean") extra.desconectado = r["desconectado"] as boolean;
  // o ativar das ligações reprovado na verificação (spec-ligacoes, seção 21), conferido item a item
  const eleg = elegibilidadeDe(r["elegibilidade"]);
  if (eleg) extra.elegibilidade = eleg;
  return falha(erro, typeof r["mensagem"] === "string" ? (r["mensagem"] as string) : undefined, extra);
}

function texto(r: Resposta, campo: string): string {
  return typeof r[campo] === "string" ? (r[campo] as string) : "";
}

const VOZES_CONFERIDAS: readonly VozConferida[] = ["ok", "nao_encontrada", "sem_voz"];

/** O `voz` da conferência da chave da voz, só quando veio num valor conhecido. */
function vozConferidaDe(r: Resposta): { voz?: VozConferida } {
  const v = r["voz"];
  return typeof v === "string" && (VOZES_CONFERIDAS as readonly string[]).includes(v) ? { voz: v as VozConferida } : {};
}

/** Uma voz escolhida que veio do servidor (id no formato e nome de texto), ou nula. */
function vozEscolhidaDe(v: unknown): VozEscolhida | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o["id"] !== "string" || !VOZ_ID.test(o["id"])) return null;
  const nome = typeof o["nome"] === "string" && o["nome"].trim() ? o["nome"] : o["id"];
  return { id: o["id"], nome };
}

/** A recusa no formato da lista de vozes (só o código e a frase: nada de campo nem status). */
function falhaLista(f: FalhaConfiguracao): ResultadoListaVozes {
  return { ok: false, erro: f.erro, ...(f.mensagem ? { mensagem: f.mensagem } : {}) };
}

/** As vozes da lista: só as que têm id no formato e nome (o resto do formato a lista mostra como veio). */
function vozesDe(lista: unknown[]): VozDaConta[] {
  return lista.filter(
    (v): v is VozDaConta =>
      !!v && typeof v === "object" && typeof (v as VozDaConta).id === "string" && VOZ_ID.test((v as VozDaConta).id) && typeof (v as VozDaConta).nome === "string",
  );
}

const SITUACOES_LIGACOES: readonly SituacaoLigacoes[] = ["indisponivel", "pronta", "ativando", "ativa", "com_pendencias"];

/** O estado das ligações que veio do servidor, conferido campo a campo; null fora do formato. */
export function estadoLigacoesDe(v: unknown): EstadoLigacoes | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const situacao = o["situacao"];
  if (typeof situacao !== "string" || !(SITUACOES_LIGACOES as readonly string[]).includes(situacao)) return null;
  const r = o["requisitos"];
  if (!r || typeof r !== "object") return null;
  const rq = r as Record<string, unknown>;
  const requisitos: RequisitosLigacoes = {
    conexaoMeta: rq["conexaoMeta"] === true,
    chaveVoz: rq["chaveVoz"] === true,
    vozEscolhida: rq["vozEscolhida"] === true,
    enderecoPublicado: rq["enderecoPublicado"] === true,
  };
  const pend = Array.isArray(o["pendencias"]) ? (o["pendencias"] as unknown[]).filter(ehPendenciaLigacoes) : [];
  return {
    situacao: situacao as SituacaoLigacoes,
    requisitos,
    elegibilidade: elegibilidadeDe(o["elegibilidade"]),
    numero: typeof o["numero"] === "string" && o["numero"].trim() ? o["numero"] : null,
    ativadaEm: typeof o["ativadaEm"] === "string" && o["ativadaEm"] ? o["ativadaEm"] : null,
    pendencias: pend,
    // a ativação que parou no meio (D20): só quando vem
    ...(o["abandonada"] === true ? { abandonada: true } : {}),
  };
}

const ESTADOS_ITEM: readonly EstadoItemElegibilidade[] = ["ok", "falta", "falhou", "nao_conferido"];

/**
 * A verificação das ligações que veio do servidor (spec-ligacoes, seção 21): só os itens conhecidos,
 * cada um com o dono da tabela (nunca o que veio); null fora do formato.
 */
export function elegibilidadeDe(v: unknown): Elegibilidade | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o["versao"] !== 1 || !Array.isArray(o["itens"]) || typeof o["conferidaEm"] !== "string") return null;
  const itens: ItemElegibilidade[] = [];
  for (const x of o["itens"] as unknown[]) {
    if (!x || typeof x !== "object") continue;
    const i = x as Record<string, unknown>;
    const id = i["id"];
    const estado = i["estado"];
    if (typeof id !== "string" || !(ITENS_ELEGIBILIDADE as readonly string[]).includes(id)) continue;
    if (typeof estado !== "string" || !(ESTADOS_ITEM as readonly string[]).includes(estado)) continue;
    const valor = typeof i["valor"] === "string" && i["valor"].trim() ? i["valor"].trim().slice(0, 40) : null;
    // o código do erro do item (a tela escolhe o texto por ele): só no formato de código
    const erro = typeof i["erro"] === "string" && /^[a-z_]{1,40}$/.test(i["erro"]) ? i["erro"] : null;
    itens.push({
      id: id as IdItemElegibilidade,
      dono: DONO_ITEM_ELEGIBILIDADE[id as IdItemElegibilidade],
      estado: estado as EstadoItemElegibilidade,
      ...(valor ? { valor } : {}),
      ...(erro ? { erro: erro as ErroLigacoes } : {}),
    });
  }
  return {
    versao: 1,
    elegivel: o["elegivel"] === true,
    limiteMeta: typeof o["limiteMeta"] === "string" && o["limiteMeta"] ? o["limiteMeta"] : null,
    itens,
    conferidaEm: o["conferidaEm"],
  };
}

function modelosDe(r: Resposta): ModelosDaChave {
  const lista = Array.isArray(r["modelos"]) ? (r["modelos"] as ModeloListado[]) : [];
  return { modelos: lista, origem: r["origem"] === "lista_curada" ? "lista_curada" : "provedor" };
}

/** Os 4 últimos caracteres da chave colada (só letras e números), como a tela do exemplo mostra. */
function ultimos4Exemplo(chave: string): string {
  return chave.replace(/[^A-Za-z0-9]/g, "").slice(-4).toUpperCase();
}

/** A lista curada (src/features/ia/modelos.ts) no formato da listarModelos: o exemplo e a reserva. */
export function modelosCurados(provedor: ProvedorIA | null | undefined): ModeloListado[] {
  // groq só transcreve e a ElevenLabs só dá voz: nenhuma das duas tem lista de modelos de texto
  if (!provedor || provedor === "groq" || provedor === "elevenlabs") return [];
  return modelosDo(provedor).map((m) => ({
    id: m.id,
    nome: m.nome,
    perfil: m.perfil,
    precoEntrada: m.precoEntrada,
    precoSaida: m.precoSaida,
    recomendado: m.recomendado,
  }));
}

/** As ações do modo banco: chamam o servidor, nunca lançam, e invalidam o que mudou. */
export function criarAcoesConfiguracaoBanco(servidor: ServidorConfiguracao, queryClient: QueryClient): AcoesConfiguracao {
  const reler = (alvo: keyof typeof RELER) => {
    for (const raiz of RELER[alvo]) void queryClient.invalidateQueries({ queryKey: CHAVES[raiz] });
  };
  /** Chama, traduz a falha da chamada (rede, sessão, validador) e relê no fim, deu certo ou não. */
  async function chamar(alvo: keyof typeof RELER, fn: () => Promise<Resposta>): Promise<Resposta | FalhaConfiguracao> {
    let resultado: Resposta | FalhaConfiguracao;
    try {
      const r = await fn();
      if (!r || typeof r !== "object") resultado = falha("falha");
      else resultado = r.ok ? r : recusaDe(r);
    } catch {
      // nunca o texto cru: pode citar a entrada
      resultado = falha("falha");
    }
    reler(alvo);
    // A conta perdeu o acesso (desativada, ou deixou de ser admin): o Eu é relido (spec 2.2) e a
    // casca leva para /sem-acesso, ou o papel novo some com a Configuração.
    if (!resultado.ok && resultado.erro === "sem_acesso") void queryClient.invalidateQueries({ queryKey: CHAVES.eu });
    return resultado;
  }
  /** O QR: como o chamar, mas sem reler nada (o pedido não grava). Só o sem_acesso relê o Eu. */
  async function pedirEstadoQr(
    fn: () => Promise<Resposta>,
  ): Promise<ResultadoConfiguracao<EstadoQr>> {
    let resultado: ResultadoConfiguracao<EstadoQr>;
    try {
      const r = await fn();
      if (!r || typeof r !== "object") resultado = falha("falha");
      else if (!r.ok) resultado = recusaDe(r);
      else
        resultado = {
          ok: true,
          conectado: r["conectado"] === true,
          qr: texto(r, "qr") || null,
          passkey: r["passkey"] === true,
        };
    } catch {
      // nunca o texto cru: pode citar a entrada
      resultado = falha("falha");
    }
    if (!resultado.ok && resultado.erro === "sem_acesso")
      void queryClient.invalidateQueries({ queryKey: CHAVES.eu });
    return resultado;
  }

  return {
    salvarConexao: async (gateway, campos) => {
      const r = await chamar("conexao", () => servidor.salvarConexao({ gateway, campos }));
      if (!r.ok) return r as FalhaConfiguracao;
      const ok = r as Resposta;
      const avisos = Array.isArray(ok["avisos"]) ? (ok["avisos"] as AvisoConexao[]) : [];
      const anterior = avisoAnterior(ok["conexao_anterior"]);
      return {
        ok: true,
        nome: texto(ok, "nome"),
        gateway: (texto(ok, "gateway") || gateway) as Gateway,
        urlWebhook: texto(ok, "url_webhook"),
        verifyToken: texto(ok, "verifyToken") || null,
        avisos,
        ...(anterior ? { anterior } : {}),
      };
    },
    consertarCampo: async (campo, valor) => {
      const r = await chamar("conexao", () => servidor.consertarCampoConexao({ campo, valor }));
      return r.ok ? { ok: true, nome: texto(r as Resposta, "nome") } : (r as FalhaConfiguracao);
    },
    conferirConexao: async () => {
      const r = await chamar("conexao", () => servidor.conferirConexao());
      return r.ok ? { ok: true, nome: texto(r as Resposta, "nome") } : (r as FalhaConfiguracao);
    },
    desconectar: async () => {
      const r = await chamar("conexao", () => servidor.desconectarConexao());
      if (!r.ok) return r as FalhaConfiguracao;
      const aviso = texto(r as Resposta, "aviso");
      return aviso === "webhook_no_painel" || aviso === "webhook_nao_desligado" ? { ok: true, aviso } : { ok: true };
    },
    verVerifyToken: async (conexaoId) => {
      try {
        const r = await servidor.verSegredoGerado({ conexao_id: conexaoId, nome: "verifyToken" });
        if (!r?.ok) return recusaDe(r ?? { ok: false });
        return { ok: true, valor: texto(r, "valor") };
      } catch {
        return falha("falha");
      }
    },
    salvarChave: async (finalidade, provedor, modelo, chave) => {
      const r = await chamar("chaves", () => servidor.salvarChaveIA({ finalidade, provedor, modelo, chave }));
      return r.ok ? { ok: true, ultimos4: texto(r as Resposta, "ultimos4") } : (r as FalhaConfiguracao);
    },
    conferirChaveNova: async (provedor, chave) => {
      if (provedor === "groq" || provedor === "elevenlabs") return falha("provedor_nao_permitido");
      try {
        const r = await servidor.listarModelos({ provedor, chave });
        if (!r?.ok) return recusaDe(r ?? { ok: false });
        return { ok: true, ...modelosDe(r) };
      } catch {
        return falha("falha");
      }
    },
    revalidarChave: async (finalidade) => {
      const r = await chamar(finalidade === "voz" ? "voz" : "chaves", () => servidor.revalidarChaveIA({ finalidade }));
      return r.ok ? { ok: true, ...vozConferidaDe(r as Resposta) } : (r as FalhaConfiguracao);
    },
    listarModelosDaChave: async (finalidade) => {
      try {
        const r = await servidor.listarModelosDaChave({ finalidade });
        if (!r?.ok) return recusaDe(r ?? { ok: false });
        return { ok: true, ...modelosDe(r) };
      } catch {
        return falha("falha");
      }
    },
    trocarModelo: async (finalidade, modelo) => {
      const r = await chamar("chaves", () => servidor.trocarModeloIA({ finalidade, modelo }));
      return r.ok ? { ok: true, modelo: texto(r as Resposta, "modelo") || modelo } : (r as FalhaConfiguracao);
    },
    removerChaveAudio: async () => {
      const r = await chamar("chaves", () => servidor.removerChaveIA({ finalidade: "transcricao" }));
      return r.ok ? { ok: true } : (r as FalhaConfiguracao);
    },
    removerChaveVoz: async () => {
      const r = await chamar("chaves", () => servidor.removerChaveIA({ finalidade: "voz" }));
      return r.ok ? { ok: true } : (r as FalhaConfiguracao);
    },
    salvarRitmo: async (espera, teto, lembrete) => {
      // o lembrete só vai quando a tela o manda: quem mexe só no ritmo continua mandando { espera, teto }
      const pedido = lembrete ? { espera, teto, lembrete: { ligado: lembrete.ligado, horas: lembrete.horas } } : { espera, teto };
      const r = await chamar("configuracao", () => servidor.salvarRitmo(pedido));
      if (!r.ok) return r as FalhaConfiguracao;
      const ok = r as Resposta;
      const resultado = {
        ok: true as const,
        espera: typeof ok["espera"] === "number" ? (ok["espera"] as number) : espera,
        teto: typeof ok["teto"] === "number" ? (ok["teto"] as number) : teto,
      };
      if (!lembrete) return resultado;
      // o valor que o servidor gravou (com recuo para o pedido); entra no cache ANTES de devolver,
      // para o interruptor não piscar de volta entre o fim do rascunho e a releitura
      const gravado = lerLembreteDaResposta(ok["lembrete"], lembrete);
      queryClient.setQueryData([...CHAVES.configuracao, "lembrete"], gravado);
      return { ...resultado, lembrete: gravado };
    },
    pedirQr: (gateway, campos, pedir) =>
      pedirEstadoQr(() => servidor.pedirQrConexao({ gateway, campos, pedir })),
    pedirQrGuardada: (pedir) => pedirEstadoQr(() => servidor.pedirQrConexaoGuardada({ pedir })),
    // a lista não grava: não relê nada (como listarModelosDaChave); só o sem_acesso relê o Eu
    listarVozes: async () => {
      let resultado: ResultadoListaVozes;
      try {
        const r = await servidor.listarVozes();
        if (!r || typeof r !== "object") resultado = falhaLista(falha("falha"));
        else if (!r.ok) resultado = falhaLista(recusaDe(r));
        else if (!Array.isArray(r["vozes"])) resultado = falhaLista(falha("falha"));
        else resultado = { ok: true, vozes: vozesDe(r["vozes"] as unknown[]), atual: vozEscolhidaDe(r["atual"]) };
      } catch {
        // nunca o texto cru: pode citar a entrada
        resultado = falhaLista(falha("falha"));
      }
      if (!resultado.ok && resultado.erro === "sem_acesso") void queryClient.invalidateQueries({ queryKey: CHAVES.eu });
      return resultado;
    },
    escolherVoz: async (vozId) => {
      const r = await chamar("configuracao", () => servidor.escolherVoz({ vozId }));
      if (!r.ok) return r as FalhaConfiguracao;
      // os agentes de voz que usam a voz do cartão recebem a nova, sem bloquear (L37); um erro fica
      // no erro_sincronia do agente, que a aba Agentes mostra
      void Promise.resolve(servidor.sincronizarVozLigacao?.())
        .catch(() => undefined)
        .then(() => queryClient.invalidateQueries({ queryKey: CHAVES.ligacoes }));
      return { ok: true, voz: vozEscolhidaDe((r as Resposta)["voz"]) ?? { id: vozId, nome: vozId } };
    },
    salvarModoVoz: async (modo) => {
      const r = await chamar("configuracao", () => servidor.salvarModoVoz({ modo }));
      if (!r.ok) return r as FalhaConfiguracao;
      const volta = (r as Resposta)["modo"];
      return { ok: true, modo: typeof volta === "string" && (MODOS_VOZ as readonly string[]).includes(volta) ? (volta as ModoVoz) : modo };
    },
    // a cópia grava a linha do destino: as chaves são relidas (a chave nunca vem na resposta)
    usarChaveElevenLabs: async (para) => {
      const r = await chamar("chaves", () => comoResposta(servidor.usarChaveElevenLabs({ para })));
      if (!r.ok) return r as FalhaConfiguracao;
      const ok = r as Resposta;
      return { ok: true, ultimos4: ok["copiada"] === true ? texto(ok, "ultimos4") || null : null };
    },
    // como o QR: nada grava no banco, então nada é relido (só o sem_acesso relê o Eu)
    desconectarCelular: async (gateway, campos) => {
      let resultado: ResultadoConfiguracao;
      try {
        const r = await servidor.desconectarCelular({ gateway, campos });
        if (!r || typeof r !== "object") resultado = falha("falha");
        else resultado = r.ok ? { ok: true } : recusaDe(r);
      } catch {
        // nunca o texto cru: pode citar a entrada
        resultado = falha("falha");
      }
      if (!resultado.ok && resultado.erro === "sem_acesso")
        void queryClient.invalidateQueries({ queryKey: CHAVES.eu });
      return resultado;
    },
    // o estado só lê o banco: nada a reler (só o sem_acesso relê o Eu)
    estadoLigacoes: async () => {
      let resultado: ResultadoConfiguracao<{ estado: EstadoLigacoes }>;
      try {
        resultado = comEstado(await servidor.estadoLigacoes());
      } catch {
        resultado = falha("falha");
      }
      if (!resultado.ok && resultado.erro === "sem_acesso") void queryClient.invalidateQueries({ queryKey: CHAVES.eu });
      return resultado;
    },
    ativarLigacoes: async () => comEstado(await chamar("ligacoes", () => servidor.ativarLigacoes())),
    desativarLigacoes: async () => comEstado(await chamar("ligacoes", () => servidor.desativarLigacoes())),
  };
}

/** A resposta das funções das ligações: o estado conferido, ou a recusa (com a frase do servidor). */
function comEstado(r: Resposta | FalhaConfiguracao): ResultadoConfiguracao<{ estado: EstadoLigacoes }> {
  if (!r || typeof r !== "object") return falha("falha");
  // a recusa leva só o código e a frase (nunca o resto do que veio)
  if (!r.ok) {
    const f = r as Record<string, unknown>;
    // a verificação reprovada vem junto: o cartão mostra o que faltou (spec-ligacoes, seção 21)
    const eleg = elegibilidadeDe(f["elegibilidade"]);
    return falha(
      typeof f["erro"] === "string" ? f["erro"] : "falha",
      typeof f["mensagem"] === "string" ? f["mensagem"] : undefined,
      eleg ? { elegibilidade: eleg } : {},
    );
  }
  const estado = estadoLigacoesDe((r as Resposta)["estado"]);
  return estado ? { ok: true, estado } : falha("falha");
}

/* ---------- o hook ---------- */

/** A Configuração lê e age por aqui (só o admin chega à tela: a rota e a casca cuidam). */
export function useDadosConfiguracao(): DadosConfiguracao {
  const modo = useModoDados();
  // o modo não muda enquanto o provedor está montado: o hook de cada modo é sempre o mesmo (como os
  // métodos da FonteDados do ProvedorDados). O do banco precisa do QueryClient; o do exemplo, do
  // ProvedorExemplo: por isso não se chamam os dois.
  return IMPLEMENTACAO[modo]();
}

const IMPLEMENTACAO: Readonly<Record<ModoDados, () => DadosConfiguracao>> = {
  banco: useConfiguracaoBanco,
  exemplo: useConfiguracaoExemplo,
};

function useConfiguracaoBanco(): DadosConfiguracao {
  const dados = useDados();
  const cliente = useClienteDados();
  const queryClient = useQueryClient();
  const servidor = useContext(ServidorConfiguracaoContexto);
  const eu = dados.useEu();
  const chaves = dados.useChaves();
  const configuracao = dados.useConfiguracao();
  const q = useQuery({ ...opcoesConexaoConfiguracao(cliente as ClienteSupabase), enabled: !!cliente });
  const conexao = paraLeitura(q);
  const acoes = useMemo(() => criarAcoesConfiguracaoBanco(servidor, queryClient), [servidor, queryClient]);
  return { modo: "banco", euId: eu.membro.id, conexao, chaves, configuracao, acoes };
}

const espera0 = () => Promise.resolve();

type EstadoParaLigacoes = Pick<EstadoExemplo, "conexao" | "chaves" | "configuracao" | "ligacoes">;

/**
 * As ligações no exemplo: os requisitos saem do estado da demo (a conexão ativa da Meta, a chave da
 * ElevenLabs ativa e a voz escolhida); o endereço conta como publicado, porque a demo não chama a
 * ElevenLabs. Ativa só enquanto a conexão da Meta continua ativa.
 */
export function estadoLigacoesExemplo(e: EstadoParaLigacoes): EstadoLigacoes {
  const c = e.conexao;
  const conexaoMeta = !!c && c.ativa && c.gateway === "meta";
  const kv = e.chaves.find((k) => k.finalidade === "voz");
  const requisitos: RequisitosLigacoes = {
    conexaoMeta,
    chaveVoz: !!kv && kv.provedor === "elevenlabs" && kv.status === "ativa",
    vozEscolhida: !!e.configuracao.voz_id,
    enderecoPublicado: true,
  };
  const ativa = conexaoMeta && !!e.ligacoes;
  return {
    situacao: ativa ? "ativa" : requisitosCumpridos(requisitos) ? "pronta" : "indisponivel",
    requisitos,
    numero: ativa ? (c?.nome ?? null) : null,
    ativadaEm: ativa ? (e.ligacoes?.ativadaEm ?? null) : null,
    pendencias: [],
  };
}

/** O primeiro requisito que falta, como a recusa do servidor; null com todos cumpridos. */
function faltaLigacoes(r: RequisitosLigacoes): FalhaConfiguracao | null {
  if (!r.conexaoMeta) return falha("sem_conexao_meta", "Conecte o WhatsApp oficial da Meta para ativar as ligações.");
  if (!r.chaveVoz) return falha("sem_chave_voz", "Conecte a chave da ElevenLabs no cartão Voz da Nina.");
  if (!r.vozEscolhida) return falha("sem_voz", "Escolha a voz da Nina no cartão Voz da Nina.");
  if (!r.enderecoPublicado)
    return falha(
      "endereco_de_previa",
      "Abra a Nina pelo endereço publicado para ativar as ligações. A prévia muda de endereço e a ElevenLabs não a alcança.",
    );
  return null;
}

/** A frase da Meta sem o limite de 2.000, na demo (a do servidor vem de ligacoes/mensagens.ts). */
const FRASE_LIMITE_EXEMPLO =
  "A Meta ainda não liberou ligações para este número. Ela só libera para empresas com limite de 2.000 conversas por dia, e a sua ainda não chegou lá.";

/** O requisito da Nina de cada item da verificação (os outros a demo dá como cumpridos). */
const REQUISITO_EXEMPLO: Partial<Record<IdItemElegibilidade, keyof RequisitosLigacoes>> = {
  conexao_meta: "conexaoMeta",
  chave_voz: "chaveVoz",
  voz: "vozEscolhida",
  endereco: "enderecoPublicado",
};

/**
 * A verificação da demo (spec-ligacoes, seção 21): os requisitos da Nina como estão no exemplo; na
 * Meta, tudo certo ou o caso comum do número novo, com o limite de 250 ("Simular limite de 250"); a
 * chave da ElevenLabs só se confere com a chave cadastrada.
 */
export function elegibilidadeExemplo(
  limite250: boolean,
  requisitos: RequisitosLigacoes,
  agora = new Date(),
): Elegibilidade {
  const limite = limite250 ? "TIER_250" : "TIER_10K";
  const itens: ItemElegibilidade[] = ITENS_ELEGIBILIDADE.map((id) => {
    const dono = DONO_ITEM_ELEGIBILIDADE[id];
    const req = REQUISITO_EXEMPLO[id];
    if (req) return { id, dono, estado: requisitos[req] ? "ok" : "falta" };
    if (id === "meta_limite") return { id, dono, estado: limite250 ? "falta" : "ok", valor: limite };
    if (id === "meta_numero") return { id, dono, estado: "ok", valor: "AVAILABLE" };
    if (id === "chave_agentes") return { id, dono, estado: requisitos.chaveVoz ? "ok" : "nao_conferido" };
    return { id, dono, estado: "ok" };
  });
  return {
    versao: 1,
    elegivel: itens.every((i) => i.estado === "ok"),
    limiteMeta: limite,
    itens,
    conferidaEm: agora.toISOString(),
  };
}

function useConfiguracaoExemplo(): DadosConfiguracao {
  const dados = useDados();
  const { estado, acoes: ex } = useExemplo();
  const chaves = dados.useChaves();
  const configuracao = dados.useConfiguracao();
  const estadoRef = useRef(estado);
  estadoRef.current = estado;
  /** A última verificação das ligações na demo (null = nunca verificou). */
  const elegRef = useRef<Elegibilidade | null>(null);

  const conexao = useMemo(() => {
    const c = estado.conexao;
    const valor: ConexaoConfiguracao = !c
      ? { conexao: null, desligada: null }
      : c.ativa
        ? { conexao: c, desligada: null }
        : // no exemplo, a conexão inativa é sempre a desligada pela Configuração (trocarConexao(null))
          { conexao: c, desligada: { ator_membro_id: estado.eu.id, em: c.atualizado_em } };
    return pronta(valor);
  }, [estado.conexao, estado.eu.id]);

  const acoes = useMemo<AcoesConfiguracao>(() => {
    const recusado = (r: { ok: boolean; erro?: string }): FalhaConfiguracao => falha(r.erro ?? "sem_acesso");
    const chaveDe = (f: FinalidadeIA) => estadoRef.current.chaves.find((k) => k.finalidade === f) ?? null;
    return {
      salvarConexao: async (gateway, _campos, sim) => {
        await espera0();
        if (sim?.falhar) return falha("credencial_invalida");
        const nome = sim?.nome ?? "";
        const r = ex.trocarConexao({ gateway, nome });
        if (!r.ok) return recusado(r);
        return { ok: true, nome, gateway, urlWebhook: "", verifyToken: null, avisos: [] };
      },
      consertarCampo: async (_campo, _valor, sim) => {
        await espera0();
        if (sim?.falhar) return falha("credencial_invalida");
        const r = ex.simularNina({ tipo: "conexao", status: "conectada", ultimo_erro: null });
        return r.ok ? { ok: true, nome: estadoRef.current.conexao?.nome ?? "" } : recusado(r);
      },
      conferirConexao: async (sim) => {
        await espera0();
        const c = estadoRef.current.conexao;
        if (!c || !c.ativa) return falha("sem_conexao");
        if (sim?.falhar) {
          const qr = c.gateway === "zapi" || c.gateway === "evolution";
          const status: StatusConexao = c.status === "erro" ? "erro" : "desconectada";
          const erro = qr ? "instancia_desconectada" : "credencial_invalida";
          ex.simularNina({ tipo: "conexao", status, ultimo_erro: erro });
          return falha(erro, undefined, { status });
        }
        if (c.status !== "conectada") ex.simularNina({ tipo: "conexao", status: "conectada", ultimo_erro: null });
        return { ok: true, nome: c.nome };
      },
      desconectar: async () => {
        await espera0();
        const r = ex.trocarConexao(null);
        return r.ok ? { ok: true } : recusado(r);
      },
      // o exemplo não guarda segredo: o cartão mostra o lugar do token
      verVerifyToken: async () => falha("nao_encontrado"),
      salvarChave: async (finalidade, provedor, modelo, chave, sim) => {
        await espera0();
        if (sim?.falhar) return falha("chave_invalida");
        const ultimos4 = ultimos4Exemplo(chave);
        const r = ex.trocarChaveIA(finalidade, { provedor, modelo, ultimos4 });
        return r.ok ? { ok: true, ultimos4 } : recusado(r);
      },
      conferirChaveNova: async (provedor, _chave, sim) => {
        await espera0();
        if (sim?.falhar) return falha("chave_invalida");
        return { ok: true, modelos: modelosCurados(provedor), origem: "lista_curada" };
      },
      revalidarChave: async (finalidade, sim) => {
        await espera0();
        const k = chaveDe(finalidade);
        if (!k) return falha("sem_chave");
        if (sim?.falhar) return falha(k.status === "sem_credito" ? "sem_credito" : "chave_invalida");
        const r = ex.simularNina({ tipo: "chave", finalidade, status: "ativa" });
        if (!r.ok) return recusado(r);
        if (finalidade !== "voz") return { ok: true };
        // a voz escolhida é conferida na lista da "conta" do exemplo (P12)
        const id = estadoRef.current.configuracao.voz_id ?? null;
        return { ok: true, voz: !id ? "sem_voz" : VOZES_EXEMPLO.some((v) => v.id === id) ? "ok" : "nao_encontrada" };
      },
      listarModelosDaChave: async (finalidade) => {
        await espera0();
        const k = chaveDe(finalidade);
        if (!k) return falha("sem_chave");
        return { ok: true, modelos: modelosCurados(k.provedor), origem: "lista_curada" };
      },
      trocarModelo: async (finalidade, modelo) => {
        await espera0();
        const k = chaveDe(finalidade);
        if (!k) return falha("sem_chave");
        const r = ex.trocarChaveIA(finalidade, { provedor: k.provedor, modelo, ultimos4: k.ultimos4 ?? "" });
        return r.ok ? { ok: true, modelo } : recusado(r);
      },
      removerChaveAudio: async () => {
        await espera0();
        if (!chaveDe("transcricao")) return falha("sem_chave");
        const r = ex.trocarChaveIA("transcricao", null);
        return r.ok ? { ok: true } : recusado(r);
      },
      removerChaveVoz: async () => {
        await espera0();
        if (!chaveDe("voz")) return falha("sem_chave");
        const r = ex.trocarChaveIA("voz", null);
        return r.ok ? { ok: true } : recusado(r);
      },
      salvarRitmo: async (espera, teto, lembrete) => {
        await espera0();
        const r = ex.salvarRitmo(espera, teto, lembrete);
        if (!r.ok) return recusado(r);
        return lembrete ? { ok: true, espera, teto, lembrete } : { ok: true, espera, teto };
      },
      // a demo não inventa QR: o celular "conecta" na hora
      pedirQr: async () => {
        await espera0();
        return { ok: true, conectado: true, qr: null, passkey: false };
      },
      pedirQrGuardada: async () => {
        await espera0();
        return { ok: true, conectado: true, qr: null, passkey: false };
      },
      // a "conta" do exemplo tem 3 vozes sem prévia: a demo não toca áudio inventado (P18)
      listarVozes: async () => {
        await espera0();
        if (!chaveDe("voz")) return falhaLista(falha("sem_chave"));
        const cfg = estadoRef.current.configuracao;
        const atual = cfg.voz_id ? { id: cfg.voz_id, nome: cfg.voz_nome || cfg.voz_id } : null;
        return { ok: true, vozes: [...VOZES_EXEMPLO], atual };
      },
      escolherVoz: async (vozId) => {
        await espera0();
        if (!chaveDe("voz")) return falha("sem_chave");
        const v = VOZES_EXEMPLO.find((x) => x.id === vozId);
        if (!v) return falha("voz_nao_encontrada", "A voz escolhida não existe mais na conta. Escolha outra voz.");
        const r = ex.escolherVoz({ id: v.id, nome: v.nome });
        return r.ok ? { ok: true, voz: { id: v.id, nome: v.nome } } : recusado(r);
      },
      salvarModoVoz: async (modo) => {
        await espera0();
        const r = ex.salvarModoVoz(modo);
        return r.ok ? { ok: true, modo } : recusado(r);
      },
      // a "cópia" do exemplo: o destino ganha os 4 últimos da origem (o exemplo não guarda chave)
      usarChaveElevenLabs: async (para) => {
        await espera0();
        const origem = chaveDe(para === "voz" ? "transcricao" : "voz");
        // a origem sem os 4 últimos não tem chave (P5): nada se grava, e o null do T1 ("nada copiado")
        // não aparece com uma linha nova no destino
        if (!origem || origem.provedor !== "elevenlabs" || origem.status === "removida" || !origem.ultimos4)
          return falha("sem_chave");
        const ultimos4 = origem.ultimos4;
        const r = ex.trocarChaveIA(para, {
          provedor: "elevenlabs",
          modelo: para === "transcricao" ? "scribe_v2" : "",
          ultimos4,
        });
        return r.ok ? { ok: true, ultimos4 } : recusado(r);
      },
      desconectarCelular: async () => {
        await espera0();
        return { ok: true };
      },
      // as ligações da demo (spec-ligacoes, 2.7): os requisitos vêm do estado do exemplo, sem rede
      // a última verificação da demo fica nesta sessão da tela (o servidor a grava na conexão)
      estadoLigacoes: async () => {
        await espera0();
        return { ok: true, estado: { ...estadoLigacoesExemplo(estadoRef.current), elegibilidade: elegRef.current } };
      },
      ativarLigacoes: async (sim) => {
        await espera0();
        const antes = estadoLigacoesExemplo(estadoRef.current);
        if (antes.situacao === "ativa") return falha("ja_ativa", "As ligações já estão ativas neste número.");
        // sem a conexão da Meta não há número para verificar
        if (!antes.requisitos.conexaoMeta) return faltaLigacoes(antes.requisitos)!;
        // a verificação vem antes de tudo: reprovada, nada é criado (como no servidor, a lista vem
        // inteira mesmo com um requisito da Nina faltando)
        const eleg = elegibilidadeExemplo(!!sim?.falhar, antes.requisitos);
        elegRef.current = eleg;
        if (!eleg.elegivel) {
          if (sim?.falhar) return falha("meta_limite", FRASE_LIMITE_EXEMPLO, { elegibilidade: eleg });
          const faltou = faltaLigacoes(antes.requisitos);
          return faltou ? { ...faltou, elegibilidade: eleg } : falha("nao_elegivel", undefined, { elegibilidade: eleg });
        }
        const r = ex.trocarLigacoes(true);
        if (!r.ok) return recusado(r);
        // o estado do exemplo só muda no próximo render: o resultado sai daqui (a data é a de agora)
        return {
          ok: true,
          estado: {
            ...antes,
            situacao: "ativa",
            elegibilidade: eleg,
            numero: estadoRef.current.conexao?.nome ?? null,
            ativadaEm: new Date().toISOString(),
          },
        };
      },
      desativarLigacoes: async (sim) => {
        await espera0();
        const antes = estadoLigacoesExemplo(estadoRef.current);
        // a demo desmonta tudo na hora; "Simular falha" deixa o tronco para o "Tentar de novo"
        if (sim?.falhar && antes.situacao === "ativa")
          return { ok: true, estado: { ...antes, situacao: "com_pendencias", pendencias: ["tronco"] } };
        const r = ex.trocarLigacoes(false);
        if (!r.ok) return recusado(r);
        const req = antes.requisitos;
        return {
          ok: true,
          estado: {
            ...antes,
            situacao: requisitosCumpridos(req) ? "pronta" : "indisponivel",
            elegibilidade: elegRef.current,
            numero: null,
            ativadaEm: null,
            pendencias: [],
          },
        };
      },
    };
  }, [ex]);

  return { modo: "exemplo", euId: estado.eu.id, conexao, chaves, configuracao, acoes };
}
