// A verificação antes de ativar as ligações (seção 21): monta a lista de
// itens a partir dos requisitos da Nina e do que a Meta e a ElevenLabs responderam, e diz qual
// falha o ativar devolve. Puro: quem chama os provedores é ligacoes.server.ts.
import { msgLigacoes } from "./mensagens";
import {
  DONO_ITEM_ELEGIBILIDADE,
  ITENS_ELEGIBILIDADE,
  LIMITES_META_SEM_LIGACOES,
  type Elegibilidade,
  type ErroLigacoes,
  type EstadoItemElegibilidade,
  type FalhaLigacoes,
  type IdItemElegibilidade,
  type ItemElegibilidade,
  type RequisitosLigacoes,
} from "./tipos";

/** O que a verificação leu. `undefined` = não chegou a conferir. */
export type Conferencias = {
  requisitos: RequisitosLigacoes;
  /** lerNumeroMeta: o tier e a saúde do número, ou a falha (o token) */
  numero?: { ok: true; limite: string | null; saude: string | null } | FalhaLigacoes;
  /** conferirSipMeta: null = livre */
  sip?: FalhaLigacoes | null;
  /** conferirAcessoAgentes: null = a chave cria agentes */
  agentes?: FalhaLigacoes | null;
};

export type Avaliacao = {
  elegibilidade: Elegibilidade;
  /** A falha que o ativar devolve (a do primeiro item que não está "ok"), com a elegibilidade. */
  falha: FalhaLigacoes | null;
};

/** Falhas passageiras: tentar de novo pode resolver ("falhou", não "falta"). */
function passageira(f: FalhaLigacoes): boolean {
  return f.erro === "provedor_fora" || f.erro === "tempo_esgotado";
}

function estadoDa(f: FalhaLigacoes | null): EstadoItemElegibilidade {
  if (f === null) return "ok";
  return passageira(f) ? "falhou" : "falta";
}

/** O tier da Meta permite as chamadas: só os tiers baixos conhecidos reprovam (sem tier, passa). */
export function limiteLigaChamadas(limite: string | null): boolean {
  return limite === null || !LIMITES_META_SEM_LIGACOES.includes(limite);
}

export function avaliarElegibilidade(c: Conferencias, agora: Date = new Date()): Avaliacao {
  const r = c.requisitos;
  const resultado = new Map<
    IdItemElegibilidade,
    { estado: EstadoItemElegibilidade; valor?: string; falha: FalhaLigacoes | null }
  >();
  const por = (id: IdItemElegibilidade, ok: boolean, falha: () => FalhaLigacoes) =>
    resultado.set(id, ok ? { estado: "ok", falha: null } : { estado: "falta", falha: falha() });

  por("conexao_meta", r.conexaoMeta, msgLigacoes.semConexaoMeta);
  por("chave_voz", r.chaveVoz, msgLigacoes.semChaveVoz);
  por("voz", r.vozEscolhida, msgLigacoes.semVoz);
  por("endereco", r.enderecoPublicado, msgLigacoes.enderecoDePrevia);

  let limiteMeta: string | null = null;
  const numero = c.numero;
  if (numero !== undefined) {
    if (!numero.ok) {
      resultado.set("meta_token", { estado: estadoDa(numero), falha: numero });
    } else {
      resultado.set("meta_token", { estado: "ok", falha: null });
      limiteMeta = numero.limite;
      resultado.set(
        "meta_limite",
        limiteLigaChamadas(numero.limite)
          ? { estado: "ok", ...(numero.limite ? { valor: numero.limite } : {}), falha: null }
          : { estado: "falta", valor: numero.limite ?? "", falha: msgLigacoes.metaLimite() },
      );
      resultado.set(
        "meta_numero",
        numero.saude === "BLOCKED"
          ? { estado: "falta", valor: numero.saude, falha: msgLigacoes.metaNumeroBloqueado() }
          : { estado: "ok", ...(numero.saude ? { valor: numero.saude } : {}), falha: null },
      );
      if (c.sip !== undefined)
        resultado.set("meta_sip_livre", { estado: estadoDa(c.sip), falha: c.sip });
    }
  }
  if (c.agentes !== undefined) {
    resultado.set("chave_agentes", { estado: estadoDa(c.agentes), falha: c.agentes });
  }

  const itens: ItemElegibilidade[] = [];
  let falha: FalhaLigacoes | null = null;
  for (const id of ITENS_ELEGIBILIDADE) {
    const x = resultado.get(id);
    const estado = x?.estado ?? "nao_conferido";
    itens.push({
      id,
      dono: DONO_ITEM_ELEGIBILIDADE[id],
      estado,
      ...(x?.valor !== undefined ? { valor: x.valor } : {}),
      ...(x?.falha ? { erro: x.falha.erro } : {}),
    });
    if (falha === null && estado !== "ok") falha = x?.falha ?? msgLigacoes.naoElegivel();
  }
  const elegibilidade: Elegibilidade = {
    versao: 1,
    elegivel: falha === null,
    limiteMeta,
    itens,
    conferidaEm: agora.toISOString(),
  };
  return { elegibilidade, falha: falha ? { ...falha, elegibilidade } : null };
}

/**
 * A recusa da Meta no fim da ativação (138015 e 138014 no ligar): a última verificação passa a
 * dizer o motivo. null = a falha não é dessas, ou não há verificação para corrigir.
 */
export function reprovadaPelaMeta(
  e: Elegibilidade | null,
  falha: FalhaLigacoes,
  agora: Date = new Date(),
): Elegibilidade | null {
  const id: IdItemElegibilidade | null =
    falha.erro === "meta_limite"
      ? "meta_limite"
      : falha.erro === "meta_pausada"
        ? "meta_numero"
        : null;
  if (!e || !id) return null;
  return {
    ...e,
    elegivel: false,
    itens: e.itens.map((i) => (i.id === id ? { ...i, estado: "falta", erro: falha.erro } : i)),
    conferidaEm: agora.toISOString(),
  };
}

/** A elegibilidade gravada (conexoes.parametros.ligacoesElegibilidade), conferida; null = não há. */
export function lerElegibilidade(v: unknown): Elegibilidade | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o["versao"] !== 1 || typeof o["elegivel"] !== "boolean") return null;
  if (typeof o["conferidaEm"] !== "string" || !Array.isArray(o["itens"])) return null;
  const limite = o["limiteMeta"];
  if (limite !== null && typeof limite !== "string") return null;
  const estados: readonly string[] = ["ok", "falta", "falhou", "nao_conferido"];
  const itens: ItemElegibilidade[] = [];
  for (const i of o["itens"]) {
    if (typeof i !== "object" || i === null) return null;
    const x = i as Record<string, unknown>;
    const id = x["id"];
    if (typeof id !== "string" || !(ITENS_ELEGIBILIDADE as readonly string[]).includes(id))
      return null;
    if (typeof x["estado"] !== "string" || !estados.includes(x["estado"])) return null;
    const item: ItemElegibilidade = {
      id: id as IdItemElegibilidade,
      dono: DONO_ITEM_ELEGIBILIDADE[id as IdItemElegibilidade],
      estado: x["estado"] as EstadoItemElegibilidade,
    };
    if (typeof x["valor"] === "string") item.valor = x["valor"];
    if (typeof x["erro"] === "string" && /^[a-z_]{1,40}$/.test(x["erro"])) {
      item.erro = x["erro"] as ErroLigacoes;
    }
    itens.push(item);
  }
  return {
    versao: 1,
    elegivel: o["elegivel"],
    limiteMeta: limite,
    itens,
    conferidaEm: o["conferidaEm"],
  };
}
