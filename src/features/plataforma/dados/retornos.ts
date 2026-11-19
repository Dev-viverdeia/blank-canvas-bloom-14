import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { CHAVES } from "./chaves";
import { COLUNAS_RETORNO, lerTodas, type ClienteSupabase } from "./colunas";
import { recusado } from "./erros";
import { paraLeitura, pronta } from "./leitura";
import { RELER_SEM_TEMPO_REAL_MS, repetirSoFalha } from "./leituras";
import { useClienteDados, useModoDados } from "./ProvedorDados";
import type { AjusteLembrete, Leitura, Resultado, RetornoDados } from "./tipos";
import { useExemplo } from "../exemplo/ProvedorExemplo";
import type { ResultadoExemplo } from "../exemplo/tipos";

// Os retornos e os lembretes da Nina vistos pelas telas (// 3.4 e 3.5). A tela lê e age só por aqui:
// - `useRetornos(conversaId)`: as linhas da conversa, em duas consultas (o retorno combinado, em
//   qualquer estado; o lembrete, só pendente e enviado). A tabela `retornos` NÃO está no tempo real:
//   a raiz `CHAVES.retornos` fica velha quando `rodadas` ou `mensagens` mudam (POR_TABELA), e a
//   leitura relê a cada 60 s enquanto houver retorno aberto (o relógio do banco fecha sem avisar);
// - `useAjusteLembrete(habilitado)`: o interruptor e as horas do lembrete, numa consulta própria;
// - `useCancelarRetorno()`: o cancelar da equipe (a rpc `cancelar_retorno`), que serve aos dois tipos
//   e SEMPRE relê depois, deu certo ou não ("já saiu" e falha também).
// No modo exemplo (os testes): o estado em memória, com a ação do reducer. Nenhum retorno semeado.

/** Os estados finais: o retorno some do aberto. Qualquer outro (inclusive `em_rodada` e `saindo`) conta como aberto. */
const STATUS_FINAIS: readonly string[] = ["enviado", "dispensado", "cancelado", "nao_enviado"];

/** O que o banco assume sem a linha de `configuracao` (ou com a coluna torta): ligado, 3 h. */
export const AJUSTE_LEMBRETE_PADRAO: Readonly<AjusteLembrete> = { ligado: true, horas: 3 };

/** Quanto tempo uma leitura de retornos vale antes de ser relida ao montar outra tela. */
const VALE_MS = 15_000;

function exigirCliente(cliente: ClienteSupabase | null, quem: string): ClienteSupabase {
  if (!cliente) throw new Error(`${quem} só funciona no <ProvedorDados fonte="banco">.`);
  return cliente;
}

