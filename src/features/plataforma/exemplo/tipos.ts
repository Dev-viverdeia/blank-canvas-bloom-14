import type { ModoVoz, VozEscolhida } from "@/features/servidor/vozes-tipos";
import type { Enums, Tables } from "@/integrations/supabase/types";

import type { AjusteLembrete, RetornoDados } from "../dados/tipos";
import type { AgenteLigacao, CamposAgente, LigacaoGuardada, LimitesLigacoes } from "../ligacoes/tipos";

// Os tipos do modo exemplo (plano das telas, "Contratos"): cada um é um Pick das colunas reais do
// banco (src/integrations/supabase/types.ts), com os mesmos nomes. Ligar ao banco depois é trocar o
// provedor (ProvedorExemplo), não as telas. O que o banco ainda não tem e a tela precisa vem como
// campo extra opcional, em camelCase, para ficar claro que não é coluna.

/* ---------- enums (os do banco) ---------- */

export type ModoConversa = Enums<"conversa_modo">;
export type MotivoHumano = Enums<"motivo_humano">;
export type OrigemMensagem = Enums<"mensagem_origem">;
export type TipoMensagem = Enums<"mensagem_tipo">;
export type StatusMensagem = Enums<"mensagem_status">;
export type TipoEtapa = Enums<"etapa_tipo">;
export type AtorHistorico = Enums<"historico_ator">;
export type PapelMembro = Enums<"papel_membro">;
export type Gateway = Enums<"gateway">;
export type StatusConexao = Enums<"conexao_status">;
export type FinalidadeIA = Enums<"ia_finalidade">;
export type ProvedorIA = Enums<"ia_provedor">;
export type StatusChave = Enums<"chave_status">;

/* ---------- linhas das tabelas ---------- */

export type Etapa = Pick<
  Tables<"etapas">,
  "id" | "chave" | "nome" | "ordem" | "tipo" | "cor" | "nina_pode_mover" | "arquivada"
>;

export type Membro = Pick<Tables<"membros">, "id" | "nome" | "email" | "papel" | "ativo" | "user_id" | "criado_em">;

export type Contato = Pick<
  Tables<"contatos">,
  | "id"
  | "nome"
  | "nome_whatsapp"
  | "telefone"
  | "email"
  | "empresa"
  | "etapa_id"
  | "etapa_desde"
  | "observacoes"
  | "resumo_nina"
  | "primeira_mensagem_em"
  | "criado_em"
  | "atualizado_em"
> & {
  /** Extra de tela (o banco ainda não guarda): os fatos que a Nina anotou na conversa. */
  fatosNina?: readonly FatoNina[] | undefined;
  /** Extra de tela: o próximo passo que a Nina sugere (nulo = nenhum). */
  proximoPasso?: ProximoPasso | null | undefined;
};

/**
 * Um fato que a Nina anotou sobre o contato (interesse, orçamento, prazo, quem decide...), com o
 * valor do jeito que o lead falou. Extra de tela: o banco ainda não guarda (spec de Contatos, "Fica
 * para quando ligarmos ao banco"). `mensagemId` é a mensagem de onde o fato saiu; nulo = só no resumo.
 */
export interface FatoNina {
  rotulo: string;
  valor: string;
  mensagemId?: string | null | undefined;
}

/** O próximo passo que a Nina sugere para o contato. Extra de tela: o banco ainda não guarda. */
export interface ProximoPasso {
  titulo: string;
  texto: string;
}

export type Conversa = Pick<
  Tables<"conversas">,
  | "id"
  | "contato_id"
  | "conexao_id"
  | "modo"
  | "motivo_humano"
  | "responsavel_id"
  | "aguardando_humano_desde"
  | "devolvida_em"
  | "nao_lidas"
  | "ultima_do_lead_em"
  | "ultima_mensagem_em"
  | "ultima_mensagem_preview"
  | "criado_em"
  | "atualizado_em"
> & {
  /**
   * Extra de tela (o banco ainda não guarda): o id do membro que estava com a conversa quando ela
   * voltou para a fila porque ele foi desativado (spec da Equipe, F1). Só vale enquanto a conversa
   * espera: quem assume, devolve ou responde apaga a marca.
   */
  estavaCom?: string | null | undefined;
};

