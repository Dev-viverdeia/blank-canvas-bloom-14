// Contratos das ligações pelo WhatsApp (seção 2). Tipos e constantes puros:
// nada aqui toca no banco nem na rede, e a tela também importa este arquivo.

/**
 * O que não saiu na desativação: "meta" (desligar o SIP na Meta), "meta_manual" (desligar no
 * painel da Meta, D23 e D34), "eleven_manual" (apagar no painel da ElevenLabs, D30) e cada recurso
 * da ElevenLabs, na ordem da desmontagem (D17).
 */
export const PENDENCIAS_LIGACOES = [
  "meta",
  "meta_manual",
  "eleven_manual",
  "tronco",
  "agente",
  "ferramenta",
  "webhook",
  "segredo",
] as const;
export type PendenciaLigacoes = (typeof PENDENCIAS_LIGACOES)[number];

export function ehPendenciaLigacoes(v: unknown): v is PendenciaLigacoes {
  return typeof v === "string" && (PENDENCIAS_LIGACOES as readonly string[]).includes(v);
}

/** Estado gravado em conexoes.parametros.ligacoes (spec 2.1). */
export type LigacoesGravadas = {
  versao: 1;
  situacao: "ativando" | "ativa" | "com_pendencias";
  /** Base das URLs dadas à ElevenLabs (o endereço publicado de onde o admin ativou). */
  origem: string;
  /** Só dígitos: o número do WhatsApp da conexão. */
  numero: string;
  /** O limite de mensagens da Meta lido na ativação (ex.: "TIER_2K"). */
  limiteMeta: string | null;
  /** ISO 8601, quando a situação virou "ativa". */
  ativadaEm: string | null;
  /** Ids na conta da ElevenLabs; null = ainda não criado ou já apagado. */
  eleven: {
    segredoId: string | null;
    webhookId: string | null;
    ferramentaId: string | null;
    agenteId: string | null;
    troncoId: string | null;
  };
  /** O app ligou o SIP na Meta (a desativação só desliga o que o app ligou). */
  metaSip: boolean;
  /**
   * A ligação de saída está pronta (seção 1): o tronco tem a saída e o
   * callback de 7 dias está ligado na Meta. Ausente = ativado antes da saída, ou a saída falhou na
   * ativação: o primeiro "Ligar" completa.
   */
  saida?: boolean;
  /** O que não saiu na desativação (PENDENCIAS_LIGACOES). */
  pendencias: PendenciaLigacoes[];
  /** ISO 8601, a cada gravação (D20). "" = estado antigo, gravado antes do campo existir. */
  atualizadaEm: string;
};

/** Chave de conexoes.parametros onde o estado fica. */
export const CHAVE_PARAMETROS = "ligacoes";

/** Nomes dos dois segredos novos em conexoes.segredos (cifrados como os da Meta). */
export const SEGREDO_TOKEN = "ligacaoToken";
export const SEGREDO_HMAC = "ligacaoHmac";
export const SEGREDOS_LIGACOES = [SEGREDO_TOKEN, SEGREDO_HMAC] as const;

/** As ações da rota /api/public/ligacoes/<conexão>/<ação> (spec 2.2). */
export const ACOES_LIGACAO = ["inicio", "equipe", "pos-chamada"] as const;
export type AcaoLigacao = (typeof ACOES_LIGACAO)[number];

export function urlDaLigacao(origem: string, conexaoId: string, acao: AcaoLigacao): string {
  return `${origem.replace(/\/+$/, "")}/api/public/ligacoes/${conexaoId}/${acao}`;
}

/** Nome da ferramenta webhook no agente (D10). */
export const FERRAMENTA_EQUIPE = "nina_passar_para_equipe";
/** Cabeçalho que leva o token de sessão para a ferramenta (spec 2.4). */
export const CABECALHO_SESSAO = "X-Nina-Sessao";
/** Variável dinâmica secreta com o token de sessão (a ElevenLabs não a mostra nem a devolve). */
export const VARIAVEL_SESSAO = "secret__nina_sessao";
/** Variável com o id da linha da ligação de saída (o pós-chamada confirma por ela). */
export const VARIAVEL_LIGACAO = "nina_ligacao";

