// O estado das ligações no banco (2.1): conexoes.parametros.ligacoes e os
// dois segredos (ligacaoToken e ligacaoHmac) em conexoes.segredos, cifrados como os da Meta.
// Usa o supabaseAdmin (ignora RLS): só entra pela lógica das ligações (ligacoes.server.ts).
//
// O supabase-js não muda uma chave dentro do jsonb: cada escrita lê a linha, junta e grava de
// volta. Gravar nunca apaga as outras chaves de parametros (wabaId, phoneId...) nem os outros
// segredos (os da Meta): os cifrados que já estão lá são copiados como estão (o dado associado é
// o id da linha e o nome do segredo, que não mudam). Toda escrita é uma trava: só vale se a
// linha ainda está como quem escreve a leu (o atualizadaEm de parametros.ligacoes, D21 e D28), e
// pede .select("id"); 0 linhas quer dizer "perdeu" (alguém gravou depois) e volta como false.
// Nenhum erro cita valor de segredo.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";

import { ehObjeto, lerLigacoesGravadas } from "../ligacoes/gravadas";
import {
  CHAVE_ELEGIBILIDADE,
  CHAVE_PARAMETROS,
  SEGREDOS_LIGACOES,
  type Elegibilidade,
  type LigacoesGravadas,
} from "../ligacoes/tipos";
import { aadConexao, cifrar } from "../nucleo/cifra";

export type SegredosLigacoes = Partial<Record<(typeof SEGREDOS_LIGACOES)[number], string>>;

function falhaBanco(operacao: string): Error {
  return new Error(`banco_${operacao}`);
}

type LinhaLida = { parametros: Record<string, unknown>; segredos: Record<string, unknown> };

async function lerLinha(id: string): Promise<LinhaLida> {
  const { data, error } = await supabaseAdmin
    .from("conexoes")
    .select("parametros, segredos")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) throw falhaBanco("ler_conexao");
  return {
    parametros: ehObjeto(data.parametros) ? data.parametros : {},
    segredos: ehObjeto(data.segredos) ? data.segredos : {},
  };
}

async function cifrarNovos(id: string, novos: SegredosLigacoes): Promise<Record<string, string>> {
  const cifrados: Record<string, string> = {};
  for (const [nome, valor] of Object.entries(novos)) {
    if (typeof valor === "string") cifrados[nome] = await cifrar(valor, aadConexao(id, nome));
  }
  return cifrados;
}

/**
 * id da conexão fora da ativa que ainda tem parametros.ligacoes: a desmontagem do Desconectar ou
 * do Trocar que deixou pendências (D15). null = nenhuma.
 */
export async function idConexaoComLigacoesPendentes(): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("conexoes")
    .select("id")
    .eq("ativa", false)
    .not("parametros->ligacoes", "is", null)
    .order("atualizado_em", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw falhaBanco("ler_conexao");
  return data?.id ?? null;
}

/**
 * Alguma conexão (ativa ou não) ainda tem parametros.ligacoes: o agente e o número estão na conta
 * da chave da ElevenLabs guardada, que fica presa até a desativação terminar (D22).
 */
export async function existemLigacoes(): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("conexoes")
    .select("id")
    .not("parametros->ligacoes", "is", null)
    .limit(1);
  if (error) throw falhaBanco("ler_conexao");
  return (data ?? []).length > 0;
}

/**
 * Os agentes das ligações, um por conexão que tem parametros.ligacoes (ativa ou não): null onde a
 * ativação ainda não criou o agente ou a desativação já o apagou. Lista vazia = não há ligações.
 * A troca da chave da voz só passa se a chave nova lê cada um deles (D29).
 */
export async function agentesDasLigacoes(): Promise<(string | null)[]> {
  const { data, error } = await supabaseAdmin
    .from("conexoes")
    .select("parametros")
    .not("parametros->ligacoes", "is", null);
  if (error) throw falhaBanco("ler_conexao");
  return (data ?? []).map(
    (linha) => lerLigacoesGravadas(linha.parametros)?.eleven.agenteId ?? null,
  );
}

/**
 * O atualizadaEm de parametros.ligacoes como a linha está agora: undefined = sem ligações; "" = o
 * estado antigo, sem o campo.
 */
function atualizadaEmDa(parametros: Record<string, unknown>): string | undefined {
  return lerLigacoesGravadas(parametros)?.atualizadaEm;
}

/**
 * A trava das escritas fora da ativação (D28): `anterior` é o atualizadaEm que quem escreve leu
 * (null = leu sem ligações). A conferência em memória poupa o update; o filtro do update fecha a
 * corrida entre a leitura e a escrita.
 */
type Trava = string | null;
function travaConfere(parametros: Record<string, unknown>, anterior: Trava): boolean {
  const atual = atualizadaEmDa(parametros);
  return anterior === null ? atual === undefined : atual === anterior;
}

