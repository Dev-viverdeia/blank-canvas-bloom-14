import { describe, expect, it } from "vitest";

import { msgLigacoes } from "./mensagens";

describe("mensagens das ligações", () => {
  it("D34: com pendências, a frase não manda Tentar de novo (a saída pode ser manual)", () => {
    const { mensagem } = msgLigacoes.comPendencias();
    expect(mensagem).not.toMatch(/tent(ar|e) de novo/i);
    expect(mensagem).toContain("cartão Ligações");
  });

  it("D34: a chave recusada não manda trocar a chave e tentar de novo sem as pendências (D22, D29)", () => {
    const { mensagem } = msgLigacoes.chaveInvalida();
    expect(mensagem).not.toMatch(/tente de novo/i);
    expect(mensagem).toContain("pendências");
  });
});

describe("D35: códigos próprios", () => {
  it("leitura, ativação interrompida e pendências têm código próprio", () => {
    expect(msgLigacoes.erroAoLer().erro).toBe("erro_ao_ler");
    expect(msgLigacoes.ativacaoInterrompida().erro).toBe("ativacao_interrompida");
    expect(msgLigacoes.comPendencias().erro).toBe("com_pendencias");
    expect(msgLigacoes.ativacaoAbandonada().erro).toBe("com_pendencias");
    // os que continuam
    expect(msgLigacoes.jaAtiva().erro).toBe("ja_ativa");
    expect(msgLigacoes.erroAoGravar().erro).toBe("erro_ao_gravar");
    expect(msgLigacoes.semConexaoMeta().erro).toBe("sem_conexao_meta");
  });
});
