// @vitest-environment node
// A ligação de saída no banco (seção 2): nina_ligacao_saida_tabela e
// nina_ligacao_saida_funcoes.
// - ligacao_iniciar_saida registra a ligação antes de chamar a ElevenLabs, sem tirar a conversa
//   de ninguém e sem contar como fala do lead (a janela de 24 h só abre se ele atender);
// - o limite por contato conta as duas direções, na entrada e na saída;
// - ligacao_saida_confirmar troca o id provisório pelo da ElevenLabs;
// - ligacao_encerrar: a saída atendida marca a ultima_do_lead_em.
// Roda quando o banco tem os envios (na base, ou em NINA_SQL_EXTRA); antes disso fica pulado.
import { describe, it } from "vitest";

import { montarBase, TEMPO_TESTE, temFuncao, usarBanco, type Banco } from "./montar";

const base = await montarBase();
const t = usarBanco(base);
const temEstrutura = temFuncao(base, "ligacao_iniciar_saida");

let seq = 0;
function ids() {
  seq += 1;
  return JSON.stringify([
    { tipo: "bsuid", valor: `BR.Saida${seq}` },
    { tipo: "telefone", valor: `55119000002${String(seq).padStart(2, "0")}` },
  ]);
}

async function preparar(t: Banco, gateway = "meta"): Promise<string> {
  const [{ id }] = await t.sql(
    `insert into public.conexoes (gateway, nome, id_externo, ativa, status, criado_em, parametros)
     values ($1, 'Conexão de teste', '106540352242333', true, 'conectada', now() - interval '1 hour', $2::jsonb)
     returning id`,
    [gateway, JSON.stringify({ ligacoes: { situacao: "ativa" } })],
  );
  await t.sql(
    `update public.configuracao set onboarding_concluido_em = now() - interval '1 hour' where id = 1`,
  );
  return id as string;
}

async function agente(t: Banco): Promise<string> {
  const [{ id }] = await t.sql(
    `with novo as (
       insert into public.ligacao_agentes (nome, atende, duracao_max_s)
       select 'Nina', true, 600 where not exists (select 1 from public.ligacao_agentes where atende)
       returning id)
     select id from novo union all select id from public.ligacao_agentes where atende limit 1`,
  );
  return id as string;
}

/** Uma conversa de um lead que escreveu há `horas` horas. */
async function conversa(t: Banco, cx: string, quem: string, horas = 1): Promise<string> {
  const momento = new Date(Date.now() - horas * 3_600_000).toISOString();
  const [r] = await t.sql(`select * from public.registrar_entrada($1, $2::jsonb, $3, $4::jsonb)`, [
    cx,
    quem,
    "Ana Lima",
    JSON.stringify({ id_externo: `wamid.saida${seq}`, tipo: "texto", texto: "Oi", momento }),
  ]);
  return r.conversa_id as string;
}

type Inicio = {
  ligacao_id: string | null;
  id_externo: string | null;
  permitida: boolean;
  motivo: string | null;
};

async function iniciarSaida(t: Banco, conv: string, ag: string, momento = new Date()) {
  const [r] = await t.como("service_role", null, (q) =>
    q(`select * from public.ligacao_iniciar_saida($1, $2, $3)`, [conv, ag, momento.toISOString()]),
  );
  return r as Inicio;
}

async function iniciarEntrada(t: Banco, cx: string, quem: string, ext: string, ag: string) {
  const [r] = await t.como("service_role", null, (q) =>
    q(`select * from public.ligacao_iniciar($1, $2::jsonb, 'Ana Lima', $3, $4, 'entrada', now())`, [
      cx,
      quem,
      ext,
      ag,
    ]),
  );
  return r as { ligacao_id: string | null; permitida: boolean; motivo: string | null };
}

async function encerrar(t: Banco, ext: string, status: string, duracao: number | null) {
  await t.como("service_role", null, (q) =>
    q(
      `select * from public.ligacao_encerrar($1, $2::public.ligacao_status, now(), $3, 'end_call', null, '[]'::jsonb, null)`,
      [ext, status, duracao],
    ),
  );
}

async function confirmar(t: Banco, lig: string, ext: string) {
  const [r] = await t.como("service_role", null, (q) =>
    q(`select public.ligacao_saida_confirmar($1, $2) as ok`, [lig, ext]),
  );
  return r.ok as boolean;
}

