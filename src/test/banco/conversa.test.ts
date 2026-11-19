// @vitest-environment node
// Funções e gatilhos da conversa (migration 0006; spec 2.3, decisões 2, 3, 4 e 8). Porte do
// 30-conversa do banco2. O comportamento de antes das funções recriadas é conferido também,
// inteiro, pelo conversa-antigo.test.ts (a suíte do banco de 28/10); aqui ficam os casos principais.
import { describe, it } from "vitest";
import { montarBase, TEMPO_TESTE, usarBanco, type Banco, type Linha, type Papel } from "./montar";

const DOM = "empresa.exemplo";
const TEL = "5511900000001";

// ---------------------------------------------------------------------------
// ajudantes
// ---------------------------------------------------------------------------

// Admin (1ª conta), dois atendentes, conexão Z-API ativa e, por padrão, o onboarding concluído.
async function preparar(t: Banco, { onboarding = true, gateway = "zapi" } = {}) {
  const uAdmin = await t.criarUsuario(`admin@${DOM}`, "Admin");
  const [{ id: mAdmin }] = await t.sql("select id from public.membros where user_id = $1", [
    uAdmin,
  ]);
  const uAtend = await t.criarUsuario(`atendente@${DOM}`, "Atendente");
  const [{ id: mAtend }] = await t.sql(
    `insert into public.membros (user_id, nome, email, papel) values ($1, 'Atendente', $2, 'atendente') returning id`,
    [uAtend, `atendente@${DOM}`],
  );
  const uOutro = await t.criarUsuario(`outro@${DOM}`, "Outro");
  const [{ id: mOutro }] = await t.sql(
    `insert into public.membros (user_id, nome, email, papel) values ($1, 'Outro', $2, 'atendente') returning id`,
    [uOutro, `outro@${DOM}`],
  );
  const [{ id: cx }] = await t.sql(
    `insert into public.conexoes (gateway, nome, id_externo, ativa, status)
     values ($1, 'Conexão de teste', 'inst-teste-1', true, 'conectada') returning id`,
    [gateway],
  );
  if (onboarding)
    await t.sql(`update public.configuracao set onboarding_concluido_em = now() where id = 1`);
  const etapas: Record<string, string> = {};
  for (const r of await t.sql(`select chave, id from public.etapas where chave is not null`))
    etapas[r.chave] = r.id;
  // etapas: as chaves do dado inicial (0001), lidas como b.etapas.perdido
  return { uAdmin, mAdmin, uAtend, mAtend, uOutro, mOutro, cx, etapas: etapas as Linha };
}

type Preparo = Awaited<ReturnType<typeof preparar>>;

function msg(idExterno: string, extra: Record<string, unknown> = {}) {
  return {
    id_externo: idExterno,
    tipo: "texto",
    texto: `oi ${idExterno}`,
    momento: new Date().toISOString(),
    ...extra,
  };
}

async function entrada(t: Banco, cx: string, m: Record<string, unknown>, tel = TEL) {
  const [r] = await t.como("service_role", null, (q) =>
    q(`select * from public.registrar_entrada($1, $2::jsonb, 'Lead de teste', $3::jsonb)`, [
      cx,
      JSON.stringify([{ tipo: "telefone", valor: tel }]),
      JSON.stringify(m),
    ]),
  );
  return r;
}

async function celular(t: Banco, cx: string, m: Record<string, unknown>, tel = TEL) {
  const [r] = await t.como("service_role", null, (q) =>
    q(`select public.registrar_saida_celular($1, $2::jsonb, $3::jsonb) as id`, [
      cx,
      JSON.stringify([{ tipo: "telefone", valor: tel }]),
      JSON.stringify(m),
    ]),
  );
  return r.id;
}

async function vencer(t: Banco, conversa: string) {
  await t.sql(
    `update public.conversas set responder_apos = now() - interval '1 second' where id = $1`,
    [conversa],
  );
}

async function pegarRodadas(t: Banco) {
  return t.como("service_role", null, (q) => q(`select * from public.pegar_rodadas(10)`));
}

async function comRodada(t: Banco, b: Preparo, tel = TEL) {
  const e = await entrada(t, b.cx, msg(`w-${tel}-1`), tel);
  await vencer(t, e.conversa_id);
  const rs = await pegarRodadas(t);
  t.igual(rs.length, 1, "pegar_rodadas devia criar 1 rodada");
  const [{ contato_id: contato }] = await t.sql(
    `select contato_id from public.conversas where id = $1`,
    [e.conversa_id],
  );
  return { conversa: e.conversa_id, rodada: rs[0].id, entrada: e.mensagem_id, contato };
}

async function concluirRodada(t: Banco, rodada: string, textos: string[]) {
  await t.sql(`select public.concluir_rodada($1, $2::jsonb, '[]'::jsonb, 1)`, [
    rodada,
    JSON.stringify(textos.map((texto) => ({ texto }))),
  ]);
}

async function conversa(t: Banco, id: string) {
  const [c] = await t.sql(`select * from public.conversas where id = $1`, [id]);
  return c;
}

async function eventos(t: Banco, conversaId: string) {
  return t.sql(
    `select tipo::text, membro_id, de, de_membro_id, motivo::text, por_envio
       from public.conversa_eventos where conversa_id = $1 order by criado_em, id`,
    [conversaId],
  );
}

const ev = (tipo: string, campos: Record<string, unknown> = {}) => ({
  tipo,
  membro_id: null,
  de: null,
  de_membro_id: null,
  motivo: null,
  por_envio: false,
  ...campos,
});

async function humanoTela(t: Banco, uid: string, conversaId: string, texto = "pela tela") {
  const [r] = await t.como("authenticated", uid, (q) =>
    q(
      `insert into public.mensagens (id, conversa_id, direcao, origem, texto, status)
       values (gen_random_uuid(), $1, 'saida', 'humano_tela', $2, 'na_fila') returning id`,
      [conversaId, texto],
    ),
  );
  return r.id;
}

const assumir = (t: Banco, uid: string, c: string) =>
  t.como("authenticated", uid, (q) => q(`select public.assumir_conversa($1)`, [c]));
const devolver = (t: Banco, uid: string, c: string) =>
  t.como("authenticated", uid, (q) => q(`select public.devolver_para_nina($1)`, [c]));
const moverNina = (t: Banco, rodada: string, etapa: string) =>
  t.como("service_role", null, (q) => q(`select public.nina_mover_etapa($1, $2)`, [rodada, etapa]));
const moverMembro = (t: Banco, uid: string, contato: string, etapa: string) =>
  t.como("authenticated", uid, (q) =>
    q(`update public.contatos set etapa_id = $1 where id = $2 returning id`, [etapa, contato]),
  );
const reenviar = (t: Banco, papel: Papel, uid: string | null, m: string) =>
  t.como(papel, uid, (q) => q(`select public.reenviar_mensagem($1)`, [m]));
const etapaDe = async (t: Banco, contato: string) =>
  (await t.sql(`select etapa_id from public.contatos where id = $1`, [contato]))[0].etapa_id;

// Mensagem da equipe que falhou (pela fila de verdade: na_fila -> enviando -> falhou).
async function mensagemQueFalhou(
  t: Banco,
  b: Preparo,
  uid: string,
  conversaId: string,
  erro = "sem_destino",
) {
  const id = await humanoTela(t, uid, conversaId);
  const env = await t.sql(`select id from public.pegar_envios(10)`);
  t.ok(
    env.some((x) => x.id === id),
    "a mensagem foi pega para envio",
  );
  await t.sql(`select public.falhar_envio($1, $2, true)`, [id, erro]);
  const [{ status }] = await t.sql(`select status::text from public.mensagens where id = $1`, [id]);
  t.igual(status, "falhou", "mensagem falhou");
  return id;
}

// ---------------------------------------------------------------------------
// testes
// ---------------------------------------------------------------------------

const base = await montarBase();
const t = usarBanco(base);

