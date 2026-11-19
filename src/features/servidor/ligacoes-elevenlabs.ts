// O que as ligações pelo WhatsApp criam e apagam na conta da ElevenLabs (// 2.5 e 2.6): o segredo do Bearer, o webhook pós-chamada (HMAC), a ferramenta "passar para a
// equipe", os agentes (um por agente de voz da Nina) e o tronco SIP.
// Lógica pura: monta os pedidos e traduz as respostas; quem
// orquestra (mensageria/configuracao/ligacoes.server.ts) injeta o fetch.
//
// Os corpos são os aceitos por API numa conta gratuita em 11/11/2026 (com leitura de volta e
// limpeza). Ainda sem conferência numa conta (L13, antes do merge): o PATCH do agente, o
// turn.silence_end_call_timeout e os modelos dos perfis "rapido" e "caprichado". Cabeçalho
// xi-api-key, sem Authorization. Erros:
// - 401 com detail.status de permissão (missing_permissions) ou 403 de permissão: a chave sem
//   ElevenLabs Agents ou Webhooks (chave_sem_acesso_agentes); outro 401: chave_invalida; quota:
//   sem crédito; outro 403: chave bloqueada (lista de IP);
// - 409 no tronco (phone_number_conflict): o número já está noutra conta (D16);
// - 404 no PATCH do agente: agente_nao_encontrado (apagado na ElevenLabs);
// - no apagar, 404 conta como já apagado (D17); a ferramenta vai com ?force=true (sem ele, a
//   ElevenLabs recusa com 409 enquanto o agente apagado ainda aparece como dependente).
// A chave, o token, o segredo HMAC e a senha SIP nunca aparecem no resultado: o pedir apaga o eco
// deles no corpo, e as mensagens são as fixas de ligacoes/mensagens.ts.

import { saudacaoDoAgente } from "@/features/mensageria/ligacoes/contexto";
import { msgLigacoes } from "@/features/mensageria/ligacoes/mensagens";
import {
  CABECALHO_SESSAO,
  DOMINIO_SIP_META,
  FERRAMENTA_EQUIPE,
  SIP_ELEVENLABS,
  VARIAVEL_SESSAO,
  VERSAO_AGENTE,
  type AgenteVoz,
  type AgenteVozPronto,
  type FalhaLigacoes,
  type LimitesLigacoes,
  type ObjetivoAgente,
  type PerfilAgente,
} from "@/features/mensageria/ligacoes/tipos";

import {
  abrirPrazo,
  FalhaDeRede,
  ler,
  lerTexto,
  pedir,
  TempoEsgotado,
  type OpcoesValidacao,
  type RespostaHttp,
} from "./http";

export const ELEVENLABS_API = "https://api.elevenlabs.io";
export const URL_SEGREDOS = `${ELEVENLABS_API}/v1/convai/secrets`;
export const URL_WEBHOOKS = `${ELEVENLABS_API}/v1/workspace/webhooks`;
export const URL_FERRAMENTAS = `${ELEVENLABS_API}/v1/convai/tools`;
export const URL_AGENTES = `${ELEVENLABS_API}/v1/convai/agents`;
export const URL_CRIAR_AGENTE = `${ELEVENLABS_API}/v1/convai/agents/create`;
export const URL_NUMEROS = `${ELEVENLABS_API}/v1/convai/phone-numbers`;
export const URL_LIGAR = `${ELEVENLABS_API}/v1/convai/sip-trunk/outbound-call`;

/** Tag dos agentes criados pelas ligações (spec 2.5). */
export const TAG_AGENTE = "nina-ligacoes";

/** Um id devolvido pela ElevenLabs, antes de entrar numa URL ou no banco. */
const ID_ELEVEN = /^[A-Za-z0-9_-]{1,128}$/;

export type Criado<T> = ({ ok: true } & T) | FalhaLigacoes;

// ---------- o agente (spec 2.5, L13 a L15) ----------

// A versão da configuração que o código monta (L13) mora em ligacoes/tipos.ts, que a tela também lê.
export { VERSAO_AGENTE };

/** Os modelos de um perfil. Sem ttsModel ou asrModel, fala e escuta ficam no padrão da ElevenLabs. */
export type ModelosDoPerfil = { llm: string; ttsModel?: string; asrModel?: string };

/**
 * Perfil → modelos (L6, L13). Os nomes saem da lista aceita pela API em 11/11/2026. Trocar um
 * modelo aqui pede subir VERSAO_AGENTE.
 */
export const PERFIS: Readonly<Record<PerfilAgente, ModelosDoPerfil>> = {
  recomendado: { llm: "gemini-3.5-flash" },
  rapido: { llm: "gemini-3.1-flash-lite" },
  caprichado: { llm: "claude-sonnet-4-6" },
};

/**
 * Abertura e regras de voz, iguais em todos os agentes. Prompt padrão, para qualquer empresa (o que
 * é do negócio vem do Contexto e das instruções do agente). As regras de fala vêm do que as
 * ligações reais da Nina vitrine mostraram (13 a 16/11/2026), reescritas sem o roteiro de lá
 * (seção 8).
 */
