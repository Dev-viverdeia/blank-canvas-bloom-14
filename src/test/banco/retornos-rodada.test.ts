// @vitest-environment node
// Retornos da Nina , o fim da rodada que leva um retorno ou um lembrete:
// - nina_retornos_rodada: concluir_rodada e falhar_rodada recriadas e o gatilho das bolhas
//   (mensagens_saida_do_retorno);
// - nina_retornos_relogio: a versão do relógio na preparar_copia;
// - nina_retornos_dashboard: o tempo de resposta do Dashboard.
// A rodada sem retorno_id (toda rodada do servidor publicado) é coberta pelos testes de hoje
// (conversa-antigo, conversa, lacunas, ligacoes-*, motor), que rodam sem mudança com os envios.
// Aqui, o caminho novo, com a rodada montada à mão: quem escolhe a rodada (a
// pegar_rodadas_com_retornos) fica em retornos.test.ts.
// Até os envios virarem migrations, os testes pulam, salvo com os arquivos em NINA_SQL_EXTRA.
import { basename } from "node:path";
import { describe, it } from "vitest";
import {
  arquivosExtra,
  arquivosMigrations,
  montarBase,
  temFuncao,
  TEMPO_TESTE,
  usarBanco,
  type Banco,
  type Linha,
} from "./montar";

const base = await montarBase();
const migrations = await arquivosMigrations();
const extras = arquivosExtra();
const acharArquivo = (parte: string) =>
  migrations.find((a) => basename(a).includes(parte)) ??
  extras.find((a) => basename(a).includes(parte));
// O nina_retornos_rodada cria a função do gatilho das bolhas; o nina_retornos_relogio e o
// nina_retornos_dashboard só recriam funções que já existem. A relogio_retornos é do
// nina_retornos_funcoes: com ela, o arquivo do nina_retornos_relogio diz se a preparar_copia é a
// nova. Depois da volta atrás pesada (nina_retornos_desfazer), o fim da rodada volta ao de antes e
// os testes do nina_retornos_rodada pulam (se o nina_retornos_funcoes e o nina_retornos_rodada
// forem reaplicados depois dela, rever esta regra).
const temRodada =
  temFuncao(base, "tg_mensagens_saida_do_retorno") && !acharArquivo("nina_retornos_desfazer");
const temRelogio = temFuncao(base, "relogio_retornos") && !!acharArquivo("nina_retornos_relogio");
const temDashboard = !!acharArquivo("nina_retornos_dashboard");

// ---------------------------------------------------------------------------
// ajudantes
// ---------------------------------------------------------------------------

let contador = 0;

/** Registra uma mensagem do lead pela função do webhook (arma a conversa, como no real). */
async function entrada(t: Banco, cx: string) {
  contador += 1;
  const [r] = await t.como("service_role", null, (q) =>
    q("select * from public.registrar_entrada($1, $2::jsonb, 'Lead de teste', $3::jsonb)", [
      cx,
      JSON.stringify([{ tipo: "telefone", valor: "5511900000001" }]),
      JSON.stringify({
        id_externo: `w-${contador}`,
        tipo: "texto",
        texto: `oi ${contador}`,
        momento: new Date().toISOString(),
      }),
    ]),
  );
  return r as { mensagem_id: string; conversa_id: string };
}

interface Cena {
  admin: string;
  cx: string;
  conversa: string;
  entrada: string;
}

/** Admin (1ª conta), Z-API ativa e conectada, onboarding concluído e uma conversa já respondida. */
async function cena(t: Banco): Promise<Cena> {
  const admin = await t.criarUsuario("admin@empresa.exemplo", "Admin");
  const [{ id: cx }] = await t.sql(
    `insert into public.conexoes (gateway, nome, id_externo, ativa, status)
     values ('zapi', 'Conexão de teste', 'inst-teste-1', true, 'conectada') returning id`,
  );
  await t.sql("update public.configuracao set onboarding_concluido_em = now() where id = 1");
  const e = await entrada(t, cx);
  // a conversa já foi respondida: nada armado (a rodada de retorno puro só nasce assim)
  await t.sql("update public.conversas set responder_apos = null where id = $1", [e.conversa_id]);
  return { admin, cx, conversa: e.conversa_id, entrada: e.mensagem_id };
}

