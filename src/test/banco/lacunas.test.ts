// @vitest-environment node
// Lacunas da mensageria (2.1 e 2.4): o gatilho da bolha da
// Nina que falha no envio, mensagens.reenvios, desistir_midia, os limites novos do
// contexto_salvar, o insert direto fechado em contexto_versoes e o envio_falhou no Dashboard.
// O L1 e o L2 já são migrations (0016_nina_lacunas_enums e 0017_nina_lacunas_funcoes). Com uma
// parte só, o teste "montagem" falha dizendo qual falta. O gatilho mensagens_envio_falhou vai num
// envio à parte (L3), depois de publicar as telas que conhecem o motivo envio_falhou: até ele virar
// migration, os testes dele pulam, salvo com o arquivo em NINA_SQL_EXTRA.
import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";
import {
  arquivosExtra,
  arquivosMigrations,
  limparSql,
  montarBase,
  temFuncao,
  temValorEnum,
  TEMPO_TESTE,
  usarBanco,
  type Banco,
} from "./montar";

const base = await montarBase();
const temL1 = temValorEnum(base, "motivo_humano", "envio_falhou");
const temL2 = temFuncao(base, "desistir_midia");
// O gatilho (L3) só existe depois do envio dele.
const temL3 = temFuncao(base, "tg_mensagens_envio_falhou");

// Os arquivos L1, L2 e L3: a migration, ou o arquivo de NINA_SQL_EXTRA enquanto não é migration.
const migrations = await arquivosMigrations();
const extras = arquivosExtra();
const acharArquivo = (parte: string) =>
  migrations.find((a) => basename(a).includes(parte)) ?? extras.find((a) => basename(a).includes(parte));
const arqL1 = acharArquivo("nina_lacunas_enums");
const arqL2 = acharArquivo("nina_lacunas_funcoes");
const arqL3 = acharArquivo("nina_lacunas_gatilho");
// Base sem o L1, para provar as travas: as migrations de antes da do L1, sem NINA_SQL_EXTRA.
const nomeL1 = arqL1 && migrations.includes(arqL1) ? basename(arqL1) : null;
const baseSemL1 =
  arqL1 && arqL2
    ? await montarBase({ semExtra: true, ...(nomeL1 ? { filtroMigrations: (nome: string) => nome < nomeL1 } : {}) })
    : null;
const provaTrava = !!baseSemL1 && !temValorEnum(baseSemL1, "motivo_humano", "envio_falhou");

const DOM = "empresa.exemplo";
const TEL = "5511900000001";

// ---------------------------------------------------------------------------
// ajudantes
// ---------------------------------------------------------------------------

interface Preparo {
  uAdmin: string;
  mAdmin: string;
  uAtend: string;
  mAtend: string;
  cx: string;
}

// Admin (1ª conta), um atendente, conexão Z-API ativa e o onboarding concluído.
async function preparar(t: Banco): Promise<Preparo> {
  const uAdmin = await t.criarUsuario(`admin@${DOM}`, "Admin");
  const [{ id: mAdmin }] = await t.sql("select id from public.membros where user_id = $1", [uAdmin]);
  const uAtend = await t.criarUsuario(`atendente@${DOM}`, "Atendente");
  const [{ id: mAtend }] = await t.sql(
    `insert into public.membros (user_id, nome, email, papel) values ($1, 'Atendente', $2, 'atendente') returning id`,
    [uAtend, `atendente@${DOM}`],
  );
  const [{ id: cx }] = await t.sql(
    `insert into public.conexoes (gateway, nome, id_externo, ativa, status)
     values ('zapi', 'Conexão de teste', 'inst-teste-1', true, 'conectada') returning id`,
  );
  await t.sql("update public.configuracao set onboarding_concluido_em = now() where id = 1");
  return { uAdmin, mAdmin, uAtend, mAtend, cx };
}

let contador = 0;
function msg(extra: Record<string, unknown> = {}) {
  contador += 1;
  return { id_externo: `w-${contador}`, tipo: "texto", texto: `oi ${contador}`, momento: new Date().toISOString(), ...extra };
}

async function entrada(t: Banco, cx: string, m: Record<string, unknown>, tel = TEL) {
  const [r] = await t.como("service_role", null, (q) =>
    q("select * from public.registrar_entrada($1, $2::jsonb, 'Lead de teste', $3::jsonb)", [
      cx,
      JSON.stringify([{ tipo: "telefone", valor: tel }]),
      JSON.stringify(m),
    ]),
  );
  return r as { mensagem_id: string; conversa_id: string };
}

async function vencer(t: Banco, conversa: string) {
  await t.sql("update public.conversas set responder_apos = now() - interval '1 second' where id = $1", [conversa]);
}

const pegarRodadas = (t: Banco) => t.como("service_role", null, (q) => q("select * from public.pegar_rodadas(10)"));

/** Conversa com uma rodada da Nina concluída e as bolhas na fila, já vencidas. Devolve os ids das bolhas. */
async function comBolhasDaNina(t: Banco, b: Preparo, textos: string[], tel = TEL) {
  const e = await entrada(t, b.cx, msg(), tel);
  await vencer(t, e.conversa_id);
  const rs = await pegarRodadas(t);
  t.igual(rs.length, 1, "pegar_rodadas devia criar 1 rodada");
  await t.como("service_role", null, (q) =>
    q("select public.concluir_rodada($1, $2::jsonb, '[]'::jsonb, 1)", [
      rs[0].id,
      JSON.stringify(textos.map((texto) => ({ texto }))),
    ]),
  );
  await t.sql(
    "update public.mensagens set enviar_apos = now() - interval '1 second' where conversa_id = $1 and status = 'na_fila'",
    [e.conversa_id],
  );
  const bolhas = await t.sql(
    "select id from public.mensagens where conversa_id = $1 and origem = 'nina' order by ordem",
    [e.conversa_id],
  );
  t.igual(bolhas.length, textos.length, "bolhas da Nina na fila");
  return { conversa: e.conversa_id, bolhas: bolhas.map((x: { id: string }) => x.id) as string[] };
}