/** Limites padrão (D8, D11, L5). */
export const MAX_DURACAO_S = 600;
export const SILENCIO_S = 25;
export const LIGACOES_SIMULTANEAS = 2;
export const LIGACOES_POR_DIA = 100;
export const LIGACOES_POR_CONTATO_24H = 10;
/** A duração máxima que um agente aceita (a faixa de duracao_max_s, L5): 30 minutos. */
export const DURACAO_MAX_AGENTE_S = 1_800;
/** A folga depois da duração máxima: a ligação passa um pouco dela e o pós-chamada demora a chegar. */
export const FOLGA_LIGACAO_S = 5 * 60;
/**
 * O teto da validade do token de sessão (L40): a duração máxima da faixa mais a folga. Cada sessão
 * vale a duração máxima do agente que atendeu mais a folga (validadeDaSessao), nunca mais que isto.
 */
export const SESSAO_VALIDA_S = DURACAO_MAX_AGENTE_S + FOLGA_LIGACAO_S;

/** A validade da sessão de uma ligação: a duração máxima do agente (sem agente, a da faixa) mais a folga. */
export function validadeDaSessao(duracaoMaxS: number | null | undefined): number {
  const d =
    typeof duracaoMaxS === "number" && Number.isFinite(duracaoMaxS) && duracaoMaxS > 0
      ? Math.min(duracaoMaxS, DURACAO_MAX_AGENTE_S)
      : DURACAO_MAX_AGENTE_S;
  return d + FOLGA_LIGACAO_S;
}
/** Tolerância da assinatura do pós-chamada (a ElevenLabs reenvia em falha). */
export const TOLERANCIA_ASSINATURA_S = 30 * 60;

/** SIP da ElevenLabs (TLS) e domínio SIP da Meta (spec 2.6). */
export const SIP_ELEVENLABS = { hostname: "sip.rtc.elevenlabs.io", port: 5061 } as const;
export const DOMINIO_SIP_META = "wa.meta.vc";
/** "ativando" sem progresso por mais que isto é uma ativação abandonada (D20). */
export const ATIVACAO_ABANDONADA_MS = 2 * 60 * 1000;
/** Teto da parte de banco do início (D26): estourou, sai a saudação genérica. */
export const TETO_INICIO_MS = 4000;

/** O que a tela recebe (spec 2.6). */
export type SituacaoLigacoes = "indisponivel" | "pronta" | "ativando" | "ativa" | "com_pendencias";

export type RequisitosLigacoes = {
  /** Conexão ativa e oficial da Meta. */
  conexaoMeta: boolean;
  /** Chave da ElevenLabs (finalidade voz) ativa. */
  chaveVoz: boolean;
  /** configuracao.voz_id preenchida. */
  vozEscolhida: boolean;
  /** O pedido não veio da prévia nem do localhost. */
  enderecoPublicado: boolean;
};

// ---------- a verificação antes de ativar (seção 21) ----------

/**
 * Os itens da verificação, na ordem em que a tela mostra e o servidor confere. Os quatro
 * primeiros são os requisitos da Nina (RequisitosLigacoes); os de "meta_" e "chave_agentes" só
 * se conferem com eles cumpridos (senão ficam "nao_conferido").
 */
export const ITENS_ELEGIBILIDADE = [
  "conexao_meta",
  "chave_voz",
  "voz",
  "endereco",
  "meta_token",
  "meta_limite",
  "meta_numero",
  "meta_sip_livre",
  "chave_agentes",
] as const;
export type IdItemElegibilidade = (typeof ITENS_ELEGIBILIDADE)[number];

/** De quem é a regra: a tela diz "regra da Meta" para os da Meta. */
export type DonoItemElegibilidade = "meta" | "nina" | "elevenlabs";

export const DONO_ITEM_ELEGIBILIDADE: Record<IdItemElegibilidade, DonoItemElegibilidade> = {
  conexao_meta: "nina",
  chave_voz: "nina",
  voz: "nina",
  endereco: "nina",
  meta_token: "meta",
  meta_limite: "meta",
  meta_numero: "meta",
  meta_sip_livre: "meta",
  chave_agentes: "elevenlabs",
};