/**
 * Uma rodada rodando que leva um retorno (ou lembrete) em_rodada, vencido há 1 min e com 1 h de
 * prazo. Mista = as entradas do lead ligadas à rodada (a faixa 0 levou o retorno junto).
 */
async function rodadaCom(
  t: Banco,
  conversa: string,
  tipo: "retorno" | "lembrete",
  opcoes: { mista?: boolean; iniciada?: string } = {},
) {
  const [{ id: retorno }] = await t.sql("select gen_random_uuid() as id");
  const [{ id: rodada }] = await t.sql(
    `insert into public.rodadas (conversa_id, status, retorno_id, iniciada_em)
     values ($1, 'rodando', $2, ${opcoes.iniciada ?? "now()"}) returning id`,
    [conversa, retorno],
  );
  await t.sql(
    `insert into public.retornos (id, conversa_id, tipo, status, vence_em, expira_em, motivo,
                                  rodada_id, tentativas)
     values ($1, $2, $3::public.retorno_tipo, 'em_rodada', now() - interval '1 minute',
             now() + interval '1 hour', $4, $5, 1)`,
    [retorno, conversa, tipo, tipo === "retorno" ? "mandar a proposta" : null, rodada],
  );
  if (opcoes.mista) {
    await t.sql(
      "update public.mensagens set rodada_id = $1 where conversa_id = $2 and direcao = 'entrada'",
      [rodada, conversa],
    );
  }
  return { rodada: rodada as string, retorno: retorno as string };
}

const concluir = (t: Banco, rodada: string, textos: string[], passos = 1) =>
  t.como("service_role", null, (q) =>
    q("select public.concluir_rodada($1, $2::jsonb, '[]'::jsonb, $3)", [
      rodada,
      JSON.stringify(textos.map((texto) => ({ texto }))),
      passos,
    ]),
  );

const falhar = (t: Banco, rodada: string, motivo: string, passageiro: boolean) =>
  t.como("service_role", null, (q) =>
    q("select public.falhar_rodada($1, $2::public.motivo_humano, $3)", [
      rodada,
      motivo,
      passageiro,
    ]),
  );

async function retorno(t: Banco, id: string) {
  const [r] = await t.sql(
    `select status::text as status, nao_enviado_motivo, rodada_id, tentar_apos, enviado_em, resolvido_em
       from public.retornos where id = $1`,
    [id],
  );
  return r as Linha;
}

async function conversaDe(t: Banco, id: string) {
  const [c] = await t.sql(
    "select modo::text as modo, motivo_humano::text as motivo, responder_apos from public.conversas where id = $1",
    [id],
  );
  return c as Linha;
}

async function statusRodada(t: Banco, id: string) {
  const [r] = await t.sql(
    "select status::text as s, foi_para_equipe as equipe from public.rodadas where id = $1",
    [id],
  );
  return r as Linha;
}

const bolhas = (t: Banco, rodada: string) =>
  t.sql(
    "select id, status::text as status from public.mensagens where rodada_id = $1 and direcao = 'saida' order by ordem",
    [rodada],
  );

const eventos = (t: Banco, conversa: string) =>
  t.sql("select tipo::text, motivo::text from public.conversa_eventos where conversa_id = $1", [
    conversa,
  ]);

/** A bolha na fila sai para envio (pegar_envios). */
async function pegarEnvio(t: Banco, rodada: string) {
  await t.sql(
    "update public.mensagens set enviar_apos = now() - interval '1 second' where rodada_id = $1 and direcao = 'saida'",
    [rodada],
  );
  await t.como("service_role", null, (q) => q("select id from public.pegar_envios(10)"));
}