/**
 * A versão de uma conexão: o atualizado_em, que o gatilho conexoes_atualizado renova a cada
 * update, e o status (a verificação guardada só vale com a conexão conectada).
 */
export type VersaoConexao = { id: string; atualizadoEm: string; status: string };

/**
 * A versão da conexão ativa, lida antes da verificação (seção 21): a gravação do resultado só vale
 * se a linha não mudou desde então. null = não há conexão ativa. Lança se o banco falhar.
 */
export async function lerVersaoConexaoAtiva(): Promise<VersaoConexao | null> {
  const { data, error } = await supabaseAdmin
    .from("conexoes")
    .select("id, atualizado_em, status")
    .eq("ativa", true)
    .maybeSingle();
  if (error) throw falhaBanco("ler_conexao");
  return data ? { id: data.id, atualizadoEm: data.atualizado_em, status: data.status } : null;
}

/** A versão de uma conexão pelo id. null = não existe. Lança se o banco falhar. */
export async function lerVersaoConexao(id: string): Promise<VersaoConexao | null> {
  const { data, error } = await supabaseAdmin
    .from("conexoes")
    .select("id, atualizado_em, status")
    .eq("id", id)
    .maybeSingle();
  if (error) throw falhaBanco("ler_conexao");
  return data ? { id: data.id, atualizadoEm: data.atualizado_em, status: data.status } : null;
}

/**
 * Grava a última verificação (spec seção 21) em parametros.ligacoesElegibilidade, sem mexer no
 * resto de parametros, só se a linha ainda está na `versao` lida antes de conferir: qualquer
 * escrita depois dela (o progresso ou a recusa de uma ativação, o Desconectar, consertar o token,
 * salvar o mesmo número) quer dizer que o resultado pode estar velho, e ele é descartado. Só grava
 * com a conexão ativa e conectada: numa conexão caída, o atualizado_em é a hora da queda que o
 * painel mostra. `seLigacoes` (a recusa tardia de uma ativação) só grava se parametros.ligacoes
 * ainda é o que ela deixou: null = sem ligações; uma string = o atualizadaEm dele. E
 * `seConferidaEm` só grava por cima da verificação guardada com esse conferidaEm (a da própria
 * ativação). false = não gravou. Lança se o banco falhar.
 */
export async function gravarElegibilidade(
  versao: VersaoConexao,
  e: Elegibilidade,
  seLigacoes?: string | null,
  seConferidaEm?: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("conexoes")
    .select("parametros, atualizado_em, ativa, status")
    .eq("id", versao.id)
    .maybeSingle();
  if (error) throw falhaBanco("ler_conexao");
  if (!data || !data.ativa || data.status !== "conectada") return false;
  if (data.atualizado_em !== versao.atualizadoEm) return false;
  const parametros = ehObjeto(data.parametros) ? data.parametros : {};
  if (seLigacoes !== undefined) {
    // só por cima de um estado das ligações conhecido: null = sem ligações; senão, o atualizadaEm
    const l = parametros[CHAVE_PARAMETROS];
    const atual = ehObjeto(l) && typeof l["atualizadaEm"] === "string" ? l["atualizadaEm"] : null;
    if (seLigacoes === null ? CHAVE_PARAMETROS in parametros : atual !== seLigacoes) return false;
  }
  if (seConferidaEm !== undefined) {
    // só por cima da verificação que a própria ativação gravou (outra, mais nova, fica)
    const guardada = parametros[CHAVE_ELEGIBILIDADE];
    if (!ehObjeto(guardada) || guardada["conferidaEm"] !== seConferidaEm) return false;
  }
  const r = await supabaseAdmin
    .from("conexoes")
    .update({ parametros: { ...parametros, [CHAVE_ELEGIBILIDADE]: e } as Json })
    .eq("id", versao.id)
    .eq("ativa", true)
    .eq("status", "conectada")
    .eq("atualizado_em", versao.atualizadoEm)
    .select("id");
  if (r.error) throw falhaBanco("gravar_elegibilidade");
  return (r.data ?? []).length === 1;
}

/**
 * O primeiro passo da ativação: grava o estado "ativando" e o ligacaoToken, só se a conexão ainda
 * está ativa e não tem parametros.ligacoes. false = já tinha (o duplo clique: outra ativação
 * começou antes) ou a conexão saiu.
 */
