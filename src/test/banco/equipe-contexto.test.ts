// @vitest-environment node
// Equipe, Contexto e onboarding (migration 0009, com o contexto_salvar recriado na 0017):
// desativar_membro, trocar_papel_membro, reativar_membro, contexto_salvar, contexto_restaurar
// e concluir_onboarding. Porte do 33-equipe-contexto do banco2.
import { describe, it } from "vitest";
import {
  montarBase,
  TEMPO_TESTE,
  usarBanco,
  type Banco,
  type Consulta,
  type Linha,
} from "./montar";

// ---------------------------------------------------------------------------
// ajudantes
// ---------------------------------------------------------------------------

// 1ª conta vira admin pelo gatilho; as outras recebem membro direto (como o servidor faz).
async function equipe(t: Banco) {
  const uAdmin = await t.criarUsuario("admin@empresa.exemplo", "Admin");
  const uAdmin2 = await t.criarUsuario("admin2@empresa.exemplo", "Admin Dois");
  const uAtend = await t.criarUsuario("atendente@empresa.exemplo", "Atendente");
  const uFora = await t.criarUsuario("fora@empresa.exemplo", "Sem convite");
  const [{ id: mAdmin }] = await t.sql("select id from public.membros where user_id = $1", [
    uAdmin,
  ]);
  const [{ id: mAdmin2 }] = await t.sql(
    `insert into public.membros (user_id, nome, email, papel) values ($1, 'Admin Dois', 'admin2@empresa.exemplo', 'admin') returning id`,
    [uAdmin2],
  );
  const [{ id: mAtend }] = await t.sql(
    `insert into public.membros (user_id, nome, email, papel) values ($1, 'Atendente', 'atendente@empresa.exemplo', 'atendente') returning id`,
    [uAtend],
  );
  return { uAdmin, uAdmin2, uAtend, uFora, mAdmin, mAdmin2, mAtend };
}

async function conexao(t: Banco) {
  const [{ id }] = await t.sql(
    `insert into public.conexoes (gateway, nome, id_externo, status, ativa) values ('zapi', 'Teste', 'inst-1', 'conectada', true) returning id`,
  );
  return id;
}

// Conversa de um lead na etapa (chave da 0001), com o responsável e o modo dados.
async function conversaNaEtapa(
  t: Banco,
  chaveEtapa: string,
  responsavel: string | null,
  cx: string | null = null,
) {
  const [{ id: contato }] = await t.sql(
    `insert into public.contatos (nome, etapa_id) values ($1, (select id from public.etapas where chave = $2)) returning id`,
    [`Lead ${chaveEtapa}`, chaveEtapa],
  );
  const [{ id }] = await t.sql(
    `insert into public.conversas (contato_id, conexao_id, modo, responsavel_id, motivo_humano)
     values ($1, $2, $3, $4, $5) returning id`,
    [contato, cx, responsavel ? "humano" : "nina", responsavel, responsavel ? "humano_tela" : null],
  );
  return id;
}

const NOVO_UUID = () => crypto.randomUUID();

// Chama como o usuário (authenticated) e devolve as linhas.
async function comoUsuario(t: Banco, uid: string, texto: string, params?: unknown[]) {
  return t.como("authenticated", uid, (q) => q(texto, params));
}

// Simula outro admin que, ao mesmo tempo, desativou quem está chamando: um gatilho só de
// teste (dispara antes do membros_ultimo_admin, pela ordem do nome) desativa o chamador no
// meio do UPDATE do alvo. É o que acontece quando dois admins se desativam juntos: o 2º
// UPDATE espera a trava do gatilho e vê o 1º já gravado.
async function simularOutroAdminSaindo(t: Banco, alvo: string, chamador: string) {
  await t.sql(`
    create function public.zz_teste_simula_saida() returns trigger
    language plpgsql security definer set search_path = '' as $f$
    begin
      if pg_trigger_depth() = 1 and new.id = '${alvo}'::uuid then
        update public.membros set ativo = false where id = '${chamador}'::uuid;
      end if;
      return new;
    end;
    $f$;
    create trigger a_teste_simula_saida before update on public.membros
      for each row execute function public.zz_teste_simula_saida();
  `);
}

async function contarAuditoria(t: Banco, acao: string) {
  return (await t.sql(`select count(*)::int as n from public.auditoria where acao = $1`, [acao]))[0]
    .n;
}

