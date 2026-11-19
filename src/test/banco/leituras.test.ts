// @vitest-environment node
// Leituras das telas (migration 0007): texto_busca, contatos_lista, contatos_contadores,
// buscar_quadro, custo_das_conversas, marcar_visto e reordenar_etapas. Porte do 31-leituras do banco2.
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

// 1ª conta vira admin pelo gatilho; o atendente recebe membro direto (como o servidor faz);
// uFora tem conta, mas não é membro.
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

async function conexao(t: Banco) {
  const [{ id }] = await t.sql(
    `insert into public.conexoes (gateway, nome, id_externo, status, ativa) values ('zapi', 'Teste', 'inst-1', 'conectada', true) returning id`,
  );
  return id;
}

interface DadosConversa {
  conexao?: string | null;
  modo?: string;
  responsavel?: string | null;
  aguardando?: string | null;
  motivo?: string | null;
  ultima?: string | null;
}

interface DadosContato {
  nome?: string | null;
  nome_whatsapp?: string | null;
  telefone?: string | null;
  email?: string | null;
  empresa?: string | null;
  primeira?: string | null;
  etapa?: string | null;
  conversa?: DadosConversa;
}

// Contato (e conversa, se `conversa` vier) gravado direto, como superusuário.
async function contato(t: Banco, c: DadosContato = {}) {
  const [{ id }] = await t.sql(
    `insert into public.contatos (nome, nome_whatsapp, telefone, email, empresa, primeira_mensagem_em, etapa_id)
     values ($1, $2, $3, $4, $5, $6::timestamptz, coalesce($7::uuid, (select id from public.etapas where chave = 'novo')))
     returning id`,
    [
      c.nome ?? null,
      c.nome_whatsapp ?? null,
      c.telefone ?? null,
      c.email ?? null,
      c.empresa ?? null,
      c.primeira ?? null,
      c.etapa ?? null,
    ],
  );
  // o id que o banco devolve (nulo sem conversa)
  let conversa: Linha = null;
  if (c.conversa) {
    const v = c.conversa;
    [{ id: conversa }] = await t.sql(
      `insert into public.conversas (contato_id, conexao_id, modo, responsavel_id, aguardando_humano_desde, motivo_humano, ultima_mensagem_em)
       values ($1, $2, $3::public.conversa_modo, $4, $5::timestamptz, $6::public.motivo_humano, $7::timestamptz) returning id`,
      [
        id,
        v.conexao ?? null,
        v.modo ?? "nina",
        v.responsavel ?? null,
        v.aguardando ?? null,
        v.motivo ?? null,
        v.ultima ?? null,
      ],
    );
  }
  return { contato: id, conversa };
}

const arr = (ids: string[]) => `{${ids.join(",")}}`;

interface ParametrosLista {
  busca?: string | null;
  recorte?: string | null;
  etapas?: string[];
  de?: string | null;
  ate?: string | null;
  ordem?: string | null | undefined;
  direcao?: string | null | undefined;
  limite?: number | null;
  deslocamento?: number | null;
}

// Chama contatos_lista com os parâmetros por nome (os que faltam vão nulos).
async function lista(q: Consulta, p: ParametrosLista = {}): Promise<Linha> {
  const [{ r }] = await q(
    `select public.contatos_lista($1, $2, $3::uuid[], $4::date, $5::date, $6, $7, $8, $9) as r`,
    [
      p.busca ?? null,
      p.recorte ?? null,
      p.etapas ? arr(p.etapas) : null,
      p.de ?? null,
      p.ate ?? null,
      p.ordem ?? null,
      p.direcao ?? null,
      p.limite ?? null,
      p.deslocamento ?? null,
    ],
  );
  return r;
}

const idsDe = (r: Linha): string[] => r.linhas.map((l: Linha) => l.contato_id).sort();
const ordenados = (ids: string[]) => [...ids].sort();

