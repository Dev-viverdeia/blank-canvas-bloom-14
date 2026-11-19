import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ErroGateway, type AdaptadorGateway, type ConexaoServidor } from "./tipos";

// banco.server, conexões, gateways, bucket e IA falsos: aqui só a ordem e as decisões do ciclo.
const m = vi.hoisted(() => ({
  eventosPendentes: vi.fn(),
  marcarEventoProcessado: vi.fn(),
  marcarEventoComErro: vi.fn(),
  pegarMidias: vi.fn(),
  concluirMidia: vi.fn(),
  desistirMidia: vi.fn(),
  gravarTranscricao: vi.fn(),
  pegarRodadas: vi.fn(),
  pegarRodadasComRetornos: vi.fn(),
  falharRodada: vi.fn(),
  pegarEnvios: vi.fn(),
  concluirEnvio: vi.fn(),
  falharEnvio: vi.fn(),
  destinoDoContato: vi.fn(),
  registrarEntrada: vi.fn(),
  registrarSaidaCelular: vi.fn(),
  atualizarStatus: vi.fn(),
  atualizarStatusConexao: vi.fn(),
  gravarEvento: vi.fn(),
  idExternoDaMensagem: vi.fn(),
  carregarConexao: vi.fn(),
  responderRodada: vi.fn(),
  transcrever: vi.fn(),
  garantirBucket: vi.fn(),
  enviarArquivo: vi.fn(),
  urlAssinada: vi.fn(),
  baixarMidia: vi.fn(),
  enviar: vi.fn(),
  traduzir: vi.fn(),
}));