/**
 * Uma mensagem. `apagada_em` preenchido = o lead apagou (a tela mostra "Mensagem apagada");
 * `transcricao` só em áudio (nula = sem transcrição); `midia_*` em imagem, áudio, vídeo, documento
 * e figurinha. No exemplo não há arquivo de verdade: `midia_caminho` fica nulo e a tela desenha o
 * espaço da mídia.
 */
export type Mensagem = Pick<
  Tables<"mensagens">,
  | "id"
  | "conversa_id"
  | "conexao_id"
  | "direcao"
  | "origem"
  | "tipo"
  | "status"
  | "texto"
  | "transcricao"
  | "momento"
  | "autor_membro_id"
  | "midia_nome"
  | "midia_mime"
  | "midia_tamanho"
  | "midia_caminho"
  | "midia_status"
  | "editada"
  | "apagada_em"
  | "erro"
  | "criado_em"
> & {
  /** Extra de tela (o banco ainda não guarda): o emoji de reação, um só por mensagem. */
  reacao?: string | null | undefined;
  /** Extra de tela: o id da mensagem citada (a resposta a uma mensagem). */
  citaId?: string | null | undefined;
  /** Extra de tela: a duração do áudio ou do vídeo, em segundos. */
  duracaoS?: number | null | undefined;
};

export type HistoricoEtapa = Pick<
  Tables<"contato_etapa_historico">,
  "id" | "contato_id" | "de_etapa_id" | "para_etapa_id" | "ator" | "membro_id" | "criado_em"
>;

/** A conexão do WhatsApp, sem `segredos` (a tela nunca vê). `nome` é o rótulo (o número). */
export type Conexao = Pick<
  Tables<"conexoes">,
  "id" | "nome" | "gateway" | "status" | "ativa" | "oficial" | "id_externo" | "ultimo_erro" | "criado_em" | "atualizado_em"
>;

/** Uma chave de IA, sem `chave_cifrada`: a tela só mostra os 4 últimos caracteres. */
export type ChaveIA = Pick<
  Tables<"ia_chaves">,
  | "id"
  | "finalidade"
  | "provedor"
  | "modelo"
  | "status"
  | "ultimos4"
  | "ultimo_erro"
  | "validada_em"
  | "atualizada_em"
  | "atualizada_por"
>;

export type Configuracao = Pick<
  Tables<"configuracao">,
  "id" | "espera_lote_s" | "espera_lote_max_s" | "onboarding_concluido_em" | "atualizado_em"
> &
  // A voz em uso (spec-voz-uso, P1): quando responder em áudio, a voz escolhida e o motivo do erro.
  // Opcionais: a linha lida sem elas (um dublê antigo, uma leitura de outra tela) vale como o padrão
  // do banco (quando_audio, sem voz), que é o que a leitura (lerVoz) supõe.
  Partial<Pick<Tables<"configuracao">, "voz_resposta" | "voz_id" | "voz_nome" | "voz_erro">>;

/**
 * O gasto de IA de uma conversa (uma linha de `ia_chamadas`). No banco a conversa vem pela
 * rodada (`rodada_id` → `rodadas.conversa_id`); aqui ela vem direto. Valor em dólar, como no banco.
 * Só o admin vê (spec, bloco 3).
 */
export type CustoIA = Pick<Tables<"ia_chamadas">, "id" | "criado_em" | "custo_usd" | "tipo" | "provedor" | "modelo"> & {
  conversa_id: string;
};

export type Auditoria = Pick<Tables<"auditoria">, "id" | "acao" | "alvo" | "ator_membro_id" | "detalhe" | "ultimos4" | "criado_em">;

/* ---------- o que o banco não guarda como linha ---------- */

/**
 * A passagem do bastão numa conversa (os cartões "A Nina passou", "Você assumiu", "Devolveu para a
 * Nina", "Respondida pelo celular" do Chat final). O banco guarda só o estado atual da conversa;
 * o exemplo guarda o momento de cada troca para a tela mostrar na linha do tempo. A mudança de etapa
 * não entra aqui: ela vem do histórico (`HistoricoEtapa`).
 */
export interface EventoPassagem {
  id: string;
  conversa_id: string;
  tipo: "passou" | "assumiu" | "devolveu" | "celular";
  /** Quem assumiu ou devolveu (nulo em "passou" e "celular"). */
  membro_id: string | null;
  /** Em "passou": por que a Nina saiu (nina_passou ou uma falha). */
  motivo: MotivoHumano | null;
  /** Em "assumiu": de onde a conversa veio. */
  de: OrigemPassagem | null;
  /** Em "assumiu" vindo de outra pessoa: quem estava com a conversa. */
  de_membro_id: string | null;
  /** Em "assumiu": a pessoa assumiu mandando uma mensagem, sem clicar em Assumir. */
  por_envio: boolean;
  criado_em: string;
}