/** Pega envios até a mensagem sair como 'enviando'. */
async function pegarAte(t: Banco, id: string) {
  const env = await t.como("service_role", null, (q) => q("select id from public.pegar_envios(10)"));
  t.ok(
    env.some((x: { id: string }) => x.id === id),
    "a mensagem foi pega para envio",
  );
}

const statusDe = async (t: Banco, id: string) =>
  (await t.sql("select status::text as s, erro from public.mensagens where id = $1", [id]))[0] as {
    s: string;
    erro: string | null;
  };

async function conversa(t: Banco, id: string) {
  const [c] = await t.sql(
    `select modo::text, motivo_humano::text, aguardando_humano_desde, responder_apos
       from public.conversas where id = $1`,
    [id],
  );
  return c as { modo: string; motivo_humano: string | null; aguardando_humano_desde: Date | null; responder_apos: Date | null };
}

async function passagens(t: Banco, conversaId: string) {
  return t.sql(
    "select tipo::text, motivo::text from public.conversa_eventos where conversa_id = $1 order by criado_em, id",
    [conversaId],
  );
}

/** foi_para_equipe da rodada da bolha (null quando a bolha não tem rodada). */
async function foiParaEquipe(t: Banco, bolhaId: string) {
  const [r] = await t.sql(
    `select r.foi_para_equipe as f
       from public.mensagens m left join public.rodadas r on r.id = m.rodada_id
      where m.id = $1`,
    [bolhaId],
  );
  return r.f as boolean | null;
}

/** A conversa foi para a equipe pelo envio que falhou, com um evento só, e a rodada da bolha ficou marcada. */
async function conferirPassou(t: Banco, conversaId: string, bolhaId: string) {
  const c = await conversa(t, conversaId);
  t.igual(c.modo, "humano", "modo");
  t.igual(c.motivo_humano, "envio_falhou", "motivo");
  t.ok(c.aguardando_humano_desde instanceof Date, "aguardando_humano_desde preenchido");
  t.igual(c.responder_apos, null, "responder_apos");
  t.igual(await passagens(t, conversaId), [{ tipo: "passou", motivo: "envio_falhou" }], "evento");
  t.igual(await foiParaEquipe(t, bolhaId), true, "rodada com foi_para_equipe");
}

type Caminho = "falhar_envio" | "sem_resposta_do_envio" | "conexao_inativa" | "falha_no_gateway";
const CAMINHOS: Caminho[] = ["falhar_envio", "sem_resposta_do_envio", "conexao_inativa", "falha_no_gateway"];

/**
 * Leva uma bolha 'na_fila' (já vencida) até 'falhou' pelo caminho dado. `antes` roda logo antes
 * do passo que grava 'falhou' (com a bolha em 'enviando', 'enviada' ou, no conexao_inativa, na fila).
 */
async function falharPor(t: Banco, b: Preparo, id: string, caminho: Caminho, antes: () => Promise<void>) {
  if (caminho === "conexao_inativa") {
    contador += 1;
    const [{ id: velha }] = await t.sql(
      `insert into public.conexoes (gateway, nome, id_externo, ativa, status)
       values ('zapi', 'Conexão antiga', $1, false, 'desconectada') returning id`,
      [`inst-antiga-${contador}`],
    );
    await t.sql("update public.mensagens set conexao_id = $1 where id = $2", [velha, id]);
    await antes();
    await t.como("service_role", null, (q) => q("select id from public.pegar_envios(10)"));
  } else {
    await pegarAte(t, id);
    if (caminho === "falhar_envio") {
      await antes();
      await falharEnvio(t, id, "numero_invalido", true);
    } else if (caminho === "sem_resposta_do_envio") {
      await t.sql(
        "update public.mensagens set tentativas = 3, status_em = now() - interval '3 minutes' where id = $1",
        [id],
      );
      await antes();
      await t.como("service_role", null, (q) => q("select id from public.pegar_envios(10)"));
    } else {
      contador += 1;
      const ext = `ext-${contador}`;
      await t.como("service_role", null, (q) => q("select public.concluir_envio($1, $2, null)", [id, ext]));
      await antes();
      await t.como("service_role", null, (q) => q("select public.atualizar_status($1, $2, 'falhou', now())", [b.cx, ext]));
    }
  }
  t.igual((await statusDe(t, id)).s, "falhou", `${caminho}: a bolha falhou`);
}

async function humanoTela(t: Banco, uid: string, conversaId: string, texto = "pela tela") {
  const [r] = await t.como("authenticated", uid, (q) =>
    q(
      `insert into public.mensagens (id, conversa_id, direcao, origem, texto, status)
       values (gen_random_uuid(), $1, 'saida', 'humano_tela', $2, 'na_fila') returning id`,
      [conversaId, texto],
    ),
  );
  return r.id as string;
}

