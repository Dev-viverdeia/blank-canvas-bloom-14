// @vitest-environment node
// As tabelas e funções da tela de Ligações (envios 1 a 4): o agente de
// voz, o histórico de ligações e as funções que gravam a ligação numa transação só. Roda quando o
// banco tem a estrutura nova (as migrations na base, ou NINA_SQL_EXTRA com os quatro envios); antes
// disso fica pulado.
import { describe, it } from "vitest";

import { montarBase, TEMPO_TESTE, temFuncao, usarBanco, type Banco } from "./montar";

const base = await montarBase();
const t = usarBanco(base);
const temEstrutura = temFuncao(base, "ligacao_iniciar");

const BSUID = "BR.LigacaoTela123";
const TEL = "5511900000088";
const IDS = JSON.stringify([
  { tipo: "bsuid", valor: BSUID },
  { tipo: "telefone", valor: TEL },
]);

async function conexaoMeta(t: Banco): Promise<string> {
  const [{ id }] = await t.sql(
    `insert into public.conexoes (gateway, nome, id_externo, ativa, status)
     values ('meta', 'Conexão de teste', '106540352242922', true, 'conectada') returning id`,
  );
  await t.sql(`update public.configuracao set onboarding_concluido_em = now() where id = 1`);
  return id;
}

async function agente(t: Banco, nome = "Nina", atende = true): Promise<string> {
  const [{ id }] = await t.sql(
    `insert into public.ligacao_agentes (nome, atende) values ($1, $2) returning id`,
    [nome, atende],
  );
  return id;
}

async function iniciar(
  t: Banco,
  cx: string,
  ext: string,
  momento: string,
  ag: string | null = null,
) {
  const [r] = await t.como("service_role", null, (q) =>
    q(`select * from public.ligacao_iniciar($1, $2::jsonb, 'Lead Teste', $3, $4, 'entrada', $5)`, [
      cx,
      IDS,
      ext,
      ag,
      momento,
    ]),
  );
  return r;
}

async function encerrar(
  t: Banco,
  ext: string,
  o: {
    status?: string;
    duracao?: number | null;
    resumo?: string | null;
    transcricao?: unknown[];
  } = {},
) {
  return t.como("service_role", null, (q) =>
    q(
      `select * from public.ligacao_encerrar($1, $2::public.ligacao_status, now(), $3, 'end_call', $4, $5::jsonb, 12)`,
      [
        ext,
        o.status ?? "concluida",
        o.duracao === undefined ? 174 : o.duracao,
        o.resumo === undefined ? "Quer saber o preço." : o.resumo,
        JSON.stringify(o.transcricao ?? [{ papel: "lead", texto: "oi", segundos: 1 }]),
      ],
    ),
  );
}

