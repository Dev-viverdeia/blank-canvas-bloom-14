import { useId, useState, type ReactNode } from "react";
import { ChevronDown, Phone } from "lucide-react";

import type { Classes } from "@/components/subido/cx";
import { andamentoVencido } from "@/features/mensageria/ligacoes/registro";

import { useLigacaoDaMensagem } from "../dados/ligacoes";
import { Equalizador, TempoCorrendo } from "./AoVivo";
import estilos from "./BlocoLigacao.module.css";
import {
  falasDaTranscricao,
  lerLigacao,
  tituloDaLinhaDeLigacao,
  tituloDaMensagemDeLigacao,
  tituloDoRegistro,
} from "./ligacao";

const s = estilos as Classes<
  | "blLigacao"
  | "blCab"
  | "blIcone"
  | "blTitulo"
  | "blResumo"
  | "blTransc"
  | "blTranscBot"
  | "blSeta"
  | "blTranscTexto"
  | "blQuem"
  | "blVivo"
>;

type Fase = "andamento" | "concluida" | "falhou";
type Fala = { quem: "Lead" | "Nina" | ""; fala: string };

interface PropsVista {
  titulo: string;
  fase: Fase;
  resumo: string | null;
  falas: readonly Fala[];
  hora?: ReactNode;
  /** O primeiro nome do lead, no lugar de "Lead" na transcrição. */
  nomeLead?: string | undefined;
  tabIndex?: number | undefined;
  /**
   * A ligação acontecendo agora (em andamento e ainda no prazo, L38): o equalizador, quem atende e o
   * tempo correndo. Quando o tempo real a encerra, o bloco troca para o fim com uma transição curta.
   */
  vivo?: { desde: string; agente: string | null } | null | undefined;
}

