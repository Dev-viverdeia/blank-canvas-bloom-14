// @vitest-environment node
// O comportamento de antes das funções recriadas na 0006 continua: os testes do banco de 28/10
// que cobrem essas funções. O antigos/03-fila inteiro (entrada, rodadas, Nina, envios e membro,
// ou seja, a 0002) e, do antigos/01-estrutura, os 11 dos gatilhos de mensagens e do histórico.
//
// Adaptações: antes de cada teste, o onboarding é dado por concluído, porque o
// pegar_rodadas novo devolve vazio sem ele (decisão 2), e os testes antigos são de antes
// dessa regra. Os e-mails do 03-fila (teste.invalid) passaram para exemplo.test, o domínio de
// teste do resto da suíte.
import { beforeEach, describe, it } from "vitest";
import { montarBase, TEMPO_TESTE, usarBanco, type Banco, type Consulta } from "./montar";

const base = await montarBase();
const t = usarBanco(base);

const concluirOnboarding = () =>
  t.sql("update public.configuracao set onboarding_concluido_em = now() where id = 1");

describe("banco: antigo 03-fila (entrada, fila, Nina e membro)", { timeout: TEMPO_TESTE }, () => {
  // Do antigos/03-fila (T4, as funções da 0002): entrada, fila, Nina e membro.
  // Tudo com dado de teste dentro do banco isolado do PGlite.

  const TEL = "+55 (11) 90000-0001";
  const TEL_DIG = "5511900000001";

  async function preparar(t: Banco) {
    // etapas: usa as do 02 se existirem; senão cria as mínimas
    const [{ n }] = await t.sql(`select count(*)::int as n from public.etapas`);
    if (n === 0) {
      await t.sql(`insert into public.etapas (chave, nome, ordem, tipo, nina_pode_mover) values
        ('novo', 'Novo', 10, 'aberta', false),
        ('em_qualificacao', 'Em qualificação', 20, 'aberta', true),
        ('perdido', 'Perdido', 60, 'perdido', true)`);
    }
    const [cx] = await t.sql(
      `insert into public.conexoes (gateway, nome, id_externo, ativa, status)
       values ('zapi', 'Conexão de teste', 'inst-teste-1', true, 'conectada') returning id`,
    );
    const uAdmin = await t.criarUsuario("admin@exemplo.test", "Admin Teste");
    const uAtend = await t.criarUsuario("atendente@exemplo.test", "Atendente Teste");
    const [at] = await t.sql(
      `insert into public.membros (user_id, nome, email, papel)
       values ($1, 'Atendente Teste', 'atendente@exemplo.test', 'atendente') returning id`,
      [uAtend],
    );
    const [permitida] = await t.sql(
      `select id from public.etapas where nina_pode_mover and not arquivada order by ordem limit 1`,
    );
    const [proibida] = await t.sql(
      `select id from public.etapas where not nina_pode_mover and not arquivada order by ordem limit 1`,
    );
    return {
      cx: cx.id,
      uAdmin,
      uAtend,
      atendenteId: at.id,
      permitida: permitida.id,
      proibida: proibida.id,
    };
  }

  function ids(tel = TEL, extra = []) {
    return [{ tipo: "telefone", valor: tel }, ...extra];
  }

  type Preparo = Awaited<ReturnType<typeof preparar>>;
  type Identificador = { tipo: string; valor: string };

  function msg(idExterno: string, extra: Record<string, unknown> = {}) {
    return {
      id_externo: idExterno,
      tipo: "texto",
      texto: `oi ${idExterno}`,
      momento: new Date().toISOString(),
      ...extra,
    };
  }

  async function entrada(
    t: Banco,
    cx: string,
    idsLista: Identificador[],
    m: Record<string, unknown>,
    nome: string | null = "Lead Teste",
  ) {
    const [r] = await t.sql(
      `select * from public.registrar_entrada($1, $2::jsonb, $3, $4::jsonb)`,
      [cx, JSON.stringify(idsLista), nome, JSON.stringify(m)],
    );
    return r;
  }

  async function saidaCelular(
    t: Banco,
    cx: string,
    idsLista: Identificador[],
    m: Record<string, unknown>,
  ) {
    const [r] = await t.sql(
      `select public.registrar_saida_celular($1, $2::jsonb, $3::jsonb) as id`,
      [cx, JSON.stringify(idsLista), JSON.stringify(m)],
    );
    return r.id;
  }

  async function vencer(t: Banco, conversa: string) {
    await t.sql(
      `update public.conversas set responder_apos = now() - interval '1 second' where id = $1`,
      [conversa],
    );
  }

  async function pegarRodadas(t: Banco, limite = 10) {
    return t.sql(`select * from public.pegar_rodadas($1)`, [limite]);
  }

  async function pegarEnvios(t: Banco, limite = 10) {
    return t.sql(`select * from public.pegar_envios($1)`, [limite]);
  }

  async function concluirRodada(t: Banco, rodada: string, textos: string[], passos = 1) {
    await t.sql(`select public.concluir_rodada($1, $2::jsonb, '[]'::jsonb, $3)`, [
      rodada,
      JSON.stringify(textos.map((texto) => ({ texto }))),
      passos,
    ]);
  }

  async function conversa(t: Banco, id: string) {
    const [c] = await t.sql(`select * from public.conversas where id = $1`, [id]);
    return c;
  }

  // rodada já aberta para uma conversa nova
  async function comRodada(t: Banco, b: Preparo, tel = TEL) {
    const e = await entrada(t, b.cx, ids(tel), msg(`w-${tel}-1`));
    await vencer(t, e.conversa_id);
    const rs = await pegarRodadas(t);
    t.igual(rs.length, 1, "pegar_rodadas devia criar 1 rodada");
    return { conversa: e.conversa_id, rodada: rs[0].id, mensagem: e.mensagem_id };
  }

  beforeEach(concluirOnboarding);

  // ---------------------------------------------------------------- entrada
  it("mesmo webhook 2 vezes = 1 mensagem", async () => {
    const b = await preparar(t);
    const m = msg("wamid-1");
    const a = await t.como(
      "service_role",
      null,
      async (q) =>
        (
          await q(`select * from public.registrar_entrada($1, $2::jsonb, $3, $4::jsonb)`, [
            b.cx,
            JSON.stringify(ids()),
            "Lead",
            JSON.stringify(m),
          ])
        )[0],
    );
    const d = await entrada(t, b.cx, ids(), m);
    t.igual(a.nova, true, "1ª chamada");
    t.igual(d.nova, false, "2ª chamada");
    t.igual(d.mensagem_id, a.mensagem_id, "mesmo id de mensagem");
    t.igual(d.conversa_id, a.conversa_id, "mesma conversa");
    const [{ n }] = await t.sql(
      `select count(*)::int as n from public.mensagens where id_externo = 'wamid-1'`,
    );
    t.igual(n, 1, "mensagens com o id");
    const [{ c }] = await t.sql(`select count(*)::int as c from public.contatos`);
    t.igual(c, 1, "contatos");
  });

  it("entrada cria contato com telefone em dígitos, etapa, conversa e primeira_mensagem_em", async () => {
    const b = await preparar(t);
    const momento = "2026-10-20T15:00:00Z";
    const e = await entrada(t, b.cx, ids(), msg("w-a", { momento }), "Fulano WhatsApp");
    const [ct] = await t.sql(
      `select ct.* from public.contatos ct join public.conversas c on c.contato_id = ct.id where c.id = $1`,
      [e.conversa_id],
    );
    t.igual(ct.telefone, TEL_DIG, "telefone");
    t.igual(ct.nome_whatsapp, "Fulano WhatsApp", "nome_whatsapp");
    t.ok(ct.etapa_id, "etapa de entrada");
    t.igual(
      ct.primeira_mensagem_em.toISOString(),
      new Date(momento).toISOString(),
      "primeira_mensagem_em",
    );
    const [ci] = await t.sql(
      `select tipo::text, valor from public.contato_identificadores where contato_id = $1`,
      [ct.id],
    );
    t.igual(ci, { tipo: "telefone", valor: TEL_DIG }, "identificador");
    // mensagem mais antiga (fora de ordem) puxa a primeira_mensagem_em para trás
    await entrada(t, b.cx, ids(), msg("w-b", { momento: "2026-10-19T10:00:00Z" }));
    const [ct2] = await t.sql(`select primeira_mensagem_em from public.contatos where id = $1`, [
      ct.id,
    ]);
    t.igual(
      ct2.primeira_mensagem_em.toISOString(),
      "2026-10-19T10:00:00.000Z",
      "primeira_mensagem_em mais antiga",
    );
    const [m] = await t.sql(
      `select direcao::text, origem::text, status::text, tipo::text from public.mensagens where id = $1`,
      [e.mensagem_id],
    );
    t.igual(
      m,
      { direcao: "entrada", origem: "lead", status: "recebida", tipo: "texto" },
      "mensagem",
    );
    await t.erro(
      entrada(t, b.cx, [{ tipo: "telefone", valor: "  " }], msg("w-c")),
      "sem_identificador",
    );
  });

  it("edição e apagamento no mesmo id; tipo desconhecido vira outro", async () => {
    const b = await preparar(t);
    const e = await entrada(t, b.cx, ids(), msg("w-ed", { texto: "original" }));
    const r1 = await entrada(t, b.cx, ids(), msg("w-ed", { texto: "editado", editada: true }));
    t.igual(r1.nova, false, "edição não é nova");
    let [m] = await t.sql(`select texto, editada, apagada_em from public.mensagens where id = $1`, [
      e.mensagem_id,
    ]);
    t.igual(m.texto, "editado", "texto trocado");
    t.igual(m.editada, true, "editada");
    t.igual(m.apagada_em, null, "não apagada");
    await entrada(t, b.cx, ids(), msg("w-ed", { apagada: true }));
    [m] = await t.sql(`select texto, apagada_em from public.mensagens where id = $1`, [
      e.mensagem_id,
    ]);
    t.ok(m.apagada_em, "apagada_em preenchida");
    t.igual(m.texto, "editado", "apagamento não mexe no texto");
    const x = await entrada(t, b.cx, ids(), msg("w-tipo", { tipo: "enquete" }));
    const [mx] = await t.sql(`select tipo::text from public.mensagens where id = $1`, [
      x.mensagem_id,
    ]);
    t.igual(mx.tipo, "outro", "tipo fora da lista");
    // apagamento de mensagem nunca gravada: não cria nada (nem lead fantasma)
    const ap = await entrada(
      t,
      b.cx,
      ids("5511900000088"),
      msg("w-fantasma", { apagada: true, texto: null }),
    );
    t.igual(ap, { mensagem_id: null, conversa_id: null, nova: false }, "nada gravado");
    const [{ n }] = await t.sql(
      `select count(*)::int as n from public.contatos where telefone = '5511900000088'`,
    );
    t.igual(n, 0, "sem contato fantasma");
    // edição que chega antes da original entra marcada como editada
    const ed = await entrada(
      t,
      b.cx,
      ids(),
      msg("w-ed-antes", { texto: "já editado", editada: true }),
    );
    t.igual(ed.nova, true, "gravada");
    const [me] = await t.sql(`select texto, editada from public.mensagens where id = $1`, [
      ed.mensagem_id,
    ]);
    t.igual(me, { texto: "já editado", editada: true }, "editada");
  });

  it("dois contatos nunca se juntam; id novo é ligado ao contato achado", async () => {
    const b = await preparar(t);
    const a = await entrada(t, b.cx, ids(), msg("w-1"));
    const bb = await entrada(t, b.cx, [{ tipo: "bsuid", valor: "BR.bsuid.1" }], msg("w-2"));
    t.ok(a.conversa_id !== bb.conversa_id, "dois contatos diferentes");
    // bsuid (de B) tem prioridade sobre telefone (de A): vai para B, sem juntar
    const c = await entrada(
      t,
      b.cx,
      [
        { tipo: "telefone", valor: TEL },
        { tipo: "bsuid", valor: "BR.bsuid.1" },
      ],
      msg("w-3"),
    );
    t.igual(c.conversa_id, bb.conversa_id, "prioridade do bsuid");
    const [{ n }] = await t.sql(`select count(*)::int as n from public.contatos`);
    t.igual(n, 2, "continua com 2 contatos");
    const dono = await t.sql(
      `select cv.id as conversa from public.contato_identificadores ci
           join public.conversas cv on cv.contato_id = ci.contato_id
          where ci.tipo = 'telefone' and ci.valor = $1`,
      [TEL_DIG],
    );
    t.igual(
      dono.map((d) => d.conversa),
      [a.conversa_id],
      "telefone segue com A",
    );
    const [fichaB] = await t.sql(
      `select ct.telefone from public.contatos ct join public.conversas cv on cv.contato_id = ct.id where cv.id = $1`,
      [bb.conversa_id],
    );
    t.igual(fichaB.telefone, null, "telefone de A não vai para a ficha de B");
    // id novo (lid) chega junto com o telefone de A: liga em A
    const d = await entrada(
      t,
      b.cx,
      [
        { tipo: "telefone", valor: TEL },
        { tipo: "lid", valor: "123@lid" },
      ],
      msg("w-4"),
    );
    t.igual(d.conversa_id, a.conversa_id, "achou A");
    const [{ l }] = await t.sql(
      `select count(*)::int as l from public.contato_identificadores ci
           join public.conversas cv on cv.contato_id = ci.contato_id
          where ci.tipo = 'lid' and ci.valor = '123@lid' and cv.id = $1`,
      [a.conversa_id],
    );
    t.igual(l, 1, "lid ligado a A");
  });

  // ---------------------------------------------------------------- rodadas
  it("2º pegar_rodadas não repete conversa; liga entradas e limpa responder_apos", async () => {
    const b = await preparar(t);
    const e = await entrada(t, b.cx, ids(), msg("w-1"));
    const c0 = await conversa(t, e.conversa_id);
    t.ok(c0.responder_apos, "gatilho armou responder_apos");
    t.igual((await pegarRodadas(t)).length, 0, "antes da espera não pega");
    await vencer(t, e.conversa_id);
    const r1 = await t.como("service_role", null, (q) =>
      q(`select * from public.pegar_rodadas(10)`),
    );
    t.igual(r1.length, 1, "1ª chamada");
    t.igual(r1[0].status, "rodando", "status");
    t.igual(r1[0].tentativa, 1, "tentativa");
    t.igual(r1[0].conversa_id, e.conversa_id, "conversa");
    t.igual((await conversa(t, e.conversa_id)).responder_apos, null, "responder_apos limpo");
    const [m] = await t.sql(`select rodada_id from public.mensagens where id = $1`, [
      e.mensagem_id,
    ]);
    t.igual(m.rodada_id, r1[0].id, "entrada ligada à rodada");
    t.igual((await pegarRodadas(t)).length, 0, "2ª chamada");
    await vencer(t, e.conversa_id);
    t.igual((await pegarRodadas(t)).length, 0, "com rodada rodando não pega de novo");
  });

  it("mídia pendente segura a rodada; copiada libera; pendente velha não segura", async () => {
    const b = await preparar(t);
    const e = await entrada(
      t,
      b.cx,
      ids(),
      msg("w-img", {
        tipo: "imagem",
        texto: null,
        midia_ref_externa: "https://midia.invalid/1",
        midia_mime: "image/jpeg",
      }),
    );
    const [m0] = await t.sql(`select midia_status::text from public.mensagens where id = $1`, [
      e.mensagem_id,
    ]);
    t.igual(m0.midia_status, "pendente", "midia_status");
    await vencer(t, e.conversa_id);
    t.igual((await pegarRodadas(t)).length, 0, "mídia pendente segura");
    const pm = await t.sql(`select * from public.pegar_midias(10)`);
    t.igual(pm.length, 1, "pegar_midias");
    t.igual(pm[0].midia_tentativas, 1, "tentativas da mídia");
    t.igual(
      (await t.sql(`select * from public.pegar_midias(10)`)).length,
      0,
      "travada não é pega de novo",
    );
    await t.sql(`select public.concluir_midia($1, $2, 'image/png', 1234, true)`, [
      e.mensagem_id,
      `${e.conversa_id}/${e.mensagem_id}`,
    ]);
    const [m1] = await t.sql(
      `select midia_status::text, midia_caminho, midia_mime, midia_tamanho::int from public.mensagens where id = $1`,
      [e.mensagem_id],
    );
    t.igual(
      m1,
      {
        midia_status: "copiada",
        midia_caminho: `${e.conversa_id}/${e.mensagem_id}`,
        midia_mime: "image/png",
        midia_tamanho: 1234,
      },
      "copiada",
    );
    t.igual((await pegarRodadas(t)).length, 1, "depois da cópia pega");

    // outra conversa: pendente há mais de 2 min não segura
    const e2 = await entrada(
      t,
      b.cx,
      ids("5511900000002"),
      msg("w-img2", { tipo: "audio", midia_ref_externa: "https://midia.invalid/2" }),
    );
    await t.sql(
      `update public.mensagens set criado_em = now() - interval '3 minutes' where id = $1`,
      [e2.mensagem_id],
    );
    await vencer(t, e2.conversa_id);
    t.igual((await pegarRodadas(t)).length, 1, "pendente velha não segura");
  });

  it("cópia de mídia falha 3 vezes e vira falhou", async () => {
    const b = await preparar(t);
    const e = await entrada(
      t,
      b.cx,
      ids(),
      msg("w-aud", { tipo: "audio", midia_ref_externa: "https://midia.invalid/3" }),
    );
    for (let i = 1; i <= 3; i++) {
      const pm = await t.sql(`select * from public.pegar_midias(10)`);
      t.igual(pm.length, 1, `tentativa ${i}`);
      await t.sql(`select public.concluir_midia($1, null, null, null, false)`, [e.mensagem_id]);
    }
    const [m] = await t.sql(
      `select midia_status::text, midia_tentativas::int from public.mensagens where id = $1`,
      [e.mensagem_id],
    );
    t.igual(m, { midia_status: "falhou", midia_tentativas: 3 }, "falhou na 3ª");
    t.igual((await t.sql(`select * from public.pegar_midias(10)`)).length, 0, "não pega mais");
  });

  it("falha passageira re-arma até 2 vezes e a 3ª vai para aguardando humano", async () => {
    const b = await preparar(t);
    const e = await entrada(t, b.cx, ids(), msg("w-1"));
    for (let i = 1; i <= 3; i++) {
      await vencer(t, e.conversa_id);
      const rs = await pegarRodadas(t);
      t.igual(rs.length, 1, `rodada ${i}`);
      t.igual(rs[0].tentativa, i, `tentativa ${i}`);
      await t.sql(`select public.falhar_rodada($1, 'erro_provedor', true)`, [rs[0].id]);
      const [r] = await t.sql(
        `select status::text, motivo::text from public.rodadas where id = $1`,
        [rs[0].id],
      );
      t.igual(r, { status: "falhou", motivo: "erro_provedor" }, `rodada ${i} falhou`);
      const [m] = await t.sql(`select rodada_id from public.mensagens where id = $1`, [
        e.mensagem_id,
      ]);
      t.igual(m.rodada_id, null, `entrada solta na ${i}`);
      const c = await conversa(t, e.conversa_id);
      if (i < 3) {
        t.igual(c.modo, "nina", `modo na ${i}`);
        const [{ ok }] = await t.sql(
          `select responder_apos between now() + interval '25 seconds' and now() + interval '35 seconds' as ok
               from public.conversas where id = $1`,
          [e.conversa_id],
        );
        t.ok(ok, `responder_apos em ~30 s na ${i}`);
      } else {
        t.igual(c.modo, "humano", "modo na 3ª");
        t.igual(c.motivo_humano, "erro_provedor", "motivo");
        t.ok(c.aguardando_humano_desde, "aguardando humano");
        t.igual(c.responder_apos, null, "sem responder_apos");
      }
    }
  });

  it("falha não passageira vai direto para aguardando humano; rodada velha expira", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await t.sql(`select public.falhar_rodada($1, 'chave_invalida', false)`, [x.rodada]);
    const c = await conversa(t, x.conversa);
    t.igual([c.modo, c.motivo_humano], ["humano", "chave_invalida"], "na 1ª");
    await t.erro(
      t.sql(`select public.falhar_rodada($1, 'erro_provedor', true)`, [x.rodada]),
      "rodada_nao_rodando",
    );

    // rodada rodando há mais de 5 min falha como erro_provedor passageiro
    const y = await comRodada(t, b, "5511900000009");
    await t.sql(
      `update public.rodadas set iniciada_em = now() - interval '6 minutes' where id = $1`,
      [y.rodada],
    );
    t.igual((await pegarRodadas(t)).length, 0, "a expirada re-arma para daqui a 30 s");
    const [r] = await t.sql(`select status::text, motivo::text from public.rodadas where id = $1`, [
      y.rodada,
    ]);
    t.igual(r, { status: "falhou", motivo: "erro_provedor" }, "expirada");
    const cy = await conversa(t, y.conversa);
    t.igual(cy.modo, "nina", "continua com a Nina");
    t.ok(cy.responder_apos > new Date(), "re-armada");
    await vencer(t, y.conversa);
    const rs = await pegarRodadas(t);
    t.igual(rs[0].tentativa, 2, "próxima é a tentativa 2");
  });

  it("concluir_rodada grava respostas em ordem com 2 s entre elas", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await concluirRodada(t, x.rodada, ["Oi!", "  ", "Como posso ajudar?"], 3);
    const ms = await t.sql(
      `select texto, ordem::int, status::text, origem::text, rodada_id,
                extract(epoch from enviar_apos - criado_em)::int as atraso
           from public.mensagens where conversa_id = $1 and direcao = 'saida' order by ordem`,
      [x.conversa],
    );
    t.igual(
      ms.map((m) => [m.texto, m.ordem, m.status, m.origem, m.atraso]),
      [
        ["Oi!", 1, "na_fila", "nina", 0],
        ["Como posso ajudar?", 2, "na_fila", "nina", 2],
      ],
      "respostas",
    );
    t.ok(
      ms.every((m) => m.rodada_id === x.rodada),
      "rodada_id",
    );
    const [r] = await t.sql(
      `select status::text, passos::int, terminada_em from public.rodadas where id = $1`,
      [x.rodada],
    );
    t.igual([r.status, r.passos], ["concluida", 3], "rodada");
    t.ok(r.terminada_em, "terminada_em");
    await t.erro(concluirRodada(t, x.rodada, ["de novo"]), "rodada_nao_rodando");
  });

  it("concluir_rodada com a conversa já em modo humano grava as respostas como cancelada", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await t.como("authenticated", b.uAtend, (q) =>
      q(`select public.assumir_conversa($1)`, [x.conversa]),
    );
    await concluirRodada(t, x.rodada, ["Oi!", "Tudo bem?"]);
    const ms = await t.sql(
      `select status::text from public.mensagens where conversa_id = $1 and origem = 'nina'`,
      [x.conversa],
    );
    t.igual(
      ms.map((m) => m.status),
      ["cancelada", "cancelada"],
      "canceladas",
    );
    t.igual((await pegarEnvios(t)).length, 0, "nada para enviar");
  });

  it("conversa sai e volta para a Nina durante a rodada: as respostas são canceladas", async () => {
    const b = await preparar(t);
    const ex = await entrada(t, b.cx, ids(), msg("w-x"));
    const ey = await entrada(t, b.cx, ids("5511900000011"), msg("w-y"));
    await vencer(t, ex.conversa_id);
    await vencer(t, ey.conversa_id);
    const rs = await pegarRodadas(t);
    t.igual(rs.length, 2, "duas rodadas");
    const x = {
      conversa: ex.conversa_id,
      rodada: rs.find((r) => r.conversa_id === ex.conversa_id).id,
    };
    const y = {
      conversa: ey.conversa_id,
      rodada: rs.find((r) => r.conversa_id === ey.conversa_id).id,
    };
    // (a) assumiu e devolveu
    await t.como("authenticated", b.uAtend, (q) =>
      q(`select public.assumir_conversa($1)`, [x.conversa]),
    );
    await t.como("authenticated", b.uAtend, (q) =>
      q(`select public.devolver_para_nina($1)`, [x.conversa]),
    );
    t.igual((await conversa(t, x.conversa)).modo, "nina", "de volta com a Nina");
    await concluirRodada(t, x.rodada, ["resposta velha"]);
    const [m] = await t.sql(
      `select status::text from public.mensagens where conversa_id = $1 and origem = 'nina'`,
      [x.conversa],
    );
    t.igual(m.status, "cancelada", "(a) cancelada");
    const [r] = await t.sql(`select status::text from public.rodadas where id = $1`, [x.rodada]);
    t.igual(r.status, "cancelada", "rodada cancelada");
    // falhar_rodada numa rodada cancelada não faz nada
    await t.sql(`select public.falhar_rodada($1, 'erro_provedor', true)`, [x.rodada]);
    t.igual(
      (await t.sql(`select status::text as s from public.rodadas where id = $1`, [x.rodada]))[0].s,
      "cancelada",
      "segue cancelada",
    );
    // (b) humano respondeu pela tela e devolveu: a resposta velha da Nina não sai depois da dele
    await t.como("authenticated", b.uAtend, (q) =>
      q(
        `insert into public.mensagens (conversa_id, direcao, origem, texto, status) values ($1, 'saida', 'humano_tela', 'respondi', 'na_fila')`,
        [y.conversa],
      ),
    );
    await t.como("authenticated", b.uAtend, (q) =>
      q(`select public.devolver_para_nina($1)`, [y.conversa]),
    );
    await concluirRodada(t, y.rodada, ["resposta velha"]);
    const [my] = await t.sql(
      `select status::text from public.mensagens where conversa_id = $1 and origem = 'nina'`,
      [y.conversa],
    );
    t.igual(my.status, "cancelada", "(b) cancelada");
    // (a) devolveu com a mensagem do lead sem resposta: a Nina responde de novo, numa rodada nova;
    // (b) o humano já respondeu: nada
    const novas = await pegarRodadas(t);
    t.igual(
      novas.map((r) => [r.conversa_id, r.tentativa]),
      [[x.conversa, 1]],
      "só (a) ganha rodada nova",
    );
  });

  it("nina passou para humano e alguém assumiu: a despedida ainda vai", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await t.sql(`select public.nina_passar_para_humano($1)`, [x.rodada]);
    await t.como("authenticated", b.uAtend, (q) =>
      q(`select public.assumir_conversa($1)`, [x.conversa]),
    );
    await concluirRodada(t, x.rodada, ["Vou te passar para a equipe."]);
    const [m] = await t.sql(
      `select status::text from public.mensagens where conversa_id = $1 and origem = 'nina'`,
      [x.conversa],
    );
    t.igual(m.status, "na_fila", "despedida na fila");
  });

  it("depois de 3 falhas e Devolver, a Nina volta a ter 2 novas tentativas", async () => {
    const b = await preparar(t);
    const e = await entrada(t, b.cx, ids(), msg("w-1"));
    for (let i = 1; i <= 3; i++) {
      await vencer(t, e.conversa_id);
      const [r] = await pegarRodadas(t);
      await t.sql(`select public.falhar_rodada($1, 'erro_provedor', true)`, [r.id]);
    }
    t.igual((await conversa(t, e.conversa_id)).modo, "humano", "foi para humano na 3ª");
    await t.como("authenticated", b.uAtend, (q) =>
      q(`select public.devolver_para_nina($1)`, [e.conversa_id]),
    );
    const [r4] = await pegarRodadas(t);
    t.igual(r4.tentativa, 1, "tentativa recomeça");
    await t.sql(`select public.falhar_rodada($1, 'erro_provedor', true)`, [r4.id]);
    const c = await conversa(t, e.conversa_id);
    t.igual(c.modo, "nina", "continua com a Nina");
    const [{ ok }] = await t.sql(
      `select responder_apos between now() + interval '25 seconds' and now() + interval '35 seconds' as ok
           from public.conversas where id = $1`,
      [e.conversa_id],
    );
    t.ok(ok, "responder_apos em ~30 s");
  });

  it("janela fechada no oficial: devolver não arma e pegar_rodadas não abre rodada; sem conexão ativa também não", async () => {
    const b = await preparar(t);
    const e = await entrada(t, b.cx, ids(), msg("w-1"));
    await t.sql(`update public.conexoes set ativa = false where id = $1`, [b.cx]);
    await vencer(t, e.conversa_id);
    t.igual((await pegarRodadas(t)).length, 0, "sem conexão ativa não abre rodada");
    await t.sql(
      `insert into public.conexoes (gateway, nome, id_externo, ativa, status) values ('meta', 'Meta teste', 'pn-teste', true, 'conectada')`,
    );
    await t.sql(
      `update public.conversas set ultima_do_lead_em = now() - interval '25 hours' where id = $1`,
      [e.conversa_id],
    );
    t.igual((await pegarRodadas(t)).length, 0, "janela fechada não abre rodada");
    t.ok((await conversa(t, e.conversa_id)).responder_apos, "continua armada");
    await t.como("authenticated", b.uAtend, (q) =>
      q(`select public.assumir_conversa($1)`, [e.conversa_id]),
    );
    await t.como("authenticated", b.uAtend, (q) =>
      q(`select public.devolver_para_nina($1)`, [e.conversa_id]),
    );
    t.igual(
      (await conversa(t, e.conversa_id)).responder_apos,
      null,
      "devolver com janela fechada não arma",
    );
    // janela aberta: abre
    await t.sql(
      `update public.conversas set ultima_do_lead_em = now() - interval '1 hour' where id = $1`,
      [e.conversa_id],
    );
    await t.como("authenticated", b.uAtend, (q) =>
      q(`select public.devolver_para_nina($1)`, [e.conversa_id]),
    );
    t.igual((await pegarRodadas(t)).length, 1, "janela aberta: a Nina responde");
  });

  it("nina_passar_para_humano: aguardando humano e a despedida ainda vai", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await t.sql(`select public.nina_passar_para_humano($1)`, [x.rodada]);
    const c = await conversa(t, x.conversa);
    t.igual([c.modo, c.motivo_humano], ["humano", "nina_passou"], "conversa");
    t.ok(c.aguardando_humano_desde, "aguardando");
    await concluirRodada(t, x.rodada, ["Vou te passar para alguém da equipe."]);
    const [m] = await t.sql(
      `select status::text from public.mensagens where conversa_id = $1 and origem = 'nina'`,
      [x.conversa],
    );
    t.igual(m.status, "na_fila", "despedida na fila");
    const [r] = await t.sql(`select passou_humano from public.rodadas where id = $1`, [x.rodada]);
    t.igual(r.passou_humano, true, "passou_humano");
  });

  // ---------------------------------------------------------------- Nina
  it("nina_mover_etapa: etapa_nao_permitida e histórico com ator nina", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await t.erro(
      t.sql(`select public.nina_mover_etapa($1, $2)`, [x.rodada, b.proibida]),
      "etapa_nao_permitida",
    );
    await t.como("service_role", null, (q) =>
      q(`select public.nina_mover_etapa($1, $2)`, [x.rodada, b.permitida]),
    );
    const [ct] = await t.sql(
      `select ct.id, ct.etapa_id from public.contatos ct join public.conversas c on c.contato_id = ct.id where c.id = $1`,
      [x.conversa],
    );
    t.igual(ct.etapa_id, b.permitida, "etapa mudou");
    const h = await t.sql(
      `select ator::text, rodada_id from public.contato_etapa_historico
          where contato_id = $1 and para_etapa_id = $2`,
      [ct.id, b.permitida],
    );
    t.igual(h.length, 1, "uma linha de histórico");
    t.igual([h[0].ator, h[0].rodada_id], ["nina", x.rodada], "ator nina e rodada");
    await concluirRodada(t, x.rodada, ["ok"]);
    await t.erro(
      t.sql(`select public.nina_mover_etapa($1, $2)`, [x.rodada, b.permitida]),
      "rodada_nao_rodando",
    );
  });

  it("nina_atualizar_contato recusa campo fora da lista", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await t.erro(
      t.sql(`select public.nina_atualizar_contato($1, $2::jsonb)`, [
        x.rodada,
        JSON.stringify({ telefone: "5511999999999" }),
      ]),
      "campo_nao_permitido",
    );
    await t.erro(
      t.sql(`select public.nina_atualizar_contato($1, $2::jsonb)`, [
        x.rodada,
        JSON.stringify({ nome: "X", etapa_id: b.permitida }),
      ]),
      "campo_nao_permitido",
    );
    await t.sql(`select public.nina_atualizar_contato($1, $2::jsonb)`, [
      x.rodada,
      JSON.stringify({ nome: "Fulano Teste", resumo_nina: "Quer saber o preço." }),
    ]);
    const [ct] = await t.sql(
      `select ct.nome, ct.resumo_nina, ct.email, ct.telefone from public.contatos ct
           join public.conversas c on c.contato_id = ct.id where c.id = $1`,
      [x.conversa],
    );
    t.igual(
      ct,
      { nome: "Fulano Teste", resumo_nina: "Quer saber o preço.", email: null, telefone: TEL_DIG },
      "contato",
    );
  });

  // ---------------------------------------------------------------- envios
  it("pegar_envios: 1ª pendente de cada conversa, só com conexão ativa", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await concluirRodada(t, x.rodada, ["um", "dois"]);
    const y = await comRodada(t, b, "5511900000003");
    await concluirRodada(t, y.rodada, ["outra"]);
    await t.sql(
      `update public.mensagens set enviar_apos = now() - interval '1 second' where direcao = 'saida'`,
    );
    const e1 = await t.como("service_role", null, (q) =>
      q(`select * from public.pegar_envios(10)`),
    );
    t.igual(e1.map((m) => m.texto).sort(), ["outra", "um"], "1ª de cada conversa");
    t.ok(
      e1.every((m) => m.status === "enviando" && m.tentativas === 1),
      "enviando, tentativa 1",
    );
    t.igual((await pegarEnvios(t)).length, 0, "com uma enviando, a conversa espera");
    const um = e1.find((m) => m.texto === "um");
    await t.sql(`select public.concluir_envio($1, 'wamid-um', 'gw-um')`, [um.id]);
    const e2 = await pegarEnvios(t);
    t.igual(
      e2.map((m) => m.texto),
      ["dois"],
      "depois vem a 2ª",
    );
    // sem conexão ativa: nada sai
    await t.sql(`select public.concluir_envio($1, 'wamid-dois', null)`, [e2[0].id]);
    const z = await comRodada(t, b, "5511900000004");
    await concluirRodada(t, z.rodada, ["tres"]);
    await t.sql(`update public.conexoes set ativa = false where id = $1`, [b.cx]);
    t.igual((await pegarEnvios(t)).length, 0, "conexão desativada");
  });

  it("pegar_envios: enviando há mais de 2 min volta e a 3ª tentativa falha", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await concluirRodada(t, x.rodada, ["oi"]);
    let e = await pegarEnvios(t);
    const id = e[0].id;
    for (let i = 2; i <= 3; i++) {
      await t.sql(
        `update public.mensagens set status_em = now() - interval '3 minutes' where id = $1`,
        [id],
      );
      e = await pegarEnvios(t);
      t.igual(
        e.map((m) => [m.id, m.tentativas]),
        [[id, i]],
        `volta na tentativa ${i}`,
      );
    }
    await t.sql(
      `update public.mensagens set status_em = now() - interval '3 minutes' where id = $1`,
      [id],
    );
    t.igual((await pegarEnvios(t)).length, 0, "não volta mais");
    const [m] = await t.sql(`select status::text from public.mensagens where id = $1`, [id]);
    t.igual(m.status, "falhou", "falhou na 3ª");
  });

  it("falhar_envio: passageiro volta à fila, definitivo falha", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await concluirRodada(t, x.rodada, ["oi"]);
    const [m] = await pegarEnvios(t);
    await t.sql(`select public.falhar_envio($1, 'erro 500', false)`, [m.id]);
    let [r] = await t.sql(
      `select status::text, erro, enviar_apos > now() as depois from public.mensagens where id = $1`,
      [m.id],
    );
    t.igual(r, { status: "na_fila", erro: "erro 500", depois: true }, "passageiro");
    t.igual((await pegarEnvios(t)).length, 0, "espera o enviar_apos");
    await t.sql(
      `update public.mensagens set enviar_apos = now() - interval '1 second' where id = $1`,
      [m.id],
    );
    t.igual((await pegarEnvios(t)).length, 1, "pega de novo");
    await t.sql(`select public.falhar_envio($1, 'numero invalido', true)`, [m.id]);
    [r] = await t.sql(`select status::text, erro from public.mensagens where id = $1`, [m.id]);
    t.igual(r, { status: "falhou", erro: "numero invalido" }, "definitivo");
  });

  it("eco do nosso envio não vira humano_celular", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await concluirRodada(t, x.rodada, ["Olá, tudo bem?"]);
    const [m] = await pegarEnvios(t);
    const eco = await t.como(
      "service_role",
      null,
      async (q) =>
        (
          await q(`select public.registrar_saida_celular($1, $2::jsonb, $3::jsonb) as id`, [
            b.cx,
            JSON.stringify(ids()),
            JSON.stringify(msg("wamid-eco", { texto: "Olá, tudo bem?" })),
          ])
        )[0].id,
    );
    t.igual(eco, m.id, "eco casou com a nossa mensagem");
    const [{ n }] = await t.sql(
      `select count(*)::int as n from public.mensagens where origem = 'humano_celular'`,
    );
    t.igual(n, 0, "nenhuma humano_celular");
    t.igual((await conversa(t, x.conversa)).modo, "nina", "continua com a Nina");
    const [mm] = await t.sql(`select id_externo from public.mensagens where id = $1`, [m.id]);
    t.igual(mm.id_externo, "wamid-eco", "ganhou o id_externo");
    // concluir_envio com o mesmo id não dá erro
    await t.sql(`select public.concluir_envio($1, 'wamid-eco', 'gw-1')`, [m.id]);
    const [m2] = await t.sql(
      `select status::text, id_externo, id_gateway from public.mensagens where id = $1`,
      [m.id],
    );
    t.igual(m2, { status: "enviada", id_externo: "wamid-eco", id_gateway: "gw-1" }, "enviada");
    // id conhecido é ignorado
    t.igual(
      await saidaCelular(t, b.cx, ids(), msg("wamid-eco", { texto: "qualquer" })),
      m.id,
      "id conhecido",
    );
  });

  it("mensagem do celular (não eco) vira humano_celular e põe a conversa no modo humano", async () => {
    const b = await preparar(t);
    const e = await entrada(t, b.cx, ids(), msg("w-1"));
    const id = await saidaCelular(
      t,
      b.cx,
      ids(),
      msg("wamid-cel", { texto: "respondi pelo celular" }),
    );
    const [m] = await t.sql(
      `select origem::text, direcao::text, status::text from public.mensagens where id = $1`,
      [id],
    );
    t.igual(m, { origem: "humano_celular", direcao: "saida", status: "enviada" }, "mensagem");
    t.igual((await conversa(t, e.conversa_id)).modo, "humano", "modo humano");
  });

  it("eco com espaço sobrando ou quebra de linha diferente ainda casa", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await concluirRodada(t, x.rodada, ["Texto da Nina\nsegunda linha", "Outra parte"]);
    const [m] = await pegarEnvios(t);
    const eco = await saidaCelular(
      t,
      b.cx,
      ids(),
      msg("wamid-esp", { texto: "  Texto da Nina\r\nsegunda   linha " }),
    );
    t.igual(eco, m.id, "casou com a nossa mensagem");
    const c = await conversa(t, x.conversa);
    t.igual([c.modo, c.motivo_humano], ["nina", null], "continua com a Nina");
    const [{ n }] = await t.sql(
      `select count(*)::int as n from public.mensagens where origem = 'humano_celular'`,
    );
    t.igual(n, 0, "nenhuma humano_celular");
    const [p2] = await t.sql(
      `select status::text from public.mensagens where texto = 'Outra parte'`,
    );
    t.igual(p2.status, "na_fila", "2ª parte segue na fila");
  });

  it("eco depois de enviada (sem id_externo) e eco pelo id_gateway (Zernio) não viram humano_celular", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await concluirRodada(t, x.rodada, ["Primeira", "Segunda"]);
    let [m] = await pegarEnvios(t);
    // Zernio: o envio devolve só o id dela (id_gateway), sem wamid
    await t.sql(`select public.concluir_envio($1, null, 'zr-1')`, [m.id]);
    const r1 = await saidaCelular(
      t,
      b.cx,
      ids(),
      msg("wamid-zr-1", { texto: "texto qualquer", id_gateway: "zr-1" }),
    );
    t.igual(r1, m.id, "casou pelo id_gateway");
    const [g] = await t.sql(`select id_externo, status::text from public.mensagens where id = $1`, [
      m.id,
    ]);
    t.igual(
      g,
      { id_externo: "wamid-zr-1", status: "enviada" },
      "ganhou o id_externo e segue enviada",
    );
    // eco sem id_gateway, chegando depois do concluir_envio (enviada, sem id_externo)
    await t.sql(
      `update public.mensagens set enviar_apos = now() - interval '1 second' where texto = 'Segunda'`,
    );
    [m] = await pegarEnvios(t);
    await t.sql(`select public.concluir_envio($1, null, null)`, [m.id]);
    const r2 = await saidaCelular(t, b.cx, ids(), msg("wamid-seg", { texto: "Segunda" }));
    t.igual(r2, m.id, "casou com a enviada");
    const [{ n }] = await t.sql(
      `select count(*)::int as n from public.mensagens where origem = 'humano_celular'`,
    );
    t.igual(n, 0, "nenhuma humano_celular");
    t.igual((await conversa(t, x.conversa)).modo, "nina", "continua com a Nina");
  });

  it("eco de mídia sem texto casa só com o mesmo tipo", async () => {
    const b = await preparar(t);
    const e = await entrada(t, b.cx, ids(), msg("w-1"));
    // atendente manda uma imagem pela tela (vai para humano, mas é nosso envio)
    const [h] = await t.como("authenticated", b.uAtend, (q) =>
      q(
        `insert into public.mensagens (conversa_id, direcao, origem, tipo, status, midia_caminho, midia_mime, midia_nome)
         values ($1, 'saida', 'humano_tela', 'imagem', 'na_fila', 'x/y', 'image/jpeg', 'foto.jpg') returning id`,
        [e.conversa_id],
      ),
    );
    const [m] = await pegarEnvios(t);
    t.igual(m.id, h.id, "imagem pega para envio");
    const outro = await saidaCelular(
      t,
      b.cx,
      ids(),
      msg("wamid-aud", { tipo: "audio", texto: null }),
    );
    t.ok(outro !== h.id, "áudio sem texto não casa com a imagem");
    const nomeErrado = await saidaCelular(
      t,
      b.cx,
      ids(),
      msg("wamid-doc", { tipo: "imagem", texto: null, midia_nome: "outra.jpg" }),
    );
    t.ok(nomeErrado !== h.id, "imagem com outro nome não casa");
    const certo = await saidaCelular(
      t,
      b.cx,
      ids(),
      msg("wamid-img", { tipo: "imagem", texto: null, midia_mime: "image/jpeg" }),
    );
    t.igual(certo, h.id, "imagem casa");
  });

  it("concluir_envio nunca falha por id_externo repetido; a duplicata do eco é apagada e o efeito dela desfeito", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await concluirRodada(t, x.rodada, ["Texto da Nina", "Segunda parte"]);
    const [m] = await pegarEnvios(t);
    // eco com texto mudado pelo gateway (formatação): não casa e entra como humano_celular
    const dup = await saidaCelular(t, b.cx, ids(), msg("wamid-dup", { texto: "*Texto* da Nina" }));
    t.ok(dup !== m.id, "duplicata gravada");
    let c = await conversa(t, x.conversa);
    t.igual(
      [c.modo, c.motivo_humano],
      ["humano", "humano_celular"],
      "a duplicata pôs a conversa no modo humano",
    );
    const [p2] = await t.sql(
      `select status::text from public.mensagens where texto = 'Segunda parte'`,
    );
    t.igual(p2.status, "cancelada", "e cancelou a 2ª parte");
    await t.sql(`select public.concluir_envio($1, 'wamid-dup', 'gw-dup')`, [m.id]);
    const ms = await t.sql(
      `select id, status::text from public.mensagens where id_externo = 'wamid-dup'`,
    );
    t.igual(ms, [{ id: m.id, status: "enviada" }], "o id ficou na nossa mensagem");
    const [{ n }] = await t.sql(`select count(*)::int as n from public.mensagens where id = $1`, [
      dup,
    ]);
    t.igual(n, 0, "duplicata apagada");
    c = await conversa(t, x.conversa);
    t.igual([c.modo, c.motivo_humano], ["nina", null], "conversa volta para a Nina");
    const [p3] = await t.sql(
      `select status::text from public.mensagens where texto = 'Segunda parte'`,
    );
    t.igual(p3.status, "na_fila", "2ª parte volta para a fila");
    // id de outra conversa: não apaga nada e não falha
    const y = await comRodada(t, b, "5511900000005");
    await concluirRodada(t, y.rodada, ["outra"]);
    const [my] = await pegarEnvios(t);
    await t.sql(`select public.concluir_envio($1, 'wamid-dup', null)`, [my.id]);
    const [r] = await t.sql(`select status::text, id_externo from public.mensagens where id = $1`, [
      my.id,
    ]);
    t.igual(r, { status: "enviada", id_externo: null }, "enviada sem id");
    const [{ k }] = await t.sql(`select count(*)::int as k from public.mensagens where id = $1`, [
      m.id,
    ]);
    t.igual(k, 1, "a outra mensagem continua");
  });

  it("duplicata do eco com humano de verdade no meio: concluir_envio não devolve para a Nina", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await concluirRodada(t, x.rodada, ["Texto da Nina", "Segunda parte"]);
    const [m] = await pegarEnvios(t);
    await saidaCelular(t, b.cx, ids(), msg("wamid-real", { texto: "respondi eu mesmo" }));
    await saidaCelular(t, b.cx, ids(), msg("wamid-dup2", { texto: "_Texto da Nina_" }));
    await t.sql(`select public.concluir_envio($1, 'wamid-dup2', null)`, [m.id]);
    const c = await conversa(t, x.conversa);
    t.igual([c.modo, c.motivo_humano], ["humano", "humano_celular"], "continua com o humano");
    const [p2] = await t.sql(
      `select status::text from public.mensagens where texto = 'Segunda parte'`,
    );
    t.igual(p2.status, "cancelada", "2ª parte continua cancelada");
  });

  it("duplicata do eco cancela a rodada rodando: concluir_envio a devolve a rodar e só revive o que a duplicata cancelou", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await concluirRodada(t, x.rodada, ["Texto da Nina", "Segunda parte"]);
    const [m] = await pegarEnvios(t);
    const e2 = await entrada(t, b.cx, ids(), msg("w-2"));
    await vencer(t, x.conversa);
    const [r2] = await pegarRodadas(t);
    t.ok(r2, "rodada 2 aberta");
    await saidaCelular(t, b.cx, ids(), msg("wamid-dup3", { texto: "*Texto* da Nina" }));
    const [r2c] = await t.sql(`select status::text from public.rodadas where id = $1`, [r2.id]);
    t.igual(r2c.status, "cancelada", "a duplicata cancelou a rodada 2");
    // lead escreve com a conversa no modo humano: fica solta
    const e3 = await entrada(t, b.cx, ids(), msg("w-3"));
    // resposta da Nina cancelada por outro motivo depois da duplicata
    await t.sql(
      `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, tipo, texto, status, status_em, rodada_id, momento)
         values ($1, $2, 'saida', 'nina', 'texto', 'Cancelada por outro motivo', 'cancelada', now(), $3, now())`,
      [x.conversa, b.cx, x.rodada],
    );
    await t.sql(`select public.concluir_envio($1, 'wamid-dup3', null)`, [m.id]);
    const c = await conversa(t, x.conversa);
    t.igual([c.modo, c.motivo_humano], ["nina", null], "conversa volta para a Nina");
    const st = await t.sql(
      `select texto, status::text from public.mensagens
          where texto in ('Segunda parte', 'Cancelada por outro motivo') order by texto`,
    );
    t.igual(
      st,
      [
        { texto: "Cancelada por outro motivo", status: "cancelada" },
        { texto: "Segunda parte", status: "na_fila" },
      ],
      "só a resposta que a duplicata cancelou volta para a fila",
    );
    const [r2v] = await t.sql(
      `select status::text, terminada_em from public.rodadas where id = $1`,
      [r2.id],
    );
    t.igual(r2v, { status: "rodando", terminada_em: null }, "rodada 2 volta a rodar");
    const ents = await t.sql(
      `select id, rodada_id from public.mensagens where id in ($1, $2) order by criado_em`,
      [e2.mensagem_id, e3.mensagem_id],
    );
    t.igual(
      ents,
      [
        { id: e2.mensagem_id, rodada_id: r2.id },
        { id: e3.mensagem_id, rodada_id: null },
      ],
      "a entrada lida pela rodada 2 é religada; a nova fica solta",
    );
    t.ok(c.responder_apos, "a entrada nova re-arma responder_apos");
    t.igual((await pegarRodadas(t)).length, 0, "com a rodada 2 rodando não abre outra");
    await concluirRodada(t, r2.id, ["Resposta 2"]);
    const [rr] = await t.sql(
      `select status::text from public.mensagens where texto = 'Resposta 2'`,
    );
    t.igual(rr.status, "na_fila", "a resposta da rodada 2 vai para a fila");
  });

  it("duplicata do eco cancela a rodada que o worker conclui antes do concluir_envio: as respostas dela voltam", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await concluirRodada(t, x.rodada, ["Texto da Nina"]);
    const [m] = await pegarEnvios(t);
    const e2 = await entrada(t, b.cx, ids(), msg("w-2"));
    await vencer(t, x.conversa);
    const [r2] = await pegarRodadas(t);
    await saidaCelular(t, b.cx, ids(), msg("wamid-dup4", { texto: "*Texto* da Nina" }));
    await concluirRodada(t, r2.id, ["Resposta 2"]);
    const [antes] = await t.sql(
      `select status::text from public.mensagens where texto = 'Resposta 2'`,
    );
    t.igual(antes.status, "cancelada", "gravada como cancelada por causa da duplicata");
    await t.sql(`select public.concluir_envio($1, 'wamid-dup4', null)`, [m.id]);
    const [depois] = await t.sql(
      `select status::text from public.mensagens where texto = 'Resposta 2'`,
    );
    t.igual(depois.status, "na_fila", "a resposta da rodada 2 volta para a fila");
    const [r2v] = await t.sql(`select status::text from public.rodadas where id = $1`, [r2.id]);
    t.igual(r2v.status, "concluida", "rodada 2 vira concluida");
    const [e] = await t.sql(`select rodada_id from public.mensagens where id = $1`, [
      e2.mensagem_id,
    ]);
    t.igual(e.rodada_id, r2.id, "entrada religada à rodada 2");
    const c = await conversa(t, x.conversa);
    t.igual([c.modo, c.responder_apos], ["nina", null], "nada pendente: não re-arma");
  });

  it("armado vencido há mais que o teto (esperou sem conexão ativa): a mensagem que chega começa um lote novo de 8 s", async () => {
    const b = await preparar(t);
    const e = await entrada(t, b.cx, ids(), msg("w-velha"));
    await t.sql(`update public.conexoes set ativa = false where id = $1`, [b.cx]);
    await t.sql(
      `update public.conversas set responder_apos = now() - interval '2 hours' where id = $1`,
      [e.conversa_id],
    );
    await t.sql(
      `update public.mensagens set criado_em = now() - interval '2 hours' where id = $1`,
      [e.mensagem_id],
    );
    t.igual((await pegarRodadas(t)).length, 0, "sem conexão ativa não abre rodada");
    t.ok((await conversa(t, e.conversa_id)).responder_apos, "continua armada");
    await t.sql(`update public.conexoes set ativa = true where id = $1`, [b.cx]);
    const e2 = await entrada(t, b.cx, ids(), msg("w-nova"));
    const [{ ok }] = await t.sql(
      `select responder_apos between now() + interval '6 seconds' and now() + interval '9 seconds' as ok
           from public.conversas where id = $1`,
      [e.conversa_id],
    );
    t.ok(ok, "responder_apos em ~8 s, não no passado");
    t.igual((await pegarRodadas(t)).length, 0, "não responde na hora");
    await vencer(t, e.conversa_id);
    const rs = await pegarRodadas(t);
    t.igual(rs.length, 1, "depois da espera, abre a rodada");
    const ms = await t.sql(
      `select count(*)::int as n from public.mensagens where rodada_id = $1 and direcao = 'entrada'`,
      [rs[0].id],
    );
    t.igual(ms[0].n, 2, "a rodada lê a antiga e a nova");
    t.igual(e2.conversa_id, e.conversa_id, "mesma conversa");
  });

  it("falha avisada pelo gateway não vira enviada no concluir_envio; tempo esgotado vira", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await concluirRodada(t, x.rodada, ["oi"]);
    const [m] = await pegarEnvios(t);
    // eco grava o id, o gateway avisa 'failed' e só depois o worker conclui
    await saidaCelular(t, b.cx, ids(), msg("wamid-ff", { texto: "oi" }));
    t.igual(
      (
        await t.sql(`select public.atualizar_status($1, 'wamid-ff', 'falhou', now()) as n`, [b.cx])
      )[0].n,
      1,
      "falhou casa",
    );
    await t.sql(`select public.concluir_envio($1, 'wamid-ff', 'gw-ff')`, [m.id]);
    const [r] = await t.sql(`select status::text, erro from public.mensagens where id = $1`, [
      m.id,
    ]);
    t.igual(r, { status: "falhou", erro: "falha_no_gateway" }, "continua falhou");
    // falha por tempo esgotado do pegar_envios: o concluir_envio que chega atrasado vale
    const y = await comRodada(t, b, "5511900000007");
    await concluirRodada(t, y.rodada, ["ola"]);
    const [my] = await pegarEnvios(t);
    await t.sql(
      `update public.mensagens set status = 'falhou', erro = 'sem_resposta_do_envio' where id = $1`,
      [my.id],
    );
    await t.sql(`select public.concluir_envio($1, 'wamid-tarde', null)`, [my.id]);
    const [r2] = await t.sql(`select status::text, erro from public.mensagens where id = $1`, [
      my.id,
    ]);
    t.igual(r2, { status: "enviada", erro: null }, "tempo esgotado vira enviada");
  });

  it("pegar_envios: enviando presa que o eco já marcou com id_externo vira enviada (não reenvia)", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await concluirRodada(t, x.rodada, ["oi"]);
    const [m] = await pegarEnvios(t);
    await saidaCelular(t, b.cx, ids(), msg("wamid-presa", { texto: "oi" }));
    await t.sql(
      `update public.mensagens set status_em = now() - interval '3 minutes' where id = $1`,
      [m.id],
    );
    t.igual((await pegarEnvios(t)).length, 0, "não reenvia");
    const [r] = await t.sql(
      `select status::text, tentativas::int from public.mensagens where id = $1`,
      [m.id],
    );
    t.igual(r, { status: "enviada", tentativas: 1 }, "enviada");
  });

  it("pegar_envios: na fila presa a conexão desativada não trava a conversa", async () => {
    const b = await preparar(t);
    const e = await entrada(t, b.cx, ids(), msg("w-1"));
    const [m1] = await t.como("authenticated", b.uAtend, (q) =>
      q(
        `insert into public.mensagens (conversa_id, direcao, origem, texto, status) values ($1, 'saida', 'humano_tela', 'pela A', 'na_fila') returning id, conexao_id`,
        [e.conversa_id],
      ),
    );
    t.igual(m1.conexao_id, b.cx, "M1 na conexão A");
    // admin troca o número: desativa A e ativa B
    await t.sql(`update public.conexoes set ativa = false where id = $1`, [b.cx]);
    t.igual((await pegarEnvios(t)).length, 0, "sem conexão ativa, nada sai e nada falha");
    const [{ st }] = await t.sql(`select status::text as st from public.mensagens where id = $1`, [
      m1.id,
    ]);
    t.igual(st, "na_fila", "sem nenhuma ativa, M1 fica (a mesma conexão pode voltar)");
    const [cb] = await t.sql(
      `insert into public.conexoes (gateway, nome, id_externo, ativa, status) values ('zapi', 'B', 'inst-teste-2', true, 'conectada') returning id`,
    );
    const [m2] = await t.como("authenticated", b.uAtend, (q) =>
      q(
        `insert into public.mensagens (conversa_id, direcao, origem, texto, status) values ($1, 'saida', 'humano_tela', 'pela B', 'na_fila') returning id, conexao_id`,
        [e.conversa_id],
      ),
    );
    t.igual(m2.conexao_id, cb.id, "M2 na conexão B");
    const env = await pegarEnvios(t);
    t.igual(
      env.map((x) => x.id),
      [m2.id],
      "M2 sai",
    );
    const [r] = await t.sql(`select status::text, erro from public.mensagens where id = $1`, [
      m1.id,
    ]);
    t.igual(r, { status: "falhou", erro: "conexao_inativa" }, "M1 falhou");
  });

  it("atualizar_status só avança e devolve quantas casaram", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await concluirRodada(t, x.rodada, ["oi"]);
    const [m] = await pegarEnvios(t);
    const st = async (id: string, s: string) =>
      (
        await t.sql(
          `select public.atualizar_status($1, $2, $3::public.mensagem_status, now()) as n`,
          [b.cx, id, s],
        )
      )[0].n;
    const atual = async () =>
      (await t.sql(`select status::text as s from public.mensagens where id = $1`, [m.id]))[0].s;
    t.igual(await st("wamid-st", "entregue"), 0, "antes do id: 0");
    await t.sql(`select public.concluir_envio($1, 'wamid-st', 'gw-st')`, [m.id]);
    // momento = hora do envio; entregue e lida não mexem nele (o dashboard mede por ele)
    await t.sql(`update public.mensagens set momento = '2026-10-10 10:00:00-03' where id = $1`, [
      m.id,
    ]);
    t.igual(await st("wamid-st", "entregue"), 1, "entregue casa");
    t.igual(await atual(), "entregue", "entregue");
    t.igual(await st("gw-st", "lida"), 1, "casa pelo id_gateway");
    t.igual(await atual(), "lida", "lida");
    t.igual(await st("wamid-st", "entregue"), 1, "entregue depois de lida casa");
    t.igual(await atual(), "lida", "não volta para entregue");
    t.igual(await st("wamid-st", "falhou"), 1, "falhou depois de lida casa");
    t.igual(await atual(), "lida", "falhou não vale depois de lida");
    t.igual(await st("nao-existe", "lida"), 0, "id desconhecido");
    const [mo] = await t.sql(
      `select momento = '2026-10-10 10:00:00-03'::timestamptz as igual from public.mensagens where id = $1`,
      [m.id],
    );
    t.igual(mo.igual, true, "momento não muda com entregue e lida");
    // falhou vale a partir de enviada
    const y = await comRodada(t, b, "5511900000006");
    await concluirRodada(t, y.rodada, ["x"]);
    const [my] = await pegarEnvios(t);
    await t.sql(`select public.concluir_envio($1, 'wamid-f', null)`, [my.id]);
    t.igual(await st("wamid-f", "falhou"), 1, "falhou casa");
    const [r] = await t.sql(`select status::text, erro from public.mensagens where id = $1`, [
      my.id,
    ]);
    t.igual([r.status, r.erro], ["falhou", "falha_no_gateway"], "enviada -> falhou");
    // status que chega antes do concluir_envio: momento = hora em que foi pega para envio
    const z = await comRodada(t, b, "5511900000008");
    await concluirRodada(t, z.rodada, ["z"]);
    const [mz] = await pegarEnvios(t);
    await saidaCelular(t, b.cx, ids("5511900000008"), msg("wamid-z", { texto: "z" }));
    await t.sql(
      `update public.mensagens set status_em = '2026-10-10 11:00:00-03', momento = '2026-10-10 10:59:00-03' where id = $1`,
      [mz.id],
    );
    t.igual(await st("wamid-z", "entregue"), 1, "entregue antes do concluir");
    const [rz] = await t.sql(
      `select status::text, momento = '2026-10-10 11:00:00-03'::timestamptz as ok from public.mensagens where id = $1`,
      [mz.id],
    );
    t.igual([rz.status, rz.ok], ["entregue", true], "momento = hora em que foi pega");
  });

  // ---------------------------------------------------------------- membro
  it("devolver_para_nina com a última do lead sem resposta arma responder_apos", async () => {
    const b = await preparar(t);
    const e = await entrada(t, b.cx, ids(), msg("w-1"));
    await t.como("authenticated", b.uAtend, (q) =>
      q(`select public.assumir_conversa($1)`, [e.conversa_id]),
    );
    let c = await conversa(t, e.conversa_id);
    t.igual(
      [c.modo, c.responsavel_id, c.responder_apos],
      ["humano", b.atendenteId, null],
      "assumida",
    );
    await entrada(t, b.cx, ids(), msg("w-2"));
    t.igual((await conversa(t, e.conversa_id)).responder_apos, null, "modo humano não arma");
    await t.como("authenticated", b.uAtend, (q) =>
      q(`select public.devolver_para_nina($1)`, [e.conversa_id]),
    );
    c = await conversa(t, e.conversa_id);
    t.igual(
      [c.modo, c.motivo_humano, c.aguardando_humano_desde],
      ["nina", null, null],
      "devolvida",
    );
    t.ok(c.devolvida_em, "devolvida_em gravada");
    t.ok(c.responder_apos && c.responder_apos <= new Date(), "responder_apos armado");
    t.igual((await pegarRodadas(t)).length, 1, "a Nina responde");
  });

  it("devolver_para_nina com a última do lead já respondida não arma", async () => {
    const b = await preparar(t);
    const e = await entrada(t, b.cx, ids(), msg("w-1"));
    await saidaCelular(t, b.cx, ids(), msg("wamid-cel", { texto: "respondido" }));
    t.igual((await conversa(t, e.conversa_id)).modo, "humano", "humano pelo celular");
    await t.como("authenticated", b.uAtend, (q) =>
      q(`select public.devolver_para_nina($1)`, [e.conversa_id]),
    );
    const c = await conversa(t, e.conversa_id);
    t.igual([c.modo, c.responder_apos], ["nina", null], "devolvida sem armar");
  });

  it("marcar_lida zera não lidas; conta sem membro recebe sem_acesso", async () => {
    const b = await preparar(t);
    const e = await entrada(t, b.cx, ids(), msg("w-1"));
    await entrada(t, b.cx, ids(), msg("w-2"));
    t.ok((await conversa(t, e.conversa_id)).nao_lidas > 0, "tem não lidas");
    await t.como("authenticated", b.uAtend, (q) =>
      q(`select public.marcar_lida($1)`, [e.conversa_id]),
    );
    t.igual((await conversa(t, e.conversa_id)).nao_lidas, 0, "zerado");
    const semMembro = await t.criarUsuario("sem-convite@exemplo.test");
    for (const f of ["marcar_lida", "assumir_conversa", "devolver_para_nina"]) {
      await t.erro(
        t.como("authenticated", semMembro, (q) => q(`select public.${f}($1)`, [e.conversa_id])),
        "sem_acesso",
      );
      await t.erro(
        t.como("anon", null, (q) => q(`select public.${f}($1)`, [e.conversa_id])),
        "permission denied",
      );
    }
    await t.erro(
      t.como("authenticated", b.uAtend, (q) => q(`select public.marcar_lida(gen_random_uuid())`)),
      "conversa_nao_encontrada",
    );
  });

  it("atendente e anon não executam as funções de serviço", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    const chamadas: [string, unknown[]][] = [
      [`select * from public.registrar_entrada($1, '[]'::jsonb, null, '{}'::jsonb)`, [b.cx]],
      [`select public.registrar_saida_celular($1, '[]'::jsonb, '{}'::jsonb)`, [b.cx]],
      [`select public.atualizar_status($1, 'x', 'lida', now())`, [b.cx]],
      [`select * from public.pegar_rodadas(1)`, []],
      [`select public.concluir_rodada($1, '[]'::jsonb, '[]'::jsonb, 1)`, [x.rodada]],
      [`select public.falhar_rodada($1, 'erro_provedor', true)`, [x.rodada]],
      [`select * from public.pegar_envios(1)`, []],
      [`select public.concluir_envio($1, 'x', null)`, [x.mensagem]],
      [`select public.falhar_envio($1, 'x', true)`, [x.mensagem]],
      [`select * from public.pegar_midias(1)`, []],
      [`select public.concluir_midia($1, null, null, null, false)`, [x.mensagem]],
      [`select public.nina_mover_etapa($1, $2)`, [x.rodada, b.permitida]],
      [`select public.nina_passar_para_humano($1)`, [x.rodada]],
      [`select public.nina_atualizar_contato($1, '{}'::jsonb)`, [x.rodada]],
      [`select public.contato_por_ids($1, '[]'::jsonb, null)`, [b.cx]],
    ];
    for (const [texto, params] of chamadas) {
      await t.erro(
        t.como("authenticated", b.uAtend, (q) => q(texto, params)),
        "permission denied",
      );
      await t.erro(
        t.como("authenticated", b.uAdmin, (q) => q(texto, params)),
        "permission denied",
      );
      await t.erro(
        t.como("anon", null, (q) => q(texto, params)),
        "permission denied",
      );
    }
    const [r] = await t.sql(`select status::text from public.rodadas where id = $1`, [x.rodada]);
    t.igual(r.status, "rodando", "nada mudou");
  });
});