describe("banco: conversa (0006)", { timeout: TEMPO_TESTE }, () => {
  // ----------------------------------------------------------- decisão 3: etapas
  it("decisão 3: a Nina nunca tira o lead de Ganho nem de Perdido; pode mandar para Perdido", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    // Novo -> Perdido: a Nina pode (lead em etapa aberta, último movimento do sistema)
    await moverNina(t, x.rodada, b.etapas.perdido);
    t.igual(await etapaDe(t, x.contato), b.etapas.perdido, "foi para Perdido");
    // de Perdido ela não tira
    await t.erro(moverNina(t, x.rodada, b.etapas.em_qualificacao), "etapa_travada");
    t.igual(await etapaDe(t, x.contato), b.etapas.perdido, "continua em Perdido");
    // mandar para a etapa em que ele já está não faz nada (nem erro, nem histórico novo)
    const [{ n: antes }] = await t.sql(
      `select count(*)::int as n from public.contato_etapa_historico where contato_id = $1`,
      [x.contato],
    );
    await moverNina(t, x.rodada, b.etapas.perdido);
    const [{ n: depois }] = await t.sql(
      `select count(*)::int as n from public.contato_etapa_historico where contato_id = $1`,
      [x.contato],
    );
    t.igual(depois, antes, "sem histórico novo");

    // Ganho (posto pelo sistema): a Nina não tira, nem para Perdido
    const y = await comRodada(t, b, "5511900000002");
    await t.sql(`update public.contatos set etapa_id = $1 where id = $2`, [
      b.etapas.ganho,
      y.contato,
    ]);
    await t.erro(moverNina(t, y.rodada, b.etapas.em_qualificacao), "etapa_travada");
    await t.erro(moverNina(t, y.rodada, b.etapas.perdido), "etapa_travada");
    t.igual(await etapaDe(t, y.contato), b.etapas.ganho, "continua em Ganho");
    // Ganho posto por um membro, mesmo depois de devolver: continua travado
    await devolver(t, b.uAtend, y.conversa);
    await t.erro(moverNina(t, y.rodada, b.etapas.qualificado), "etapa_travada");
    // a regra antiga continua: etapa que a Nina não pode mover
    await t.erro(moverNina(t, y.rodada, b.etapas.em_negociacao), "etapa_nao_permitida");
  });

  it("decisão 3: movimento de pessoa trava a Nina até devolver; movimento depois de devolver trava de novo", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    // a Nina move livre (o último movimento é do sistema, a entrada)
    await moverNina(t, x.rodada, b.etapas.em_qualificacao);
    // e de novo (o último é dela)
    await moverNina(t, x.rodada, b.etapas.qualificado);
    // uma pessoa move ("Desfazer"): a Nina fica travada
    const r = await moverMembro(t, b.uAtend, x.contato, b.etapas.em_qualificacao);
    t.igual(r.length, 1, "membro moveu");
    await t.erro(moverNina(t, x.rodada, b.etapas.qualificado), "etapa_travada");
    await t.erro(moverNina(t, x.rodada, b.etapas.perdido), "etapa_travada");
    t.igual(await etapaDe(t, x.contato), b.etapas.em_qualificacao, "ficou onde a pessoa pôs");
    // devolvida_em antiga (antes do movimento) não destrava
    await t.sql(
      `update public.conversas set devolvida_em = now() - interval '1 hour' where id = $1`,
      [x.conversa],
    );
    await t.erro(moverNina(t, x.rodada, b.etapas.qualificado), "etapa_travada");
    // devolveu depois do movimento: destrava
    await devolver(t, b.uAtend, x.conversa);
    await moverNina(t, x.rodada, b.etapas.qualificado);
    t.igual(await etapaDe(t, x.contato), b.etapas.qualificado, "a Nina moveu depois de devolver");
    const [h] = await t.sql(
      `select ator::text, rodada_id from public.contato_etapa_historico where contato_id = $1 order by criado_em desc limit 1`,
      [x.contato],
    );
    t.igual(h, { ator: "nina", rodada_id: x.rodada }, "histórico com ator nina");
    // uma pessoa move de novo, depois da devolução: trava de novo
    await moverMembro(t, b.uAdmin, x.contato, b.etapas.em_negociacao);
    await t.erro(moverNina(t, x.rodada, b.etapas.perdido), "etapa_travada");
    t.igual(await etapaDe(t, x.contato), b.etapas.em_negociacao, "ficou onde a pessoa pôs");
  });

  // ----------------------------------------------------------- decisão 4
  it("decisão 4: o lead que escreve depois do celular entra na espera; com responsável ou já na espera, não muda", async () => {
    const b = await preparar(t);
    const e = await entrada(t, b.cx, msg("w-1"));
    await celular(t, b.cx, msg("cel-1", { texto: "respondi pelo celular" }));
    let c = await conversa(t, e.conversa_id);
    t.igual(
      [c.modo, c.motivo_humano, c.responsavel_id, c.aguardando_humano_desde],
      ["humano", "humano_celular", null, null],
      "atendida pelo celular",
    );
    await entrada(t, b.cx, msg("w-2"));
    c = await conversa(t, e.conversa_id);
    t.ok(c.aguardando_humano_desde, "entrou na espera");
    t.igual(
      [c.modo, c.motivo_humano, c.responsavel_id, c.responder_apos],
      ["humano", "humano_celular", null, null],
      "continua humana, sem Nina",
    );
    // já na espera: a hora da espera não muda
    const desde = c.aguardando_humano_desde.getTime();
    await entrada(t, b.cx, msg("w-3"));
    t.igual(
      (await conversa(t, e.conversa_id)).aguardando_humano_desde.getTime(),
      desde,
      "espera desde a 1ª",
    );
    // com uma pessoa responsável: não entra na espera
    await assumir(t, b.uAtend, e.conversa_id);
    await entrada(t, b.cx, msg("w-4"));
    c = await conversa(t, e.conversa_id);
    t.igual([c.responsavel_id, c.aguardando_humano_desde], [b.mAtend, null], "com responsável");
    // modo nina: continua armando a Nina, sem espera
    const e2 = await entrada(t, b.cx, msg("w-5", {}), "5511900000002");
    const c2 = await conversa(t, e2.conversa_id);
    t.igual([c2.modo, c2.aguardando_humano_desde], ["nina", null], "modo nina");
    t.ok(c2.responder_apos, "Nina armada");
  });

  // ----------------------------------------------------------- eventos
  it("eventos: assumir pelo botão (da Nina, da espera, de outra pessoa e do celular), com o de", async () => {
    const b = await preparar(t);
    // da Nina
    const x = await comRodada(t, b);
    await assumir(t, b.uAtend, x.conversa);
    // de novo, já com ele: sem evento
    await assumir(t, b.uAtend, x.conversa);
    // de outra pessoa
    await assumir(t, b.uOutro, x.conversa);
    t.igual(
      await eventos(t, x.conversa),
      [
        ev("assumiu", { membro_id: b.mAtend, de: "nina" }),
        ev("assumiu", { membro_id: b.mOutro, de: "outro", de_membro_id: b.mAtend }),
      ],
      "nina e outro",
    );
    t.igual((await conversa(t, x.conversa)).responsavel_id, b.mOutro, "responsável trocado");

    // da espera (a Nina passou)
    const y = await comRodada(t, b, "5511900000002");
    await t.sql(`select public.nina_passar_para_humano($1)`, [y.rodada]);
    await assumir(t, b.uAdmin, y.conversa);
    t.igual(
      await eventos(t, y.conversa),
      [
        ev("passou", { motivo: "nina_passou" }),
        ev("assumiu", { membro_id: b.mAdmin, de: "espera" }),
      ],
      "espera",
    );

    // do celular
    const e = await entrada(t, b.cx, msg("w-z"), "5511900000003");
    await celular(t, b.cx, msg("cel-z", { texto: "pelo celular" }), "5511900000003");
    await assumir(t, b.uAtend, e.conversa_id);
    t.igual(
      await eventos(t, e.conversa_id),
      [ev("celular", { de: "nina" }), ev("assumiu", { membro_id: b.mAtend, de: "celular" })],
      "celular",
    );

    // comportamento antigo: modo humano, responsável, fora da espera, fila e rodada da Nina canceladas
    const z = await comRodada(t, b, "5511900000004");
    await t.sql(`select public.nina_passar_para_humano($1)`, [z.rodada]);
    await t.sql(`update public.conversas set modo = 'nina' where id = $1`, [z.conversa]);
    await assumir(t, b.uAtend, z.conversa);
    const c = await conversa(t, z.conversa);
    t.igual(
      [c.modo, c.responsavel_id, c.aguardando_humano_desde, c.responder_apos],
      ["humano", b.mAtend, null, null],
      "assumida",
    );
    const [r] = await t.sql(`select status::text from public.rodadas where id = $1`, [z.rodada]);
    t.igual(r.status, "rodando", "a rodada que a Nina passou continua (a despedida vai)");
    await t.erro(
      t.como("authenticated", b.uAtend, (q) =>
        q(`select public.assumir_conversa(gen_random_uuid())`),
      ),
      "conversa_nao_encontrada",
    );
  });

  it("eventos: assumir por envio (por_envio, com o de); com outra pessoa responsável, não assume", async () => {
    const b = await preparar(t);
    // da Nina
    const x = await comRodada(t, b);
    await humanoTela(t, b.uAtend, x.conversa);
    await humanoTela(t, b.uAtend, x.conversa, "de novo");
    t.igual(
      await eventos(t, x.conversa),
      [ev("assumiu", { membro_id: b.mAtend, de: "nina", por_envio: true })],
      "da Nina, uma vez",
    );
    // outra pessoa manda na conversa de quem já está com ela: sem evento, responsável fica
    await humanoTela(t, b.uOutro, x.conversa, "ajudando");
    t.igual((await eventos(t, x.conversa)).length, 1, "sem evento novo");
    t.igual((await conversa(t, x.conversa)).responsavel_id, b.mAtend, "responsável continua");

    // da espera (falha)
    const y = await comRodada(t, b, "5511900000002");
    await t.sql(`select public.falhar_rodada($1, 'sem_credito', false)`, [y.rodada]);
    await humanoTela(t, b.uOutro, y.conversa);
    t.igual(
      await eventos(t, y.conversa),
      [
        ev("passou", { motivo: "sem_credito" }),
        ev("assumiu", { membro_id: b.mOutro, de: "espera", por_envio: true }),
      ],
      "da espera",
    );
    const cy = await conversa(t, y.conversa);
    t.igual(
      [cy.responsavel_id, cy.aguardando_humano_desde],
      [b.mOutro, null],
      "assumida por quem mandou",
    );

    // do celular
    const e = await entrada(t, b.cx, msg("w-c"), "5511900000003");
    await celular(t, b.cx, msg("cel-c"), "5511900000003");
    await humanoTela(t, b.uAdmin, e.conversa_id);
    t.igual(
      (await eventos(t, e.conversa_id)).map((x) => [x.tipo, x.de, x.por_envio, x.membro_id]),
      [
        ["celular", "nina", false, null],
        ["assumiu", "celular", true, b.mAdmin],
      ],
      "do celular",
    );
  });

  it("eventos: devolver grava devolveu (só quando estava com a equipe); comportamento antigo continua", async () => {
    const b = await preparar(t);
    const e = await entrada(t, b.cx, msg("w-1"));
    // já com a Nina: sem evento
    await devolver(t, b.uAtend, e.conversa_id);
    t.igual(await eventos(t, e.conversa_id), [], "nada");
    await assumir(t, b.uAtend, e.conversa_id);
    await entrada(t, b.cx, msg("w-2"));
    await devolver(t, b.uOutro, e.conversa_id);
    t.igual(
      await eventos(t, e.conversa_id),
      [ev("assumiu", { membro_id: b.mAtend, de: "nina" }), ev("devolveu", { membro_id: b.mOutro })],
      "eventos",
    );
    const c = await conversa(t, e.conversa_id);
    t.igual(
      [c.modo, c.responsavel_id, c.motivo_humano, c.aguardando_humano_desde],
      ["nina", null, null, null],
      "devolvida",
    );
    t.ok(c.devolvida_em, "devolvida_em");
    t.ok(c.responder_apos && c.responder_apos <= new Date(), "lead sem resposta: Nina armada");
    t.igual((await pegarRodadas(t)).length, 1, "a Nina responde");
    await t.erro(
      t.como("authenticated", b.uAtend, (q) =>
        q(`select public.devolver_para_nina(gen_random_uuid())`),
      ),
      "conversa_nao_encontrada",
    );
  });

  it("eventos: nina_passar_para_humano grava passou (nina_passou) e foi_para_equipe; comportamento antigo continua", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await t.como("service_role", null, (q) =>
      q(`select public.nina_passar_para_humano($1)`, [x.rodada]),
    );
    const c = await conversa(t, x.conversa);
    t.igual([c.modo, c.motivo_humano], ["humano", "nina_passou"], "conversa");
    t.ok(c.aguardando_humano_desde, "aguardando");
    // a 2ª chamada (a conversa já saiu da Nina) não grava de novo
    await t.sql(`select public.nina_passar_para_humano($1)`, [x.rodada]);
    t.igual(await eventos(t, x.conversa), [ev("passou", { motivo: "nina_passou" })], "um evento");
    const [r] = await t.sql(
      `select passou_humano, foi_para_equipe, status::text from public.rodadas where id = $1`,
      [x.rodada],
    );
    t.igual(r, { passou_humano: true, foi_para_equipe: true, status: "rodando" }, "rodada");
    await concluirRodada(t, x.rodada, ["Vou te passar para a equipe."]);
    const [m] = await t.sql(
      `select status::text from public.mensagens where conversa_id = $1 and origem = 'nina'`,
      [x.conversa],
    );
    t.igual(m.status, "na_fila", "a despedida vai");
    // conversa que já estava com a equipe (assumida durante a rodada): sem evento nem foi_para_equipe
    const y = await comRodada(t, b, "5511900000002");
    await t.sql(`update public.conversas set modo = 'humano' where id = $1`, [y.conversa]);
    await t.sql(`select public.nina_passar_para_humano($1)`, [y.rodada]);
    t.igual(await eventos(t, y.conversa), [], "sem evento");
    const [ry] = await t.sql(
      `select passou_humano, foi_para_equipe from public.rodadas where id = $1`,
      [y.rodada],
    );
    t.igual(ry, { passou_humano: true, foi_para_equipe: false }, "só passou_humano");
  });

  it("eventos: falhar_rodada que vai para a equipe grava passou com o motivo e foi_para_equipe; passageira não", async () => {
    const b = await preparar(t);
    // não passageira: na hora
    const x = await comRodada(t, b);
    await t.como("service_role", null, (q) =>
      q(`select public.falhar_rodada($1, 'chave_invalida', false)`, [x.rodada]),
    );
    t.igual(await eventos(t, x.conversa), [ev("passou", { motivo: "chave_invalida" })], "evento");
    const [rx] = await t.sql(
      `select status::text, motivo::text, foi_para_equipe from public.rodadas where id = $1`,
      [x.rodada],
    );
    t.igual(rx, { status: "falhou", motivo: "chave_invalida", foi_para_equipe: true }, "rodada");
    const cx = await conversa(t, x.conversa);
    t.igual(
      [cx.modo, cx.motivo_humano, cx.responder_apos],
      ["humano", "chave_invalida", null],
      "conversa",
    );
    t.ok(cx.aguardando_humano_desde, "aguardando");

    // passageira: 2 re-armam (sem evento), a 3ª vai para a equipe
    const e = await entrada(t, b.cx, msg("w-p"), "5511900000002");
    const rodadas = [];
    for (let i = 1; i <= 3; i++) {
      await vencer(t, e.conversa_id);
      const [r] = await pegarRodadas(t);
      t.igual(r.tentativa, i, `tentativa ${i}`);
      rodadas.push(r.id);
      await t.sql(`select public.falhar_rodada($1, 'erro_provedor', true)`, [r.id]);
      if (i < 3) t.igual(await eventos(t, e.conversa_id), [], `sem evento na ${i}`);
    }
    t.igual(
      await eventos(t, e.conversa_id),
      [ev("passou", { motivo: "erro_provedor" })],
      "evento na 3ª",
    );
    const fp = await t.sql(
      `select foi_para_equipe from public.rodadas where id = any ($1::uuid[]) order by tentativa`,
      [rodadas],
    );
    t.igual(
      fp.map((r) => r.foi_para_equipe),
      [false, false, true],
      "foi_para_equipe só na 3ª",
    );

    // conversa já com a equipe: a rodada falha, sem evento
    const y = await comRodada(t, b, "5511900000003");
    await t.sql(`update public.conversas set modo = 'humano' where id = $1`, [y.conversa]);
    await t.sql(`select public.falhar_rodada($1, 'erro_provedor', false)`, [y.rodada]);
    t.igual(await eventos(t, y.conversa), [], "sem evento");
    // a rodada presa há 5 min também passa por aqui (pegar_rodadas)
    const z = await comRodada(t, b, "5511900000004");
    await t.sql(
      `update public.rodadas set iniciada_em = now() - interval '6 minutes', tentativa = 3 where id = $1`,
      [z.rodada],
    );
    await pegarRodadas(t);
    t.igual(
      await eventos(t, z.conversa),
      [ev("passou", { motivo: "erro_provedor" })],
      "rodada presa na 3ª tentativa",
    );
  });

  it("eventos: celular grava celular quando tira da Nina ou da espera; eco do nosso envio não", async () => {
    const b = await preparar(t);
    const e = await entrada(t, b.cx, msg("w-1"));
    await celular(t, b.cx, msg("cel-1"));
    await celular(t, b.cx, msg("cel-2"));
    t.igual(
      await eventos(t, e.conversa_id),
      [ev("celular", { de: "nina" })],
      "um evento (o 2º já estava no celular)",
    );
    // o lead escreve (espera, decisão 4) e o celular responde: tira da espera
    await entrada(t, b.cx, msg("w-2"));
    await celular(t, b.cx, msg("cel-3"));
    t.igual(
      (await eventos(t, e.conversa_id)).map((x) => [x.tipo, x.de]),
      [
        ["celular", "nina"],
        ["celular", "espera"],
      ],
      "da espera",
    );
    const c = await conversa(t, e.conversa_id);
    t.igual(
      [c.modo, c.responsavel_id, c.aguardando_humano_desde],
      ["humano", null, null],
      "fora da espera",
    );
    // com uma pessoa responsável: sem evento
    await assumir(t, b.uAtend, e.conversa_id);
    await celular(t, b.cx, msg("cel-4"));
    t.igual(
      (await eventos(t, e.conversa_id)).filter((x) => x.tipo === "celular").length,
      2,
      "sem evento novo",
    );
    // eco do nosso envio: não é humano_celular nem evento
    const x = await comRodada(t, b, "5511900000002");
    await concluirRodada(t, x.rodada, ["resposta da Nina"]);
    await t.sql(`select id from public.pegar_envios(10)`);
    await celular(t, b.cx, msg("eco-1", { texto: "resposta da Nina" }), "5511900000002");
    t.igual(await eventos(t, x.conversa), [], "eco sem evento");
    t.igual((await conversa(t, x.conversa)).modo, "nina", "continua com a Nina");
  });

  // ----------------------------------------------------------- prévia
  it("prévia: ultima_mensagem_id acompanha a prévia; refeita quando a última vira cancelada ou é apagada", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    let c = await conversa(t, x.conversa);
    t.igual(
      [c.ultima_mensagem_id, c.ultima_mensagem_preview],
      [x.entrada, `oi w-${TEL}-1`],
      "prévia da entrada",
    );
    const momentoEntrada = c.ultima_mensagem_em.getTime();
    await concluirRodada(t, x.rodada, ["Primeira", "Segunda"]);
    const [seg] = await t.sql(
      `select id from public.mensagens where conversa_id = $1 and texto = 'Segunda'`,
      [x.conversa],
    );
    c = await conversa(t, x.conversa);
    t.igual(
      [c.ultima_mensagem_id, c.ultima_mensagem_preview],
      [seg.id, "Segunda"],
      "prévia da resposta da Nina",
    );
    // assumir cancela as respostas na fila: a prévia volta para a entrada
    await assumir(t, b.uAtend, x.conversa);
    c = await conversa(t, x.conversa);
    t.igual(
      [c.ultima_mensagem_id, c.ultima_mensagem_preview, c.ultima_mensagem_em.getTime()],
      [x.entrada, `oi w-${TEL}-1`, momentoEntrada],
      "refeita depois do cancelamento",
    );

    // a última do lead é apagada: volta para a anterior
    const e2 = await entrada(t, b.cx, msg("w-2", { texto: "segunda do lead" }));
    t.igual((await conversa(t, x.conversa)).ultima_mensagem_id, e2.mensagem_id, "nova entrada");
    await entrada(t, b.cx, msg("w-2", { apagada: true }));
    c = await conversa(t, x.conversa);
    t.igual(
      [c.ultima_mensagem_id, c.ultima_mensagem_preview],
      [x.entrada, `oi w-${TEL}-1`],
      "refeita depois de apagada",
    );
    // apagar uma que não é a última não mexe
    const e3 = await entrada(t, b.cx, msg("w-3", { texto: "terceira" }));
    await t.sql(`update public.mensagens set apagada_em = now() where id = $1`, [x.entrada]);
    t.igual(
      (await conversa(t, x.conversa)).ultima_mensagem_id,
      e3.mensagem_id,
      "continua a última",
    );
    // falhou continua valendo como prévia
    const h = await humanoTela(t, b.uAtend, x.conversa, "da equipe");
    await t.sql(
      `update public.mensagens set status = 'falhou', erro = 'sem_destino' where id = $1`,
      [h],
    );
    c = await conversa(t, x.conversa);
    t.igual([c.ultima_mensagem_id, c.ultima_mensagem_preview], [h, "da equipe"], "falhou continua");
    // mídia sem texto vira [tipo], como no insert
    const im = await entrada(
      t,
      b.cx,
      msg("w-img", { tipo: "imagem", texto: null, midia_ref_externa: "ref-1" }),
    );
    await t.sql(`update public.mensagens set status = 'cancelada' where id = $1`, [h]);
    c = await conversa(t, x.conversa);
    t.igual(
      [c.ultima_mensagem_id, c.ultima_mensagem_preview],
      [im.mensagem_id, "[imagem]"],
      "continua a imagem",
    );
    await entrada(t, b.cx, msg("w-img", { apagada: true }));
    t.igual(
      (await conversa(t, x.conversa)).ultima_mensagem_preview,
      "terceira",
      "volta para o texto",
    );
    // nenhuma vale: sem prévia
    await t.sql(`update public.mensagens set apagada_em = now() where conversa_id = $1`, [
      x.conversa,
    ]);
    c = await conversa(t, x.conversa);
    t.igual([c.ultima_mensagem_id, c.ultima_mensagem_preview], [null, null], "sem prévia");
    t.ok(c.ultima_mensagem_em, "a hora da última atividade fica");
  });

  it("prévia: mensagem humana mais antiga que a resposta cancelada da Nina vira a prévia", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await t.sql(
      `update public.mensagens set momento = now() - interval '10 minutes' where id = $1`,
      [x.entrada],
    );
    await t.sql(
      `update public.conversas set ultima_mensagem_em = now() - interval '10 minutes' where id = $1`,
      [x.conversa],
    );
    await concluirRodada(t, x.rodada, ["resposta da Nina"]);
    // o celular respondeu antes (webhook atrasado): momento 5 min atrás
    const cel = await celular(
      t,
      b.cx,
      msg("cel-velho", {
        texto: "respondi pelo celular",
        momento: new Date(Date.now() - 5 * 60_000).toISOString(),
      }),
    );
    const c = await conversa(t, x.conversa);
    t.igual(
      [c.ultima_mensagem_id, c.ultima_mensagem_preview],
      [cel, "respondi pelo celular"],
      "prévia do celular",
    );
    const [n] = await t.sql(
      `select status::text from public.mensagens where conversa_id = $1 and origem = 'nina'`,
      [x.conversa],
    );
    t.igual(n.status, "cancelada", "resposta da Nina cancelada");
    // a mensagem da tela durante a fila da Nina: prévia da tela
    const y = await comRodada(t, b, "5511900000002");
    await concluirRodada(t, y.rodada, ["resposta"]);
    const h = await humanoTela(t, b.uAtend, y.conversa, "eu respondo");
    const cy = await conversa(t, y.conversa);
    t.igual(
      [cy.ultima_mensagem_id, cy.ultima_mensagem_preview],
      [h, "eu respondo"],
      "prévia da tela",
    );
  });

  it("prévia: conversa sem ultima_mensagem_id (de antes do pacote) é refeita na próxima mudança de status", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await concluirRodada(t, x.rodada, ["resposta"]);
    await t.sql(`update public.conversas set ultima_mensagem_id = null where id = $1`, [
      x.conversa,
    ]);
    await t.sql(`select id from public.pegar_envios(10)`);
    const [m] = await t.sql(
      `select id from public.mensagens where conversa_id = $1 and origem = 'nina'`,
      [x.conversa],
    );
    t.igual((await conversa(t, x.conversa)).ultima_mensagem_id, m.id, "preenchida");
  });

  it("prévia: o lead escreve com a resposta da Nina na fila e a pessoa responde (tela e celular): a prévia é da pessoa", async () => {
    const b = await preparar(t);
    const casos: [string, (conv: string) => Promise<string>][] = [
      ["5511900000001", (conv) => humanoTela(t, b.uAtend, conv, "resposta da pessoa")],
      [
        "5511900000002",
        () => celular(t, b.cx, msg("cel-pessoa", { texto: "resposta da pessoa" }), "5511900000002"),
      ],
    ];
    for (const [tel, responder] of casos) {
      const x = await comRodada(t, b, tel);
      await concluirRodada(t, x.rodada, ["resposta da Nina"]);
      const e2 = await entrada(t, b.cx, msg(`w2-${tel}`, { texto: "lead w2" }), tel);
      let c = await conversa(t, x.conversa);
      t.igual(
        [c.ultima_mensagem_id, c.ultima_mensagem_preview],
        [e2.mensagem_id, "lead w2"],
        `${tel}: prévia do lead`,
      );
      const [{ n }] = await t.sql(
        `select count(*)::int as n from public.mensagens where conversa_id = $1 and origem = 'nina' and status = 'na_fila'`,
        [x.conversa],
      );
      t.igual(n, 1, `${tel}: 1 resposta da Nina na fila`);
      const h = await responder(x.conversa);
      const [mh] = await t.sql(`select momento from public.mensagens where id = $1`, [h]);
      c = await conversa(t, x.conversa);
      t.igual(
        [c.ultima_mensagem_id, c.ultima_mensagem_preview, c.ultima_mensagem_em.getTime()],
        [h, "resposta da pessoa", mh.momento.getTime()],
        `${tel}: prévia, id e hora da pessoa`,
      );
      const [nina] = await t.sql(
        `select status::text from public.mensagens where conversa_id = $1 and origem = 'nina'`,
        [x.conversa],
      );
      t.igual(nina.status, "cancelada", `${tel}: resposta da Nina cancelada`);
    }
  });

  it("prévia: o gatilho de atualizar trava a conversa antes de refazer; o lead apaga a última e manda outra", async () => {
    // A corrida (dois webhooks ao mesmo tempo) não se reproduz numa conexão só: aqui
    // ficam a trava no corpo e a sequência de um webhook depois do outro.
    const [{ src }] = await t.sql(
      `select prosrc as src from pg_proc where proname = 'tg_mensagens_apos_atualizar'`,
    );
    const trava = src.indexOf("for update");
    t.ok(trava > 0, "trava a conversa");
    t.ok(trava < src.indexOf("order by m.momento desc"), "a trava vem antes da escolha da última");
    t.ok(src.indexOf("for update") > src.indexOf("if not v_refaz"), "só trava quando vai refazer");
    const b = await preparar(t);
    const e1 = await entrada(t, b.cx, msg("w-1", { texto: "primeira" }));
    await entrada(t, b.cx, msg("w-2", { texto: "com erro" }));
    await entrada(t, b.cx, msg("w-2", { apagada: true }));
    let c = await conversa(t, e1.conversa_id);
    t.igual(
      [c.ultima_mensagem_id, c.ultima_mensagem_preview],
      [e1.mensagem_id, "primeira"],
      "volta para a anterior",
    );
    const e3 = await entrada(t, b.cx, msg("w-3", { texto: "corrigida" }));
    c = await conversa(t, e1.conversa_id);
    t.igual(
      [c.ultima_mensagem_id, c.ultima_mensagem_preview],
      [e3.mensagem_id, "corrigida"],
      "a nova é a última",
    );
    // apagar uma que não é a última (não refaz) não mexe na prévia
    await entrada(t, b.cx, msg("w-1", { apagada: true }));
    t.igual(
      (await conversa(t, e1.conversa_id)).ultima_mensagem_id,
      e3.mensagem_id,
      "continua a nova",
    );
  });

  it("concluir_envio: apagar a duplicata do eco apaga o evento celular dela; o celular de verdade fica", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await concluirRodada(t, x.rodada, ["Texto da Nina", "Segunda parte"]);
    const [m] = await t.sql(`select id from public.pegar_envios(10)`);
    // eco com texto mudado pelo gateway: não casa e entra como humano_celular
    await celular(t, b.cx, msg("wamid-dup", { texto: "*Texto* da Nina" }));
    t.igual(
      await eventos(t, x.conversa),
      [ev("celular", { de: "nina" })],
      "a duplicata gravou celular",
    );
    await t.sql(`select public.concluir_envio($1, 'wamid-dup', 'gw-dup')`, [m.id]);
    t.igual(await eventos(t, x.conversa), [], "evento da duplicata apagado");
    const c = await conversa(t, x.conversa);
    t.igual(
      [c.modo, c.motivo_humano],
      ["nina", null],
      "o comportamento antigo continua: volta para a Nina",
    );
    const [p2] = await t.sql(
      `select status::text from public.mensagens where texto = 'Segunda parte'`,
    );
    t.igual(p2.status, "na_fila", "2ª parte volta para a fila");

    // celular de verdade no meio: o evento dele fica
    const y = await comRodada(t, b, "5511900000002");
    await concluirRodada(t, y.rodada, ["Outra da Nina"]);
    const [my] = await t.sql(`select id from public.pegar_envios(10)`);
    await celular(t, b.cx, msg("wamid-real", { texto: "respondi eu mesmo" }), "5511900000002");
    await celular(t, b.cx, msg("wamid-dup2", { texto: "_Outra da Nina_" }), "5511900000002");
    await t.sql(`select public.concluir_envio($1, 'wamid-dup2', null)`, [my.id]);
    t.igual(
      await eventos(t, y.conversa),
      [ev("celular", { de: "nina" })],
      "o celular de verdade fica",
    );
    t.igual((await conversa(t, y.conversa)).modo, "humano", "continua com o humano");
  });

  it("desativado: assumir e mandar pela tela (conversa sem responsável) dão sem_acesso; ativo continua", async () => {
    // A corrida com o desativar_membro não se reproduz numa conexão só: aqui ficam a
    // trava (for share) no corpo e a conferência de "ativo" que vem depois dela.
    for (const f of ["assumir_conversa", "tg_mensagens_apos_inserir"]) {
      const [{ src }] = await t.sql(`select prosrc as src from pg_proc where proname = $1`, [f]);
      t.ok(
        /from public\.membros mb\s+where mb\.id = \S+ and mb\.ativo\s+for share/.test(src),
        `${f}: for share no membro ativo`,
      );
    }
    const [{ src: a }] = await t.sql(
      `select prosrc as src from pg_proc where proname = 'assumir_conversa'`,
    );
    t.ok(
      a.indexOf("for share") <
        a.indexOf("from public.conversas c where c.id = p_conversa for update"),
      "assumir: membro antes da conversa (mesma ordem do desativar_membro)",
    );
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await t.sql(`update public.membros set ativo = false where id = $1`, [b.mOutro]);
    await t.erro(assumir(t, b.uOutro, x.conversa), "sem_acesso");
    // o gatilho: humano_tela de quem foi desativado numa conversa sem responsável
    // (a policy já barra pela tela; aqui o insert vem direto, sem RLS)
    await t.erro(
      t.sql(
        `insert into public.mensagens (conversa_id, direcao, origem, texto, status, autor_membro_id)
       values ($1, 'saida', 'humano_tela', 'x', 'na_fila', $2)`,
        [x.conversa, b.mOutro],
      ),
      "sem_acesso",
    );
    let c = await conversa(t, x.conversa);
    t.igual([c.modo, c.responsavel_id], ["nina", null], "nada mudou");
    // ativo: continua igual
    await humanoTela(t, b.uAtend, x.conversa, "eu");
    c = await conversa(t, x.conversa);
    t.igual([c.modo, c.responsavel_id], ["humano", b.mAtend], "ficou com quem mandou");
    // com responsável, a mensagem de outra pessoa não passa pela conferência
    await t.sql(
      `insert into public.mensagens (conversa_id, direcao, origem, texto, status, autor_membro_id)
       values ($1, 'saida', 'humano_tela', 'y', 'na_fila', $2)`,
      [x.conversa, b.mOutro],
    );
    t.igual((await conversa(t, x.conversa)).responsavel_id, b.mAtend, "responsável continua");
    const y = await comRodada(t, b, "5511900000002");
    await assumir(t, b.uAtend, y.conversa);
    t.igual((await conversa(t, y.conversa)).responsavel_id, b.mAtend, "ativo assume");
  });

  it("ultima_da_nina_em: grava quando a resposta da Nina sai; cancelada e mensagem da equipe não", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await concluirRodada(t, x.rodada, ["um", "dois"]);
    t.igual((await conversa(t, x.conversa)).ultima_da_nina_em, null, "na fila: nada");
    const [m1] = await t.sql(`select id from public.pegar_envios(10)`);
    t.igual((await conversa(t, x.conversa)).ultima_da_nina_em, null, "enviando: nada");
    await t.sql(`select public.concluir_envio($1, 'wamid-1', null)`, [m1.id]);
    const [{ ok }] = await t.sql(
      `select c.ultima_da_nina_em = m.momento as ok from public.conversas c, public.mensagens m where c.id = $1 and m.id = $2`,
      [x.conversa, m1.id],
    );
    t.ok(ok, "ultima_da_nina_em = momento do envio");
    const antes = (await conversa(t, x.conversa)).ultima_da_nina_em.getTime();
    // entregue e lida da mesma mensagem não mexem
    await t.sql(`select public.atualizar_status($1, 'wamid-1', 'lida', now())`, [b.cx]);
    t.igual((await conversa(t, x.conversa)).ultima_da_nina_em.getTime(), antes, "lida não mexe");
    // a mensagem da equipe que sai não conta
    await assumir(t, b.uAtend, x.conversa);
    const h = await humanoTela(t, b.uAtend, x.conversa);
    await t.sql(`select id from public.pegar_envios(10)`);
    await t.sql(`select public.concluir_envio($1, 'wamid-h', null)`, [h]);
    t.igual((await conversa(t, x.conversa)).ultima_da_nina_em.getTime(), antes, "equipe não conta");
    // a cancelada (assumir) não conta
    const [{ s }] = await t.sql(
      `select status::text as s from public.mensagens where conversa_id = $1 and texto = 'dois'`,
      [x.conversa],
    );
    t.igual(s, "cancelada", "a 2ª foi cancelada");
    // direto de enviando para entregue (status antes do concluir_envio) também conta
    const y = await comRodada(t, b, "5511900000002");
    await concluirRodada(t, y.rodada, ["oi"]);
    const [m2] = await t.sql(`select id from public.pegar_envios(10)`);
    await t.sql(`update public.mensagens set id_externo = 'wamid-y' where id = $1`, [m2.id]);
    await t.sql(`select public.atualizar_status($1, 'wamid-y', 'entregue', now())`, [b.cx]);
    t.ok((await conversa(t, y.conversa)).ultima_da_nina_em, "entregue conta");
  });

  // ----------------------------------------------------------- pegar_rodadas
  it("pegar_rodadas: vazio sem o onboarding concluído (a mensagem fica armada); normal depois", async () => {
    const b = await preparar(t, { onboarding: false });
    const e = await entrada(t, b.cx, msg("w-1"));
    await vencer(t, e.conversa_id);
    t.igual((await pegarRodadas(t)).length, 0, "sem onboarding: vazio");
    t.ok((await conversa(t, e.conversa_id)).responder_apos, "continua armada");
    const [{ n }] = await t.sql(`select count(*)::int as n from public.rodadas`);
    t.igual(n, 0, "nenhuma rodada criada");
    await t.sql(`update public.configuracao set onboarding_concluido_em = now() where id = 1`);
    const rs = await pegarRodadas(t);
    t.igual(rs.length, 1, "depois do onboarding: a Nina responde");
    t.igual(
      [rs[0].conversa_id, rs[0].tentativa, rs[0].status],
      [e.conversa_id, 1, "rodando"],
      "rodada",
    );
    const [m] = await t.sql(`select rodada_id from public.mensagens where id = $1`, [
      e.mensagem_id,
    ]);
    t.igual(m.rodada_id, rs[0].id, "entrada ligada");
    t.igual((await conversa(t, e.conversa_id)).responder_apos, null, "responder_apos limpo");
    t.igual((await pegarRodadas(t)).length, 0, "não repete");
  });

  it("pegar_rodadas: sem onboarding, a rodada presa ainda expira (limpeza roda antes)", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await t.sql(`update public.configuracao set onboarding_concluido_em = null where id = 1`);
    await t.sql(
      `update public.rodadas set iniciada_em = now() - interval '6 minutes' where id = $1`,
      [x.rodada],
    );
    t.igual((await pegarRodadas(t)).length, 0, "vazio");
    const [r] = await t.sql(`select status::text, motivo::text from public.rodadas where id = $1`, [
      x.rodada,
    ]);
    t.igual(r, { status: "falhou", motivo: "erro_provedor" }, "expirou");
  });

  // ----------------------------------------------------------- nina_atualizar_contato
  it("nina_atualizar_contato: só preenche campo vazio; resumo_nina sempre, com resumo_nina_em; fatos e proximo_passo em anotacoes_nina", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await t.sql(
      `update public.contatos set nome = 'Nome da equipe', email = null, empresa = '  ' where id = $1`,
      [x.contato],
    );
    const fatos = [
      { rotulo: "Interesse", valor: "Plano anual", mensagem_id: x.entrada },
      { rotulo: "Cidade", valor: "Recife" },
    ];
    const passo = { titulo: "Mandar proposta", texto: "Até sexta" };
    await t.como("service_role", null, (q) =>
      q(`select public.nina_atualizar_contato($1, $2::jsonb)`, [
        x.rodada,
        JSON.stringify({
          nome: "Nome da Nina",
          email: "lead@empresa.exemplo",
          empresa: "Empresa Exemplo",
          resumo_nina: "Quer o plano anual.",
          fatos,
          proximo_passo: passo,
        }),
      ]),
    );
    let [c] = await t.sql(
      `select nome, email, empresa, resumo_nina, resumo_nina_em is not null as tem_em, anotacoes_nina from public.contatos where id = $1`,
      [x.contato],
    );
    t.igual(
      c,
      {
        nome: "Nome da equipe",
        email: "lead@empresa.exemplo",
        empresa: "Empresa Exemplo",
        resumo_nina: "Quer o plano anual.",
        tem_em: true,
        anotacoes_nina: { fatos, proximo_passo: passo },
      },
      "primeira chamada",
    );
    // preenchidos são ignorados; resumo sempre; proximo_passo null substitui e os fatos ficam
    const [{ em1 }] = await t.sql(
      `select resumo_nina_em as em1 from public.contatos where id = $1`,
      [x.contato],
    );
    await t.sql(`select public.nina_atualizar_contato($1, $2::jsonb)`, [
      x.rodada,
      JSON.stringify({
        email: "outro@empresa.exemplo",
        resumo_nina: "Resumo novo.",
        proximo_passo: null,
      }),
    ]);
    [c] = await t.sql(
      `select email, resumo_nina, resumo_nina_em > $2 as mais_novo, anotacoes_nina from public.contatos where id = $1`,
      [x.contato, em1],
    );
    t.igual(
      c,
      {
        email: "lead@empresa.exemplo",
        resumo_nina: "Resumo novo.",
        mais_novo: true,
        anotacoes_nina: { fatos, proximo_passo: null },
      },
      "segunda chamada",
    );
    // valor vazio não preenche; sem resumo, resumo_nina_em não muda
    const y = await comRodada(t, b, "5511900000002");
    await t.sql(`select public.nina_atualizar_contato($1, $2::jsonb)`, [
      y.rodada,
      JSON.stringify({ nome: "   ", empresa: "" }),
    ]);
    const [cy] = await t.sql(
      `select nome, empresa, resumo_nina_em, anotacoes_nina from public.contatos where id = $1`,
      [y.contato],
    );
    t.igual(
      cy,
      { nome: null, empresa: null, resumo_nina_em: null, anotacoes_nina: null },
      "nada entrou",
    );
    // só fatos
    await t.sql(`select public.nina_atualizar_contato($1, $2::jsonb)`, [
      y.rodada,
      JSON.stringify({ fatos: [] }),
    ]);
    t.igual(
      (await t.sql(`select anotacoes_nina from public.contatos where id = $1`, [y.contato]))[0]
        .anotacoes_nina,
      { fatos: [] },
      "só fatos",
    );
    // formatos recusados
    for (const ruim of [
      { telefone: "5511999999999" },
      { fatos: "texto" },
      { fatos: [{ rotulo: "x" }] },
      { fatos: [{ rotulo: "x", valor: 3 }] },
      { fatos: [{ rotulo: "x", valor: "y", mensagem_id: 5 }] },
      { proximo_passo: "ligar" },
      { proximo_passo: { titulo: "x" } },
    ]) {
      await t.erro(
        t.sql(`select public.nina_atualizar_contato($1, $2::jsonb)`, [
          y.rodada,
          JSON.stringify(ruim),
        ]),
        "campo_nao_permitido",
      );
    }
    // rodada que não está rodando
    await concluirRodada(t, y.rodada, ["ok"]);
    await t.erro(
      t.sql(`select public.nina_atualizar_contato($1, '{"nome":"x"}'::jsonb)`, [y.rodada]),
      "rodada_nao_rodando",
    );
  });

  // ----------------------------------------------------------- citação
  it("citação na entrada e no celular: responde_a_id pela mesma conexão; não achada fica nula", async () => {
    const b = await preparar(t);
    const a = await entrada(t, b.cx, msg("w-a"));
    const r1 = await entrada(t, b.cx, msg("w-b", { responde_a_id_externo: " w-a " }));
    const r2 = await entrada(t, b.cx, msg("w-c", { responde_a_id_externo: "nao-existe" }));
    const r3 = await entrada(t, b.cx, msg("w-d", { responde_a_id_externo: "" }));
    const cita = async (id: string) =>
      (await t.sql(`select responde_a_id from public.mensagens where id = $1`, [id]))[0]
        .responde_a_id;
    t.igual(await cita(r1.mensagem_id), a.mensagem_id, "achada");
    t.igual(await cita(r2.mensagem_id), null, "não achada");
    t.igual(await cita(r3.mensagem_id), null, "vazia");
    // reentrega da mesma mensagem não mexe na citação
    await entrada(t, b.cx, msg("w-c", { responde_a_id_externo: "w-a" }));
    t.igual(await cita(r2.mensagem_id), null, "reentrega não muda");
    // outra conexão: o mesmo id externo não casa
    await t.sql(`update public.conexoes set ativa = false where id = $1`, [b.cx]);
    const [{ id: cx2 }] = await t.sql(
      `insert into public.conexoes (gateway, nome, id_externo, ativa, status) values ('evolution', 'Outra', 'inst-2', true, 'conectada') returning id`,
    );
    const r4 = await entrada(t, cx2, msg("w-e", { responde_a_id_externo: "w-a" }));
    t.igual(await cita(r4.mensagem_id), null, "outra conexão");
    // celular (não eco): citação achada e não achada
    const c1 = await celular(t, cx2, msg("cel-1", { responde_a_id_externo: "w-e" }));
    const c2 = await celular(t, cx2, msg("cel-2", { responde_a_id_externo: "w-a" }));
    t.igual(await cita(c1), r4.mensagem_id, "celular achada");
    t.igual(await cita(c2), null, "celular não achada");
  });

  // ----------------------------------------------------------- reenviar_mensagem
  it("reenviar_mensagem: o atendente e o admin reenviam a mensagem da equipe que falhou", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    const m = await mensagemQueFalhou(t, b, b.uAtend, x.conversa);
    await reenviar(t, "authenticated", b.uAtend, m);
    const [r] = await t.sql(
      `select status::text, erro, tentativas::int, conexao_id, enviar_apos <= now() as ja, autor_membro_id from public.mensagens where id = $1`,
      [m],
    );
    t.igual(
      r,
      {
        status: "na_fila",
        erro: null,
        tentativas: 0,
        conexao_id: b.cx,
        ja: true,
        autor_membro_id: b.mAtend,
      },
      "de volta na fila",
    );
    const env = await t.sql(`select id, tentativas::int from public.pegar_envios(10)`);
    t.igual(
      env.map((e) => [e.id, e.tentativas]),
      [[m, 1]],
      "sai de novo, com a 1ª tentativa",
    );
    // o admin reenvia a mensagem do atendente (outra mensagem), e ela vai pela conexão ativa nova
    await t.sql(`select public.concluir_envio($1, 'wamid-ok', null)`, [m]);
    const m2 = await mensagemQueFalhou(t, b, b.uAtend, x.conversa, "http_400");
    await t.sql(`update public.conexoes set ativa = false where id = $1`, [b.cx]);
    const [{ id: cx2 }] = await t.sql(
      `insert into public.conexoes (gateway, nome, id_externo, ativa, status) values ('evolution', 'Nova', 'inst-2', true, 'conectada') returning id`,
    );
    await reenviar(t, "authenticated", b.uAdmin, m2);
    const [r2] = await t.sql(
      `select status::text, conexao_id from public.mensagens where id = $1`,
      [m2],
    );
    t.igual(r2, { status: "na_fila", conexao_id: cx2 }, "na conexão ativa");
    // a prévia não muda e a conversa fica como estava
    const c = await conversa(t, x.conversa);
    t.igual([c.ultima_mensagem_id, c.responsavel_id], [m2, b.mAtend], "conversa");
  });

  it("reenviar_mensagem: nao_reenviavel (não é da equipe pela tela, não falhou, ou pode ter chegado)", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await concluirRodada(t, x.rodada, ["da Nina"]);
    const [nina] = await t.sql(
      `select id from public.mensagens where conversa_id = $1 and origem = 'nina'`,
      [x.conversa],
    );
    await t.sql(
      `update public.mensagens set status = 'falhou', erro = 'sem_destino' where id = $1`,
      [nina.id],
    );
    await t.erro(reenviar(t, "authenticated", b.uAtend, nina.id), "nao_reenviavel");
    // humano_tela ainda na fila
    const h = await humanoTela(t, b.uAtend, x.conversa);
    await t.erro(reenviar(t, "authenticated", b.uAtend, h), "nao_reenviavel");
    // entrada do lead e mensagem do celular
    await t.erro(reenviar(t, "authenticated", b.uAtend, x.entrada), "nao_reenviavel");
    const cel = await celular(t, b.cx, msg("cel-1"));
    await t.sql(`update public.mensagens set status = 'falhou' where id = $1`, [cel]);
    await t.erro(reenviar(t, "authenticated", b.uAtend, cel), "nao_reenviavel");
    // erros que dizem que pode ter chegado
    for (const erro of [
      "sem_resposta_do_envio",
      "tempo_esgotado",
      "falha_de_rede",
      "http_502",
      "http:503",
      "meta_500_131000",
      "zernio_http_504",
    ]) {
      await t.sql(`update public.mensagens set status = 'falhou', erro = $2 where id = $1`, [
        h,
        erro,
      ]);
      await t.erro(reenviar(t, "authenticated", b.uAtend, h), "nao_reenviavel");
    }
    // com id do gateway (ele aceitou), mesmo com erro comum
    await t.sql(
      `update public.mensagens set status = 'falhou', erro = 'sem_destino', id_gateway = 'gw-1' where id = $1`,
      [h],
    );
    await t.erro(reenviar(t, "authenticated", b.uAtend, h), "nao_reenviavel");
    const [r] = await t.sql(`select status::text from public.mensagens where id = $1`, [h]);
    t.igual(r.status, "falhou", "continua falhou");
    // os caminhos de verdade: sem_resposta_do_envio (pegar_envios) e falha_no_gateway (atualizar_status)
    const y = await comRodada(t, b, "5511900000002");
    await assumir(t, b.uAtend, y.conversa);
    const p = await humanoTela(t, b.uAtend, y.conversa);
    await t.sql(`select id from public.pegar_envios(10)`);
    await t.sql(
      `update public.mensagens set tentativas = 3, status_em = now() - interval '3 minutes' where id = $1`,
      [p],
    );
    await t.sql(`select id from public.pegar_envios(10)`);
    t.igual(
      (await t.sql(`select erro from public.mensagens where id = $1`, [p]))[0].erro,
      "sem_resposta_do_envio",
      "presa",
    );
    await t.erro(reenviar(t, "authenticated", b.uAtend, p), "nao_reenviavel");
    const z = await comRodada(t, b, "5511900000003");
    await assumir(t, b.uAtend, z.conversa);
    const g = await humanoTela(t, b.uAtend, z.conversa);
    await t.sql(`select id from public.pegar_envios(10)`);
    await t.sql(`select public.concluir_envio($1, 'wamid-g', null)`, [g]);
    await t.sql(`select public.atualizar_status($1, 'wamid-g', 'falhou', now())`, [b.cx]);
    t.igual(
      (await t.sql(`select status::text, erro from public.mensagens where id = $1`, [g]))[0],
      { status: "falhou", erro: "falha_no_gateway" },
      "falha do gateway",
    );
    // o gateway avisou que não entregou: não chegou, então pode sair de novo, com os ids limpos
    await reenviar(t, "authenticated", b.uAtend, g);
    t.igual(
      (
        await t.sql(
          `select status::text, erro, id_externo, id_gateway from public.mensagens where id = $1`,
          [g],
        )
      )[0],
      { status: "na_fila", erro: null, id_externo: null, id_gateway: null },
      "falha do gateway reenvia",
    );
    // não existe
    await t.erro(
      t.como("authenticated", b.uAtend, (q) =>
        q(`select public.reenviar_mensagem(gen_random_uuid())`),
      ),
      "nao_encontrado",
    );
  });

  it("reenviar_mensagem: sem_conexao_ativa e janela_fechada", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    const m = await mensagemQueFalhou(t, b, b.uAtend, x.conversa);
    await t.sql(`update public.conexoes set ativa = false where id = $1`, [b.cx]);
    await t.erro(reenviar(t, "authenticated", b.uAtend, m), "sem_conexao_ativa");
    // conexão oficial com a janela de 24 h fechada
    await t.sql(
      `insert into public.conexoes (gateway, nome, id_externo, ativa, status) values ('meta', 'Meta', 'pn-1', true, 'conectada')`,
    );
    await t.sql(
      `update public.conversas set ultima_do_lead_em = now() - interval '25 hours' where id = $1`,
      [x.conversa],
    );
    await t.erro(reenviar(t, "authenticated", b.uAtend, m), "janela_fechada");
    await t.sql(`update public.conversas set ultima_do_lead_em = null where id = $1`, [x.conversa]);
    await t.erro(reenviar(t, "authenticated", b.uAtend, m), "janela_fechada");
    const [r] = await t.sql(`select status::text from public.mensagens where id = $1`, [m]);
    t.igual(r.status, "falhou", "continua falhou");
    // janela aberta: vai
    await t.sql(
      `update public.conversas set ultima_do_lead_em = now() - interval '1 hour' where id = $1`,
      [x.conversa],
    );
    await reenviar(t, "authenticated", b.uAtend, m);
    t.igual(
      (await t.sql(`select status::text from public.mensagens where id = $1`, [m]))[0].status,
      "na_fila",
      "na fila",
    );
  });

  it("reenviar_mensagem: anon, conta sem membro e membro desativado não reenviam", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    const m = await mensagemQueFalhou(t, b, b.uAtend, x.conversa);
    await t.erro(reenviar(t, "anon", null, m), "permission denied");
    const fora = await t.criarUsuario(`fora@${DOM}`);
    await t.erro(reenviar(t, "authenticated", fora, m), "sem_acesso");
    await t.sql(`update public.membros set ativo = false where id = $1`, [b.mOutro]);
    await t.erro(reenviar(t, "authenticated", b.uOutro, m), "sem_acesso");
    const [r] = await t.sql(`select status::text from public.mensagens where id = $1`, [m]);
    t.igual(r.status, "falhou", "nada mudou");
    // a permissão de execução é a de uma função de tela
    const [p] = await t.sql(
      `select has_function_privilege('anon', 'public.reenviar_mensagem(uuid)', 'execute') as anon,
              has_function_privilege('authenticated', 'public.reenviar_mensagem(uuid)', 'execute') as auth,
              has_function_privilege('service_role', 'public.reenviar_mensagem(uuid)', 'execute') as srv`,
    );
    t.igual(p, { anon: false, auth: true, srv: true }, "grants");
  });

  // ----------------------------------------------------------- permissões e forma
  it("forma: recriadas com a mesma assinatura e retorno; security definer e search_path vazio; gatilhos sem execução direta", async () => {
    const esperadas = [
      ["tg_mensagens_apos_inserir", "", "trigger"],
      ["tg_mensagens_apos_atualizar", "", "trigger"],
      ["assumir_conversa", "p_conversa uuid", "void"],
      ["devolver_para_nina", "p_conversa uuid", "void"],
      ["nina_passar_para_humano", "p_rodada uuid", "void"],
      ["falhar_rodada", "p_rodada uuid, p_motivo motivo_humano, p_passageiro boolean", "void"],
      ["nina_mover_etapa", "p_rodada uuid, p_etapa uuid", "void"],
      ["nina_atualizar_contato", "p_rodada uuid, p_campos jsonb", "void"],
      ["pegar_rodadas", "p_limite integer", "SETOF rodadas"],
      [
        "registrar_entrada",
        "p_conexao uuid, p_ids jsonb, p_nome_whatsapp text, p_msg jsonb",
        "TABLE(mensagem_id uuid, conversa_id uuid, nova boolean)",
      ],
      ["registrar_saida_celular", "p_conexao uuid, p_ids jsonb, p_msg jsonb", "uuid"],
      ["reenviar_mensagem", "p_msg uuid", "void"],
      ["concluir_envio", "p_msg uuid, p_id_externo text, p_id_gateway text", "void"],
    ];
    for (const [nome, args, ret] of esperadas) {
      const linhas = await t.sql(
        `select pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as ret,
                p.prosecdef as definer, p.proconfig as cfg
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1`,
        [nome],
      );
      t.igual(linhas.length, 1, `${nome}: uma só versão`);
      const l = linhas[0];
      t.igual(
        [l.args.replace(/public\./g, ""), l.ret.replace(/public\./g, "")],
        [args, ret],
        `${nome}: assinatura`,
      );
      t.igual(
        [l.definer, l.cfg],
        [true, ['search_path=""']],
        `${nome}: security definer e search_path`,
      );
    }
    for (const f of ["tg_mensagens_apos_inserir()", "tg_mensagens_apos_atualizar()"]) {
      for (const papel of ["anon", "authenticated", "service_role"]) {
        const [{ ok }] = await t.sql(`select has_function_privilege($1, $2, 'execute') as ok`, [
          papel,
          `public.${f}`,
        ]);
        t.igual(ok, false, `${papel} não executa ${f}`);
      }
    }
    // as do servidor continuam só do service_role
    for (const f of [
      "falhar_rodada(uuid, public.motivo_humano, boolean)",
      "pegar_rodadas(integer)",
      "nina_mover_etapa(uuid, uuid)",
      "nina_passar_para_humano(uuid)",
      "nina_atualizar_contato(uuid, jsonb)",
      "registrar_entrada(uuid, jsonb, text, jsonb)",
      "registrar_saida_celular(uuid, jsonb, jsonb)",
      "concluir_envio(uuid, text, text)",
    ]) {
      const [p] = await t.sql(
        `select has_function_privilege('anon', $1, 'execute') as anon, has_function_privilege('authenticated', $1, 'execute') as auth,
                has_function_privilege('service_role', $1, 'execute') as srv`,
        [`public.${f}`],
      );
      t.igual(p, { anon: false, auth: false, srv: true }, f);
    }
    for (const f of ["assumir_conversa(uuid)", "devolver_para_nina(uuid)"]) {
      const [p] = await t.sql(
        `select has_function_privilege('anon', $1, 'execute') as anon, has_function_privilege('authenticated', $1, 'execute') as auth,
                has_function_privilege('service_role', $1, 'execute') as srv`,
        [`public.${f}`],
      );
      t.igual(p, { anon: false, auth: true, srv: true }, f);
    }
    const [g] = await t.sql(
      `select tgname, pg_get_triggerdef(oid) as def from pg_trigger where tgname = 'mensagens_apos_atualizar'`,
    );
    t.ok(
      /AFTER UPDATE OF status, apagada_em ON public\.mensagens/.test(g.def),
      `gatilho: ${g.def}`,
    );
    // o arquivo pode ser aplicado de novo
    await t.aplicar("src/test/banco/base/0006_nina_ligacao_conversa.sql");
  });

  it("atendente não grava evento direto; o evento do gatilho é gravado mesmo sem grant dele", async () => {
    const b = await preparar(t);
    const x = await comRodada(t, b);
    await t.erro(
      t.como("authenticated", b.uAtend, (q) =>
        q(`insert into public.conversa_eventos (conversa_id, tipo) values ($1, 'assumiu')`, [
          x.conversa,
        ]),
      ),
      "permission denied",
    );
    await humanoTela(t, b.uAtend, x.conversa);
    const lidos = await t.como("authenticated", b.uAtend, (q) =>
      q(`select tipo::text, por_envio from public.conversa_eventos where conversa_id = $1`, [
        x.conversa,
      ]),
    );
    t.igual(lidos, [{ tipo: "assumiu", por_envio: true }], "o membro lê o evento");
  });
});
