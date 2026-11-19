// O que o painel do botão "Ligar" diz em cada estado (seção 6). Lógica
// pura: o componente (BotaoLigar.tsx) só desenha o que sai daqui.
//
// A regra é da Meta: a empresa só liga para quem autorizou. A permissão só se pede dentro de 24 h da
// última mensagem do lead (o pedido por template fica para depois), e a Meta limita os pedidos.

import {
  MAX_OBJETIVO_LIGACAO,
  type AgenteIndisponivel,
  type AgenteParaLigar,
  type EstadoPermissaoDeLigar,
} from "@/features/mensageria/ligacoes/tipos";

import { dataCurta, horaCurta } from "../comum/tempo";

/** O texto que o lead recebe no pedido (TEXTO_PEDIDO_PERMISSAO do servidor). */
export const TEXTO_PEDIDO_LEAD =
  "Podemos te ligar por aqui, pelo WhatsApp? Se puder, toque em permitir.";

/** O que o painel oferece: ligar, pedir a permissão ou nada (só a explicação). */
export type AcaoPainel = "ligar" | "pedir" | null;

export interface TextoPainel {
  titulo: string;
  texto: string;
  /** Uma linha menor, abaixo do texto (a permissão que vale, o pedido enviado). */
  detalhe: string | null;
  acao: AcaoPainel;
  /** O rótulo do botão da ação. */
  botao: string | null;
  /** O tom do ícone do título. */
  tom: "ok" | "espera" | "atencao";
}

/** "18/11, às 14:00" (hoje: "hoje, às 14:00"). */
export function quando(iso: string, agora: Date = new Date()): string {
  const hoje = dataCurta(agora.toISOString()) === dataCurta(iso);
  return `${hoje ? "hoje" : dataCurta(iso)}, às ${horaCurta(iso)}`;
}

/** O que a ligação faz, dito antes de ligar. */
const O_QUE_ACONTECE =
  "O agente escolhido liga pelo WhatsApp e conversa com o lead. Depois, a Nina manda por mensagem o que combinou. A conversa continua com quem está nela.";

export function textoDoPainel(
  e: EstadoPermissaoDeLigar,
  nome: string,
  agora: Date = new Date(),
): TextoPainel {
  const deNovo = e.pedirDeNovoEm
    ? `Dá para pedir de novo ${quando(e.pedirDeNovoEm, agora)}.`
    : null;
  if (e.podeLigar) {
    const detalhe =
      e.permissao === "permanente"
        ? "O lead permitiu ligações sem prazo."
        : e.expiraEm
          ? `O lead permitiu ligações até ${quando(e.expiraEm, agora)}.`
          : "O lead permitiu ligações.";
    return {
      titulo: `Ligar para ${nome}`,
      texto: O_QUE_ACONTECE,
      detalhe,
      acao: "ligar",
      botao: "Ligar agora",
      tom: "ok",
    };
  }
  switch (e.motivo) {
    case "pedir":
      return {
        titulo: "O lead precisa autorizar a ligação",
        texto: `A Meta só deixa a empresa ligar para quem autorizou. A Nina manda: “${TEXTO_PEDIDO_LEAD}”`,
        detalhe:
          e.pedido?.resposta === "recusou"
            ? "Da última vez, o lead não permitiu."
            : "Quando o lead permitir, o botão Ligar fica liberado.",
        acao: "pedir",
        botao: "Pedir para ligar",
        tom: "atencao",
      };
    case "aguardando_lead":
      return {
        titulo: "Aguardando o lead autorizar",
        texto: "O pedido foi enviado pelo WhatsApp. Quando o lead permitir, dá para ligar.",
        detalhe: e.pedido ? `Pedido enviado ${quando(e.pedido.pedidoEm, agora)}.` : null,
        acao: null,
        botao: null,
        tom: "espera",
      };
    case "recusou":
      return {
        titulo: "O lead não permitiu ligações",
        texto:
          "A Meta só deixa pedir de novo depois de um tempo. Enquanto isso, a conversa segue por mensagem.",
        detalhe: deNovo,
        acao: null,
        botao: null,
        tom: "atencao",
      };
    case "fora_da_janela":
      return {
        titulo: "Só dá para pedir quando o lead escrever",
        texto:
          "A Meta só deixa pedir permissão até 24 h depois da última mensagem do lead. Quando ele escrever de novo, o pedido fica liberado.",
        detalhe: null,
        acao: null,
        botao: null,
        tom: "atencao",
      };
    case "limite_de_pedidos":
      return {
        titulo: "A Meta limita os pedidos de ligação",
        texto: "A Meta deixa pedir no máximo 1 vez por dia e 2 vezes por semana para o mesmo lead.",
        detalhe: deNovo,
        acao: null,
        botao: null,
        tom: "atencao",
      };
    case "meta_nao_deixa":
      return {
        titulo: "A Meta não deixa ligar para este lead agora",
        texto:
          "Depois de 4 ligações seguidas sem resposta, a Meta tira a permissão. O lead pode permitir de novo.",
        detalhe: deNovo,
        acao: null,
        botao: null,
        tom: "atencao",
      };
    case "ligacao_em_andamento":
      return {
        titulo: "Já há uma ligação em andamento",
        texto: "Quando ela terminar, o resumo aparece na conversa.",
        detalhe: null,
        acao: null,
        botao: null,
        tom: "espera",
      };
    case "sem_telefone":
      return {
        titulo: "Este contato não tem telefone",
        texto: "A Nina só liga para contatos com o número do WhatsApp.",
        detalhe: null,
        acao: null,
        botao: null,
        tom: "atencao",
      };
    case "sem_ligacoes":
      return {
        titulo: "As ligações estão desligadas",
        texto: "Um admin ativa as ligações na área Ligações.",
        detalhe: null,
        acao: null,
        botao: null,
        tom: "atencao",
      };
    default:
      return {
        titulo: "Não dá para ligar agora",
        texto: "Tente de novo em alguns minutos.",
        detalhe: null,
        acao: null,
        botao: null,
        tom: "atencao",
      };
  }
}