const falharEnvio = (t: Banco, id: string, erro: string, definitivo: boolean) =>
  t.como("service_role", null, (q) => q("select public.falhar_envio($1, $2, $3)", [id, erro, definitivo]));

const reenviar = (t: Banco, uid: string, id: string) =>
  t.como("authenticated", uid, (q) => q("select public.reenviar_mensagem($1)", [id]));

const salvarContexto = (t: Banco, uid: string, baseId: number | null, mudancas: unknown) =>
  t.como("authenticated", uid, async (q) => {
    const [r] = await q("select public.contexto_salvar($1, $2::jsonb) as r", [baseId, JSON.stringify(mudancas)]);
    return r.r as { id: number; numero: number };
  });

const itens = (n: number, extra: Partial<{ pergunta: string; resposta: string }> = {}) =>
  Array.from({ length: n }, (_, i) => ({ pergunta: `Pergunta ${i + 1}?`, resposta: `Resposta ${i + 1}.`, ...extra }));

// ---------------------------------------------------------------------------
// testes
// ---------------------------------------------------------------------------

// Não pula: com só uma das partes (L1 sem L2, ou L2 sem L1) o banco está quebrado e a suíte
// não pode ficar verde pulando os testes.
describe("banco: lacunas da mensageria (montagem)", () => {
  it("o banco tem o L1 e o L2 juntos, ou nenhum dos dois", () => {
    if (temL1 !== temL2) {
      throw new Error(
        temL1
          ? "o banco tem o valor 'envio_falhou' (L1), mas não as peças do L2 (desistir_midia): falta aplicar o L2"
          : "o banco tem as peças do L2 (desistir_midia), mas não o valor 'envio_falhou' (L1): falta aplicar o L1",
      );
    }
  });
});

// A trava do começo do L2 e do L3, num banco montado só até antes da migration do L1.
describe.skipIf(!provaTrava)("banco: trava do L2 sem o L1", { timeout: TEMPO_TESTE }, () => {
  const t = usarBanco(baseSemL1!);

  const comoDono = async (texto: string) => {
    await t.db.exec("set role dono_app");
    try {
      await t.db.exec(texto);
    } catch (e) {
      try {
        await t.db.exec("rollback");
      } catch {
        /* sem transação */
      }
      throw e;
    } finally {
      await t.db.exec("reset role");
    }
  };

  it("o L2 sozinho é recusado e não deixa nada aplicado", async () => {
    await t.erro(t.aplicar(arqL2!), "falta_o_L1_envio_falhou");
    const [r] = await t.sql(
      `select to_regprocedure('public.desistir_midia(uuid, text)') is null as sem_funcao,
              not exists (select 1 from information_schema.columns
                           where table_schema = 'public' and table_name = 'mensagens'
                             and column_name = 'reenvios') as sem_coluna,
              not exists (select 1 from pg_trigger where tgname = 'mensagens_envio_falhou') as sem_gatilho`,
    );
    t.igual(r, { sem_funcao: true, sem_coluna: true, sem_gatilho: true });
  });

  it.skipIf(!arqL3)("o L3 sozinho também é recusado sem o L1 e não deixa o gatilho", async () => {
    await t.erro(t.aplicar(arqL3!), "falta_o_L1_envio_falhou");
    const [r] = await t.sql(
      `select not exists (select 1 from pg_trigger where tgname = 'mensagens_envio_falhou') as sem_gatilho`,
    );
    t.igual(r, { sem_gatilho: true });
  });

  it("o L1, o L2 (e o L3, se veio) na mesma transação (o caso do remix) passam pela trava e funcionam", async () => {
    const partes = [arqL1!, arqL2!, ...(arqL3 ? [arqL3] : [])];
    const texto = ["begin;", ...(await Promise.all(partes.map(async (a) => limparSql(await readFile(a, "utf8"))))), "commit;"].join(
      "\n",
    );
    await comoDono(texto);
    const [r] = await t.sql(`select to_regprocedure('public.desistir_midia(uuid, text)') is not null as tem_desistir`);
    t.igual(r, { tem_desistir: true });
    if (!arqL3) return;
    const b = await preparar(t);
    const x = await comBolhasDaNina(t, b, ["Olá!"]);
    const id = x.bolhas[0]!;
    await pegarAte(t, id);
    await falharEnvio(t, id, "numero_invalido", true);
    await conferirPassou(t, x.conversa, id);
  });
});