export async function iniciarLigacoes(
  id: string,
  estado: LigacoesGravadas,
  token: string,
): Promise<boolean> {
  const linha = await lerLinha(id);
  if (CHAVE_PARAMETROS in linha.parametros) return false;
  const novos = await cifrarNovos(id, { ligacaoToken: token });
  const r = await supabaseAdmin
    .from("conexoes")
    .update({
      parametros: { ...linha.parametros, [CHAVE_PARAMETROS]: estado } as Json,
      segredos: { ...linha.segredos, ...novos } as Json,
      atualizado_em: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("ativa", true)
    // a trava do duplo clique: duas ativações ao mesmo tempo, só uma grava
    .is("parametros->ligacoes", null)
    .select("id");
  if (r.error) throw falhaBanco("gravar_ligacoes");
  return (r.data ?? []).length === 1;
}

/**
 * O progresso da ativação (D21): grava o estado (e, se vierem, os segredos novos) só se a conexão
 * continua ativa e na mesma ativação, isto é, ainda "ativando" com o atualizadaEm da gravação
 * anterior. false = perdeu: a conexão foi desconectada ou trocada, ou a ativação foi desmontada
 * (desativar, Tentar de novo) enquanto rodava. Nada é gravado nesse caso.
 */
export async function gravarProgressoLigacoes(
  id: string,
  estado: LigacoesGravadas,
  anterior: string,
  segredos: SegredosLigacoes = {},
): Promise<boolean> {
  const linha = await lerLinha(id);
  const atual = linha.parametros[CHAVE_PARAMETROS];
  if (!ehObjeto(atual) || atual["situacao"] !== "ativando" || atual["atualizadaEm"] !== anterior) {
    return false;
  }
  const novos = await cifrarNovos(id, segredos);
  const campos: { parametros: Json; atualizado_em: string; segredos?: Json } = {
    parametros: { ...linha.parametros, [CHAVE_PARAMETROS]: estado } as Json,
    atualizado_em: new Date().toISOString(),
  };
  if (Object.keys(novos).length > 0) campos.segredos = { ...linha.segredos, ...novos } as Json;
  const r = await supabaseAdmin
    .from("conexoes")
    .update(campos)
    .eq("id", id)
    // a trava: a mesma conexão ativa, na mesma ativação (entre a leitura e a escrita)
    .eq("ativa", true)
    .eq("parametros->ligacoes->>situacao", "ativando")
    .eq("parametros->ligacoes->>atualizadaEm", anterior)
    .select("id");
  if (r.error) throw falhaBanco("gravar_ligacoes");
  return (r.data ?? []).length === 1;
}

/** O update com a trava de `anterior` (D28); devolve se gravou. Lança se o banco falhar. */
async function atualizarComTrava(
  id: string,
  campos: { parametros: Json; atualizado_em: string; segredos?: Json },
  anterior: Trava,
  operacao: string,
): Promise<boolean> {
  let consulta = supabaseAdmin.from("conexoes").update(campos).eq("id", id);
  if (anterior === null) consulta = consulta.is("parametros->ligacoes", null);
  else if (anterior === "") {
    consulta = consulta
      .not("parametros->ligacoes", "is", null)
      .is("parametros->ligacoes->>atualizadaEm", null);
  } else consulta = consulta.eq("parametros->ligacoes->>atualizadaEm", anterior);
  const r = await consulta.select("id");
  if (r.error) throw falhaBanco(operacao);
  return (r.data ?? []).length === 1;
}

/**
 * Grava o estado das ligações, sem mexer no resto da linha, só se ninguém gravou depois de quem
 * escreve ter lido: o atualizadaEm gravado ainda é `anterior` (null = só se não há ligações).
 * false = perdeu, nada gravado (D28). Lança se o banco falhar.
 */
export async function gravarLigacoes(
  id: string,
  estado: LigacoesGravadas,
  anterior: Trava,
): Promise<boolean> {
  const linha = await lerLinha(id);
  if (!travaConfere(linha.parametros, anterior)) return false;
  return atualizarComTrava(
    id,
    {
      parametros: { ...linha.parametros, [CHAVE_PARAMETROS]: estado } as Json,
      atualizado_em: new Date().toISOString(),
    },
    anterior,
    "gravar_ligacoes",
  );
}

/**
 * Tira parametros.ligacoes e os dois segredos das ligações (a desativação terminou), com a mesma
 * trava: só se o atualizadaEm gravado ainda é `anterior`. false = perdeu (D28).
 */
export async function limparLigacoes(id: string, anterior: string): Promise<boolean> {
  const linha = await lerLinha(id);
  if (!travaConfere(linha.parametros, anterior)) return false;
  const parametros = { ...linha.parametros };
  delete parametros[CHAVE_PARAMETROS];
  const segredos = { ...linha.segredos };
  let mudouSegredo = false;
  for (const nome of SEGREDOS_LIGACOES) {
    if (nome in segredos) {
      delete segredos[nome];
      mudouSegredo = true;
    }
  }
  const campos: { parametros: Json; atualizado_em: string; segredos?: Json } = {
    parametros: parametros as Json,
    atualizado_em: new Date().toISOString(),
  };
  if (mudouSegredo) campos.segredos = segredos as Json;
  return atualizarComTrava(id, campos, anterior, "limpar_ligacoes");
}