/**
 * Depois desta falha, o painel ainda oferece a ação? Não depois de `tempo_esgotado`: a ElevenLabs não
 * confirmou a ligação a tempo, e ela pode ter saído. A ligação aparece na conversa se tiver saído.
 */
export function podeRepetir(f: { erro: string } | null): boolean {
  return f?.erro !== "tempo_esgotado";
}

/** A falha de uma ação do painel: a frase pronta do servidor, ou uma genérica. */
export function textoFalhaSaida(f: { erro: string; mensagem: string | null }): string {
  if (f.mensagem) return f.mensagem;
  if (f.erro === "sem_acesso") return "Você não tem acesso a esta conversa.";
  return "Não deu para falar com o servidor agora. Tente de novo.";
}

// ---------------------------------------------------------------------------
// Como ligar (A2 e A3): com um agente, ou eu mesmo, pelo meu WhatsApp
// ---------------------------------------------------------------------------

/** Por que um agente não liga agora, como a janela escreve abaixo do nome dele. */
export const TEXTO_INDISPONIVEL: Record<AgenteIndisponivel, string> = {
  nao_sincronizado: "Ainda não está pronto na ElevenLabs.",
};

/** O agente cuja última atualização falhou: liga, com a configuração anterior (só um aviso). */
export const TEXTO_DESATUALIZADO =
  "A última atualização falhou: ele liga com a configuração anterior. Atualize em Ligações → Agentes.";

/** O agente marcado sumiu da lista ou deixou de estar pronto: a janela não troca sozinha. */
export const TEXTO_ESCOLHIDO_SAIU = "O agente escolhido não está mais disponível. Escolha outro.";

/**
 * O agente marcado na primeira abertura da janela (sem nada marcado): o primeiro Ativo pronto; sem
 * nenhum, o Receptivo pronto (o que atende antes dos outros). Nulo quando nenhum está pronto.
 */
export function agentePadrao(agentes: readonly AgenteParaLigar[]): string | null {
  // os prontos sem aviso antes dos desatualizados (Opus, PR #26); a ordem da lista fica
  const prontos = agentes
    .filter((a) => a.indisponivel === null)
    .sort((x, y) => Number(x.desatualizado) - Number(y.desatualizado));
  const ativo = prontos.find((a) => a.uso === "ligar");
  if (ativo) return ativo.id;
  const receptivo =
    prontos.find((a) => a.uso === "receber" && a.atende) ??
    prontos.find((a) => a.uso === "receber");
  return receptivo?.id ?? null;
}

/**
 * O agente marcado, como a janela usa. Nunca troca sozinha para outro (revisão do PR #26): se o
 * marcado sumiu da lista ou ficou indisponível numa releitura, `agente` é nulo (o "Ligar agora" fica
 * desabilitado) e `saiu` pede para escolher outro. O padrão (agentePadrao) só entra na primeira
 * abertura, por quem chama.
 */
export function agenteEscolhido(
  agentes: readonly AgenteParaLigar[],
  marcado: string | null,
): { agente: AgenteParaLigar | null; saiu: boolean } {
  if (!marcado) return { agente: null, saiu: false };
  const a = agentes.find((x) => x.id === marcado);
  if (!a || a.indisponivel !== null) return { agente: null, saiu: true };
  return { agente: a, saiu: false };
}

/**
 * O "Eu mesmo, pelo meu WhatsApp": `https://wa.me/<só os dígitos do telefone do lead>`. Nulo sem
 * telefone (o contato só com o BSUID) ou com um que não é internacional (E.164: de 8 a 15 dígitos,
 * sem começar por 0; Sol, PR #26): a opção fica desabilitada.
 */
export function linkWhatsApp(telefone: string | null | undefined): string | null {
  const digitos = (telefone ?? "").replace(/\D/g, "");
  return /^[1-9]\d{7,14}$/.test(digitos) ? `https://wa.me/${digitos}` : null;
}

export { MAX_OBJETIVO_LIGACAO };

/**
 * O tamanho do objetivo como o servidor conta: aparado (os espaços e as quebras de linha das pontas
 * não contam). É o que o contador mostra.
 */
export function tamanhoObjetivo(texto: string): number {
  return texto.trim().length;
}

/** O objetivo passou do limite (aparado, como no servidor): o Ligar fica desabilitado. */
export function objetivoPassou(texto: string): boolean {
  return tamanhoObjetivo(texto) > MAX_OBJETIVO_LIGACAO;
}

/** O objetivo que vai no pedido: aparado; vazio = sem objetivo. */
export function objetivoDoPedido(texto: string): string | undefined {
  const t = texto.trim();
  return t ? t : undefined;
}

/** O aviso depois de ligar: cita o agente. */
export function textoLigando(agente: string, lead: string): string {
  return `${agente} está ligando para ${lead}. A ligação aparece na conversa.`;
}
