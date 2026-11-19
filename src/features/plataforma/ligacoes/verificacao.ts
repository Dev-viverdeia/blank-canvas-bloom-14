// A verificação antes de ativar as ligações (seção 21), do lado da tela: o
// que cada item quer dizer, o que fazer quando falta e em que fase o cartão está. Lógica pura: o
// cartão (Ativacao.tsx) e a lista (Elegibilidade.tsx) só desenham o que sai daqui.
//
// O cliente comum conecta um número novo, que nasce com limite de 250 na Meta, e a Meta só liga as
// chamadas com 2.000 ou mais. Por isso o cartão nunca trata isso como erro: é uma fase do cartão
// ("bloqueada pela Meta"), com o porquê e o caminho para liberar.

import {
  DONO_ITEM_ELEGIBILIDADE,
  ITENS_ELEGIBILIDADE,
  requisitosCumpridos,
  type DonoItemElegibilidade,
  type EstadoItemElegibilidade,
  type EstadoLigacoes,
  type IdItemElegibilidade,
  type ItemElegibilidade,
  type RequisitosLigacoes,
} from "@/features/mensageria/ligacoes/tipos";

import { dataCurta } from "../comum/tempo";

/** Os itens que a tela confere sozinha, sem perguntar à Meta (os requisitos de sempre). */
const REQUISITO_DO_ITEM: Partial<Record<IdItemElegibilidade, keyof RequisitosLigacoes>> = {
  conexao_meta: "conexaoMeta",
  chave_voz: "chaveVoz",
  voz: "vozEscolhida",
  endereco: "enderecoPublicado",
};

export interface TextoItem {
  /** O nome do item, em toda situação. */
  rotulo: string;
  /** A regra, dita antes de conferir (o porquê do item). */
  regra: string;
  /** O que fazer quando falta. */
  falta: string;
}

export const TEXTOS_ITEM: Readonly<Record<IdItemElegibilidade, TextoItem>> = {
  conexao_meta: {
    rotulo: "WhatsApp oficial da Meta conectado",
    regra: "As ligações só funcionam na conexão oficial da Meta.",
    falta:
      "Conecte o número pela Meta no cartão WhatsApp da Configuração. As conexões por Z-API, Evolution ou Zernio não recebem ligações.",
  },
  chave_voz: {
    rotulo: "Chave da ElevenLabs",
    regra: "É a ElevenLabs que dá a voz da Nina na ligação.",
    falta: "Cadastre a chave da ElevenLabs no cartão Voz da Configuração.",
  },
  voz: {
    rotulo: "Voz escolhida",
    regra: "A voz que atende as ligações.",
    falta: "Escolha a voz da Nina no cartão Voz da Configuração.",
  },
  endereco: {
    rotulo: "Aberta pelo endereço publicado",
    regra: "A ElevenLabs precisa de um endereço fixo para falar com a Nina.",
    falta: "Abra a Nina pelo endereço publicado, não pela prévia, e verifique de novo.",
  },
  meta_token: {
    rotulo: "Acesso da Nina à Meta",
    regra: "O token da conexão com a Meta precisa estar valendo.",
    falta:
      "A Meta não aceitou o token da conexão. Conecte o WhatsApp pela Meta de novo, com um token novo, e verifique de novo.",
  },
  meta_limite: {
    rotulo: "Limite de 2.000 conversas por dia",
    regra:
      "A Meta só libera ligações para empresas que podem iniciar conversa com 2.000 pessoas por dia.",
    // o caso comum tem o bloco próprio (BLOCO_LIMITE); esta frase vale quando o tier não veio
    falta:
      "A Meta só libera ligações para empresas com limite de 2.000 conversas por dia, e a sua ainda não chegou lá.",
  },
  meta_numero: {
    rotulo: "Número liberado na Meta",
    regra: "O número não pode estar bloqueado na Meta.",
    falta:
      "A Meta bloqueou este número. Veja o motivo na saúde da conta, no WhatsApp Manager: forma de pagamento, verificação da empresa, nome de exibição ou política. Resolva e verifique de novo.",
  },
  meta_sip_livre: {
    rotulo: "Número livre para ligações",
    regra: "O número não pode estar recebendo ligações por outro sistema.",
    falta:
      "Este número já manda as ligações para outro sistema. Desligue as ligações dele no WhatsApp Manager (o número → Ligações) e verifique de novo.",
  },
  chave_agentes: {
    rotulo: "Chave da ElevenLabs pode criar o agente de voz",
    regra: "A chave precisa de escrita em ElevenLabs Agents e Webhooks.",
    falta:
      "A chave da ElevenLabs não pode criar o agente de voz. Crie uma chave com escrita em ElevenLabs Agents e Webhooks e troque no cartão Voz.",
  },
};