/** O bloco em si: o telefone, o título, o resumo e "Ver transcrição", que abre e fecha. */
function VistaLigacao({ titulo, fase, resumo, falas, hora, nomeLead, tabIndex, vivo }: PropsVista) {
  const [aberta, setAberta] = useState(false);
  const idTransc = useId();
  return (
    <div className={s.blLigacao} data-fase={fase} data-ligacao="" data-vivo={vivo ? "" : undefined}>
      <div className={s.blCab}>
        <span className={s.blIcone} aria-hidden="true">
          <Phone size={16} strokeWidth={2} />
        </span>
        <p className={s.blTitulo}>{titulo}</p>
        {vivo ? <Equalizador /> : null}
        {hora}
      </div>
      {vivo ? (
        <p className={s.blVivo}>
          {vivo.agente ? `${vivo.agente} atende · ` : null}
          <TempoCorrendo desde={vivo.desde} />
        </p>
      ) : null}
      {resumo && <p className={s.blResumo}>{resumo}</p>}
      {falas.length > 0 && (
        <div className={s.blTransc}>
          <button
            type="button"
            className={s.blTranscBot}
            aria-expanded={aberta}
            aria-controls={aberta ? idTransc : undefined}
            tabIndex={tabIndex}
            onClick={() => setAberta((a) => !a)}
          >
            <span>Ver transcrição</span>
            <ChevronDown className={s.blSeta} size={16} aria-hidden="true" />
          </button>
          {aberta && (
            <div
              id={idTransc}
              className={s.blTranscTexto}
              role="region"
              aria-label="Transcrição da ligação"
            >
              {falas.map((f, i) => (
                <p key={i}>
                  {f.quem && (
                    <span className={s.blQuem}>
                      {f.quem === "Lead" ? nomeLead || "Lead" : f.quem}:{" "}
                    </span>
                  )}
                  {f.fala}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface Props {
  /** O texto gravado ("[ligação] concluída (192 s)\nresumo"). */
  texto: string | null | undefined;
  transcricao?: string | null | undefined;
  /** O início da ligação (o `momento` da mensagem): "em andamento" velho vira "sem resumo". */
  momento: string;
  /** A hora da mensagem, já montada pela bolha. */
  hora?: ReactNode;
  /** O primeiro nome do lead, no lugar de "Lead" na transcrição. */
  nomeLead?: string | undefined;
  /** No foco móvel da conversa, o botão da transcrição sai da ordem do Tab com a mensagem fora da vez. */
  tabIndex?: number | undefined;
  /** O relógio (testes). */
  agoraMs?: number | undefined;
}

/**
 * O registro de uma ligação da primeira versão (2.7), no Chat, na aba Conversa
 * dos Contatos e na gaveta do Kanban (os três pela Bolha): o telefone, "Ligação · 3 min 12 s" (ou em
 * andamento, sem resumo, não completada), o resumo e "Ver transcrição", que abre e fecha.
 */
export function BlocoLigacao({
  texto,
  transcricao,
  momento,
  hora,
  nomeLead,
  tabIndex,
  agoraMs,
}: Props) {
  const lido = lerLigacao(texto);
  const titulo = tituloDoRegistro(texto, momento, agoraMs ?? Date.now()) ?? "Ligação";
  const falas = transcricao?.trim()
    ? falasDaTranscricao(transcricao).map((f) => ({
        quem: (f.quem === "Lead" || f.quem === "Nina" ? f.quem : "") as Fala["quem"],
        fala: f.fala,
      }))
    : [];
  const vivo =
    lido?.fase === "andamento" && !andamentoVencido(momento, agoraMs ?? Date.now())
      ? { desde: momento, agente: null }
      : null;
  return (
    <VistaLigacao
      titulo={titulo}
      fase={lido?.fase ?? "concluida"}
      resumo={lido?.resumo ?? null}
      falas={falas}
      hora={hora}
      nomeLead={nomeLead}
      tabIndex={tabIndex}
      vivo={vivo}
    />
  );
}

interface PropsDaMensagem {
  /** A mensagem do tipo "ligacao". */
  mensagemId: string;
  /** O rótulo gravado na mensagem ("Ligação · 2 min 54 s"): vale enquanto a linha não chega. */
  texto: string | null | undefined;
  momento: string;
  hora?: ReactNode;
  nomeLead?: string | undefined;
  tabIndex?: number | undefined;
  agoraMs?: number | undefined;
}

/**
 * A ligação da tela de Ligações (L16): a mensagem do tipo "ligacao" lê a
 * linha de `ligacoes` dela (resumo, duração e transcrição). Enquanto a linha não chega, o rótulo da
 * mensagem. No tempo real, o "em andamento" vira o fim sem recarregar.
 */
export function BlocoLigacaoDaMensagem({
  mensagemId,
  texto,
  momento,
  hora,
  nomeLead,
  tabIndex,
  agoraMs,
}: PropsDaMensagem) {
  const leitura = useLigacaoDaMensagem(mensagemId);
  const l = leitura.dados ?? null;
  const agora = agoraMs ?? Date.now();
  const titulo = l
    ? tituloDaLinhaDeLigacao(l, agora)
    : (tituloDaMensagemDeLigacao({ tipo: "ligacao", texto, momento }, agora) ?? "Ligação");
  const fase: Fase = l
    ? l.status === "em_andamento"
      ? "andamento"
      : l.status === "nao_completada"
        ? "falhou"
        : "concluida"
    : /andamento/.test(texto ?? "")
      ? "andamento"
      : /não completada/.test(texto ?? "")
        ? "falhou"
        : "concluida";
  const falas: Fala[] = (l?.transcricao ?? []).map((f) => ({
    quem: f.papel === "lead" ? "Lead" : "Nina",
    fala: f.texto,
  }));
  const desde = l?.iniciadaEm ?? momento;
  const vivo =
    fase === "andamento" && !andamentoVencido(desde, agora)
      ? { desde, agente: l?.agenteNome ?? null }
      : null;
  return (
    <VistaLigacao
      titulo={titulo}
      fase={fase}
      resumo={l?.resumo ?? null}
      falas={falas}
      hora={hora}
      nomeLead={nomeLead}
      tabIndex={tabIndex}
      vivo={vivo}
    />
  );
}