/**
 * ok = cumprido; falta = conferido e não cumprido; falhou = não deu para conferir agora (rede,
 * tempo, provedor fora: tentar de novo resolve); nao_conferido = não chegou a conferir (um item
 * antes faltou).
 */
export type EstadoItemElegibilidade = "ok" | "falta" | "falhou" | "nao_conferido";

export type ItemElegibilidade = {
  id: IdItemElegibilidade;
  dono: DonoItemElegibilidade;
  estado: EstadoItemElegibilidade;
  /**
   * O valor lido, quando ajuda a explicar: em meta_limite, o tier (ex.: "TIER_250"); em
   * meta_numero, o can_send_message do health_status (ex.: "BLOCKED"). Nunca segredo.
   */
  valor?: string;
  /**
   * Em "falta" ou "falhou", o erro deste item (o mesmo código da falha do ativar): a tela escolhe
   * o texto por ele. Ex.: meta_numero com "meta_pausada" (138014) ou "meta_numero_bloqueado"
   * (BLOCKED); meta_limite com "meta_limite" mesmo quando o tier lido era 2K (a Meta recusou).
   */
  erro?: ErroLigacoes;
};

/** O resultado da verificação, gravado em conexoes.parametros.ligacoesElegibilidade. */
export type Elegibilidade = {
  versao: 1;
  /** Todos os itens "ok": a ativação pode seguir. */
  elegivel: boolean;
  /** O tier lido na Meta (null = não leu). */
  limiteMeta: string | null;
  itens: ItemElegibilidade[];
  /** ISO 8601. */
  conferidaEm: string;
};

/** Chave de conexoes.parametros onde fica a última verificação (fora de "ligacoes", que é da ativação). */
export const CHAVE_ELEGIBILIDADE = "ligacoesElegibilidade";

/**
 * Os tiers da Meta abaixo de 2.000 conversas por dia: com eles a Meta recusa as chamadas (138015).
 * Só estes reprovam na verificação. Tier ausente ou desconhecido (um número de teste, um tier novo
 * da Meta) passa, e quem decide é a Meta no ligar do SIP, que vem antes de criar qualquer coisa na
 * ElevenLabs.
 */
export const LIMITES_META_SEM_LIGACOES = ["TIER_50", "TIER_250", "TIER_1K"];

export type EstadoLigacoes = {
  situacao: SituacaoLigacoes;
  requisitos: RequisitosLigacoes;
  /** A última verificação desta conexão (null = nunca verificada, ou a conexão mudou). */
  elegibilidade?: Elegibilidade | null;
  /** Formatado, quando ativa (ex.: "+55 11 91234-5678"). */
  numero: string | null;
  ativadaEm: string | null;
  pendencias: PendenciaLigacoes[];
  /** true = "com_pendencias" vindo de uma ativação que parou no meio (D20), não de uma desativação. */
  abandonada?: boolean;
};

export type ErroLigacoes =
  | "sem_acesso"
  | "sem_conexao_meta"
  | "sem_chave_voz"
  | "sem_voz"
  | "endereco_de_previa"
  | "ja_ativa"
  /** ativar com pendências de uma desativação, ou com uma ativação abandonada (D20, D35) */
  | "com_pendencias"
  /** a conexão saiu, ou as ligações foram desativadas, no meio da ativação (D21, D35) */
  | "ativacao_interrompida"
  | "chave_invalida"
  | "chave_sem_acesso_agentes"
  | "numero_em_outra_conta"
  | "meta_token_invalido"
  | "meta_recusou"
  /** a Meta só liga chamadas com 2.000 conversas por dia ou mais (tier abaixo de TIER_2K, ou 138015) */
  | "meta_limite"
  /** a Meta recusou por requisito técnico do número ou do app (138018) */
  | "meta_requisito_tecnico"
  /** a Meta pausou as ligações do número por qualidade baixa (138014) */
  | "meta_pausada"
  /** o número está bloqueado na Meta (health_status BLOCKED: pagamento, verificação, política...) */
  | "meta_numero_bloqueado"
  /** a verificação achou um item faltando: o detalhe está em `elegibilidade` */
  | "nao_elegivel"
  | "meta_sip_em_uso"
  | "provedor_fora"
  | "tempo_esgotado"
  | "erro_ao_gravar"
  | "erro_ao_ler"
  /** o agente não existe mais na conta da ElevenLabs (PATCH com 404) */
  | "agente_nao_encontrado"
  /** o prompt do agente (com o Contexto inteiro, L14) passa do limite da ElevenLabs */
  | "prompt_grande";

