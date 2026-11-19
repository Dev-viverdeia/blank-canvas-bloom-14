// @vitest-environment node
// O contrato entre o servidor das ligações (fase B, 2.2) e as funções do
// envio 3: os argumentos exatamente como mensageria/ligacoes/banco.server.ts os manda (nulos onde o
// servidor não sabe, a transcrição no formato de falasDaLigacao, o p_agente nulo do agente da
// primeira versão) são aceitos e gravam o que a tela lê. Roda quando o banco tem a estrutura nova.
import { describe, it } from "vitest";

import { falasDaLigacao, motivoDoFim } from "@/features/mensageria/ligacoes/registro";

import { montarBase, TEMPO_TESTE, temFuncao, usarBanco, type Banco } from "./montar";

const base = await montarBase();
const t = usarBanco(base);
const temEstrutura = temFuncao(base, "ligacao_iniciar");

const IDS = JSON.stringify([{ tipo: "telefone", valor: "5511900000077" }]);

async function conexaoMeta(t: Banco): Promise<string> {
  const [{ id }] = await t.sql(
    `insert into public.conexoes (gateway, nome, id_externo, ativa, status)
     values ('meta', 'Conexão de teste', '106540352242922', true, 'conectada') returning id`,
  );
  await t.sql(`update public.configuracao set onboarding_concluido_em = now() where id = 1`);
  return id;
}

/** O ligacao_iniciar como o iniciarLigacao do servidor chama: nome vazio, agente nulo ou não. */
async function iniciarComoServidor(t: Banco, cx: string, ext: string, agente: string | null) {
  const [r] = await t.como("service_role", null, (q) =>
    q(`select * from public.ligacao_iniciar($1, $2::jsonb, $3, $4, $5, 'entrada', $6)`, [
      cx,
      IDS,
      "",
      ext,
      agente,
      new Date().toISOString(),
    ]),
  );
  return r;
}