async function versoes(t: Banco) {
  return t.sql(
    `select id::int, numero, origem::text, restaurada_de::int, preco, tom_voz, objecoes, itens, criado_por
       from public.contexto_versoes order by numero`,
  );
}

const SALVAR = "select public.contexto_salvar($1, $2::jsonb) as r";

// ---------------------------------------------------------------------------
// testes
// ---------------------------------------------------------------------------

const base = await montarBase();
const t = usarBanco(base);

describe("banco: equipe e contexto (0009)", { timeout: TEMPO_TESTE }, () => {
  // ------------------------------------------------------------- permissões
  it("permissões: anon não executa nenhuma; authenticated e service_role executam", async () => {
    const funcoes = [
      "public.desativar_membro(uuid)",
      "public.trocar_papel_membro(uuid, public.papel_membro)",
      "public.reativar_membro(uuid)",
      "public.contexto_salvar(bigint, jsonb, public.contexto_origem)",
      "public.contexto_restaurar(bigint)",
      "public.concluir_onboarding()",
    ];
    for (const f of funcoes) {
      const [r] = await t.sql(
        `select has_function_privilege('anon', $1, 'execute') as anon,
                has_function_privilege('authenticated', $1, 'execute') as aut,
                has_function_privilege('service_role', $1, 'execute') as srv`,
        [f],
      );
      t.igual(r, { anon: false, aut: true, srv: true }, f);
    }
    const [g] = await t.sql(
      `select has_function_privilege('authenticated', 'public.tg_contexto_numerar()', 'execute') as aut,
              has_function_privilege('service_role', 'public.tg_contexto_numerar()', 'execute') as srv`,
    );
    t.igual(g, { aut: false, srv: false }, "função do gatilho: ninguém chama direto");
    const { mAtend } = await equipe(t);
    await t.como("anon", null, async (q) => {
      await t.erro(q("select public.desativar_membro($1)", [mAtend]), "permission denied");
      await t.erro(
        q(`select public.trocar_papel_membro($1, 'admin')`, [mAtend]),
        "permission denied",
      );
      await t.erro(q("select public.reativar_membro($1)", [mAtend]), "permission denied");
      await t.erro(q(SALVAR, [null, '{"preco":"x"}']), "permission denied");
      await t.erro(q("select public.contexto_restaurar(1)"), "permission denied");
      await t.erro(q("select public.concluir_onboarding()"), "permission denied");
    });
  });

  it("permissões: atendente, conta sem membro, admin desativado e service_role recebem sem_acesso em todas", async () => {
    const { uAtend, uFora, uAdmin2, mAdmin, mAdmin2, mAtend } = await equipe(t);
    // uma versão para o restaurar ter alvo
    await t.sql(`insert into public.contexto_versoes (preco) values ('100')`);
    await t.sql(`update public.membros set ativo = false where id = $1`, [mAdmin2]);
    const chamadas = (q: Consulta) => [
      q("select public.desativar_membro($1)", [mAtend]),
      q(`select public.trocar_papel_membro($1, 'admin')`, [mAtend]),
      q("select public.reativar_membro($1)", [mAdmin2]),
      q(SALVAR, [1, '{"preco":"200"}']),
      q("select public.contexto_restaurar(1)"),
      q("select public.concluir_onboarding()"),
    ];
    for (const uid of [uAtend, uFora, uAdmin2]) {
      await t.como("authenticated", uid, async (q) => {
        for (const p of chamadas(q)) await t.erro(p, "sem_acesso");
      });
    }
    await t.como("service_role", null, async (q) => {
      for (const p of chamadas(q)) await t.erro(p, "sem_acesso");
    });
    // nada mudou
    const m = await t.sql(
      `select id, papel::text, ativo from public.membros where id = any($1) order by nome`,
      [[mAdmin, mAdmin2, mAtend]],
    );
    t.igual(
      m.map((x) => [x.papel, x.ativo]),
      [
        ["admin", true],
        ["admin", false],
        ["atendente", true],
      ],
      "membros iguais",
    );
    t.igual(
      (await t.sql("select count(*)::int as n from public.contexto_versoes"))[0].n,
      1,
      "versões iguais",
    );
    t.igual(
      (await t.sql("select onboarding_concluido_em from public.configuracao"))[0]
        .onboarding_concluido_em,
      null,
      "onboarding igual",
    );
    t.igual(
      (await t.sql("select count(*)::int as n from public.auditoria"))[0].n,
      0,
      "sem auditoria",
    );
  });

  // ------------------------------------------------------------- desativar
  it("desativar: devolve TODAS as conversas da pessoa (aberta, Ganho e Perdido), com evento, auditoria e os ids", async () => {
    const { uAdmin, mAdmin, mAtend } = await equipe(t);
    const cx = await conexao(t);
    const cAberta = await conversaNaEtapa(t, "em_negociacao", mAtend, cx);
    const cGanho = await conversaNaEtapa(t, "ganho", mAtend, cx);
    const cPerdido = await conversaNaEtapa(t, "perdido", mAtend, cx);
    const cDoAdmin = await conversaNaEtapa(t, "novo", mAdmin, cx);
    const cNina = await conversaNaEtapa(t, "novo", null, cx);
    // mensagem que a pessoa deixou na fila (decisão 15: vai para o lead)
    const [{ id: msg }] = await t.sql(
      `insert into public.mensagens (conversa_id, direcao, origem, status, texto, autor_membro_id)
       values ($1, 'saida', 'humano_tela', 'na_fila', 'já te respondo', $2) returning id`,
      [cAberta, mAtend],
    );
    await t.sql(
      `update public.conversas set modo = 'humano', responsavel_id = $2, aguardando_humano_desde = null where id = $1`,
      [cAberta, mAtend],
    );

    const antes = Date.now();
    const [{ ids }] = await comoUsuario(t, uAdmin, "select public.desativar_membro($1) as ids", [
      mAtend,
    ]);
    t.igual([...ids].sort(), [cAberta, cGanho, cPerdido].sort(), "devolve as 3 conversas");

    t.igual(
      (await t.sql("select ativo from public.membros where id = $1", [mAtend]))[0].ativo,
      false,
      "desativada",
    );
    const cv = await t.sql(
      `select id, modo::text, responsavel_id, aguardando_humano_desde from public.conversas where id = any($1)`,
      [[cAberta, cGanho, cPerdido]],
    );
    for (const c of cv) {
      t.igual(c.responsavel_id, null, `sem responsável (${c.id})`);
      t.igual(c.modo, "humano", "continua com a equipe");
      t.ok(
        c.aguardando_humano_desde && c.aguardando_humano_desde.getTime() >= antes - 5000,
        "aguardando desde agora",
      );
    }
    const outras = await t.sql(
      `select id, responsavel_id, aguardando_humano_desde from public.conversas where id = any($1) order by id`,
      [[cDoAdmin, cNina]],
    );
    t.igual(
      outras.map((c) => [c.id, c.responsavel_id, c.aguardando_humano_desde]),
      [
        [cDoAdmin, mAdmin, null],
        [cNina, null, null],
      ].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
      "as conversas de outros não mudam",
    );

    const ev = await t.sql(
      `select conversa_id, tipo::text, de, de_membro_id, membro_id from public.conversa_eventos
        where tipo = 'voltou_para_fila' order by conversa_id`,
    );
    t.igual(
      ev,
      [cAberta, cGanho, cPerdido].sort().map((id) => ({
        conversa_id: id,
        tipo: "voltou_para_fila",
        de: "outro",
        de_membro_id: mAtend,
        membro_id: null,
      })),
      "um evento voltou_para_fila por conversa",
    );

    const au = await t.sql(
      `select ator_membro_id, acao::text, alvo, detalhe from public.auditoria`,
    );
    t.igual(
      au,
      [
        {
          ator_membro_id: mAdmin,
          acao: "membro_desativado",
          alvo: mAtend,
          detalhe: { nome: "Atendente", conversas_devolvidas: 3 },
        },
      ],
      "auditoria",
    );

    t.igual(
      (await t.sql("select status::text from public.mensagens where id = $1", [msg]))[0].status,
      "na_fila",
      "a mensagem pendente continua na fila",
    );

    // de novo: já desativada e sem conversas -> vazio, sem nova auditoria
    const [{ ids: ids2 }] = await comoUsuario(
      t,
      uAdmin,
      "select public.desativar_membro($1) as ids",
      [mAtend],
    );
    t.igual(ids2, [], "repetir devolve vazio");
    t.igual(await contarAuditoria(t, "membro_desativado"), 1, "sem auditoria nova");
  });

  it("desativar: proprio_membro, nao_encontrado e sem conversas devolve vazio", async () => {
    const { uAdmin, mAdmin, mAdmin2 } = await equipe(t);
    await t.como("authenticated", uAdmin, async (q) => {
      await t.erro(q("select public.desativar_membro($1)", [mAdmin]), "proprio_membro");
      await t.erro(q("select public.desativar_membro($1)", [NOVO_UUID()]), "nao_encontrado");
      const [{ ids }] = await q("select public.desativar_membro($1) as ids", [mAdmin2]);
      t.igual(ids, [], "admin sem conversas: vazio");
    });
    t.igual(
      (await t.sql("select ativo from public.membros where id = $1", [mAdmin]))[0].ativo,
      true,
      "o próprio continua ativo",
    );
    t.igual(
      (await t.sql("select ativo from public.membros where id = $1", [mAdmin2]))[0].ativo,
      false,
      "o outro admin saiu",
    );
    t.igual(await contarAuditoria(t, "membro_desativado"), 1, "auditoria do outro admin");
  });

  it("desativar: ultimo_admin (outro admin saiu ao mesmo tempo) e nada muda", async () => {
    const { uAdmin, mAdmin, mAdmin2 } = await equipe(t);
    const cx = await conexao(t);
    const c = await conversaNaEtapa(t, "ganho", mAdmin2, cx);
    await simularOutroAdminSaindo(t, mAdmin2, mAdmin);
    await t.como("authenticated", uAdmin, async (q) => {
      await t.erro(q("select public.desativar_membro($1)", [mAdmin2]), "ultimo_admin");
    });
    const m = await t.sql(`select id, ativo from public.membros where id = any($1)`, [
      [mAdmin, mAdmin2],
    ]);
    t.ok(
      m.every((x) => x.ativo),
      "os dois admins continuam ativos",
    );
    t.igual(
      (await t.sql("select responsavel_id from public.conversas where id = $1", [c]))[0]
        .responsavel_id,
      mAdmin2,
      "conversa continua com a pessoa",
    );
    t.igual(
      (await t.sql("select count(*)::int as n from public.conversa_eventos"))[0].n,
      0,
      "sem evento",
    );
    t.igual(
      (await t.sql("select count(*)::int as n from public.auditoria"))[0].n,
      0,
      "sem auditoria",
    );
  });

  // ------------------------------------------------------------- trocar papel
  it("trocar papel: troca, audita, mesmo papel não muda nada; proprio_membro e nao_encontrado", async () => {
    const { uAdmin, mAdmin, mAtend } = await equipe(t);
    await t.como("authenticated", uAdmin, async (q) => {
      await t.erro(
        q(`select public.trocar_papel_membro($1, 'atendente')`, [mAdmin]),
        "proprio_membro",
      );
      await t.erro(q(`select public.trocar_papel_membro($1, 'admin')`, [mAdmin]), "proprio_membro");
      await t.erro(
        q(`select public.trocar_papel_membro($1, 'admin')`, [NOVO_UUID()]),
        "nao_encontrado",
      );
      await q(`select public.trocar_papel_membro($1, 'admin')`, [mAtend]);
      await q(`select public.trocar_papel_membro($1, 'admin')`, [mAtend]); // de novo: nada
    });
    t.igual(
      (await t.sql("select papel::text from public.membros where id = $1", [mAtend]))[0].papel,
      "admin",
      "virou admin",
    );
    t.igual(
      (await t.sql("select papel::text from public.membros where id = $1", [mAdmin]))[0].papel,
      "admin",
      "o próprio não muda",
    );
    const au = await t.sql(
      `select ator_membro_id, acao::text, alvo, detalhe from public.auditoria`,
    );
    t.igual(
      au,
      [
        {
          ator_membro_id: mAdmin,
          acao: "membro_papel_trocado",
          alvo: mAtend,
          detalhe: { nome: "Atendente", de: "atendente", para: "admin" },
        },
      ],
      "uma auditoria",
    );
  });

  it("trocar papel: ultimo_admin (outro admin saiu ao mesmo tempo) e nada muda", async () => {
    const { uAdmin, mAdmin, mAdmin2 } = await equipe(t);
    await simularOutroAdminSaindo(t, mAdmin2, mAdmin);
    await t.como("authenticated", uAdmin, async (q) => {
      await t.erro(
        q(`select public.trocar_papel_membro($1, 'atendente')`, [mAdmin2]),
        "ultimo_admin",
      );
    });
    const m = await t.sql(`select papel::text, ativo from public.membros where id = any($1)`, [
      [mAdmin, mAdmin2],
    ]);
    t.ok(
      m.every((x) => x.ativo && x.papel === "admin"),
      "os dois continuam admins ativos",
    );
    t.igual(
      (await t.sql("select count(*)::int as n from public.auditoria"))[0].n,
      0,
      "sem auditoria",
    );
  });

  // ------------------------------------------------------------- reativar
  it("reativar: volta ativa, audita e NÃO recebe as conversas de volta; já ativa não muda nada", async () => {
    const { uAdmin, mAdmin, mAtend } = await equipe(t);
    const cx = await conexao(t);
    const c = await conversaNaEtapa(t, "em_negociacao", mAtend, cx);
    await t.como("authenticated", uAdmin, async (q) => {
      await q("select public.desativar_membro($1)", [mAtend]);
      await q("select public.reativar_membro($1)", [mAtend]);
      await q("select public.reativar_membro($1)", [mAtend]); // já ativa: nada
    });
    t.igual(
      (await t.sql("select ativo from public.membros where id = $1", [mAtend]))[0].ativo,
      true,
      "ativa de novo",
    );
    const [cv] = await t.sql(
      "select responsavel_id, aguardando_humano_desde from public.conversas where id = $1",
      [c],
    );
    t.igual(cv.responsavel_id, null, "a conversa continua sem responsável");
    t.ok(cv.aguardando_humano_desde !== null, "e continua aguardando na fila");
    t.igual(
      (await t.sql("select count(*)::int as n from public.conversa_eventos"))[0].n,
      1,
      "só o evento do desativar",
    );
    const au = await t.sql(
      `select ator_membro_id, acao::text, alvo, detalhe from public.auditoria where acao = 'membro_reativado'`,
    );
    t.igual(
      au,
      [
        {
          ator_membro_id: mAdmin,
          acao: "membro_reativado",
          alvo: mAtend,
          detalhe: { nome: "Atendente" },
        },
      ],
      "uma auditoria",
    );
  });

  it("reativar: proprio_membro, nao_encontrado e ultimo_admin não se aplica (reativar admin nunca tira admin)", async () => {
    const { uAdmin, mAdmin, mAdmin2 } = await equipe(t);
    await t.sql("update public.membros set ativo = false where id = $1", [mAdmin2]);
    await t.como("authenticated", uAdmin, async (q) => {
      await t.erro(q("select public.reativar_membro($1)", [mAdmin]), "proprio_membro");
      await t.erro(q("select public.reativar_membro($1)", [NOVO_UUID()]), "nao_encontrado");
      // único admin ativo reativando outro admin: o gatilho do último admin não dispara
      await q("select public.reativar_membro($1)", [mAdmin2]);
    });
    const m = await t.sql(`select ativo from public.membros where id = any($1)`, [
      [mAdmin, mAdmin2],
    ]);
    t.ok(
      m.every((x) => x.ativo),
      "os dois admins ativos",
    );
  });

  // ------------------------------------------------------------- contexto_salvar
  it("contexto_salvar: 1ª versão com p_base nulo; p_base nulo com versão dá contexto_mudou; p_base inexistente dá nao_encontrado", async () => {
    const { uAdmin, mAdmin } = await equipe(t);
    await t.como("authenticated", uAdmin, async (q) => {
      await t.erro(q(SALVAR, [999, '{"preco":"10"}']), "nao_encontrado");
      const [{ r }] = await q("select public.contexto_salvar(null, $1::jsonb, $2) as r", [
        '{"preco":"R$ 100","itens":[{"pergunta":"Tem frete?","resposta":"Não"}]}',
        "onboarding",
      ]);
      t.igual(r.numero, 1, "número 1");
      await t.erro(q(SALVAR, [null, '{"tom_voz":"leve"}']), "contexto_mudou");
      await t.erro(q(SALVAR, [999, '{"preco":"10"}']), "nao_encontrado");
    });
    const v = await versoes(t);
    t.igual(v.length, 1, "uma versão");
    t.igual(
      {
        numero: v[0].numero,
        origem: v[0].origem,
        preco: v[0].preco,
        tom: v[0].tom_voz,
        itens: v[0].itens,
        por: v[0].criado_por,
      },
      {
        numero: 1,
        origem: "onboarding",
        preco: "R$ 100",
        tom: "",
        itens: [{ pergunta: "Tem frete?", resposta: "Não" }],
        por: mAdmin,
      },
      "a versão gravada",
    );
  });

  it("contexto_salvar: dois admins em campos diferentes se juntam; no mesmo campo o 2º recebe contexto_mudou", async () => {
    const { uAdmin, uAdmin2, mAdmin2 } = await equipe(t);
    const [{ r: v1 }] = await comoUsuario(t, uAdmin, SALVAR, [
      null,
      '{"preco":"100","tom_voz":"formal","objecoes":"caro"}',
    ]);
    // os dois abriram a v1
    const [{ r: v2 }] = await comoUsuario(t, uAdmin, SALVAR, [v1.id, '{"preco":"200"}']);
    const [{ r: v3 }] = await comoUsuario(t, uAdmin2, SALVAR, [v1.id, '{"tom_voz":"leve"}']);
    t.igual([v1.numero, v2.numero, v3.numero], [1, 2, 3], "números");
    let v = await versoes(t);
    t.igual(
      v.map((x) => [x.numero, x.preco, x.tom_voz, x.objecoes]),
      [
        [1, "100", "formal", "caro"],
        [2, "200", "formal", "caro"],
        [3, "200", "leve", "caro"],
      ],
      "a v3 junta o preço do admin 1 e o tom do admin 2",
    );
    t.igual(v[2].criado_por, mAdmin2, "a v3 é do admin 2");

    // o 2º admin, ainda na v1, muda o preço, que mudou desde a v1
    let v4: Linha;
    await t.como("authenticated", uAdmin2, async (q) => {
      await t.erro(q(SALVAR, [v1.id, '{"preco":"300"}']), "contexto_mudou");
      // junto com um campo que ninguém mexeu: recusa tudo
      await t.erro(q(SALVAR, [v1.id, '{"objecoes":"nenhuma","preco":"300"}']), "contexto_mudou");
      // mandar o mesmo valor da base não conta como mudança
      [{ r: v4 }] = await q(SALVAR, [v1.id, '{"preco":"100","objecoes":"nenhuma"}']);
      t.igual(v4.numero, 4, "v4");
    });
    v = await versoes(t);
    t.igual(
      v.map((x) => [x.numero, x.preco, x.tom_voz, x.objecoes]).at(-1),
      [4, "200", "leve", "nenhuma"],
      "o preço da atual ficou",
    );

    // itens contam como um campo só
    const [{ r: v5 }] = await comoUsuario(t, uAdmin, SALVAR, [
      v4.id,
      '{"itens":[{"pergunta":"A","resposta":"1"}]}',
    ]);
    t.igual(v5.numero, 5, "v5 com itens");
    await t.como("authenticated", uAdmin2, async (q) => {
      await t.erro(
        q(SALVAR, [v4.id, '{"itens":[{"pergunta":"B","resposta":"2"}]}']),
        "contexto_mudou",
      );
    });
  });

  it("contexto_salvar: limite_tamanho acima de 2.000 letras (campo e resposta livre); 2.000 cabem", async () => {
    const { uAdmin } = await equipe(t);
    const dois = "á".repeat(2000);
    const passa = "á".repeat(2001);
    await t.como("authenticated", uAdmin, async (q) => {
      await t.erro(q(SALVAR, [null, JSON.stringify({ preco: passa })]), "limite_tamanho");
      await t.erro(
        q(SALVAR, [null, JSON.stringify({ itens: [{ pergunta: "P", resposta: passa }] })]),
        "limite_tamanho",
      );
      await t.erro(
        q(SALVAR, [null, JSON.stringify({ tom_voz: "ok", horario: passa })]),
        "limite_tamanho",
      );
      const [{ r }] = await q(SALVAR, [
        null,
        JSON.stringify({ preco: dois, itens: [{ pergunta: "P", resposta: dois }] }),
      ]);
      t.igual(r.numero, 1, "2.000 letras cabem");
      await t.erro(q(SALVAR, [r.id, JSON.stringify({ objecoes: passa })]), "limite_tamanho");
    });
    t.igual(
      (await t.sql("select count(*)::int as n from public.contexto_versoes"))[0].n,
      1,
      "só a versão que cabia",
    );
  });

  it("contexto_salvar: numero sem buraco depois de chamadas recusadas e de um insert que falhou", async () => {
    const { uAdmin, mAdmin } = await equipe(t);
    await t.como("authenticated", uAdmin, async (q) => {
      const [{ r: v1 }] = await q(SALVAR, [null, '{"preco":"1"}']);
      await t.erro(
        q(SALVAR, [v1.id, JSON.stringify({ preco: "x".repeat(2001) })]),
        "limite_tamanho",
      );
      await t.erro(q(SALVAR, [null, '{"preco":"2"}']), "contexto_mudou");
      await t.erro(q(SALVAR, [v1.id, '{"inventado":"2"}']), "mudancas_invalidas");
      // a 0017 fechou o insert direto para authenticated (só as funções gravam)
      await t.erro(
        q(`insert into public.contexto_versoes (preco, criado_por) values ('3', $1)`, [mAdmin]),
        "42501",
      );
    });
    // um insert direto que falha no check gasta um id da sequência, mas não um número (como
    // superusuário, porque o authenticated já não insere direto)
    await t.erro(
      t.sql(
        `insert into public.contexto_versoes (preco, itens, criado_por) values ('3', '{}'::jsonb, $1)`,
        [mAdmin],
      ),
      "check",
    );
    await t.como("authenticated", uAdmin, async (q) => {
      const [{ m: idV1 }] = await q("select max(id)::int as m from public.contexto_versoes");
      const [{ r: v2 }] = await q(SALVAR, [idV1, '{"preco":"2"}']);
      t.igual(v2.numero, 2, "número 2");
      t.ok(v2.id > idV1 + 1, "o id pulou (a sequência gastou), o número não");
    });
    // um insert direto fora das funções (o superusuário) também ganha o número seguinte
    const [{ numero }] = await t.sql(
      `insert into public.contexto_versoes (preco, criado_por) values ('4', $1) returning numero`,
      [mAdmin],
    );
    t.igual(numero, 3, "insert direto: número 3");
    await t.como("authenticated", uAdmin, async (q) => {
      const [{ m: idAtual }] = await q("select max(id)::int as m from public.contexto_versoes");
      const [{ r: v4 }] = await q(SALVAR, [idAtual, '{"tom_voz":"t"}']);
      t.igual(v4.numero, 4, "número 4");
    });
    t.igual(
      (await versoes(t)).map((x) => x.numero),
      [1, 2, 3, 4],
      "1, 2, 3, 4",
    );
  });

  it("contexto: a versão atual é a de maior id (a mesma da Nina), mesmo com id e numero em ordem trocada", async () => {
    const { uAdmin, mAdmin } = await equipe(t);
    await t.sql(
      `insert into public.contexto_versoes (preco, criado_por) values ('a', $1), ('b', $1)`,
      [mAdmin],
    );
    // duas gravações diretas ao mesmo tempo: id e numero saem trocados
    await t.sql(`update public.contexto_versoes set numero = numero + 10`);
    await t.sql(
      `update public.contexto_versoes set numero = case preco when 'a' then 2 else 1 end`,
    );
    const [{ id: idB }] = await t.sql(
      `select id::int from public.contexto_versoes where preco = 'b'`,
    );
    const [{ id: idA }] = await t.sql(
      `select id::int from public.contexto_versoes where preco = 'a'`,
    );
    // a Nina usa a de maior id
    const [{ m }] = await t.sql(`select max(id)::int as m from public.contexto_versoes`);
    t.igual(m, idB, "Nina: b");
    await t.como("authenticated", uAdmin, async (q) => {
      // p_base = a (maior numero) mudando preco: a atual é b, que mudou o preco depois de a
      await t.erro(q(SALVAR, [idA, '{"preco":"c"}']), "contexto_mudou");
      // restaurar b (a atual) não grava
      const [{ r: atual }] = await q("select public.contexto_restaurar($1) as r", [idB]);
      t.igual(atual, { id: idB, numero: 1 }, "restaurar a atual devolve b");
      const [{ r }] = await q(SALVAR, [idB, '{"tom_voz":"leve"}']);
      const [{ preco }] = await q("select preco from public.contexto_versoes where id = $1", [
        r.id,
      ]);
      t.igual([r.numero, preco], [3, "b"], "partiu de b, número seguinte");
    });
  });

  it("contexto_salvar: sem mudança devolve a atual sem versão nova; formatos inválidos recusados", async () => {
    const { uAdmin } = await equipe(t);
    await t.como("authenticated", uAdmin, async (q) => {
      const [{ r: v1 }] = await q(SALVAR, [
        null,
        '{"preco":"1","itens":[{"pergunta":"A","resposta":"B","extra":1}]}',
      ]);
      const [{ r: igual }] = await q(SALVAR, [v1.id, '{"preco":"1"}']);
      t.igual(igual, v1, "mesmo valor: devolve a atual");
      const [{ r: vazio }] = await q(SALVAR, [v1.id, "{}"]);
      t.igual(vazio, v1, "sem mudanças: devolve a atual");
      for (const m of [
        "[]",
        '{"preco":1}',
        '{"preco":null}',
        '{"itens":{}}',
        '{"itens":[{"pergunta":"A"}]}',
        '{"itens":["x"]}',
        '{"id":"9"}',
      ]) {
        await t.erro(q(SALVAR, [v1.id, m]), "mudancas_invalidas");
      }
      await t.erro(
        q("select public.contexto_salvar($1, $2::jsonb, $3)", [
          v1.id,
          '{"preco":"2"}',
          "restauracao",
        ]),
        "mudancas_invalidas",
      );
    });
    const v = await versoes(t);
    t.igual(v.length, 1, "uma versão só");
    t.igual(
      v[0].itens,
      [{ pergunta: "A", resposta: "B" }],
      "itens guardados só com pergunta e resposta",
    );
    t.igual(v[0].origem, "edicao", "origem padrão edicao");
  });

  // ------------------------------------------------------------- contexto_restaurar
  it("contexto_restaurar: grava origem restauracao, restaurada_de e o conteúdo da versão; nao_encontrado; restaurar a atual não grava", async () => {
    const { uAdmin2, mAdmin2 } = await equipe(t);
    await t.como("authenticated", uAdmin2, async (q) => {
      const [{ r: v1 }] = await q(SALVAR, [
        null,
        '{"preco":"100","itens":[{"pergunta":"A","resposta":"1"}]}',
      ]);
      const [{ r: v2 }] = await q(SALVAR, [v1.id, '{"preco":"200","tom_voz":"leve","itens":[]}']);
      await t.erro(q("select public.contexto_restaurar(999)"), "nao_encontrado");
      const [{ r: atual }] = await q("select public.contexto_restaurar($1) as r", [v2.id]);
      t.igual(atual, v2, "restaurar a atual devolve a atual");
      const [{ r: v3 }] = await q("select public.contexto_restaurar($1) as r", [v1.id]);
      t.igual(v3.numero, 3, "número 3");
      // depois de restaurar, o salvar a partir da v3 continua
      const [{ r: v4 }] = await q(SALVAR, [v3.id, '{"objecoes":"caro"}']);
      t.igual(v4.numero, 4, "número 4");
    });
    const v = await versoes(t);
    t.igual(
      v.map((x) => [x.numero, x.origem, x.restaurada_de, x.preco, x.tom_voz, x.itens]),
      [
        [1, "edicao", null, "100", "", [{ pergunta: "A", resposta: "1" }]],
        [2, "edicao", null, "200", "leve", []],
        [3, "restauracao", v[0].id, "100", "", [{ pergunta: "A", resposta: "1" }]],
        [4, "edicao", null, "100", "", [{ pergunta: "A", resposta: "1" }]],
      ],
      "versões",
    );
    t.igual(v[2].criado_por, mAdmin2, "quem restaurou");
  });

  // ------------------------------------------------------------- onboarding
  it("concluir_onboarding: grava agora, repete sem mudar a data nem o atualizado_em", async () => {
    const { uAdmin, uAdmin2 } = await equipe(t);
    const [{ d: d1 }] = await comoUsuario(t, uAdmin, "select public.concluir_onboarding() as d");
    t.ok(d1 instanceof Date, "devolve a data");
    const [c1] = await t.sql(
      "select onboarding_concluido_em as d, atualizado_em as a from public.configuracao",
    );
    t.igual(c1.d.getTime(), d1.getTime(), "gravou");
    await t.sql(`select pg_sleep(0.01)`);
    const [{ d: d2 }] = await comoUsuario(t, uAdmin2, "select public.concluir_onboarding() as d");
    t.igual(d2.getTime(), d1.getTime(), "a 2ª chamada devolve a mesma data");
    const [c2] = await t.sql(
      "select onboarding_concluido_em as d, atualizado_em as a from public.configuracao",
    );
    t.igual(
      [c2.d.getTime(), c2.a.getTime()],
      [c1.d.getTime(), c1.a.getTime()],
      "nada mudou na linha",
    );
  });

  it("concluir_onboarding: sem a linha da configuração, cria a linha 1", async () => {
    const { uAdmin } = await equipe(t);
    await t.sql("delete from public.configuracao");
    const [{ d }] = await comoUsuario(t, uAdmin, "select public.concluir_onboarding() as d");
    const r = await t.sql("select id, onboarding_concluido_em as d from public.configuracao");
    t.igual(
      r.map((x) => [x.id, x.d.getTime()]),
      [[1, d.getTime()]],
      "linha 1 com a data",
    );
  });
});