const PROMPT_ABERTURA = `Você é a Nina, a atendente desta empresa, numa ligação de voz pelo WhatsApp com um lead.

Esta é uma ligação
- Você já está falando com a pessoa por voz, ao vivo. O contexto da empresa, mais abaixo, foi escrito para o atendimento por mensagem no WhatsApp: siga o que ele diz sobre a empresa e o jeito de atender, adaptado para a ligação.
- Enquanto vocês falam, nunca convide a pessoa a te ligar nem a te mandar um áudio: vocês já estão se falando por voz. Ignore o que o contexto da empresa disser sobre convidar para ligar ou para mandar áudio. A única exceção é o fim do tempo da ligação (abaixo).
- O que o contexto da empresa chama de bolha, mensagem, emoji ou "manda aqui" vira fala. O que precisar ir por escrito segue a regra do que vai por escrito, logo abaixo.
- Durante a ligação você não manda nada no chat: nem link, nem imagem, nem arquivo. O que precisar ir por escrito (um link, um endereço, um horário, uma lista, um material), você mesma manda por mensagem neste WhatsApp assim que a ligação terminar. Diga isso numa frase ("te mando o link por mensagem aqui assim que a gente desligar") e siga a conversa. Nunca diga que já mandou. Se o que você sabe sobre a pessoa disser que a conversa já está com a equipe, diga que a equipe manda por mensagem, e não você.
- Fale sempre em português do Brasil, do começo ao fim, inclusive na despedida. Nada de palavras ou expressões em inglês.

Como falar
- Fale com frases curtas e naturais, como numa conversa por telefone.
- Fale pouco de cada vez: no máximo 2 frases curtas (uns 10 segundos) e depois pare e devolva a palavra. Nunca dê dois exemplos nem duas ofertas de uma vez. Se a pessoa quiser saber mais, ela pede.
- No máximo uma pergunta por fala, no fim dela, e espere a resposta.
- Antes de perguntar algo, veja se a pessoa já respondeu nesta ligação ou no que você sabe sobre ela; se já, use a resposta.
- Não repita o que já foi dito nem o pedido inteiro a cada fala: confirme só o que acabou de mudar.
- Quando a pessoa pedir ou aceitar algo, siga na hora: não pergunte de novo se ela quer nem peça para confirmar o que ela acabou de dizer.
- O que você recebe da pessoa é uma transcrição e pode vir errada. Se uma fala não combina com o assunto (uma palavra solta, uma resposta que não encaixa na pergunta), não aceite nem construa em cima: diga o que ouviu numa pergunta curta ("amanhã à noite? não peguei") e espere.
- Tudo o que você escreve vira voz: a pessoa ouve cada palavra. Nunca escreva o que está pensando, decidindo ou conferindo, nem fale da pessoa na terceira pessoa.
- Ferramentas, como end_call e ${FERRAMENTA_EQUIPE}, você chama: nunca diga nem escreva o nome delas, e nunca explique como você funciona por dentro (ferramenta, sistema, transcrição, demora).
- Seu tom acompanha o da pessoa: animada quando ela está animada, tranquila quando ela está séria, acolhedora quando ela está chateada ou conta algo ruim.
- Quando você errar, ou a pessoa apontar algo que não ficou como ela queria, corrija na hora com leveza, sem lamentar ("boa, à tarde então").
- Não leia listas, links, e-mails nem endereços em voz alta: eles vão por escrito, depois da ligação. Você não vê o chat durante a ligação: o que é ruim de entender por voz, como um e-mail ou um nome soletrado, peça para a pessoa soletrar devagar, ou para mandar por escrito aqui no WhatsApp, que você (ou a equipe, se a conversa já está com ela) responde por mensagem depois da ligação. Nunca diga que recebeu o que ela escreveu.
- Não invente preço, prazo, condição nem nenhuma informação que não esteja no contexto da empresa. Diga os valores do contexto como estão, sem fazer conta de cabeça. Se não souber, diga que vai confirmar com a equipe.`;

const OBJETIVO_NO_PROMPT: Readonly<Record<ObjetivoAgente, string>> = {
  vendas:
    "Seu objetivo nesta ligação é vender: entenda o que a pessoa precisa, tire as dúvidas com o que está no contexto da empresa e conduza para o próximo passo da compra.",
  suporte:
    "Seu objetivo nesta ligação é dar suporte: entenda a dúvida ou o problema da pessoa e ajude a resolver com o que está no contexto da empresa.",
  outro: "Atenda a pessoa com o que está no contexto da empresa.",
};

/**
 * Encerrar, silêncio e o tempo da ligação (L15, seção 8): o silêncio longo
 * encerra sozinho (turn.silence_end_call_timeout), e o tempo máximo vem no fim do prompt
 * (tempoDaLigacao).
 */