/** De onde vem uma conversa assumida: da Nina, da espera, de outra pessoa ou do celular. */
export type OrigemPassagem = "nina" | "espera" | "outro" | "celular";

/**
 * Um convite para a equipe (spec da Equipe, F1). Extra: o banco não tem tabela de convites (e
 * `membros.nome` é obrigatório). Some quando a pessoa aceita ou o admin cancela.
 */
export interface Convite {
  id: string;
  /** Aparado e em minúsculas, como `membros.email`. */
  email: string;
  papel: PapelMembro;
  /** O membro que convidou. */
  convidado_por: string | null;
  /** O último envio (o "Reenviar" grava de novo). */
  enviado_em: string;
}

/* ---------- o estado ---------- */

export interface EstadoBase {
  etapas: Etapa[];
  membros: Membro[];
  contatos: Contato[];
  /** Uma conversa por contato, como no banco (`conversa_do_contato`). */
  conversas: Conversa[];
  /** Todas as mensagens, de todas as conversas, na ordem em que aconteceram. */
  mensagens: Mensagem[];
  historico: HistoricoEtapa[];
  /** A conexão ativa (no banco, só uma tem `ativa`). Nula = nenhum WhatsApp conectado. */
  conexao: Conexao | null;
  /**
   * As chaves de IA, uma por finalidade (resposta e transcrição). Sem a de transcrição = sem escuta.
   * Só o admin lê (como `custos` e `auditoria`): para a atendente, o provedor entrega vazio.
   */
  chaves: ChaveIA[];
  configuracao: Configuracao;
  /** Extra: as passagens do bastão (ver `EventoPassagem`). */
  eventos: EventoPassagem[];
  /** Extra: as conversas em que a Nina está digitando agora (ids de conversa). */
  digitando: string[];
  /** Extra: o gasto de IA por conversa (só o admin vê). */
  custos: CustoIA[];
  /** Extra: o que fica registrado na auditoria (apagar contato, trocar chave ou conexão). */
  auditoria: Auditoria[];
  /** Extra: os convites enviados e ainda não aceitos (ausente = nenhum). Só o admin lê. */
  convites?: Convite[] | undefined;
  /**
   * Extra: as ligações pelo WhatsApp ativadas na demo (2.7). No banco, o
   * estado fica em conexoes.parametros.ligacoes; aqui, só quando ficou ativa. Ausente = desligadas.
   */
  ligacoes?: { ativadaEm: string } | null | undefined;
  /**
   * Extra: os agentes de voz (no banco, `ligacao_agentes`, fase B).
   * Ausente = nenhum. Todo membro lê (o Histórico mostra quem atendeu); só o admin muda.
   */
  ligacaoAgentes?: AgenteLigacao[] | undefined;
  /** Extra: o histórico das ligações (no banco, `ligacoes`, fase B). Ausente = nenhuma. Todo membro lê. */
  historicoLigacoes?: LigacaoGuardada[] | undefined;
  /** Extra: os limites das ligações (no banco, colunas novas de `configuracao`). Ausente = os padrões. */
  limitesLigacoes?: LimitesLigacoes | undefined;
  /**
   * Extra: os retornos e lembretes da Nina (no banco, `retornos`). Ausente = nenhum: o exemplo NÃO
   * semeia (só os testes põem). As telas leem igual nos dois modos.
   */
  retornos?: RetornoDados[] | undefined;
  /** Extra: o ajuste do lembrete (no banco, colunas de `configuracao`). Ausente = o padrão (ligado, 3 h). */
  lembrete?: AjusteLembrete | undefined;
}

/** O estado que as telas leem: o do exemplo mais `eu`, o membro logado (muda com o papel). */
export interface EstadoExemplo extends EstadoBase {
  eu: Membro;
  /**
   * Extra (só do modo exemplo): a pausa da simulação (o botão do topo saiu em 30/10). Pausada, a Nina simulada do Kanban
   * para de dar passos; ao retomar, continua de onde estava. Fica no provedor para não se perder ao
   * trocar de área. Ausente conta como rodando.
   */
  simulacaoPausada?: boolean | undefined;
}

/* ---------- ações ---------- */

