// Marcação de ferramenta escrita como texto. Às vezes o modelo, em vez de chamar a ferramenta
// "responder", escreve a chamada no texto final (`<invoke name="responder"><parameter
// name="bolhas">[...]</parameter></invoke>` ou parecido). Sem este cuidado, o texto final viraria
// bolha e o lead receberia o código cru no WhatsApp (visto em teste em 12/11/2026). Puro: nada aqui
// toca no banco nem na rede.

/** Pedaços que só aparecem quando o modelo escreveu uma chamada de ferramenta como texto. */
const MARCACAO =
  /<\/?(?:[a-z]+:)?(?:invoke|parameter|function_calls|function_results|tool_call|tool_use)\b/i;

/** O conteúdo de um `<parameter name="bolhas">…</parameter>` (com ou sem prefixo no nome da tag). */
const PARAMETRO_BOLHAS =
  /<(?:[a-z]+:)?parameter\s+name\s*=\s*["']bolhas["']\s*>([\s\S]*?)<\/(?:[a-z]+:)?parameter>/i;

export function temMarcacaoDeFerramenta(texto: string): boolean {
  return MARCACAO.test(texto);
}

/**
 * As bolhas que o modelo quis mandar pela ferramenta "responder", tiradas da marcação escrita como
 * texto. null quando não dá para tirar com segurança (sem o parâmetro "bolhas", JSON inválido,
 * lista vazia ou uma bolha que ainda traz marcação).
 */
export function bolhasDaMarcacao(texto: string): string[] | null {
  const achado = PARAMETRO_BOLHAS.exec(texto);
  if (!achado?.[1]) return null;
  let lista: unknown;
  try {
    lista = JSON.parse(achado[1].trim());
  } catch {
    return null;
  }
  if (!Array.isArray(lista)) return null;
  const bolhas = lista
    .filter((b): b is string => typeof b === "string")
    .map((b) => b.trim())
    .filter((b) => b !== "");
  if (bolhas.length === 0 || bolhas.some(temMarcacaoDeFerramenta)) return null;
  return bolhas;
}