/** O número pausado pela Meta por qualidade (138014): a pausa acaba sozinha. */
export const TEXTO_NUMERO_PAUSADO =
  "A Meta pausou as ligações deste número por causa da qualidade das conversas. Essa regra é da Meta: veja o motivo no WhatsApp Manager e verifique de novo quando a pausa terminar.";

/**
 * O que fazer com o item que falta. O `erro` do item manda quando vem (o mesmo código da falha do
 * ativar); sem ele, vale o texto do id.
 */
export function textoFalta(item: Pick<ItemElegibilidade, "id" | "erro">): string {
  if (item.id === "meta_numero" && item.erro === "meta_pausada") return TEXTO_NUMERO_PAUSADO;
  return TEXTOS_ITEM[item.id].falta;
}

/** O item que não deu para conferir agora (rede, tempo, provedor fora). */
export const TEXTO_FALHOU = "Não deu para conferir agora. Verifique de novo em alguns minutos.";

/** O endereço da Central de Segurança do Meta Business, onde começa a verificação da empresa. */
export const LINK_VERIFICACAO_META = "https://business.facebook.com/settings/security-center";

/**
 * O bloco do limite que falta: o caso comum do cliente que conectou um número novo. A regra é da
 * Meta; atender não sobe o limite; o caminho é a verificação da empresa (messaging-limits, conferido
 * em 17/11/2026).
 */
export const BLOCO_LIMITE = {
  explica:
    "A Meta só libera ligações pelo WhatsApp para empresas com limite de 2.000 conversas por dia. Todo número novo começa em 250, e responder os clientes não aumenta esse limite. O caminho é verificar a sua empresa na Meta.",
  passos: [
    "No Meta Business Suite, abra Configurações → Central de segurança e clique em Iniciar verificação.",
    "Envie os dados da empresa: CNPJ, endereço, telefone e um site ou e-mail com o domínio da empresa.",
    "Espere a aprovação. Depois dela, a Meta ainda analisa as mensagens antes de subir o limite para 2.000.",
    "Volte aqui e clique em Verificar de novo.",
  ],
  link: "Abrir a Central de segurança da Meta",
  dica: "O limite vale para a empresa inteira na Meta, não para cada número. Se a sua empresa já é verificada na Meta (por exemplo, a que você usa para anúncios), cadastre o número nela.",
  enquanto: "Enquanto isso, a Nina continua atendendo por texto e por áudio normalmente.",
} as const;

/** Os tiers que a Meta recusa para ligações (o limite de hoje que o título pode citar). */
const TIERS_BAIXOS = ["TIER_50", "TIER_250", "TIER_1K"];

/**
 * O título do bloco do limite: com um tier baixo lido, diz o limite de hoje. Com outro tier (a
 * Meta recusou com 138015 mesmo lendo 2K, por exemplo), não cita número: o tier lido não explica.
 */
export function tituloLimite(valor: string | undefined): string {
  const baixo = !!valor && TIERS_BAIXOS.includes(valor.trim().toUpperCase());
  const n = baixo ? limiteLegivel(valor) : null;
  return n
    ? `O seu limite na Meta hoje é de ${n} conversas por dia`
    : "O seu número ainda não tem o limite que a Meta exige";
}