vi.mock("./banco.server", () => ({
  eventosPendentes: m.eventosPendentes,
  marcarEventoProcessado: m.marcarEventoProcessado,
  marcarEventoComErro: m.marcarEventoComErro,
  pegarMidias: m.pegarMidias,
  concluirMidia: m.concluirMidia,
  desistirMidia: m.desistirMidia,
  gravarTranscricao: m.gravarTranscricao,
  pegarRodadas: m.pegarRodadas,
  pegarRodadasComRetornos: m.pegarRodadasComRetornos,
  falharRodada: m.falharRodada,
  pegarEnvios: m.pegarEnvios,
  concluirEnvio: m.concluirEnvio,
  falharEnvio: m.falharEnvio,
  destinoDoContato: m.destinoDoContato,
  registrarEntrada: m.registrarEntrada,
  registrarSaidaCelular: m.registrarSaidaCelular,
  atualizarStatus: m.atualizarStatus,
  atualizarStatusConexao: m.atualizarStatusConexao,
  gravarEvento: m.gravarEvento,
  idExternoDaMensagem: m.idExternoDaMensagem,
}));
vi.mock("./conexoes.server", () => ({ carregarConexao: m.carregarConexao, conexaoAtiva: vi.fn() }));
vi.mock("@/features/mensageria/ia/responder.server", () => ({
  responderRodada: m.responderRodada,
}));
vi.mock("@/features/mensageria/ia/transcrever.server", () => ({ transcrever: m.transcrever }));
vi.mock("./midia.server", async (original) => ({
  ...(await original<typeof import("./midia.server")>()),
  garantirBucket: m.garantirBucket,
  enviarArquivo: m.enviarArquivo,
  urlAssinada: m.urlAssinada,
}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
// a espera entre bolhas avança o relógio falso, sem esperar de verdade
const esperas: number[] = [];
vi.mock("./espera", () => ({
  dormir: async (ms: number) => {
    esperas.push(ms);
    agora += ms;
  },
}));

const adaptador: AdaptadorGateway = {
  gateway: "zapi",
  validarWebhook: async () => true,
  traduzir: (...a) => m.traduzir(...a),
  baixarMidia: (...a) => m.baixarMidia(...a),
  enviar: (...a) => m.enviar(...a),
  marcarLidaEDigitando: async () => {},
  montarConexao: () => {
    throw new Error("nao");
  },
};
vi.mock("../gateways", () => ({ adaptadorDe: (g: string) => (g === "zapi" ? adaptador : null) }));

const { achouTrabalho, MAX_FALHAS_BASTAO, rodarCiclo, rodarLaco } = await import("./ciclo.server");

const CONEXAO = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "22222222-2222-4222-8222-222222222222";
const msgId = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const conexao: ConexaoServidor = {
  id: CONEXAO,
  gateway: "zapi",
  id_externo: "inst",
  parametros: {},
  segredos: {},
  oficial: false,
};

function mensagem(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: msgId(n),
    conversa_id: CONVERSA,
    conexao_id: CONEXAO,
    tipo: "texto",
    texto: "ola",
    midia_ref_externa: null,
    midia_caminho: null,
    midia_mime: null,
    midia_nome: null,
    ...extra,
  };
}

let agora = 0;
/** Um turno real do laço de eventos (o relógio falso, Date.now, não se mexe). */
const tick = () => new Promise<void>((ok) => setTimeout(ok, 0));

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  esperas.length = 0;
  agora = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => agora);
  m.eventosPendentes.mockResolvedValue([]);
  m.pegarMidias.mockResolvedValue([]);
  m.pegarRodadas.mockResolvedValue([]);
  m.pegarRodadasComRetornos.mockResolvedValue([]);
  m.pegarEnvios.mockResolvedValue([]);
  m.carregarConexao.mockResolvedValue(conexao);
  m.destinoDoContato.mockResolvedValue([{ tipo: "telefone", valor: "5511999990000" }]);
  m.baixarMidia.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mime: "audio/ogg" });
  m.transcrever.mockResolvedValue({ erro: "audio_sem_transcricao" });
  m.enviar.mockResolvedValue({ id_externo: "W1", id_gateway: "G1" });
  m.urlAssinada.mockResolvedValue("https://assinada.exemplo/x");
  m.traduzir.mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rodarCiclo", () => {
  it("mídias uma por vez, só com 15 s sobrando: nenhuma pega é devolvida", async () => {
    for (const n of [1, 2, 3]) {
      m.pegarMidias.mockResolvedValueOnce([
        mensagem(n, { tipo: "imagem", midia_ref_externa: "r" }),
      ]);
    }
    m.baixarMidia.mockImplementation(async () => {
      agora += 20_000;
      return { bytes: new Uint8Array([1]), mime: "image/jpeg" };
    });
    const resumo = await rodarCiclo({ orcamentoMs: 45_000 });

    // 0 s: pega; 20 s: pega (sobram 25 s); 40 s: sobram 5 s, não pega mais
    expect(m.pegarMidias).toHaveBeenCalledTimes(2);
    expect(m.pegarMidias).toHaveBeenCalledWith(1);
    expect(m.baixarMidia).toHaveBeenCalledTimes(2);
    expect(m.concluirMidia).toHaveBeenCalledWith(
      msgId(1),
      `${CONVERSA}/${msgId(1)}`,
      "image/jpeg",
      1,
      true,
    );
    expect(m.concluirMidia.mock.calls.some((c) => c[4] === false)).toBe(false);
    expect(m.pegarRodadasComRetornos).not.toHaveBeenCalled();
    expect(m.pegarEnvios).not.toHaveBeenCalled();
    expect(resumo.orcamento_esgotado).toBe(false);
    expect(resumo.midias).toMatchObject({ copiadas: 2, devolvidas: 0 });
  });

  it("no máximo 5 mídias por passada", async () => {
    m.pegarMidias.mockImplementation(async () => [
      mensagem(1, { tipo: "imagem", midia_ref_externa: "r" }),
    ]);
    await rodarCiclo();
    expect(m.pegarMidias).toHaveBeenCalledTimes(5);
  });

  it("envios um por vez: 20 itens que cabem no tempo, nenhum devolvido", async () => {
    let n = 0;
    m.pegarEnvios.mockImplementation(async (limite: number) =>
      Array.from({ length: limite }, () => mensagem(++n)),
    );
    m.enviar.mockImplementation(async () => {
      agora += 1_000;
      return { id_externo: "W", id_gateway: "G" };
    });
    const resumo = await rodarCiclo({ orcamentoMs: 45_000 });
    expect(m.pegarEnvios).toHaveBeenCalledTimes(20);
    expect(m.pegarEnvios.mock.calls.every((c) => c[0] === 1)).toBe(true);
    expect(m.falharEnvio).not.toHaveBeenCalled();
    expect(resumo.envios).toMatchObject({ enviados: 20, devolvidos: 0 });
  });

  it("só pega envio se um texto inteiro (preparo 1,5 s + 10 s + 2 s) termina até fimEm + 5 s", async () => {
    m.pegarEnvios.mockResolvedValue([mensagem(1)]);
    // 8,4 s até o fim: 8,4 + 5 = 13,4 s até o corte, menos que os 13,5 s do envio
    await rodarCiclo({ fimEm: agora + 8_400 });
    expect(m.pegarEnvios).not.toHaveBeenCalled();

    // 8,5 s: cabe exatamente um; depois dele (o relógio anda 1 s), não pega mais
    m.enviar.mockImplementation(async () => {
      agora += 1_000;
      return { id_externo: "W" };
    });
    const resumo = await rodarCiclo({ fimEm: agora + 8_500 });
    expect(m.pegarEnvios).toHaveBeenCalledTimes(1);
    expect(m.falharEnvio).not.toHaveBeenCalled();
    expect(resumo.envios).toMatchObject({ enviados: 1, devolvidos: 0 });
  });

  it("pior caso: gateway lento (10 s cada) perto do fim, nenhum envio começa sem tempo", async () => {
    const inicio = agora;
    const fimEm = inicio + 45_000;
    m.pegarRodadasComRetornos.mockResolvedValueOnce([{ id: "rod-1" }]);
    // a IA gasta todo o tempo dela (até fimEm - 3 s)
    m.responderRodada.mockImplementation(async () => {
      agora = fimEm - 3_000 - 20_000;
    });
    let n = 0;
    m.pegarEnvios.mockImplementation(async () => [mensagem(++n)]);
    const inicios: number[] = [];
    m.enviar.mockImplementation(async (_p: unknown, _c: unknown, o: { fimEm: number }) => {
      expect(o.fimEm).toBe(fimEm);
      inicios.push(agora);
      agora += 10_000; // o teto inteiro do envio de texto
      return { id_externo: "W" };
    });
    m.concluirEnvio.mockImplementation(async () => {
      agora += 1_000; // concluir_envio lento
    });
    const resumo = await rodarCiclo({ fimEm });
    expect(inicios.length).toBeGreaterThan(0);
    // todo envio termina, com o concluir_envio, até o corte (fimEm + 5 s = 50 s)
    for (const t of inicios) expect(t + 10_000 + 2_000).toBeLessThanOrEqual(fimEm + 5_000);
    expect(agora).toBeLessThanOrEqual(fimEm + 5_000);
    expect(m.falharEnvio).not.toHaveBeenCalled();
    expect(resumo.envios.devolvidos).toBe(0);
    expect(resumo.envios.enviados).toBe(inicios.length);
  });

  it("exceção: mídia pega com pouco tempo é devolvida sem chamar o gateway", async () => {
    const midia = (tentativas: number) =>
      mensagem(1, {
        tipo: "imagem",
        texto: null,
        midia_caminho: `${CONVERSA}/${msgId(1)}`,
        midia_mime: "image/png",
        tentativas,
      });
    // 10 s até o fim: cabe um texto (13,5 s até o corte), mas não a mídia (20 + 2 s)
    m.pegarEnvios.mockResolvedValueOnce([midia(1)]);
    const resumo = await rodarCiclo({ fimEm: agora + 10_000 });
    expect(m.enviar).not.toHaveBeenCalled();
    expect(m.falharEnvio).toHaveBeenCalledWith(msgId(1), "sem_tempo", false);
    expect(resumo.envios).toMatchObject({ enviados: 0, falhas: 0, devolvidos: 1 });

    // na última tentativa, tenta assim mesmo (o gateway corta o pedido pelo fimEm)
    m.falharEnvio.mockReset();
    m.pegarEnvios.mockResolvedValueOnce([midia(3)]);
    const fimEm = agora + 10_000;
    await rodarCiclo({ fimEm });
    expect(m.enviar).toHaveBeenCalledWith(expect.objectContaining({ tipo: "imagem" }), conexao, {
      fimEm,
    });
    expect(m.falharEnvio).not.toHaveBeenCalled();
  });

  // Regressão do áudio da Nina sem legenda: o concluir_rodada (0014) grava o áudio dela com
  // texto nulo (a fala fica em transcricao) e o pedido só leva texto quando m.texto existe. A
  // Zernio manda o texto do pedido em "message" junto da nota de voz: se o texto chegasse aqui,
  // o lead receberia a legenda.
  it("áudio da Nina (texto nulo, fala na transcrição) sai sem texto no pedido", async () => {
    m.pegarEnvios.mockResolvedValueOnce([
      mensagem(1, {
        tipo: "audio",
        origem: "nina",
        texto: null,
        transcricao: "oi, tudo bem?",
        midia_caminho: `${CONVERSA}/${msgId(1)}`,
        midia_mime: "audio/ogg",
      }),
    ]);
    await rodarCiclo();
    expect(m.enviar).toHaveBeenCalledTimes(1);
    const pedido = m.enviar.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(pedido).toMatchObject({ tipo: "audio", midia: { mime: "audio/ogg" } });
    expect(pedido).not.toHaveProperty("texto");
    expect(JSON.stringify(pedido)).not.toContain("oi, tudo bem?");
  });

  it("depois de uma mídia devolvida por falta de tempo, só pega envio quando cabe uma mídia", async () => {
    const midia = (n: number) =>
      mensagem(n, {
        tipo: "imagem",
        texto: null,
        midia_caminho: `${CONVERSA}/${msgId(n)}`,
        midia_mime: "image/png",
        tentativas: 1,
      });
    // 12 s até o fim (17 s até o corte): cabe um texto (13,5 s), não uma mídia (23,5 s)
    m.pegarEnvios.mockResolvedValueOnce([midia(1)]).mockResolvedValueOnce([midia(2)]);
    const resumo = await rodarCiclo({ fimEm: agora + 12_000 });
    expect(m.pegarEnvios).toHaveBeenCalledTimes(1);
    expect(m.falharEnvio).toHaveBeenCalledTimes(1);
    expect(m.falharEnvio).toHaveBeenCalledWith(msgId(1), "sem_tempo", false);
    expect(resumo.envios).toMatchObject({ devolvidos: 1, enviados: 0 });
  });

  it("envioComTetoDeMidia: pega só quando cabe uma mídia inteira (preparo 1,5 s + 20 s + 2 s)", async () => {
    m.pegarEnvios.mockResolvedValue([mensagem(1)]);
    // 18,4 s até o fim: 23,4 s até o corte, menos que os 23,5 s
    await rodarCiclo({ fimEm: agora + 18_400, envioComTetoDeMidia: true });
    expect(m.pegarEnvios).not.toHaveBeenCalled();
    m.pegarEnvios.mockResolvedValueOnce([mensagem(1)]).mockResolvedValue([]);
    const resumo = await rodarCiclo({ fimEm: agora + 18_500, envioComTetoDeMidia: true });
    expect(m.pegarEnvios).toHaveBeenCalled();
    expect(resumo.envios.enviados).toBe(1);
  });

  it("última tentativa que esgota o tempo: fica enviando (sem falhar_envio nem concluir_envio)", async () => {
    m.pegarEnvios.mockResolvedValueOnce([mensagem(1, { tentativas: 3 })]);
    m.enviar.mockRejectedValue(new ErroGateway("tempo_esgotado", false));
    const resumo = await rodarCiclo();
    expect(m.falharEnvio).not.toHaveBeenCalled();
    expect(m.concluirEnvio).not.toHaveBeenCalled();
    expect(resumo.envios).toMatchObject({ incertos: 1, falhas: 0, enviados: 0 });
    expect(resumo.erros.envios).toEqual(["tempo_esgotado"]);
  });

  it("tempo esgotado antes da última tentativa, ou outro erro na última: falhar_envio normal", async () => {
    m.pegarEnvios.mockResolvedValueOnce([mensagem(1, { tentativas: 2 })]);
    m.enviar.mockRejectedValue(new ErroGateway("tempo_esgotado", false));
    let resumo = await rodarCiclo();
    expect(m.falharEnvio).toHaveBeenCalledWith(msgId(1), "tempo_esgotado", false);
    expect(resumo.envios).toMatchObject({ incertos: 0, falhas: 1 });

    m.falharEnvio.mockReset();
    m.pegarEnvios.mockResolvedValueOnce([mensagem(2, { tentativas: 3 })]);
    m.enviar.mockRejectedValue(new ErroGateway("falha_no_gateway", false));
    resumo = await rodarCiclo();
    expect(m.falharEnvio).toHaveBeenCalledWith(msgId(2), "falha_no_gateway", false);
    expect(resumo.envios).toMatchObject({ incertos: 0, falhas: 1 });
  });

  it("rodada que passa do orçamento: nada novo começa e o resumo acusa", async () => {
    m.pegarRodadasComRetornos
      .mockResolvedValueOnce([{ id: "a" }])
      .mockResolvedValueOnce([{ id: "b" }])
      .mockResolvedValueOnce([{ id: "c" }]);
    m.responderRodada.mockImplementation(async () => {
      await tick(); // as 3 vagas já começaram quando a IA gasta o tempo
      agora += 30_000; // 3 em paralelo: 90 s no relógio falso, como a IA no pior caso
    });
    m.pegarEnvios.mockResolvedValue([mensagem(1)]);
    const resumo = await rodarCiclo({ orcamentoMs: 45_000 });
    // uma pegada por vaga (3), e nenhuma depois: ao terminar, já não há 20 s
    expect(m.pegarRodadasComRetornos).toHaveBeenCalledTimes(3);
    expect(m.responderRodada).toHaveBeenCalledTimes(3);
    expect(resumo.rodadas.respondidas).toBe(3);
    expect(m.pegarEnvios).not.toHaveBeenCalled();
    expect(resumo.orcamento_esgotado).toBe(true);
    expect(resumo.duracao_ms).toBe(90_000);
  });

  it("não pede rodada nova com menos de 20 s até o fim", async () => {
    const sobras: number[] = [];
    m.pegarRodadasComRetornos.mockImplementation(async () => {
      sobras.push(1_000_000 + 45_000 - agora);
      return [{ id: "r" + agora }];
    });
    m.responderRodada.mockImplementation(async () => {
      await tick();
      agora += 6_000; // cada rodada avança o relógio
    });
    await rodarCiclo({ orcamentoMs: 45_000 });
    // a 1ª pegada é em 0 s; todas as outras também só com 20 s ou mais até o fim
    expect(sobras.length).toBeGreaterThan(3);
    expect(sobras.every((x) => x >= 20_000)).toBe(true);
    // e a pegada seguinte acabou sem tempo: a última sobra ficou perto do limite, não longe dele
    expect(Math.min(...sobras)).toBeLessThan(26_000);
    expect(m.pegarRodadas).not.toHaveBeenCalled();
  });

  it("rodada que lança erro vira falhar_rodada passageira", async () => {
    m.pegarRodadasComRetornos.mockResolvedValueOnce([{ id: "rod-1" }]);
    m.responderRodada.mockRejectedValue(new Error("responder_rodada_nao_implementado"));
    const resumo = await rodarCiclo();
    expect(m.falharRodada).toHaveBeenCalledWith("rod-1", "erro_provedor", true);
    expect(resumo.rodadas.falhas).toBe(1);
    expect(resumo.erros.rodadas).toContain("responder_rodada_nao_implementado");
  });

  it("ErroGateway definitivo vira falhar_envio definitivo", async () => {
    m.pegarEnvios.mockResolvedValueOnce([mensagem(1)]);
    m.enviar.mockRejectedValue(new ErroGateway("numero_invalido", true, "corpo do gateway"));
    await rodarCiclo();
    expect(m.falharEnvio).toHaveBeenCalledWith(msgId(1), "numero_invalido", true);
    expect(m.concluirEnvio).not.toHaveBeenCalled();
  });

  it("erro qualquer no envio vira erro_interno passageiro", async () => {
    m.pegarEnvios.mockResolvedValueOnce([mensagem(1)]);
    m.enviar.mockRejectedValue(new TypeError("fetch failed"));
    await rodarCiclo();
    expect(m.falharEnvio).toHaveBeenCalledWith(msgId(1), "erro_interno", false);
  });

  it("envio de texto e de mídia: destino, URL assinada de 1 h e concluir_envio", async () => {
    m.pegarEnvios.mockResolvedValueOnce([mensagem(1)]).mockResolvedValueOnce([
      mensagem(2, {
        tipo: "imagem",
        texto: null,
        midia_caminho: `${CONVERSA}/${msgId(2)}`,
        midia_mime: "image/png",
      }),
    ]);
    const resumo = await rodarCiclo();
    expect(m.enviar).toHaveBeenNthCalledWith(
      1,
      {
        destino: [{ tipo: "telefone", valor: "5511999990000" }],
        tipo: "texto",
        texto: "ola",
        chave: msgId(1),
      },
      conexao,
      // o prazo vai junto para o gateway
      { fimEm: 1_000_000 + 45_000 },
    );
    expect(m.urlAssinada).toHaveBeenCalledWith(`${CONVERSA}/${msgId(2)}`, 3600);
    expect(m.enviar.mock.calls[1]?.[0]).toMatchObject({
      tipo: "imagem",
      midia: { url: "https://assinada.exemplo/x", mime: "image/png" },
    });
    expect(m.concluirEnvio).toHaveBeenCalledWith(msgId(1), "W1", "G1");
    expect(resumo.envios.enviados).toBe(2);
  });

  it("concluir_envio que falha: 3 tentativas e nunca falhar_envio (evita reenvio)", async () => {
    m.pegarEnvios.mockResolvedValueOnce([mensagem(1)]);
    m.concluirEnvio.mockRejectedValue(new Error("concluir_envio:08006"));
    const resumo = await rodarCiclo();
    expect(m.concluirEnvio).toHaveBeenCalledTimes(3);
    expect(m.falharEnvio).not.toHaveBeenCalled();
    expect(resumo.erros.envios).toEqual(["concluir_envio:08006"]);
  });

  it("concluir_envio com falha passageira: a nova tentativa resolve", async () => {
    m.pegarEnvios.mockResolvedValueOnce([mensagem(1)]);
    m.concluirEnvio
      .mockRejectedValueOnce(new Error("concluir_envio:08006"))
      .mockResolvedValue(undefined);
    const resumo = await rodarCiclo();
    expect(m.concluirEnvio).toHaveBeenCalledTimes(2);
    expect(resumo.envios.enviados).toBe(1);
    expect(resumo.erros.envios).toEqual([]);
  });

  it("adaptador que lança no traduzir: evento fica pendente com traducao_falhou", async () => {
    m.eventosPendentes.mockResolvedValue([
      { id: 9, gateway: "zapi", conexao_id: CONEXAO, payload: {}, tentativas: 1 },
    ]);
    m.traduzir.mockImplementation(() => {
      throw new Error("bug");
    });
    const resumo = await rodarCiclo();
    expect(m.marcarEventoComErro).toHaveBeenCalledWith(9, "traducao_falhou");
    expect(m.marcarEventoProcessado).not.toHaveBeenCalled();
    expect(resumo.eventos.falhas).toBe(1);
  });

  it("áudio sem transcrição não trava a mídia", async () => {
    m.pegarMidias.mockResolvedValueOnce([mensagem(1, { tipo: "audio", midia_ref_externa: "ref" })]);
    const resumo = await rodarCiclo();
    expect(m.transcrever).toHaveBeenCalled();
    expect(m.gravarTranscricao).not.toHaveBeenCalled();
    expect(m.garantirBucket).toHaveBeenCalled();
    expect(m.enviarArquivo).toHaveBeenCalledWith(
      `${CONVERSA}/${msgId(1)}`,
      expect.any(Uint8Array),
      "audio/ogg",
    );
    expect(m.concluirMidia).toHaveBeenCalledWith(
      msgId(1),
      `${CONVERSA}/${msgId(1)}`,
      "audio/ogg",
      3,
      true,
    );
    expect(resumo.midias.copiadas).toBe(1);
  });

  it("transcrição que lança erro também não trava; com texto, grava a transcrição", async () => {
    m.pegarMidias
      .mockResolvedValueOnce([mensagem(1, { tipo: "audio", midia_ref_externa: "a" })])
      .mockResolvedValueOnce([mensagem(2, { tipo: "audio", midia_ref_externa: "b" })]);
    m.transcrever.mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce({ texto: "bom dia" });
    await rodarCiclo();
    expect(m.concluirMidia).toHaveBeenCalledTimes(2);
    expect(m.concluirMidia.mock.calls.every((c) => c[4] === true)).toBe(true);
    expect(m.gravarTranscricao).toHaveBeenCalledWith(msgId(2), "bom dia");
  });

  it("falha passageira ao baixar a mídia vira concluir_midia com ok = false", async () => {
    for (const [n, erro, codigo] of [
      [1, new ErroGateway("midia_vazia", false), "midia_vazia"],
      [2, new Error("qualquer"), "qualquer"],
    ] as const) {
      m.concluirMidia.mockReset();
      m.pegarMidias.mockResolvedValueOnce([
        mensagem(n, { tipo: "imagem", midia_ref_externa: "r" }),
      ]);
      m.baixarMidia.mockRejectedValueOnce(erro);
      const resumo = await rodarCiclo();
      expect(m.concluirMidia).toHaveBeenCalledWith(msgId(n), "", "", 0, false);
      expect(m.desistirMidia).not.toHaveBeenCalled();
      expect(resumo.midias.falhas).toBe(1);
      expect(resumo.erros.midias).toEqual([codigo]);
    }
  });

  it("erro definitivo ao baixar desiste da mídia, sem gastar as outras tentativas", async () => {
    for (const [n, codigo] of [
      [1, "midia_expirada"],
      [2, "midia_grande_demais"],
    ] as const) {
      m.desistirMidia.mockReset();
      m.pegarMidias.mockResolvedValueOnce([
        mensagem(n, { tipo: "imagem", midia_ref_externa: "r" }),
      ]);
      m.baixarMidia.mockRejectedValueOnce(new ErroGateway(codigo, true));
      const resumo = await rodarCiclo();
      expect(m.desistirMidia).toHaveBeenCalledWith(msgId(n), codigo);
      expect(m.desistirMidia).toHaveBeenCalledTimes(1);
      expect(resumo.midias.falhas).toBe(1);
      expect(resumo.erros.midias).toEqual([codigo]);
    }
    expect(m.concluirMidia).not.toHaveBeenCalled();
  });

  it("midia_tamanho acima de 25 MB desiste sem baixar", async () => {
    m.pegarMidias.mockResolvedValueOnce([
      mensagem(1, {
        tipo: "documento",
        midia_ref_externa: "r",
        midia_tamanho: 25 * 1024 * 1024 + 1,
      }),
    ]);
    const resumo = await rodarCiclo();
    expect(m.baixarMidia).not.toHaveBeenCalled();
    expect(m.desistirMidia).toHaveBeenCalledWith(msgId(1), "midia_grande_demais");
    expect(m.concluirMidia).not.toHaveBeenCalled();
    expect(resumo.midias.falhas).toBe(1);
    expect(resumo.erros.midias).toEqual(["midia_grande_demais"]);
  });

  it("midia_tamanho nulo ou até 25 MB: baixa normal", async () => {
    for (const [n, tamanho] of [
      [1, null],
      [2, 25 * 1024 * 1024],
      [3, 1_000],
    ] as const) {
      m.pegarMidias.mockResolvedValueOnce([
        mensagem(n, { tipo: "imagem", midia_ref_externa: "r", midia_tamanho: tamanho }),
      ]);
      await rodarCiclo();
      expect(m.concluirMidia).toHaveBeenLastCalledWith(
        msgId(n),
        `${CONVERSA}/${msgId(n)}`,
        "audio/ogg",
        3,
        true,
      );
    }
    expect(m.baixarMidia).toHaveBeenCalledTimes(3);
    expect(m.desistirMidia).not.toHaveBeenCalled();
  });

  it("desistir_midia que falha: anota e solta a mídia com concluir_midia ok = false", async () => {
    m.pegarMidias.mockResolvedValueOnce([mensagem(1, { tipo: "imagem", midia_ref_externa: "r" })]);
    m.baixarMidia.mockRejectedValueOnce(new ErroGateway("midia_grande_demais", true));
    m.desistirMidia.mockRejectedValueOnce(new Error("banco fora"));
    const resumo = await rodarCiclo();
    expect(m.desistirMidia).toHaveBeenCalledWith(msgId(1), "midia_grande_demais");
    expect(m.concluirMidia).toHaveBeenCalledWith(msgId(1), "", "", 0, false);
    expect(resumo.midias.falhas).toBe(1);
    expect(resumo.erros.midias).toEqual(["midia_grande_demais", "erro_interno"]);
  });

  it("evento pendente: reaplica; status que ainda não casa continua pendente", async () => {
    m.eventosPendentes.mockResolvedValue([
      { id: 7, gateway: "zapi", conexao_id: CONEXAO, payload: {}, tentativas: 1 },
      { id: 8, gateway: "zapi", conexao_id: CONEXAO, payload: {}, tentativas: 1 },
    ]);
    m.traduzir.mockReturnValue([{ tipo: "status", id: "W1", status: "lida", momento: "x" }]);
    m.atualizarStatus.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const resumo = await rodarCiclo();
    expect(m.marcarEventoProcessado).toHaveBeenCalledWith(7);
    expect(m.marcarEventoComErro).toHaveBeenCalledWith(8, "status_sem_mensagem");
    expect(resumo.eventos).toMatchObject({ processados: 1, pendentes: 1 });
  });

  it("o resumo não leva dado pessoal nem mensagem de erro crua", async () => {
    m.pegarEnvios.mockResolvedValueOnce([mensagem(1)]);
    m.enviar.mockRejectedValue(new Error("falhou para 5511999990000 com token abc"));
    const resumo = await rodarCiclo();
    expect(JSON.stringify(resumo)).not.toContain("5511999990000");
    expect(resumo.erros.envios).toEqual(["erro_interno"]);
  });

  it("3 bolhas da mesma conversa saem na mesma passada, com 2 s entre elas", async () => {
    // a 2ª e a 3ª bolha só vencem 2 s depois da anterior (a fila volta vazia antes)
    m.pegarEnvios
      .mockResolvedValueOnce([mensagem(1)])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([mensagem(2)])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([mensagem(3)]);
    const resumo = await rodarCiclo();
    expect(m.enviar).toHaveBeenCalledTimes(3);
    expect(resumo.envios.enviados).toBe(3);
    // espera quando a fila esvazia depois de um envio; vazia de novo sem envio, encerra
    expect(esperas).toEqual([2_000, 2_000, 2_000]);
    expect(m.pegarEnvios).toHaveBeenCalledTimes(7);
  });

  it("sem envio nenhum, não espera", async () => {
    await rodarCiclo();
    expect(esperas).toEqual([]);
    expect(m.pegarEnvios).toHaveBeenCalledTimes(1);
  });

  it("transcrição passageira (429) devolve a mídia; na 3ª tentativa conclui sem texto", async () => {
    m.transcrever.mockResolvedValue({ erro: "passageiro" });
    m.pegarMidias.mockResolvedValueOnce([
      mensagem(1, { tipo: "audio", midia_ref_externa: "a", midia_tentativas: 1 }),
    ]);
    const resumo = await rodarCiclo();
    expect(m.concluirMidia).toHaveBeenCalledTimes(1);
    expect(m.concluirMidia).toHaveBeenCalledWith(msgId(1), "", "", 0, false);
    expect(resumo.midias).toMatchObject({ copiadas: 0, devolvidas: 1 });
    expect(m.falharRodada).not.toHaveBeenCalled();

    m.concluirMidia.mockReset();
    m.pegarMidias.mockResolvedValueOnce([
      mensagem(1, { tipo: "audio", midia_ref_externa: "a", midia_tentativas: 3 }),
    ]);
    await rodarCiclo();
    expect(m.concluirMidia).toHaveBeenCalledWith(
      msgId(1),
      `${CONVERSA}/${msgId(1)}`,
      "audio/ogg",
      3,
      true,
    );
  });

  it("o envio passa a conexão ao destino (conversa da Zernio de outra conta fica de fora)", async () => {
    m.pegarEnvios.mockResolvedValueOnce([mensagem(1)]);
    await rodarCiclo();
    expect(m.destinoDoContato).toHaveBeenCalledWith(CONVERSA, CONEXAO);
  });
  it("prazo curto não começa rodada nem mídia, e o prazo vai junto para a rodada", async () => {
    m.pegarRodadasComRetornos.mockResolvedValueOnce([{ id: "r1" }]);
    m.pegarMidias.mockResolvedValue([mensagem(1, { tipo: "imagem", midia_ref_externa: "r" })]);
    // 14 s até o fim: nem rodada (20 s) nem mídia (15 s)
    await rodarCiclo({ fimEm: agora + 14_000 });
    expect(m.pegarRodadasComRetornos).not.toHaveBeenCalled();
    expect(m.pegarMidias).not.toHaveBeenCalled();
    expect(m.responderRodada).not.toHaveBeenCalled();

    // 19,9 s: mídia sim, rodada não
    await rodarCiclo({ fimEm: agora + 19_900 });
    expect(m.pegarMidias).toHaveBeenCalled();
    expect(m.pegarRodadasComRetornos).not.toHaveBeenCalled();

    // 20 s: a rodada começa e recebe o prazo absoluto
    m.pegarMidias.mockResolvedValue([]);
    const fimEm = agora + 20_000;
    await rodarCiclo({ fimEm });
    expect(m.responderRodada).toHaveBeenCalledWith({ id: "r1" }, { fimEm });
  });

  it("o prazo vai junto para baixarMidia (6 s antes, para a cópia) e transcrever, com a conversa", async () => {
    m.pegarMidias.mockResolvedValueOnce([mensagem(1, { tipo: "audio", midia_ref_externa: "a" })]);
    const fimEm = agora + 40_000;
    await rodarCiclo({ fimEm });
    expect(m.baixarMidia).toHaveBeenCalledWith("a", conexao, { fimEm: fimEm - 6_000 });
    // a conversa do áudio vai junto, para o custo da transcrição contar nela (ia_chamadas.conversa_id)
    expect(m.transcrever).toHaveBeenCalledWith(expect.any(Uint8Array), "audio/ogg", {
      fimEm,
      conversaId: CONVERSA,
    });
  });

  it("áudio sem 5 s para transcrever: devolve sem chamar o provedor; na 3ª tentativa, tenta", async () => {
    const audio = (t: number) =>
      mensagem(1, { tipo: "audio", midia_ref_externa: "a", midia_tentativas: t });
    // o download e a cópia gastam até sobrar 4 s
    const fimEm = agora + 20_000;
    m.baixarMidia.mockImplementation(async () => {
      agora = fimEm - 4_000;
      return { bytes: new Uint8Array([1]), mime: "audio/ogg" };
    });
    m.pegarMidias.mockResolvedValueOnce([audio(1)]);
    const resumo = await rodarCiclo({ fimEm });
    expect(m.transcrever).not.toHaveBeenCalled();
    expect(m.concluirMidia).toHaveBeenCalledWith(msgId(1), "", "", 0, false);
    expect(resumo.midias).toMatchObject({ copiadas: 0, devolvidas: 1 });
    expect(resumo.erros.midias).toEqual(["sem_tempo_transcricao"]);

    m.concluirMidia.mockReset();
    m.pegarMidias.mockResolvedValueOnce([audio(3)]);
    const fim2 = agora + 20_000;
    m.baixarMidia.mockImplementation(async () => {
      agora = fim2 - 4_000;
      return { bytes: new Uint8Array([1]), mime: "audio/ogg" };
    });
    await rodarCiclo({ fimEm: fim2 });
    expect(m.transcrever).toHaveBeenCalledTimes(1);
  });

  it("a limpeza saiu do motor (é do relógio do banco): o resumo não tem a etapa", async () => {
    const resumo = await rodarCiclo();
    expect("limpeza" in resumo).toBe(false);
    expect(Object.keys(resumo.erros).sort()).toEqual(["envios", "eventos", "midias", "rodadas"]);
    // os eventos pendentes são o 1º passo da passada
    const ordem = (f: { mock: { invocationCallOrder: number[] } }) =>
      f.mock.invocationCallOrder[0]!;
    expect(ordem(m.eventosPendentes)).toBeLessThan(ordem(m.pegarMidias));
    expect(m.eventosPendentes).toHaveBeenCalledWith(20);
  });

  it("evento que lança na reaplicação: a falha vai por marcarEventoComErro (falhar_evento)", async () => {
    m.eventosPendentes.mockResolvedValue([
      { id: 7, gateway: "zapi", conexao_id: CONEXAO, payload: {}, tentativas: 0 },
    ]);
    m.traduzir.mockReturnValue([{ tipo: "status", id: "W1", status: "lida", momento: "x" }]);
    m.atualizarStatus.mockRejectedValue(new Error("atualizar_status:08006"));
    const resumo = await rodarCiclo();
    expect(m.marcarEventoComErro).toHaveBeenCalledWith(7, "atualizar_status:08006");
    expect(m.marcarEventoProcessado).not.toHaveBeenCalled();
    expect(resumo.eventos.falhas).toBe(1);
  });

  it("somenteEnvios: pula eventos, mídias e rodadas e só envia", async () => {
    m.eventosPendentes.mockResolvedValue([{ id: 1, gateway: "zapi", conexao_id: CONEXAO }]);
    m.pegarMidias.mockResolvedValue([mensagem(9, { tipo: "imagem", midia_ref_externa: "r" })]);
    m.pegarRodadasComRetornos.mockResolvedValue([{ id: "rod-1" }]);
    m.pegarEnvios.mockResolvedValueOnce([mensagem(1)]);
    const resumo = await rodarCiclo({ somenteEnvios: true, orcamentoMs: 12_000 });

    expect(m.eventosPendentes).not.toHaveBeenCalled();
    expect(m.pegarMidias).not.toHaveBeenCalled();
    expect(m.pegarRodadasComRetornos).not.toHaveBeenCalled();
    expect(m.responderRodada).not.toHaveBeenCalled();
    expect(m.enviar).toHaveBeenCalledTimes(1);
    // o prazo da passada curta vai junto para o gateway
    expect(m.enviar.mock.calls[0]?.[2]).toEqual({ fimEm: 1_000_000 + 12_000 });
    expect(m.concluirEnvio).toHaveBeenCalledWith(msgId(1), "W1", "G1");
    expect(resumo.envios.enviados).toBe(1);
  });

  describe("somenteEnvios com mídia (a passada curta do pedirEnvio)", () => {
    const imagem = () =>
      mensagem(1, {
        tipo: "imagem",
        texto: null,
        midia_caminho: `${CONVERSA}/${msgId(1)}`,
        midia_mime: "image/png",
        tentativas: 1,
      });
    beforeEach(() => {
      // o preparo (conexão, destino, URL assinada) gasta o tempo reservado para ele
      m.urlAssinada.mockImplementation(async () => {
        agora += 1_500;
        return "https://assinada.exemplo/x";
      });
    });

    it("com 12 s, a imagem nunca cabe: é pega, gasta a tentativa e volta para a fila", async () => {
      m.pegarEnvios.mockResolvedValueOnce([imagem()]);
      const resumo = await rodarCiclo({ somenteEnvios: true, orcamentoMs: 12_000 });
      expect(m.enviar).not.toHaveBeenCalled();
      expect(m.falharEnvio).toHaveBeenCalledWith(msgId(1), "sem_tempo", false);
      expect(resumo.envios).toMatchObject({ enviados: 0, devolvidos: 1 });
    });

    it("com ORCAMENTO_SOMENTE_ENVIOS_MS (18,5 s), a imagem sai na hora", async () => {
      const { ORCAMENTO_SOMENTE_ENVIOS_MS } = await import("./ciclo.server");
      expect(ORCAMENTO_SOMENTE_ENVIOS_MS).toBe(18_500);
      m.pegarEnvios.mockResolvedValueOnce([imagem()]);
      const inicio = agora;
      const resumo = await rodarCiclo({
        somenteEnvios: true,
        orcamentoMs: ORCAMENTO_SOMENTE_ENVIOS_MS,
      });
      expect(m.enviar).toHaveBeenCalledWith(expect.objectContaining({ tipo: "imagem" }), conexao, {
        fimEm: inicio + ORCAMENTO_SOMENTE_ENVIOS_MS,
      });
      expect(m.falharEnvio).not.toHaveBeenCalled();
      expect(m.concluirEnvio).toHaveBeenCalledWith(msgId(1), "W1", "G1");
      expect(resumo.envios).toMatchObject({ enviados: 1, devolvidos: 0 });
    });

    it("100 ms a menos que ORCAMENTO_SOMENTE_ENVIOS_MS já não cabe a mídia", async () => {
      const { ORCAMENTO_SOMENTE_ENVIOS_MS } = await import("./ciclo.server");
      m.pegarEnvios.mockResolvedValueOnce([imagem()]);
      await rodarCiclo({ somenteEnvios: true, orcamentoMs: ORCAMENTO_SOMENTE_ENVIOS_MS - 100 });
      expect(m.enviar).not.toHaveBeenCalled();
      expect(m.falharEnvio).toHaveBeenCalledWith(msgId(1), "sem_tempo", false);
    });
  });

  it("somenteEnvios vale mais que eventos e midias ligados", async () => {
    await rodarCiclo({ somenteEnvios: true, eventos: true, midias: true });
    expect(m.eventosPendentes).not.toHaveBeenCalled();
    expect(m.pegarMidias).not.toHaveBeenCalled();
    expect(m.pegarRodadasComRetornos).not.toHaveBeenCalled();
    expect(m.pegarEnvios).toHaveBeenCalledTimes(1);
  });

  it("sem somenteEnvios, a passada continua com todas as etapas", async () => {
    await rodarCiclo({ somenteEnvios: false });
    expect(m.eventosPendentes).toHaveBeenCalledTimes(1);
    expect(m.pegarMidias).toHaveBeenCalledTimes(1);
    expect(m.pegarRodadasComRetornos).toHaveBeenCalledTimes(1);
    expect(m.pegarEnvios).toHaveBeenCalledTimes(1);
  });

  it("citação: o responde_a_id da linha é resolvido uma vez por envio, mesmo com o 2º pedido sem ela", async () => {
    m.idExternoDaMensagem.mockResolvedValue("wamid.CITADA");
    m.pegarEnvios.mockResolvedValueOnce([mensagem(1, { responde_a_id: msgId(7) })]);
    m.enviar
      .mockRejectedValueOnce(new ErroGateway("http:400", true))
      .mockResolvedValueOnce({ id_externo: "W2" });
    await rodarCiclo();
    expect(m.idExternoDaMensagem).toHaveBeenCalledTimes(1);
    expect(m.enviar).toHaveBeenCalledTimes(2);
    expect(m.enviar.mock.calls[0]?.[0]).toMatchObject({ texto: "ola", respondeA: "wamid.CITADA" });
  });

  it("citação: um campo responde_a_id_externo solto na linha é ignorado (vale só o responde_a_id)", async () => {
    m.pegarEnvios.mockResolvedValueOnce([mensagem(1, { responde_a_id_externo: "wamid.SOLTO" })]);
    await rodarCiclo();
    expect(m.idExternoDaMensagem).not.toHaveBeenCalled();
    expect(m.enviar.mock.calls[0]?.[0]).not.toHaveProperty("respondeA");
  });

  it("citação: com só o responde_a_id, busca o id_externo na mesma conexão", async () => {
    m.idExternoDaMensagem.mockResolvedValue("wamid.DA_TELA");
    m.pegarEnvios.mockResolvedValueOnce([mensagem(1, { responde_a_id: msgId(7) })]);
    await rodarCiclo();
    expect(m.idExternoDaMensagem).toHaveBeenCalledWith(msgId(7), CONEXAO);
    expect(m.enviar.mock.calls[0]?.[0]).toMatchObject({ respondeA: "wamid.DA_TELA" });
  });

  it("citação de outra conexão (ou sem id_externo): o envio sai sem respondeA", async () => {
    m.idExternoDaMensagem.mockResolvedValue(null);
    m.pegarEnvios.mockResolvedValueOnce([mensagem(1, { responde_a_id: msgId(7) })]);
    const resumo = await rodarCiclo();
    expect(m.enviar).toHaveBeenCalledTimes(1);
    expect(m.enviar.mock.calls[0]?.[0]).not.toHaveProperty("respondeA");
    expect(resumo.envios.enviados).toBe(1);
  });

  it("citação: falha ao buscar a citada anota o erro e envia assim mesmo, sem ela", async () => {
    m.idExternoDaMensagem.mockRejectedValue(new Error("citacao_mensagem:08006"));
    m.pegarEnvios.mockResolvedValueOnce([mensagem(1, { responde_a_id: msgId(7) })]);
    const resumo = await rodarCiclo();
    expect(m.enviar).toHaveBeenCalledTimes(1);
    expect(m.enviar.mock.calls[0]?.[0]).not.toHaveProperty("respondeA");
    expect(m.falharEnvio).not.toHaveBeenCalled();
    expect(resumo.envios.enviados).toBe(1);
    expect(resumo.erros.envios).toEqual(["citacao_mensagem:08006"]);
  });

  it("citação recusada (erro definitivo): manda de novo sem a citação e conclui", async () => {
    m.idExternoDaMensagem.mockResolvedValue("wamid.VELHA");
    m.pegarEnvios.mockResolvedValueOnce([mensagem(1, { responde_a_id: msgId(7) })]);
    m.enviar
      .mockRejectedValueOnce(new ErroGateway("http:400", true))
      .mockResolvedValueOnce({ id_externo: "W2" });
    const resumo = await rodarCiclo();
    expect(m.enviar).toHaveBeenCalledTimes(2);
    expect(m.enviar.mock.calls[0]?.[0]).toMatchObject({ respondeA: "wamid.VELHA" });
    expect(m.enviar.mock.calls[1]?.[0]).not.toHaveProperty("respondeA");
    expect(m.enviar.mock.calls[1]?.[0]).toMatchObject({ texto: "ola", chave: msgId(1) });
    expect(m.falharEnvio).not.toHaveBeenCalled();
    expect(m.concluirEnvio).toHaveBeenCalledWith(msgId(1), "W2", null);
    expect(resumo.envios).toMatchObject({ enviados: 1, falhas: 0 });
  });

  it("citação: erro passageiro ou sem citação não repete; definitivo de novo sem ela falha", async () => {
    m.idExternoDaMensagem.mockResolvedValue("wamid.C");
    m.pegarEnvios.mockResolvedValueOnce([mensagem(1, { responde_a_id: msgId(7) })]);
    m.enviar.mockRejectedValueOnce(new ErroGateway("http:500", false));
    await rodarCiclo();
    expect(m.enviar).toHaveBeenCalledTimes(1);
    expect(m.falharEnvio).toHaveBeenLastCalledWith(msgId(1), "http:500", false);

    m.enviar.mockReset();
    m.pegarEnvios.mockResolvedValueOnce([mensagem(2)]);
    m.enviar.mockRejectedValueOnce(new ErroGateway("http:400", true));
    await rodarCiclo();
    expect(m.enviar).toHaveBeenCalledTimes(1);
    expect(m.falharEnvio).toHaveBeenLastCalledWith(msgId(2), "http:400", true);

    m.enviar.mockReset();
    m.pegarEnvios.mockResolvedValueOnce([mensagem(3, { responde_a_id: msgId(7) })]);
    m.enviar
      .mockRejectedValueOnce(new ErroGateway("http:400", true))
      .mockRejectedValueOnce(new ErroGateway("sem_janela", true));
    await rodarCiclo();
    expect(m.enviar).toHaveBeenCalledTimes(2);
    expect(m.falharEnvio).toHaveBeenLastCalledWith(msgId(3), "sem_janela", true);
  });

  it("citação recusada sem tempo para o 2º pedido inteiro: volta para a fila (na última, falha)", async () => {
    // o 1º pedido demora 14 s: dos 20 s até o fim (25 s até o corte) sobram 11 s, menos que 12 s
    const recusaLenta = async () => {
      agora += 14_000;
      throw new ErroGateway("http:400", true);
    };
    m.idExternoDaMensagem.mockResolvedValue("wamid.C");
    m.pegarEnvios.mockResolvedValueOnce([mensagem(1, { responde_a_id: msgId(7), tentativas: 1 })]);
    m.enviar.mockImplementationOnce(recusaLenta);
    await rodarCiclo({ fimEm: agora + 20_000 });
    expect(m.enviar).toHaveBeenCalledTimes(1);
    expect(m.falharEnvio).toHaveBeenLastCalledWith(msgId(1), "http:400", false);

    m.enviar.mockReset();
    m.pegarEnvios.mockResolvedValueOnce([mensagem(2, { responde_a_id: msgId(7), tentativas: 3 })]);
    m.enviar.mockImplementationOnce(recusaLenta);
    await rodarCiclo({ fimEm: agora + 20_000 });
    expect(m.enviar).toHaveBeenCalledTimes(1);
    expect(m.falharEnvio).toHaveBeenLastCalledWith(msgId(2), "http:400", true);
  });

  it("envio_incerto do gateway: fica enviando, sem falhar_envio nem concluir_envio", async () => {
    m.pegarEnvios.mockResolvedValueOnce([mensagem(1, { tentativas: 2 })]);
    m.enviar.mockRejectedValueOnce(new ErroGateway("envio_incerto", false));
    const resumo = await rodarCiclo();
    expect(m.falharEnvio).not.toHaveBeenCalled();
    expect(m.concluirEnvio).not.toHaveBeenCalled();
    expect(resumo.envios).toMatchObject({ incertos: 1, falhas: 0, enviados: 0 });
  });

  it("chave da Zernio: o id da mensagem; com reenvio, id:rN (as tentativas não mudam a chave)", async () => {
    for (const [n, extra, chave] of [
      [1, {}, msgId(1)],
      [2, { reenvios: 0, tentativas: 2 }, msgId(2)],
      [3, { reenvios: 1 }, `${msgId(3)}:r1`],
      [4, { reenvios: 2, tentativas: 3 }, `${msgId(4)}:r2`],
    ] as const) {
      m.enviar.mockClear();
      m.pegarEnvios.mockResolvedValueOnce([mensagem(n, extra)]);
      await rodarCiclo();
      expect(m.enviar.mock.calls[0]?.[0]).toMatchObject({ chave });
    }
  });

  it("o pedido leva a tentativa que o pegar_envios contou", async () => {
    m.pegarEnvios.mockResolvedValueOnce([mensagem(1, { tentativas: 2 })]);
    await rodarCiclo();
    expect(m.enviar.mock.calls[0]?.[0]).toMatchObject({ chave: msgId(1), tentativa: 2 });
  });

  it("o pedido leva o erro que a tentativa anterior deixou na linha; sem erro, não leva", async () => {
    m.pegarEnvios.mockResolvedValueOnce([mensagem(1, { tentativas: 2, erro: "zernio_http_503" })]);
    await rodarCiclo();
    expect(m.enviar.mock.calls[0]?.[0]).toMatchObject({
      tentativa: 2,
      erroAnterior: "zernio_http_503",
    });

    for (const [n, extra] of [
      [2, { tentativas: 1, erro: null }],
      [3, { tentativas: 2, erro: "  " }],
    ] as const) {
      m.enviar.mockReset();
      m.pegarEnvios.mockResolvedValueOnce([mensagem(n, extra)]);
      await rodarCiclo();
      expect(m.enviar).toHaveBeenCalledTimes(1);
      expect(m.enviar.mock.calls[0]?.[0]).not.toHaveProperty("erroAnterior");
    }
  });

  it("422 de validação depois de um 503 (recusa definitiva): o 2º pedido vai sem a citação, com o mesmo erro anterior", async () => {
    m.idExternoDaMensagem.mockResolvedValue("wamid.CITADA");
    m.pegarEnvios.mockResolvedValueOnce([
      mensagem(1, { responde_a_id: msgId(7), tentativas: 2, erro: "zernio_http_503" }),
    ]);
    m.enviar
      .mockRejectedValueOnce(new ErroGateway("zernio_http_422", true))
      .mockResolvedValueOnce({ id_externo: "wamid.NOVO" });
    const resumo = await rodarCiclo();
    expect(m.enviar).toHaveBeenCalledTimes(2);
    expect(m.enviar.mock.calls[0]?.[0]).toMatchObject({
      respondeA: "wamid.CITADA",
      erroAnterior: "zernio_http_503",
    });
    expect(m.enviar.mock.calls[1]?.[0]).not.toHaveProperty("respondeA");
    expect(m.enviar.mock.calls[1]?.[0]).toMatchObject({ erroAnterior: "zernio_http_503" });
    expect(m.concluirEnvio).toHaveBeenCalledWith(msgId(1), "wamid.NOVO", null);
    expect(resumo.envios).toMatchObject({ enviados: 1, incertos: 0, falhas: 0 });
  });

  it("sem citação na linha (formato de hoje do pegar_envios): nada muda no pedido", async () => {
    m.pegarEnvios.mockResolvedValueOnce([mensagem(1, { responde_a_id: null })]);
    await rodarCiclo();
    expect(m.idExternoDaMensagem).not.toHaveBeenCalled();
    expect(m.enviar.mock.calls[0]?.[0]).not.toHaveProperty("respondeA");
  });
});

