import { readFileSync } from "node:fs";
import path from "node:path";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CaixaEscrever, type FaixaRetorno } from "@/features/plataforma/comum/CaixaEscrever";
import { EventoConversa } from "@/features/plataforma/comum/EventoConversa";
import { faixaDoRetorno } from "@/features/plataforma/comum/retornos";

import { AGORA_TESTE, retornoDeTeste } from "./retornos-fabrica";

// Retornos da Nina, a faixa da caixa de escrever (mockup, quadros 1, 9, 11,
// 15 e 16) e a linha do histórico em vermelho (quadro 10). O recuo, o corte de 2 linhas e as larguras
// não se medem em jsdom: o CSS tem os valores do mockup e a conferência é por print.

afterEach(cleanup);

let n = 0;
const novaConversa = () => `conv-rt2-${++n}`;
const campo = () => screen.getByRole("textbox", { name: /^Mensagem/ });
const faixaDom = () => document.querySelector<HTMLElement>("[data-faixa-retorno]");

/** A faixa do retorno como a Conversa a monta, com o que o teste quiser mudar. */
function retorno(
  extra: Partial<FaixaRetorno> = {},
  comNina = true,
  motivo?: string | null,
): FaixaRetorno {
  const conteudo = faixaDoRetorno({
    retorno: retornoDeTeste({ id: "r1", ...(motivo !== undefined ? { motivo } : {}) }),
    comNina,
    agora: AGORA_TESTE,
  })!;
  return { ...conteudo, cancelando: false, aoCancelar: vi.fn(), ...extra };
}

function montar(props: Partial<Parameters<typeof CaixaEscrever>[0]> = {}) {
  return render(
    <CaixaEscrever
      conversaId={novaConversa()}
      aoEnviar={vi.fn()}
      destinatario="Carla"
      {...props}
    />,
  );
}

describe("CaixaEscrever: só a faixa do retorno (quadro 1)", () => {
  it("marca a faixa e a caixa sobe por cima dela; o texto tem o título em negrito e o motivo", () => {
    montar({ retorno: retorno() });
    const faixa = faixaDom()!;
    expect(faixa).not.toBeNull();
    expect(faixa).toHaveAttribute("data-tom", "retorno");
    expect(faixa).not.toHaveAttribute("data-dupla");
    expect(document.querySelector("[data-com-faixa]")).not.toBeNull();
    expect(within(faixa).getByText("Retorno marcado para amanhã, 09:00").tagName).toBe("B");
    expect(faixa).toHaveTextContent(
      "Retorno marcado para amanhã, 09:00 · Retomar a proposta do plano anual, depois da conversa dela com o sócio",
    );
  });

  it("o link se chama 'Cancelar o retorno de amanhã, 09:00' e começa pelo texto visível (WCAG 2.5.3)", () => {
    montar({ retorno: retorno() });
    const botao = within(faixaDom()!).getByRole("button", {
      name: "Cancelar o retorno de amanhã, 09:00",
    });
    expect(botao).toHaveTextContent("Cancelar");
    expect(botao).not.toHaveAttribute("aria-disabled");
    expect(botao).not.toHaveAttribute("aria-busy");
  });

  it("clicar chama o aoCancelar uma vez", () => {
    const aoCancelar = vi.fn();
    montar({ retorno: retorno({ aoCancelar }) });
    fireEvent.click(screen.getByRole("button", { name: /^Cancelar o retorno/ }));
    expect(aoCancelar).toHaveBeenCalledTimes(1);
  });

  it("a dica 'você assume ao enviar' continua no campo e na descrição; o texto do retorno não entra nela", () => {
    const dica = "Escreva para Carla · você assume ao enviar";
    montar({ retorno: retorno(), dica });
    expect(campo()).toHaveAttribute("placeholder", dica);
    const ids = (campo().getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
    const descricao = ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    expect(descricao).toContain(dica);
    expect(descricao).not.toContain("Retorno marcado");
  });

  it("a faixa não é região viva nem tem papel: quem avisa é a linha do histórico", () => {
    montar({ retorno: retorno() });
    const faixa = faixaDom()!;
    expect(faixa).not.toHaveAttribute("role");
    expect(faixa.querySelector("[aria-live], [role='status'], [role='alert']")).toBeNull();
  });

  it("quadro 15: o texto inteiro vai no title (o corte em 2 linhas é só visual)", () => {
    const longo =
      "Retomar a proposta do plano anual depois da conversa dela com o sócio e do fechamento do trimestre";
    const f = retorno({}, true, longo);
    montar({ retorno: f });
    const txt = within(faixaDom()!).getByTitle(f.frase);
    expect(txt).toHaveTextContent(longo);
    expect(f.frase).toBe(`Retorno marcado para amanhã, 09:00 · ${longo}`);
  });

  it("o ícone fica fora do trecho que o corte de 2 linhas conta", () => {
    montar({ retorno: retorno() });
    const faixa = faixaDom()!;
    const icone = faixa.querySelector("svg")!;
    expect(icone.closest("[aria-hidden='true']")).not.toBeNull();
    const texto = within(faixa).getByTitle(/^Retorno marcado/);
    expect(texto.contains(icone)).toBe(false);
  });
});

describe("CaixaEscrever: cancelando (quadro 11)", () => {
  it("o link vira 'Cancelando…', aria-disabled e aria-busy (nunca disabled), e o clique não chama", () => {
    const aoCancelar = vi.fn();
    montar({ retorno: retorno({ cancelando: true, aoCancelar }) });
    const botao = within(faixaDom()!).getByRole("button", {
      name: "Cancelando o retorno de amanhã, 09:00",
    });
    expect(botao).toHaveTextContent("Cancelando…");
    expect(botao).toHaveAttribute("aria-disabled", "true");
    expect(botao).toHaveAttribute("aria-busy", "true");
    expect(botao).not.toBeDisabled();
    fireEvent.click(botao);
    expect(aoCancelar).not.toHaveBeenCalled();
  });

  it("o foco fica no link enquanto cancela", () => {
    const { rerender } = montar({ retorno: retorno() });
    const botao = screen.getByRole("button", { name: /^Cancelar o retorno/ });
    botao.focus();
    expect(document.activeElement).toBe(botao);
    rerender(
      <CaixaEscrever
        conversaId="conv-rt2-foco"
        aoEnviar={vi.fn()}
        destinatario="Carla"
        retorno={retorno({ cancelando: true })}
      />,
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /^Cancelando o retorno/ }),
    );
  });
});