/**
 * O tier da Meta em português: "TIER_250" → "250", "TIER_2K" → "2.000", "TIER_UNLIMITED" → null
 * (sem número: quem chama diz "sem limite"). Fora do formato, null.
 */
export function limiteLegivel(tier: string): string | null {
  const m = /^TIER_(\d+)(K?)$/.exec(tier.trim().toUpperCase());
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? 1000 : 1);
  return n.toLocaleString("pt-BR");
}

/** A linha de um item cumprido que tem valor a mostrar (o limite de hoje). */
export function detalheOk(item: Pick<ItemElegibilidade, "id" | "valor">): string | null {
  if (item.id !== "meta_limite" || !item.valor) return null;
  if (item.valor.trim().toUpperCase() === "TIER_UNLIMITED") return "Sem limite de conversas.";
  const n = limiteLegivel(item.valor);
  return n ? `O seu limite: ${n} conversas por dia.` : null;
}

export const NOME_GRUPO: Readonly<Record<DonoItemElegibilidade, string>> = {
  nina: "Na Nina",
  meta: "Regras da Meta",
  elevenlabs: "Na ElevenLabs",
};
export const ORDEM_GRUPOS: readonly DonoItemElegibilidade[] = ["nina", "meta", "elevenlabs"];

/**
 * Os 9 itens, na ordem da tela, com o estado de agora:
 * - os da Nina saem dos requisitos do estado (lidos a cada abertura: valem mesmo sem verificação);
 * - os da Meta saem da última verificação enquanto a conexão da Meta está ativa, e o da
 *   ElevenLabs, enquanto há chave da voz: a verificação velha não vale para o que saiu. Sem ela,
 *   ficam "nao_conferido".
 */
export function itensDoCartao(
  estado: Pick<EstadoLigacoes, "requisitos" | "elegibilidade">,
): ItemElegibilidade[] {
  const gravados = new Map((estado.elegibilidade?.itens ?? []).map((i) => [i.id, i]));
  return ITENS_ELEGIBILIDADE.map((id) => {
    const dono = DONO_ITEM_ELEGIBILIDADE[id];
    const req = REQUISITO_DO_ITEM[id];
    if (req) return { id, dono, estado: estado.requisitos[req] ? "ok" : "falta" };
    const vale = dono === "meta" ? estado.requisitos.conexaoMeta : estado.requisitos.chaveVoz;
    const g = gravados.get(id);
    if (!vale || !g) return { id, dono, estado: "nao_conferido" as EstadoItemElegibilidade };
    return {
      id,
      dono,
      estado: g.estado,
      ...(g.valor ? { valor: g.valor } : {}),
      ...(g.erro ? { erro: g.erro } : {}),
    };
  });
}

/**
 * A fase do cartão antes de ativar:
 * - bloqueada_meta: uma regra da Meta faltou na última verificação. Vem antes do "configurar":
 *   liberar na Meta leva dias, e o cliente precisa saber disso primeiro;
 * - configurar: falta um requisito da Nina. Com a conexão da Meta, já dá para verificar o número;
 * - verificar: tudo certo na Nina e nenhuma verificação (ou uma que não chegou a conferir);
 * - ajustar: só a chave da ElevenLabs faltou;
 * - sem_conferir: nada faltou, mas algo não deu para conferir (rede, tempo);
 * - liberada: a última verificação passou (e a ativação não seguiu, ou foi desativada depois).
 */
export type FaseCartao =
  "configurar" | "verificar" | "bloqueada_meta" | "ajustar" | "sem_conferir" | "liberada";

export function faseDoCartao(
  estado: Pick<EstadoLigacoes, "requisitos" | "elegibilidade">,
): FaseCartao {
  const itens = itensDoCartao(estado);
  if (itens.some((i) => i.dono === "meta" && i.estado === "falta")) return "bloqueada_meta";
  if (!requisitosCumpridos(estado.requisitos)) return "configurar";
  if (!estado.elegibilidade) return "verificar";
  if (estado.elegibilidade.elegivel) return "liberada";
  // o "ajustar" diz que o número pode: só com as regras da Meta todas cumpridas
  if (itens.some((i) => i.estado === "falhou")) return "sem_conferir";
  if (itens.some((i) => i.estado === "falta")) return "ajustar";
  return "verificar";
}

