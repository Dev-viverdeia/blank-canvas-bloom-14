// @vitest-environment node
// A robustez das ligações recebidas ("Porte da vitrine"; trazido da Nina
// vitrine em 17/11/2026), os quatro envios juntos:
// - nina_ligacao_aviso_falha: a ligação de entrada que não completou vira mensagem no chat, uma
//   vez por ligação e no máximo uma a cada 10 min por conversa;
// - nina_ligacoes_limite_por_contato: o limite em 24 h conta só as atendidas e as em curso;
// - nina_ligacoes_presas_relogio: a manutenção acorda o worker quando há ligação presa;
// - nina_ligacoes_limite_simultaneas: o teto de simultâneas vai a 200.
// Roda quando o banco tem os envios (na base, ou em NINA_SQL_EXTRA); antes disso fica pulado.
import { describe, it } from "vitest";

import { montarBase, TEMPO_TESTE, temFuncao, usarBanco, type Banco } from "./montar";

const base = await montarBase();
const t = usarBanco(base);
const temEstrutura = temFuncao(base, "ligacao_avisar_falha");

const TEXTO = "Oi, Ana! Aqui é a Nina. Sua ligação não completou. Pode me ligar de novo?";

let seq = 0;
function ids() {
  seq += 1;
  return JSON.stringify([
    { tipo: "bsuid", valor: `BR.AvisoFalha${seq}` },
    { tipo: "telefone", valor: `55119000001${String(seq).padStart(2, "0")}` },
  ]);
}

async function preparar(t: Banco, ativa = true): Promise<string> {
  const [{ id }] = await t.sql(
    `insert into public.conexoes (gateway, nome, id_externo, ativa, status, criado_em)
     values ('meta', 'Conexão de teste', '106540352242111', $1, 'conectada', now() - interval '1 hour')
     returning id`,
    [ativa],
  );
  await t.sql(
    `update public.configuracao set onboarding_concluido_em = now() - interval '1 hour' where id = 1`,
  );
  return id as string;
}

async function ligar(t: Banco, cx: string, ext: string, quem: string, momento = new Date()) {
  // um agente só atende: o primeiro do teste serve a todas as ligações
  const [{ id: ag }] = await t.sql(
    `with novo as (
       insert into public.ligacao_agentes (nome, atende, duracao_max_s)
       select 'Nina', true, 600 where not exists (select 1 from public.ligacao_agentes where atende)
       returning id)
     select id from novo union all select id from public.ligacao_agentes where atende limit 1`,
  );
  const [r] = await t.como("service_role", null, (q) =>
    q(`select * from public.ligacao_iniciar($1, $2::jsonb, 'Ana Lima', $3, $4, 'entrada', $5)`, [
      cx,
      quem,
      ext,
      ag,
      momento.toISOString(),
    ]),
  );
  return r as { ligacao_id: string; conversa_id: string };
}

async function falhar(t: Banco, ext: string) {
  await t.como("service_role", null, (q) =>
    q(
      `select * from public.ligacao_encerrar($1, 'nao_completada', now(), null, 'nao_atendida', null, '[]'::jsonb, null)`,
      [ext],
    ),
  );
}

function avisar(t: Banco, ligacao: string, texto = TEXTO) {
  return t
    .como("service_role", null, (q) =>
      q(`select public.ligacao_avisar_falha($1, $2) as id`, [ligacao, texto]),
    )
    .then((r) => (r[0].id as string | null) ?? null);
}