const PROMPT_ENCERRAR = `Encerrar
- Se o contexto atualizado (mais abaixo) disser que esta ligação não continua, siga ele: despeça-se e use end_call na hora, sem atender. Fora isso, encerre só quando a pessoa se despedir com clareza ("tchau", "valeu, era isso", "pode encerrar"). Aí, se você combinou mandar algo por escrito, lembre numa frase que vai chegar por mensagem aqui no WhatsApp; despeça-se numa frase curta, diga "pode desligar aí" e use end_call junto com o tchau.
- Um "tchau" solto no meio de um assunto pode ser outra palavra mal transcrita: pergunte numa frase curta se ela quer parar por aqui e só encerre com um sim.
- Se a fala chegar vazia ("...") ou você não entender, diga leve "não peguei, pode repetir?".
- Se a pessoa ficar em silêncio, pergunte uma vez se ela ainda está aí e espere a resposta. Não desligue por causa do silêncio: se ela não voltar, a ligação se encerra sozinha.
- A ligação tem um tempo máximo (no fim, em tempo_da_ligacao). Você não sabe quanto tempo já passou: não fale do tempo da ligação por conta própria. Se o tempo acabar, a ligação se despede sozinha, e a pessoa pode te ligar de novo ou seguir por mensagem aqui.`;

/**
 * As variáveis de cada ligação (D9): o lead e o Contexto atualizado. O Contexto inteiro vai fixo no
 * prompt (promptDoAgente, L14); o início só manda o nina_contexto quando o agente está atrás da
 * versão mais recente, e então ele vale no lugar do fixo.
 */
const PROMPT_VARIAVEIS = `<sobre_o_lead>
{{nina_lead}}
</sobre_o_lead>

<contexto_atualizado>
{{nina_contexto}}
</contexto_atualizado>
Quando <contexto_atualizado> vier preenchido, ele é a versão mais nova do contexto da empresa e vale no lugar de <contexto_da_empresa>, logo abaixo.`;

/** O Contexto que vai fixo no prompt, quando ainda não há nenhum. */
export const CONTEXTO_VAZIO = "(o contexto da empresa ainda não foi preenchido)";

/**
 * O limite do prompt de sistema na ElevenLabs: 2 MB, contando as instruções e o que mais vai junto
 * (documentação de Agents, "Choosing a model", conferida em 12/11/2026). O prompt maior não é
 * cortado: a sincronia falha com prompt_grande.
 */
export const MAX_PROMPT_BYTES = 2_000_000;

/** Texto do admin no prompt: sem "{{" nem "}}", que a ElevenLabs leria como variável. */
function textoDoAdmin(texto: string): string {
  return texto.trim().replace(/\{+/g, "{").replace(/\}+/g, "}");
}

function promptDaEquipe(regrasEquipe: string | null): string {
  const regras = regrasEquipe === null ? "" : textoDoAdmin(regrasEquipe);
  const depois =
    "- Depois de usar a ferramenta, avise que a equipe continua o atendimento por mensagem neste WhatsApp.";
  if (!regras) {
    return `Passar para a equipe
- Use a ferramenta ${FERRAMENTA_EQUIPE} quando a pessoa pedir para falar com alguém da equipe, ou nos casos que a parte "Quando passar para humano" do contexto da empresa descreve.
${depois}`;
  }
  return `Passar para a equipe
- Use a ferramenta ${FERRAMENTA_EQUIPE} quando a pessoa pedir para falar com alguém da equipe, ou nos casos das regras abaixo. Elas valem no lugar da parte "Quando passar para humano" do contexto da empresa.
${depois}

<regras_para_passar_para_a_equipe>
${regras}
</regras_para_passar_para_a_equipe>`;
}

/**
 * O prompt do agente (L14): as regras fixas de voz, o objetivo e as instruções do agente, as
 * regras de equipe (as próprias ou as do Contexto), o encerrar e as variáveis que chegam a cada
 * ligação (D9). Puro.
 */
export function montarPromptLigacao(
  agente: Pick<AgenteVoz, "objetivo" | "instrucoes" | "regrasEquipe">,
): string {
  const instrucoes = textoDoAdmin(agente.instrucoes);
  const papel = [`Seu papel\n${OBJETIVO_NO_PROMPT[agente.objetivo]}`];
  if (instrucoes)
    papel.push(`<instrucoes_deste_atendimento>\n${instrucoes}\n</instrucoes_deste_atendimento>`);
  return [
    PROMPT_ABERTURA,
    papel.join("\n\n"),
    promptDaEquipe(agente.regrasEquipe),
    PROMPT_ENCERRAR,
    PROMPT_VARIAVEIS,
  ].join("\n\n");
}

/**
 * O prompt que vai para a ElevenLabs (L14): o de montarPromptLigacao e, no fim, o Contexto inteiro
 * (textoDoContexto, sem corte), que só muda numa sincronia. Puro.
 */
