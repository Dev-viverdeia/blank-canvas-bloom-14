// @vitest-environment node
// Uma Nina por vez (envio nina_ligacao_uma_nina_por_vez, seção 7): a
// conversa com ligação em andamento dentro do teto fica de fora das rodadas, e a espera acorda o
// worker 2 min depois do começo da ligação, sem contar como atraso. Roda quando o banco tem o envio
// (na base, ou em NINA_SQL_EXTRA); antes disso fica pulado.
import { describe, it } from "vitest";

import { montarBase, TEMPO_TESTE, temFuncao, usarBanco, type Banco } from "./montar";

const base = await montarBase();
const t = usarBanco(base);
const temEstrutura = temFuncao(base, "ligacao_teto");

let seq = 0;
function ids() {
  seq += 1;
  return JSON.stringify([
    { tipo: "bsuid", valor: `BR.UmaNina${seq}` },
    { tipo: "telefone", valor: `55119000002${String(seq).padStart(2, "0")}` },
  ]);
}

async function preparar(t: Banco): Promise<string> {
  const [{ id }] = await t.sql(
    `insert into public.conexoes (gateway, nome, id_externo, ativa, status, criado_em)
     values ('meta', 'Conexão de teste', '106540352242333', true, 'conectada', now() - interval '1 hour')
     returning id`,
  );
  await t.sql(
    `update public.configuracao set onboarding_concluido_em = now() - interval '1 hour' where id = 1`,
  );
  return id as string;
}

async function ligar(t: Banco, cx: string, ext: string, quem: string, momento: Date) {
  const [r] = await t.como("service_role", null, (q) =>
    q(`select * from public.ligacao_iniciar($1, $2::jsonb, 'Ana Lima', $3, null, 'entrada', $4)`, [
      cx,
      quem,
      ext,
      momento.toISOString(),
    ]),
  );
  // a conversa armada e pronta (sem a espera do lote)
  await t.sql(`update public.conversas set responder_apos = now() - interval '1 second' where id = $1`, [
    r.conversa_id,
  ]);
  return r as { ligacao_id: string; conversa_id: string };
}

async function pegar(t: Banco): Promise<string[]> {
  const rs = await t.como("service_role", null, (q) =>
    q(`select conversa_id from public.pegar_rodadas(10)`),
  );
  return rs.map((r) => r.conversa_id as string);
}

async function pendencias(t: Banco) {
  const [p] = await t.como("service_role", null, (q) =>
    q(`select proximo_em, vencido_desde, atrasado_desde from public.motor_pendencias()`),
  );
  return p as { proximo_em: Date | null; vencido_desde: Date | null; atrasado_desde: Date | null };
}

describe.skipIf(!temEstrutura)("banco: uma Nina por vez", { timeout: TEMPO_TESTE }, () => {
  it("a conversa com ligação em andamento fica de fora; quando ela termina, a rodada sai", async () => {
    const cx = await preparar(t);
    const lig = await ligar(t, cx, "conv_uma_1", ids(), new Date(Date.now() - 60_000));
    t.igual(await pegar(t), [], "durante a ligação");
    await t.como("service_role", null, (q) =>
      q(
        `select * from public.ligacao_encerrar('conv_uma_1', 'concluida', now(), 50, 'end_call', 'ok', '[]'::jsonb, 5)`,
      ),
    );
    t.igual(await pegar(t), [lig.conversa_id], "depois da ligação");
  });

  it("passado o teto (duração máxima + 2 min) sem pós-chamada, a ligação não segura mais", async () => {
    const cx = await preparar(t);
    const lig = await ligar(t, cx, "conv_uma_2", ids(), new Date(Date.now() - 33 * 60_000));
    t.igual(await pegar(t), [lig.conversa_id]);
  });

  it("a espera acorda o worker 2 min depois do começo, sem contar como atraso", async () => {
    const cx = await preparar(t);
    await ligar(t, cx, "conv_uma_3", ids(), new Date(Date.now() - 30_000));
    const antes = await pendencias(t);
    t.ok(antes.proximo_em instanceof Date, "a conferência das presas está marcada");
    const falta = (antes.proximo_em as Date).getTime() - Date.now();
    t.ok(falta > 60_000 && falta <= 90_000, `daqui a ~90 s (${falta} ms)`);
    t.igual(antes.atrasado_desde, null);

    await ligar(t, cx, "conv_uma_4", ids(), new Date(Date.now() - 5 * 60_000));
    const depois = await pendencias(t);
    // a espera nunca vence (base 0032): o próximo marco de 2 min desde o começo, sempre no futuro
    t.igual(depois.vencido_desde, null, "a espera não fica vencida");
    t.igual(depois.atrasado_desde, null, "não é atraso do motor");
    const proximo = (depois.proximo_em as Date).getTime() - Date.now();
    t.ok(proximo > 0 && proximo <= 120_000, `o próximo marco em até 2 min (${proximo} ms)`);
  });

  it("a espera de uma ligação longa não esconde o trabalho novo de outra conversa", async () => {
    const cx = await preparar(t);
    // ligação de 20 min em andamento, com a conversa armada desde o começo dela (o registro)
    const longa = await ligar(t, cx, "conv_uma_5", ids(), new Date(Date.now() - 20 * 60_000));
    await t.sql(
      `update public.conversas set responder_apos = now() - interval '20 minutes' where id = $1`,
      [longa.conversa_id],
    );
    // outro lead escreveu agora: a conversa dele está pronta
    const [{ conversa_id: outra }] = await t.como("service_role", null, (q) =>
      q(`select * from public.registrar_entrada($1, $2::jsonb, 'Bia', $3::jsonb)`, [
        cx,
        ids(),
        JSON.stringify({
          momento: new Date().toISOString(),
          id_externo: "wamid.uma5",
          tipo: "texto",
          texto: "oi",
        }),
      ]),
    );
    await t.sql(`update public.conversas set responder_apos = now() - interval '1 second' where id = $1`, [
      outra,
    ]);
    const p = await pendencias(t);
    t.ok(p.vencido_desde instanceof Date, "o trabalho novo aparece vencido");
    const idade = Date.now() - (p.vencido_desde as Date).getTime();
    t.ok(idade < 60_000, `vencido há segundos, não há 18 min (${idade} ms)`);
  });
});