describe.skipIf(!temEstrutura)("banco: a tela de Ligações", { timeout: TEMPO_TESTE }, () => {
  it("o tipo de mensagem 'ligacao' passa pela tipo_de_mensagem", async () => {
    const [r] = await t.sql(`select public.tipo_de_mensagem('ligacao')::text as tipo`);
    t.igual(r.tipo, "ligacao");
  });

  it("ligacao_iniciar: cria contato, conversa, a mensagem 'ligacao' e a linha do histórico; repetir não duplica", async () => {
    const cx = await conexaoMeta(t);
    const ag = await agente(t);
    const momento = new Date().toISOString();

    const r = await iniciar(t, cx, "conv_a", momento, ag);
    t.igual(r.permitida, true);
    t.ok(r.ligacao_id && r.conversa_id, "devolve a ligação e a conversa");

    const [l] = await t.sql(
      `select l.direcao::text, l.status::text, l.agente_id, l.conexao_id, m.tipo::text as tipo,
              m.texto, m.id_externo, m.direcao::text as m_direcao, c.ultima_mensagem_preview as previa,
              c.responder_apos is not null as armou
         from public.ligacoes l join public.mensagens m on m.id = l.mensagem_id
         join public.conversas c on c.id = l.conversa_id
        where l.id = $1`,
      [r.ligacao_id],
    );
    t.igual(
      [
        l.direcao,
        l.status,
        l.agente_id,
        l.conexao_id,
        l.tipo,
        l.texto,
        l.id_externo,
        l.m_direcao,
        l.previa,
      ],
      [
        "entrada",
        "em_andamento",
        ag,
        cx,
        "ligacao",
        "Ligação em andamento",
        "ligacao:conv_a",
        "entrada",
        "Ligação em andamento",
      ],
    );
    t.igual(
      l.armou,
      true,
      "a entrada arma a rodada como qualquer outra (a rodada só de ligação conclui vazia no servidor)",
    );

    const de_novo = await iniciar(t, cx, "conv_a", momento, ag);
    t.igual(de_novo.ligacao_id, r.ligacao_id, "o mesmo início devolve a mesma ligação");
    const [{ n }] = await t.sql(
      `select (select count(*) from public.ligacoes)::int + (select count(*) from public.mensagens)::int as n`,
    );
    t.igual(n, 2, "uma ligação e uma mensagem");
  });

  it("limite por contato em 24 h: acima dele recusa sem criar nada; ligação antiga não conta", async () => {
    const cx = await conexaoMeta(t);
    await t.sql(`update public.configuracao set ligacoes_por_contato = 2 where id = 1`);
    const agora = Date.now();
    const antiga = new Date(agora - 25 * 3600 * 1000).toISOString();
    t.igual((await iniciar(t, cx, "conv_1", antiga)).permitida, true);
    t.igual(
      (await iniciar(t, cx, "conv_2", new Date(agora - 60_000).toISOString())).permitida,
      true,
    );
    t.igual(
      (await iniciar(t, cx, "conv_3", new Date(agora - 30_000).toISOString())).permitida,
      true,
    );
    const r = await iniciar(t, cx, "conv_4", new Date(agora).toISOString());
    t.igual([r.permitida, r.motivo, r.ligacao_id], [false, "limite_por_contato", null]);
    const [{ n }] = await t.sql(`select count(*)::int as n from public.ligacoes`);
    t.igual(n, 3, "a recusada não grava nada");
  });

  it("ligacao_encerrar: grava o fim, o rótulo e a prévia; falha atrasada não desfaz; vazio não apaga; sem a ligação não devolve linha", async () => {
    const cx = await conexaoMeta(t);
    await iniciar(t, cx, "conv_b", new Date().toISOString());

    const fim = await encerrar(t, "conv_b");
    t.igual(fim.length, 1);
    const ler = async () =>
      (
        await t.sql(
          `select l.status::text, l.duracao_s, l.resumo, jsonb_array_length(l.transcricao) as falas,
                  l.custo_creditos, m.texto, c.ultima_mensagem_preview as previa
             from public.ligacoes l join public.mensagens m on m.id = l.mensagem_id
             join public.conversas c on c.id = l.conversa_id where l.id_externo = 'conv_b'`,
        )
      )[0];
    t.igual(await ler(), {
      status: "concluida",
      duracao_s: 174,
      resumo: "Quer saber o preço.",
      falas: 1,
      custo_creditos: 12,
      texto: "Ligação · 2 min 54 s",
      previa: "Ligação · 2 min 54 s",
    });

    await encerrar(t, "conv_b", {
      status: "nao_completada",
      duracao: null,
      resumo: null,
      transcricao: [],
    });
    t.igual((await ler()).status, "concluida", "a falha atrasada não desfaz a concluída");

    await encerrar(t, "conv_b", { resumo: "  ", transcricao: [] });
    const depois = await ler();
    t.igual([depois.resumo, depois.falas], ["Quer saber o preço.", 1], "vazio não apaga");

    t.igual((await encerrar(t, "conv_inexistente")).length, 0);
    await t.erro(encerrar(t, "conv_b", { status: "em_andamento" }), "status_invalido");
  });

  it("ligacao_encerrar não mexe na prévia quando a ligação não é a última mensagem", async () => {
    const cx = await conexaoMeta(t);
    const r = await iniciar(t, cx, "conv_c", new Date(Date.now() - 60_000).toISOString());
    await t.como("service_role", null, (q) =>
      q(`select * from public.registrar_entrada($1, $2::jsonb, '', $3::jsonb)`, [
        cx,
        IDS,
        JSON.stringify({
          id_externo: "wamid.depois",
          tipo: "texto",
          texto: "mandei depois",
          momento: new Date().toISOString(),
        }),
      ]),
    );
    await encerrar(t, "conv_c");
    const [c] = await t.sql(
      `select ultima_mensagem_preview as p from public.conversas where id = $1`,
      [r.conversa_id],
    );
    t.igual(c.p, "mandei depois");
  });

  it("ligacao_passar_para_equipe: passa uma vez por ligação, com o evento; depois da devolução não passa de novo", async () => {
    const cx = await conexaoMeta(t);
    const r = await iniciar(t, cx, "conv_d", new Date().toISOString());
    const passar = async () =>
      (
        await t.como("service_role", null, (q) =>
          q(`select public.ligacao_passar_para_equipe($1) as mudou`, [r.ligacao_id]),
        )
      )[0].mudou;

    t.igual(await passar(), true);
    const [c] = await t.sql(
      `select modo::text, motivo_humano::text, aguardando_humano_desde is not null as espera, responder_apos
         from public.conversas where id = $1`,
      [r.conversa_id],
    );
    t.igual(
      [c.modo, c.motivo_humano, c.espera, c.responder_apos],
      ["humano", "nina_passou", true, null],
    );

    // a equipe devolve para a Nina; o pós-chamada chega e não passa de novo
    await t.sql(
      `update public.conversas set modo = 'nina', motivo_humano = null, aguardando_humano_desde = null where id = $1`,
      [r.conversa_id],
    );
    t.igual(await passar(), false);
    const [{ eventos }] = await t.sql(
      `select count(*)::int as eventos from public.conversa_eventos where conversa_id = $1 and tipo = 'passou'`,
      [r.conversa_id],
    );
    t.igual(eventos, 1);
    const [{ modo }] = await t.sql(`select modo::text from public.conversas where id = $1`, [
      r.conversa_id,
    ]);
    t.igual(modo, "nina");
    await t.erro(
      t.como("service_role", null, (q) =>
        q(`select public.ligacao_passar_para_equipe(gen_random_uuid())`),
      ),
      "ligacao_nao_encontrada",
    );
  });

  it("ligacao_agente_atender: um agente atende por vez", async () => {
    const a = await agente(t, "Vendas", true);
    const b = await agente(t, "Suporte", false);
    await t.como("service_role", null, (q) => q(`select public.ligacao_agente_atender($1)`, [b]));
    const linhas = await t.sql(`select nome, atende from public.ligacao_agentes order by nome`);
    t.igual(linhas, [
      { nome: "Suporte", atende: true },
      { nome: "Vendas", atende: false },
    ]);
    await t.erro(
      t.sql(`update public.ligacao_agentes set atende = true where id = $1`, [a]),
      "ligacao_agentes_um_atende",
    );
  });

  it("acesso: membro lê, ninguém da tela grava; anon não vê nada; as funções são só do servidor", async () => {
    const cx = await conexaoMeta(t);
    await agente(t);
    await iniciar(t, cx, "conv_e", new Date().toISOString());
    const uAdmin = await t.criarUsuario("ligacoes-admin@exemplo.test", "Admin");

    await t.como("authenticated", uAdmin, async (q) => {
      t.igual((await q(`select count(*)::int as n from public.ligacoes`))[0].n, 1);
      t.igual((await q(`select count(*)::int as n from public.ligacao_agentes`))[0].n, 1);
    });
    await t.erro(
      t.como("authenticated", uAdmin, (q) =>
        q(`insert into public.ligacao_agentes (nome) values ('x')`),
      ),
      "permission denied",
    );
    await t.erro(
      t.como("authenticated", uAdmin, (q) => q(`update public.ligacoes set resumo = 'x'`)),
      "permission denied",
    );
    await t.erro(
      t.como("authenticated", uAdmin, (q) =>
        q(
          `select * from public.ligacao_iniciar($1, '[]'::jsonb, '', 'conv_x', null, 'entrada', now())`,
          [cx],
        ),
      ),
      "permission denied",
    );
    await t.erro(
      t.como("anon", null, (q) => q(`select count(*) from public.ligacoes`)),
      "permission denied",
    );
  });

  it("tempo real: ligacoes está na publicação, e a preparar_copia a inclui", async () => {
    const pub = await t.sql(
      `select 1 from pg_catalog.pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'ligacoes'`,
    );
    t.igual(pub.length, 1);
    const [{ def }] = await t.sql(
      `select pg_get_functiondef('public.preparar_copia()'::regprocedure) as def`,
    );
    t.ok(String(def).includes("'ligacoes'"), "a preparar_copia põe ligacoes no tempo real");
  });
});