export function promptDoAgente(
  agente: Pick<AgenteVoz, "objetivo" | "instrucoes" | "regrasEquipe" | "duracaoMaxS">,
  contexto: string,
): string {
  const fixo = textoDoAdmin(contexto) || CONTEXTO_VAZIO;
  return (
    `${montarPromptLigacao(agente)}\n\n<contexto_da_empresa>\n${fixo}\n</contexto_da_empresa>` +
    `\n\n${tempoDaLigacao(agente.duracaoMaxS)}`
  );
}

/**
 * O tempo da ligação (seção 22): só o máximo, fixo. Nada no prompt pode
 * mudar a cada vez de falar: o prompt inteiro é uma parte só do cache do LLM, e uma variável que
 * muda (como {{system__call_duration_secs}}, que estava aqui) zera o cache em toda fala. Medido
 * em 18/11/2026: o LLM da ligação ficou 12 a 16 vezes mais caro. O fim da ligação é avisado pela
 * mensagem de tempo máximo da ElevenLabs. Puro.
 */
export function tempoDaLigacao(duracaoMaxS: number): string {
  const max = Math.max(60, Math.round(duracaoMaxS));
  const minutos = Math.max(1, Math.round(max / 60));
  return `<tempo_da_ligacao>
O máximo desta ligação é de ${minutos} ${minutos === 1 ? "minuto" : "minutos"}.
</tempo_da_ligacao>`;
}

/** O prompt da configuração cabe no limite da ElevenLabs (MAX_PROMPT_BYTES, em UTF-8). */
export function promptCabe(config: ConfigAgente): boolean {
  return (
    new TextEncoder().encode(config.conversation_config.agent.prompt.prompt).byteLength <=
    MAX_PROMPT_BYTES
  );
}

/** Nome do tronco, do segredo e do webhook: os 8 primeiros caracteres do id da conexão (spec 2.5). */
export function nomeDosRecursos(conexaoId: string): string {
  return `Nina (ligações) ${conexaoId.slice(0, 8)}`;
}

/** Nome do agente na ElevenLabs: o dos recursos e o nome do agente na Nina. */
export function nomeDoAgente(conexaoId: string, nome: string): string {
  const limpo = nome.replace(/\s+/g, " ").trim();
  return limpo ? `${nomeDosRecursos(conexaoId)} · ${limpo}` : nomeDosRecursos(conexaoId);
}

/** O que todos os agentes da conexão compartilham (L12): criados uma vez, na ativação. */
export type RecursosDoAgente = {
  conexaoId: string;
  /** a URL do webhook de início (urlDaLigacao(origem, conexão, "inicio")) */
  urlInicio: string;
  segredoId: string;
  webhookId: string;
  ferramentaId: string;
};

export type DadosAgente = {
  /** A voz já decidida: a do agente ou, sem ela, a do cartão Voz (quem chama decide). */
  agente: AgenteVozPronto;
  limites: LimitesLigacoes;
  recursos: RecursosDoAgente;
  /** O Contexto atual em texto (textoDoContexto), inteiro: vai fixo no prompt (L14). */
  contexto: string;
};

/** O corpo do POST /v1/convai/agents/create e do PATCH /v1/convai/agents/<id>. Puro. */
export function montarConfigAgente(d: DadosAgente) {
  const { agente, limites, recursos } = d;
  const modelos = PERFIS[agente.perfil];
  return {
    name: nomeDoAgente(recursos.conexaoId, agente.nome),
    tags: [TAG_AGENTE],
    conversation_config: {
      agent: {
        language: "pt",
        first_message: "{{nina_saudacao}}",
        max_conversation_duration_message:
          "Estamos chegando ao fim desta ligação. Podemos continuar por mensagem neste WhatsApp.",
        dynamic_variables: {
          dynamic_variable_placeholders: {
            // se o início não responder, a saudação do agente sem o nome
            nina_saudacao: saudacaoDoAgente(agente.saudacao, null),
            nina_contexto: "",
            nina_lead: "",
          },
        },
        prompt: {
          prompt: promptDoAgente(agente, d.contexto),
          llm: modelos.llm,
          temperature: 0.3,
          max_tokens: 600,
          timezone: "America/Sao_Paulo",
          tool_ids: [recursos.ferramentaId],
          built_in_tools: {
            end_call: {
              type: "system",
              name: "end_call",
              description:
                "Encerre a ligação junto com a despedida. Não use por causa de silêncio: se a pessoa não responder, a ligação se encerra sozinha.",
              params: { system_tool_type: "end_call" },
            },
          },
        },
      },
      // sem model_id, fala e escuta no padrão da ElevenLabs (L13)
      tts: {
        voice_id: agente.vozId,
        ...(modelos.ttsModel ? { model_id: modelos.ttsModel } : {}),
      },
      ...(modelos.asrModel ? { asr: { provider: modelos.asrModel } } : {}),
      // o silêncio longo encerra a ligação (L15)
      turn: { silence_end_call_timeout: agente.silencioS },
      conversation: { max_duration_seconds: agente.duracaoMaxS },
    },
    platform_settings: {
      summary_language: "pt",
      auth: {
        enable_auth: true,
        allowlist: [],
        require_origin_header: false,
        shareable_token: null,
      },
      // o limite por contato não vai ao agente: o início confere (L19)
      call_limits: {
        agent_concurrency_limit: limites.simultaneas,
        daily_limit: limites.porDia,
        bursting_enabled: false,
      },
      // retenção no padrão (sem retenção zero): com ela, a transcrição pode não chegar (D8)
      privacy: { record_voice: false },
      overrides: { enable_conversation_initiation_client_data_from_webhook: true },
      workspace_overrides: {
        conversation_initiation_client_data_webhook: {
          url: recursos.urlInicio,
          request_headers: { Authorization: { secret_id: recursos.segredoId } },
        },
        webhooks: {
          post_call_webhook_id: recursos.webhookId,
          events: ["transcript", "call_initiation_failure"],
          send_audio: false,
        },
      },
    },
  };
}