export type FalhaLigacoes = {
  ok: false;
  erro: ErroLigacoes;
  mensagem: string;
  /** A verificação feita no ativar, quando ela reprovou ("nao_elegivel", "meta_limite"...). */
  elegibilidade?: Elegibilidade;
};
export type ResultadoLigacoes = { ok: true; estado: EstadoLigacoes } | FalhaLigacoes;

/** Os requisitos todos cumpridos. */
export function requisitosCumpridos(r: RequisitosLigacoes): boolean {
  return r.conexaoMeta && r.chaveVoz && r.vozEscolhida && r.enderecoPublicado;
}

// ---------- os agentes de voz (L2 a L15 e L19) ----------

/**
 * A versão da configuração dos agentes que o código monta (L13; servidor/ligacoes-elevenlabs.ts).
 * Cada agente guarda a versão aplicada; com uma mais nova aqui, a tela oferece atualizar todos
 * (PATCH). A 1 é a da primeira versão (um agente só); a 3 traz a regra do canal (L42); a 4, a
 * imagem que não sai durante a ligação (L44); a 5, o prompt padrão com as regras de fala das
 * ligações reais da vitrine, o envio por escrito depois da ligação e o tempo da ligação
 * (seção 8); a 6, o tempo da ligação sem o relógio, que quebrava o cache do
 * LLM (seção 22). Aqui, e não no servidor, porque a tela lê. Sobe só no commit que vai ao ar
 * (seção 6).
 */
export const VERSAO_AGENTE = 6;

export const OBJETIVOS_AGENTE = ["vendas", "suporte", "outro"] as const;
export type ObjetivoAgente = (typeof OBJETIVOS_AGENTE)[number];

/**
 * O uso do agente (A1): Receptivo ("receber", recebe as ligações do
 * número; só ele pode atender) ou Ativo ("ligar", faz ligações). O enum ligacao_agente_uso do banco.
 */
export const USOS_AGENTE = ["receber", "ligar"] as const;
export type UsoAgente = (typeof USOS_AGENTE)[number];

/** Perfis de modelos (L6, L13): o que cada um usa fica em PERFIS, no servidor. */
export const PERFIS_AGENTE = ["recomendado", "rapido", "caprichado"] as const;
export type PerfilAgente = (typeof PERFIS_AGENTE)[number];

/** Um agente de voz da Nina (a linha de ligacao_agentes, sem o que é da sincronia). */
export type AgenteVoz = {
  nome: string;
  /** Receptivo ou Ativo (A1 da spec). */
  uso: UsoAgente;
  objetivo: ObjetivoAgente;
  /** As instruções do admin; "" = só o objetivo. */
  instrucoes: string;
  /** Quando passar para a equipe; null = a parte "Quando passar para humano" do Contexto (L8). */
  regrasEquipe: string | null;
  /** null = a voz do cartão Voz (quem monta o agente decide). */
  vozId: string | null;
  vozNome: string | null;
  perfil: PerfilAgente;
  /** Modelo da saudação: {nome} vira o primeiro nome do lead (saudacaoDoAgente). */
  saudacao: string;
  duracaoMaxS: number;
  silencioS: number;
};

/** O agente com a voz já decidida: o que vai para a ElevenLabs. */
export type AgenteVozPronto = AgenteVoz & { vozId: string };

/**
 * O modelo de saudação do agente Ativo novo (A4 da spec): quem liga se
 * apresenta. O agente Receptivo, quando liga, usa este mesmo texto no lugar da saudação dele.
 */
