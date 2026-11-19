import { textoDoErro } from "../dados/estados";
import type { Resultado } from "../dados/tipos";

// Os textos da área Ligações que mais de uma peça usa.

/** O texto de uma recusa das ações dos agentes. */
export function textoFalhaAgente(r: Extract<Resultado, { ok: false }>): string {
  if (r.erro === "agente_que_atende")
    return "Este agente atende as ligações. Escolha outro para atender antes de apagar.";
  if (r.erro === "sem_permissao" || r.erro === "sem_acesso")
    return "Só um admin pode mudar os agentes.";
  if (r.erro === "nome_vazio") return "Confira os campos do agente e tente de novo.";
  if (r.erro === "uso_do_agente")
    return "Só um agente Receptivo atende as ligações do número, e o primeiro agente é Receptivo.";
  // a frase fixa do servidor (a ElevenLabs recusou, o prompt ficou grande, a mudança ficou salva...)
  if (r.erro === "falha" && r.detalhe) return r.detalhe;
  return textoDoErro(r.erro);
}

export const TEXTO_ATUALIZACAO =
  "Melhoramos a voz e a conversa dos agentes. Atualizar leva a configuração nova para todos, sem mudar o que você escreveu.";

/** O Contexto mudou depois da última atualização de algum agente (L14). */
export const TEXTO_ATUALIZACAO_CONTEXTO =
  "O Contexto mudou depois da última atualização dos agentes de voz. Atualizar leva o Contexto novo para as ligações. Até lá, cada ligação recebe o Contexto atual no começo.";
