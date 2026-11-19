import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// O motor acordado (motor.server.ts) sobre um supabaseAdmin falso: cada rpc fica registrada e a
// resposta vem do teste. Nada vai à rede nem ao banco.
const falso = vi.hoisted(() => {
  const estado = {
    rpcs: [] as { nome: string; args: unknown }[],
    responder: (_nome: string, _args: unknown): unknown => ({ data: null, error: null }),
  };
  const supabaseAdmin = {
    rpc: async (nome: string, args?: unknown) => {
      estado.rpcs.push({ nome, args });
      return estado.responder(nome, args);
    },
  };
  return { estado, supabaseAdmin };
});

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: falso.supabaseAdmin }));

type Motor = typeof import("./motor.server");
/** Um módulo novo por teste: o preparo lembrado (1 h por instância) não vaza entre os testes. */
let motor: Motor;

const nomes = () => falso.estado.rpcs.map((r) => r.nome);

beforeEach(async () => {
  vi.resetModules();
  motor = await import("./motor.server");
  falso.estado.rpcs = [];
  falso.estado.responder = (nome) =>
    nome === "acordar_motor" ? { data: "tocado", error: null } : { data: true, error: null };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("acordarMotor", () => {
  it("com origem válida: grava o endereço e pede o toque (sem renovar)", async () => {
    await expect(motor.acordarMotor("https://nina.exemplo.com")).resolves.toBe("tocado");
    expect(falso.estado.rpcs).toEqual([
      { nome: "motor_endereco", args: { p_url: "https://nina.exemplo.com" } },
      { nome: "acordar_motor", args: { p_renovar: false } },
    ]);
  });

  it("a origem vem normalizada (só https://<host>, sem caminho nem barra)", async () => {
    await motor.acordarMotor("https://Nina.Exemplo.com/");
    expect(falso.estado.rpcs[0]).toEqual({
      nome: "motor_endereco",
      args: { p_url: "https://nina.exemplo.com" },
    });
  });

  it("renovar: acordar_motor(true), sem gravar endereço", async () => {
    await expect(motor.acordarMotor(null, { renovar: true })).resolves.toBe("tocado");
    expect(falso.estado.rpcs).toEqual([{ nome: "acordar_motor", args: { p_renovar: true } }]);
  });

  it.each([
    ["a prévia do Lovable", "https://id-preview--abc123.lovable.app"],
    ["a prévia por nome", "https://preview--nina.lovable.app"],
    ["o editor", "https://abc123.lovableproject.com"],
    ["a máquina local", "https://localhost"],
    ["http", "http://nina.exemplo.com"],
    ["com porta", "https://nina.exemplo.com:8443"],
    ["texto que não é URL", "nina.exemplo.com"],
    ["vazia", ""],
  ])("%s não é gravada, mas o toque sai com o endereço que já estava", async (_caso, origem) => {
    await expect(motor.acordarMotor(origem)).resolves.toBe("tocado");
    expect(nomes()).toEqual(["acordar_motor"]);
  });

  it("devolve o que o banco respondeu; resposta estranha ou erro vira falhou", async () => {
    falso.estado.responder = () => ({ data: "recente", error: null });
    await expect(motor.acordarMotor()).resolves.toBe("recente");
    falso.estado.responder = () => ({ data: "sem_endereco", error: null });
    await expect(motor.acordarMotor()).resolves.toBe("sem_endereco");
    falso.estado.responder = () => ({ data: "outra_coisa", error: null });
    await expect(motor.acordarMotor()).resolves.toBe("falhou");
    falso.estado.responder = () => ({ data: null, error: { code: "42501", message: "x" } });
    await expect(motor.acordarMotor()).resolves.toBe("falhou");
    expect(console.error).toHaveBeenCalledWith("motor_toque_falhou", "42501");
  });

  it("nunca lança: o rpc que lança vira falhou", async () => {
    falso.estado.responder = () => {
      throw new Error("sem SUPABASE_SERVICE_ROLE_KEY");
    };
    await expect(motor.acordarMotor("https://nina.exemplo.com")).resolves.toBe("falhou");
  });

  it("o endereço que falha ao gravar não impede o toque", async () => {
    falso.estado.responder = (nome) =>
      nome === "motor_endereco"
        ? { data: null, error: { code: "23514", message: "x" } }
        : { data: "tocado", error: null };
    await expect(motor.acordarMotor("https://nina.exemplo.com")).resolves.toBe("tocado");
    expect(nomes()).toEqual(["motor_endereco", "acordar_motor"]);
  });

  it("teto de 3 s: o banco que não responde vira falhou no teto", async () => {
    vi.useFakeTimers();
    falso.estado.responder = () => new Promise(() => {});
    let resultado: string | null = null;
    void motor.acordarMotor().then((r) => (resultado = r));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(resultado).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(resultado).toBe("falhou");
  });

  it("tetoMs encurta o teto (o fim do laço passa o que sobra), mas nunca o alonga além de 3 s", async () => {
    vi.useFakeTimers();
    falso.estado.responder = () => new Promise(() => {});
    let curto: string | null = null;
    void motor.acordarMotor(null, { renovar: true, tetoMs: 1_000 }).then((r) => (curto = r));
    await vi.advanceTimersByTimeAsync(999);
    expect(curto).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(curto).toBe("falhou");

    let longo: string | null = null;
    void motor.acordarMotor(null, { renovar: true, tetoMs: 10_000 }).then((r) => (longo = r));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(longo).toBe("falhou");
  });
});

describe("conferirChaveDoMotor", () => {
  it("pergunta ao banco (motor_confere) e só aceita true", async () => {
    await expect(motor.conferirChaveDoMotor("c".repeat(64))).resolves.toBe(true);
    expect(falso.estado.rpcs).toEqual([
      { nome: "motor_confere", args: { p_chave: "c".repeat(64) } },
    ]);
    falso.estado.responder = () => ({ data: false, error: null });
    await expect(motor.conferirChaveDoMotor("d".repeat(64))).resolves.toBe(false);
    falso.estado.responder = () => ({ data: "true", error: null });
    await expect(motor.conferirChaveDoMotor("d".repeat(64))).resolves.toBe(false);
  });

  it.each([
    ["nula", null],
    ["vazia", ""],
    ["comprida demais", "x".repeat(201)],
    ["64 caracteres que não são hexadecimais", "x".repeat(64)],
    ["hexadecimal maiúsculo", "C".repeat(64)],
    ["hexadecimal curto", "c".repeat(63)],
    ["hexadecimal comprido", "c".repeat(65)],
  ])(
    "%s: não, sem ir ao banco (a chave é sempre 64 hexadecimais minúsculos)",
    async (_caso, chave) => {
      await expect(motor.conferirChaveDoMotor(chave)).resolves.toBe(false);
      expect(falso.estado.rpcs).toEqual([]);
    },
  );

  it("erro ou exceção do banco: não", async () => {
    falso.estado.responder = () => ({ data: null, error: { code: "08006", message: "x" } });
    await expect(motor.conferirChaveDoMotor("c".repeat(64))).resolves.toBe(false);
    falso.estado.responder = () => {
      throw new Error("x");
    };
    await expect(motor.conferirChaveDoMotor("c".repeat(64))).resolves.toBe(false);
    expect(nomes()).toEqual(["motor_confere", "motor_confere"]);
  });
});

describe("esperarJanelaDoToque", () => {
  it("espera até vistoEm + 40 s + 1,5 s, e não espera quando a janela já fechou", async () => {
    vi.useFakeTimers();
    const visto = Date.now();
    vi.setSystemTime(visto + 38_500);
    let acabou = false;
    void motor.esperarJanelaDoToque(visto).then(() => (acabou = true));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(acabou).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(acabou).toBe(true);

    let fechada = false;
    void motor.esperarJanelaDoToque(Date.now() - 41_500).then(() => (fechada = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(fechada).toBe(true);
  });

  it("com ateEm, nunca espera além dele (a rota guarda o tempo da leitura e do toque)", async () => {
    vi.useFakeTimers();
    const visto = Date.now();
    let acabou = false;
    void motor.esperarJanelaDoToque(visto, visto + 30_000).then(() => (acabou = true));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(acabou).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(acabou).toBe(true);

    // o ateEm depois da janela não alonga a espera
    let janela = false;
    void motor.esperarJanelaDoToque(Date.now(), Date.now() + 60_000).then(() => (janela = true));
    await vi.advanceTimersByTimeAsync(41_500);
    expect(janela).toBe(true);
  });
});

describe("prepararCopia", () => {
  it("chama preparar_copia uma vez e lembra por 1 h nesta instância", async () => {
    let agora = Date.parse("2026-11-03T12:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => agora);
    falso.estado.responder = () => ({ data: "preparada", error: null });
    await expect(motor.prepararCopia()).resolves.toBe("preparada");
    agora += 60 * 60 * 1000 - 1;
    // dentro da 1 h: lembrado (e já pronta)
    await expect(motor.prepararCopia()).resolves.toBe("pronta");
    expect(nomes()).toEqual(["preparar_copia"]);
    agora += 1;
    falso.estado.responder = () => ({ data: "pronta", error: null });
    await expect(motor.prepararCopia()).resolves.toBe("pronta");
    expect(nomes()).toEqual(["preparar_copia", "preparar_copia"]);
  });

  it("pedidos ao mesmo tempo dividem a mesma chamada", async () => {
    let soltar: (v: unknown) => void = () => {};
    falso.estado.responder = () => new Promise((ok) => (soltar = ok));
    const a = motor.prepararCopia();
    const b = motor.prepararCopia();
    soltar({ data: "pronta", error: null });
    await expect(Promise.all([a, b])).resolves.toEqual(["pronta", "pronta"]);
    expect(nomes()).toEqual(["preparar_copia"]);
  });

  it("a falha não fica lembrada: o pedido seguinte tenta de novo", async () => {
    falso.estado.responder = () => ({ data: null, error: { code: "42501", message: "x" } });
    await expect(motor.prepararCopia()).resolves.toBe("falhou");
    falso.estado.responder = () => {
      throw new Error("x");
    };
    await expect(motor.prepararCopia()).resolves.toBe("falhou");
    falso.estado.responder = () => ({ data: "estranho", error: null });
    await expect(motor.prepararCopia()).resolves.toBe("falhou");
    falso.estado.responder = () => ({ data: "pronta", error: null });
    await expect(motor.prepararCopia()).resolves.toBe("pronta");
    expect(nomes()).toHaveLength(4);
  });
});

describe("pendenciasDoMotor", () => {
  it("lê a linha de motor_pendencias_com_retornos em ms; coluna nula fica null", async () => {
    falso.estado.responder = () => ({
      data: [
        {
          proximo_em: "2026-11-03T12:05:00+00:00",
          vencido_desde: "2026-11-03T11:58:00-03:00",
          atrasado_desde: "2026-11-03T11:40:00+00:00",
        },
      ],
      error: null,
    });
    await expect(motor.pendenciasDoMotor()).resolves.toEqual({
      proximoEm: Date.parse("2026-11-03T12:05:00Z"),
      vencidoDesde: Date.parse("2026-11-03T14:58:00Z"),
      atrasadoDesde: Date.parse("2026-11-03T11:40:00Z"),
    });
    expect(falso.estado.rpcs).toEqual([{ nome: "motor_pendencias_com_retornos", args: undefined }]);
  });

  it("sem linha: tudo null; erro ou exceção: null", async () => {
    falso.estado.responder = () => ({ data: [], error: null });
    await expect(motor.pendenciasDoMotor()).resolves.toEqual({
      proximoEm: null,
      vencidoDesde: null,
      atrasadoDesde: null,
    });
    falso.estado.responder = () => ({
      data: null,
      error: { code: "P0001", message: "sem_acesso" },
    });
    await expect(motor.pendenciasDoMotor()).resolves.toBeNull();
    falso.estado.responder = () => {
      throw new Error("x");
    };
    await expect(motor.pendenciasDoMotor()).resolves.toBeNull();
  });
});

describe("passar o bastão (a parada do worker)", () => {
  const AGORA = Date.parse("2026-11-13T12:42:30Z");
  const FIM = AGORA + 15_000; // a chamada termina daqui a 15 s
  const MIN = 60_000;
  const p = (x: { proximoEm?: number; vencidoDesde?: number }) => ({
    proximoEm: x.proximoEm ?? null,
    vencidoDesde: x.vencidoDesde ?? null,
    atrasadoDesde: null,
  });

  it("passa com trabalho vencido há menos de 10 min ou que vence até 15 s depois do fim", () => {
    // o lote vence daqui a 4 s, e esta chamada não começa rodada nova
    expect(motor.devePassarBastao(p({ proximoEm: AGORA + 4_000 }), FIM, AGORA)).toBe(true);
    expect(motor.devePassarBastao(p({ proximoEm: FIM + 15_000 }), FIM, AGORA)).toBe(true);
    expect(motor.devePassarBastao(p({ proximoEm: FIM + 15_001 }), FIM, AGORA)).toBe(false);
    expect(motor.devePassarBastao(p({ vencidoDesde: AGORA - 1_000 }), FIM, AGORA)).toBe(true);
    // vencido há mais de 10 min (um item que nunca é pego) não vira cadeia de chamadas
    expect(motor.devePassarBastao(p({ vencidoDesde: AGORA - 10 * MIN }), FIM, AGORA)).toBe(false);
    expect(motor.devePassarBastao(p({}), FIM, AGORA)).toBe(false);
    expect(motor.devePassarBastao(null, FIM, AGORA)).toBe(false);
  });

  it("com trabalho perto, toca com renovar; tocado e recente contam como passou", async () => {
    const agora = Date.now();
    falso.estado.responder = (nome) =>
      nome === "motor_pendencias_com_retornos"
        ? { data: [{ proximo_em: new Date(agora + 4_000).toISOString() }], error: null }
        : { data: "tocado", error: null };
    await expect(motor.passarBastao(agora + 15_000)).resolves.toBe("passou");
    expect(falso.estado.rpcs).toEqual([
      { nome: "motor_pendencias_com_retornos", args: undefined },
      { nome: "acordar_motor", args: { p_renovar: true } },
    ]);

    falso.estado.rpcs = [];
    falso.estado.responder = (nome) =>
      nome === "motor_pendencias_com_retornos"
        ? { data: [{ proximo_em: new Date(agora + 4_000).toISOString() }], error: null }
        : { data: "recente", error: null };
    await expect(motor.passarBastao(agora + 15_000)).resolves.toBe("passou");
  });

  it("sem trabalho perto não toca; sem a leitura das pendências ou com o toque falhando, falhou", async () => {
    const agora = Date.now();
    falso.estado.responder = () => ({
      data: [{ proximo_em: null, vencido_desde: null }],
      error: null,
    });
    await expect(motor.passarBastao(agora + 15_000)).resolves.toBe("sem_trabalho");
    expect(nomes()).toEqual(["motor_pendencias_com_retornos"]);

    falso.estado.responder = () => ({ data: null, error: { code: "57014", message: "x" } });
    await expect(motor.passarBastao(agora + 15_000)).resolves.toBe("falhou");

    falso.estado.responder = (nome) =>
      nome === "motor_pendencias_com_retornos"
        ? { data: [{ vencido_desde: new Date(agora - 1_000).toISOString() }], error: null }
        : { data: "sem_endereco", error: null };
    await expect(motor.passarBastao(agora + 15_000)).resolves.toBe("falhou");
  });
});

describe("deveRenovarToque (a regra do fim do laço)", () => {
  const AGORA = Date.parse("2026-11-03T12:00:00Z");
  const MIN = 60_000;
  const p = (x: { proximoEm?: number; vencidoDesde?: number; atrasadoDesde?: number }) => ({
    proximoEm: x.proximoEm ?? null,
    vencidoDesde: x.vencidoDesde ?? null,
    atrasadoDesde: x.atrasadoDesde ?? null,
  });

  it("item que fica pronto nos próximos 10 min (no limite também)", () => {
    expect(motor.deveRenovarToque(p({ proximoEm: AGORA + 10 * MIN }), false, AGORA)).toBe(true);
    expect(motor.deveRenovarToque(p({ proximoEm: AGORA + 10 * MIN + 1 }), false, AGORA)).toBe(
      false,
    );
  });

  it("item vencido há menos de 10 min", () => {
    expect(motor.deveRenovarToque(p({ vencidoDesde: AGORA - 10 * MIN + 1 }), false, AGORA)).toBe(
      true,
    );
    expect(motor.deveRenovarToque(p({ vencidoDesde: AGORA }), false, AGORA)).toBe(true);
  });

  it("vencido há 10 min ou mais, sem trabalho achado: não renova", () => {
    expect(motor.deveRenovarToque(p({ vencidoDesde: AGORA - 10 * MIN }), false, AGORA)).toBe(false);
    expect(motor.deveRenovarToque(p({ vencidoDesde: AGORA - 600 * MIN }), false, AGORA)).toBe(
      false,
    );
  });

  it("trabalho achado com pendência sobrando renova; sem pendência, não", () => {
    expect(motor.deveRenovarToque(p({ vencidoDesde: AGORA - 600 * MIN }), true, AGORA)).toBe(true);
    expect(motor.deveRenovarToque(p({ proximoEm: AGORA + 600 * MIN }), true, AGORA)).toBe(true);
    expect(motor.deveRenovarToque(p({}), true, AGORA)).toBe(false);
    expect(motor.deveRenovarToque(p({}), false, AGORA)).toBe(false);
  });

  it("retorno atrasado (atrasadoDesde): renova só junto de trabalho achado na chamada", () => {
    // a pilha das 09:00 anda enquanto a chamada acha trabalho
    expect(motor.deveRenovarToque(p({ atrasadoDesde: AGORA - 600 * MIN }), true, AGORA)).toBe(true);
    expect(motor.deveRenovarToque(p({ atrasadoDesde: AGORA - 12 * MIN }), true, AGORA)).toBe(true);
    // item atrasado que a chamada não consegue pegar não vira laço sem fim
    expect(motor.deveRenovarToque(p({ atrasadoDesde: AGORA - 600 * MIN }), false, AGORA)).toBe(
      false,
    );
    expect(motor.deveRenovarToque(p({ atrasadoDesde: AGORA - 12 * MIN }), false, AGORA)).toBe(
      false,
    );
    // e sem pendência nenhuma, nem com trabalho
    expect(motor.deveRenovarToque(p({}), true, AGORA)).toBe(false);
  });

  it("sem a leitura das pendências: só se achou trabalho", () => {
    expect(motor.deveRenovarToque(null, true, AGORA)).toBe(true);
    expect(motor.deveRenovarToque(null, false, AGORA)).toBe(false);
  });
});

describe("comTeto", () => {
  it("a promessa que rejeita vira o valor do teto, na hora", async () => {
    await expect(motor.comTeto(Promise.reject(new Error("x")), 1_000, "teto")).resolves.toBe(
      "teto",
    );
    await expect(motor.comTeto(Promise.resolve("ok"), 1_000, "teto")).resolves.toBe("ok");
  });
});
