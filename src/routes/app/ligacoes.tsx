import { createFileRoute } from "@tanstack/react-router";

import { CarregandoArea, ESPERA_ESQUELETO_MS } from "@/features/plataforma/AreaVazia";
import { TelaLigacoes } from "@/features/plataforma/ligacoes";

// A área Ligações (2.3): o topo, o Histórico e, para o admin, os Agentes e
// os Ajustes.
export const Route = createFileRoute("/app/ligacoes")({
  component: TelaLigacoes,
  // 1ª visita, com o código da área ainda baixando: o esqueleto dela no lugar da área anterior.
  pendingComponent: () => <CarregandoArea area="ligacoes" />,
  pendingMs: ESPERA_ESQUELETO_MS,
  pendingMinMs: 0,
});