async function lerConversa(t: Banco, id: string) {
  const [c] = await t.sql(
    `select modo, responsavel_id, nao_lidas, ultima_do_lead_em, aguardando_humano_desde,
            responder_apos, ultima_mensagem_preview
       from public.conversas where id = $1`,
    [id],
  );
  return c as Record<string, unknown>;
}

describe.skipIf(!temEstrutura)("banco: a ligação de saída", { timeout: TEMPO_TESTE }, () => {
  it("registra a ligação e a mensagem antes de chamar a ElevenLabs, sem contar como fala do lead", async () => {
    const cx = await preparar(t);
    const ag = await agente(t);
    const conv = await conversa(t, cx, ids(), 30);
    const antes = await lerConversa(t, conv);
    const r = await iniciarSaida(t, conv, ag);
    t.ok(r.permitida, "permitida");
    t.igual(r.id_externo, `saida-${r.ligacao_id}`, "o id provisório");

    const [l] = await t.sql(
      `select l.direcao, l.status, l.id_externo, l.agente_id, l.conexao_id,
              m.direcao as m_direcao, m.origem, m.tipo, m.id_externo as m_ext
         from public.ligacoes l join public.mensagens m on m.id = l.mensagem_id where l.id = $1`,
      [r.ligacao_id],
    );
    t.igual(
      [l.direcao, l.status, l.id_externo, l.agente_id, l.conexao_id],
      ["saida", "em_andamento", r.id_externo, ag, cx],
    );
    t.igual(
      [l.m_direcao, l.origem, l.tipo, l.m_ext],
      ["entrada", "lead", "ligacao", `ligacao:${r.id_externo}`],
    );

    const depois = await lerConversa(t, conv);
    t.igual(depois["modo"], "nina", "continua com a Nina");
    t.igual(depois["nao_lidas"], antes["nao_lidas"], "não conta como não lida");
    t.igual(
      String(depois["ultima_do_lead_em"]),
      String(antes["ultima_do_lead_em"]),
      "a janela de 24 h não abre antes de o lead atender",
    );
    t.ok(depois["responder_apos"], "a Nina de texto fica armada para depois da ligação");
    t.igual(depois["ultima_mensagem_preview"], "Ligação em andamento");
  });

  it("com a conversa com a equipe: continua com a mesma pessoa, sem ir para 'Precisam de você'", async () => {
    const cx = await preparar(t);
    const ag = await agente(t);
    const conv = await conversa(t, cx, ids());
    await t.sql(
      `update public.conversas set modo = 'humano', responsavel_id = null,
              aguardando_humano_desde = null, responder_apos = null where id = $1`,
      [conv],
    );
    const r = await iniciarSaida(t, conv, ag);
    t.ok(r.permitida);
    const c = await lerConversa(t, conv);
    t.igual([c["modo"], c["aguardando_humano_desde"], c["responder_apos"]], ["humano", null, null]);
  });

  it("recusa com ligação em andamento na conversa (de entrada ou de saída)", async () => {
    const cx = await preparar(t);
    const ag = await agente(t);
    const quem = ids();
    const conv = await conversa(t, cx, quem);
    t.ok((await iniciarSaida(t, conv, ag)).permitida);
    t.igual((await iniciarSaida(t, conv, ag)).motivo, "ligacao_em_andamento");
  });

  it("o limite por contato em 24 h conta as duas direções, na entrada e na saída", async () => {
    const cx = await preparar(t);
    const ag = await agente(t);
    await t.sql(`update public.configuracao set ligacoes_por_contato = 2 where id = 1`);
    try {
      const quem = ids();
      const conv = await conversa(t, cx, quem);
      const a = await iniciarEntrada(t, cx, quem, "conv_saida_lim_1", ag);
      t.ok(a.permitida);
      await encerrar(t, "conv_saida_lim_1", "concluida", 60);
      const b = await iniciarSaida(t, conv, ag);
      t.ok(b.permitida);
      await encerrar(t, b.id_externo!, "concluida", 30);
      t.igual(
        (await iniciarSaida(t, conv, ag)).motivo,
        "limite_por_contato",
        "a saída conta a entrada",
      );
      t.igual(
        (await iniciarEntrada(t, cx, quem, "conv_saida_lim_2", ag)).motivo,
        "limite_por_contato",
        "a entrada conta a saída",
      );
      // a que não completou não conta
      await t.sql(`update public.ligacoes set status = 'nao_completada' where id = $1`, [
        b.ligacao_id,
      ]);
      t.ok((await iniciarSaida(t, conv, ag)).permitida);
    } finally {
      await t.sql(`update public.configuracao set ligacoes_por_contato = 10 where id = 1`);
    }
  });

  it("confirmar troca o id provisório na ligação e na mensagem; é idempotente", async () => {
    const cx = await preparar(t);
    const ag = await agente(t);
    const conv = await conversa(t, cx, ids());
    const r = await iniciarSaida(t, conv, ag);
    t.igual(await confirmar(t, r.ligacao_id!, "conv_saida_real_1"), true);
    t.igual(await confirmar(t, r.ligacao_id!, "conv_saida_real_1"), true, "de novo");
    t.igual(
      await confirmar(t, r.ligacao_id!, "conv_saida_outra"),
      false,
      "outro id depois de confirmado",
    );
    const [l] = await t.sql(
      `select l.id_externo, m.id_externo as m_ext
         from public.ligacoes l join public.mensagens m on m.id = l.mensagem_id where l.id = $1`,
      [r.ligacao_id],
    );
    t.igual([l.id_externo, l.m_ext], ["conv_saida_real_1", "ligacao:conv_saida_real_1"]);
    await t.erro(
      t.como("service_role", null, (q) =>
        q(`select public.ligacao_saida_confirmar($1, 'saida-x')`, [r.ligacao_id]),
      ),
      "ligacao_invalida",
    );
    // uma ligação de entrada não é confirmada
    const e = await iniciarEntrada(t, cx, ids(), "conv_saida_entrada_1", ag);
    t.igual(await confirmar(t, e.ligacao_id!, "conv_saida_real_2"), false);
  });

  it("a saída atendida abre a janela de 24 h; a não atendida, não", async () => {
    const cx = await preparar(t);
    const ag = await agente(t);
    const conv = await conversa(t, cx, ids(), 30);
    const antes = await lerConversa(t, conv);

    const a = await iniciarSaida(t, conv, ag);
    await encerrar(t, a.id_externo!, "nao_completada", null);
    t.igual(
      String((await lerConversa(t, conv))["ultima_do_lead_em"]),
      String(antes["ultima_do_lead_em"]),
    );

    const momento = new Date(Date.now() - 60_000);
    const b = await iniciarSaida(t, conv, ag, momento);
    await confirmar(t, b.ligacao_id!, "conv_saida_janela_1");
    await encerrar(t, "conv_saida_janela_1", "concluida", 45);
    const [c] = await t.sql(`select ultima_do_lead_em from public.conversas where id = $1`, [conv]);
    t.igual(new Date(c.ultima_do_lead_em as string).getTime(), momento.getTime());
  });

  it("sem conexão da Meta ativa, ou sem a conversa: recusa sem gravar", async () => {
    const outra = await preparar(t, "zapi");
    const ag = await agente(t);
    const conv = await conversa(t, outra, ids());
    t.igual((await iniciarSaida(t, conv, ag)).motivo, "sem_conexao");
    await t.sql(`update public.conexoes set ativa = false where id = $1`, [outra]);
    await preparar(t);
    t.igual(
      (await iniciarSaida(t, "00000000-0000-4000-8000-000000000000", ag)).motivo,
      "conversa_nao_encontrada",
    );
  });

  it("com as ligações desativadas (ou ainda ativando): recusa sem gravar (Sol, PR #24)", async () => {
    const cx = await preparar(t);
    const ag = await agente(t);
    const conv = await conversa(t, cx, ids());
    for (const parametros of [
      {},
      { ligacoes: { situacao: "ativando" } },
      { ligacoes: { situacao: "com_pendencias" } },
    ]) {
      await t.sql(`update public.conexoes set parametros = $2::jsonb where id = $1`, [
        cx,
        JSON.stringify(parametros),
      ]);
      const r = await iniciarSaida(t, conv, ag);
      t.igual([r.permitida, r.motivo], [false, "sem_ligacoes"], JSON.stringify(parametros));
    }
    const [{ n }] = await t.sql(
      `select count(*)::int as n from public.ligacoes where conversa_id = $1`,
      [conv],
    );
    t.igual(n, 0);
  });

  it("só o servidor chama as funções; o membro só lê ligacao_permissoes", async () => {
    await t.erro(
      t.como("authenticated", null, (q) =>
        q(`select * from public.ligacao_iniciar_saida(gen_random_uuid(), null, now())`),
      ),
      "permission denied",
    );
    await t.erro(
      t.como("anon", null, (q) => q(`select * from public.ligacao_permissoes`)),
      "permission denied",
    );
  });
});