export const SAUDACAO_AGENTE_LIGAR =
  "Oi, {nome}! Aqui é a Nina, te ligando pelo WhatsApp. Tudo bem?";

/** O modelo de saudação padrão (L5). */
export const SAUDACAO_AGENTE_PADRAO = "Oi, {nome}! Aqui é a Nina. Como posso te ajudar?";

/** O agente "Nina" que nasce na ativação e o ponto de partida do "Novo agente" (L2, L5). */
export const AGENTE_PADRAO: AgenteVoz = {
  nome: "Nina",
  uso: "receber",
  objetivo: "vendas",
  instrucoes: "",
  regrasEquipe: null,
  vozId: null,
  vozNome: null,
  perfil: "recomendado",
  saudacao: SAUDACAO_AGENTE_PADRAO,
  duracaoMaxS: MAX_DURACAO_S,
  silencioS: SILENCIO_S,
};

/** Os limites da conta (L19): simultâneas e por dia vão a todos os agentes; por contato, no início. */
export type LimitesLigacoes = {
  simultaneas: number;
  porDia: number;
  porContato: number;
};

export const LIMITES_PADRAO: LimitesLigacoes = {
  simultaneas: LIGACOES_SIMULTANEAS,
  porDia: LIGACOES_POR_DIA,
  porContato: LIGACOES_POR_CONTATO_24H,
};

/** As faixas aceitas (spec-ligacoes-tela 2.1; o banco confere as mesmas). */
export const FAIXAS_AGENTE = {
  nome: { min: 1, max: 60 },
  instrucoes: { min: 0, max: 4_000 },
  regrasEquipe: { min: 1, max: 2_000 },
  saudacao: { min: 1, max: 300 },
  duracaoMaxS: { min: 180, max: DURACAO_MAX_AGENTE_S },
  silencioS: { min: 10, max: 60 },
} as const;

export const FAIXAS_LIMITES = {
  simultaneas: { min: 1, max: 200 },
  porDia: { min: 1, max: 10_000 },
  porContato: { min: 1, max: 100 },
} as const;

// ---------- a ligação de saída  ----------

/** A permissão do lead na Meta para a empresa ligar. */
export type PermissaoDeLigar = "permanente" | "temporaria" | "nenhuma";

/**
 * Por que o botão "Ligar" não liga agora (null = liga):
 * - sem_ligacoes: as ligações não estão ativas na conta;
 * - sem_telefone: o contato não tem telefone conhecido;
 * - pedir: não há permissão, e dá para pedir agora (o lead está na janela de 24 h);
 * - aguardando_lead: o pedido foi enviado e o lead ainda não respondeu;
 * - recusou: o lead recusou o último pedido (só se pede de novo quando a Meta deixar);
 * - fora_da_janela: não há permissão, e o lead não falou nas últimas 24 h (por template, depois);
 * - limite_de_pedidos: a Meta não deixa pedir agora (1 a cada 24 h e 2 a cada 7 dias por lead);
 * - meta_nao_deixa: a Meta não deixa ligar agora por outro motivo (ex.: 4 ligações sem resposta);
 * - ligacao_em_andamento: já há uma ligação em andamento nesta conversa.
 */
export type MotivoNaoLiga =
  | "sem_ligacoes"
  | "sem_telefone"
  | "pedir"
  | "aguardando_lead"
  | "recusou"
  | "fora_da_janela"
  | "limite_de_pedidos"
  | "meta_nao_deixa"
  | "ligacao_em_andamento";

