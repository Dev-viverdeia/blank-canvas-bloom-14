// Telemetria Viver de IA. Nunca quebra o app.
type ViaProps = Record<string, string | number | boolean>;

declare global {
  interface Window {
    via?: {
      track?: (nome: string, props?: ViaProps, opts?: { value?: boolean }) => void;
      setInstance?: (url: string) => void;
      q?: unknown[][];
    };
  }
}

// Diz à telemetria qual é o backend desta cópia: só a URL, nunca a chave.
// O import é dinâmico: se o cliente Supabase falhar ao iniciar, o app segue como estava.
export function informarBackend(): void {
  if (typeof window === 'undefined') return;
  import('@/integrations/supabase/client')
    .then(({ supabase }) => {
      const cliente = supabase as unknown as { supabaseUrl?: string; rest?: { url?: string } };
      const url = cliente.supabaseUrl ?? cliente.rest?.url;
      if (!url) return;
      if (window.via?.setInstance) window.via.setInstance(url);
      else (window.via ??= { q: [] }).q?.push(['setInstance', url]);
    })
    .catch(() => undefined);
}

// Momento de valor que não grava nada no banco (passo 6).
export function viaValor(nome: string, props: ViaProps = {}): void {
  try {
    if (typeof window !== 'undefined') window.via?.track?.(nome, props, { value: true });
  } catch {
    /* a telemetria nunca quebra o app */
  }
}