export type ErroExemplo =
  | "sem_permissao"
  | "sem_conexao_ativa"
  | "janela_fechada"
  | "nao_encontrado"
  /** Cancelar um retorno ou lembrete que já saiu, já foi cancelado ou não existe (`cancelar_retorno`). */
  | "retorno_nao_pendente"
  /** Arquivar uma etapa que ainda tem contato (gatilho tg_etapas_arquivar). */
  | "etapa_com_leads"
  /** Arquivar a última etapa aberta: o lead novo não teria onde entrar (tg_etapas_arquivar). */
  | "sem_etapa_de_entrada"
  /** Nome de etapa vazio (check `btrim(nome) <> ''`). */
  | "nome_vazio"
  /** E-mail sem o formato x@y.zz (convite). */
  | "email_invalido"
  /** O e-mail já é de um membro (ativo ou não) ou de outro convite. */
  | "email_em_uso"
  /** A ação deixaria a equipe sem admin ativo (gatilho membros_ultimo_admin). */
  | "ultimo_admin"
  /** Ninguém troca o próprio papel nem se desativa (decisão 3 da spec da Equipe). */
  | "proprio_membro"
  /** Apagar o agente de voz que atende as ligações (L10: troque quem atende antes). */
  | "agente_que_atende"
  /**
   * O uso do agente não deixa (A1): o Ativo não atende, o que atende
   * não vira Ativo e o primeiro agente é Receptivo.
   */
  | "uso_do_agente";

/**
 * O resultado de toda ação. Nunca lança: a recusada devolve o erro e não muda nada.
 * `id` é o da linha criada (a mensagem enviada); `assumiu` diz que a ação tirou a conversa da Nina,
 * da espera ou do celular (a tela avisa "Você assumiu a conversa").
 */
export type ResultadoExemplo =
  | { ok: true; id?: string | undefined; assumiu?: boolean | undefined }
  | { ok: false; erro: ErroExemplo };

export interface NovaMensagem {
  texto?: string | null | undefined;
  tipo: TipoMensagem;
  /** Anexo ou áudio gravado (simulado): nome, tipo e tamanho do arquivo, e a duração. */
  midia?:
    | {
        nome: string;
        mime?: string | null | undefined;
        tamanho?: number | null | undefined;
        duracaoS?: number | null | undefined;
      }
    | null
    | undefined;
  citaId?: string | null | undefined;
}

/**
 * O que a tela pode mudar num contato: as colunas que o banco deixa o membro gravar (grant por
 * coluna em `contatos`; a etapa muda por `moverEtapa`). Telefone e nome do WhatsApp vêm do WhatsApp.
 */
export type CamposContato = Partial<Pick<Contato, "nome" | "email" | "empresa" | "observacoes" | "resumo_nina">>;

/** O que o "Editar etapas" (Kanban 2) muda numa etapa. A ordem muda por `reordenarEtapas`. */
export type CamposEtapa = Partial<Pick<Etapa, "nome" | "cor" | "nina_pode_mover" | "arquivada">>;

export interface NovaConexao {
  gateway: Gateway;
  /** O rótulo do número (ex.: "(11) 90000-0000"). */
  nome: string;
  id_externo?: string | undefined;
  /** Meta e Zernio (API oficial): ligam a regra da janela de 24 h. Sem o campo, vem do gateway. */
  oficial?: boolean | null | undefined;
}

export interface NovaChaveIA {
  provedor: ProvedorIA;
  modelo: string;
  ultimos4: string;
}

/**
 * O que as telas simulam (o "Simular" do Chat, a "Nina ao vivo" do Kanban). Não passa pelo papel:
 * é o mundo acontecendo (a Nina, o lead, o celular da empresa, o provedor).
 */
export type EventoSimulado =
  | { tipo: "lead_mensagem"; conversaId: string; mensagem: NovaMensagem }
  | { tipo: "nina_responde"; conversaId: string; texto: string }
  | { tipo: "nina_digitando"; conversaId: string; digitando: boolean }
  | { tipo: "nina_move"; contatoId: string; etapaId: string }
  | { tipo: "nina_passa"; conversaId: string; motivo: MotivoHumano }
  | { tipo: "nina_resumo"; contatoId: string; resumo: string }
  | { tipo: "celular_responde"; conversaId: string; texto: string }
  | { tipo: "status_mensagem"; mensagemId: string; status: StatusMensagem; erro?: string | null | undefined }
  | { tipo: "conexao"; status: StatusConexao; ultimo_erro?: string | null | undefined }
  | { tipo: "chave"; finalidade: FinalidadeIA; status: StatusChave; ultimo_erro?: string | null | undefined };