const daqui = (d: Date | null) => (d instanceof Date ? d.getTime() - Date.now() : null);

// ---------------------------------------------------------------------------

describe.skipIf(!temRodada)(
  "banco: retornos, o fim da rodada (nina_retornos_rodada)",
  { timeout: TEMPO_TESTE },
  () => {
    const t = usarBanco(base);

    it("rodada pura de retorno: a bolha entra na fila, o retorno fica saindo e, quando ela sai, enviado", async () => {
      const c = await cena(t);
      const { rodada, retorno: rt } = await rodadaCom(t, c.conversa, "retorno");
      await concluir(t, rodada, ["Oi! Como combinamos, segue a proposta."]);
      const bs = await bolhas(t, rodada);
      t.igual(
        bs.map((b: Linha) => b.status),
        ["na_fila"],
        "a bolha na fila",
      );
      t.igual((await statusRodada(t, rodada)).s, "concluida", "a rodada");
      t.igual((await retorno(t, rt)).status, "saindo", "saindo");

      await pegarEnvio(t, rodada);
      t.igual(
        (await bolhas(t, rodada)).map((b: Linha) => b.status),
        ["enviando"],
        "enviando",
      );
      t.igual((await retorno(t, rt)).status, "saindo", "na_fila → enviando não muda o retorno");

      await t.como("service_role", null, (q) =>
        q("select public.concluir_envio($1, 'ext-1', null)", [bs[0].id]),
      );
      const r = await retorno(t, rt);
      t.igual(r.status, "enviado", "enviado");
      t.ok(
        r.enviado_em instanceof Date && r.resolvido_em instanceof Date,
        "enviado_em e resolvido_em",
      );
      t.igual((await conversaDe(t, c.conversa)).modo, "nina", "a conversa continua com a Nina");
    });

    it("gatilho: a bolha do retorno que falha deixa o retorno não enviado (envio recusado); a conversa vai para a equipe como hoje", async () => {
      const c = await cena(t);
      const { rodada, retorno: rt } = await rodadaCom(t, c.conversa, "retorno");
      await concluir(t, rodada, ["Oi!"]);
      const [b] = await bolhas(t, rodada);
      await pegarEnvio(t, rodada);
      await t.como("service_role", null, (q) =>
        q("select public.falhar_envio($1, 'numero_invalido', true)", [b.id]),
      );
      const r = await retorno(t, rt);
      t.igual([r.status, r.nao_enviado_motivo], ["nao_enviado", "envio_recusado"], "não enviado");
      const cv = await conversaDe(t, c.conversa);
      t.igual(
        [cv.modo, cv.motivo],
        ["humano", "envio_falhou"],
        "a regra de hoje da bolha que falha",
      );
    });

    it("rodada pura: sem conexão ativa no insert, o erro não sobe; o retorno volta em 30 s e a conversa fica com a Nina", async () => {
      const c = await cena(t);
      const { rodada, retorno: rt } = await rodadaCom(t, c.conversa, "retorno");
      await t.sql("update public.conexoes set ativa = false");
      await concluir(t, rodada, ["Oi!"]);
      t.igual(await bolhas(t, rodada), [], "nenhuma bolha");
      t.igual((await statusRodada(t, rodada)).s, "concluida", "a rodada concluída, vazia");
      const r = await retorno(t, rt);
      t.igual([r.status, r.rodada_id], ["pendente", null], "o retorno volta");
      const falta = daqui(r.tentar_apos) ?? 0;
      t.ok(falta > 20_000 && falta <= 30_000, `tentar_apos em ~30 s (veio ${falta} ms)`);
      const cv = await conversaDe(t, c.conversa);
      t.igual([cv.modo, cv.responder_apos], ["nina", null], "a conversa com a Nina, sem armar");
      t.igual(await eventos(t, c.conversa), [], "nenhuma passagem");
    });

    it("rodada mista (com a fala do lead): sem conexão ativa, o erro sobe como hoje e nada é gravado", async () => {
      const c = await cena(t);
      const { rodada, retorno: rt } = await rodadaCom(t, c.conversa, "retorno", { mista: true });
      await t.sql("update public.conexoes set ativa = false");
      await t.erro(concluir(t, rodada, ["Oi!"]), "sem_conexao_ativa");
      t.igual((await statusRodada(t, rodada)).s, "rodando", "a rodada continua rodando");
      t.igual((await retorno(t, rt)).status, "em_rodada", "o retorno não mudou");
    });

    it("descarte: o lead escreveu durante a rodada pura; nenhuma bolha, e o retorno volta para ir junto da resposta", async () => {
      const c = await cena(t);
      const { rodada, retorno: rt } = await rodadaCom(t, c.conversa, "retorno");
      await entrada(t, c.cx); // o lead escreve no meio: a entrada fica solta e a conversa, armada
      await concluir(t, rodada, ["Oi! Como combinamos..."]);
      t.igual(await bolhas(t, rodada), [], "nenhuma bolha");
      const r = await retorno(t, rt);
      t.igual([r.status, r.rodada_id], ["pendente", null], "o retorno volta");
      t.ok((daqui(r.tentar_apos) ?? 1) <= 0, "pronto já");
      t.ok(
        (await conversaDe(t, c.conversa)).responder_apos instanceof Date,
        "a conversa segue armada para a faixa 0",
      );
    });

    it("descarte do lembrete: o lead escreveu durante a rodada de lembrete; nenhuma bolha, e o lembrete fica dispensado", async () => {
      const c = await cena(t);
      const { rodada, retorno: lb } = await rodadaCom(t, c.conversa, "lembrete");
      await entrada(t, c.cx);
      await concluir(t, rodada, ["Conseguiu ver?"]);
      t.igual(await bolhas(t, rodada), [], "nenhuma bolha");
      t.igual((await retorno(t, lb)).status, "dispensado", "dispensado");
    });

    it("falhar_rodada: a pura de retorno não arma a conversa na falha passageira; o retorno volta em 30 s", async () => {
      const c = await cena(t);
      const { rodada, retorno: rt } = await rodadaCom(t, c.conversa, "retorno");
      await falhar(t, rodada, "erro_provedor", true);
      t.igual((await statusRodada(t, rodada)).s, "falhou", "a rodada falhou");
      const r = await retorno(t, rt);
      t.igual([r.status, r.rodada_id], ["pendente", null], "o retorno volta");
      const falta = daqui(r.tentar_apos) ?? 0;
      t.ok(falta > 20_000 && falta <= 30_000, `tentar_apos em ~30 s (veio ${falta} ms)`);
      const cv = await conversaDe(t, c.conversa);
      t.igual([cv.modo, cv.responder_apos], ["nina", null], "a conversa não é armada (D5)");
      t.igual(await eventos(t, c.conversa), [], "nenhuma passagem");
    });

    it("falhar_rodada: a falha definitiva da pura de retorno vai para a equipe (regra de hoje), e o retorno fica não enviado", async () => {
      const c = await cena(t);
      const { rodada, retorno: rt } = await rodadaCom(t, c.conversa, "retorno");
      await falhar(t, rodada, "chave_invalida", false);
      const r = await retorno(t, rt);
      t.igual([r.status, r.nao_enviado_motivo], ["nao_enviado", "nina_falhou"], "não enviado");
      const cv = await conversaDe(t, c.conversa);
      t.igual(
        [cv.modo, cv.motivo, cv.responder_apos],
        ["humano", "chave_invalida", null],
        "com a equipe",
      );
      t.igual(
        await eventos(t, c.conversa),
        [{ tipo: "passou", motivo: "chave_invalida" }],
        "a passagem",
      );
      t.igual((await statusRodada(t, rodada)).equipe, true, "foi_para_equipe");
    });

    it("falhar_rodada: a de lembrete nunca vai para a equipe nem arma a conversa (uma tentativa só)", async () => {
      const c = await cena(t);
      const { rodada, retorno: lb } = await rodadaCom(t, c.conversa, "lembrete");
      await falhar(t, rodada, "chave_invalida", false);
      const r = await retorno(t, lb);
      t.igual(
        [r.status, r.nao_enviado_motivo],
        ["nao_enviado", "nina_falhou"],
        "não enviado, em silêncio",
      );
      const cv = await conversaDe(t, c.conversa);
      t.igual([cv.modo, cv.responder_apos], ["nina", null], "a conversa como estava");
      t.igual(await eventos(t, c.conversa), [], "nenhuma passagem");
    });

    it("falhar_rodada: a mista arma a conversa como hoje (o lead tem resposta) e o retorno volta", async () => {
      const c = await cena(t);
      const { rodada, retorno: rt } = await rodadaCom(t, c.conversa, "retorno", { mista: true });
      await falhar(t, rodada, "erro_provedor", true);
      const cv = await conversaDe(t, c.conversa);
      t.ok(cv.responder_apos instanceof Date, "a conversa armada para a nova tentativa");
      const [{ n }] = await t.sql(
        "select count(*)::int as n from public.mensagens where rodada_id = $1 and direcao = 'entrada'",
        [rodada],
      );
      t.igual(n, 0, "as entradas soltas de novo");
      t.igual((await retorno(t, rt)).status, "pendente", "o retorno volta");
    });

    it("D5: a pegar_rodadas de hoje falha a rodada pura presa sem armar a conversa, e não cria outra", async () => {
      const c = await cena(t);
      const { rodada, retorno: rt } = await rodadaCom(t, c.conversa, "retorno", {
        iniciada: "now() - interval '6 minutes'",
      });
      const pegar = () =>
        t.como("service_role", null, (q) => q("select id from public.pegar_rodadas(10)"));
      t.igual(await pegar(), [], "nenhuma rodada nova");
      t.igual((await statusRodada(t, rodada)).s, "falhou", "a presa falhou");
      t.igual((await retorno(t, rt)).status, "pendente", "o retorno volta");
      t.igual((await conversaDe(t, c.conversa)).responder_apos, null, "a conversa não é armada");
      t.igual(await pegar(), [], "e a pegada seguinte continua vazia");
    });

    it("gatilho: a bolha de rodada comum não mexe em retorno nenhum", async () => {
      const c = await cena(t);
      const [{ id: rodada }] = await t.sql(
        "insert into public.rodadas (conversa_id, status) values ($1, 'rodando') returning id",
        [c.conversa],
      );
      await t.sql(
        `insert into public.retornos (conversa_id, tipo, status, vence_em, expira_em, motivo)
       values ($1, 'retorno', 'pendente', now() + interval '1 day', now() + interval '1 day 3 hours', 'x')`,
        [c.conversa],
      );
      await concluir(t, rodada, ["Oi!"]);
      const [b] = await bolhas(t, rodada);
      await pegarEnvio(t, rodada);
      await t.como("service_role", null, (q) =>
        q("select public.concluir_envio($1, 'ext-2', null)", [b.id]),
      );
      const rs = await t.sql(
        "select status::text as s from public.retornos where conversa_id = $1",
        [c.conversa],
      );
      t.igual(rs, [{ s: "pendente" }], "o retorno de amanhã fica pendente");
    });
  },
);