export type ConfigAgente = ReturnType<typeof montarConfigAgente>;

/** O corpo do POST /v1/convai/tools: a ferramenta webhook "passar para a equipe" (D10). */
export function montarFerramentaEquipe(d: { urlEquipe: string; segredoId: string }) {
  return {
    tool_config: {
      type: "webhook",
      name: FERRAMENTA_EQUIPE,
      description:
        "Passa o atendimento para a equipe humana. Use quando a pessoa pedir para falar com alguém da equipe, ou quando o contexto da empresa mandar passar para uma pessoa. A equipe continua por mensagem neste WhatsApp.",
      response_timeout_secs: 10,
      pre_tool_speech: "off",
      execution_mode: "immediate",
      tool_error_handling_mode: "hide",
      follow_redirects: false,
      api_schema: {
        url: d.urlEquipe,
        method: "POST",
        request_headers: {
          Authorization: { secret_id: d.segredoId },
          [CABECALHO_SESSAO]: { variable_name: VARIAVEL_SESSAO },
        },
        request_body_schema: { type: "object", properties: {}, required: [] },
      },
    },
  };
}

/** O corpo do POST /v1/convai/phone-numbers: o tronco SIP só de entrada (spec 2.6, passo 4). */
export function montarTronco(d: { conexaoId: string; numero: string; senha: string }) {
  const digitos = d.numero.replace(/\D/g, "");
  return {
    phone_number: `+${digitos}`,
    label: nomeDosRecursos(d.conexaoId),
    provider: "sip_trunk",
    supports_inbound: true,
    supports_outbound: false,
    inbound_trunk_config: {
      media_encryption: "required",
      credentials: { username: digitos, password: d.senha },
      remote_domains: [DOMINIO_SIP_META],
      attributes_to_headers: {},
    },
    outbound_trunk_config: null,
  };
}

// ---------- tradução das respostas ----------

function statusDoDetalhe(corpo: unknown): string {
  return (lerTexto(corpo, "detail", "status") ?? "").toLowerCase();
}

/** 2xx dá null; o resto vira a falha fixa (tabela no topo do arquivo). */
export function falhaEleven(r: RespostaHttp): FalhaLigacoes | null {
  if (r.status >= 200 && r.status < 300) return null;
  const detalhe = statusDoDetalhe(r.corpo);
  if (r.status === 401) {
    if (detalhe.includes("permission")) return msgLigacoes.chaveSemAcessoAgentes();
    if (detalhe.includes("quota")) return msgLigacoes.semCredito();
    return msgLigacoes.chaveInvalida();
  }
  if (r.status === 403) {
    return detalhe.includes("permission")
      ? msgLigacoes.chaveSemAcessoAgentes()
      : msgLigacoes.chaveBloqueada();
  }
  if (r.status === 429) return msgLigacoes.elevenMuitas();
  return msgLigacoes.elevenFora();
}

function falhaDoErroEleven(e: unknown): FalhaLigacoes {
  if (e instanceof TempoEsgotado) return msgLigacoes.elevenTempo();
  if (e instanceof FalhaDeRede) return msgLigacoes.elevenSemRede();
  return msgLigacoes.elevenFora();
}

type Pedido = { url: string; metodo: "GET" | "POST" | "PATCH" | "DELETE"; corpo?: unknown };

/** Um pedido à ElevenLabs no seu próprio prazo. Lança só TempoEsgotado ou FalhaDeRede. */
async function chamar(
  chave: string,
  p: Pedido,
  opcoes: OpcoesValidacao | undefined,
  segredos: readonly string[],
): Promise<RespostaHttp> {
  const prazo = abrirPrazo(opcoes?.prazoMs);
  try {
    const headers: Record<string, string> = { "xi-api-key": chave.trim() };
    if (p.corpo !== undefined) headers["Content-Type"] = "application/json";
    return await pedir(
      opcoes,
      prazo,
      p.url,
      {
        method: p.metodo,
        headers,
        ...(p.corpo !== undefined ? { body: JSON.stringify(p.corpo) } : {}),
      },
      [chave, ...segredos],
    );
  } finally {
    prazo.encerrar();
  }
}