export interface AcoesExemplo {
  enviarMensagem: (conversaId: string, mensagem: NovaMensagem) => ResultadoExemplo;
  assumir: (conversaId: string) => ResultadoExemplo;
  devolverParaNina: (conversaId: string) => ResultadoExemplo;
  marcarLida: (conversaId: string) => ResultadoExemplo;
  reagir: (mensagemId: string, emoji: string | null) => ResultadoExemplo;
  /** Reenvia uma mensagem que falhou (o "Tentar de novo" da Bolha). */
  tentarDeNovo: (mensagemId: string) => ResultadoExemplo;
  moverEtapa: (contatoId: string, etapaId: string, ator: "membro" | "nina") => ResultadoExemplo;
  editarContato: (contatoId: string, campos: CamposContato) => ResultadoExemplo;
  /**
   * Só o admin (policy etapas_admin_altera). Renomeia (aparado, até 32 caracteres), troca a cor,
   * liga ou desliga o "Nina pode mover", arquiva e restaura. Recusa: `nome_vazio`,
   * `etapa_com_leads` (arquivar com contato) e `sem_etapa_de_entrada` (arquivar a última aberta).
   */
  editarEtapa: (etapaId: string, campos: CamposEtapa) => ResultadoExemplo;
  /**
   * Só o admin. Regrava a ordem dos ids passados (10, 20, 30...), dentro de um grupo só: as abertas,
   * ou Ganho e Perdido. Id que não existe ou repetido: `nao_encontrado`; grupos misturados:
   * `sem_permissao`.
   */
  reordenarEtapas: (ids: string[]) => ResultadoExemplo;
  /** Só o admin. Leva junto a conversa, as mensagens, o histórico e o custo; fica na auditoria. */
  apagarContato: (contatoId: string) => ResultadoExemplo;
  simularNina: (evento: EventoSimulado) => ResultadoExemplo;
  /** Só o admin. `null` desconecta o número atual. */
  trocarConexao: (nova: NovaConexao | null) => ResultadoExemplo;
  /** Só o admin. `null` remove a chave daquela finalidade. */
  trocarChaveIA: (finalidade: FinalidadeIA, nova: NovaChaveIA | null) => ResultadoExemplo;
  /**
   * Só o admin. Os valores saem presos aos limites de `LIMITES_RITMO`; o lembrete (opcional), às horas de
   * `LIMITES_LEMBRETE`.
   */
  salvarRitmo: (espera: number, teto: number, lembrete?: AjusteLembrete) => ResultadoExemplo;
  /** Qualquer membro ativo. Só cancela o que está `pendente`; senão `retorno_nao_pendente`. */
  cancelarRetorno: (retornoId: string) => ResultadoExemplo;
  /** Só o admin. Grava a voz escolhida (e limpa o erro da voz). Id fora do formato: `nao_encontrado`. */
  escolherVoz: (voz: VozEscolhida) => ResultadoExemplo;
  /** Só o admin. Quando a Nina responde em áudio. Modo fora da lista: `nao_encontrado`. */
  salvarModoVoz: (modo: ModoVoz) => ResultadoExemplo;
  /** Só o admin. Liga (só com a conexão ativa da Meta) ou desliga as ligações da demo. */
  trocarLigacoes: (ativas: boolean) => ResultadoExemplo;
  /** Só o admin. Cria um agente de voz com a versão de configuração dada; o `id` é o do agente. */
  criarAgenteLigacao: (campos: CamposAgente, versao: number) => ResultadoExemplo;
  /** Só o admin. Grava os campos e a versão aplicada (editar leva a configuração inteira, L10). */
  salvarAgenteLigacao: (agenteId: string, campos: CamposAgente, versao: number) => ResultadoExemplo;
  /** Só o admin. Recusa `agente_que_atende` para o agente que atende. */
  apagarAgenteLigacao: (agenteId: string) => ResultadoExemplo;
  /** Só o admin. Este agente passa a atender as ligações (um só, L3). */
  atenderAgenteLigacao: (agenteId: string) => ResultadoExemplo;
  /** Só o admin. Leva todos os agentes para a versão dada (o "Atualizar" da L13). */
  atualizarAgentesLigacao: (versao: number) => ResultadoExemplo;
  /** Só o admin. Os valores saem presos às faixas de `FAIXA_LIMITES`. */
  salvarLimitesLigacoes: (limites: LimitesLigacoes) => ResultadoExemplo;
  /** Volta o exemplo ao começo (o "Recomeçar o exemplo" do Simular). */
  recomecar: () => void;
  /** Pausa ou retoma a simulação da Nina (só no modo exemplo; sem botão desde 30/10, usada nos testes). */
  alternarSimulacao?: (() => void) | undefined;
  /** Só o admin (spec da Equipe, F2). Recusa: `email_invalido`, `email_em_uso`. O `id` é o do convite. */
  convidarMembro: (email: string, papel: PapelMembro) => ResultadoExemplo;
  /** Só o admin. Grava o novo envio. */
  reenviarConvite: (conviteId: string) => ResultadoExemplo;
  /** Só o admin. O convite some (o link do e-mail deixa de valer). */
  cancelarConvite: (conviteId: string) => ResultadoExemplo;
  /** Só o admin, nunca em si mesmo (`proprio_membro`) e nunca deixando a equipe sem admin (`ultimo_admin`). */
  trocarPapelMembro: (membroId: string, papel: PapelMembro) => ResultadoExemplo;
  /**
   * Só o admin, nunca em si mesmo nem no último admin. As conversas com a pessoa voltam para a espera
   * ("Precisam de você"), com `estavaCom`.
   */
  desativarMembro: (membroId: string) => ResultadoExemplo;
  /** Só o admin. As conversas não voltam para a pessoa. */
  reativarMembro: (membroId: string) => ResultadoExemplo;
}