describe.skipIf(!temFuncao(base, "ligacao_rearmar_depois"))(
  "banco: a rodada depois da ligação que fechou tarde",
  { timeout: TEMPO_TESTE },
  () => {
    async function rearmar(t: Banco, ligacao: string) {
      const [r] = await t.como("service_role", null, (q) =>
        q(`select public.ligacao_rearmar_depois($1) as armou`, [ligacao]),
      );
      return r.armou as boolean;
    }
    async function encerrar(t: Banco, ext: string) {
      await t.como("service_role", null, (q) =>
        q(
          `select * from public.ligacao_encerrar($1, 'concluida', now(), 120, 'end_call', 'ok', '[]'::jsonb, 5)`,
          [ext],
        ),
      );
    }

    it("o registro consumido por uma rodada vazia (a ligação passou do teto) volta e a conversa arma", async () => {
      const cx = await preparar(t);
      // passou do teto (30 + 2 min, sem agente): a rodada pega o registro e conclui vazia (D7)
      const lig = await ligar(t, cx, "conv_rearma_1", ids(), new Date(Date.now() - 40 * 60_000));
      const [rod] = await pegar(t).then((cs) => cs.map((c) => c));
      t.igual(rod, lig.conversa_id);
      await t.sql(
        `update public.rodadas set status = 'concluida', terminada_em = now() where conversa_id = $1`,
        [lig.conversa_id],
      );
      // a ligação fecha tarde, como concluída
      await encerrar(t, "conv_rearma_1");
      t.igual(await rearmar(t, lig.ligacao_id), true);
      const [m] = await t.sql(
        `select m.rodada_id, c.responder_apos <= now() as armada
           from public.ligacoes l join public.mensagens m on m.id = l.mensagem_id
           join public.conversas c on c.id = l.conversa_id where l.id = $1`,
        [lig.ligacao_id],
      );
      t.igual([m.rodada_id, m.armada], [null, true]);
      // a rodada seguinte pega o registro de novo
      t.igual(await pegar(t), [lig.conversa_id]);
    });

    it("não mexe na rodada que respondeu, na ligação passada à equipe nem na não concluída", async () => {
      const cx = await preparar(t);
      const lig = await ligar(t, cx, "conv_rearma_2", ids(), new Date(Date.now() - 40 * 60_000));
      t.igual(await rearmar(t, lig.ligacao_id), false, "em andamento");
      await pegar(t);
      await t.sql(
        `update public.rodadas set status = 'concluida', passos = 1, terminada_em = now() where conversa_id = $1`,
        [lig.conversa_id],
      );
      await encerrar(t, "conv_rearma_2");
      t.igual(await rearmar(t, lig.ligacao_id), false, "a rodada teve passos (respondeu)");

      const outra = await ligar(t, cx, "conv_rearma_3", ids(), new Date(Date.now() - 60_000));
      await encerrar(t, "conv_rearma_3");
      await t.sql(`update public.ligacoes set passou_equipe = true where id = $1`, [outra.ligacao_id]);
      t.igual(await rearmar(t, outra.ligacao_id), false, "passou para a equipe");
    });

    it("o registro ainda solto: só garante a conversa armada", async () => {
      const cx = await preparar(t);
      const lig = await ligar(t, cx, "conv_rearma_4", ids(), new Date(Date.now() - 60_000));
      await t.sql(`update public.conversas set responder_apos = null where id = $1`, [
        lig.conversa_id,
      ]);
      await encerrar(t, "conv_rearma_4");
      t.igual(await rearmar(t, lig.ligacao_id), true);
      t.igual(await pegar(t), [lig.conversa_id]);
    });
  },
);
