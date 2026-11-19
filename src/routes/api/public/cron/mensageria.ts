// Worker da mensageria (spec da mensageria, premissa "Worker" e "Resultado da prova"; e
// "A rota"): chamado pelo toque do motor (o banco, com net.http_post e
// o cabeçalho x-nina-motor) ou por um Job gerenciado do Lovable (o Bearer do LOVABLE_CRON_SECRET).
// Quem chama não espera a resposta, mas a rota segue rodando (o Lovable a corta entre 50 e 60 s).
// Por isso ela responde só depois de rodar: confere quem chamou e roda o laço de passadas com
// orçamento de 45 s (ORCAMENTO_LACO_MS, no ciclo), contado da 1ª linha do handler, como o corte do
// Lovable.
// - Com o cabeçalho x-nina-motor, a chave decide (errada = 401); sem ele, o Bearer do Lovable.
// - A cada chamada autenticada, grava configuracao.worker_visto_em (o sinal que a Saúde lê) e
//   prepara a cópia do remix (prepararCopia), ao mesmo tempo que o laço roda, sem esperá-los
//   antes: a falha só vai para o log.
// - Depois do laço, espera fechar a janela do "recente" (esperarJanelaDoToque: o webhook que chegou
//   no fim do laço ocioso levou "recente" e contou com esta chamada), lê as pendências e pede outro
//   toque quando ainda há trabalho perto (deveRenovarToque). Devolve { ...resumo, toque, presas } (toque: o
//   resultado do pedido, ou null quando não pediu).
// - Tudo depois do laço (a espera da janela, a leitura das pendências e o toque) termina até o
//   limite duro (inicioEm + 45 s + 5 s): a espera para 3 s antes dele (numa partida a frio, o
//   vistoEm vem segundos depois do inicioEm); com pouco tempo, a leitura das pendências é pulada e a
//   regra decide só pelo trabalho achado; o teto do toque é o que sobra, e com menos de 500 ms ele
//   não sai (toque: "sem_tempo" na resposta).
// - No trecho final do laço, com trabalho perto, a chamada passa o bastão (motor.passarBastao):
//   pede a sucessora e responde já, porque o pg_net só despacha o pedido seguinte quando este
//   responde ("A parada do worker").
import { createFileRoute } from "@tanstack/react-router";

import type { ResultadoPresas } from "@/features/mensageria/ligacoes/presas.server";
import { FOLGA_CORTE_MS } from "@/features/mensageria/nucleo/prazo";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

/**
 * O prazo da conferência das ligações presas, contado do início da chamada: ela corre junto com o
 * laço (até 5 consultas de 5 s à ElevenLabs) e nenhuma consulta começa sem caber nele.
 */
const PRAZO_PRESAS_MS = 30_000;

/** Teto da leitura das pendências depois do laço (o laço já gastou ~45 s dos 50). */
const TETO_PENDENCIAS_MS = 2_000;
/** Com menos que isto até o limite duro, a leitura das pendências é pulada. */
const MIN_PENDENCIAS_MS = 1_500;
/** O que a leitura das pendências deixa para o toque, dentro do que sobra. */
const RESERVA_DEPOIS_PENDENCIAS_MS = 1_000;
/** O que a espera da janela deixa até o limite duro: a leitura inteira (2 s) e 1 s para o toque. */
const RESERVA_DEPOIS_ESPERA_MS = TETO_PENDENCIAS_MS + RESERVA_DEPOIS_PENDENCIAS_MS;
/** Com menos que isto até o limite duro, o toque de renovação não sai. */
const MIN_TOQUE_MS = 500;

export const Route = createFileRoute("/api/public/cron/mensageria")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // antes da autenticação e do import do ciclo, que numa partida a frio leva tempo
        const inicioEm = Date.now();
        const chave = request.headers.get("x-nina-motor");
        if (chave !== null) {
          const { conferirChaveDoMotor } =
            await import("@/features/mensageria/nucleo/motor.server");
          if (!(await conferirChaveDoMotor(chave))) {
            return new Response("Unauthorized", { status: 401 });
          }
        } else {
          const negado = await authenticateCronRequest(request);
          if (negado) return negado;
        }

        const [{ rodarLaco, achouTrabalho, ORCAMENTO_LACO_MS }, { marcarWorkerVisto }, motor] =
          await Promise.all([
            import("@/features/mensageria/nucleo/ciclo.server"),
            import("@/features/mensageria/nucleo/banco.server"),
            import("@/features/mensageria/nucleo/motor.server"),
          ]);
        // não espera antes do laço; marcarWorkerVisto e prepararCopia nunca lançam (a falha vai
        // para o log)
        const vistoEm = Date.now();
        const visto = marcarWorkerVisto(new Date(vistoEm)).catch(() => false);
        const preparo = motor.prepararCopia().catch(() => "falhou" as const);
        // as ligações presas em "em andamento" (ligacoes/presas.server.ts): junto com o laço, com
        // prazo; nunca derrubam a rota
        const presas: Promise<ResultadoPresas> = import(
          "@/features/mensageria/ligacoes/presas.server"
        )
          .then((p) => p.fecharLigacoesPresas({ fimEm: inicioEm + PRAZO_PRESAS_MS }))
          .catch(() => "falhou" as const);
        // nos últimos ~22 s, pede a próxima chamada já se há trabalho perto (a parada do worker)
        const resumo = await rodarLaco({ inicioEm, passarBastao: motor.passarBastao });
        await Promise.all([visto, preparo]);
        // bastão passado: a sucessora está na fila do pg_net, que só a despacha quando esta
        // chamada responder. Responde já, sem a espera da janela, a leitura e a renovação.
        if (resumo.bastao) {
          // a sucessora confere as presas de novo: estas seguem depois da resposta, sem atrasá-la
          const { emSegundoPlano } = await import("@/lib/segundo-plano");
          emSegundoPlano(presas);
          return Response.json({ ...resumo, toque: null, presas: "segundo_plano" });
        }
        const presasFeito = await presas;
        // o laço ocioso acaba em ~38 s; a janela do "recente" vai até vistoEm + 40 s, mas a espera
        // nunca passa do limite duro menos a leitura e o toque
        const limite = inicioEm + ORCAMENTO_LACO_MS + FOLGA_CORTE_MS;
        await motor.esperarJanelaDoToque(vistoEm, limite - RESERVA_DEPOIS_ESPERA_MS);

        const resta = limite - Date.now();
        const pendencias =
          resta < MIN_PENDENCIAS_MS
            ? null
            : await motor.comTeto(
                motor.pendenciasDoMotor(),
                Math.min(TETO_PENDENCIAS_MS, resta - RESERVA_DEPOIS_PENDENCIAS_MS),
                null,
              );
        let toque: Awaited<ReturnType<typeof motor.acordarMotor>> | "sem_tempo" | null = null;
        if (motor.deveRenovarToque(pendencias, achouTrabalho(resumo))) {
          const restaToque = limite - Date.now();
          // sem tempo para o toque, não pede: a resposta registra (o próximo acontecimento acorda)
          toque =
            restaToque < MIN_TOQUE_MS
              ? "sem_tempo"
              : await motor.acordarMotor(null, {
                  renovar: true,
                  tetoMs: Math.min(motor.TETO_TOQUE_MS, restaToque),
                });
        }
        return Response.json({ ...resumo, toque, presas: presasFeito });
      },
    },
  },
});
