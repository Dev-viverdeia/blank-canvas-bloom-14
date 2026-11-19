// @vitest-environment node
// Estrutura do envio 2 da ligação das telas: as migrations 0004 (enums), 0005 (tabelas) e
// 0010 (tempo real). Porte do 10-estrutura do banco2.
import { describe, it } from "vitest";
import { montarBase, TEMPO_TESTE, usarBanco, type Banco } from "./montar";

// ---------------------------------------------------------------------------
// ajudantes
// ---------------------------------------------------------------------------

// 1ª conta vira admin pelo gatilho; as outras recebem membro direto (como o servidor faz).
async function equipe(t: Banco) {
  const uAdmin = await t.criarUsuario("admin@empresa.exemplo", "Admin");
  const uAtend = await t.criarUsuario("atendente@empresa.exemplo", "Atendente");
  const uFora = await t.criarUsuario("fora@empresa.exemplo", "Sem convite");
  const [{ id: mAdmin }] = await t.sql("select id from public.membros where user_id = $1", [
    uAdmin,
  ]);
  const [{ id: mAtend }] = await t.sql(
    `insert into public.membros (user_id, nome, email, papel) values ($1, 'Atendente', 'atendente@empresa.exemplo', 'atendente') returning id`,
    [uAtend],
  );
  return { uAdmin, uAtend, uFora, mAdmin, mAtend };
}

async function conexao(t: Banco, campos = {}) {
  const c = {
    gateway: "zapi",
    nome: "Teste",
    id_externo: "inst-1",
    status: "conectada",
    ativa: true,
    ...campos,
  };
  const [{ id }] = await t.sql(
    `insert into public.conexoes (gateway, nome, id_externo, status, ativa) values ($1, $2, $3, $4, $5) returning id`,
    [c.gateway, c.nome, c.id_externo, c.status, c.ativa],
  );
  return id;
}

async function conversa(t: Banco, conexaoId: string) {
  const [{ id: contato }] = await t.sql(
    `insert into public.contatos (nome) values ('Lead de teste') returning id`,
  );
  const [{ id }] = await t.sql(
    `insert into public.conversas (contato_id, conexao_id) values ($1, $2) returning id`,
    [contato, conexaoId],
  );
  return { contato, conversa: id };
}

async function mensagemDoLead(t: Banco, conversaId: string, conexaoId: string, texto = "Oi") {
  const [{ id }] = await t.sql(
    `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, status, texto)
     values ($1, $2, 'entrada', 'lead', 'recebida', $3) returning id`,
    [conversaId, conexaoId, texto],
  );
  return id;
}

const NOVO_UUID = () => crypto.randomUUID();

// ---------------------------------------------------------------------------
// testes
// ---------------------------------------------------------------------------

const base = await montarBase();
const t = usarBanco(base);

