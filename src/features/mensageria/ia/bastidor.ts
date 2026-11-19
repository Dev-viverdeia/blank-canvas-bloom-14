// O raciocínio da rodada escrito para o lead ("Não há mensagem nova da Ana, então não envio nada
// agora", "Não enviei nada à lead"): na Nina vitrine, 29 mensagens em 21 conversas (13 a
// 15/11/2026). Mora aqui, e não em responder.server.ts, para a ferramenta responder (que recusa o
// bastidor uma vez na rodada de retorno e de lembrete) e a rodada usarem o mesmo teste sem ciclo
// de import. Puro.

/** Só frases que nenhuma resposta ao lead teria. */
const BASTIDOR = new RegExp(
  [
    // "não há (nenhuma) mensagem nova da Ana, então não envio nada": a decisão interna junto
    "\\b(n[ãa]o h[áa]|nenhuma|sem)( nenhuma)? mensage(m|ns) novas?[^.!?]{0,60}?(,|;|ent[ãa]o|portanto)\\s*(ent[ãa]o\\s*)?n[ãa]o ((envio|enviei|vou enviar|vou mandar|mando) nada|respondo|vou responder)(\\s+(agora|por enquanto))?\\s*([.!…]+\\s*(((fico|sigo|vou ficar)( no)? |vou )?aguard(o|ando|ar)(?![\\p{L}\\p{N}_])( (((a|o|da|do|de|pela|pelo)( sua| seu| uma)?|sua|seu) )?(resposta|retorno)( d(el[ae]s?|[ao]s? \\p{L}+( (?!(hoje|amanh[ãa]|ainda|tamb[ée]m|logo|agora)(?![\\p{L}\\p{N}_]))\\p{L}+)?))?)?[.!…]*\\s*)?)?$",
    // o lead na terceira pessoa ou desde a última resposta
    "\\bmensage(m|ns) novas? d[oa] lead\\b",
    "\\b(nenhuma|sem) mensage(m|ns) novas? desde a (sua |minha )?[úu]ltima\\b",
    "\\bn[ãa]o (envio|enviei|vou enviar|vou mandar) nada (ao|à|para o|para a|pro|pra) lead\\b",
    // a Nina falando dela mesma na terceira pessoa ("a última pergunta da Nina ainda está sem
    // resposta"): só junto de "última" ou "sem resposta", nunca "a mensagem da Nina, nossa consultora"
    "(^|\\s)[úu]ltima (pergunta|resposta|mensagem) da Nina (ainda|est[áa]|ficou)(?![\\p{L}\\p{N}_])",
  ].join("|"),
  "iu",
);

export function ehBastidor(texto: string): boolean {
  return BASTIDOR.test(texto);
}