describe.skipIf(!temEstrutura)(
  "banco: o aviso da ligação que não completou",
  { timeout: TEMPO_TESTE },
  () => {
    it("põe o aviso na fila como mensagem da Nina, com rodada concluída, e marca a ligação", async () => {
      const cx = await preparar(t);
      const quem = ids();
      const lig = await ligar(t, cx, "conv_aviso_1", quem);
      await falhar(t, "conv_aviso_1");
      const id = await avisar(t, lig.ligacao_id);
      t.ok(id, "devolve a mensagem");
      const [m] = await t.sql(
        `select m.direcao, m.origem, m.tipo, m.texto, m.status, r.status as rodada
         from public.mensagens m join public.rodadas r on r.id = m.rodada_id where m.id = $1`,
        [id],
      );
      t.igual(
        [m.direcao, m.origem, m.tipo, m.texto, m.status, m.rodada],
        ["saida", "nina", "texto", TEXTO, "na_fila", "concluida"],
      );
      const [l] = await t.sql(`select aviso_falha_em from public.ligacoes where id = $1`, [
        lig.ligacao_id,
      ]);
      t.ok(l.aviso_falha_em, "a ligação fica avisada");
      // a mesma ligação de novo (outro aviso do webhook): nada
      t.igual(await avisar(t, lig.ligacao_id), null);
    });

    it("não avisa a ligação concluída, nem com a conversa com a equipe", async () => {
      const cx = await preparar(t);
      const lig = await ligar(t, cx, "conv_aviso_2", ids());
      t.igual(await avisar(t, lig.ligacao_id), null, "em andamento");
      await t.como("service_role", null, (q) =>
        q(
          `select * from public.ligacao_encerrar('conv_aviso_2', 'concluida', now(), 60, 'end_call', 'ok', '[]'::jsonb, 5)`,
        ),
      );
      t.igual(await avisar(t, lig.ligacao_id), null, "concluída");

      const outra = await ligar(t, cx, "conv_aviso_3", ids());
      await falhar(t, "conv_aviso_3");
      await t.sql(`update public.conversas set modo = 'humano' where id = $1`, [outra.conversa_id]);
      t.igual(await avisar(t, outra.ligacao_id), null, "com a equipe");
    });

    it("quem tenta várias vezes recebe um aviso só, e a ligação mais nova cala a antiga", async () => {
      const cx = await preparar(t);
      const quem = ids();
      const a = await ligar(t, cx, "conv_aviso_4", quem, new Date(Date.now() - 60_000));
      const b = await ligar(t, cx, "conv_aviso_5", quem);
      await falhar(t, "conv_aviso_4");
      await falhar(t, "conv_aviso_5");
      t.igual(await avisar(t, a.ligacao_id), null, "a antiga: já há uma mais nova");
      t.ok(await avisar(t, b.ligacao_id), "a mais nova avisa");
      const c = await ligar(t, cx, "conv_aviso_6", quem);
      await falhar(t, "conv_aviso_6");
      t.igual(await avisar(t, c.ligacao_id), null, "outra falha em menos de 10 min");
    });

    it("não avisa a falha de mais de 2 h, nem se o lead já escreveu depois", async () => {
      const cx = await preparar(t);
      const velha = await ligar(t, cx, "conv_aviso_7", ids(), new Date(Date.now() - 3 * 3600_000));
      await falhar(t, "conv_aviso_7");
      t.igual(await avisar(t, velha.ligacao_id), null, "velha");

      const quem = ids();
      const lig = await ligar(t, cx, "conv_aviso_8", quem, new Date(Date.now() - 30_000));
      await t.como("service_role", null, (q) =>
        q(`select * from public.registrar_entrada($1, $2::jsonb, 'Ana Lima', $3::jsonb)`, [
          cx,
          quem,
          JSON.stringify({
            momento: new Date().toISOString(),
            id_externo: "wamid.aviso8",
            tipo: "texto",
            texto: "oi, caiu aqui",
          }),
        ]),
      );
      await falhar(t, "conv_aviso_8");
      t.igual(await avisar(t, lig.ligacao_id), null, "o lead escreveu");
    });

    it("sem conexão ativa, nada fica: nem a mensagem, nem a rodada, nem a marca", async () => {
      const cx = await preparar(t);
      const lig = await ligar(t, cx, "conv_aviso_9", ids());
      await falhar(t, "conv_aviso_9");
      await t.sql(`update public.conexoes set ativa = false`);
      const antes = await t.sql(
        `select count(*)::int as n from public.rodadas where conversa_id = $1`,
        [lig.conversa_id],
      );
      t.igual(await avisar(t, lig.ligacao_id), null);
      const depois = await t.sql(
        `select count(*)::int as n from public.rodadas where conversa_id = $1`,
        [lig.conversa_id],
      );
      t.igual(depois[0].n, antes[0].n);
      const [l] = await t.sql(`select aviso_falha_em from public.ligacoes where id = $1`, [
        lig.ligacao_id,
      ]);
      t.igual(l.aviso_falha_em, null);
    });

    it("recusa texto vazio ou longo demais", async () => {
      const cx = await preparar(t);
      const lig = await ligar(t, cx, "conv_aviso_10", ids());
      await falhar(t, "conv_aviso_10");
      await t.erro(avisar(t, lig.ligacao_id, "   "), "texto_invalido");
      await t.erro(avisar(t, lig.ligacao_id, "x".repeat(501)), "texto_invalido");
    });
    it("não avisa ligação de saída (a Nina ligou: \"vi que você me ligou\" seria falso)", async () => {
      const cx = await preparar(t);
      const lig = await ligar(t, cx, "conv_aviso_11", ids());
      await falhar(t, "conv_aviso_11");
      await t.sql(`update public.ligacoes set direcao = 'saida' where id = $1`, [lig.ligacao_id]);
      t.igual(await avisar(t, lig.ligacao_id), null);
    });
  },
);

