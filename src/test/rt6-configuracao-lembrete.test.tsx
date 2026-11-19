import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TelaConfiguracao } from "@/features/plataforma/configuracao";
import {
  CartaoRitmo,
  LIMITES_LEMBRETE,
  mudarHoras,
  type PropsLembrete,
} from "@/features/plataforma/configuracao/CartaoRitmo";
import {
  ServidorConfiguracaoContexto,
  type ServidorConfiguracao,
} from "@/features/plataforma/dados/configuracao";
import { ProvedorDados } from "@/features/plataforma/dados/ProvedorDados";
import { criarClienteFalso, type Consulta } from "@/features/plataforma/dados/testes/clienteFalso";
import type { AjusteLembrete, Leitura } from "@/features/plataforma/dados/tipos";
import { criarEstadoInicial, type ChaveIA } from "@/features/plataforma/exemplo";
import { ProvedorPapel } from "@/features/plataforma/papel";

// T9 (retornos da Nina): o interruptor e as horas do lembrete no cartão de ritmo (quadros 20 a 24).
// O cliente do Supabase e o servidor da Configuração são falsos: nada vai à rede nem ao banco.

vi.mock("@/components/nina/VooNina", async (original) => {
  const real = await original<typeof import("@/components/nina/VooNina")>();
  return { ...real, movimentoReduzido: () => true, rolarAteEMedir: () => Promise.resolve(null) };
});

const AGORA = new Date("2026-11-18T15:00:00-03:00");
const UID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EU = {
  id: "mb-1",
  nome: "Ana",
  email: "ana@teste.com",
  papel: "admin",
  ativo: true,
  user_id: UID,
  criado_em: "2026-10-01T12:00:00.000Z",
  vistos: {},
};
const minAtras = (m: number) => new Date(AGORA.getTime() - m * 60_000).toISOString();
const CONEXAO = {
  id: "cx-1",
  nome: "(11) 91234-5678",
  gateway: "zapi",
  status: "conectada",
  ativa: true,
  oficial: false,
  id_externo: null,
  ultimo_erro: null,
  criado_em: "2026-10-20T12:00:00.000Z",
  atualizado_em: "2026-10-20T12:00:00.000Z",
};
const CHAVE = {
  id: "k-1",
  finalidade: "resposta",
  provedor: "anthropic",
  modelo: "claude-haiku-5-5",
  status: "ativa",
  ultimos4: "TSTE",
  ultimo_erro: null,
  validada_em: minAtras(60),
  atualizada_em: minAtras(60),
  atualizada_por: null,
} as ChaveIA;
const CONFIG = {
  id: 1,
  espera_lote_s: 8,
  espera_lote_max_s: 60,
  onboarding_concluido_em: "2026-10-21T12:00:00.000Z",
  atualizado_em: minAtras(1),
  worker_visto_em: minAtras(0.5),
  lembrete_ligado: true,
  lembrete_horas: 3,
};

function servidorFalso(sobre: Record<string, unknown> = {}) {
  const ok = (extra: Record<string, unknown> = {}) => vi.fn(async () => ({ ok: true, ...extra }));
  return {
    salvarRitmo: ok({ espera: 8, teto: 60 }),
    ...sobre,
  } as unknown as ServidorConfiguracao & { salvarRitmo: ReturnType<typeof vi.fn> };
}