describe("banco: estrutura do envio 2 (0004, 0005 e 0010)", { timeout: TEMPO_TESTE }, () => {
  it("estrutura: enums novos (auditoria e conversa_evento_tipo)", async () => {
    const [{ v }] = await t.sql(`select enum_range(null::public.auditoria_acao)::text[] as v`);
    for (const valor of [
      "membro_reativado",
      "convite_reenviado",
      "convite_cancelado",
      "membro_entrou",
      "ritmo_alterado",
    ]) {
      t.ok(v.includes(valor), `auditoria_acao sem ${valor}`);
    }
    t.ok(
      v.includes("membro_convidado") && v.includes("contato_apagado"),
      "os valores antigos continuam",
    );
    const [{ e }] = await t.sql(
      `select enum_range(null::public.conversa_evento_tipo)::text[] as e`,
    );
    t.igual(
      e,
      ["passou", "assumiu", "devolveu", "celular", "voltou_para_fila"],
      "conversa_evento_tipo",
    );
    // o valor novo já pode ser usado (o 10 rodou numa transação própria)
    await t.sql(
      `insert into public.auditoria (acao, alvo) values ('ritmo_alterado', 'configuracao')`,
    );
  });

  it("estrutura: colunas novas com tipo, nulo e default da spec", async () => {
    const esperado = [
      ["conexao_eventos", "ativa_de", "boolean", "YES", null],
      ["conexao_eventos", "ativa_para", "boolean", "NO", null],
      ["conexao_eventos", "ator_membro_id", "uuid", "YES", null],
      ["conexao_eventos", "conexao_id", "uuid", "NO", null],
      ["conexao_eventos", "status_de", "USER-DEFINED", "YES", null],
      ["conexao_eventos", "status_para", "USER-DEFINED", "NO", null],
      ["conexao_eventos", "ultimo_erro", "text", "YES", null],
      ["configuracao", "worker_visto_em", "timestamp with time zone", "YES", null],
      ["contatos", "anotacoes_nina", "jsonb", "YES", null],
      ["contatos", "resumo_nina_em", "timestamp with time zone", "YES", null],
      ["contexto_versoes", "numero", "integer", "YES", null],
      ["contexto_versoes", "restaurada_de", "bigint", "YES", null],
      ["conversa_eventos", "conversa_id", "uuid", "NO", null],
      ["conversa_eventos", "de", "text", "YES", null],
      ["conversa_eventos", "de_membro_id", "uuid", "YES", null],
      ["conversa_eventos", "membro_id", "uuid", "YES", null],
      ["conversa_eventos", "motivo", "USER-DEFINED", "YES", null],
      ["conversa_eventos", "por_envio", "boolean", "NO", "false"],
      ["conversa_eventos", "tipo", "USER-DEFINED", "NO", null],
      ["conversas", "ultima_da_nina_em", "timestamp with time zone", "YES", null],
      ["conversas", "ultima_mensagem_id", "uuid", "YES", null],
      ["convites", "convidado_por", "uuid", "YES", null],
      ["convites", "email", "text", "NO", null],
      ["convites", "enviado_em", "timestamp with time zone", "NO", "now()"],
      ["convites", "papel", "USER-DEFINED", "NO", "'atendente'::papel_membro"],
      ["convites", "user_id", "uuid", "YES", null],
      ["ia_chamadas", "conversa_id", "uuid", "YES", null],
      ["membros", "vistos", "jsonb", "NO", "'{}'::jsonb"],
      ["mensagens", "midia_duracao_s", "integer", "YES", null],
      ["mensagens", "responde_a_id", "uuid", "YES", null],
      ["rodadas", "foi_para_equipe", "boolean", "NO", "false"],
    ];
    const linhas = await t.sql(
      `select table_name as t, column_name as c, data_type as tipo, is_nullable as nulo, column_default as def
         from information_schema.columns
        where table_schema = 'public'
          and (table_name || '.' || column_name) = any ($1::text[])
        order by 1, 2`,
      [esperado.map(([tb, c]) => `${tb}.${c}`)],
    );
    t.igual(
      linhas.map((r) => [r.t, r.c, r.tipo, r.nulo, r.def ? r.def.replace(/public\./g, "") : null]),
      esperado,
      "colunas",
    );
    // tipos enum certos
    const enums = await t.sql(
      `select table_name || '.' || column_name as c, udt_name as u from information_schema.columns
        where table_schema = 'public' and data_type = 'USER-DEFINED'
          and table_name in ('conversa_eventos', 'conexao_eventos', 'convites') order by 1`,
    );
    t.igual(enums, [
      { c: "conexao_eventos.status_de", u: "conexao_status" },
      { c: "conexao_eventos.status_para", u: "conexao_status" },
      { c: "conversa_eventos.motivo", u: "motivo_humano" },
      { c: "conversa_eventos.tipo", u: "conversa_evento_tipo" },
      { c: "convites.papel", u: "papel_membro" },
    ]);
    // índice da linha do tempo da conversa
    const [{ def }] = await t.sql(
      `select indexdef as def from pg_indexes where indexname = 'conversa_eventos_conversa'`,
    );
    t.ok(/\(conversa_id, criado_em\)/.test(def), `índice: ${def}`);
  });

  it("estrutura: chaves estrangeiras com cascade e set null da spec", async () => {
    const fks = await t.sql(
      `select 'public.' || rel.relname || '.' || a.attname as col, 'public.' || alvo.relname as alvo, confdeltype as acao
         from pg_constraint c
         join pg_class rel on rel.oid = c.conrelid
         join pg_class alvo on alvo.oid = c.confrelid
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        where c.contype = 'f' and c.connamespace = 'public'::regnamespace
          and (rel.relname in ('conversa_eventos', 'conexao_eventos', 'convites')
               or ('public.' || rel.relname || '.' || a.attname) in
                  ('public.mensagens.responde_a_id', 'public.conversas.ultima_mensagem_id',
                   'public.ia_chamadas.conversa_id', 'public.contexto_versoes.restaurada_de'))
        order by 1`,
    );
    t.igual(
      fks.map((f) => `${f.col} -> ${f.alvo} (${f.acao})`),
      [
        "public.conexao_eventos.ator_membro_id -> public.membros (n)",
        "public.conexao_eventos.conexao_id -> public.conexoes (c)",
        "public.contexto_versoes.restaurada_de -> public.contexto_versoes (a)",
        "public.conversa_eventos.conversa_id -> public.conversas (c)",
        "public.conversa_eventos.de_membro_id -> public.membros (n)",
        "public.conversa_eventos.membro_id -> public.membros (n)",
        "public.conversas.ultima_mensagem_id -> public.mensagens (n)",
        "public.convites.convidado_por -> public.membros (n)",
        "public.ia_chamadas.conversa_id -> public.conversas (n)",
        "public.mensagens.responde_a_id -> public.mensagens (n)",
      ],
      "fks (c = cascade, n = set null, a = sem ação)",
    );
  });

  it("estrutura: apagar o contato leva conversa, mensagens e eventos, e solta a ia_chamada", async () => {
    const { mAdmin } = await equipe(t);
    const cx = await conexao(t);
    const { contato, conversa: cv } = await conversa(t, cx);
    const m1 = await mensagemDoLead(t, cv, cx, "primeira");
    const [{ id: m2 }] = await t.sql(
      `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, status, texto, responde_a_id)
       values ($1, $2, 'entrada', 'lead', 'recebida', 'cita a primeira', $3) returning id`,
      [cv, cx, m1],
    );
    await t.sql(`update public.conversas set ultima_mensagem_id = $1 where id = $2`, [m2, cv]);
    await t.sql(
      `insert into public.conversa_eventos (conversa_id, tipo, membro_id, de) values ($1, 'assumiu', $2, 'nina')`,
      [cv, mAdmin],
    );
    const [{ id: ch }] = await t.sql(
      `insert into public.ia_chamadas (tipo, provedor, modelo, custo_origem, conversa_id)
       values ('transcricao', 'groq', 'whisper', 'sem_preco', $1) returning id`,
      [cv],
    );
    await t.sql(`delete from public.contatos where id = $1`, [contato]);
    t.igual(
      (
        await t.sql(`select count(*)::int as n from public.mensagens where conversa_id = $1`, [cv])
      )[0].n,
      0,
      "mensagens",
    );
    t.igual(
      (
        await t.sql(
          `select count(*)::int as n from public.conversa_eventos where conversa_id = $1`,
          [cv],
        )
      )[0].n,
      0,
      "eventos",
    );
    t.igual(
      (await t.sql(`select conversa_id from public.ia_chamadas where id = $1`, [ch]))[0]
        .conversa_id,
      null,
      "ia_chamadas.conversa_id fica nulo",
    );
  });

  it("convites: atendente não lê; admin lê; anon e a tela não gravam; só o servidor grava", async () => {
    const { uAdmin, uAtend, uFora, mAdmin } = await equipe(t);
    await t.como("service_role", null, async (q) => {
      await q(
        `insert into public.convites (email, papel, convidado_por) values ('novo@empresa.exemplo', 'atendente', $1)`,
        [mAdmin],
      );
    });
    await t.como("authenticated", uAtend, async (q) => {
      t.igual((await q("select * from public.convites")).length, 0, "atendente vê 0 convites");
    });
    await t.como("authenticated", uFora, async (q) => {
      t.igual((await q("select * from public.convites")).length, 0, "conta sem membro vê 0");
    });
    await t.como("authenticated", uAdmin, async (q) => {
      const r = await q(
        "select email, papel, enviado_em is not null as enviado from public.convites",
      );
      t.igual(
        r,
        [{ email: "novo@empresa.exemplo", papel: "atendente", enviado: true }],
        "admin lê",
      );
      await t.erro(
        q(`insert into public.convites (email) values ('outro@empresa.exemplo')`),
        "permission denied",
      );
      await t.erro(q(`update public.convites set papel = 'admin'`), "permission denied");
      await t.erro(q(`delete from public.convites`), "permission denied");
    });
    await t.como("anon", null, async (q) => {
      await t.erro(q("select * from public.convites"), "permission denied");
    });
    // e-mail minúsculo e único
    await t.erro(
      t.sql(`insert into public.convites (email) values ('Maiusculo@empresa.exemplo')`),
      "convites_email_minusculo",
    );
    await t.erro(
      t.sql(`insert into public.convites (email) values ('')`),
      "convites_email_minusculo",
    );
    await t.erro(
      t.sql(`insert into public.convites (email) values ('novo@empresa.exemplo')`),
      "23505",
    );
    const u = NOVO_UUID();
    await t.sql(`insert into public.convites (email, user_id) values ('a@empresa.exemplo', $1)`, [
      u,
    ]);
    await t.erro(
      t.sql(`insert into public.convites (email, user_id) values ('b@empresa.exemplo', $1)`, [u]),
      "23505",
    );
  });

  it("configuracao: membro (atendente) lê pela configuracao_membro_le; conta sem membro e anon não", async () => {
    const { uAdmin, uAtend, uFora } = await equipe(t);
    const [{ n: pol }] = await t.sql(
      `select count(*)::int as n from pg_policies where tablename = 'configuracao' and policyname = 'configuracao_membro_le' and cmd = 'SELECT'`,
    );
    t.igual(pol, 1, "policy existe");
    for (const u of [uAtend, uAdmin]) {
      await t.como("authenticated", u, async (q) => {
        const r = await q(
          "select espera_lote_s, espera_lote_max_s, onboarding_concluido_em, worker_visto_em from public.configuracao",
        );
        t.igual(
          r,
          [
            {
              espera_lote_s: 8,
              espera_lote_max_s: 60,
              onboarding_concluido_em: null,
              worker_visto_em: null,
            },
          ],
          "lê a linha",
        );
        await t.erro(q("update public.configuracao set espera_lote_s = 10"), "permission denied");
      });
    }
    await t.como("authenticated", uFora, async (q) => {
      t.igual((await q("select * from public.configuracao")).length, 0, "conta sem membro vê 0");
    });
    // membro desativado deixa de ler
    await t.sql(`update public.membros set ativo = false where user_id = $1`, [uAtend]);
    await t.como("authenticated", uAtend, async (q) => {
      t.igual((await q("select * from public.configuracao")).length, 0, "desativado vê 0");
    });
    await t.como("anon", null, async (q) => {
      await t.erro(q("select * from public.configuracao"), "permission denied");
    });
  });

  it("conversa_eventos: membro lê; authenticated não grava (nem admin); anon não chega", async () => {
    const { uAdmin, uAtend, uFora, mAdmin } = await equipe(t);
    const cx = await conexao(t);
    const { conversa: cv } = await conversa(t, cx);
    await t.sql(
      `insert into public.conversa_eventos (conversa_id, tipo, membro_id, de, motivo) values ($1, 'passou', null, 'nina', 'nina_passou')`,
      [cv],
    );
    for (const u of [uAdmin, uAtend]) {
      await t.como("authenticated", u, async (q) => {
        const r = await q(
          "select tipo::text, de, motivo::text, por_envio from public.conversa_eventos",
        );
        t.igual(
          r,
          [{ tipo: "passou", de: "nina", motivo: "nina_passou", por_envio: false }],
          "membro lê",
        );
        await t.erro(
          q(`insert into public.conversa_eventos (conversa_id, tipo) values ($1, 'assumiu')`, [cv]),
          "permission denied",
        );
        await t.erro(q(`update public.conversa_eventos set de = 'outro'`), "permission denied");
        await t.erro(q(`delete from public.conversa_eventos`), "permission denied");
      });
    }
    await t.como("authenticated", uFora, async (q) => {
      t.igual(
        (await q("select * from public.conversa_eventos")).length,
        0,
        "conta sem membro vê 0",
      );
    });
    await t.como("anon", null, async (q) => {
      await t.erro(q("select * from public.conversa_eventos"), "permission denied");
    });
    // o "de" só aceita os 4 valores
    await t.erro(
      t.sql(
        `insert into public.conversa_eventos (conversa_id, tipo, de) values ($1, 'assumiu', 'lead')`,
        [cv],
      ),
      "conversa_eventos_de",
    );
    for (const de of ["nina", "espera", "outro", "celular"]) {
      await t.sql(
        `insert into public.conversa_eventos (conversa_id, tipo, de, de_membro_id) values ($1, 'assumiu', $2, $3)`,
        [cv, de, mAdmin],
      );
    }
  });

  it("mensagens: a tela insere com responde_a_id e midia_duracao_s (policy mensagens_membro_insere)", async () => {
    const { uAtend, mAtend, uFora } = await equipe(t);
    const cx = await conexao(t);
    const { conversa: cv } = await conversa(t, cx);
    const doLead = await mensagemDoLead(t, cv, cx, "Quanto custa?");
    const id = NOVO_UUID();
    // como o envio.ts: id do navegador, status na_fila explícito, sem conexao_id
    await t.como("authenticated", uAtend, async (q) => {
      const r = await q(
        `insert into public.mensagens (id, conversa_id, direcao, origem, tipo, texto, status, responde_a_id, midia_duracao_s)
         values ($1, $2, 'saida', 'humano_tela', 'audio', null, 'na_fila', $3, 12)
         returning id, responde_a_id, midia_duracao_s, autor_membro_id, conexao_id`,
        [id, cv, doLead],
      );
      t.igual(
        r,
        [
          {
            id,
            responde_a_id: doLead,
            midia_duracao_s: 12,
            autor_membro_id: mAtend,
            conexao_id: cx,
          },
        ],
        "gravou",
      );
      // duração negativa: recusada pelo check
      await t.erro(
        q(
          `insert into public.mensagens (conversa_id, direcao, origem, texto, status, midia_duracao_s)
           values ($1, 'saida', 'humano_tela', 'x', 'na_fila', -1)`,
          [cv],
        ),
        "mensagens_midia_duracao_s",
      );
      // a policy continua valendo: não pode gravar como lead
      await t.erro(
        q(
          `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, texto, status, responde_a_id)
           values ($1, $2, 'entrada', 'lead', 'x', 'recebida', $3)`,
          [cv, cx, doLead],
        ),
        "row-level security",
      );
      // colunas sem grant continuam fechadas
      await t.erro(
        q(
          `insert into public.mensagens (conversa_id, direcao, origem, texto, status, transcricao)
           values ($1, 'saida', 'humano_tela', 'x', 'na_fila', 'y')`,
          [cv],
        ),
        "permission denied",
      );
    });
    // conta sem membro: a policy recusa
    await t.como("authenticated", uFora, async (q) => {
      await t.erro(
        q(
          `insert into public.mensagens (conversa_id, direcao, origem, texto, status, responde_a_id)
           values ($1, 'saida', 'humano_tela', 'x', 'na_fila', $2)`,
          [cv, doLead],
        ),
        "row-level security",
      );
    });
    // a mensagem citada some: a citação fica nula
    await t.sql(`delete from public.mensagens where id = $1`, [doLead]);
    t.igual(
      (await t.sql(`select responde_a_id from public.mensagens where id = $1`, [id]))[0]
        .responde_a_id,
      null,
      "set null",
    );
  });

  it("mensagens: a tela não cita mensagem de outra conversa (policy restritiva mensagens_citacao_mesma_conversa)", async () => {
    const { uAtend } = await equipe(t);
    const cx = await conexao(t);
    const { conversa: cv } = await conversa(t, cx);
    const { conversa: outra } = await conversa(t, cx);
    const daOutra = await mensagemDoLead(t, outra, cx, "segredo de outro lead");
    const daMesma = await mensagemDoLead(t, cv, cx, "Quanto custa?");
    await t.como("authenticated", uAtend, async (q) => {
      const e = await t.erro(
        q(
          `insert into public.mensagens (conversa_id, direcao, origem, texto, status, responde_a_id)
           values ($1, 'saida', 'humano_tela', 'x', 'na_fila', $2)`,
          [cv, daOutra],
        ),
        "row-level security",
      );
      t.igual((e as Error & { code?: string }).code, "42501", "código 42501");
      // id que não existe: também recusado
      await t.erro(
        q(
          `insert into public.mensagens (conversa_id, direcao, origem, texto, status, responde_a_id)
           values ($1, 'saida', 'humano_tela', 'x', 'na_fila', gen_random_uuid())`,
          [cv],
        ),
        "row-level security",
      );
      // da mesma conversa e sem citação: continuam
      const ok = await q(
        `insert into public.mensagens (conversa_id, direcao, origem, texto, status, responde_a_id)
         values ($1, 'saida', 'humano_tela', 'cita', 'na_fila', $2) returning responde_a_id`,
        [cv, daMesma],
      );
      t.igual(ok, [{ responde_a_id: daMesma }], "mesma conversa");
      await q(
        `insert into public.mensagens (conversa_id, direcao, origem, texto, status)
               values ($1, 'saida', 'humano_tela', 'sem', 'na_fila')`,
        [cv],
      );
    });
    const [{ n }] = await t.sql(
      `select count(*)::int as n from public.mensagens where conversa_id = $1 and origem = 'humano_tela'`,
      [cv],
    );
    t.igual(n, 2, "só as duas válidas");
    // o servidor (service_role) não passa por RLS: a citação da entrada (registrar_entrada) segue igual
    const [p] = await t.sql(
      `select polname, polpermissive from pg_policy where polrelid = 'public.mensagens'::regclass
          and polname = 'mensagens_citacao_mesma_conversa'`,
    );
    t.igual(p, { polname: "mensagens_citacao_mesma_conversa", polpermissive: false }, "restritiva");
    const [f] = await t.sql(
      `select has_function_privilege('anon', 'public.mensagem_da_conversa(uuid, uuid)', 'execute') as anon,
              has_function_privilege('authenticated', 'public.mensagem_da_conversa(uuid, uuid)', 'execute') as auth`,
    );
    t.igual(f, { anon: false, auth: true }, "função da policy: authenticated executa, anon não");
  });

  it("configuracao: o check do ritmo recusa fora dos limites e aceita 8/60", async () => {
    const recusados = [
      [1, 60],
      [31, 60],
      [8, 19],
      [8, 121],
      [16, 20],
      [30, 34],
      [0, 60],
    ];
    for (const [e, m] of recusados) {
      await t.erro(
        t.sql(
          `update public.configuracao set espera_lote_s = $1, espera_lote_max_s = $2 where id = 1`,
          [e, m],
        ),
        "23514",
      );
    }
    // o motivo é o check novo (e não os antigos) nos casos que os antigos aceitariam
    for (const [e, m] of [
      [1, 60],
      [31, 60],
      [8, 19],
      [8, 121],
      [16, 20],
    ]) {
      await t.erro(
        t.sql(
          `update public.configuracao set espera_lote_s = $1, espera_lote_max_s = $2 where id = 1`,
          [e, m],
        ),
        "configuracao_ritmo",
      );
    }
    for (const [e, m] of [
      [2, 20],
      [15, 20],
      [30, 120],
      [30, 35],
      [8, 60],
    ]) {
      await t.sql(
        `update public.configuracao set espera_lote_s = $1, espera_lote_max_s = $2 where id = 1`,
        [e, m],
      );
      const [r] = await t.sql(
        `select espera_lote_s as e, espera_lote_max_s as m from public.configuracao`,
      );
      t.igual(r, { e, m }, `aceita ${e}/${m}`);
    }
  });

  it("membros: vistos nasce {} e a tela não grava direto", async () => {
    const { uAtend } = await equipe(t);
    await t.como("authenticated", uAtend, async (q) => {
      const r = await q(`select vistos from public.membros where user_id = auth.uid()`);
      t.igual(r, [{ vistos: {} }], "default");
      await t.erro(
        q(`update public.membros set vistos = '{"tour":"2026-11-02T10:00:00-03:00"}'`),
        "permission denied",
      );
    });
    await t.erro(
      t.sql(`update public.membros set vistos = '[]'::jsonb where user_id = $1`, [uAtend]),
      "membros_vistos_objeto",
    );
  });

  it("contatos: anotacoes_nina só para ler pela tela; os campos antigos continuam editáveis", async () => {
    const { uAtend } = await equipe(t);
    const cx = await conexao(t);
    const { contato } = await conversa(t, cx);
    await t.sql(
      `update public.contatos set anotacoes_nina = $1::jsonb, resumo_nina_em = now() where id = $2`,
      [
        JSON.stringify({ fatos: [{ rotulo: "Cidade", valor: "Recife" }], proximo_passo: null }),
        contato,
      ],
    );
    await t.como("authenticated", uAtend, async (q) => {
      const [r] = await q(
        `select anotacoes_nina, resumo_nina_em is not null as tem from public.contatos where id = $1`,
        [contato],
      );
      t.igual(
        r,
        {
          anotacoes_nina: { fatos: [{ rotulo: "Cidade", valor: "Recife" }], proximo_passo: null },
          tem: true,
        },
        "lê",
      );
      await t.erro(
        q(`update public.contatos set anotacoes_nina = '{}'::jsonb where id = $1`, [contato]),
        "permission denied",
      );
      await t.erro(
        q(`update public.contatos set resumo_nina_em = now() where id = $1`, [contato]),
        "permission denied",
      );
      const ok = await q(
        `update public.contatos set empresa = 'Empresa Exemplo' where id = $1 returning id`,
        [contato],
      );
      t.igual(ok.length, 1, "empresa continua editável");
    });
    await t.erro(
      t.sql(`update public.contatos set anotacoes_nina = '[]'::jsonb where id = $1`, [contato]),
      "contatos_anotacoes_nina_objeto",
    );
  });

  it("contexto_versoes: num banco sem versões o pacote aplica e numero fica vazio", async () => {
    t.igual((await t.sql(`select count(*)::int as n from public.contexto_versoes`))[0].n, 0);
    const [{ n }] = await t.sql(
      `select count(*)::int as n from pg_constraint where conname = 'contexto_versoes_numero_unico' and contype = 'u'`,
    );
    t.igual(n, 1, "unique de numero");
  });

  it("tempo real: a publicação tem as 5 tabelas novas e as 3 antigas; conexoes e ia_chaves fora; reaplicar não duplica", async () => {
    const lista = async () =>
      (
        await t.sql(
          `select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' order by 1`,
        )
      ).map((r) => r.tablename);
    // A tela de Ligações (envio 4) acrescenta `ligacoes`, quando já está na base.
    const [{ tem }] = await t.sql(`select to_regclass('public.ligacoes') is not null as tem`);
    const esperado = [
      "contato_etapa_historico",
      "contatos",
      "conversa_eventos",
      "conversas",
      "etapas",
      ...(tem ? ["ligacoes"] : []),
      "membros",
      "mensagens",
      "rodadas",
    ];
    t.igual(await lista(), esperado, "publicação");
    await t.aplicar("src/test/banco/base/0010_nina_ligacao_tempo_real.sql");
    t.igual(await lista(), esperado, "idempotente");
  });

  it("conexao_eventos: gravado ao mudar status e ao desativar, com o membro do auth.uid() (nulo pelo servidor)", async () => {
    const { uAdmin, uAtend, uFora, mAdmin } = await equipe(t);
    const cx = await conexao(t, { status: "conectando", ativa: false });
    const eventos = () =>
      t.sql(
        `select status_de::text as sd, status_para::text as sp, ativa_de as ad, ativa_para as ap, ultimo_erro as erro, ator_membro_id as ator
           from public.conexao_eventos where conexao_id = $1 order by criado_em, id`,
        [cx],
      );
    t.igual(await eventos(), [], "insert não grava evento");

    // admin conectou (o servidor age com o jwt do admin)
    await t.como("service_role", uAdmin, async (q) => {
      await q(`update public.conexoes set status = 'conectada', ativa = true where id = $1`, [cx]);
    });
    // o servidor (sem usuário) registra um erro
    await t.como("service_role", null, async (q) => {
      await q(
        `update public.conexoes set status = 'erro', ultimo_erro = 'token_invalido' where id = $1`,
        [cx],
      );
    });
    // mudar só o nome, ou repetir o mesmo status, não grava
    await t.sql(`update public.conexoes set nome = 'Outro nome' where id = $1`, [cx]);
    await t.sql(`update public.conexoes set status = 'erro' where id = $1`, [cx]);
    // admin desativou
    await t.como("service_role", uAdmin, async (q) => {
      await q(
        `update public.conexoes set ativa = false, status = 'desconectada', ultimo_erro = null where id = $1`,
        [cx],
      );
    });
    const ev = await eventos();
    t.igual(ev.length, 3, `3 eventos: ${JSON.stringify(ev)}`);
    t.igual(
      ev[0],
      { sd: "conectando", sp: "conectada", ad: false, ap: true, erro: null, ator: mAdmin },
      "conectou",
    );
    t.igual(
      ev[1],
      { sd: "conectada", sp: "erro", ad: true, ap: true, erro: "token_invalido", ator: null },
      "erro pelo servidor",
    );
    t.igual(
      ev[2],
      { sd: "erro", sp: "desconectada", ad: true, ap: false, erro: null, ator: mAdmin },
      "desativou",
    );

    // só desativar (sem mudar status) também grava
    const cx2 = await conexao(t, { id_externo: "inst-2", status: "conectada", ativa: true });
    await t.como("service_role", uAdmin, async (q) => {
      await q(`update public.conexoes set ativa = false where id = $1`, [cx2]);
    });
    const [e2] = await t.sql(
      `select status_de::text as sd, status_para::text as sp, ativa_de as ad, ativa_para as ap, ator_membro_id as ator from public.conexao_eventos where conexao_id = $1`,
      [cx2],
    );
    t.igual(
      e2,
      { sd: "conectada", sp: "conectada", ad: true, ap: false, ator: mAdmin },
      "só desativou",
    );

    // quem lê: membro (atendente também); conta sem membro não; anon não chega
    await t.como("authenticated", uAtend, async (q) => {
      t.igual((await q("select * from public.conexao_eventos")).length, 4, "atendente lê");
      await t.erro(
        q(
          `insert into public.conexao_eventos (conexao_id, status_para, ativa_para) values ($1, 'erro', false)`,
          [cx],
        ),
        "permission denied",
      );
    });
    await t.como("authenticated", uFora, async (q) => {
      t.igual((await q("select * from public.conexao_eventos")).length, 0, "conta sem membro vê 0");
    });
    await t.como("anon", null, async (q) => {
      await t.erro(q("select * from public.conexao_eventos"), "permission denied");
    });
    // escrita só pelo gatilho: nem o servidor grava direto
    await t.como("service_role", null, async (q) => {
      t.igual(
        (await q("select count(*)::int as n from public.conexao_eventos"))[0].n,
        4,
        "servidor lê",
      );
      await t.erro(
        q(
          `insert into public.conexao_eventos (conexao_id, status_para, ativa_para) values ($1, 'erro', false)`,
          [cx],
        ),
        "permission denied",
      );
      await t.erro(q(`delete from public.conexao_eventos`), "permission denied");
    });
    // a conexão apagada leva os eventos (cascade)
    await t.sql(`delete from public.conexoes where id = $1`, [cx2]);
    t.igual(
      (
        await t.sql(`select count(*)::int as n from public.conexao_eventos where conexao_id = $1`, [
          cx2,
        ])
      )[0].n,
      0,
      "cascade",
    );
    // a função do gatilho não é chamável
    for (const papel of ["anon", "authenticated", "service_role"]) {
      const [{ p }] = await t.sql(
        `select has_function_privilege($1, 'public.tg_conexoes_eventos()', 'execute') as p`,
        [papel],
      );
      t.igual(p, false, `execute para ${papel}`);
    }
  });

  it("permissões: tabelas novas com RLS, anon sem nada, authenticated só lê, service_role lê e grava (menos conexao_eventos)", async () => {
    const rls = await t.sql(
      `select relname as t, relrowsecurity as r from pg_class
        where oid in ('public.conversa_eventos'::regclass, 'public.conexao_eventos'::regclass, 'public.convites'::regclass) order by 1`,
    );
    t.igual(
      rls,
      [
        { t: "conexao_eventos", r: true },
        { t: "conversa_eventos", r: true },
        { t: "convites", r: true },
      ],
      "RLS ligada",
    );
    const priv = await t.sql(
      `select tb, papel, string_agg(p, ',' order by p) as ps
         from unnest(array['conversa_eventos', 'conexao_eventos', 'convites']) tb,
              unnest(array['anon', 'authenticated', 'service_role']) papel,
              unnest(array['select', 'insert', 'update', 'delete', 'truncate']) p
        where has_table_privilege(papel, 'public.' || tb, p)
        group by 1, 2 order by 1, 2`,
    );
    t.igual(
      priv.map((r) => `${r.tb}/${r.papel}: ${r.ps}`),
      [
        "conexao_eventos/authenticated: select",
        "conexao_eventos/service_role: select",
        "conversa_eventos/authenticated: select",
        "conversa_eventos/service_role: delete,insert,select,truncate,update",
        "convites/authenticated: select",
        "convites/service_role: delete,insert,select,truncate,update",
      ],
      "privilégios",
    );
    // grants por coluna de insert em mensagens para authenticated
    const [g] = await t.sql(
      `select has_column_privilege('authenticated', 'public.mensagens', 'responde_a_id', 'insert') as r,
              has_column_privilege('authenticated', 'public.mensagens', 'midia_duracao_s', 'insert') as d,
              has_column_privilege('anon', 'public.mensagens', 'responde_a_id', 'insert') as a,
              has_column_privilege('authenticated', 'public.mensagens', 'responde_a_id', 'update') as u`,
    );
    t.igual(g, { r: true, d: true, a: false, u: false }, "grant por coluna");
  });
});