describe("banco: lacunas da mensageria", { timeout: TEMPO_TESTE }, () => {
  const t = usarBanco(base);

  // ------------------------------------------------- gatilho mensagens_envio_falhou (L3)
  describe.skipIf(!temL3)("bolha da Nina que falha de vez vai para a equipe", () => {
    it("pelo falhar_envio definitivo", async () => {
      const b = await preparar(t);
      const x = await comBolhasDaNina(t, b, ["Olá!"]);
      const id = x.bolhas[0]!;
      await pegarAte(t, id);
      await falharEnvio(t, id, "numero_invalido", true);
      t.igual(await statusDe(t, id), { s: "falhou", erro: "numero_invalido" });
      await conferirPassou(t, x.conversa, x.bolhas[0]!);
    });

    it("pelo falhar_envio passageiro só na 3ª tentativa", async () => {
      const b = await preparar(t);
      const x = await comBolhasDaNina(t, b, ["Olá!"]);
      const id = x.bolhas[0]!;
      for (let i = 1; i <= 2; i++) {
        await pegarAte(t, id);
        await falharEnvio(t, id, "http_429", false);
        t.igual((await statusDe(t, id)).s, "na_fila", `tentativa ${i} volta para a fila`);
        t.igual((await conversa(t, x.conversa)).modo, "nina", `tentativa ${i}: conversa continua com a Nina`);
        await t.sql("update public.mensagens set enviar_apos = now() - interval '1 second' where id = $1", [id]);
      }
      await pegarAte(t, id);
      await falharEnvio(t, id, "http_429", false);
      t.igual((await statusDe(t, id)).s, "falhou");
      await conferirPassou(t, x.conversa, x.bolhas[0]!);
    });

    it("pelo pegar_envios: presa em enviando na 3ª tentativa (sem_resposta_do_envio)", async () => {
      const b = await preparar(t);
      const x = await comBolhasDaNina(t, b, ["Olá!"]);
      const id = x.bolhas[0]!;
      await pegarAte(t, id);
      await t.sql(
        "update public.mensagens set tentativas = 3, status_em = now() - interval '3 minutes' where id = $1",
        [id],
      );
      await t.como("service_role", null, (q) => q("select id from public.pegar_envios(10)"));
      t.igual(await statusDe(t, id), { s: "falhou", erro: "sem_resposta_do_envio" });
      await conferirPassou(t, x.conversa, x.bolhas[0]!);
    });

    it("pelo pegar_envios: na fila de uma conexão desativada (conexao_inativa)", async () => {
      const b = await preparar(t);
      const x = await comBolhasDaNina(t, b, ["Olá!"]);
      const id = x.bolhas[0]!;
      const [{ id: velha }] = await t.sql(
        `insert into public.conexoes (gateway, nome, id_externo, ativa, status)
         values ('zapi', 'Conexão antiga', 'inst-antiga', false, 'desconectada') returning id`,
      );
      await t.sql("update public.mensagens set conexao_id = $1 where id = $2", [velha, id]);
      await t.como("service_role", null, (q) => q("select id from public.pegar_envios(10)"));
      t.igual(await statusDe(t, id), { s: "falhou", erro: "conexao_inativa" });
      await conferirPassou(t, x.conversa, x.bolhas[0]!);
    });

    it("pelo atualizar_status: o gateway avisa que não entregou (falha_no_gateway)", async () => {
      const b = await preparar(t);
      const x = await comBolhasDaNina(t, b, ["Olá!"]);
      const id = x.bolhas[0]!;
      await pegarAte(t, id);
      await t.como("service_role", null, (q) => q("select public.concluir_envio($1, 'ext-nina-1', null)", [id]));
      t.igual((await statusDe(t, id)).s, "enviada");
      t.igual((await conversa(t, x.conversa)).modo, "nina", "enviada não mexe na conversa");
      const [{ n }] = await t.como("service_role", null, (q) =>
        q("select public.atualizar_status($1, 'ext-nina-1', 'falhou', now()) as n", [b.cx]),
      );
      t.igual(n, 1, "casou com a bolha");
      t.igual(await statusDe(t, id), { s: "falhou", erro: "falha_no_gateway" });
      await conferirPassou(t, x.conversa, x.bolhas[0]!);
    });

    it("duas bolhas que falham geram uma passagem só", async () => {
      const b = await preparar(t);
      const x = await comBolhasDaNina(t, b, ["Olá!", "Tudo bem?"]);
      await t.sql(
        "update public.mensagens set status = 'enviando', tentativas = 1, status_em = now() where id = any($1::uuid[])",
        [x.bolhas],
      );
      for (const id of x.bolhas) await falharEnvio(t, id, "numero_invalido", true);
      for (const id of x.bolhas) t.igual((await statusDe(t, id)).s, "falhou");
      await conferirPassou(t, x.conversa, x.bolhas[0]!);
    });

    it("limpa o responder_apos que o lead armou depois da rodada", async () => {
      const b = await preparar(t);
      const x = await comBolhasDaNina(t, b, ["Olá!"]);
      const id = x.bolhas[0]!;
      await pegarAte(t, id);
      // o lead escreve de novo antes da falha: isso arma a próxima rodada
      await entrada(t, b.cx, msg());
      t.ok((await conversa(t, x.conversa)).responder_apos instanceof Date, "responder_apos armado antes da falha");
      await falharEnvio(t, id, "numero_invalido", true);
      await conferirPassou(t, x.conversa, id);
      t.igual((await pegarRodadas(t)).length, 0, "a Nina não responde o lead depois da falha");
    });

    it("a Nina para nela: a bolha seguinte, ainda na fila, é cancelada e não sai", async () => {
      const b = await preparar(t);
      const x = await comBolhasDaNina(t, b, ["Olá!", "Tudo bem?"]);
      const [b1, b2] = x.bolhas as [string, string];
      await pegarAte(t, b1);
      t.igual((await statusDe(t, b2)).s, "na_fila", "2ª bolha esperando a 1ª");
      await falharEnvio(t, b1, "numero_invalido", true);
      t.igual((await statusDe(t, b2)).s, "cancelada", "2ª bolha cancelada");
      await conferirPassou(t, x.conversa, b1);
      t.igual(await t.como("service_role", null, (q) => q("select id from public.pegar_envios(10)")), [], "nada sai");
    });

    it("a Nina para nela também quando a falha vem do próprio pegar_envios", async () => {
      const b = await preparar(t);
      const x = await comBolhasDaNina(t, b, ["Olá!", "Tudo bem?"]);
      const [b1, b2] = x.bolhas as [string, string];
      await pegarAte(t, b1);
      await t.sql(
        "update public.mensagens set tentativas = 3, status_em = now() - interval '3 minutes' where id = $1",
        [b1],
      );
      // a mesma chamada marca a 1ª como falhou e não pode pegar a 2ª
      const pegas = await t.como("service_role", null, (q) => q("select id from public.pegar_envios(10)"));
      t.igual(pegas, [], "o pegar_envios não pegou a 2ª bolha");
      t.igual(await statusDe(t, b1), { s: "falhou", erro: "sem_resposta_do_envio" });
      t.igual((await statusDe(t, b2)).s, "cancelada", "2ª bolha cancelada");
      await conferirPassou(t, x.conversa, b1);
    });

    it("a Nina para só na conversa da bolha que falhou: a fila de outra conversa segue", async () => {
      const b = await preparar(t);
      const x = await comBolhasDaNina(t, b, ["Olá!", "Tudo bem?"]);
      const y = await comBolhasDaNina(t, b, ["Oi!", "Como vai?"], "5511900000002");
      const [x1, x2] = x.bolhas as [string, string];
      const [y1, y2] = y.bolhas as [string, string];
      // a mesma passada pega a 1ª bolha de cada conversa
      await pegarAte(t, x1);
      t.igual((await statusDe(t, y1)).s, "enviando", "1ª bolha da outra conversa no envio");
      await falharEnvio(t, x1, "numero_invalido", true);
      t.igual((await statusDe(t, x2)).s, "cancelada", "2ª bolha da conversa que falhou cancelada");
      await conferirPassou(t, x.conversa, x1);
      t.igual((await statusDe(t, y2)).s, "na_fila", "2ª bolha da outra conversa continua na fila");
      const c = await conversa(t, y.conversa);
      t.igual([c.modo, c.motivo_humano], ["nina", null], "a outra conversa continua com a Nina");
      t.igual(await passagens(t, y.conversa), [], "sem evento na outra conversa");
      await t.como("service_role", null, (q) =>
        q("select public.concluir_envio($1, 'ext-outra-1', null)", [y1]),
      );
      const env = await t.como("service_role", null, (q) =>
        q("select id from public.pegar_envios(10)"),
      );
      t.igual(
        env.map((m: { id: string }) => m.id),
        [y2],
        "a 2ª bolha da outra conversa sai",
      );
    });

    it("a Nina para nela: a rodada que já roda na conversa é cancelada e a despedida dela não sai", async () => {
      const b = await preparar(t);
      const x = await comBolhasDaNina(t, b, ["Olá!"]);
      const id = x.bolhas[0]!;
      await pegarAte(t, id);
      // o lead escreve de novo com a bolha ainda no envio, e a Nina já começa a responder (R2)
      const e2 = await entrada(t, b.cx, msg());
      await vencer(t, x.conversa);
      const rs = await pegarRodadas(t);
      t.igual(rs.length, 1, "R2 rodando");
      const r2 = rs[0].id as string;
      await falharEnvio(t, id, "numero_invalido", true);
      await conferirPassou(t, x.conversa, id);
      const [r] = await t.sql(
        "select status::text as s, terminada_em from public.rodadas where id = $1",
        [r2],
      );
      t.igual(r.s, "cancelada", "R2 cancelada");
      t.ok(r.terminada_em instanceof Date, "R2 com terminada_em");
      const [m] = await t.sql("select rodada_id from public.mensagens where id = $1", [
        e2.mensagem_id,
      ]);
      t.igual(m.rodada_id, null, "a entrada solta da R2");
      // a ferramenta da R2 não vale mais e a despedida dela entra cancelada
      await t.erro(
        t.como("service_role", null, (q) => q("select public.nina_passar_para_humano($1)", [r2])),
        "rodada_nao_rodando",
      );
      await t.como("service_role", null, (q) =>
        q("select public.concluir_rodada($1, $2::jsonb, '[]'::jsonb, 1)", [
          r2,
          JSON.stringify([{ texto: "Vou te passar para a equipe" }]),
        ]),
      );
      await t.sql(
        "update public.mensagens set enviar_apos = now() - interval '1 second' where conversa_id = $1",
        [x.conversa],
      );
      t.igual(
        await t.como("service_role", null, (q) => q("select id from public.pegar_envios(10)")),
        [],
        "nada sai",
      );
      t.igual(
        await passagens(t, x.conversa),
        [{ tipo: "passou", motivo: "envio_falhou" }],
        "um evento só",
      );
    });

    it("a mesma bolha regravada como falhou depois do Devolver não passa de novo", async () => {
      const b = await preparar(t);
      const x = await comBolhasDaNina(t, b, ["Olá!"]);
      const id = x.bolhas[0]!;
      await pegarAte(t, id);
      await falharEnvio(t, id, "numero_invalido", true);
      await conferirPassou(t, x.conversa, id);
      await t.como("authenticated", b.uAtend, (q) => q("select public.devolver_para_nina($1)", [x.conversa]));
      t.igual((await conversa(t, x.conversa)).modo, "nina", "devolvida");
      // concluir_envio atrasado: regrava status = 'falhou' na mesma bolha (old.status já era 'falhou')
      await t.como("service_role", null, (q) => q("select public.concluir_envio($1, 'ext-atrasado', null)", [id]));
      t.igual(await statusDe(t, id), { s: "falhou", erro: "numero_invalido" });
      const c = await conversa(t, x.conversa);
      t.igual([c.modo, c.motivo_humano], ["nina", null], "continua com a Nina");
      t.igual(
        await passagens(t, x.conversa),
        [
          { tipo: "passou", motivo: "envio_falhou" },
          { tipo: "devolveu", motivo: null },
        ],
        "um envio_falhou só",
      );
    });

    it.each(CAMINHOS)("bolha da equipe que falha não mexe na conversa (%s)", async (caminho) => {
      const b = await preparar(t);
      const e = await entrada(t, b.cx, msg());
      const id = await humanoTela(t, b.uAtend, e.conversa_id);
      // volta a conversa para a Nina à mão, para provar que o gatilho olha a origem
      await t.sql(
        "update public.conversas set modo = 'nina', motivo_humano = null, aguardando_humano_desde = null where id = $1",
        [e.conversa_id],
      );
      const antes = await passagens(t, e.conversa_id);
      await falharPor(t, b, id, caminho, async () => {});
      const c = await conversa(t, e.conversa_id);
      t.igual([c.modo, c.motivo_humano], ["nina", null], "conversa igual");
      t.igual(await passagens(t, e.conversa_id), antes, "sem evento novo");
    });

    it.each(CAMINHOS)("bolha da Nina com a conversa fora do modo nina fica como está (%s)", async (caminho) => {
      const b = await preparar(t);
      const x = await comBolhasDaNina(t, b, ["Olá!"]);
      const id = x.bolhas[0]!;
      let antes: Awaited<ReturnType<typeof conversa>> | null = null;
      let evAntes: unknown[] = [];
      await falharPor(t, b, id, caminho, async () => {
        // a conversa já está com a equipe, sem cancelar a bolha (como quando outra passagem
        // não cancela a fila)
        await t.sql(
          `update public.conversas
              set modo = 'humano', responsavel_id = $2, motivo_humano = 'humano_tela',
                  aguardando_humano_desde = null, responder_apos = null
            where id = $1`,
          [x.conversa, b.mAtend],
        );
        antes = await conversa(t, x.conversa);
        evAntes = await passagens(t, x.conversa);
      });
      t.igual(await conversa(t, x.conversa), antes, "conversa igual");
      t.igual(await passagens(t, x.conversa), evAntes, "sem evento novo");
      t.igual(await foiParaEquipe(t, id), false, "rodada sem foi_para_equipe");
    });

    it("conversa fora do modo nina (a equipe assumiu) fica como está", async () => {
      const b = await preparar(t);
      const x = await comBolhasDaNina(t, b, ["Olá!"]);
      const id = x.bolhas[0]!;
      await pegarAte(t, id);
      await t.como("authenticated", b.uAtend, (q) => q("select public.assumir_conversa($1)", [x.conversa]));
      const antes = await conversa(t, x.conversa);
      t.igual(antes.modo, "humano");
      const evAntes = await passagens(t, x.conversa);
      await falharEnvio(t, id, "numero_invalido", true);
      t.igual((await statusDe(t, id)).s, "falhou");
      t.igual(await conversa(t, x.conversa), antes, "conversa igual");
      t.igual(await passagens(t, x.conversa), evAntes, "sem evento novo");
      t.ok(!evAntes.some((ev: { motivo: string | null }) => ev.motivo === "envio_falhou"), "nenhum envio_falhou");
      t.igual(await foiParaEquipe(t, id), false, "rodada sem foi_para_equipe");
    });

    it("o gatilho tem a forma combinada", async () => {
      const [g] = await t.sql(
        `select pg_get_triggerdef(tg.oid) as def, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as dono
           from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
          where tg.tgname = 'mensagens_envio_falhou' and tg.tgrelid = 'public.mensagens'::regclass`,
      );
      t.ok(g, "gatilho existe");
      t.ok(/AFTER UPDATE OF status ON public\.mensagens FOR EACH ROW WHEN/i.test(g.def), `definição: ${g.def}`);
      t.ok(g.def.includes("tg_mensagens_envio_falhou()"), "chama a função");
      t.igual([g.prosecdef, g.proconfig, g.dono], [true, ["search_path=\"\""], "dono_app"]);
      const [p] = await t.sql(
        `select has_function_privilege('anon', 'public.tg_mensagens_envio_falhou()', 'execute') as anon,
                has_function_privilege('authenticated', 'public.tg_mensagens_envio_falhou()', 'execute') as auth`,
      );
      t.igual(p, { anon: false, auth: false });
    });
  });

  // ------------------------------------------------- reenvios
  describe("mensagens.reenvios", () => {
    it("nasce 0 e o reenviar_mensagem soma 1 a cada Tentar de novo", async () => {
      const b = await preparar(t);
      const e = await entrada(t, b.cx, msg());
      const id = await humanoTela(t, b.uAtend, e.conversa_id);
      const reenvios = async () => (await t.sql("select reenvios, tentativas from public.mensagens where id = $1", [id]))[0];
      t.igual(await reenvios(), { reenvios: 0, tentativas: 0 });
      for (let n = 1; n <= 2; n++) {
        await pegarAte(t, id);
        await falharEnvio(t, id, "sem_destino", true);
        await reenviar(t, b.uAtend, id);
        t.igual(await reenvios(), { reenvios: n, tentativas: 0 }, `reenvio ${n}`);
        t.igual((await statusDe(t, id)).s, "na_fila");
      }
      // as tentativas automáticas não mexem nele
      await t.sql("update public.mensagens set enviar_apos = now() - interval '1 second' where id = $1", [id]);
      await pegarAte(t, id);
      await falharEnvio(t, id, "http_429", false);
      t.igual((await reenvios()).reenvios, 2, "tentativa automática não conta");
    });

    it("não aceita valor negativo e a tela não grava a coluna", async () => {
      const b = await preparar(t);
      const e = await entrada(t, b.cx, msg());
      const id = await humanoTela(t, b.uAtend, e.conversa_id);
      await t.erro(t.sql("update public.mensagens set reenvios = -1 where id = $1", [id]), "23514");
      await t.erro(
        t.como("authenticated", b.uAtend, (q) =>
          q(
            `insert into public.mensagens (id, conversa_id, direcao, origem, texto, status, reenvios)
             values (gen_random_uuid(), $1, 'saida', 'humano_tela', 'x', 'na_fila', 5)`,
            [e.conversa_id],
          ),
        ),
        "42501",
      );
      // a tela lê a coluna
      const lido = await t.como("authenticated", b.uAtend, (q) =>
        q("select reenvios from public.mensagens where id = $1", [id]),
      );
      t.igual(lido, [{ reenvios: 0 }]);
    });

    it("a bolha da Nina que falhou continua sem Tentar de novo", async () => {
      const b = await preparar(t);
      const x = await comBolhasDaNina(t, b, ["Olá!"]);
      const id = x.bolhas[0]!;
      await pegarAte(t, id);
      await falharEnvio(t, id, "numero_invalido", true);
      await t.erro(reenviar(t, b.uAdmin, id), "nao_reenviavel");
      t.igual((await t.sql("select reenvios from public.mensagens where id = $1", [id]))[0].reenvios, 0);
    });
  });

  // ------------------------------------------------- desistir_midia
  describe("desistir_midia", () => {
    async function audioPendente(t: Banco, b: Preparo) {
      const e = await entrada(t, b.cx, msg({ tipo: "audio", texto: null, midia_ref_externa: "ref-audio-1" }));
      const [m] = await t.sql(
        "select midia_status::text, midia_tentativas, erro from public.mensagens where id = $1",
        [e.mensagem_id],
      );
      t.igual(m, { midia_status: "pendente", midia_tentativas: 0, erro: null }, "áudio pendente");
      return e;
    }

    const desistir = (t: Banco, id: string, erro = "midia_grande_demais") =>
      t.como("service_role", null, (q) => q("select public.desistir_midia($1, $2)", [id, erro]));

    const midia = async (t: Banco, id: string) =>
      (
        await t.sql(
          "select midia_status::text, midia_tentativas, midia_pega_em, erro from public.mensagens where id = $1",
          [id],
        )
      )[0];

    it("mídia pendente vira falhou na hora, sem gastar tentativa", async () => {
      const b = await preparar(t);
      const e = await audioPendente(t, b);
      await desistir(t, e.mensagem_id);
      t.igual(await midia(t, e.mensagem_id), {
        midia_status: "falhou",
        midia_tentativas: 0,
        midia_pega_em: null,
        erro: "midia_grande_demais",
      });
    });

    it("depois de pega pelo pegar_midias: solta a trava e não soma tentativa", async () => {
      const b = await preparar(t);
      const e = await audioPendente(t, b);
      const pegas = await t.como("service_role", null, (q) => q("select id from public.pegar_midias(10)"));
      t.igual(pegas.map((x: { id: string }) => x.id), [e.mensagem_id]);
      await desistir(t, e.mensagem_id);
      const m = await midia(t, e.mensagem_id);
      t.igual([m.midia_status, m.midia_tentativas, m.midia_pega_em], ["falhou", 1, null]);
      // não volta para a fila de cópia
      t.igual(await t.como("service_role", null, (q) => q("select id from public.pegar_midias(10)")), []);
    });

    it("a conversa não espera mais a mídia: pegar_rodadas já cria a rodada", async () => {
      const b = await preparar(t);
      const e = await audioPendente(t, b);
      await vencer(t, e.conversa_id);
      t.igual((await pegarRodadas(t)).length, 0, "com a mídia pendente, espera");
      await desistir(t, e.mensagem_id);
      t.igual((await pegarRodadas(t)).length, 1, "sem a mídia pendente, cria a rodada");
    });

    it("mídia já copiada fica como está; mensagem que não existe dá erro", async () => {
      const b = await preparar(t);
      const e = await audioPendente(t, b);
      await t.como("service_role", null, (q) =>
        q("select public.concluir_midia($1, 'c/1', 'audio/ogg', 10, true)", [e.mensagem_id]),
      );
      await desistir(t, e.mensagem_id);
      const m = await midia(t, e.mensagem_id);
      t.igual([m.midia_status, m.erro], ["copiada", null]);
      await t.erro(desistir(t, "00000000-0000-0000-0000-000000000000"), "mensagem_nao_encontrada");
    });

    it("só o servidor chama; forma igual às outras funções da fila", async () => {
      const b = await preparar(t);
      const e = await audioPendente(t, b);
      await t.erro(
        t.como("authenticated", b.uAdmin, (q) => q("select public.desistir_midia($1, 'x')", [e.mensagem_id])),
        "42501",
      );
      await t.erro(t.como("anon", null, (q) => q("select public.desistir_midia($1, 'x')", [e.mensagem_id])), "42501");
      const [f] = await t.sql(
        `select pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as res,
                p.prosecdef, p.proconfig
           from pg_proc p where p.oid = 'public.desistir_midia(uuid, text)'::regprocedure`,
      );
      t.igual(f, { args: "p_msg uuid, p_erro text", res: "void", prosecdef: true, proconfig: ['search_path=""'] });
      const [p] = await t.sql(
        `select has_function_privilege('public', 'public.desistir_midia(uuid, text)', 'execute') as pub,
                has_function_privilege('service_role', 'public.desistir_midia(uuid, text)', 'execute') as srv`,
      );
      t.igual(p, { pub: false, srv: true }, "só o service_role executa");
    });
  });

  // ------------------------------------------------- contexto_salvar e contexto_versoes
  describe("Contexto", () => {
    it("a pergunta de um item livre tem o limite de 2.000 letras", async () => {
      const b = await preparar(t);
      await t.erro(salvarContexto(t, b.uAdmin, null, { itens: itens(1, { pergunta: "a".repeat(2001) }) }), "limite_tamanho");
      const r = await salvarContexto(t, b.uAdmin, null, { itens: itens(1, { pergunta: "a".repeat(2000) }) });
      t.igual(r.numero, 1, "2.000 letras passa");
      // a resposta continua com o limite
      await t.erro(salvarContexto(t, b.uAdmin, r.id, { itens: itens(1, { resposta: "b".repeat(2001) }) }), "limite_tamanho");
    });

    it("no máximo 50 itens livres: o 51º dá limite_itens", async () => {
      const b = await preparar(t);
      const r = await salvarContexto(t, b.uAdmin, null, { itens: itens(50) });
      t.igual(r.numero, 1, "50 itens passa");
      await t.erro(salvarContexto(t, b.uAdmin, r.id, { itens: itens(51) }), "limite_itens");
      const [{ n, numero }] = await t.sql(
        "select count(*)::int as n, max(numero) as numero from public.contexto_versoes",
      );
      t.igual([n, numero], [1, 1], "a recusa não grava versão nem gasta número");
    });

    it("insert direto em contexto_versoes é recusado para authenticated; as funções continuam gravando", async () => {
      const b = await preparar(t);
      await t.erro(
        t.como("authenticated", b.uAdmin, (q) =>
          q(
            `insert into public.contexto_versoes (empresa_oferta, itens, origem, criado_por)
             values ('direto', '[]'::jsonb, 'edicao', $1)`,
            [b.mAdmin],
          ),
        ),
        "42501",
      );
      const v1 = await salvarContexto(t, b.uAdmin, null, { empresa_oferta: "Loja de teste" });
      const v2 = await salvarContexto(t, b.uAdmin, v1.id, { preco: "R$ 10" });
      t.igual([v1.numero, v2.numero], [1, 2]);
      const restaurada = await t.como("authenticated", b.uAdmin, async (q) => {
        const [r] = await q("select public.contexto_restaurar($1) as r", [v1.id]);
        return r.r as { id: number; numero: number };
      });
      t.igual(restaurada.numero, 3, "contexto_restaurar grava");
      const [priv] = await t.sql(
        `select has_table_privilege('authenticated', 'public.contexto_versoes', 'insert') as tabela,
                has_column_privilege('authenticated', 'public.contexto_versoes', 'empresa_oferta', 'insert') as coluna,
                has_table_privilege('authenticated', 'public.contexto_versoes', 'select') as le,
                (select count(*)::int from pg_policies
                  where schemaname = 'public' and tablename = 'contexto_versoes'
                    and policyname = 'contexto_versoes_admin_insere') as policy`,
      );
      t.igual(priv, { tabela: false, coluna: false, le: true, policy: 0 });
      // a leitura do membro continua
      const lidas = await t.como("authenticated", b.uAtend, (q) => q("select numero from public.contexto_versoes order by numero"));
      t.igual(lidas, [{ numero: 1 }, { numero: 2 }, { numero: 3 }]);
    });
  });

  // ------------------------------------------------- dashboard_periodo
  describe("dashboard_periodo", () => {
    it("conta envio_falhou como falha, não como a Nina decidiu", async () => {
      const b = await preparar(t);
      const x = await comBolhasDaNina(t, b, ["Olá!"]);
      // A passagem do envio_falhou gravada direto (o gatilho que a cria é do L3, com teste
      // próprio), mais uma falha antiga e duas decisões da Nina, na mesma janela.
      await t.sql(
        `insert into public.conversa_eventos (conversa_id, tipo, motivo)
         values ($1, 'passou', 'envio_falhou'), ($1, 'passou', 'erro_provedor'),
                ($1, 'passou', 'nina_passou'), ($1, 'passou', null)`,
        [x.conversa],
      );
      const [{ r }] = await t.como("authenticated", b.uAdmin, (q) =>
        q("select public.dashboard_periodo(now() - interval '1 day', now() + interval '1 hour', null) as r"),
      );
      t.igual(r.passados, {
        falha: 2,
        ninaPassou: 2,
        porMotivo: { envio_falhou: 1, erro_provedor: 1, nina_passou: 1 },
      });
    });

    it("mantém a assinatura, o security definer e as permissões", async () => {
      const [f] = await t.sql(
        `select pg_get_function_result(p.oid) as res, p.prosecdef, p.proconfig, p.provolatile,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth
           from pg_proc p
          where p.oid = 'public.dashboard_periodo(timestamptz, timestamptz, timestamptz)'::regprocedure`,
      );
      t.igual(f, { res: "jsonb", prosecdef: true, proconfig: ['search_path=""'], provolatile: "s", anon: false, auth: true });
    });
  });
});