/** O ligacao_encerrar como o encerrarLigacao do servidor chama (todos os campos podem vir nulos). */
async function encerrarComoServidor(
  t: Banco,
  ext: string,
  fim: {
    status: "concluida" | "nao_completada";
    encerradaEm: string | null;
    duracaoS: number | null;
    motivoFim: string | null;
    resumo: string | null;
    transcricao: unknown[];
    custoCreditos: number | null;
  },
) {
  return t.como("service_role", null, (q) =>
    q(
      `select * from public.ligacao_encerrar($1, $2::public.ligacao_status, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        ext,
        fim.status,
        fim.encerradaEm,
        fim.duracaoS,
        fim.motivoFim,
        fim.resumo,
        JSON.stringify(fim.transcricao),
        fim.custoCreditos,
      ],
    ),
  );
}

describe.skipIf(!temEstrutura)(
  "banco: o servidor das ligações e as funções do envio 3",
  { timeout: TEMPO_TESTE },
  () => {
    it("o agente da primeira versão (p_agente nulo) e o nome vazio são aceitos", async () => {
      const cx = await conexaoMeta(t);
      const r = await iniciarComoServidor(t, cx, "conv_srv_1", null);
      t.igual(r.permitida, true);
      const [l] = await t.sql(`select agente_id from public.ligacoes where id = $1`, [
        r.ligacao_id,
      ]);
      t.igual(l.agente_id, null);
    });

    it("o fim com as falas de falasDaLigacao: sem marcas de emoção, com os segundos; o rótulo vai à mensagem", async () => {
      const cx = await conexaoMeta(t);
      await iniciarComoServidor(t, cx, "conv_srv_2", null);
      const transcricao = falasDaLigacao([
        { role: "agent", message: "[excited] Oi! Aqui é a Nina.", time_in_call_secs: 0 },
        { role: "user", message: "Quero saber o preço.", time_in_call_secs: 4.6 },
      ]);
      const fim = await encerrarComoServidor(t, "conv_srv_2", {
        status: "concluida",
        encerradaEm: new Date().toISOString(),
        duracaoS: 125,
        motivoFim: motivoDoFim("Call ended by remote party"),
        resumo: "Quer saber o preço.",
        transcricao,
        custoCreditos: 640,
      });
      t.igual(fim.length, 1);
      const [l] = await t.sql(
        `select l.status::text, l.motivo_fim, l.transcricao, l.custo_creditos, m.texto
           from public.ligacoes l join public.mensagens m on m.id = l.mensagem_id
          where l.id_externo = 'conv_srv_2'`,
      );
      t.igual(
        [l.status, l.motivo_fim, l.transcricao, l.custo_creditos, l.texto],
        [
          "concluida",
          "client_ended",
          [
            { papel: "nina", texto: "Oi! Aqui é a Nina.", segundos: 0 },
            { papel: "lead", texto: "Quero saber o preço.", segundos: 4 },
          ],
          640,
          "Ligação · 2 min 5 s",
        ],
      );
    });

    it("o call_initiation_failure (tudo nulo e falas vazias) depois do fim não apaga nada", async () => {
      const cx = await conexaoMeta(t);
      await iniciarComoServidor(t, cx, "conv_srv_3", null);
      await encerrarComoServidor(t, "conv_srv_3", {
        status: "concluida",
        encerradaEm: null,
        duracaoS: 30,
        motivoFim: null,
        resumo: "Resumo.",
        transcricao: [{ papel: "lead", texto: "oi", segundos: 1 }],
        custoCreditos: null,
      });
      await encerrarComoServidor(t, "conv_srv_3", {
        status: "nao_completada",
        encerradaEm: new Date().toISOString(),
        duracaoS: null,
        motivoFim: "nao_atendida",
        resumo: null,
        transcricao: [],
        custoCreditos: null,
      });
      const [l] = await t.sql(
        `select status::text, resumo, jsonb_array_length(transcricao) as falas, encerrada_em is not null as fim
           from public.ligacoes where id_externo = 'conv_srv_3'`,
      );
      t.igual([l.status, l.resumo, l.falas, l.fim], ["concluida", "Resumo.", 1, true]);
    });

    it("o pós-chamada sem o início: encerrar não devolve linha, iniciar cria, encerrar grava", async () => {
      const cx = await conexaoMeta(t);
      const fim = {
        status: "concluida" as const,
        encerradaEm: new Date().toISOString(),
        duracaoS: 60,
        motivoFim: "agent_ended",
        resumo: null,
        transcricao: [],
        custoCreditos: null,
      };
      t.igual((await encerrarComoServidor(t, "conv_srv_4", fim)).length, 0);
      const r = await iniciarComoServidor(t, cx, "conv_srv_4", null);
      t.igual(r.permitida, true);
      t.igual((await encerrarComoServidor(t, "conv_srv_4", fim)).length, 1);
      const [m] = await t.sql(
        `select m.texto from public.ligacoes l join public.mensagens m on m.id = l.mensagem_id
          where l.id_externo = 'conv_srv_4'`,
      );
      t.igual(m.texto, "Ligação · 1 min");
    });

    it("zerar o id_externo dos agentes (a desativação) deixa as linhas e o histórico", async () => {
      const cx = await conexaoMeta(t);
      const [{ id: ag }] = await t.sql(
        `insert into public.ligacao_agentes (nome, atende, id_externo, versao_config, sincronizado_em)
         values ('Nina', true, 'agent_srv_1', 2, now()) returning id`,
      );
      await iniciarComoServidor(t, cx, "conv_srv_5", ag);
      await t.como("service_role", null, (q) =>
        q(
          `update public.ligacao_agentes set id_externo = null, sincronizado_em = null,
                  erro_sincronia = null where id_externo = any($1::text[])`,
          [["agent_srv_1"]],
        ),
      );
      const [a] = await t.sql(
        `select id_externo, versao_config, atende,
                (select count(*) from public.ligacoes where agente_id = $1)::int as ligacoes
           from public.ligacao_agentes where id = $1`,
        [ag],
      );
      t.igual([a.id_externo, a.versao_config, a.atende, a.ligacoes], [null, 2, true, 1]);
    });
  },
);