/** A ordem da conversa: do mais antigo para o mais novo, o id desempata. */
function porCriacao(a: RetornoDados, b: RetornoDados): number {
  const ta = Date.parse(a.criado_em);
  const tb = Date.parse(b.criado_em);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Há retorno combinado ainda aberto (o relógio do banco pode fechá-lo sem aviso). */
function temRetornoAberto(linhas: readonly RetornoDados[] | undefined): boolean {
  return (linhas ?? []).some((r) => r.tipo === "retorno" && !STATUS_FINAIS.includes(r.status));
}

/**
 * Os retornos e lembretes de uma conversa. Duas consultas no mesmo `queryFn`, juntadas e ordenadas:
 * 1. `tipo = 'retorno'`, todos os status;
 * 2. `tipo = 'lembrete'` e `status in ('pendente', 'enviado')`.
 * Chave: `[...CHAVES.retornos, "da-conversa", conversaId]`.
 */
export function opcoesRetornos(cliente: ClienteSupabase, conversaId: string) {
  return queryOptions({
    queryKey: [...CHAVES.retornos, "da-conversa", conversaId] as const,
    queryFn: async (): Promise<RetornoDados[]> => {
      const [retornos, lembretes] = await Promise.all([
        lerTodas<RetornoDados>((de, ate) =>
          cliente
            .from("retornos")
            .select(COLUNAS_RETORNO)
            .eq("conversa_id", conversaId)
            .eq("tipo", "retorno")
            .order("criado_em")
            .order("id")
            .range(de, ate),
        ),
        lerTodas<RetornoDados>((de, ate) =>
          cliente
            .from("retornos")
            .select(COLUNAS_RETORNO)
            .eq("conversa_id", conversaId)
            .eq("tipo", "lembrete")
            .in("status", ["pendente", "enviado"])
            .order("criado_em")
            .order("id")
            .range(de, ate),
        ),
      ]);
      return [...retornos, ...lembretes].sort(porCriacao);
    },
    staleTime: VALE_MS,
    retry: repetirSoFalha,
    // a tabela não está no tempo real: "não enviado" decidido só pelo relógio e o cancelar de outro
    // membro chegam por esta releitura (e pelo foco da janela). Sem retorno aberto, não relê.
    refetchInterval: (q) => (temRetornoAberto(q.state.data) ? RELER_SEM_TEMPO_REAL_MS : false),
  });
}

/**
 * O ajuste como o banco guarda, campo a campo: o que não tiver o formato certo (nulo, coluna ausente,
 * horas fora de 1 a 23) fica com o padrão daquele campo, sem derrubar o outro.
 */
export function lerAjusteLembrete(data: unknown): AjusteLembrete {
  const o = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const ligado = o["lembrete_ligado"];
  const horas = o["lembrete_horas"];
  return {
    ligado: typeof ligado === "boolean" ? ligado : AJUSTE_LEMBRETE_PADRAO.ligado,
    horas:
      typeof horas === "number" && Number.isInteger(horas) && horas >= 1 && horas <= 23
        ? horas
        : AJUSTE_LEMBRETE_PADRAO.horas,
  };
}

/**
 * O ajuste do lembrete, numa consulta própria (COLUNAS_CONFIGURACAO não muda: uma coluna com defeito
 * esconde só o bloco do lembrete). Fica embaixo de `CHAVES.configuracao`, então salvar o ritmo já a
 * relê; a tabela não está no tempo real, então relê a cada 60 s e no foco.
 */
export function opcoesAjusteLembrete(cliente: ClienteSupabase) {
  return queryOptions({
    queryKey: [...CHAVES.configuracao, "lembrete"] as const,
    queryFn: async (): Promise<AjusteLembrete> => {
      const { data, error } = await cliente
        .from("configuracao")
        .select("lembrete_ligado, lembrete_horas")
        .eq("id", 1)
        .maybeSingle();
      if (error) throw error;
      return lerAjusteLembrete(data);
    },
    staleTime: VALE_MS,
    retry: repetirSoFalha,
    refetchInterval: RELER_SEM_TEMPO_REAL_MS,
    refetchOnWindowFocus: "always",
  });
}

/* ---------- o modo exemplo ---------- */

/**
 * O que a T10 acrescenta ao exemplo (`estado.retornos`, `estado.lembrete` e a ação `cancelarRetorno`).
 * Lido por este tipo local, de forma opcional, para valer antes e depois dela.
 */
interface ExtrasRetornos {
  retornos?: readonly RetornoDados[];
  lembrete?: AjusteLembrete;
}
type CancelarNoExemplo = (retornoId: string) => ResultadoExemplo;

function useRetornosExemplo(conversaId: string | null | undefined): Leitura<RetornoDados[]> {
  const { estado } = useExemplo();
  const retornos = (estado as ExtrasRetornos).retornos;
  return useMemo(() => {
    if (!conversaId) return pronta<RetornoDados[]>([]);
    const linhas = (retornos ?? []).filter(
      (r) =>
        r.conversa_id === conversaId &&
        (r.tipo === "retorno" || r.status === "pendente" || r.status === "enviado"),
    );
    return pronta([...linhas].sort(porCriacao));
  }, [retornos, conversaId]);
}

function useAjusteExemplo(habilitado: boolean): Leitura<AjusteLembrete> {
  const { estado } = useExemplo();
  const lembrete = (estado as ExtrasRetornos).lembrete;
  return useMemo(
    () =>
      habilitado
        ? pronta<AjusteLembrete>(lembrete ?? { ...AJUSTE_LEMBRETE_PADRAO })
        : { ...pronta<AjusteLembrete>(AJUSTE_LEMBRETE_PADRAO), dados: undefined },
    [habilitado, lembrete],
  );
}

function useCancelarExemplo(): (retornoId: string) => Promise<Resultado> {
  const { acoes } = useExemplo();
  return useCallback(
    async (retornoId) => {
      const cancelar = (acoes as { cancelarRetorno?: CancelarNoExemplo }).cancelarRetorno;
      if (typeof cancelar !== "function") return { ok: false, erro: "falha" };
      const r = cancelar(retornoId);
      return r.ok ? { ok: true } : recusado(r);
    },
    [acoes],
  );
}

/* ---------- o modo banco ---------- */

function useRetornosBanco(conversaId: string | null | undefined): Leitura<RetornoDados[]> {
  const cliente = exigirCliente(useClienteDados(), "useRetornos()");
  const q = useQuery({ ...opcoesRetornos(cliente, conversaId ?? ""), enabled: !!conversaId });
  const leitura = paraLeitura(q);
  const vazia = useMemo(() => pronta<RetornoDados[]>([]), []);
  return conversaId ? leitura : vazia;
}

function useAjusteBanco(habilitado: boolean): Leitura<AjusteLembrete> {
  const cliente = exigirCliente(useClienteDados(), "useAjusteLembrete()");
  const q = useQuery({ ...opcoesAjusteLembrete(cliente), enabled: habilitado });
  const leitura = paraLeitura(q);
  // uma consulta desligada fica "pendente" para sempre: a leitura não carrega nem falha
  const desligada = useMemo<Leitura<AjusteLembrete>>(
    () => ({ dados: undefined, carregando: false, erro: null, tentarDeNovo: () => {} }),
    [],
  );
  return habilitado ? leitura : desligada;
}

/**
 * O cancelar da equipe, para o retorno ou para o lembrete (a linha tem o tipo). Nunca lança. Relê
 * `retornos` SEMPRE: no ok, no "já saiu" (`retorno_nao_pendente`) e na falha; a promessa só resolve
 * depois da releitura, para o "Cancelando…" durar até a lista nova voltar. Quem perdeu o acesso
 * (`sem_acesso`) também relê o Eu. A permissão é do banco: atendente e admin cancelam.
 */
function useCancelarBanco(): (retornoId: string) => Promise<Resultado> {
  const cliente = exigirCliente(useClienteDados(), "useCancelarRetorno()");
  const qc = useQueryClient();
  return useCallback(
    async (retornoId) => {
      let r: Resultado;
      try {
        const { error } = await cliente.rpc("cancelar_retorno", { p_retorno: retornoId });
        r = error ? recusado(error) : { ok: true };
      } catch (e) {
        r = recusado(e);
      }
      await qc.invalidateQueries({ queryKey: CHAVES.retornos });
      if (!r.ok && r.erro === "sem_acesso") void qc.invalidateQueries({ queryKey: CHAVES.eu });
      return r;
    },
    [cliente, qc],
  );
}

/* ---------- o que a tela usa ---------- */

const LER = { banco: useRetornosBanco, exemplo: useRetornosExemplo } as const;
const AJUSTE = { banco: useAjusteBanco, exemplo: useAjusteExemplo } as const;
const CANCELAR = { banco: useCancelarBanco, exemplo: useCancelarExemplo } as const;

/** Os retornos e lembretes da conversa (todo membro lê). Sem conversa: lista vazia, sem ir ao banco. */
export function useRetornos(conversaId: string | null | undefined): Leitura<RetornoDados[]> {
  return LER[useModoDados()](conversaId);
}

/** O ajuste do lembrete (todo membro lê). `habilitado = false` não vai ao banco e não fica carregando. */
export function useAjusteLembrete(habilitado = true): Leitura<AjusteLembrete> {
  return AJUSTE[useModoDados()](habilitado);
}

/** O cancelar da equipe: o retorno ou o lembrete pelo id. Devolve `retorno_nao_pendente` se já saiu. */
export function useCancelarRetorno(): (retornoId: string) => Promise<Resultado> {
  return CANCELAR[useModoDados()]();
}