describe.skipIf(!temRelogio)(
  "banco: retornos, a versão do relógio (nina_retornos_relogio)",
  { timeout: TEMPO_TESTE },
  () => {
    const t = usarBanco(base);
    const preparar = async () =>
      (await t.como("service_role", null, (q) => q("select public.preparar_copia() as r")))[0]
        .r as string;
    const versao = async () =>
      (await t.sql("select relogio_versao as v from public.motor"))[0].v as number;

    it("a versão 1 dá pronta; a versão 0 refaz o relógio sem semear de novo", async () => {
      t.igual(await preparar(), "preparada", "o original sem relógio");
      t.igual(await versao(), 1, "a versão gravada");
      t.igual(await preparar(), "pronta", "a 2ª chamada");
      await t.sql("delete from public.etapas where chave = 'ganho'");
      await t.sql("delete from cron.job");
      await t.sql("update public.motor set relogio_versao = 0");
      t.igual(await preparar(), "preparada", "a versão 0 refaz");
      t.igual(
        (await t.sql("select jobname from cron.job order by jobid")).map((l: Linha) => l.jobname),
        ["nina-relogio", "nina-retornos"],
        "os dois jobs",
      );
      t.igual(await versao(), 1, "a versão de volta");
      const [{ n }] = await t.sql(
        "select count(*)::int as n from public.etapas where chave = 'ganho'",
      );
      t.igual(n, 0, "a etapa apagada não volta");
    });

    it("se o cron recusar, a versão fica como estava e a chamada seguinte tenta de novo", async () => {
      await t.sql("revoke execute on function cron.schedule(text, text, text) from dono_app");
      try {
        t.igual(await preparar(), "preparada", "sem o cron");
        t.igual(await versao(), 0, "a versão não sobe sem o relógio");
        t.igual(await t.sql("select jobname from cron.job"), [], "nenhum job");
      } finally {
        await t.sql("grant execute on function cron.schedule(text, text, text) to dono_app");
      }
      t.igual(await preparar(), "preparada", "com o cron de volta");
      t.igual(await versao(), 1, "a versão 1");
    });
  },
);