function montarBanco(config: Record<string, unknown> = CONFIG, servidor = servidorFalso()) {
  const f = criarClienteFalso({
    uid: UID,
    consulta: (c: Consulta) => {
      switch (c.tabela) {
        case "membros":
          return { data: EU, error: null };
        case "conexoes":
          return { data: CONEXAO, error: null };
        case "ia_chaves":
          return { data: [CHAVE], error: null };
        case "configuracao":
          return { data: config, error: null };
        default:
          return undefined;
      }
    },
    rpc: (nome) =>
      nome === "motor_pendencias" || nome === "motor_pendencias_com_retornos"
        ? { data: [{ proximo_em: null, vencido_desde: null, atrasado_desde: null }], error: null }
        : undefined,
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ProvedorPapel papel="admin">
        <Suspense fallback={<p>suspenso</p>}>
          <ProvedorDados fonte="banco" cliente={f.cliente}>
            <ServidorConfiguracaoContexto.Provider value={servidor}>
              <TelaConfiguracao />
            </ServidorConfiguracaoContexto.Provider>
          </ProvedorDados>
        </Suspense>
      </ProvedorPapel>
    </QueryClientProvider>,
  );
  return { f, servidor, qc };
}

function montarExemplo() {
  return render(
    <ProvedorPapel inicial="admin">
      <ProvedorDados
        exemplo={criarEstadoInicial(AGORA)}
        progredirEnvios={false}
        relogio={() => new Date(AGORA)}
      >
        <TelaConfiguracao />
      </ProvedorDados>
    </ProvedorPapel>,
  );
}

async function andar(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function carregar() {
  for (let i = 0; i < 6; i++) await andar(5);
}

const ritmo = () => document.getElementById("cfg-card-ritmo")!;
const botao = (nome: string | RegExp) => within(ritmo()).getByRole("button", { name: nome });
const chave = () =>
  within(ritmo()).getByRole("switch", { name: "Lembrete para quem parou de responder" });
const horas = () => screen.getByTestId("cfg-valor-horas").textContent;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AGORA);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("mudarHoras", () => {
  it("anda de 1 em 1 hora, presa em 1 e 23, sem mexer no interruptor", () => {
    expect(LIMITES_LEMBRETE).toEqual({ min: 1, max: 23 });
    expect(mudarHoras({ ligado: false, horas: 3 }, 1)).toEqual({ ligado: false, horas: 4 });
    expect(mudarHoras({ ligado: true, horas: 3 }, -1)).toEqual({ ligado: true, horas: 2 });
    expect(mudarHoras({ ligado: true, horas: 1 }, -1).horas).toBe(1);
    expect(mudarHoras({ ligado: true, horas: 23 }, 1).horas).toBe(23);
  });
});

describe("quadro 20 a 22: o admin liga, desliga e ajusta as horas (modo exemplo)", () => {
  it("nasce ligado, com 3 h, e o interruptor tem role='switch' com o nome do bloco", () => {
    montarExemplo();
    expect(chave()).toHaveAttribute("aria-checked", "true");
    expect(chave()).toHaveAttribute("aria-describedby", "cfg-ajuda-lembrete");
    expect(within(chave()).getByText("Ligado")).toBeInTheDocument();
    expect(horas()).toBe("3h");
    expect(
      within(ritmo()).getByText(
        "Se o lead não responder à Nina nesse tempo, ela manda um lembrete. Uma vez só, entre 8h e 20h.",
      ),
    ).toBeInTheDocument();
    expect(within(ritmo()).queryByText("Mudanças ainda não salvas")).not.toBeInTheDocument();
  });

  it("desligar (quadro 21): o número some, a ajuda muda e o rodapé aparece; religar volta às horas de antes; Desfazer limpa", () => {
    montarExemplo();
    fireEvent.click(botao("Esperar 1 hora a mais para o lembrete"));
    expect(horas()).toBe("4h");
    fireEvent.click(chave());
    expect(chave()).toHaveAttribute("aria-checked", "false");
    expect(within(chave()).getByText("Desligado")).toBeInTheDocument();
    expect(screen.queryByTestId("cfg-valor-horas")).not.toBeInTheDocument();
    expect(
      within(ritmo()).getByText(
        "A Nina não lembra quem parou de responder. Os retornos combinados com o lead continuam valendo.",
      ),
    ).toBeInTheDocument();
    expect(within(ritmo()).getByText("Mudanças ainda não salvas")).toBeInTheDocument();
    fireEvent.click(chave());
    expect(horas()).toBe("4h");
    fireEvent.click(botao("Desfazer"));
    expect(horas()).toBe("3h");
    expect(chave()).toHaveAttribute("aria-checked", "true");
    expect(within(ritmo()).queryByText("Mudanças ainda não salvas")).not.toBeInTheDocument();
  });

  it("o interruptor responde ao Enter e ao Espaço (é um botão) e as horas travam em 1 e 23 (quadro 22)", () => {
    montarExemplo();
    const mais = botao("Esperar 1 hora a mais para o lembrete");
    for (let i = 0; i < 30; i++) fireEvent.click(mais);
    expect(horas()).toBe("23h");
    expect(mais).toHaveAttribute("aria-disabled", "true");
    expect(mais).not.toBeDisabled();
    const menos = botao("Esperar 1 hora a menos para o lembrete");
    for (let i = 0; i < 40; i++) fireEvent.click(menos);
    expect(horas()).toBe("1h");
    expect(menos).toHaveAttribute("aria-disabled", "true");
    expect(chave().tagName).toBe("BUTTON");
  });

  it("o ritmo continua como era: 8 s e 60 s, e salvar só o ritmo não fala do lembrete", async () => {
    montarExemplo();
    expect(screen.getByTestId("cfg-valor-espera").textContent).toBe("8s");
    fireEvent.click(botao("Esperar 1 segundo a mais"));
    fireEvent.click(botao("Salvar o ritmo"));
    await andar(200);
    expect(
      screen.getAllByText("Ritmo salvo. A Nina espera 9 s depois da última mensagem, até 60 s.")
        .length,
    ).toBeGreaterThan(0);
  });
});

describe("salvar com o lembrete (modo banco)", () => {
  it("lê o ajuste do banco (desligado, 6 h): o interruptor vem desligado e o número some", async () => {
    montarBanco({ ...CONFIG, lembrete_ligado: false, lembrete_horas: 6 });
    await carregar();
    expect(chave()).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByTestId("cfg-valor-horas")).not.toBeInTheDocument();
  });

  it("só o lembrete, desligando: manda o ritmo de hoje com o lembrete e avisa 'Lembrete desligado'", async () => {
    // o banco falso muda junto com o servidor (a releitura depois de salvar traz o valor novo)
    const banco = { ...CONFIG };
    const servidor = servidorFalso({
      salvarRitmo: vi.fn(async () => {
        banco.lembrete_ligado = false;
        return { ok: true, espera: 8, teto: 60 };
      }),
    });
    const { qc } = montarBanco(banco, servidor);
    await carregar();
    fireEvent.click(chave());
    fireEvent.click(botao("Salvar o ritmo"));
    await andar(200);
    expect(servidor.salvarRitmo).toHaveBeenCalledWith({
      espera: 8,
      teto: 60,
      lembrete: { ligado: false, horas: 3 },
    });
    expect(
      screen.getAllByText(
        "Lembrete desligado. Os retornos combinados com o lead continuam valendo.",
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/Ritmo salvo/)).not.toBeInTheDocument();
    // o rascunho acabou e o interruptor não pisca de volta: o cache já tem o valor gravado
    expect(within(ritmo()).queryByText("Mudanças ainda não salvas")).not.toBeInTheDocument();
    expect(chave()).toHaveAttribute("aria-checked", "false");
    expect(qc.getQueryData(["configuracao", "lembrete"])).toEqual({ ligado: false, horas: 3 });
  });

  it("só o lembrete, ligado com 5 h: usa as horas que o servidor devolveu", async () => {
    const servidor = servidorFalso({
      salvarRitmo: vi.fn(async () => ({
        ok: true,
        espera: 8,
        teto: 60,
        lembrete: { ligado: true, horas: 5 },
      })),
    });
    montarBanco(CONFIG, servidor);
    await carregar();
    fireEvent.click(botao("Esperar 1 hora a mais para o lembrete"));
    fireEvent.click(botao("Esperar 1 hora a mais para o lembrete"));
    fireEvent.click(botao("Salvar o ritmo"));
    await andar(200);
    expect(servidor.salvarRitmo).toHaveBeenCalledWith({
      espera: 8,
      teto: 60,
      lembrete: { ligado: true, horas: 5 },
    });
    expect(
      screen.getAllByText(
        "Lembrete salvo. Se o lead não responder em 5 h, a Nina manda um lembrete.",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("os dois: a frase do ritmo, um espaço e a do lembrete", async () => {
    const servidor = servidorFalso({
      salvarRitmo: vi.fn(async () => ({
        ok: true,
        espera: 9,
        teto: 60,
        lembrete: { ligado: true, horas: 4 },
      })),
    });
    montarBanco(CONFIG, servidor);
    await carregar();
    fireEvent.click(botao("Esperar 1 segundo a mais"));
    fireEvent.click(botao("Esperar 1 hora a mais para o lembrete"));
    fireEvent.click(botao("Salvar o ritmo"));
    await andar(200);
    expect(
      screen.getAllByText(
        "Ritmo salvo. A Nina espera 9 s depois da última mensagem, até 60 s. Lembrete salvo. Se o lead não responder em 4 h, a Nina manda um lembrete.",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("só o ritmo: o lembrete NÃO vai ao servidor (continua { espera, teto })", async () => {
    const { servidor } = montarBanco();
    await carregar();
    fireEvent.click(botao("Esperar 1 segundo a mais"));
    fireEvent.click(botao("Salvar o ritmo"));
    await andar(200);
    expect(servidor.salvarRitmo).toHaveBeenCalledWith({ espera: 9, teto: 60 });
  });

  it("o servidor recusa (fora do limite): mostra a mensagem dele e o rascunho fica na tela (quadro 23)", async () => {
    const servidor = servidorFalso({
      salvarRitmo: vi.fn(async () => ({
        ok: false,
        erro: "fora_do_limite",
        campo: "lembrete_horas",
        mensagem: "As horas do lembrete vão de 1 a 23.",
      })),
    });
    montarBanco(CONFIG, servidor);
    await carregar();
    fireEvent.click(botao("Esperar 1 hora a mais para o lembrete"));
    fireEvent.click(botao("Salvar o ritmo"));
    await andar(200);
    expect(screen.getAllByText("As horas do lembrete vão de 1 a 23.").length).toBeGreaterThan(0);
    expect(horas()).toBe("4h");
    expect(within(ritmo()).getByText("Mudanças ainda não salvas")).toBeInTheDocument();
  });

  it("falha de gravação: o aviso de hoje e o rascunho continua", async () => {
    const servidor = servidorFalso({
      salvarRitmo: vi.fn(async () => ({ ok: false, erro: "erro_ao_gravar" })),
    });
    montarBanco(CONFIG, servidor);
    await carregar();
    fireEvent.click(chave());
    fireEvent.click(botao("Salvar o ritmo"));
    await andar(200);
    expect(
      screen.getAllByText("Não conseguimos gravar agora. Tente de novo em instantes.").length,
    ).toBeGreaterThan(0);
    expect(chave()).toHaveAttribute("aria-checked", "false");
  });

  it("salvando: o interruptor e os botões das horas ficam com aria-disabled", async () => {
    let solta: (v: unknown) => void = () => {};
    const servidor = servidorFalso({ salvarRitmo: vi.fn(() => new Promise((r) => (solta = r))) });
    montarBanco(CONFIG, servidor);
    await carregar();
    fireEvent.click(botao("Esperar 1 hora a mais para o lembrete"));
    fireEvent.click(botao("Salvar o ritmo"));
    await andar(10);
    expect(chave()).toHaveAttribute("aria-disabled", "true");
    expect(botao("Esperar 1 hora a mais para o lembrete")).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(chave());
    expect(chave()).toHaveAttribute("aria-checked", "true");
    await act(async () => {
      solta({ ok: true, espera: 8, teto: 60, lembrete: { ligado: true, horas: 4 } });
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(chave()).not.toHaveAttribute("aria-disabled");
  });
});

describe("o cartão sozinho: leitura carregando, com erro e o atendente só vê (quadros 24)", () => {
  const leitura = (p: Partial<Leitura<AjusteLembrete>>): Leitura<AjusteLembrete> => ({
    dados: undefined,
    carregando: false,
    erro: null,
    tentarDeNovo: () => {},
    ...p,
  });
  function cartao(admin: boolean, lembrete: PropsLembrete | undefined) {
    return render(
      <CartaoRitmo
        admin={admin}
        salvo={{ espera: 8, teto: 60 }}
        rascunho={{ espera: 8, teto: 60 }}
        salvando={false}
        aoMudar={() => {}}
        aoDesfazer={() => {}}
        aoSalvar={() => {}}
        verTempo={false}
        aoAlternarTempo={() => {}}
        realce={null}
        oculto={false}
        lembrete={lembrete}
      />,
    );
  }
  const base = { mudou: false, aoAlternar: () => {}, aoMudarHoras: () => {} };

  it("atendente: a pílula 'Ligado' e '3h', sem interruptor e sem botões das horas", () => {
    const dados = { ligado: true, horas: 3 };
    cartao(false, { ...base, leitura: leitura({ dados }), atual: dados });
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.getByText("Ligado")).toHaveAttribute("data-so");
    expect(screen.getByTestId("cfg-valor-horas").textContent).toBe("3h");
    expect(screen.queryByRole("button", { name: /hora/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Salvar o ritmo" })).not.toBeInTheDocument();
  });

  it("atendente com o lembrete desligado: só a pílula 'Desligado' e a ajuda", () => {
    const dados = { ligado: false, horas: 3 };
    cartao(false, { ...base, leitura: leitura({ dados }), atual: dados });
    expect(screen.getByText("Desligado")).toHaveAttribute("data-so");
    expect(screen.queryByTestId("cfg-valor-horas")).not.toBeInTheDocument();
  });

  it("carregando: o rótulo e o osso de texto; o ritmo segue editável", () => {
    cartao(true, { ...base, leitura: leitura({ carregando: true }), atual: undefined });
    expect(screen.getByText("Lembrete para quem parou de responder")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Carregando o lembrete" })).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Esperar 1 segundo a mais" })).toBeInTheDocument();
  });

  it("erro sem dados: o aviso 'Não deu para carregar o lembrete' e 'Tentar de novo' chama a releitura", () => {
    const tentar = vi.fn();
    cartao(true, {
      ...base,
      leitura: leitura({ erro: "falha", tentarDeNovo: tentar }),
      atual: undefined,
    });
    expect(screen.getByText("Não deu para carregar o lembrete")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(tentar).toHaveBeenCalled();
  });

  it("sem a prop lembrete, o cartão fica como era (sem o 3º bloco)", () => {
    cartao(true, undefined);
    expect(screen.queryByText("Lembrete para quem parou de responder")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });
});
