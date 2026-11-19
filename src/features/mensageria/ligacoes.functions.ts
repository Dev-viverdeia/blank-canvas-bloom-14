// Funções de servidor da área Ligações (2.2), só admin. As leituras
// (histórico, agentes e limites) são da tela, pela RLS; ativar e desativar continuam em
// configuracao.functions.ts. Uso no navegador:
//   await criarAgenteLigacao({ data: { campos } })               → { ok: true, id }
//   await salvarAgenteLigacao({ data: { agenteId, campos } })    → { ok: true, id }
//   await apagarAgenteLigacao({ data: { agenteId } })            → { ok: true, id }
//   await atenderAgenteLigacao({ data: { agenteId } })           → { ok: true, id }
//   await atualizarAgentesLigacao({ data: {} })                  → { ok: true }
//   await sincronizarContextoLigacao({ data: {} })               → { ok: true } (depois de salvar o Contexto)
//   await sincronizarVozLigacao({ data: {} })                    → { ok: true } (depois de escolher a voz)
//   await salvarLimitesLigacoes({ data: { limites } })           → { ok: true }
//   await adotarAgenteDoTronco({ data: {} })                     → { ok: true, id? } (ao abrir a área, L43)
// Falha: { ok: false, erro, mensagem }; sem admin, { ok: false, erro: "sem_acesso", mensagem }.
// campos: { nome, objetivo, instrucoes, regrasEquipe, vozId, vozNome, perfil, saudacao,
// duracaoMaxS, silencioS }; limites: { simultaneas, porDia, porContato }. A lógica fica em
// configuracao/agentes-ligacao.server.ts, que entra por import() dentro do handler.
import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import { lerEntradaVazia } from "./configuracao.functions";

/**
 * O pedido chegou pela prévia (ou pelo localhost)? Lá roda o código da prévia, e o agente de voz é
 * o mesmo do endereço publicado: a prévia nunca mexe nele (a lógica salva no banco e devolve
 * endereco_de_previa). Vale a URL do pedido (o servidor que roda o código) ou o cabeçalho Origin.
 */
async function pedidoDaPrevia(): Promise<boolean> {
  const { getRequest } = await import("@tanstack/react-start/server");
  const { ehOrigemDePrevia } = await import("./nucleo/origem");
  const req = getRequest();
  const origem = req.headers.get("origin") ?? "";
  return ehOrigemDePrevia(new URL(req.url).origin) || (origem !== "" && ehOrigemDePrevia(origem));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function objeto(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Pedido inválido.");
  return v as Record<string, unknown>;
}

export function lerEntradaAgente(entrada: unknown): { agenteId: string } {
  const id = objeto(entrada)["agenteId"];
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("Pedido inválido.");
  return { agenteId: id };
}

/** Os campos seguem como vieram: a lógica confere cada um e devolve o texto do problema. */
export function lerEntradaCampos(entrada: unknown): { campos: Record<string, unknown> } {
  return { campos: objeto(objeto(entrada)["campos"]) };
}

export function lerEntradaSalvarAgente(entrada: unknown): {
  agenteId: string;
  campos: Record<string, unknown>;
} {
  return { ...lerEntradaAgente(entrada), ...lerEntradaCampos(entrada) };
}

export function lerEntradaLimites(entrada: unknown): { limites: Record<string, unknown> } {
  return { limites: objeto(objeto(entrada)["limites"]) };
}

export const criarAgenteLigacao = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((entrada: { campos: Record<string, unknown> }) => lerEntradaCampos(entrada))
  .handler(async ({ data, context }) => {
    const { criarAgenteLigacaoLogica } = await import("./configuracao/agentes-ligacao.server");
    return criarAgenteLigacaoLogica(
      { supabase: context.supabase, userId: context.userId, naPrevia: await pedidoDaPrevia() },
      data.campos,
    );
  });

export const salvarAgenteLigacao = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((entrada: { agenteId: string; campos: Record<string, unknown> }) =>
    lerEntradaSalvarAgente(entrada),
  )
  .handler(async ({ data, context }) => {
    const { salvarAgenteLigacaoLogica } = await import("./configuracao/agentes-ligacao.server");
    return salvarAgenteLigacaoLogica(
      { supabase: context.supabase, userId: context.userId, naPrevia: await pedidoDaPrevia() },
      data.agenteId,
      data.campos,
    );
  });

export const apagarAgenteLigacao = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((entrada: { agenteId: string }) => lerEntradaAgente(entrada))
  .handler(async ({ data, context }) => {
    const { apagarAgenteLigacaoLogica } = await import("./configuracao/agentes-ligacao.server");
    return apagarAgenteLigacaoLogica(
      { supabase: context.supabase, userId: context.userId, naPrevia: await pedidoDaPrevia() },
      data.agenteId,
    );
  });

export const atenderAgenteLigacao = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((entrada: { agenteId: string }) => lerEntradaAgente(entrada))
  .handler(async ({ data, context }) => {
    const { atenderAgenteLigacaoLogica } = await import("./configuracao/agentes-ligacao.server");
    return atenderAgenteLigacaoLogica(
      { supabase: context.supabase, userId: context.userId, naPrevia: await pedidoDaPrevia() },
      data.agenteId,
    );
  });

export const atualizarAgentesLigacao = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((entrada?: Record<string, never>) => lerEntradaVazia(entrada))
  .handler(async ({ context }) => {
    const { atualizarAgentesLigacaoLogica } = await import("./configuracao/agentes-ligacao.server");
    return atualizarAgentesLigacaoLogica({ supabase: context.supabase, userId: context.userId, naPrevia: await pedidoDaPrevia() });
  });

export const sincronizarContextoLigacao = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((entrada?: Record<string, never>) => lerEntradaVazia(entrada))
  .handler(async ({ context }) => {
    const { sincronizarContextoLigacaoLogica } =
      await import("./configuracao/agentes-ligacao.server");
    return sincronizarContextoLigacaoLogica({ supabase: context.supabase, userId: context.userId, naPrevia: await pedidoDaPrevia() });
  });

export const sincronizarVozLigacao = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((entrada?: Record<string, never>) => lerEntradaVazia(entrada))
  .handler(async ({ context }) => {
    const { sincronizarVozLigacaoLogica } = await import("./configuracao/agentes-ligacao.server");
    return sincronizarVozLigacaoLogica({ supabase: context.supabase, userId: context.userId, naPrevia: await pedidoDaPrevia() });
  });

export const salvarLimitesLigacoes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((entrada: { limites: Record<string, unknown> }) => lerEntradaLimites(entrada))
  .handler(async ({ data, context }) => {
    const { salvarLimitesLigacoesLogica } = await import("./configuracao/agentes-ligacao.server");
    return salvarLimitesLigacoesLogica(
      { supabase: context.supabase, userId: context.userId, naPrevia: await pedidoDaPrevia() },
      data.limites,
    );
  });

export const adotarAgenteDoTronco = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((entrada?: Record<string, never>) => lerEntradaVazia(entrada))
  .handler(async ({ context }) => {
    const { adotarAgenteDoTroncoLogica } = await import("./configuracao/agentes-ligacao.server");
    return adotarAgenteDoTroncoLogica({ supabase: context.supabase, userId: context.userId, naPrevia: await pedidoDaPrevia() });
  });
