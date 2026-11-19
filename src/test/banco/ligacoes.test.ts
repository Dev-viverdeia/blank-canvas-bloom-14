// @vitest-environment node
// O registro da ligação no banco de verdade (D6 e D7): a registrar_entrada
// real grava o "[ligação] em andamento" (tipo outro, id_externo "ligacao:<id>") como uma entrada
// qualquer, com contato, conversa e mensagem novos, e arma a rodada (responder_apos). O mesmo
// início de novo é idempotente, e o pós-chamada, que só faz UPDATE de texto e transcrição, não
// arma de novo.
import { describe, it } from "vitest";

import { montarBase, TEMPO_TESTE, usarBanco, type Banco } from "./montar";

const BSUID = "BR.LigacaoTeste123";
const TEL = "5511900000077";
const ID_EXTERNO = "ligacao:conv_x";

async function conexaoMeta(t: Banco): Promise<string> {
  const [{ id }] = await t.sql(
    `insert into public.conexoes (gateway, nome, id_externo, ativa, status)
     values ('meta', 'Conexão de teste', '106540352242922', true, 'conectada') returning id`,
  );
  await t.sql(`update public.configuracao set onboarding_concluido_em = now() where id = 1`);
  return id;
}

/** A chamada que as rotas fazem (registrarEntrada, sem nome do WhatsApp). */
async function registrar(t: Banco, cx: string, momento: string) {
  const [r] = await t.como("service_role", null, (q) =>
    q(`select * from public.registrar_entrada($1, $2::jsonb, null, $3::jsonb)`, [
      cx,
      JSON.stringify([
        { tipo: "bsuid", valor: BSUID },
        { tipo: "telefone", valor: TEL },
      ]),
      JSON.stringify({
        id_externo: ID_EXTERNO,
        tipo: "outro",
        texto: "[ligação] em andamento",
        momento,
      }),
    ]),
  );
  return r;
}

const base = await montarBase();
const t = usarBanco(base);

describe("banco: o registro da ligação (D7)", { timeout: TEMPO_TESTE }, () => {
  it("cria contato, conversa e mensagem, arma a rodada; repetir não duplica; o UPDATE do pós-chamada não arma de novo", async () => {
    const cx = await conexaoMeta(t);
    const momento = new Date().toISOString();

    const r = await registrar(t, cx, momento);
    t.ok(r.mensagem_id && r.conversa_id, "devolve a mensagem e a conversa");
    t.igual(r.nova, true, "a primeira gravação é nova");

    // o contato nasce com os dois identificadores
    const ids = await t.sql(
      `select tipo::text, valor from public.contato_identificadores
        where contato_id = (select contato_id from public.conversas where id = $1)
        order by tipo::text`,
      [r.conversa_id],
    );
    t.igual(
      ids.map((i) => `${i.tipo}:${i.valor}`),
      [`bsuid:${BSUID}`, `telefone:${TEL}`],
      "contato com o BSUID e o telefone",
    );

    const [m] = await t.sql(
      `select direcao::text, origem::text, tipo::text, texto, status::text, id_externo, conexao_id
         from public.mensagens where id = $1`,
      [r.mensagem_id],
    );
    t.igual(
      m,
      {
        direcao: "entrada",
        origem: "lead",
        tipo: "outro",
        texto: "[ligação] em andamento",
        status: "recebida",
        id_externo: ID_EXTERNO,
        conexao_id: cx,
      },
      "a mensagem do registro",
    );

    const [c1] = await t.sql(
      `select responder_apos, ultima_mensagem_id, ultima_mensagem_preview
         from public.conversas where id = $1`,
      [r.conversa_id],
    );
    t.ok(c1.responder_apos instanceof Date, "o registro arma a rodada (responder_apos)");
    t.igual(c1.ultima_mensagem_id, r.mensagem_id, "o registro é a última mensagem");
    t.igual(c1.ultima_mensagem_preview, "[ligação] em andamento", "a prévia é o registro");

    // o mesmo início de novo (reenvio da ElevenLabs): a mesma mensagem, nada novo
    const r2 = await registrar(t, cx, momento);
    t.igual(
      [r2.mensagem_id, r2.conversa_id, r2.nova],
      [r.mensagem_id, r.conversa_id, false],
      "repetir devolve o mesmo registro, não novo",
    );
    const [{ n }] = await t.sql(
      `select count(*)::int as n from public.mensagens where id_externo = $1`,
      [ID_EXTERNO],
    );
    t.igual(n, 1, "uma mensagem só");
    const [{ contatos, conversas }] = await t.sql(
      `select (select count(*)::int from public.contatos) as contatos,
              (select count(*)::int from public.conversas) as conversas`,
    );
    t.igual([contatos, conversas], [1, 1], "um contato e uma conversa");
    const [c2] = await t.sql(`select responder_apos from public.conversas where id = $1`, [
      r.conversa_id,
    ]);
    t.igual(
      c2.responder_apos?.getTime(),
      c1.responder_apos.getTime(),
      "repetir não mexe no responder_apos",
    );

    // a rodada já passou (desarmada); o pós-chamada só faz UPDATE de texto e transcrição
    await t.sql(`update public.conversas set responder_apos = null where id = $1`, [r.conversa_id]);
    await t.como("service_role", null, (q) =>
      q(`update public.mensagens set texto = $2, transcricao = $3 where id = $1 returning id`, [
        r.mensagem_id,
        "[ligação] concluída (192 s)\nQuer o preço.",
        "Lead: oi\nNina: Oi!",
      ]),
    );
    const [c3] = await t.sql(`select responder_apos from public.conversas where id = $1`, [
      r.conversa_id,
    ]);
    t.igual(c3.responder_apos, null, "o UPDATE do pós-chamada não arma a rodada de novo");
    const [m3] = await t.sql(`select texto, transcricao from public.mensagens where id = $1`, [
      r.mensagem_id,
    ]);
    t.igual(
      m3,
      { texto: "[ligação] concluída (192 s)\nQuer o preço.", transcricao: "Lead: oi\nNina: Oi!" },
      "o texto e a transcrição gravados",
    );
  });
});