describe(
  "banco: antigo 01-estrutura (gatilhos de mensagens e histórico de etapa)",
  { timeout: TEMPO_TESTE },
  () => {
    const DOM = "exemplo.test";

    // Monta: admin (1ª conta), atendente convidado, etapas próprias de teste (ordem negativa,
    // para serem as primeiras mesmo com as etapas do 02), conexão ativa, contato e conversa.
    async function montar(t: Banco, { gateway = "zapi" } = {}) {
      const uAdmin = await t.criarUsuario(`admin@${DOM}`, "Admin Teste");
      const [admin] = await t.sql("select id from public.membros where user_id = $1", [uAdmin]);
      const uAt = await t.criarUsuario(`atendente@${DOM}`, "Atendente Teste");
      const [at] = await t.sql(
        `insert into public.membros (user_id, nome, email, papel, convidado_por)
       values ($1, 'Atendente Teste', $2, 'atendente', $3) returning id`,
        [uAt, `atendente@${DOM}`, admin.id],
      );
      await t.sql("insert into public.configuracao (id) values (1) on conflict (id) do nothing");
      const [e1] = await t.sql(
        `insert into public.etapas (nome, ordem, tipo) values ('Entrada teste', -1000, 'aberta') returning id`,
      );
      const [e2] = await t.sql(
        `insert into public.etapas (nome, ordem, tipo, nina_pode_mover) values ('Seguinte teste', -999, 'aberta', true) returning id`,
      );
      const [cx] = await t.sql(
        `insert into public.conexoes (gateway, nome, id_externo, ativa, status)
       values ($1, 'Conexão teste', 'inst-teste', true, 'conectada') returning id`,
        [gateway],
      );
      const [contato] = await t.sql(
        `insert into public.contatos (nome, telefone) values ('Lead Teste', '5511900000001') returning id, etapa_id`,
      );
      const [conv] = await t.sql(
        "insert into public.conversas (contato_id, conexao_id) values ($1, $2) returning id",
        [contato.id, cx.id],
      );
      return {
        uAdmin,
        admin: admin.id,
        uAt,
        at: at.id,
        e1: e1.id,
        e2: e2.id,
        cx: cx.id,
        contato: contato.id,
        contatoEtapa: contato.etapa_id,
        conv: conv.id,
      };
    }

    type Montado = Awaited<ReturnType<typeof montar>>;

    async function entrada(t: Banco, s: Montado, idExterno: string, extra = "") {
      return t.sql(
        `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, tipo, texto, id_externo, status)
       values ($1, $2, 'entrada', 'lead', 'texto', 'oi', $3, 'recebida') ${extra} returning id`,
        [s.conv, s.cx, idExterno],
      );
    }

    async function rodada(t: Banco, s: Montado) {
      const [r] = await t.sql("insert into public.rodadas (conversa_id) values ($1) returning id", [
        s.conv,
      ]);
      return r.id;
    }

    async function humanoTela(q: Consulta, conv: string, extra: Record<string, unknown> = {}) {
      const cols = ["conversa_id", "direcao", "origem", "texto", "status"];
      const vals: unknown[] = [conv, "saida", "humano_tela", "olá pela tela", "na_fila"];
      for (const [k, v] of Object.entries(extra)) {
        const i = cols.indexOf(k);
        if (i >= 0) vals[i] = v;
        else {
          cols.push(k);
          vals.push(v);
        }
      }
      const ph = vals.map((_, i) => `$${i + 1}`).join(", ");
      return q(
        `insert into public.mensagens (${cols.join(", ")}) values (${ph}) returning id, autor_membro_id, conexao_id, enviar_apos`,
        vals,
      );
    }

    beforeEach(concluirOnboarding);

    it("mensagem duplicada entra 1 vez", async () => {
      const s = await montar(t);
      await entrada(t, s, "wamid.dup", "on conflict do nothing");
      const seg = await entrada(t, s, "wamid.dup", "on conflict do nothing");
      t.igual(seg.length, 0, "segunda não entra");
      await t.erro(entrada(t, s, "wamid.dup"), "23505");
      const [n] = await t.sql(
        `select count(*)::int as n from public.mensagens where id_externo = 'wamid.dup'`,
      );
      t.igual(n.n, 1);
      const [c] = await t.sql("select nao_lidas from public.conversas where id = $1", [s.conv]);
      t.igual(c.nao_lidas, 1, "não lidas conta 1");
      // id_externo nulo não colide
      await t.sql(
        `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, texto, status) values ($1, $2, 'entrada', 'lead', 'a', 'recebida')`,
        [s.conv, s.cx],
      );
      await t.sql(
        `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, texto, status) values ($1, $2, 'entrada', 'lead', 'b', 'recebida')`,
        [s.conv, s.cx],
      );
    });

    it("entrada arma responder_apos (8 s, teto de 60 s), prévia e janela", async () => {
      const s = await montar(t);
      await entrada(t, s, "wamid.1");
      const [c] = await t.sql(
        `select responder_apos > now() + interval '7 seconds' and responder_apos <= now() + interval '8 seconds' as ok8,
                ultima_mensagem_preview, ultima_do_lead_em is not null as janela, nao_lidas
         from public.conversas where id = $1`,
        [s.conv],
      );
      t.igual(c.ok8, true, "responder_apos = agora + 8 s");
      t.igual(c.ultima_mensagem_preview, "oi");
      t.igual(c.janela, true);
      // 1ª pendente há 58 s (e armada naquela hora): o teto (60 s) manda
      await t.sql(
        `update public.mensagens set criado_em = now() - interval '58 seconds' where id_externo = 'wamid.1'`,
      );
      await t.sql(
        `update public.conversas set responder_apos = now() - interval '50 seconds' where id = $1`,
        [s.conv],
      );
      await entrada(t, s, "wamid.2");
      const [c2] = await t.sql(
        `select responder_apos <= now() + interval '3 seconds' as teto from public.conversas where id = $1`,
        [s.conv],
      );
      t.igual(c2.teto, true, "teto de 60 s desde a 1ª pendente");
      // mídia sem texto vira prévia com o tipo e entra pendente
      await t.sql(
        `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, tipo, midia_ref_externa, status)
         values ($1, $2, 'entrada', 'lead', 'audio', 'ref-1', 'recebida')`,
        [s.conv, s.cx],
      );
      const [c3] = await t.sql(
        "select ultima_mensagem_preview from public.conversas where id = $1",
        [s.conv],
      );
      t.igual(c3.ultima_mensagem_preview, "[audio]");
      const [m] = await t.sql(
        `select midia_status from public.mensagens where midia_ref_externa = 'ref-1'`,
      );
      t.igual(m.midia_status, "pendente");
      // em modo humano, não arma
      await t.sql(
        `update public.conversas set modo = 'humano', responder_apos = null where id = $1`,
        [s.conv],
      );
      await entrada(t, s, "wamid.3");
      const [c4] = await t.sql("select responder_apos from public.conversas where id = $1", [
        s.conv,
      ]);
      t.igual(c4.responder_apos, null, "modo humano não arma a Nina");
    });

    it("entrada solta antiga (modo humano) não puxa o teto: a nova arma 8 s", async () => {
      const s = await montar(t);
      // lead escreveu ontem no modo humano: a entrada ficou solta (sem rodada)
      await t.sql(`update public.conversas set modo = 'humano' where id = $1`, [s.conv]);
      await entrada(t, s, "wamid.ontem");
      await t.sql(
        `update public.mensagens set criado_em = now() - interval '1 day' where id_externo = 'wamid.ontem'`,
      );
      // devolvida sem armar (a última do lead já tinha resposta)
      await t.sql(
        `update public.conversas set modo = 'nina', responder_apos = null where id = $1`,
        [s.conv],
      );
      await entrada(t, s, "wamid.hoje");
      const [c] = await t.sql(
        `select responder_apos > now() + interval '7 seconds' and responder_apos <= now() + interval '8 seconds' as ok
           from public.conversas where id = $1`,
        [s.conv],
      );
      t.igual(c.ok, true, "responder_apos = agora + 8 s");
      // a 2ª da rajada recomeça os 8 s (o teto conta desde a de hoje)
      await entrada(t, s, "wamid.hoje2");
      const [c2] = await t.sql(
        `select responder_apos > now() + interval '7 seconds' as ok from public.conversas where id = $1`,
        [s.conv],
      );
      t.igual(c2.ok, true, "rajada continua esperando");
      // depois de uma rodada, entradas soltas antes dela não contam
      const rd = await rodada(t, s);
      await t.sql(
        `update public.rodadas set iniciada_em = now() - interval '10 minutes', status = 'falhou' where id = $1`,
        [rd],
      );
      await t.sql(
        `update public.mensagens set criado_em = now() - interval '11 minutes' where id_externo in ('wamid.hoje', 'wamid.hoje2')`,
      );
      await t.sql(
        `update public.conversas set responder_apos = now() - interval '9 minutes' where id = $1`,
        [s.conv],
      );
      await entrada(t, s, "wamid.depois");
      const [c3] = await t.sql(
        `select responder_apos > now() + interval '7 seconds' and responder_apos <= now() + interval '8 seconds' as ok
           from public.conversas where id = $1`,
        [s.conv],
      );
      t.igual(c3.ok, true, "só conta o que chegou depois da última rodada");
    });

    it("re-armado da falha passageira (+30 s) não é encurtado por mensagem nova do lead", async () => {
      const s = await montar(t);
      await entrada(t, s, "wamid.f1");
      const rd = await rodada(t, s);
      await t.sql(
        `update public.rodadas set status = 'falhou', terminada_em = now() where id = $1`,
        [rd],
      );
      await t.sql(
        `update public.mensagens set criado_em = now() - interval '5 minutes' where id_externo = 'wamid.f1'`,
      );
      await t.sql(
        `update public.rodadas set iniciada_em = now() - interval '4 minutes' where id = $1`,
        [rd],
      );
      await t.sql(
        `update public.conversas set responder_apos = now() + interval '30 seconds' where id = $1`,
        [s.conv],
      );
      await entrada(t, s, "wamid.f2");
      const [c] = await t.sql(
        `select responder_apos > now() + interval '25 seconds' as ok from public.conversas where id = $1`,
        [s.conv],
      );
      t.igual(c.ok, true, "continua em ~30 s");
    });

    it("mensagem humana cancela a rodada que está rodando e solta as entradas", async () => {
      const s = await montar(t);
      const [e] = await entrada(t, s, "wamid.r1");
      const rd = await rodada(t, s);
      await t.sql("update public.mensagens set rodada_id = $1 where id = $2", [rd, e.id]);
      await t.como("authenticated", s.uAt, (q) => humanoTela(q, s.conv));
      const [r] = await t.sql(
        "select status, terminada_em is not null as fim from public.rodadas where id = $1",
        [rd],
      );
      t.igual([r.status, r.fim], ["cancelada", true], "rodada cancelada");
      const [m] = await t.sql("select rodada_id from public.mensagens where id = $1", [e.id]);
      t.igual(m.rodada_id, null, "entrada solta");
      // humano_celular também
      await t.sql(`update public.conversas set modo = 'nina' where id = $1`, [s.conv]);
      const rd2 = await rodada(t, s);
      await t.sql(
        `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, texto, status) values ($1, $2, 'saida', 'humano_celular', 'cel', 'enviada')`,
        [s.conv, s.cx],
      );
      const [r2] = await t.sql("select status from public.rodadas where id = $1", [rd2]);
      t.igual(r2.status, "cancelada", "humano_celular cancela");
    });

    it("humano_tela muda o modo e cancela a fila da Nina", async () => {
      const s = await montar(t);
      await entrada(t, s, "wamid.h1");
      const rd = await rodada(t, s);
      const [nina] = await t.sql(
        `insert into public.mensagens (conversa_id, direcao, origem, texto, status, rodada_id, ordem)
         values ($1, 'saida', 'nina', 'resposta da Nina', 'na_fila', $2, 1) returning id, conexao_id`,
        [s.conv, rd],
      );
      t.igual(nina.conexao_id, s.cx, "saída usa a conexão ativa");
      await t.sql(`update public.conversas set aguardando_humano_desde = now() where id = $1`, [
        s.conv,
      ]);
      const [h] = await t.como("authenticated", s.uAt, (q) => humanoTela(q, s.conv));
      t.igual(h.autor_membro_id, s.at, "autor preenchido com o próprio membro");
      t.igual(h.conexao_id, s.cx);
      t.ok(h.enviar_apos, "enviar_apos preenchido");
      const [c] = await t.sql(
        "select modo, motivo_humano, responsavel_id, aguardando_humano_desde, responder_apos, ultima_mensagem_preview from public.conversas where id = $1",
        [s.conv],
      );
      t.igual(c.modo, "humano");
      t.igual(c.motivo_humano, "humano_tela");
      t.igual(c.responsavel_id, s.at);
      t.igual(c.aguardando_humano_desde, null);
      t.igual(c.responder_apos, null);
      t.igual(c.ultima_mensagem_preview, "olá pela tela");
      const [n] = await t.sql("select status from public.mensagens where id = $1", [nina.id]);
      t.igual(n.status, "cancelada", "fila da Nina cancelada");
    });

    it("humano_celular passa para humano sem responsável e sem checar janela", async () => {
      const s = await montar(t, { gateway: "meta" });
      await t.sql(
        `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, texto, status, id_externo)
         values ($1, $2, 'saida', 'humano_celular', 'pelo celular', 'enviada', 'wamid.cel')`,
        [s.conv, s.cx],
      );
      const [c] = await t.sql(
        "select modo, motivo_humano, responsavel_id from public.conversas where id = $1",
        [s.conv],
      );
      t.igual(c.modo, "humano");
      t.igual(c.motivo_humano, "humano_celular");
      t.igual(c.responsavel_id, null);
    });

    it("membro insere humano_tela só como ele mesmo", async () => {
      const s = await montar(t);
      await t.erro(
        t.como("authenticated", s.uAt, (q) => humanoTela(q, s.conv, { autor_membro_id: s.admin })),
        "row-level security",
      );
      const rd = await rodada(t, s);
      await t.erro(
        t.como("authenticated", s.uAt, (q) =>
          humanoTela(q, s.conv, { origem: "nina", rodada_id: rd }),
        ),
        "permission denied",
      );
      await t.erro(
        t.como("authenticated", s.uAt, (q) => humanoTela(q, s.conv, { status: "enviada" })),
        "row-level security",
      );
      await t.erro(
        t.como("authenticated", s.uAt, (q) => humanoTela(q, s.conv, { id_externo: "forjado" })),
        "permission denied",
      );
      const [ok] = await t.como("authenticated", s.uAt, (q) =>
        humanoTela(q, s.conv, { autor_membro_id: s.at }),
      );
      t.igual(ok.autor_membro_id, s.at);
      // conta sem membro não insere
      const u = await t.criarUsuario(`intruso@${DOM}`);
      await t.erro(
        t.como("authenticated", u, (q) => humanoTela(q, s.conv)),
        "row-level security",
      );
    });

    it("janela_fechada nos oficiais (menos humano_celular)", async () => {
      const s = await montar(t, { gateway: "meta" });
      await t.erro(
        t.como("authenticated", s.uAt, (q) => humanoTela(q, s.conv)),
        "janela_fechada",
      );
      await t.sql(
        `update public.conversas set ultima_do_lead_em = now() - interval '25 hours' where id = $1`,
        [s.conv],
      );
      await t.erro(
        t.como("authenticated", s.uAt, (q) => humanoTela(q, s.conv)),
        "janela_fechada",
      );
      const rd = await rodada(t, s);
      await t.erro(
        t.sql(
          `insert into public.mensagens (conversa_id, direcao, origem, texto, status, rodada_id) values ($1, 'saida', 'nina', 'x', 'na_fila', $2)`,
          [s.conv, rd],
        ),
        "janela_fechada",
      );
      await t.sql(
        `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, texto, status) values ($1, $2, 'saida', 'humano_celular', 'cel', 'enviada')`,
        [s.conv, s.cx],
      );
      // lead escreveu agora: abre a janela
      await t.sql(`update public.conversas set modo = 'nina' where id = $1`, [s.conv]);
      await entrada(t, s, "wamid.abre");
      const [h] = await t.como("authenticated", s.uAt, (q) => humanoTela(q, s.conv));
      t.ok(h.id, "com a janela aberta, envia");
      const [o] = await t.sql(`select oficial from public.conexoes where id = $1`, [s.cx]);
      t.igual(o.oficial, true, "meta é oficial");
      // não oficial não tem janela: zapi ativa, lead calado há 25 h (e depois nunca), envia
      await t.sql("update public.conexoes set ativa = false where id = $1", [s.cx]);
      const [z] = await t.sql(
        `insert into public.conexoes (gateway, nome, id_externo, ativa, status) values ('zapi', 'Zapi teste', 'inst-z', true, 'conectada') returning id, oficial`,
      );
      t.igual(z.oficial, false, "zapi não é oficial");
      await t.sql(
        `update public.conversas set ultima_do_lead_em = now() - interval '25 hours' where id = $1`,
        [s.conv],
      );
      const [h2] = await t.como("authenticated", s.uAt, (q) => humanoTela(q, s.conv));
      t.igual(h2.conexao_id, z.id, "sai pela zapi sem janela_fechada");
      await t.sql(`update public.conversas set ultima_do_lead_em = null where id = $1`, [s.conv]);
      const [h3] = await t.como("authenticated", s.uAt, (q) => humanoTela(q, s.conv));
      t.ok(h3.id, "sem nenhuma mensagem do lead também envia");
    });

    it("sem_conexao_ativa na saída", async () => {
      const s = await montar(t);
      await t.sql("update public.conexoes set ativa = false where id = $1", [s.cx]);
      await t.erro(
        t.como("authenticated", s.uAt, (q) => humanoTela(q, s.conv)),
        "sem_conexao_ativa",
      );
    });

    it("histórico de etapa grava o ator (sistema, membro, nina)", async () => {
      const s = await montar(t);
      const h0 = await t.sql(
        "select de_etapa_id, para_etapa_id, ator from public.contato_etapa_historico where contato_id = $1",
        [s.contato],
      );
      t.igual(h0.length, 1);
      t.igual(h0[0].ator, "sistema");
      t.igual(h0[0].de_etapa_id, null);
      t.igual(h0[0].para_etapa_id, s.e1);

      await t.sql(
        `update public.contatos set etapa_desde = now() - interval '1 day' where id = $1`,
        [s.contato],
      );
      await t.como("authenticated", s.uAt, (q) =>
        q("update public.contatos set etapa_id = $1 where id = $2", [s.e2, s.contato]),
      );
      const [h1] = await t.sql(
        `select de_etapa_id, para_etapa_id, ator, membro_id from public.contato_etapa_historico
         where contato_id = $1 and ator = 'membro'`,
        [s.contato],
      );
      t.igual(h1.membro_id, s.at);
      t.igual(h1.de_etapa_id, s.e1);
      t.igual(h1.para_etapa_id, s.e2);
      const [c] = await t.sql(
        `select etapa_desde > now() - interval '1 minute' as novo from public.contatos where id = $1`,
        [s.contato],
      );
      t.igual(c.novo, true, "etapa_desde atualizada");

      const rd = await rodada(t, s);
      await t.sql(
        `begin; select set_config('nina.rodada_id', '${rd}', true);
         update public.contatos set etapa_id = '${s.e1}' where id = '${s.contato}'; commit;`,
      );
      const [h2] = await t.sql(
        `select ator, rodada_id, membro_id from public.contato_etapa_historico where contato_id = $1 and ator = 'nina'`,
        [s.contato],
      );
      t.igual(h2.rodada_id, rd);
      t.igual(h2.membro_id, null);

      // fora da transação da Nina e sem login: sistema
      await t.sql("update public.contatos set etapa_id = $1 where id = $2", [s.e2, s.contato]);
      const r = await t.sql(
        "select ator from public.contato_etapa_historico where contato_id = $1 order by criado_em, ator",
        [s.contato],
      );
      t.igual(r.length, 4);
      t.igual(r.filter((x) => x.ator === "sistema").length, 2);
      // mudar outra coluna não grava histórico
      await t.sql(`update public.contatos set nome = 'Outro nome' where id = $1`, [s.contato]);
      const [n] = await t.sql(
        "select count(*)::int as n from public.contato_etapa_historico where contato_id = $1",
        [s.contato],
      );
      t.igual(n.n, 4);
      // membro não escreve no histórico direto
      await t.erro(
        t.como("authenticated", s.uAdmin, (q) =>
          q(
            `insert into public.contato_etapa_historico (contato_id, para_etapa_id, ator) values ($1, $2, 'membro')`,
            [s.contato, s.e1],
          ),
        ),
        "permission denied",
      );
    });
  },
);
