// Trabalho que continua depois da resposta (medido na Nina vitrine em 13/11/2026): na Cloudflare, uma
// promessa solta é cortada quando a resposta sai; com o ctx.waitUntil da requisição, ela segue até
// terminar (até 30 s depois da resposta). O src/server.ts guarda o ctx de cada requisição num
// AsyncLocalStorage (o mesmo mecanismo que o TanStack Start usa para o evento da requisição), e
// emSegundoPlano o acha de qualquer ponto do servidor. Sem ctx (testes, Node), a promessa só corre.
import { AsyncLocalStorage } from "node:async_hooks";

type ContextoExecucao = { waitUntil?: (p: Promise<unknown>) => void } | null | undefined;

const CHAVE = Symbol.for("nina:contexto-execucao");
const global = globalThis as unknown as Record<symbol, AsyncLocalStorage<ContextoExecucao>>;
if (!global[CHAVE]) global[CHAVE] = new AsyncLocalStorage<ContextoExecucao>();
const armazem = global[CHAVE];

/** Roda `fn` com o ctx da requisição à mão para emSegundoPlano. */
export function comContextoDeExecucao<T>(ctx: unknown, fn: () => T): T {
  return armazem.run(ctx as ContextoExecucao, fn);
}

/** Segura a promessa até ela terminar, mesmo depois da resposta. Nunca lança. */
export function emSegundoPlano(p: Promise<unknown>): void {
  const segura = p.catch(() => undefined);
  try {
    armazem.getStore()?.waitUntil?.(segura);
  } catch {
    // sem waitUntil que funcione: a promessa corre enquanto a instância viver
  }
}