async function hojeSP(t: Banco) {
  const [{ d, ontem }] = await t.sql(
    `select ((now() at time zone 'America/Sao_Paulo')::date)::text as d,
            ((now() at time zone 'America/Sao_Paulo')::date - 1)::text as ontem`,
  );
  return { d, ontem };
}

// ---------------------------------------------------------------------------
// testes
// ---------------------------------------------------------------------------

const base = await montarBase();
const t = usarBanco(base);

describe("banco: leituras (0007)", { timeout: TEMPO_TESTE }, () => {
  it("texto_busca: minúsculo, sem acento, espaços juntos; nulo continua nulo", async () => {
    const [r] = await t.sql(
      `select public.texto_busca('  Clínica   VALE ') as a,
              public.texto_busca('JOSÉ da Conceição Ñandú ÀÉÎÕÜ Ýÿ') as b,
              public.texto_busca(null) as c,
              public.texto_busca('') as d`,
    );
    t.igual(r.a, "clinica vale");
    t.igual(r.b, "jose da conceicao nandu aeiou yy");
    t.igual(r.c, null);
    t.igual(r.d, "");
    const [{ v }] = await t.sql(
      `select provolatile as v from pg_proc where oid = 'public.texto_busca(text)'::regprocedure`,
    );
    t.igual(v, "i", "immutable");
  });

  it("novos_hoje: virada do dia em São Paulo (23:59 de ontem fica fora, 00:00 de hoje entra)", async () => {
    const { uAdmin } = await equipe(t);
    const { d, ontem } = await hojeSP(t);
    const a = await contato(t, { nome: "Ontem 23h59", primeira: `${ontem} 23:59:59-03` });
    const b = await contato(t, { nome: "Hoje 00h00", primeira: `${d} 00:00:00-03` });
    const c = await contato(t, { nome: "Hoje 23h59", primeira: `${d} 23:59:00-03` });
    // 01:00 em UTC de hoje = 22:00 de ontem em São Paulo: não é de hoje
    const u = await contato(t, { nome: "UTC enganoso", primeira: `${d} 01:00:00+00` });
    const sem = await contato(t, { nome: "Sem mensagem" });
    await t.como("authenticated", uAdmin, async (q) => {
      const [{ k }] = await q("select public.contatos_contadores() as k");
      t.igual(k.novos_hoje, 2, "contador novos_hoje");
      t.igual(k.todos, 5, "contador todos");
      const r = await lista(q, { recorte: "novos_hoje" });
      t.igual(r.total, 2, "total do recorte");
      t.igual(idsDe(r), ordenados([b.contato, c.contato]), "linhas do recorte");
      // "Entrou em" = hoje (data de São Paulo da primeira_mensagem_em), inclusivo
      const h = await lista(q, { de: d, ate: d });
      t.igual(idsDe(h), ordenados([b.contato, c.contato]), "filtro Entrou em hoje");
      const o = await lista(q, { de: ontem, ate: ontem });
      t.igual(idsDe(o), ordenados([a.contato, u.contato]), "filtro Entrou em ontem");
      const desde = await lista(q, { de: ontem });
      t.igual(desde.total, 4, "só o de: o contato sem mensagem do lead sai");
      const todos = await lista(q, {});
      t.ok(idsDe(todos).includes(sem.contato), "sem filtro, o contato sem mensagem aparece");
    });
  });

  it("contatos_lista: 1.500 contatos em páginas de 50, com total certo e ordem estável", async () => {
    const { uAdmin } = await equipe(t);
    const cx = await conexao(t);
    // nomes repetidos (100 nomes) e a última mensagem empatada (10 horários) ou nula (1 em 3)
    await t.sql(
      `with novos as (
         insert into public.contatos (nome, primeira_mensagem_em)
         select 'Lead ' || lpad((i % 100)::text, 3, '0'), timestamptz '2026-10-01 12:00-03' + (i % 5) * interval '1 day'
           from generate_series(1, 1500) as i
         returning id, nome
       ), numerados as (
         select id, row_number() over (order by id) as i from novos
       )
       insert into public.conversas (contato_id, conexao_id, ultima_mensagem_em)
       select id, $1, timestamptz '2026-10-20 10:00-03' + (i % 10) * interval '1 hour'
         from numerados where i % 3 <> 0`,
      [cx],
    );
    await t.como("authenticated", uAdmin, async (q) => {
      for (const [ordem, direcao] of [
        ["ultima", "desc"],
        ["contato", "asc"],
        ["entrada", "desc"],
        ["etapa", "asc"],
      ]) {
        const vistos = [];
        for (let pagina = 0; pagina < 30; pagina++) {
          const r = await lista(q, { ordem, direcao, limite: 50, deslocamento: pagina * 50 });
          t.igual(r.total, 1500, `total na página ${pagina} (${ordem})`);
          t.igual(r.linhas.length, 50, `tamanho da página ${pagina} (${ordem})`);
          vistos.push(...r.linhas);
        }
        const fim = await lista(q, { ordem, direcao, limite: 50, deslocamento: 1500 });
        t.igual([fim.total, fim.linhas.length], [1500, 0], "depois da última página");
        t.igual(
          new Set(vistos.map((l) => l.contato_id)).size,
          1500,
          `nenhuma linha repetida nem pulada (${ordem})`,
        );
        // a mesma ordem, de novo: igual (estável)
        const de200 = [];
        for (let i = 0; i < 1500; i += 200) {
          de200.push(...(await lista(q, { ordem, direcao, limite: 200, deslocamento: i })).linhas);
        }
        t.igual(
          de200.map((l) => l.contato_id),
          vistos.map((l) => l.contato_id),
          `páginas de 200 dão a mesma ordem (${ordem})`,
        );
        if (ordem === "ultima") {
          const tempos: (number | null)[] = vistos.map((l) =>
            l.ultima_mensagem_em ? Date.parse(l.ultima_mensagem_em) : null,
          );
          const primeiroNulo = tempos.indexOf(null);
          t.igual(primeiroNulo, 1000, "as 500 sem conversa vêm no fim");
          t.ok(
            tempos.slice(primeiroNulo).every((x) => x === null),
            "nulos só no fim",
          );
          for (let i = 1; i < primeiroNulo; i++)
            t.ok(tempos[i - 1]! >= tempos[i]!, `desc na posição ${i}`);
          // empate: desempate pelo nome e depois pelo id
          for (let i = 1; i < 1500; i++) {
            const [x, y] = [vistos[i - 1], vistos[i]];
            if (x.ultima_mensagem_em === y.ultima_mensagem_em) {
              t.ok(
                x.nome < y.nome || (x.nome === y.nome && x.contato_id < y.contato_id),
                `desempate na posição ${i}`,
              );
            }
          }
        }
        if (ordem === "contato") {
          for (let i = 1; i < 1500; i++)
            t.ok(vistos[i - 1].nome <= vistos[i].nome, `A a Z na posição ${i}`);
        }
      }
      // formato da linha
      const [l] = (await lista(q, { limite: 1 })).linhas;
      t.igual(
        Object.keys(l).sort(),
        [
          "contato_id",
          "conversa",
          "criado_em",
          "email",
          "empresa",
          "entrou_em",
          "etapa_id",
          "etapa_ordem",
          "nome",
          "nome_whatsapp",
          "primeira_mensagem_em",
          "telefone",
          "ultima_mensagem_em",
        ],
        "chaves da linha",
      );
      t.igual(
        Object.keys(l.conversa).sort(),
        [
          "aguardando_humano_desde",
          "id",
          "modo",
          "motivo_humano",
          "nao_lidas",
          "responsavel_id",
          "ultima_da_nina_em",
          "ultima_do_lead_em",
          "ultima_mensagem_em",
        ],
        "chaves da conversa",
      );
      // padrão = 50; limite fora de 1..200 é recusado
      t.igual((await lista(q, {})).linhas.length, 50, "página padrão de 50");
      await t.erro(lista(q, { limite: 201 }), "parametro_invalido");
      await t.erro(lista(q, { limite: 0 }), "parametro_invalido");
    });
  });

  it("contatos_lista: busca sem acento e por telefone, com ou sem máscara", async () => {
    const { uAtend } = await equipe(t);
    const jose = await contato(t, {
      nome: "José da Conceição",
      empresa: "Clínica Vale",
      telefone: "5511900000007",
      email: "jose@empresa.exemplo",
      primeira: "2026-10-01 10:00-03",
    });
    const maria = await contato(t, {
      nome_whatsapp: "Mária Ávila",
      telefone: "5521988887777",
      email: "MARIA@Empresa.Exemplo",
      primeira: "2026-10-01 10:00-03",
    });
    await contato(t, { nome: "Outro 1234", telefone: "5531911112222" });
    await t.como("authenticated", uAtend, async (q) => {
      const so = async (busca: string) => idsDe(await lista(q, { busca }));
      t.igual(await so("jose"), [jose.contato], "jose sem acento");
      t.igual(await so("CONCEICAO"), [jose.contato], "maiúsculas e sem acento");
      t.igual(await so("  clinica   vale "), [jose.contato], "empresa, espaços juntos");
      t.igual(await so("Clínica"), [jose.contato], "com acento também acha");
      t.igual(await so("maria avila"), [maria.contato], "nome do WhatsApp sem acento");
      t.igual(await so("maria@empresa"), [maria.contato], "e-mail sem diferenciar maiúsculas");
      t.igual(await so("(11) 90000-0007"), [jose.contato], "telefone com máscara");
      t.igual(await so("+55 11 90000 0007"), [jose.contato], "telefone com +55 e espaços");
      t.igual(await so("11900000007"), [jose.contato], "telefone sem máscara, sem o 55");
      t.igual(await so("90000-0007"), [jose.contato], "só o número");
      t.igual(await so("8888"), [maria.contato], "4 dígitos");
      t.igual(await so("900"), [], "3 dígitos não comparam o telefone");
      t.igual((await so("1234")).length, 1, "4 dígitos que estão no nome");
      t.igual(await so("ninguem"), [], "sem resultado");
      const r = await lista(q, { busca: "empresa.exemplo" });
      t.igual(r.total, 2, "total com busca");
      t.igual((await lista(q, { busca: "" })).total, 3, "busca vazia = todos");
    });
  });

  it("contatos_lista e contadores: recortes precisam, com_nina e comigo (admin e atendente)", async () => {
    const { uAdmin, uAtend, mAdmin, mAtend } = await equipe(t);
    const cx = await conexao(t);
    const p = "2026-10-01 10:00-03";
    const aguardando = await contato(t, {
      nome: "A aguardando",
      primeira: p,
      conversa: { conexao: cx, modo: "humano", aguardando: p, motivo: "nina_passou" },
    });
    const falha = await contato(t, {
      nome: "B falha",
      primeira: p,
      conversa: { conexao: cx, modo: "humano", aguardando: p, motivo: "erro_provedor" },
    });
    const doAdmin = await contato(t, {
      nome: "C do admin",
      primeira: p,
      conversa: { conexao: cx, modo: "humano", responsavel: mAdmin },
    });
    const doAtend = await contato(t, {
      nome: "D do atendente",
      primeira: p,
      conversa: { conexao: cx, modo: "humano", responsavel: mAtend },
    });
    const nina = await contato(t, {
      nome: "E com a Nina",
      primeira: p,
      conversa: { conexao: cx, modo: "nina" },
    });
    const celular = await contato(t, {
      nome: "F celular",
      primeira: p,
      conversa: { conexao: cx, modo: "humano", motivo: "humano_celular" },
    });
    // sem mensagem do lead: só em todos, mesmo com conversa
    const semLeadNina = await contato(t, {
      nome: "G sem lead nina",
      conversa: { conexao: cx, modo: "nina" },
    });
    const semLeadFila = await contato(t, {
      nome: "H sem lead fila",
      conversa: { conexao: cx, modo: "humano", aguardando: p },
    });
    const semConversa = await contato(t, { nome: "I sem conversa" });
    const todos = [
      aguardando,
      falha,
      doAdmin,
      doAtend,
      nina,
      celular,
      semLeadNina,
      semLeadFila,
      semConversa,
    ].map((x) => x.contato);

    const conferir = async (q: Consulta, comigo: string[]) => {
      const esperado: Record<string, string[]> = {
        todos,
        precisam: [aguardando.contato, falha.contato],
        novos_hoje: [],
        com_nina: [nina.contato],
        comigo,
      };
      const [{ k }] = await q("select public.contatos_contadores() as k");
      t.igual(
        Object.keys(k).sort(),
        ["com_nina", "comigo", "novos_hoje", "precisam", "todos"],
        "chaves dos contadores",
      );
      for (const [recorte, ids] of Object.entries(esperado)) {
        const r = await lista(q, { recorte });
        t.igual(idsDe(r), ordenados(ids), `linhas de ${recorte}`);
        t.igual(r.total, ids.length, `total de ${recorte}`);
        t.igual(k[recorte], ids.length, `contador de ${recorte} = total da aba`);
      }
    };
    await t.como("authenticated", uAdmin, (q) => conferir(q, [doAdmin.contato]));
    await t.como("authenticated", uAtend, (q) => conferir(q, [doAtend.contato]));
    // recorte combinado com etapa e busca
    const [{ id: qualificado }] = await t.sql(
      `select id from public.etapas where chave = 'qualificado'`,
    );
    await t.sql("update public.contatos set etapa_id = $1 where id = $2", [
      qualificado,
      falha.contato,
    ]);
    await t.como("authenticated", uAdmin, async (q) => {
      t.igual(
        idsDe(await lista(q, { recorte: "precisam", etapas: [qualificado] })),
        [falha.contato],
        "precisam + etapa",
      );
      t.igual(
        idsDe(await lista(q, { recorte: "precisam", busca: "aguardando" })),
        [aguardando.contato],
        "precisam + busca",
      );
      t.igual((await lista(q, { etapas: [] })).total, 9, "etapas vazio = todas");
      // ordem por etapa: o de Qualificado (ordem 30) vem por último no asc
      const r = await lista(q, { ordem: "etapa", direcao: "asc" });
      t.igual(r.linhas[r.linhas.length - 1].contato_id, falha.contato, "ordem por etapa");
      t.igual(r.linhas[r.linhas.length - 1].etapa_ordem, 30, "etapa_ordem na linha");
      await t.erro(lista(q, { recorte: "outro" }), "parametro_invalido");
      await t.erro(lista(q, { ordem: "telefone" }), "parametro_invalido");
      await t.erro(lista(q, { direcao: "para cima" }), "parametro_invalido");
    });
  });

  it("custo_das_conversas: só admin; soma a rodada e a transcrição (ia_chamadas.conversa_id)", async () => {
    const { uAdmin, uAtend, uFora } = await equipe(t);
    const cx = await conexao(t);
    const a = await contato(t, { nome: "A", conversa: { conexao: cx } });
    const b = await contato(t, { nome: "B", conversa: { conexao: cx } });
    const semCusto = await contato(t, { nome: "C", conversa: { conexao: cx } });
    const [{ id: rodadaA }] = await t.sql(
      `insert into public.rodadas (conversa_id, status) values ($1, 'concluida') returning id`,
      [a.conversa],
    );
    const [{ id: rodadaB }] = await t.sql(
      `insert into public.rodadas (conversa_id, status) values ($1, 'concluida') returning id`,
      [b.conversa],
    );
    await t.sql(
      `insert into public.ia_chamadas (rodada_id, conversa_id, tipo, provedor, modelo, custo_usd, custo_origem) values
         ($1, null, 'resposta', 'anthropic', 'm', 0.010000, 'tabela'),          -- rodada de A
         ($1, null, 'resposta', 'anthropic', 'm', 0.005000, 'provedor'),        -- rodada de A
         (null, $3, 'transcricao', 'groq', 'w', 0.000300, 'tabela'),            -- transcrição de A, sem rodada
         (null, $3, 'transcricao', 'groq', 'w', null, 'sem_preco'),             -- sem preço: não soma
         ($2, null, 'resposta', 'openai', 'm', 0.100000, 'tabela'),             -- rodada de B
         ($2, $3, 'transcricao', 'groq', 'w', 0.000700, 'tabela'),              -- conversa_id vale sobre a rodada
         (null, null, 'onboarding', 'anthropic', 'm', 1.000000, 'tabela')       -- sem conversa`,
      [rodadaA, rodadaB, a.conversa],
    );
    const chamar = (q: Consulta, ids: string[]) =>
      q(
        `select conversa_id, custo_usd::text as custo from public.custo_das_conversas($1::uuid[]) order by custo_usd`,
        [arr(ids)],
      );
    await t.como("authenticated", uAdmin, async (q) => {
      const r = await chamar(q, [
        a.conversa,
        b.conversa,
        semCusto.conversa,
        a.conversa,
        crypto.randomUUID(),
      ]);
      const porId = Object.fromEntries(r.map((x) => [x.conversa_id, Number(x.custo)]));
      t.igual(r.length, 3, "uma linha por conversa que existe (repetida sai uma vez)");
      t.igual(porId[a.conversa], 0.016, "A: 2 da rodada + 2 transcrições (uma de outra rodada)");
      t.igual(porId[b.conversa], 0.1, "B: só a rodada");
      t.igual(porId[semCusto.conversa], 0, "sem custo = 0");
      t.igual(await chamar(q, []), [], "lista vazia");
      const muitos = Array.from({ length: 201 }, () => crypto.randomUUID());
      await t.erro(chamar(q, muitos), "parametro_invalido");
      t.igual((await chamar(q, muitos.slice(0, 200))).length, 0, "200 ids pode");
    });
    await t.como("authenticated", uAtend, async (q) => {
      await t.erro(chamar(q, [a.conversa]), "sem_acesso");
    });
    await t.como("authenticated", uFora, async (q) => {
      await t.erro(chamar(q, [a.conversa]), "sem_acesso");
    });
  });

  it("reordenar_etapas: troca as posições do grupo; recusa grupo misturado, id inexistente e atendente", async () => {
    const { uAdmin, uAtend, uFora } = await equipe(t);
    const etapas = Object.fromEntries(
      (await t.sql("select chave, id from public.etapas")).map((e) => [e.chave, e.id]),
    );
    const ordens = async () =>
      Object.fromEntries(
        (await t.sql("select chave, ordem from public.etapas")).map((e) => [e.chave, e.ordem]),
      );
    const reordenar = (q: Consulta, ids: string[]) =>
      q("select public.reordenar_etapas($1::uuid[])", [arr(ids)]);
    const antes = await ordens();
    await t.como("authenticated", uAtend, async (q) => {
      await t.erro(reordenar(q, [etapas.em_qualificacao, etapas.novo]), "sem_acesso");
    });
    await t.como("authenticated", uFora, async (q) => {
      await t.erro(reordenar(q, [etapas.em_qualificacao, etapas.novo]), "sem_acesso");
    });
    await t.como("authenticated", uAdmin, async (q) => {
      await t.erro(reordenar(q, [etapas.novo, etapas.ganho]), "sem_permissao");
      await t.erro(
        reordenar(q, [etapas.perdido, etapas.qualificado, etapas.ganho]),
        "sem_permissao",
      );
      await t.erro(reordenar(q, [etapas.novo, crypto.randomUUID()]), "nao_encontrado");
      await t.erro(reordenar(q, [etapas.novo, etapas.novo]), "nao_encontrado");
      await t.erro(q(`select public.reordenar_etapas(array[null]::uuid[])`), "nao_encontrado");
    });
    t.igual(await ordens(), antes, "as recusas não mudaram nada");
    await t.como("authenticated", uAdmin, async (q) => {
      // as 4 abertas na nova ordem: as posições 10, 20, 30, 40 são reaproveitadas
      await reordenar(q, [
        etapas.qualificado,
        etapas.novo,
        etapas.em_negociacao,
        etapas.em_qualificacao,
      ]);
      // só duas trocam entre si (a menor posição das duas vai para a 1ª da lista)
      await reordenar(q, [etapas.perdido, etapas.ganho]);
      await q("select public.reordenar_etapas(array[]::uuid[])");
    });
    t.igual(
      await ordens(),
      { qualificado: 10, novo: 20, em_negociacao: 30, em_qualificacao: 40, perdido: 50, ganho: 60 },
      "nova ordem",
    );
    // o contato novo continua entrando na aberta de menor ordem (agora Qualificado)
    const [{ etapa_id }] = await t.sql(
      `insert into public.contatos (nome) values ('Novo') returning etapa_id`,
    );
    t.igual(etapa_id, etapas.qualificado, "entrada pela nova ordem");
  });

  it("marcar_visto: grava em membros.vistos por pessoa, sem apagar a outra chave", async () => {
    const { uAdmin, uAtend, uFora, mAdmin, mAtend } = await equipe(t);
    let kanban: Date | undefined;
    await t.como("authenticated", uAtend, async (q) => {
      [{ kanban }] = await q(`select public.marcar_visto('kanban') as kanban`);
      t.ok(kanban instanceof Date, "devolve o instante");
      await q(`select public.marcar_visto('tour')`);
      await t.erro(q(`select public.marcar_visto('chat')`), "parametro_invalido");
      await t.erro(q(`select public.marcar_visto(null)`), "parametro_invalido");
    });
    const [{ vistos }] = await t.sql("select vistos from public.membros where id = $1", [mAtend]);
    t.igual(Object.keys(vistos).sort(), ["kanban", "tour"], "as duas chaves");
    t.igual(Date.parse(vistos.kanban), kanban!.getTime(), "o mesmo instante devolvido");
    const [{ v: doAdmin }] = await t.sql("select vistos as v from public.membros where id = $1", [
      mAdmin,
    ]);
    t.igual(doAdmin, {}, "o admin não foi tocado");
    await t.como("authenticated", uAdmin, async (q) => {
      await q(`select public.marcar_visto('kanban')`);
    });
    const [{ v: depois }] = await t.sql("select vistos as v from public.membros where id = $1", [
      mAdmin,
    ]);
    t.igual(Object.keys(depois), ["kanban"], "admin marcou o dele");
    await t.como("authenticated", uFora, async (q) => {
      await t.erro(q(`select public.marcar_visto('kanban')`), "sem_acesso");
    });
  });

  it("buscar_quadro: nome, empresa, nome do WhatsApp, texto e transcrição; até 50", async () => {
    const { uAtend, uFora } = await equipe(t);
    const cx = await conexao(t);
    const pNome = await contato(t, { nome: "Lúcia Prado", conversa: { conexao: cx } });
    const pEmpresa = await contato(t, {
      nome: "X",
      empresa: "Padaria São João",
      conversa: { conexao: cx },
    });
    const pWhats = await contato(t, { nome_whatsapp: "Zé Ônibus" });
    const pTexto = await contato(t, { nome: "Y", conversa: { conexao: cx } });
    const pAudio = await contato(t, { nome: "Z", conversa: { conexao: cx } });
    const pApagada = await contato(t, { nome: "W", conversa: { conexao: cx } });
    const msg = (
      conv: string,
      campos: { tipo?: string; texto?: string; transcricao?: string; apagada?: string },
    ) =>
      t.sql(
        `insert into public.mensagens (conversa_id, conexao_id, direcao, origem, status, tipo, texto, transcricao, apagada_em)
         values ($1, $2, 'entrada', 'lead', 'recebida', $3::public.mensagem_tipo, $4, $5, $6::timestamptz)`,
        [
          conv,
          cx,
          campos.tipo ?? "texto",
          campos.texto ?? null,
          campos.transcricao ?? null,
          campos.apagada ?? null,
        ],
      );
    await msg(pTexto.conversa, { texto: "Quero saber o preço da AVALIAÇÃO" });
    await msg(pAudio.conversa, { tipo: "audio", transcricao: "posso pagar no pix parcelado?" });
    await msg(pApagada.conversa, { texto: "segredo apagado", apagada: "2026-10-01 10:00-03" });
    await t.como("authenticated", uAtend, async (q) => {
      const busca = async (s: string | null) =>
        (await q("select b from public.buscar_quadro($1) as b", [s])).map((r) => r.b).sort();
      t.igual(await busca("lucia"), [pNome.contato], "nome sem acento");
      t.igual(await busca("sao joao"), [pEmpresa.contato], "empresa");
      t.igual(await busca("ze onibus"), [pWhats.contato], "nome do WhatsApp");
      t.igual(await busca("avaliacao"), [pTexto.contato], "texto da mensagem");
      t.igual(await busca("PIX"), [pAudio.contato], "transcrição do áudio");
      t.igual(await busca("segredo"), [], "mensagem apagada não conta");
      t.igual(await busca("   "), [], "busca vazia");
      t.igual(await busca(null), [], "busca nula");
    });
    await t.sql(
      `insert into public.contatos (nome) select 'Repetido ' || i from generate_series(1, 60) as i`,
    );
    await t.como("authenticated", uAtend, async (q) => {
      const r = await q(`select b from public.buscar_quadro('repetido') as b`);
      t.igual(r.length, 50, "no máximo 50");
    });
    await t.como("authenticated", uFora, async (q) => {
      await t.erro(q(`select public.buscar_quadro('lucia')`), "sem_acesso");
    });
  });

  it("permissões: anon recusado em todas; conta sem membro recebe sem_acesso", async () => {
    const { uFora } = await equipe(t);
    const chamadas = [
      `select public.texto_busca('a')`,
      `select public.contatos_lista(null, null, null, null, null, null, null, null, null)`,
      `select public.contatos_contadores()`,
      `select * from public.buscar_quadro('a')`,
      `select * from public.custo_das_conversas(array[]::uuid[])`,
      `select public.marcar_visto('kanban')`,
      `select public.reordenar_etapas(array[]::uuid[])`,
    ];
    await t.como("anon", null, async (q) => {
      for (const c of chamadas) await t.erro(q(c), "permission denied");
    });
    await t.como("authenticated", uFora, async (q) => {
      for (const c of chamadas.slice(1)) await t.erro(q(c), "sem_acesso");
      t.igual(
        (await q(`select public.texto_busca('Á') as v`))[0].v,
        "a",
        "texto_busca não lê dado: só exige estar logado",
      );
    });
    // o service_role executa (sem pessoa na sessão, as de membro dão sem_acesso)
    await t.como("service_role", null, async (q) => {
      await t.erro(q(chamadas[2]!), "sem_acesso");
    });
    // grants conferidos no catálogo
    const linhas = await t.sql(
      `select p.proname,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as srv,
              p.prosecdef as definer,
              array_to_string(p.proconfig, ',') as cfg
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('texto_busca', 'contatos_lista', 'contatos_contadores', 'buscar_quadro',
                            'custo_das_conversas', 'marcar_visto', 'reordenar_etapas')
        order by p.proname`,
    );
    t.igual(linhas.length, 7, "as 7 funções existem (uma assinatura cada)");
    for (const l of linhas) {
      t.igual(
        [l.anon, l.auth, l.srv, l.definer, l.cfg],
        [false, true, true, true, 'search_path=""'],
        l.proname,
      );
    }
  });
});
