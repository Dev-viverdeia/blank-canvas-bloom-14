// As mensagens fixas das ligações na Configuração (2.6), em pt-BR. Nenhuma
// cita valor de chave, token, segredo ou senha, nem texto vindo do provedor. A primeira frase vira
// o título do aviso na tela.
import type { ErroLigacoes, FalhaLigacoes } from "./tipos";

/**
 * A chave da ElevenLabs presa enquanto houver ligações (D22): o agente e o número ficam na conta
 * desta chave. Vai na falha `ligacoes_ativas` do salvar, do remover e do copiar a chave da voz.
 */
export const MENSAGEM_CHAVE_PRESA =
  "Desative as ligações no cartão Ligações (e resolva as pendências, se houver) antes de trocar ou remover a chave da ElevenLabs: o agente e o número das ligações ficam na conta desta chave.";

/**
 * A troca da chave da voz com ligações (D29): só passa uma chave da mesma conta da ElevenLabs, a
 * que lê o agente das ligações. Vai na falha `ligacoes_ativas` do salvar a chave da voz.
 */
export const MENSAGEM_CHAVE_OUTRA_CONTA =
  "Com as ligações ativas, a chave nova da ElevenLabs tem de ser da mesma conta da chave atual, onde ficam o agente e o número das ligações. Use uma chave dessa conta, ou desative as ligações antes de trocar de conta.";

/** A recusa da Meta ao ligar as chamadas (spec 2.6): a demo da Configuração simula a mesma. */
export const MENSAGEM_META_RECUSOU =
  "A Meta não liberou as ligações neste número. Confira se a empresa está verificada (limite de 2.000 conversas por dia) e se o app da Meta está em modo Live. Números de teste da Meta funcionam sem o limite.";

export function falhaLigacoes(erro: ErroLigacoes, mensagem: string): FalhaLigacoes {
  return { ok: false, erro, mensagem };
}