export interface TextoFase {
  /** O título da gaveta (e do cartão, sem `tituloCartao`). */
  titulo: string;
  /** O título do cartão, quando difere do da gaveta. */
  tituloCartao?: string;
  /** A linha do cartão, quando não depende do que veio. */
  resumo: string;
  /** A pílula do cabeçalho. */
  linha: string;
  tom?: "ok" | "atencao";
  /** A frase debaixo do título. */
  apoio: string;
  botao: string;
}

export const TEXTO_FASE: Readonly<Record<FaseCartao, TextoFase>> = {
  configurar: {
    titulo: "Falta configurar a Nina",
    resumo: "",
    linha: "Falta configurar",
    apoio:
      "Resolva o que falta na Nina. Você já pode verificar se a Meta libera ligações no seu número: a verificação não muda nada.",
    botao: "Verificar meu número",
  },
  verificar: {
    titulo: "Veja se o seu número pode usar ligações",
    tituloCartao: "A Nina pode atender ligações pelo WhatsApp",
    resumo:
      "Ao ativar, a Nina confere se o seu número cumpre as regras da Meta. Leva alguns segundos.",
    linha: "Desligadas",
    apoio:
      "A verificação confere a Nina, a ElevenLabs e as regras da Meta para o seu número, sem mudar nada. Se estiver tudo certo, a Nina já ativa as ligações.",
    botao: "Ativar ligações",
  },
  bloqueada_meta: {
    titulo: "A Meta ainda não liberou ligações neste número",
    resumo: "",
    linha: "Bloqueado pela Meta",
    tom: "atencao",
    apoio: "Essa regra é da Meta, não da Nina. Veja abaixo o que falta e como liberar.",
    botao: "Verificar de novo",
  },
  ajustar: {
    titulo: "Falta um ajuste na ElevenLabs",
    resumo: "",
    linha: "Falta um ajuste",
    tom: "atencao",
    apoio: "O seu número pode usar ligações. Falta só a chave da ElevenLabs.",
    botao: "Verificar de novo",
  },
  sem_conferir: {
    titulo: "Não deu para conferir agora",
    resumo: "A Meta ou a ElevenLabs não responderam a tempo. Nada foi mudado.",
    linha: "Sem conferir",
    tom: "atencao",
    apoio:
      "A Meta ou a ElevenLabs não responderam a tempo. Nada foi mudado. Verifique de novo em alguns minutos.",
    botao: "Verificar de novo",
  },
  liberada: {
    titulo: "O seu número pode usar ligações",
    tituloCartao: "A Nina pode atender ligações pelo WhatsApp",
    resumo: "",
    linha: "Liberado",
    tom: "ok",
    apoio: "A última verificação passou. Ative para a Nina começar a atender as ligações.",
    botao: "Ativar ligações",
  },
};

/** O cartão sem a conexão oficial da Meta: não há número para verificar. */
export const TITULO_SEM_META = "As ligações precisam do WhatsApp oficial da Meta";
export const RESUMO_SEM_META =
  "Conecte o número pela Meta na Configuração. As conexões por Z-API, Evolution ou Zernio não recebem ligações.";

/** O título do cartão: sem a conexão da Meta, ele diz isso, não "falta configurar". */
export function tituloDaFase(fase: FaseCartao, estado: Pick<EstadoLigacoes, "requisitos">): string {
  if (!podeVerificar(estado)) return TITULO_SEM_META;
  return TEXTO_FASE[fase].tituloCartao ?? TEXTO_FASE[fase].titulo;
}