/** O que o botão "Ligar" de uma conversa mostra (permissaoDeLigar). */
export type EstadoPermissaoDeLigar = {
  permissao: PermissaoDeLigar;
  /** ISO 8601: quando a permissão temporária acaba (null = permanente ou nenhuma). */
  expiraEm: string | null;
  /** Dá para ligar agora. */
  podeLigar: boolean;
  /** Dá para pedir a permissão agora (dentro da janela e com o pedido liberado pela Meta). */
  podePedir: boolean;
  /** O lead mandou mensagem nas últimas 24 h. */
  dentroDaJanela: boolean;
  motivo: MotivoNaoLiga | null;
  /** O último pedido de permissão desta conversa (null = nunca pediu). */
  pedido: PedidoDePermissao | null;
  /**
   * ISO 8601: quando dá para pedir de novo, nos motivos "recusou" e "limite_de_pedidos" (o
   * limit_expiration_time da Meta, ou a conta pela regra de 1 a cada 24 h e 2 a cada 7 dias).
   * null = já dá, ou não se sabe.
   */
  pedirDeNovoEm: string | null;
};

/** Um pedido de permissão enviado ao lead, e a resposta dele (tabela ligacao_permissoes). */
export type PedidoDePermissao = {
  /** ISO 8601. */
  pedidoEm: string;
  /** null = ainda sem resposta. */
  resposta: "aceitou" | "recusou" | null;
  /** Aceitou para sempre (true) ou por 7 dias (false); null sem resposta. */
  permanente: boolean | null;
  /** ISO 8601. */
  respondidoEm: string | null;
};

export type ErroLigarSaida =
  | "sem_acesso"
  | "sem_ligacoes"
  | "sem_telefone"
  | "conversa_nao_encontrada"
  | "sem_permissao"
  | "fora_da_janela"
  | "limite_de_pedidos"
  | "ligacao_em_andamento"
  | "limite_por_contato"
  | "meta_token_invalido"
  | "provedor_fora"
  | "tempo_esgotado"
  | "erro_ao_gravar"
  | "erro_ao_ler"
  | "agente_indisponivel"
  | "objetivo_invalido"
  | "limite_da_conta";

export type FalhaLigarSaida = { ok: false; erro: ErroLigarSaida; mensagem: string };
export type ResultadoPermissaoDeLigar =
  { ok: true; estado: EstadoPermissaoDeLigar } | FalhaLigarSaida;
/** O pedido foi enviado: o estado novo (motivo "aguardando_lead"). */
export type ResultadoPedirPermissao =
  { ok: true; estado: EstadoPermissaoDeLigar } | FalhaLigarSaida;
/** A ligação saiu: a linha em `ligacoes` (direcao "saida") e a conversa da ElevenLabs. */
export type ResultadoLigarParaLead = { ok: true; ligacaoId: string } | FalhaLigarSaida;

// ---------------------------------------------------------------------------
// Ligar com um agente 
// ---------------------------------------------------------------------------

/** O tamanho máximo do objetivo da ligação (A3; o check ligacoes_objetivo do banco). */
export const MAX_OBJETIVO_LIGACAO = 500;

/**
 * Por que um agente não liga agora (A2): sem o agente na ElevenLabs (ainda não sincronizado).
 * null = pronto. A última sincronia em erro não impede (o agente lá liga com a configuração
 * anterior, e o Contexto atrasado vai nas variáveis): é só um aviso (AgenteParaLigar.desatualizado;
 * revisão do Opus no PR #26).
 */
export type AgenteIndisponivel = "nao_sincronizado";

/** Um agente na janela do "Ligar" (agentesParaLigar). Os Ativos vêm primeiro, depois por nome. */
export type AgenteParaLigar = {
  /** O id da linha de ligacao_agentes. */
  id: string;
  nome: string;
  uso: UsoAgente;
  objetivo: ObjetivoAgente;
  /** É o que atende as ligações do número. */
  atende: boolean;
  indisponivel: AgenteIndisponivel | null;
  /** A última atualização dele na ElevenLabs falhou: liga com a configuração anterior (aviso). */
  desatualizado: boolean;
};

export type ResultadoAgentesParaLigar = { ok: true; agentes: AgenteParaLigar[] } | FalhaLigarSaida;

/**
 * O pedido de ligar (ligarParaLead). Sem agenteId, liga com o agente que atende (A6). O objetivo é
 * opcional: vazio ou só espaços = sem objetivo; mais que MAX_OBJETIVO_LIGACAO = objetivo_invalido.
 */
export type PedidoDeLigar = { conversaId: string; agenteId?: string; objetivo?: string };
