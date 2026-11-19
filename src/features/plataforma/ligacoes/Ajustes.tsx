import { useState } from "react";

import { Aviso, Botao } from "@/components/subido";

import { AtalhoArea } from "../comum/AtalhoArea";
import { dataCurta } from "../comum/tempo";
import type { AcoesLigacoes } from "../dados/ligacoes";
import type { Leitura } from "../dados/tipos";
import { CartaoLigacoes, type ControleLigacoes } from "./Ativacao";
import { l } from "./estilos";
import { Passo, type TomAvisoCurto } from "./pecas";
import { FAIXA_LIMITES, mudarLimite, type LimitesLigacoes } from "./tipos";

// A aba Ajustes (2.3; só o admin): o número conectado, os limites
// (simultâneas, por dia e por contato em 24 h, L19) e "Desativar ligações", com as pendências e os
// botões "Já desliguei" / "Já apaguei" de hoje (o cartão das ligações, que antes de ativar fica no topo).

const ID_LIMITES = "lg-h-limites";

const ROTULO_LIMITE: Record<
  keyof LimitesLigacoes,
  { rotulo: string; unidade: string; ajuda: string; menos: string; mais: string }
> = {
  simultaneas: {
    rotulo: "Ligações ao mesmo tempo",
    unidade: "",
    ajuda:
      "Quantas ligações o número atende juntas. As outras ouvem que a linha está ocupada. O plano da sua conta na ElevenLabs também tem um limite de ligações juntas, que vale por cima deste.",
    menos: "Uma ligação ao mesmo tempo a menos",
    mais: "Uma ligação ao mesmo tempo a mais",
  },
  porDia: {
    rotulo: "Ligações por dia",
    unidade: "",
    ajuda:
      "Passou disso, as ligações do dia não são atendidas nem feitas. A conta da Nina soma todos os agentes e vira à meia-noite de Brasília; cada agente na ElevenLabs também tem este limite, que vira à meia-noite UTC (21h em Brasília).",
    menos: "Dez ligações por dia a menos",
    mais: "Dez ligações por dia a mais",
  },
  porContato: {
    rotulo: "Por contato em 24 horas",
    unidade: "",
    ajuda: "Quantas vezes a mesma pessoa é atendida num dia.",
    menos: "Uma ligação por contato a menos",
    mais: "Uma ligação por contato a mais",
  },
};

interface Props {
  controle: ControleLigacoes;
  limites: Leitura<LimitesLigacoes>;
  acoes: AcoesLigacoes;
  avisar: (texto: string, tom?: TomAvisoCurto) => void;
}

export function Ajustes({ controle, limites, acoes, avisar }: Props) {
  const estado = controle.estado;
  const situacao = estado?.situacao ?? null;
  const cartaoAqui =
    controle.acao !== "ativar" && (situacao === "ativa" || situacao === "com_pendencias");

  return (
    <div className={l.lgAjustes}>
      <section className={l.lgSecao} aria-labelledby="lg-h-numero">
        <h2 id="lg-h-numero" className={l.lgSecaoH}>
          Número
        </h2>
        <p className={l.lgAjuda}>
          {situacao === "ativa" && estado?.numero
            ? `A Nina atende as ligações no ${estado.numero}${estado.ativadaEm ? `, desde ${dataCurta(estado.ativadaEm, true)}` : ""}.`
            : "Nenhum número com ligações ativas. Para ativar, siga os passos no topo da página."}{" "}
          O número é o do WhatsApp conectado na Configuração.
        </p>
        <div>
          <AtalhoArea para="/app/configuracao" variante="discreto" tamanho="compacto">
            Abrir a Configuração
          </AtalhoArea>
        </div>
      </section>

      <Limites leitura={limites} acoes={acoes} avisar={avisar} />

      {cartaoAqui ? <CartaoLigacoes controle={controle} meta="Desativar ligações" /> : null}
    </div>
  );
}

function Limites({
  leitura,
  acoes,
  avisar,
}: {
  leitura: Leitura<LimitesLigacoes>;
  acoes: AcoesLigacoes;
  avisar: Props["avisar"];
}) {
  const salvo = leitura.dados;
  const [rascunho, setRascunho] = useState<LimitesLigacoes | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  if (!salvo) return null;
  const r = rascunho ?? salvo;
  const mudou =
    r.simultaneas !== salvo.simultaneas ||
    r.porDia !== salvo.porDia ||
    r.porContato !== salvo.porContato;

  const salvar = () => {
    if (salvando) return;
    setErro(null);
    setSalvando(true);
    void acoes.salvarLimites(r).then((res) => {
      setSalvando(false);
      if (!res.ok) {
        setErro(
          res.erro === "falha" && res.detalhe === "fase B"
            ? "Ainda não dá para mudar os limites por aqui."
            : "Não deu para salvar os limites. Tente de novo.",
        );
        return;
      }
      setRascunho(null);
      avisar("Limites salvos.");
      document.getElementById(ID_LIMITES)?.focus({ preventScroll: true });
    });
  };

  return (
    <section className={l.lgSecao} aria-labelledby={ID_LIMITES}>
      <h2 id={ID_LIMITES} tabIndex={-1} className={l.lgSecaoH}>
        Limites
      </h2>
      <p className={l.lgAjuda}>
        Valem para todos os agentes. Os padrões servem para a maioria das empresas.
      </p>
      {erro ? (
        <Aviso tom="erro" compacto>
          {erro}
        </Aviso>
      ) : null}
      <div className={l.lgRegs}>
        {(Object.keys(ROTULO_LIMITE) as (keyof LimitesLigacoes)[]).map((campo) => {
          const t = ROTULO_LIMITE[campo];
          const f = FAIXA_LIMITES[campo];
          return (
            <Passo
              key={campo}
              id={`lg-limite-${campo}`}
              rotulo={t.rotulo}
              valor={r[campo]}
              texto={{ numero: r[campo].toLocaleString("pt-BR"), unidade: t.unidade }}
              ajuda={t.ajuda}
              noMinimo={salvando || r[campo] <= f.min}
              noMaximo={salvando || r[campo] >= f.max}
              menosAria={t.menos}
              maisAria={t.mais}
              aoMudar={(sinal) => setRascunho(mudarLimite(r, campo, sinal))}
            />
          );
        })}
      </div>
      {mudou ? (
        <div className={l.lgSecaoPe}>
          <p className={l.lgMeta}>Mudanças ainda não salvas</p>
          <Botao variante="discreto" disabled={salvando} onClick={() => setRascunho(null)}>
            Desfazer
          </Botao>
          <Botao carregando={salvando} onClick={salvar}>
            Salvar os limites
          </Botao>
        </div>
      ) : null}
    </section>
  );
}
