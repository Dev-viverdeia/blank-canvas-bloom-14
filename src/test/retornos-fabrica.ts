import type { RetornoDados } from "@/features/plataforma/dados/tipos";

// A fábrica dos testes dos retornos (mockup, quadros 1 a 19). Os padrões são
// os do mockup: a Nina marcou na quarta 18/11 às 16:09 um retorno para a quinta 19/11 às 09:00, que
// vale até as 12:00. O lembrete: armado às 09:00, vence às 12:00 e vale até as 20:00. Todos os instantes
// em UTC (Brasília é UTC-3), porque o banco devolve assim.

/** Quarta 18/11/2026, 16:10 em Brasília: um minuto depois de a Nina marcar o retorno do quadro 1. */
export const AGORA_TESTE = Date.parse("2026-11-18T16:10:00-03:00");

/** O instante de um relógio de Brasília ("2026-11-19 09:00") como o ISO que o banco devolve. */
export function emBrasilia(data: string, hora: string): string {
  const hhmmss = hora.length === 5 ? `${hora}:00` : hora;
  return new Date(`${data}T${hhmmss}-03:00`).toISOString();
}

export const MOTIVO_DO_MOCKUP =
  "Retomar a proposta do plano anual, depois da conversa dela com o sócio";

let contador = 0;

/** O retorno combinado do quadro 1 (pendente). Cada chamada tem um id novo, salvo o que o teste passar. */
export function retornoDeTeste(parcial: Partial<RetornoDados> = {}): RetornoDados {
  contador += 1;
  const marcado = emBrasilia("2026-11-18", "16:09");
  return {
    id: `ret-${contador}`,
    conversa_id: "conv-1",
    tipo: "retorno",
    status: "pendente",
    vence_em: emBrasilia("2026-11-19", "09:00"),
    expira_em: emBrasilia("2026-11-19", "12:00"),
    motivo: MOTIVO_DO_MOCKUP,
    marcado_em: marcado,
    rodada_origem_id: "rod-origem",
    rodada_id: null,
    fechado_por_rodada: null,
    substitui_id: null,
    nao_enviado_motivo: null,
    nota_fim: null,
    cancelado_por: null,
    enviado_em: null,
    resolvido_em: null,
    criado_em: marcado,
    ...parcial,
  };
}

/** O lembrete do quadro 3 (pendente): armado às 09:00 de quarta, vence às 12:00 e vale até as 20:00. */
export function lembreteDeTeste(parcial: Partial<RetornoDados> = {}): RetornoDados {
  contador += 1;
  const marcado = emBrasilia("2026-11-18", "09:00");
  return {
    id: `lem-${contador}`,
    conversa_id: "conv-1",
    tipo: "lembrete",
    status: "pendente",
    vence_em: emBrasilia("2026-11-18", "12:00"),
    expira_em: emBrasilia("2026-11-18", "20:00"),
    motivo: null,
    marcado_em: marcado,
    rodada_origem_id: "rod-pergunta",
    rodada_id: null,
    fechado_por_rodada: null,
    substitui_id: null,
    nao_enviado_motivo: null,
    nota_fim: null,
    cancelado_por: null,
    enviado_em: null,
    resolvido_em: null,
    criado_em: marcado,
    ...parcial,
  };
}