export const msgLigacoes = {
  semAcesso: () => falhaLigacoes("sem_acesso", "Só um admin pode ativar ou desativar as ligações."),
  semConexaoMeta: () =>
    falhaLigacoes(
      "sem_conexao_meta",
      "As ligações precisam do WhatsApp oficial da Meta conectado. Conecte o número pela Meta no cartão WhatsApp e tente de novo.",
    ),
  semChaveVoz: () =>
    falhaLigacoes(
      "sem_chave_voz",
      "Cadastre a chave da ElevenLabs no cartão Voz antes de ativar as ligações.",
    ),
  semVoz: () =>
    falhaLigacoes("sem_voz", "Escolha a voz da Nina no cartão Voz antes de ativar as ligações."),
  enderecoDePrevia: () =>
    falhaLigacoes(
      "endereco_de_previa",
      "Abra a Nina pelo endereço publicado para ativar as ligações. A prévia muda de endereço e a ElevenLabs não a alcança.",
    ),
  jaAtiva: () =>
    falhaLigacoes(
      "ja_ativa",
      "As ligações já estão ativas neste número, ou a ativação já começou. Atualize a página para ver o estado.",
    ),
  comPendencias: () =>
    falhaLigacoes(
      "com_pendencias",
      "Uma desativação anterior deixou pendências. Resolva o que o cartão Ligações pede antes de ativar.",
    ),
  ativacaoAbandonada: () =>
    falhaLigacoes(
      "com_pendencias",
      "Uma ativação anterior parou no meio. Clique em Tentar de novo para desfazer o que ela criou e depois ative de novo.",
    ),
  chaveTrocada: () =>
    falhaLigacoes(
      "chave_invalida",
      "A chave da ElevenLabs foi trocada por uma de outra conta durante a ativação. Desfizemos o que tinha sido criado. Ative de novo para criar tudo na conta da chave nova.",
    ),
  ativacaoInterrompida: () =>
    falhaLigacoes(
      "ativacao_interrompida",
      "A ativação foi interrompida: o WhatsApp foi desconectado ou trocado, ou as ligações foram desativadas enquanto ela rodava. Desfizemos o que tinha sido criado. Confira o WhatsApp e ative de novo.",
    ),

  // ElevenLabs
  chaveInvalida: () =>
    falhaLigacoes(
      "chave_invalida",
      "A ElevenLabs não reconheceu a chave guardada. Se o cartão Ligações mostrar pendências, resolva-as primeiro; depois, troque a chave no cartão Voz e ative de novo.",
    ),
  chaveBloqueada: () =>
    falhaLigacoes(
      "chave_invalida",
      "A ElevenLabs recusou o acesso desta chave. Confira as permissões e a lista de endereços de IP da chave na ElevenLabs.",
    ),
  chaveSemAcessoAgentes: () =>
    falhaLigacoes(
      "chave_sem_acesso_agentes",
      "A chave da ElevenLabs não tem acesso aos agentes. Na ElevenLabs, edite a chave e ligue ElevenLabs Agents (escrita) e Webhooks (escrita).",
    ),
  semCredito: () =>
    falhaLigacoes(
      "provedor_fora",
      "A conta da ElevenLabs está sem créditos. Recarregue a conta e tente de novo.",
    ),
  numeroEmOutraConta: () =>
    falhaLigacoes(
      "numero_em_outra_conta",
      "Este número já está cadastrado em outra conta da ElevenLabs. Apague-o lá (Agents → Phone Numbers) ou use a chave daquela conta.",
    ),
  elevenMuitas: () =>
    falhaLigacoes(
      "provedor_fora",
      "A ElevenLabs está recebendo chamadas demais agora. Espere um minuto e tente de novo.",
    ),
  elevenFora: () =>
    falhaLigacoes(
      "provedor_fora",
      "A ElevenLabs não respondeu como esperado. Pode ser uma instabilidade do lado dela: tente de novo em alguns minutos.",
    ),
  elevenSemRede: () =>
    falhaLigacoes(
      "provedor_fora",
      "Não conseguimos falar com a ElevenLabs agora. Tente de novo em alguns minutos.",
    ),
  agenteNaoEncontrado: () =>
    falhaLigacoes(
      "agente_nao_encontrado",
      "Este agente não existe mais na conta da ElevenLabs: ele foi apagado lá. Crie o agente de novo na área Ligações.",
    ),
  promptGrande: () =>
    falhaLigacoes(
      "prompt_grande",
      "O Contexto ficou grande demais para o agente de voz: a ElevenLabs aceita um prompt de até 2 MB. Encurte o Contexto (as perguntas e respostas mais longas primeiro) e atualize os agentes na área Ligações.",
    ),
  elevenTempo: () =>
    falhaLigacoes(
      "tempo_esgotado",
      "A ElevenLabs demorou mais de 10 segundos para responder. Tente de novo em instantes.",
    ),

  // Meta
  metaTokenInvalido: () =>
    falhaLigacoes(
      "meta_token_invalido",
      "A Meta não aceitou o token da conexão, ou ele não tem permissão sobre este número. Conserte o token no cartão WhatsApp e tente de novo.",
    ),
  metaRecusou: () => falhaLigacoes("meta_recusou", MENSAGEM_META_RECUSOU),
  metaLimite: () =>
    falhaLigacoes(
      "meta_limite",
      "A Meta ainda não liberou ligações para este número. Ela só libera para empresas com limite de 2.000 conversas por dia, e a sua ainda não chegou lá. Verifique a sua empresa na Meta e tente de novo.",
    ),
  metaRequisitoTecnico: () =>
    falhaLigacoes(
      "meta_requisito_tecnico",
      "A Meta recusou ligar as chamadas neste número por um requisito técnico. Confira se o app da Meta está publicado (modo Live) e tente de novo.",
    ),
  metaPausada: () =>
    falhaLigacoes(
      "meta_pausada",
      "A Meta pausou as ligações deste número por causa da qualidade das conversas. Essa regra é da Meta: veja o motivo no WhatsApp Manager e tente de novo quando a pausa terminar.",
    ),
  metaNumeroBloqueado: () =>
    falhaLigacoes(
      "meta_numero_bloqueado",
      "A Meta bloqueou este número. Essa regra é da Meta: veja o motivo na saúde da conta, no WhatsApp Manager (forma de pagamento, verificação da empresa, nome de exibição ou política), resolva e tente de novo.",
    ),
  naoElegivel: () =>
    falhaLigacoes(
      "nao_elegivel",
      "Falta resolver um item antes de ativar as ligações. Veja a lista no cartão.",
    ),
  metaSipEmUso: () =>
    falhaLigacoes(
      "meta_sip_em_uso",
      "Este número já tem ligações ligadas na Meta, ou manda as ligações para outro sistema. No painel da Meta (WhatsApp Manager → o número → Ligações), desligue as ligações e tire o servidor SIP de outro sistema, e tente de novo.",
    ),
  metaSemSenha: () =>
    falhaLigacoes(
      "provedor_fora",
      "A Meta ligou as chamadas, mas não devolveu a senha SIP do número. Tente de novo em alguns minutos.",
    ),
  metaSemNumero: () =>
    falhaLigacoes(
      "provedor_fora",
      "A Meta não informou o número deste WhatsApp. Tente de novo em alguns minutos.",
    ),
  metaMuitas: () =>
    falhaLigacoes(
      "provedor_fora",
      "A Meta recebeu tentativas demais. Espere um minuto e tente de novo.",
    ),
  metaFora: () =>
    falhaLigacoes(
      "provedor_fora",
      "A Meta não respondeu como esperado. Pode ser uma instabilidade passageira: tente de novo em alguns minutos.",
    ),
  metaSemRede: () =>
    falhaLigacoes(
      "provedor_fora",
      "Não conseguimos falar com a Meta agora. Tente de novo em alguns minutos.",
    ),
  metaTempo: () =>
    falhaLigacoes(
      "tempo_esgotado",
      "A Meta demorou mais de 10 segundos para responder. Tente de novo em instantes.",
    ),

  // banco
  erroAoGravar: () =>
    falhaLigacoes(
      "erro_ao_gravar",
      "Não conseguimos gravar o andamento das ligações agora. Tente de novo em instantes.",
    ),
  erroAoLer: () =>
    falhaLigacoes(
      "erro_ao_ler",
      "Não conseguimos ler a configuração das ligações agora. Tente de novo em instantes.",
    ),
};