describe.skipIf(!temDashboard)(
  "banco: retornos, o tempo de resposta do Dashboard (nina_retornos_dashboard)",
  { timeout: TEMPO_TESTE },
  () => {
    const t = usarBanco(base);

    it("a rodada pura de retorno fica fora do tempo de resposta; a resposta ao lead continua contando", async () => {
      const c = await cena(t);
      const [{ id: comum }] = await t.sql(
        "insert into public.rodadas (conversa_id, status, iniciada_em, terminada_em) values ($1, 'concluida', now() - interval '2 hours', now() - interval '2 hours') returning id",
        [c.conversa],
      );
      // o lead às T - 2 h; a Nina responde 30 s depois (rodada comum)
      await t.sql(
        "update public.mensagens set momento = now() - interval '2 hours', rodada_id = $1 where id = $2",
        [comum, c.entrada],
      );
      const bolha = (rodada: string, quando: string) =>
        t.sql(
          `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, status, momento, rodada_id, texto)
         values ($1, $2, 'saida', 'nina', 'enviada', ${quando}, $3, 'oi')`,
          [c.conversa, c.cx, rodada],
        );
      await bolha(comum, "now() - interval '2 hours' + interval '30 seconds'");
      // o retorno combinado sai agora, sem fala do lead (rodada pura): seriam 2 h de "resposta"
      const [{ id: pura }] = await t.sql(
        "insert into public.rodadas (conversa_id, status, retorno_id, iniciada_em, terminada_em) values ($1, 'concluida', gen_random_uuid(), now(), now()) returning id",
        [c.conversa],
      );
      await bolha(pura, "now()");
      const [{ r }] = await t.como("authenticated", c.admin, (q) =>
        q(
          "select public.dashboard_periodo(now() - interval '1 day', now() + interval '1 minute', null) as r",
        ),
      );
      t.igual(r.respostaNinaS, 30, "só a resposta ao lead");
      t.igual(r.respostaNinaP90S, 30, "p90");
      t.igual(r.enviadasPorOrigem.nina, 2, "as duas bolhas continuam em enviadas");
    });
  },
);