/** A ação que o reducer recebe: o que fazer, quem faz (`euId`) e quando (`agora`, ISO). */
export type AcaoExemplo =
  | { tipo: "enviarMensagem"; conversaId: string; mensagem: NovaMensagem }
  | { tipo: "assumir"; conversaId: string }
  | { tipo: "devolverParaNina"; conversaId: string }
  | { tipo: "marcarLida"; conversaId: string }
  | { tipo: "reagir"; mensagemId: string; emoji: string | null }
  | { tipo: "tentarDeNovo"; mensagemId: string }
  | { tipo: "moverEtapa"; contatoId: string; etapaId: string; ator: "membro" | "nina" }
  | { tipo: "editarContato"; contatoId: string; campos: CamposContato }
  | { tipo: "editarEtapa"; etapaId: string; campos: CamposEtapa }
  | { tipo: "reordenarEtapas"; ids: string[] }
  | { tipo: "apagarContato"; contatoId: string }
  | { tipo: "simularNina"; evento: EventoSimulado }
  | { tipo: "trocarConexao"; nova: NovaConexao | null }
  | { tipo: "trocarChaveIA"; finalidade: FinalidadeIA; nova: NovaChaveIA | null }
  | { tipo: "salvarRitmo"; espera: number; teto: number; lembrete?: AjusteLembrete | undefined }
  | { tipo: "cancelarRetorno"; retornoId: string }
  | { tipo: "escolherVoz"; voz: VozEscolhida }
  | { tipo: "salvarModoVoz"; modo: ModoVoz }
  | { tipo: "trocarLigacoes"; ativas: boolean }
  | { tipo: "criarAgenteLigacao"; campos: CamposAgente; versao: number }
  | { tipo: "salvarAgenteLigacao"; agenteId: string; campos: CamposAgente; versao: number }
  | { tipo: "apagarAgenteLigacao"; agenteId: string }
  | { tipo: "atenderAgenteLigacao"; agenteId: string }
  | { tipo: "atualizarAgentesLigacao"; versao: number }
  | { tipo: "salvarLimitesLigacoes"; limites: LimitesLigacoes }
  | { tipo: "convidarMembro"; email: string; papel: PapelMembro }
  | { tipo: "reenviarConvite"; conviteId: string }
  | { tipo: "cancelarConvite"; conviteId: string }
  | { tipo: "trocarPapelMembro"; membroId: string; papel: PapelMembro }
  | { tipo: "desativarMembro"; membroId: string }
  | { tipo: "reativarMembro"; membroId: string };

export interface Comando {
  acao: AcaoExemplo;
  /** O membro que faz a ação (o `eu` do momento). */
  euId: string;
  /** O instante da ação, em ISO (o provedor usa o relógio; o teste fixa). */
  agora: string;
}