/** Cria um recurso e lê o id do campo `campo`. Sem id válido, a ElevenLabs "não respondeu como esperado". */
async function criar(
  chave: string,
  p: Pedido,
  campo: string,
  opcoes: OpcoesValidacao | undefined,
  segredos: readonly string[],
  traduzir: (r: RespostaHttp) => FalhaLigacoes | null = falhaEleven,
): Promise<{ ok: true; id: string; corpo: unknown } | FalhaLigacoes> {
  try {
    const r = await chamar(chave, p, opcoes, segredos);
    const falha = traduzir(r);
    if (falha) return falha;
    const id = lerTexto(r.corpo, campo);
    if (!id || !ID_ELEVEN.test(id)) return msgLigacoes.elevenFora();
    return { ok: true, id, corpo: r.corpo };
  } catch (e) {
    return falhaDoErroEleven(e);
  }
}

// ---------- criar ----------

/**
 * Conferência barata (grátis, só leitura) de que a chave enxerga os agentes, antes de criar
 * qualquer coisa: GET /v1/convai/agents?page_size=1. null = enxerga. A escrita só se confere
 * criando (o segredo, logo em seguida).
 */
export async function conferirAcessoAgentes(
  chave: string,
  opcoes?: OpcoesValidacao,
): Promise<FalhaLigacoes | null> {
  try {
    const r = await chamar(chave, { url: `${URL_AGENTES}?page_size=1`, metodo: "GET" }, opcoes, []);
    return falhaEleven(r);
  } catch (e) {
    return falhaDoErroEleven(e);
  }
}

/** O segredo que a ElevenLabs manda no Authorization do início e da ferramenta: "Bearer <token>". */
export async function criarSegredo(
  chave: string,
  d: { conexaoId: string; token: string },
  opcoes?: OpcoesValidacao,
): Promise<Criado<{ segredoId: string }>> {
  const r = await criar(
    chave,
    {
      url: URL_SEGREDOS,
      metodo: "POST",
      corpo: {
        type: "new",
        name: `${nomeDosRecursos(d.conexaoId)} token`,
        value: `Bearer ${d.token}`,
      },
    },
    "secret_id",
    opcoes,
    [d.token],
  );
  return r.ok ? { ok: true, segredoId: r.id } : r;
}

/**
 * O webhook do workspace para o pós-chamada, assinado com HMAC. A ElevenLabs devolve o segredo
 * só na criação: hmac null = criou, mas sem o segredo (quem chama apaga o webhook).
 */
export async function criarWebhookPosChamada(
  chave: string,
  d: { conexaoId: string; url: string },
  opcoes?: OpcoesValidacao,
): Promise<Criado<{ webhookId: string; hmac: string | null }>> {
  const r = await criar(
    chave,
    {
      url: URL_WEBHOOKS,
      metodo: "POST",
      corpo: {
        settings: {
          auth_type: "hmac",
          name: `${nomeDosRecursos(d.conexaoId)} pós-chamada`,
          webhook_url: d.url,
        },
      },
    },
    "webhook_id",
    opcoes,
    [],
  );
  if (!r.ok) return r;
  const hmac = lerTexto(r.corpo, "webhook_secret");
  return { ok: true, webhookId: r.id, hmac: hmac && hmac.trim() ? hmac : null };
}

export async function criarFerramentaEquipe(
  chave: string,
  d: { urlEquipe: string; segredoId: string },
  opcoes?: OpcoesValidacao,
): Promise<Criado<{ ferramentaId: string }>> {
  const r = await criar(
    chave,
    { url: URL_FERRAMENTAS, metodo: "POST", corpo: montarFerramentaEquipe(d) },
    "id",
    opcoes,
    [],
  );
  return r.ok ? { ok: true, ferramentaId: r.id } : r;
}

export async function criarAgente(
  chave: string,
  d: DadosAgente,
  opcoes?: OpcoesValidacao,
): Promise<Criado<{ agenteId: string }>> {
  const config = montarConfigAgente(d);
  // o prompt grande demais não vai à rede (a ElevenLabs recusaria)
  if (!promptCabe(config)) return msgLigacoes.promptGrande();
  const r = await criar(
    chave,
    { url: URL_CRIAR_AGENTE, metodo: "POST", corpo: config },
    "agent_id",
    opcoes,
    [],
  );
  return r.ok ? { ok: true, agenteId: r.id } : r;
}

/** 404 no agente: ele foi apagado na conta da ElevenLabs. */
function falhaDoAgente(r: RespostaHttp): FalhaLigacoes | null {
  if (r.status === 404) return msgLigacoes.agenteNaoEncontrado();
  return falhaEleven(r);
}

/**
 * Atualiza um agente já criado (L10, L13): PATCH /v1/convai/agents/<id> com a configuração
 * montada. null = atualizou. 404 (ou um id fora do formato, sem ir à rede) dá
 * agente_nao_encontrado; o prompt acima do limite, prompt_grande (sem ir à rede); o resto, as
 * falhas do criar. Nunca lança.
 */
