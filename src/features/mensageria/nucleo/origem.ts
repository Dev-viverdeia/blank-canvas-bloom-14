// A origem da prévia, sem nenhuma dependência: o motor (motor.server.ts) a usa no webhook, na 1ª
// requisição de cada instância e na rota do worker, e o configuracao.server a reexporta. Importar o
// configuracao.server inteiro só por ela carregaria as chaves, os gateways e a fala numa partida a
// frio.

/**
 * Origem é da prévia do Lovable (id-preview--<id>.lovable.app, preview--<nome>.lovable.app ou
 * <id>.lovableproject.com do editor) ou da máquina local: o gateway não alcança ou não é a
 * URL definitiva. Os domínios ainda precisam ser confirmados no app publicado.
 */
export function ehOrigemDePrevia(origem: string): boolean {
  return /id-preview--|(^|\/\/)preview--|lovableproject\.com|localhost|127\.0\.0\.1/i.test(origem);
}
