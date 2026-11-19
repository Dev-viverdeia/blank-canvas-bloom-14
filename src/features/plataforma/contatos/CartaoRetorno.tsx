import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CalendarClock, Clock } from "lucide-react";

import { Botao } from "@/components/subido";
import { type Classes } from "@/components/subido/cx";

import {
  avisoDoCancelar,
  cartaoDoRetorno,
  lembreteVisivel,
  retornoVisivel,
  type ConteudoCartao,
} from "../comum/retornos";
import { ErroLeitura } from "../dados/estados";
import { useAjusteLembrete, useCancelarRetorno, useRetornos } from "../dados/retornos";
import type { RetornoDados } from "../dados/tipos";
import { conexaoAtiva, janelaFechada } from "../exemplo/regras";
import type { Conversa, EstadoExemplo } from "../exemplo/tipos";
import estilos from "./Perfil.module.css";

// O cartão "Retorno marcado" / "Lembrete automático" da coluna da direita do perfil (// mockup, quadros 17 a 19, 3.4). Só um dos dois aparece por vez (o retorno ganha),
// e sem nenhum dos dois o cartão não existe. Os hooks ficam AQUI dentro, e não no `usePerfilContato`
// bloqueante: a leitura dos retornos nunca derruba o perfil (erro, falta de acesso, tabela ainda sem dado).
// O "Cancelar" é para qualquer membro (a permissão é do banco) e serve aos dois tipos.

const s = estilos as Classes<
  | "pfCartao"
  | "pfPassoCab"
  | "pfPassoTitulo"
  | "pfPassoTexto"
  | "pfCinza"
  | "pfRetIcone"
  | "pfRetBotao"
>;

interface Props {
  /** A conversa do contato; sem ela, nada a mostrar. */
  conversa: Pick<Conversa, "id" | "modo" | "ultima_do_lead_em" | "devolvida_em"> | undefined;
  /** O tipo da etapa do lead (`aberta`, `ganho` ou `perdido`): o lembrete só vale em etapa aberta. */
  etapaTipo: string | undefined;
  conexao: EstadoExemplo["conexao"];
  /** O relógio da tela (30 s), em ms: o "Hoje" e o "Amanhã" saem dele, nunca de `Date.now()`. */
  agora: number;
  /** O aviso curto da tela (o `avisar` do perfil), com o tom de erro. */
  avisar(texto: string, tom?: "ok" | "erro"): void;
  /** Depois que o cartão some (cancelou ou "já saiu"): quem monta leva o foco para a coluna. */
  aoSumir(): void;
}

const SEM_RETORNOS: readonly RetornoDados[] = [];

export function CartaoRetorno({ conversa, etapaTipo, conexao, agora, avisar, aoSumir }: Props) {
  const base = useId();
  const retornosL = useRetornos(conversa?.id);
  const cancelar = useCancelarRetorno();

  // Os que a própria tela já escondeu ao cancelar (no ok e no "já saiu"), mesmo que a releitura falhe.
  const [escondidos, setEscondidos] = useState<ReadonlySet<string>>(() => new Set());
  const [cancelandoId, setCancelandoId] = useState<string | null>(null);
  // A trava síncrona: o Enter repetido não chama a ação duas vezes antes do render do "Cancelando…".
  const trava = useRef<string | null>(null);
  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  const todos = retornosL.dados ?? SEM_RETORNOS;
  const abertos = useMemo(() => todos.filter((r) => !escondidos.has(r.id)), [todos, escondidos]);
  const haLembretePendente = abertos.some((r) => r.tipo === "lembrete" && r.status === "pendente");
  // O ajuste só é lido quando há lembrete pendente (uma consulta a menos em quase todo perfil).
  const ajusteL = useAjusteLembrete(haLembretePendente);

  const retorno = useMemo(() => retornoVisivel(abertos, agora), [abertos, agora]);
  const comNina = conversa?.modo === "nina";
  const podeEnviar =
    !!conversa &&
    conexaoAtiva({ conexao }) &&
    !janelaFechada({ conexao }, conversa, new Date(agora));
  const lembrete = useMemo(
    () =>
      lembreteVisivel(abertos, {
        ajuste: ajusteL.dados,
        comNina,
        etapaAberta: etapaTipo === "aberta",
        podeEnviar,
        ultimaDoLeadEm: conversa?.ultima_do_lead_em ?? null,
        devolvidaEm: conversa?.devolvida_em ?? null,
        agora,
      }),
    [
      abertos,
      ajusteL.dados,
      comNina,
      etapaTipo,
      podeEnviar,
      conversa?.ultima_do_lead_em,
      conversa?.devolvida_em,
      agora,
    ],
  );

  if (!conversa) return null;

  const c = cartaoDoRetorno({ retorno, lembrete, comNina, agora });

  const cancelarCartao = (cartao: ConteudoCartao) => {
    if (trava.current) return;
    trava.current = cartao.id;
    setCancelandoId(cartao.id);
    void cancelar(cartao.id).then((r) => {
      trava.current = null;
      if (!vivo.current) return;
      setCancelandoId(null);
      const aviso = avisoDoCancelar(cartao.tipo, r);
      if (aviso.some) setEscondidos((antes) => new Set(antes).add(cartao.id));
      avisar(aviso.texto, aviso.tom);
      // O cartão some: o foco não pode cair no <body>. No erro, ele fica no botão.
      if (aviso.some) aoSumir();
    });
  };

  // Erro sem dados: o aviso compacto no lugar do cartão (com dados, vale o que já havia).
  if (retornosL.erro && retornosL.dados === undefined) {
    return (
      <ErroLeitura
        erro={retornosL.erro}
        titulo="Não deu para ver se há retorno marcado"
        tentarDeNovo={retornosL.tentarDeNovo}
        compacto
      />
    );
  }
  if (!c && haLembretePendente && ajusteL.erro && ajusteL.dados === undefined) {
    return (
      <ErroLeitura
        erro={ajusteL.erro}
        titulo="Não deu para ver se há lembrete marcado"
        tentarDeNovo={ajusteL.tentarDeNovo}
        compacto
      />
    );
  }
  if (!c) return null;

  const cancelando = cancelandoId === c.id;
  const Icone = c.tipo === "retorno" ? CalendarClock : Clock;
  return (
    // O Botao (componente comum) não deixa o aria-busy passar para o botão: o "ocupado" fica na região.
    <section
      className={s.pfCartao}
      aria-labelledby={`${base}-ret`}
      aria-busy={cancelando || undefined}
    >
      <p className={s.pfPassoCab}>
        <Icone className={s.pfRetIcone} size={16} strokeWidth={2} aria-hidden="true" />
        <span id={`${base}-ret`}>{c.titulo}</span>
        {c.quem ? <span className={s.pfCinza}>{c.quem}</span> : null}
      </p>
      {c.sub ? <p className={s.pfCinza}>{c.sub}</p> : null}
      {/* O horário é um parágrafo, não um título: "Amanhã, 09:00" não serve para navegar por títulos. */}
      <p className={s.pfPassoTitulo}>{c.quando}</p>
      {c.texto ? <p className={s.pfPassoTexto}>{c.texto}</p> : null}
      {c.nota ? <p className={s.pfPassoTexto}>{c.nota}</p> : null}
      <Botao
        variante="contorno"
        tamanho="compacto"
        largo
        className={s.pfRetBotao}
        aria-disabled={cancelando || undefined}
        onClick={() => {
          if (!cancelando) cancelarCartao(c);
        }}
      >
        {cancelando ? "Cancelando…" : c.botao}
      </Botao>
    </section>
  );
}