// A etapa das rodadas em 3 vagas (B1): cada vaga pega 1 rodada por vez (pegar_rodadas_com_retornos
// com limite 1) e roda o corpo de sempre. Os tempos são do relógio falso (agora); as rodadas
// ficam presas num adiável que o teste solta na hora que quer.
describe("rodarCiclo: as rodadas em 3 vagas", () => {
  type Adiavel = { soltar: () => void; falhar: (e: Error) => void; p: Promise<void> };
  const adiaveis = new Map<string, Adiavel>();
  const iniciadas: string[] = [];
  /** A fila do banco: cada pegada leva 1 rodada, na ordem; vazia, devolve []. */
  const fila: { id: string }[] = [];

  function prender(...ids: string[]) {
    for (const id of ids) {
      let soltar!: () => void;
      let falhar!: (e: Error) => void;
      const p = new Promise<void>((ok, nao) => {
        soltar = ok;
        falhar = nao;
      });
      adiaveis.set(id, { soltar, falhar, p });
    }
  }
  const soltar = (id: string) => adiaveis.get(id)?.soltar();
  const soltarTodas = () => {
    for (const a of adiaveis.values()) a.soltar();
  };

  beforeEach(() => {
    adiaveis.clear();
    iniciadas.length = 0;
    fila.length = 0;
    m.pegarRodadasComRetornos.mockImplementation(async () => {
      const r = fila.shift();
      return r ? [r] : [];
    });
    m.responderRodada.mockImplementation(async (r: { id: string }) => {
      iniciadas.push(r.id);
      await adiaveis.get(r.id)?.p;
    });
  });

  it("cada vaga pega 1 rodada por vez: limite 1, e a pura só com 30 s ou mais até o fim", async () => {
    fila.push({ id: "a" });
    await rodarCiclo({ fimEm: agora + 45_000 });
    expect(m.pegarRodadasComRetornos.mock.calls.every((c) => c[0] === 1)).toBe(true);
    // 45 s sobrando: a rodada pura cabe
    expect(m.pegarRodadasComRetornos.mock.calls[0]).toEqual([1, 1]);

    m.pegarRodadasComRetornos.mockClear();
    await rodarCiclo({ fimEm: agora + 30_000 });
    expect(m.pegarRodadasComRetornos.mock.calls[0]).toEqual([1, 1]);

    // de 29,9 s a 20 s: ainda pega o lead (FOLGA_RODADA_MS), mas a pura não
    m.pegarRodadasComRetornos.mockClear();
    await rodarCiclo({ fimEm: agora + 29_900 });
    expect(m.pegarRodadasComRetornos.mock.calls[0]).toEqual([1, 0]);
    m.pegarRodadasComRetornos.mockClear();
    await rodarCiclo({ fimEm: agora + 20_000 });
    expect(m.pegarRodadasComRetornos.mock.calls[0]).toEqual([1, 0]);

    // abaixo de 20 s, nenhuma pegada
    m.pegarRodadasComRetornos.mockClear();
    await rodarCiclo({ fimEm: agora + 19_900 });
    expect(m.pegarRodadasComRetornos).not.toHaveBeenCalled();
    expect(m.pegarRodadas).not.toHaveBeenCalled();
  });

  it("o limite de 3 ao mesmo tempo continua: a 4ª só começa quando uma vaga fica livre", async () => {
    prender("a", "b", "c", "d", "e");
    fila.push({ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" });
    const execucao = rodarCiclo({ fimEm: agora + 45_000 });
    await tick();
    expect(iniciadas).toEqual(["a", "b", "c"]);

    soltar("b");
    await tick();
    expect(iniciadas).toEqual(["a", "b", "c", "d"]);
    soltar("a");
    soltar("c");
    await tick();
    expect(iniciadas).toEqual(["a", "b", "c", "d", "e"]);
    soltarTodas();
    const resumo = await execucao;
    expect(resumo.rodadas.respondidas).toBe(5);
  });

  it("o lead que fica pronto no meio começa antes de a rodada pura mais lenta acabar", async () => {
    const inicio = agora;
    // 3 rodadas puras (retornos das 09:00): 10 s, 20 s e 40 s
    prender("p10", "p20", "p40", "lead");
    fila.push({ id: "p10" }, { id: "p20" }, { id: "p40" });
    const execucao = rodarCiclo({ fimEm: inicio + 45_000 });
    await tick();
    expect(iniciadas).toEqual(["p10", "p20", "p40"]);

    // aos 5 s o lead escreve: as 3 vagas estão ocupadas, ele espera a primeira livre
    agora = inicio + 5_000;
    fila.push({ id: "lead" });
    await tick();
    expect(iniciadas).not.toContain("lead");

    // aos 10 s a vaga da pura mais curta termina e pega o lead, 30 s antes de a mais lenta acabar
    agora = inicio + 10_000;
    soltar("p10");
    await tick();
    expect(iniciadas).toEqual(["p10", "p20", "p40", "lead"]);

    agora = inicio + 20_000;
    soltar("p20");
    agora = inicio + 25_000;
    soltar("lead");
    agora = inicio + 40_000;
    soltar("p40");
    const resumo = await execucao;
    expect(resumo.rodadas.respondidas).toBe(4);
    expect(resumo.rodadas.falhas).toBe(0);
  });

  it("a vaga que termina sem 20 s até o fim não pega o lead (ele fica para o bastão)", async () => {
    const inicio = agora;
    prender("a", "b", "c");
    fila.push({ id: "a" }, { id: "b" }, { id: "c" });
    const execucao = rodarCiclo({ fimEm: inicio + 45_000 });
    await tick();
    fila.push({ id: "lead" });
    agora = inicio + 26_000; // sobram 19 s
    soltar("a");
    await tick();
    expect(iniciadas).not.toContain("lead");
    expect(fila).toEqual([{ id: "lead" }]);
    soltarTodas();
    await execucao;
  });

  it("vaga que volta vazia: ninguém chama o banco de novo até uma rodada terminar", async () => {
    prender("a", "b");
    fila.push({ id: "a" }, { id: "b" });
    const execucao = rodarCiclo({ fimEm: agora + 45_000 });
    await tick();
    await tick();
    // a 1ª e a 2ª vagas pegaram; a 3ª voltou vazia; nenhuma chamada a mais
    expect(m.pegarRodadasComRetornos).toHaveBeenCalledTimes(3);
    expect(iniciadas).toEqual(["a", "b"]);
    soltarTodas();
    await execucao;
  });

  it("fila vazia no começo: uma pegada só (as 3 vagas não chamam juntas)", async () => {
    const resumo = await rodarCiclo({ fimEm: agora + 45_000 });
    expect(m.pegarRodadasComRetornos).toHaveBeenCalledTimes(1);
    expect(resumo.rodadas).toEqual({ respondidas: 0, falhas: 0 });
  });

  it("a vaga vazia só espera a próxima vaga terminar: quem termina chama até voltar vazia (o lead no meio é pego)", async () => {
    const inicio = agora;
    // duas rodadas lentas ocupam duas vagas; a 3ª vaga volta vazia no começo
    prender("b", "c", "lead");
    fila.push({ id: "b" }, { id: "c" });
    const execucao = rodarCiclo({ fimEm: inicio + 45_000 });
    await tick();
    expect(m.pegarRodadasComRetornos).toHaveBeenCalledTimes(3);

    // aos 5 s um lead escreve; ninguém chama o banco (a vaga vazia está suspensa)
    agora = inicio + 5_000;
    fila.push({ id: "lead" });
    await tick();
    expect(m.pegarRodadasComRetornos).toHaveBeenCalledTimes(3);
    expect(iniciadas).toEqual(["b", "c"]);

    // aos 12 s a vaga de "b" termina e o lead é pego antes de "c" acabar. Com uma vaga ainda livre,
    // a pegada seguinte volta vazia e para: 1 pegada com o lead e 1 vazia, não uma por vaga
    agora = inicio + 12_000;
    soltar("b");
    await tick();
    expect(iniciadas).toEqual(["b", "c", "lead"]);
    expect(m.pegarRodadasComRetornos).toHaveBeenCalledTimes(5);

    // "lead" termina e a fila está vazia: chama uma vez, volta vazia e para
    agora = inicio + 15_000;
    soltar("lead");
    await tick();
    expect(m.pegarRodadasComRetornos).toHaveBeenCalledTimes(6);
    await tick();
    expect(m.pegarRodadasComRetornos).toHaveBeenCalledTimes(6);

    soltarTodas();
    await execucao;
    // "c" é a última a terminar: a etapa acaba sem chamar o banco de novo (os envios saem na hora)
    expect(m.pegarRodadasComRetornos).toHaveBeenCalledTimes(6);
  });

  it("no erro da irmã: anota e recua para a pegar_rodadas de hoje pedindo 1, e trata toda rodada devolvida", async () => {
    m.pegarRodadasComRetornos.mockRejectedValue(new Error("pegar_rodadas_com_retornos:57014"));
    m.pegarRodadas
      .mockResolvedValueOnce([{ id: "r1" }])
      .mockResolvedValueOnce([{ id: "r2" }, { id: "r3" }])
      .mockResolvedValue([]);
    const resumo = await rodarCiclo({ fimEm: agora + 45_000 });
    expect(m.pegarRodadas.mock.calls.every((c) => c[0] === 1)).toBe(true);
    expect(m.pegarRodadas).toHaveBeenCalled();
    // nenhuma rodada devolvida fica sem responderRodada
    expect(m.responderRodada.mock.calls.map((c) => (c[0] as { id: string }).id).sort()).toEqual([
      "r1",
      "r2",
      "r3",
    ]);
    expect(resumo.rodadas.respondidas).toBe(3);
    // o erro da irmã fica no resumo, só com o código
    expect(resumo.erros.rodadas).toContain("pegar_rodadas_com_retornos:57014");
  });

  it("erro da irmã e do recuo: anota os dois, termina sem lançar e as outras rodadas seguem", async () => {
    prender("a");
    m.pegarRodadasComRetornos
      .mockResolvedValueOnce([{ id: "a" }])
      .mockRejectedValue(new Error("pegar_rodadas_com_retornos:08006"));
    m.pegarRodadas.mockRejectedValue(new Error("pegar_rodadas:08006"));
    const execucao = rodarCiclo({ fimEm: agora + 45_000 });
    await tick();
    soltar("a");
    const resumo = await execucao;
    expect(resumo.rodadas.respondidas).toBe(1);
    expect(resumo.erros.rodadas).toEqual(
      expect.arrayContaining(["pegar_rodadas_com_retornos:08006", "pegar_rodadas:08006"]),
    );
  });

  it("rodada que falha numa vaga vira falhar_rodada passageira e não derruba as outras", async () => {
    prender("a", "b");
    fila.push({ id: "a" }, { id: "b" }, { id: "c" });
    const execucao = rodarCiclo({ fimEm: agora + 45_000 });
    await tick();
    adiaveis.get("a")?.falhar(new Error("erro_ia"));
    await tick();
    expect(m.falharRodada).toHaveBeenCalledWith("a", "erro_provedor", true);
    // a vaga da que falhou segue: "c" já começou
    expect(iniciadas).toEqual(["a", "b", "c"]);
    soltar("b");
    const resumo = await execucao;
    expect(resumo.rodadas).toEqual({ respondidas: 2, falhas: 1 });
    expect(m.falharRodada).toHaveBeenCalledTimes(1);
  });

  it("falhar_rodada que também falha: anota e a vaga segue", async () => {
    prender("a");
    fila.push({ id: "a" }, { id: "b" });
    m.falharRodada.mockRejectedValue(new Error("falhar_rodada:08006"));
    const execucao = rodarCiclo({ fimEm: agora + 45_000 });
    await tick();
    adiaveis.get("a")?.falhar(new Error("erro_ia"));
    const resumo = await execucao;
    expect(resumo.rodadas).toEqual({ respondidas: 1, falhas: 1 });
    expect(resumo.erros.rodadas).toEqual(
      expect.arrayContaining(["erro_ia", "falhar_rodada:08006"]),
    );
  });

  it("os envios só começam depois de todas as vagas terminarem", async () => {
    prender("a", "b");
    fila.push({ id: "a" }, { id: "b" });
    m.pegarEnvios.mockResolvedValue([]);
    const execucao = rodarCiclo({ fimEm: agora + 45_000 });
    await tick();
    soltar("a");
    await tick();
    expect(m.pegarEnvios).not.toHaveBeenCalled();
    soltar("b");
    await execucao;
    expect(m.pegarEnvios).toHaveBeenCalled();
  });

  it("rodada que termina sozinha libera os envios na hora: o lead que ficou pronto no meio é pego na passada seguinte", async () => {
    prender("a", "b");
    fila.push({ id: "a" });
    m.pegarEnvios.mockResolvedValue([]);
    const execucao = rodarCiclo({ fimEm: agora + 45_000 });
    await tick();
    expect(iniciadas).toEqual(["a"]);
    // o lead B fica pronto enquanto A ainda roda; a vaga vazia está suspensa
    fila.push({ id: "b" });
    await tick();
    expect(iniciadas).toEqual(["a"]);
    // A termina sozinha: a etapa acaba e os envios saem antes de B começar
    soltar("a");
    await tick();
    expect(m.pegarEnvios).toHaveBeenCalled();
    expect(iniciadas).toEqual(["a"]);
    expect(fila).toEqual([{ id: "b" }]);
    soltarTodas();
    await execucao;
  });

  it("somenteEnvios: nenhuma vaga (nem a irmã nem o recuo)", async () => {
    fila.push({ id: "a" });
    await rodarCiclo({ somenteEnvios: true, fimEm: agora + 45_000 });
    expect(m.pegarRodadasComRetornos).not.toHaveBeenCalled();
    expect(m.pegarRodadas).not.toHaveBeenCalled();
    expect(m.responderRodada).not.toHaveBeenCalled();
  });
});

describe("rodarLaco", () => {
  it("sem trabalho: repete a passada a cada 2 s e respeita os 45 s", async () => {
    const inicio = agora;
    const resumo = await rodarLaco({ orcamentoMs: 45_000 });
    // passadas em 0, 2, 4, ..., 40 s (sobram 5 s); depois, a espera deixaria só 3 s
    expect(resumo.passadas).toBe(21);
    expect(esperas.every((ms) => ms === 2_000)).toBe(true);
    expect(esperas).toHaveLength(20);
    expect(agora - inicio).toBeLessThanOrEqual(45_000);
    expect(45_000 - (agora - inicio)).toBeGreaterThanOrEqual(5_000);
    // envios só com 8 s sobrando: passadas de 0 a 36 s
    expect(m.pegarEnvios).toHaveBeenCalledTimes(19);
  });

  it("cada passada recebe o prazo que sobra, e nenhuma começa com menos de 5 s", async () => {
    const inicio = agora;
    const prazos: number[] = [];
    m.pegarRodadasComRetornos.mockImplementation(async () => {
      return [{ id: "r" + agora }];
    });
    m.responderRodada.mockImplementation(async (_r: unknown, o: { fimEm: number }) => {
      prazos.push(o.fimEm - agora);
      agora += 12_000;
    });
    const resumo = await rodarLaco({ orcamentoMs: 45_000 });
    // 1ª passada em 0 s (rodada até 12 s), 2ª em 12 s (até 24 s), 3ª em 24 s: sobram 21 s,
    // ainda cabe uma rodada (até 36 s); de 36 s em diante sobram menos de 20 s: sem rodada,
    // passadas ociosas a cada 2 s até sobrarem 5 s.
    expect(prazos).toEqual([45_000, 33_000, 21_000]);
    expect(resumo.rodadas.respondidas).toBe(3);
    expect(agora - inicio).toBeLessThanOrEqual(45_000);
    expect(resumo.passadas).toBeGreaterThanOrEqual(4);
  });

  it("passada com trabalho emenda na próxima sem esperar", async () => {
    const inicio = agora;
    // pegarMidias abre cada passada: o relógio falso nele marca o começo de cada uma
    const comecos: number[] = [];
    m.pegarMidias.mockImplementation(async () => {
      comecos.push(agora - inicio);
      return [];
    });
    m.pegarEnvios
      .mockResolvedValueOnce([mensagem(1)])
      .mockResolvedValueOnce([mensagem(2)])
      .mockResolvedValueOnce([mensagem(3)])
      .mockResolvedValue([]);
    m.enviar.mockImplementation(async () => {
      agora += 1_000;
      return { id_externo: "W" };
    });
    const resumo = await rodarLaco({ orcamentoMs: 45_000 });
    expect(resumo.envios.enviados).toBe(3);
    // 1ª passada: 3 s de envios e a espera de 2 s da bolha seguinte (até 5 s). A 2ª começa
    // em 5 s, sem espera ociosa; a 2ª não acha nada, então a 3ª vem 2 s depois.
    expect(comecos.slice(0, 3)).toEqual([0, 5_000, 7_000]);
    expect(esperas.slice(0, 2)).toEqual([2_000, 2_000]);
  });

  it("o orçamento conta do início do pedido (inicioEm), não da chamada do laço", async () => {
    const inicioEm = agora - 3_000; // autenticação e import levaram 3 s
    const prazos: number[] = [];
    m.pegarRodadasComRetornos.mockResolvedValueOnce([{ id: "r1" }]);
    m.responderRodada.mockImplementation(async (_r: unknown, o: { fimEm: number }) => {
      prazos.push(o.fimEm);
    });
    const resumo = await rodarLaco({ inicioEm });
    expect(prazos).toEqual([inicioEm + 45_000]);
    expect(agora).toBeLessThanOrEqual(inicioEm + 45_000);
    expect(resumo.duracao_ms).toBe(agora - inicioEm);
  });

  it("pior caso no laço: rodada até fimEm - 3 s e gateway lento, tudo acaba até 50 s", async () => {
    const inicio = agora;
    const fimEm = inicio + 45_000;
    m.pegarRodadasComRetornos.mockResolvedValueOnce([{ id: "r1" }]);
    m.responderRodada.mockImplementation(async () => {
      agora = fimEm - 3_000; // a IA usa todo o tempo dela
    });
    let n = 0;
    m.pegarEnvios.mockImplementation(async () => [mensagem(++n)]);
    m.enviar.mockImplementation(async () => {
      agora += 10_000;
      return { id_externo: "W" };
    });
    const resumo = await rodarLaco({ orcamentoMs: 45_000 });
    // com 3 s sobrando, nenhum envio começa (precisaria de 13,5 s até o corte)
    expect(m.enviar).not.toHaveBeenCalled();
    expect(m.pegarEnvios).not.toHaveBeenCalled();
    expect(agora - inicio).toBeLessThanOrEqual(50_000);
    expect(resumo.envios.devolvidos).toBe(0);
  });

  it("passa o bastão só no trecho final (últimos 22 s), a cada passada até passar, e para", async () => {
    const inicio = agora;
    const chamadas: number[] = [];
    const respostas = ["sem_trabalho", "sem_trabalho", "passou"] as const;
    const passarBastao = vi.fn(async (fimEm: number) => {
      chamadas.push(agora - inicio);
      expect(fimEm).toBe(inicio + 45_000);
      return respostas[chamadas.length - 1] ?? "passou";
    });
    const resumo = await rodarLaco({ orcamentoMs: 45_000, passarBastao });
    // passadas ociosas a cada 2 s: a 1ª no trecho final é a de 24 s (sobram 21 s, menos que 22 s);
    // depois da 3ª (passou), não chama mais
    expect(chamadas).toEqual([24_000, 26_000, 28_000]);
    expect(resumo.bastao).toBe(true);
    // passou, o laço para na hora: o pg_net só despacha a sucessora quando esta chamada responder
    expect(agora - inicio).toBe(28_000);
    // sem passarBastao, o resumo não tem o campo
    expect(await rodarLaco({ orcamentoMs: 45_000 })).not.toHaveProperty("bastao");
  });

  it("toque que falha tenta de novo até 3 vezes por chamada; exceção conta como falha", async () => {
    let n = 0;
    const passarBastao = vi.fn(async () => {
      n++;
      if (n === 2) throw new Error("x");
      return "falhou" as const;
    });
    const resumo = await rodarLaco({ orcamentoMs: 45_000, passarBastao });
    expect(passarBastao).toHaveBeenCalledTimes(MAX_FALHAS_BASTAO);
    expect(resumo.passadas).toBeGreaterThan(MAX_FALHAS_BASTAO);
    expect(resumo).not.toHaveProperty("bastao");
  });

  it("eventos pendentes rodam só na 1ª passada", async () => {
    const resumo = await rodarLaco({ orcamentoMs: 45_000 });
    expect(resumo.passadas).toBeGreaterThan(1);
    expect(m.eventosPendentes).toHaveBeenCalledTimes(1);
  });

  it("mídia que falhou não é repetida na mesma chamada (nem na mesma passada)", async () => {
    m.pegarMidias.mockResolvedValue([mensagem(1, { tipo: "imagem", midia_ref_externa: "r" })]);
    m.baixarMidia.mockRejectedValue(new ErroGateway("falha_de_rede", false));
    const resumo = await rodarLaco({ orcamentoMs: 45_000 });
    expect(m.pegarMidias).toHaveBeenCalledTimes(1);
    expect(resumo.midias.falhas).toBe(1);
    expect(resumo.passadas).toBeGreaterThan(1);
  });

  it("mídia devolvida por falta de tempo: as passadas seguintes só pegam envio que cabe como mídia", async () => {
    m.pegarEnvios
      .mockResolvedValueOnce([
        mensagem(1, {
          tipo: "imagem",
          texto: null,
          midia_caminho: `${CONVERSA}/${msgId(1)}`,
          midia_mime: "image/png",
          tentativas: 1,
        }),
      ])
      .mockResolvedValue([mensagem(2)]);
    m.enviar.mockImplementation(async () => {
      agora += 1_000;
      return { id_externo: "W" };
    });
    // 12 s de orçamento: a 2ª passada ainda teria tempo para um texto, não para uma mídia
    const resumo = await rodarLaco({ orcamentoMs: 12_000 });
    expect(resumo.passadas).toBeGreaterThan(1);
    expect(m.pegarEnvios).toHaveBeenCalledTimes(1);
    expect(m.enviar).not.toHaveBeenCalled();
    expect(resumo.envios).toMatchObject({ devolvidos: 1, enviados: 0 });
  });

  it("orçamento menor que 5 s: nenhuma passada", async () => {
    const resumo = await rodarLaco({ orcamentoMs: 4_000 });
    expect(resumo.passadas).toBe(0);
    expect(m.pegarEnvios).not.toHaveBeenCalled();
  });
});

describe("achouTrabalho (a renovação do toque, na rota)", () => {
  it("só as contagens das etapas contam; erro sem contagem não é trabalho", async () => {
    const vazio = await rodarCiclo();
    expect(achouTrabalho(vazio)).toBe(false);
    expect(achouTrabalho({ ...vazio, eventos: { ...vazio.eventos, pendentes: 1 } })).toBe(true);
    expect(achouTrabalho({ ...vazio, envios: { ...vazio.envios, incertos: 1 } })).toBe(true);
    expect(achouTrabalho({ ...vazio, erros: { ...vazio.erros, rodadas: ["x"] } })).toBe(false);
  });
});