describe("CaixaEscrever: a faixa dupla (quadro 9)", () => {
  it("com a faixa de hoje: as duas frases, a descrição do campo é só a da linha 1 e a nota fica no lugar do motivo", () => {
    montar({
      retorno: retorno({}, false),
      faixa: {
        tom: "pessoa",
        texto: "Marina está atendendo. Se você enviar, a conversa continua com Marina.",
      },
    });
    const faixa = faixaDom()!;
    expect(faixa).toHaveAttribute("data-dupla");
    expect(faixa).toHaveAttribute("data-tom", "pessoa");
    expect(
      within(faixa).getByText(
        "Marina está atendendo. Se você enviar, a conversa continua com Marina.",
      ),
    ).toBeInTheDocument();
    expect(within(faixa).getByText("Retorno marcado para amanhã, 09:00")).toBeInTheDocument();
    expect(
      within(faixa).getByText("A Nina só envia se a conversa voltar para ela antes da hora."),
    ).toBeInTheDocument();
    expect(within(faixa).queryByText(/Retomar a proposta/)).toBeNull();
    // o campo é descrito só pela linha 1
    const ids = (campo().getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
    const descricao = ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    expect(descricao).toContain("Marina está atendendo");
    expect(descricao).not.toContain("Retorno marcado");
    expect(descricao).not.toContain("A Nina só envia");
  });

  it("com o bloqueio: a faixa vermelha e o retorno; o 'Reconectar' vem antes do 'Cancelar' no Tab", () => {
    montar({ bloqueio: "sem_conexao", aoReconectar: vi.fn(), retorno: retorno() });
    const faixa = faixaDom()!;
    expect(faixa).toHaveAttribute("data-dupla");
    expect(faixa).toHaveAttribute("data-tom", "sem_conexao");
    const botoes = within(faixa)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(botoes).toEqual(["Reconectar", "Cancelar"]);
  });

  it("a ação da linha 1 continua funcionando na dupla", () => {
    const aoReconectar = vi.fn();
    montar({ bloqueio: "sem_conexao", aoReconectar, retorno: retorno() });
    fireEvent.click(screen.getByRole("button", { name: "Reconectar" }));
    expect(aoReconectar).toHaveBeenCalledTimes(1);
  });

  it("a dica sai da descrição com a faixa de hoje (como sempre), mesmo com o retorno", () => {
    const dica = "Escreva para Carla · você assume ao enviar";
    montar({
      retorno: retorno(),
      faixa: { tom: "falha", texto: "Sem crédito de IA: a Nina parou." },
      dica,
    });
    const ids = (campo().getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
    const descricao = ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    expect(descricao).not.toContain(dica);
  });
});

describe("CaixaEscrever: sem o retorno, a marcação é a de hoje", () => {
  it("nenhuma faixa, nenhum atributo novo (quadro 14)", () => {
    const { container } = montar();
    expect(container.querySelector(".ceFaixa, [class*='ceFaixa']")).toBeNull();
    expect(
      document.querySelector("[data-faixa-retorno], [data-dupla], [data-com-faixa]"),
    ).toBeNull();
  });

  it("retorno nulo, ou só a faixa de hoje: sem data-faixa-retorno nem data-dupla, e as classes de antes", () => {
    montar({ retorno: null, faixa: { tom: "pessoa", texto: "Marina está atendendo." } });
    const faixa = document.querySelector("[data-tom='pessoa']") as HTMLElement;
    expect(faixa).not.toBeNull();
    expect(faixa).not.toHaveAttribute("data-faixa-retorno");
    expect(faixa).not.toHaveAttribute("data-dupla");
    // o ícone e a frase direto na faixa (sem a linha 1 da dupla) e o ceRet ausente
    expect(faixa.querySelector("[class*='ceFaixaL1'], [class*='ceRet']")).toBeNull();
    expect(faixa.children).toHaveLength(1);
    expect(within(faixa).getByText("Marina está atendendo.")).toBeInTheDocument();
  });
});

describe("EventoConversa: o negrito e a falha (quadro 10)", () => {
  it("aceita um trecho em negrito e mostra a hora em mono", () => {
    render(
      <EventoConversa
        texto={
          <>
            A Nina marcou um retorno para <b>qui, 19/11, às 09:00</b>
          </>
        }
        momento="2026-11-18T19:09:00.000Z"
      />,
    );
    const nota = screen.getByRole("note");
    expect(nota).toHaveTextContent("A Nina marcou um retorno para qui, 19/11, às 09:00 · 16:09");
    expect(within(nota).getByText("qui, 19/11, às 09:00").tagName).toBe("B");
    expect(nota).not.toHaveAttribute("data-tom");
  });

  it("tom falha: data-tom no role=note, a hora continua cinza", () => {
    render(
      <EventoConversa
        texto="Retorno das 09:00 não enviado: a conversa estava com a equipe"
        momento="2026-11-19T12:00:00.000Z"
        tom="falha"
      />,
    );
    const nota = screen.getByRole("note");
    expect(nota).toHaveAttribute("data-tom", "falha");
    expect(nota).toHaveTextContent(
      "Retorno das 09:00 não enviado: a conversa estava com a equipe · 09:00",
    );
  });

  it("o CSS tem a regra do negrito e a da falha em vermelho", () => {
    const css = readFileSync(
      path.resolve(__dirname, "../features/plataforma/comum/EventoConversa.module.css"),
      "utf-8",
    );
    expect(css).toMatch(/\.evEvento b\s*\{[^}]*font-weight: var\(--sb-peso-forte\)/);
    expect(css).toMatch(/\.evEvento\[data-tom='falha'\]\s*\{[^}]*color: var\(--sb-erro\)/);
  });
});

describe("CSS da faixa do retorno", () => {
  const css = readFileSync(
    path.resolve(__dirname, "../features/plataforma/comum/CaixaEscrever.module.css"),
    "utf-8",
  );

  it("os valores do mockup: azul-névoa, alinhada à esquerda, 2 linhas no máximo, link de 44 px", () => {
    expect(css).toMatch(
      /\.ceFaixa\[data-tom='retorno'\]\s*\{[^}]*background: var\(--sb-azul-nevoa\)/,
    );
    expect(css).toMatch(/\.ceFaixa\[data-tom='retorno'\]\s*\{[^}]*text-align: left/);
    expect(css).toMatch(/\.ceRetTxt\s*\{[^}]*-webkit-line-clamp: 2/);
    expect(css).toMatch(/\.ceFaixaAcao\s*\{[^}]*min-height: var\(--sb-controle\)/);
  });

  it("com a nota (faixa dupla), o corte de 2 linhas sai: no celular o título quebra e a nota não pode sumir (D1)", () => {
    // A nota é irmã do título dentro de `.ceRetTxt`; sem esta regra, o corte de 2 linhas a esconde a 360 px.
    expect(css).toMatch(
      /\.ceRetTxt:has\(>\s*\.ceRetNota\)\s*\{[^}]*display: block[^}]*-webkit-line-clamp: unset/,
    );
    // vem depois da regra base, para valer na cascata
    expect(css.indexOf(".ceRetTxt:has(> .ceRetNota)")).toBeGreaterThan(
      css.search(/\.ceRetTxt\s*\{/),
    );
  });

  it("o 'Cancelando…' fica cinza e sem sublinhado; no celular o ícone fica à esquerda, não em cima", () => {
    expect(css).toMatch(/\.ceFaixaAcao\[aria-disabled='true'\]\s*\{[^}]*text-decoration: none/);
    // a regra do celular de hoje põe o ícone em bloco; o retorno tem classe própria de ícone (ceRetIc)
    expect(css).toMatch(/\.ceRetIc\s*\{[^}]*align-self: flex-start/);
    expect(css).toMatch(/@media \(max-width: 899px\)[\s\S]*\.ceFaixa\[data-faixa-retorno\]/);
  });
});