/** O rótulo do botão principal do cartão e da gaveta. */
export function botaoDaFase(
  fase: FaseCartao,
  estado: Pick<EstadoLigacoes, "elegibilidade">,
): string {
  if (fase === "configurar")
    return estado.elegibilidade ? "Verificar de novo" : "Verificar meu número";
  return TEXTO_FASE[fase].botao;
}

/** O começo do que falta, para o resumo de uma linha do cartão ("A Meta bloqueou este número."). */
function primeiraFrase(texto: string): string {
  const i = texto.indexOf(". ");
  return i < 0 ? texto : texto.slice(0, i + 1);
}

/**
 * A linha do cartão: o essencial da fase, sem a lista (ela fica na gaveta, que abre ao ativar ou em
 * "Ver como liberar").
 */
export function resumoDaFase(
  fase: FaseCartao,
  estado: Pick<EstadoLigacoes, "requisitos" | "elegibilidade">,
  itens: readonly ItemElegibilidade[],
): string {
  if (!podeVerificar(estado)) return RESUMO_SEM_META;
  const falta = itens.filter((i) => i.estado === "falta");
  if (fase === "bloqueada_meta") {
    const meta = falta.find((i) => i.dono === "meta")!;
    if (meta.id === "meta_limite") {
      const n = meta.valor ? limiteLegivel(meta.valor) : null;
      const baixo = !!meta.valor && TIERS_BAIXOS.includes(meta.valor.trim().toUpperCase());
      return baixo && n
        ? `A Meta exige limite de 2.000 conversas por dia, e o seu está em ${n}. Isso se resolve verificando a empresa na Meta.`
        : "A Meta exige limite de 2.000 conversas por dia, e o seu ainda não chegou lá. Isso se resolve verificando a empresa na Meta.";
    }
    return primeiraFrase(textoFalta(meta));
  }
  if (fase === "configurar") {
    const nomes = falta
      .filter((i) => i.dono === "nina")
      .map((i) => TEXTOS_ITEM[i.id].rotulo.toLowerCase());
    const metaOk = itens.filter((i) => i.dono === "meta").every((i) => i.estado === "ok");
    return `Falta na Nina: ${nomes.join(", ")}.${metaOk ? " A Meta já libera ligações no seu número." : ""}`;
  }
  if (fase === "ajustar") return primeiraFrase(textoFalta(falta[0]!));
  if (fase === "liberada" && estado.elegibilidade)
    return `O seu número pode usar ligações (conferido em ${dataCurta(estado.elegibilidade.conferidaEm, true)}).`;
  return TEXTO_FASE[fase].resumo;
}

/** A frase do "configurar" quando a Meta já liberou o número (a verificação passou na Meta). */
export const APOIO_CONFIGURAR_META_OK =
  "A Meta libera ligações no seu número. Falta só configurar a Nina.";

/** A dica debaixo do botão desligado: sem a conexão da Meta, não há número para verificar. */
export const DICA_SEM_META = "Conecte o WhatsApp oficial da Meta para verificar.";

/** Só a conexão da Meta é preciso para verificar: o resto a lista mostra. */
export function podeVerificar(estado: Pick<EstadoLigacoes, "requisitos">): boolean {
  return estado.requisitos.conexaoMeta;
}

/** A frase debaixo do título: no "configurar", diz se a Meta já liberou. */
export function apoioDaFase(
  fase: FaseCartao,
  itens: readonly Pick<ItemElegibilidade, "dono" | "estado">[],
): string {
  const metaOk = itens.filter((i) => i.dono === "meta").every((i) => i.estado === "ok");
  return fase === "configurar" && metaOk ? APOIO_CONFIGURAR_META_OK : TEXTO_FASE[fase].apoio;
}

/** Os passos que a tela mostra enquanto o servidor verifica e ativa (uma chamada só: andam no relógio). */
export const PASSOS_ATIVACAO: readonly string[] = [
  "Conferindo o seu número na Meta",
  "Conferindo a chave da ElevenLabs",
  "Criando o agente de voz",
  "Ligando as chamadas na Meta",
];
