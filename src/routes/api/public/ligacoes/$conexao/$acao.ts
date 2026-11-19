// Rotas que a ElevenLabs chama durante uma ligação pelo WhatsApp (2.2):
// início, a ferramenta "passar para a equipe" e o pós-chamada. Só POST. A lógica fica no
// servidor e é carregada aqui dentro.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/ligacoes/$conexao/$acao")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { processarLigacao } = await import("@/features/mensageria/ligacoes/rotas.server");
        return processarLigacao(request, params.conexao, params.acao);
      },
    },
  },
});