export async function atualizarAgente(
  chave: string,
  idExterno: string,
  config: ConfigAgente,
  opcoes?: OpcoesValidacao,
): Promise<FalhaLigacoes | null> {
  if (!ID_ELEVEN.test(idExterno)) return msgLigacoes.agenteNaoEncontrado();
  if (!promptCabe(config)) return msgLigacoes.promptGrande();
  try {
    const r = await chamar(
      chave,
      { url: `${URL_AGENTES}/${encodeURIComponent(idExterno)}`, metodo: "PATCH", corpo: config },
      opcoes,
      [],
    );
    return falhaDoAgente(r);
  } catch (e) {
    return falhaDoErroEleven(e);
  }
}

/** 409 no tronco: o número já está cadastrado noutra conta da ElevenLabs (D16). */
function falhaDoTronco(r: RespostaHttp): FalhaLigacoes | null {
  if (r.status === 409) return msgLigacoes.numeroEmOutraConta();
  return falhaEleven(r);
}

/** O tronco SIP com a senha que a Meta gerou (só em memória: nunca no banco nem no resultado). */
export async function criarTronco(
  chave: string,
  d: { conexaoId: string; numero: string; senha: string },
  opcoes?: OpcoesValidacao,
): Promise<Criado<{ troncoId: string }>> {
  const r = await criar(
    chave,
    { url: URL_NUMEROS, metodo: "POST", corpo: montarTronco(d) },
    "phone_number_id",
    opcoes,
    [d.senha],
    falhaDoTronco,
  );
  return r.ok ? { ok: true, troncoId: r.id } : r;
}

/**
 * Os dois PATCH do tronco, nesta ordem: sem guardar as mensagens SIP (a criação não aceita o
 * campo) e depois ligado ao agente. null = os dois deram certo.
 */
export async function ligarTroncoAoAgente(
  chave: string,
  troncoId: string,
  agenteId: string,
  opcoes?: OpcoesValidacao,
): Promise<FalhaLigacoes | null> {
  const url = `${URL_NUMEROS}/${encodeURIComponent(troncoId)}`;
  try {
    const sip = await chamar(
      chave,
      { url, metodo: "PATCH", corpo: { store_sip_messages: false } },
      opcoes,
      [],
    );
    const falhaSip = falhaEleven(sip);
    if (falhaSip) return falhaSip;
    const agente = await chamar(
      chave,
      { url, metodo: "PATCH", corpo: { agent_id: agenteId } },
      opcoes,
      [],
    );
    return falhaEleven(agente);
  } catch (e) {
    return falhaDoErroEleven(e);
  }
}

/**
 * Troca o agente que atende o número (L11): PATCH do tronco com o agente novo. null = trocou; 404
 * no tronco é agente_nao_encontrado (o número saiu da conta). Nunca lança.
 */
export async function apontarTronco(
  chave: string,
  troncoId: string,
  agenteId: string,
  opcoes?: OpcoesValidacao,
): Promise<FalhaLigacoes | null> {
  if (!ID_ELEVEN.test(troncoId) || !ID_ELEVEN.test(agenteId)) return msgLigacoes.elevenFora();
  try {
    const r = await chamar(
      chave,
      {
        url: `${URL_NUMEROS}/${encodeURIComponent(troncoId)}`,
        metodo: "PATCH",
        corpo: { agent_id: agenteId },
      },
      opcoes,
      [],
    );
    return falhaDoAgente(r);
  } catch (e) {
    return falhaDoErroEleven(e);
  }
}

// ---------- apagar (D17) ----------

export type RecursoEleven = "tronco" | "agente" | "ferramenta" | "webhook" | "segredo";

/** A ordem de apagar (D17): tronco, agente, ferramenta, webhook e por último o segredo. */
export const ORDEM_APAGAR: readonly RecursoEleven[] = [
  "tronco",
  "agente",
  "ferramenta",
  "webhook",
  "segredo",
];

export function urlDeApagar(recurso: RecursoEleven, id: string): string {
  const alvo = encodeURIComponent(id);
  switch (recurso) {
    case "tronco":
      return `${URL_NUMEROS}/${alvo}`;
    case "agente":
      return `${URL_AGENTES}/${alvo}`;
    case "ferramenta":
      return `${URL_FERRAMENTAS}/${alvo}?force=true`;
    case "webhook":
      return `${URL_WEBHOOKS}/${alvo}`;
    case "segredo":
      return `${URL_SEGREDOS}/${alvo}`;
  }
}

/**
 * O fim de um apagar: "saiu" (2xx, ou 404: já não existia), "ficou" (qualquer outra falha, que um
 * novo pedido pode resolver) ou "chave_recusada" (401: a chave foi revogada ou perdeu o acesso, e
 * o app não alcança mais a conta; D30).
 */
export type FimDoApagar = "saiu" | "ficou" | "chave_recusada";