describe.skipIf(!temEstrutura)(
  "banco: o limite por contato, as presas e o teto de simultâneas",
  { timeout: TEMPO_TESTE },
  () => {
    it("o limite por contato não conta as que não completaram", async () => {
      const cx = await preparar(t);
      await t.sql(`update public.configuracao set ligacoes_por_contato = 2 where id = 1`);
      const quem = ids();
      const agora = Date.now();
      await ligar(t, cx, "conv_lim_1", quem, new Date(agora - 90_000));
      await falhar(t, "conv_lim_1");
      await ligar(t, cx, "conv_lim_2", quem, new Date(agora - 60_000));
      await falhar(t, "conv_lim_2");
      // duas falhas não contam: a 3ª e a 4ª passam (uma em curso, outra concluída)
      await ligar(t, cx, "conv_lim_3", quem, new Date(agora - 30_000));
      await t.como("service_role", null, (q) =>
        q(
          `select * from public.ligacao_encerrar('conv_lim_3', 'concluida', now(), 60, 'end_call', 'ok', '[]'::jsonb, 5)`,
        ),
      );
      const quarta = await ligar(t, cx, "conv_lim_4", quem, new Date(agora - 10_000));
      t.ok(quarta.ligacao_id, "a 4ª passa: só uma atendida antes dela");
      // a 5ª encontra uma concluída e uma em curso: o limite (2) recusa
      const [r] = await t.como("service_role", null, (q) =>
        q(
          `select * from public.ligacao_iniciar($1, $2::jsonb, 'Ana Lima', 'conv_lim_5', null, 'entrada', now())`,
          [cx, quem],
        ),
      );
      t.igual([r.permitida, r.motivo], [false, "limite_por_contato"]);
      // a mesma ligação de novo (o início repetido) devolve a mesma, mesmo acima do limite
      const [de_novo] = await t.como("service_role", null, (q) =>
        q(
          `select * from public.ligacao_iniciar($1, $2::jsonb, 'Ana Lima', 'conv_lim_4', null, 'entrada', now())`,
          [cx, quem],
        ),
      );
      t.igual([de_novo.permitida, de_novo.ligacao_id], [true, quarta.ligacao_id]);
    });

    it("a manutenção acorda o worker só com ligação presa (em andamento há mais de 2 min)", async () => {
      const cx = await preparar(t);
      await t.sql(`update public.motor set url = 'https://nina-a.exemplo.test', tocado_em = null`);
      await t.sql(`update public.configuracao set worker_visto_em = null where id = 1`);
      const pedidos = async () =>
        (await t.sql(`select count(*)::int as n from net.http_request_queue`))[0].n as number;
      const antes = await pedidos();
      await ligar(t, cx, "conv_presa_1", ids(), new Date(Date.now() - 30_000));
      await t.sql(`select public.manutencao_nina()`);
      t.igual(await pedidos(), antes, "ligação nova: não acorda");
      await ligar(t, cx, "conv_presa_2", ids(), new Date(Date.now() - 5 * 60_000));
      await t.sql(`select public.manutencao_nina()`);
      t.igual(await pedidos(), antes + 1, "ligação presa: um toque");
      // sem endereço, o toque não sai e a manutenção não falha
      await t.sql(`update public.motor set url = null, tocado_em = null`);
      await t.sql(`select public.manutencao_nina()`);
      t.igual(await pedidos(), antes + 1);
    });

    it("o teto de simultâneas é 200", async () => {
      await t.sql(`update public.configuracao set ligacoes_simultaneas = 200 where id = 1`);
      await t.erro(
        t.sql(`update public.configuracao set ligacoes_simultaneas = 201 where id = 1`),
        "configuracao_ligacoes_simultaneas",
      );
    });
  },
);
