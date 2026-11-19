// As 8 áreas da plataforma (spec, decisão 3; Ligações desda spec-ligacoes-tela, L1), na ordem do menu. Os grupos, os ícones e os textos
// de Chat, Contatos, Equipe, Contexto e Configuração são os do F (AREAS e as vistas da t6); Kanban
// e Dashboard seguem o mesmo tom. Todas já são telas, com dados de exemplo. O `vazio` diz o que vai
// aparecer quando não houver dado (a AreaVazia); hoje só Contatos usa, na tabela sem contato nenhum.

import type { PapelMembro } from "./exemplo/tipos";

export type AreaId = "chat" | "ligacoes" | "contatos" | "kanban" | "dashboard" | "equipe" | "contexto" | "configuracao";

export type GrupoArea = "atendimento" | "nina";

export type FormaVazio = "lista" | "cartao" | "tabela" | "quadro";

export interface Area {
  id: AreaId;
  nome: string;
  /** Rótulo curto do dock do celular. */
  curto: string;
  rota:
    | "/app/chat"
    | "/app/ligacoes"
    | "/app/contatos"
    | "/app/kanban"
    | "/app/dashboard"
    | "/app/equipe"
    | "/app/contexto"
    | "/app/configuracao";
  grupo: GrupoArea;
  /** `d` do ícone (traço de 24 px, como os do F). */
  icone: string;
  /** Frase sob o título da área. */
  descricao: string;
  /** O estado vazio: o que falta e o que vai aparecer ali. */
  vazio: { titulo: string; texto: string; forma: FormaVazio };
}

export const GRUPOS: readonly { id: GrupoArea; titulo: string }[] = [
  { id: "atendimento", titulo: "Atendimento" },
  { id: "nina", titulo: "Sua Nina" },
];

/** As 8 áreas, na ordem do menu (spec, decisão 3; Ligações logo abaixo do Chat, spec-ligacoes-tela L1). */
export const AREAS: readonly Area[] = [
  {
    id: "chat",
    nome: "Chat",
    curto: "Chat",
    rota: "/app/chat",
    grupo: "atendimento",
    icone: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2zM13 8H7M17 12H7",
    descricao: "As conversas que a Nina está tendo com os seus leads. Você pode assumir qualquer uma.",
    vazio: {
      titulo: "Nenhuma conversa ainda",
      texto: "Quando um lead mandar mensagem para o número conectado, a conversa aparece aqui na hora.",
      forma: "lista",
    },
  },
  {
    id: "ligacoes",
    nome: "Ligações",
    curto: "Ligações",
    rota: "/app/ligacoes",
    grupo: "atendimento",
    // o telefone do lucide (Phone), o mesmo do registro da ligação na conversa
    icone:
      "M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384",
    descricao: "As ligações que a Nina atende pelo WhatsApp, com o resumo e a conversa de cada uma.",
    vazio: {
      titulo: "Nenhuma ligação ainda",
      texto: "Quando um lead ligar pelo WhatsApp para o número conectado, a ligação aparece aqui com o resumo e a conversa.",
      forma: "lista",
    },
  },
  {
    id: "contatos",
    nome: "Contatos",
    curto: "Contatos",
    rota: "/app/contatos",
    grupo: "atendimento",
    icone: "M7 8a5 5 0 1 0 10 0a5 5 0 1 0-10 0M20 21a8 8 0 0 0-16 0",
    descricao: "Todo mundo que falou com a Nina, com o que ela descobriu sobre cada pessoa.",
    vazio: {
      titulo: "Nenhum contato ainda",
      texto:
        "Os contatos entram sozinhos quando os primeiros leads chegarem. Assim você vê o histórico de cada um num lugar só.",
      forma: "tabela",
    },
  },
  {
    id: "kanban",
    nome: "Kanban",
    curto: "Kanban",
    rota: "/app/kanban",
    grupo: "atendimento",
    icone: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8 7v7M12 7v4M16 7v9",
    descricao: "Os leads em colunas, conforme avançam na conversa com a Nina.",
    vazio: {
      titulo: "Nenhum lead no quadro ainda",
      texto: "Cada lead que chegar entra na primeira coluna e anda para a próxima conforme a conversa avança.",
      forma: "quadro",
    },
  },
  {
    id: "dashboard",
    nome: "Dashboard",
    curto: "Dash.",
    rota: "/app/dashboard",
    grupo: "atendimento",
    icone: "M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z",
    descricao: "Os números do atendimento da Nina, num lugar só.",
    vazio: {
      titulo: "Nenhum número ainda",
      texto:
        "Quando os primeiros leads chegarem, aqui aparecem quantos chegaram, quantos a Nina atendeu e quantos foram para a equipe.",
      forma: "cartao",
    },
  },
  {
    id: "equipe",
    nome: "Equipe",
    curto: "Equipe",
    rota: "/app/equipe",
    grupo: "atendimento",
    icone:
      "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M5 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
    descricao: "Quem recebe os leads quando a Nina passa a vez.",
    vazio: {
      titulo: "Ninguém na equipe ainda",
      texto: "Aqui aparecem as pessoas que atendem junto com você e recebem os leads que a Nina passar.",
      forma: "lista",
    },
  },
  {
    id: "contexto",
    nome: "Contexto",
    curto: "Contexto",
    rota: "/app/contexto",
    grupo: "nina",
    icone: "M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20M8 7h6M8 11h8",
    descricao: "Tudo o que a Nina sabe sobre a sua empresa, do jeito que você contou para ela.",
    vazio: {
      titulo: "Nenhum item no Contexto ainda",
      texto: "O que você contar para a Nina aparece aqui, um assunto por cartão.",
      forma: "cartao",
    },
  },
  {
    id: "configuracao",
    nome: "Configuração",
    curto: "Config.",
    rota: "/app/configuracao",
    grupo: "nina",
    icone: "M20 7h-9M14 17H5M14 17a3 3 0 1 0 6 0a3 3 0 1 0-6 0M4 7a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
    descricao: "WhatsApp, cérebro e chaves da Nina.",
    vazio: {
      titulo: "Nada para configurar aqui ainda",
      texto: "Aqui aparecem o WhatsApp conectado, o cérebro escolhido e o final da chave de API.",
      forma: "tabela",
    },
  },
];

/**
 * Se o papel vê a área (spec, bloco 1, item 4, confirmado em 30/10): o atendente não vê a
 * Configuração, que some do menu, do dock, dos atalhos da Nina e do tour dele. As Ligações, todo membro
 * vê (L9); dentro delas, as abas Agentes e Ajustes são só do admin.
 */
export function areaVisivelPara(id: AreaId, papel: PapelMembro): boolean {
  return papel === "admin" || id !== "configuracao";
}

/** As áreas do menu para o papel, na ordem de sempre (a Configuração é a última: as outras não mudam de lugar). */
export function areasDoPapel(papel: PapelMembro): readonly Area[] {
  return papel === "admin" ? AREAS : AREAS.filter((a) => areaVisivelPara(a.id, papel));
}

export function areaPorId(id: AreaId): Area {
  return AREAS.find((a) => a.id === id) ?? AREAS[0]!;
}

/** A área aberta, pelo caminho da URL ("/app/kanban" → Kanban). `null` fora das áreas. */
export function areaDoCaminho(caminho: string): Area | null {
  const limpo = caminho.replace(/\/+$/, "");
  return AREAS.find((a) => limpo === a.rota || limpo.startsWith(a.rota + "/")) ?? null;
}