/** Apaga um recurso. Nunca lança. */
export async function apagarRecursoEleven(
  chave: string,
  recurso: RecursoEleven,
  id: string,
  opcoes?: OpcoesValidacao,
): Promise<FimDoApagar> {
  try {
    const r = await chamar(chave, { url: urlDeApagar(recurso, id), metodo: "DELETE" }, opcoes, []);
    if ((r.status >= 200 && r.status < 300) || r.status === 404) return "saiu";
    return r.status === 401 ? "chave_recusada" : "ficou";
  } catch {
    return "ficou";
  }
}

// ---------- a chave enxerga o agente (D29) ----------

/**
 * A chave lê o agente das ligações (GET /v1/convai/agents/<id> com 200): é da mesma conta da chave
 * que o criou (D29). Qualquer outra resposta, rede ou tempo dá false. Nunca lança.
 */
export async function chaveLeAgente(
  chave: string,
  agenteId: string,
  opcoes?: OpcoesValidacao,
): Promise<boolean> {
  if (!chave.trim() || !ID_ELEVEN.test(agenteId)) return false;
  try {
    const r = await chamar(
      chave,
      { url: `${URL_AGENTES}/${encodeURIComponent(agenteId)}`, metodo: "GET" },
      opcoes,
      [],
    );
    return r.status === 200;
  } catch {
    return false;
  }
}

// ---------- a ligação de saída (seções 1 e 4) ----------

/**
 * A saída do tronco, como funcionou na vitrine em 17/11/2026: direto na Meta, com as mesmas
 * credenciais da entrada e o domínio do From da ElevenLabs (custom_from_domain), sem proxy.
 */
export function montarSaidaDoTronco(d: { numero: string; senha: string }) {
  const digitos = d.numero.replace(/\D/g, "");
  return {
    outbound_trunk_config: {
      address: DOMINIO_SIP_META,
      transport: "tls",
      media_encryption: "required",
      credentials: { username: digitos, password: d.senha },
      custom_from_domain: SIP_ELEVENLABS.hostname,
    },
  };
}

/** Liga a saída no tronco (PATCH). null = deu certo. A senha só vai no corpo. */
export async function ligarSaidaDoTronco(
  chave: string,
  troncoId: string,
  d: { numero: string; senha: string },
  opcoes?: OpcoesValidacao,
): Promise<FalhaLigacoes | null> {
  if (!ID_ELEVEN.test(troncoId)) return msgLigacoes.elevenFora();
  try {
    const r = await chamar(
      chave,
      {
        url: `${URL_NUMEROS}/${encodeURIComponent(troncoId)}`,
        metodo: "PATCH",
        corpo: montarSaidaDoTronco(d),
      },
      opcoes,
      [d.senha],
    );
    return falhaEleven(r);
  } catch (e) {
    return falhaDoErroEleven(e);
  }
}

/**
 * Pede à ElevenLabs que ligue para `para` (só dígitos) pelo tronco, com o agente e as variáveis
 * da conversa (ela não chama o webhook de início na saída). Devolve o id da conversa dela. Na
 * falha, `incerto` diz se a ligação pode ter saído mesmo assim (tempo esgotado, rede ou 5xx): aí
 * quem chama não fecha a ligação, que o pós-chamada ou as presas resolvem (Sol, PR #24).
 */
export async function ligarPeloTronco(
  chave: string,
  d: { agenteId: string; troncoId: string; para: string; variaveis: Record<string, string> },
  opcoes?: OpcoesValidacao,
): Promise<{ ok: true; conversaEleven: string } | (FalhaLigacoes & { incerto: boolean })> {
  if (!ID_ELEVEN.test(d.agenteId) || !ID_ELEVEN.test(d.troncoId) || !/^\d{8,15}$/.test(d.para)) {
    return { ...msgLigacoes.elevenFora(), incerto: false };
  }
  const segredos = Object.entries(d.variaveis)
    .filter(([k]) => k.startsWith("secret__"))
    .map(([, v]) => v);
  try {
    const r = await chamar(
      chave,
      {
        url: URL_LIGAR,
        metodo: "POST",
        corpo: {
          agent_id: d.agenteId,
          agent_phone_number_id: d.troncoId,
          to_number: `+${d.para}`,
          conversation_initiation_client_data: { dynamic_variables: d.variaveis },
        },
      },
      opcoes,
      segredos,
    );
    const falha = falhaEleven(r);
    if (falha) return { ...falha, incerto: r.status >= 500 };
    const conversa = lerTexto(r.corpo, "conversation_id");
    if (ler(r.corpo, "success") === false) return { ...msgLigacoes.elevenFora(), incerto: false };
    // 2xx sem o id da conversa: pode ter saído, sem como saber qual
    if (!conversa || !ID_ELEVEN.test(conversa))
      return { ...msgLigacoes.elevenFora(), incerto: true };
    return { ok: true, conversaEleven: conversa };
  } catch (e) {
    return { ...falhaDoErroEleven(e), incerto: true };
  }
}
