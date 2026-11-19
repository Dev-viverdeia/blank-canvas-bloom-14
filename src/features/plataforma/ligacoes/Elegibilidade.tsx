import { IC } from "@/features/onboarding/lista/dados";
import type { ItemElegibilidade } from "@/features/mensageria/ligacoes/tipos";

import { AtalhoArea } from "../comum/AtalhoArea";
import { Ic } from "../configuracao/pecas";
import {
  BLOCO_LIMITE,
  LINK_VERIFICACAO_META,
  NOME_GRUPO,
  ORDEM_GRUPOS,
  TEXTOS_ITEM,
  TEXTO_FALHOU,
  detalheOk,
  textoFalta,
  tituloLimite,
} from "./verificacao";
import { l } from "./estilos";

const ICONE: Record<ItemElegibilidade["estado"], string> = {
  ok: IC.ok,
  falta: IC.triangulo,
  falhou: IC.alerta,
  nao_conferido: IC.pendente,
};

/** O que o leitor de tela ouve depois do rótulo (o ícone diz o estado, nunca só a cor). */
const ESTADO_SR: Record<ItemElegibilidade["estado"], string> = {
  ok: " (pronto)",
  falta: " (falta)",
  falhou: " (não deu para conferir)",
  nao_conferido: " (ainda não conferido)",
};

/**
 * A lista da verificação (seção 21): três grupos, "Na Nina", "Regras da
 * Meta" e "Na ElevenLabs", para o cliente ver de quem é cada regra. Cada item mostra a regra antes
 * de conferir, o valor quando ajuda (o limite de hoje) e, quando falta, o que fazer. O limite da
 * Meta que falta, o caso comum, ganha o bloco com o passo a passo da verificação da empresa.
 */
export function ListaElegibilidade({ itens }: { itens: readonly ItemElegibilidade[] }) {
  return (
    <div className={l.lgEleg}>
      {ORDEM_GRUPOS.map((dono) => {
        const doGrupo = itens.filter((i) => i.dono === dono);
        if (doGrupo.length === 0) return null;
        const idH = `lg-eleg-${dono}`;
        // o grupo todo certo vira uma linha só (abre para ver os itens): o que falta aparece primeiro
        const tudoCerto = doGrupo.every((i) => i.estado === "ok");
        const ninaFalta = dono === "nina" && doGrupo.some((i) => i.estado === "falta");
        const lista = (
          <ul className={l.lgElegItens}>
            {doGrupo.map((item) => (
              <ItemDaLista key={item.id} item={item} />
            ))}
          </ul>
        );
        return (
          <section key={dono} className={l.lgElegGrupo} aria-labelledby={idH} data-dono={dono}>
            <h3 id={idH} className={l.lgElegGrupoH}>
              {NOME_GRUPO[dono]}
            </h3>
            {tudoCerto ? (
              <details className={l.lgElegResumo} data-resumo={dono}>
                <summary>
                  <Ic d={IC.ok} tamanho="p" />
                  <span>
                    Tudo certo{" "}
                    <span className={l.lgElegConta}>
                      · {doGrupo.length === 1 ? "1 item" : `${doGrupo.length} itens`}
                    </span>
                  </span>
                  <Ic d={IC.chevronDireita} tamanho="p" className={l.lgElegSeta} />
                </summary>
                {lista}
              </details>
            ) : (
              lista
            )}
            {ninaFalta && (
              <div>
                <AtalhoArea para="/app/configuracao" variante="discreto" tamanho="compacto">
                  Abrir a Configuração
                </AtalhoArea>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function ItemDaLista({ item }: { item: ItemElegibilidade }) {
  const t = TEXTOS_ITEM[item.id];
  const limiteFalta = item.id === "meta_limite" && item.estado === "falta";
  const detalhe =
    item.estado === "ok"
      ? detalheOk(item)
      : item.estado === "falta"
        ? limiteFalta
          ? null
          : textoFalta(item)
        : item.estado === "falhou"
          ? TEXTO_FALHOU
          : t.regra;
  return (
    <li className={l.lgElegItem} data-estado={item.estado} data-item={item.id}>
      <Ic d={ICONE[item.estado]} tamanho="p" />
      <div className={l.lgElegTexto}>
        <span className={l.lgElegRotulo}>
          {t.rotulo}
          <span className={l.lgSr}>{ESTADO_SR[item.estado]}</span>
        </span>
        {detalhe ? <span className={l.lgElegDetalhe}>{detalhe}</span> : null}
        {limiteFalta ? <BlocoLimite valor={item.valor} /> : null}
      </div>
    </li>
  );
}

/** O limite de 250 (o cliente comum): o porquê, o passo a passo da verificação e a dica do portfólio. */
function BlocoLimite({ valor }: { valor: string | undefined }) {
  return (
    <div className={l.lgElegLimite} data-bloco="limite">
      <b>{tituloLimite(valor)}</b>
      <p>{BLOCO_LIMITE.explica}</p>
      <ol aria-label="Como liberar as ligações">
        {BLOCO_LIMITE.passos.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ol>
      <a href={LINK_VERIFICACAO_META} target="_blank" rel="noopener noreferrer">
        {BLOCO_LIMITE.link}
        <span className={l.lgSr}> (abre em outra aba)</span>
      </a>
      <p>{BLOCO_LIMITE.dica}</p>
      <p className={l.lgElegEnquanto}>{BLOCO_LIMITE.enquanto}</p>
    </div>
  );
}
