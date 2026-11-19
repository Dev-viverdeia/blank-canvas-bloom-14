export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      auditoria: {
        Row: {
          acao: Database["public"]["Enums"]["auditoria_acao"]
          alvo: string | null
          ator_membro_id: string | null
          criado_em: string
          detalhe: Json
          id: number
          ultimos4: string | null
        }
        Insert: {
          acao: Database["public"]["Enums"]["auditoria_acao"]
          alvo?: string | null
          ator_membro_id?: string | null
          criado_em?: string
          detalhe?: Json
          id?: never
          ultimos4?: string | null
        }
        Update: {
          acao?: Database["public"]["Enums"]["auditoria_acao"]
          alvo?: string | null
          ator_membro_id?: string | null
          criado_em?: string
          detalhe?: Json
          id?: never
          ultimos4?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "auditoria_ator_membro_id_fkey"
            columns: ["ator_membro_id"]
            isOneToOne: false
            referencedRelation: "membros"
            referencedColumns: ["id"]
          },
        ]
      }
      conexao_eventos: {
        Row: {
          ativa_de: boolean | null
          ativa_para: boolean
          ator_membro_id: string | null
          conexao_id: string
          criado_em: string
          id: string
          status_de: Database["public"]["Enums"]["conexao_status"] | null
          status_para: Database["public"]["Enums"]["conexao_status"]
          ultimo_erro: string | null
        }
        Insert: {
          ativa_de?: boolean | null
          ativa_para: boolean
          ator_membro_id?: string | null
          conexao_id: string
          criado_em?: string
          id?: string
          status_de?: Database["public"]["Enums"]["conexao_status"] | null
          status_para: Database["public"]["Enums"]["conexao_status"]
          ultimo_erro?: string | null
        }
        Update: {
          ativa_de?: boolean | null
          ativa_para?: boolean
          ator_membro_id?: string | null
          conexao_id?: string
          criado_em?: string
          id?: string
          status_de?: Database["public"]["Enums"]["conexao_status"] | null
          status_para?: Database["public"]["Enums"]["conexao_status"]
          ultimo_erro?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conexao_eventos_ator_membro_id_fkey"
            columns: ["ator_membro_id"]
            isOneToOne: false
            referencedRelation: "membros"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conexao_eventos_conexao_id_fkey"
            columns: ["conexao_id"]
            isOneToOne: false
            referencedRelation: "conexoes"
            referencedColumns: ["id"]
          },
        ]
      }
      conexoes: {
        Row: {
          ativa: boolean
          atualizado_em: string
          criado_em: string
          criado_por: string | null
          gateway: Database["public"]["Enums"]["gateway"]
          id: string
          id_externo: string
          nome: string
          oficial: boolean | null
          parametros: Json
          segredos: Json
          status: Database["public"]["Enums"]["conexao_status"]
          ultimo_erro: string | null
        }
        Insert: {
          ativa?: boolean
          atualizado_em?: string
          criado_em?: string
          criado_por?: string | null
          gateway: Database["public"]["Enums"]["gateway"]
          id?: string
          id_externo: string
          nome: string
          oficial?: boolean | null
          parametros?: Json
          segredos?: Json
          status?: Database["public"]["Enums"]["conexao_status"]
          ultimo_erro?: string | null
        }
        Update: {
          ativa?: boolean
          atualizado_em?: string
          criado_em?: string
          criado_por?: string | null
          gateway?: Database["public"]["Enums"]["gateway"]
          id?: string
          id_externo?: string
          nome?: string
          oficial?: boolean | null
          parametros?: Json
          segredos?: Json
          status?: Database["public"]["Enums"]["conexao_status"]
          ultimo_erro?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conexoes_criado_por_fkey"
            columns: ["criado_por"]
            isOneToOne: false
            referencedRelation: "membros"
            referencedColumns: ["id"]
          },
        ]
      }
      configuracao: {
        Row: {
          atualizado_em: string
          criado_em: string
          espera_lote_max_s: number
          espera_lote_s: number
          id: number
          lembrete_horas: number
          lembrete_ligado: boolean
          ligacoes_por_contato: number
          ligacoes_por_dia: number
          ligacoes_simultaneas: number
          onboarding_concluido_em: string | null
          voz_erro: string | null
          voz_id: string | null
          voz_nome: string | null
          voz_resposta: string
          worker_retornos_em: string | null
          worker_visto_em: string | null
        }
        Insert: {
          atualizado_em?: string
          criado_em?: string
          espera_lote_max_s?: number
          espera_lote_s?: number
          id?: number
          lembrete_horas?: number
          lembrete_ligado?: boolean
          ligacoes_por_contato?: number
          ligacoes_por_dia?: number
          ligacoes_simultaneas?: number
          onboarding_concluido_em?: string | null
          voz_erro?: string | null
          voz_id?: string | null
          voz_nome?: string | null
          voz_resposta?: string
          worker_retornos_em?: string | null
          worker_visto_em?: string | null
        }
        Update: {
          atualizado_em?: string
          criado_em?: string
          espera_lote_max_s?: number
          espera_lote_s?: number
          id?: number
          lembrete_horas?: number
          lembrete_ligado?: boolean
          ligacoes_por_contato?: number
          ligacoes_por_dia?: number
          ligacoes_simultaneas?: number
          onboarding_concluido_em?: string | null
          voz_erro?: string | null
          voz_id?: string | null
          voz_nome?: string | null
          voz_resposta?: string
          worker_retornos_em?: string | null
          worker_visto_em?: string | null
        }
        Relationships: []
      }
      contato_etapa_historico: {
        Row: {
          ator: Database["public"]["Enums"]["historico_ator"]
          contato_id: string
          criado_em: string
          de_etapa_id: string | null
          id: string
          membro_id: string | null
          para_etapa_id: string
          rodada_id: string | null
        }
        Insert: {
          ator: Database["public"]["Enums"]["historico_ator"]
          contato_id: string
          criado_em?: string
          de_etapa_id?: string | null
          id?: string
          membro_id?: string | null
          para_etapa_id: string
          rodada_id?: string | null
        }
        Update: {
          ator?: Database["public"]["Enums"]["historico_ator"]
          contato_id?: string
          criado_em?: string
          de_etapa_id?: string | null
          id?: string
          membro_id?: string | null
          para_etapa_id?: string
          rodada_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contato_etapa_historico_contato_id_fkey"
            columns: ["contato_id"]
            isOneToOne: false
            referencedRelation: "contatos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contato_etapa_historico_de_etapa_id_fkey"
            columns: ["de_etapa_id"]
            isOneToOne: false
            referencedRelation: "etapas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contato_etapa_historico_membro_id_fkey"
            columns: ["membro_id"]
            isOneToOne: false
            referencedRelation: "membros"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contato_etapa_historico_para_etapa_id_fkey"
            columns: ["para_etapa_id"]
            isOneToOne: false
            referencedRelation: "etapas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contato_etapa_historico_rodada_id_fkey"
            columns: ["rodada_id"]
            isOneToOne: false
            referencedRelation: "rodadas"
            referencedColumns: ["id"]
          },
        ]
      }
      contato_identificadores: {
        Row: {
          conexao_id: string | null
          contato_id: string
          criado_em: string
          id: string
          tipo: Database["public"]["Enums"]["identificador_tipo"]
          valor: string
        }
        Insert: {
          conexao_id?: string | null
          contato_id: string
          criado_em?: string
          id?: string
          tipo: Database["public"]["Enums"]["identificador_tipo"]
          valor: string
        }
        Update: {
          conexao_id?: string | null
          contato_id?: string
          criado_em?: string
          id?: string
          tipo?: Database["public"]["Enums"]["identificador_tipo"]
          valor?: string
        }
        Relationships: [
          {
            foreignKeyName: "contato_identificadores_conexao_id_fkey"
            columns: ["conexao_id"]
            isOneToOne: false
            referencedRelation: "conexoes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contato_identificadores_contato_id_fkey"
            columns: ["contato_id"]
            isOneToOne: false
            referencedRelation: "contatos"
            referencedColumns: ["id"]
          },
        ]
      }
      contatos: {
        Row: {
          anotacoes_nina: Json | null
          atualizado_em: string
          criado_em: string
          email: string | null
          empresa: string | null
          etapa_desde: string
          etapa_id: string
          id: string
          nome: string | null
          nome_whatsapp: string | null
          observacoes: string | null
          primeira_mensagem_em: string | null
          resumo_nina: string | null
          resumo_nina_em: string | null
          telefone: string | null
        }
        Insert: {
          anotacoes_nina?: Json | null
          atualizado_em?: string
          criado_em?: string
          email?: string | null
          empresa?: string | null
          etapa_desde?: string
          etapa_id: string
          id?: string
          nome?: string | null
          nome_whatsapp?: string | null
          observacoes?: string | null
          primeira_mensagem_em?: string | null
          resumo_nina?: string | null
          resumo_nina_em?: string | null
          telefone?: string | null
        }
        Update: {
          anotacoes_nina?: Json | null
          atualizado_em?: string
          criado_em?: string
          email?: string | null
          empresa?: string | null
          etapa_desde?: string
          etapa_id?: string
          id?: string
          nome?: string | null
          nome_whatsapp?: string | null
          observacoes?: string | null
          primeira_mensagem_em?: string | null
          resumo_nina?: string | null
          resumo_nina_em?: string | null
          telefone?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contatos_etapa_id_fkey"
            columns: ["etapa_id"]
            isOneToOne: false
            referencedRelation: "etapas"
            referencedColumns: ["id"]
          },
        ]
      }
      contexto_versoes: {
        Row: {
          cliente_ideal: string
          criado_em: string
          criado_por: string | null
          diferenciais: string
          empresa_oferta: string
          horario: string
          id: number
          itens: Json
          numero: number | null
          objecoes: string
          origem: Database["public"]["Enums"]["contexto_origem"]
          preco: string
          quando_passar_humano: string
          restaurada_de: number | null
          tom_voz: string
        }
        Insert: {
          cliente_ideal?: string
          criado_em?: string
          criado_por?: string | null
          diferenciais?: string
          empresa_oferta?: string
          horario?: string
          id?: never
          itens?: Json
          numero?: number | null
          objecoes?: string
          origem?: Database["public"]["Enums"]["contexto_origem"]
          preco?: string
          quando_passar_humano?: string
          restaurada_de?: number | null
          tom_voz?: string
        }
        Update: {
          cliente_ideal?: string
          criado_em?: string
          criado_por?: string | null
          diferenciais?: string
          empresa_oferta?: string
          horario?: string
          id?: never
          itens?: Json
          numero?: number | null
          objecoes?: string
          origem?: Database["public"]["Enums"]["contexto_origem"]
          preco?: string
          quando_passar_humano?: string
          restaurada_de?: number | null
          tom_voz?: string
        }
        Relationships: [
          {
            foreignKeyName: "contexto_versoes_criado_por_fkey"
            columns: ["criado_por"]
            isOneToOne: false
            referencedRelation: "membros"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contexto_versoes_restaurada_de_fkey"
            columns: ["restaurada_de"]
            isOneToOne: false
            referencedRelation: "contexto_versoes"
            referencedColumns: ["id"]
          },
        ]
      }
      conversa_eventos: {
        Row: {
          conversa_id: string
          criado_em: string
          de: string | null
          de_membro_id: string | null
          id: string
          membro_id: string | null
          motivo: Database["public"]["Enums"]["motivo_humano"] | null
          por_envio: boolean
          tipo: Database["public"]["Enums"]["conversa_evento_tipo"]
        }
        Insert: {
          conversa_id: string
          criado_em?: string
          de?: string | null
          de_membro_id?: string | null
          id?: string
          membro_id?: string | null
          motivo?: Database["public"]["Enums"]["motivo_humano"] | null
          por_envio?: boolean
          tipo: Database["public"]["Enums"]["conversa_evento_tipo"]
        }
        Update: {
          conversa_id?: string
          criado_em?: string
          de?: string | null
          de_membro_id?: string | null
          id?: string
          membro_id?: string | null
          motivo?: Database["public"]["Enums"]["motivo_humano"] | null
          por_envio?: boolean
          tipo?: Database["public"]["Enums"]["conversa_evento_tipo"]
        }
        Relationships: [
          {
            foreignKeyName: "conversa_eventos_conversa_id_fkey"
            columns: ["conversa_id"]
            isOneToOne: false
            referencedRelation: "conversas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversa_eventos_de_membro_id_fkey"
            columns: ["de_membro_id"]
            isOneToOne: false
            referencedRelation: "membros"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversa_eventos_membro_id_fkey"
            columns: ["membro_id"]
            isOneToOne: false
            referencedRelation: "membros"
            referencedColumns: ["id"]
          },
        ]
      }
      conversas: {
        Row: {
          aguardando_humano_desde: string | null
          atualizado_em: string
          conexao_id: string | null
          contato_id: string
          criado_em: string
          devolvida_em: string | null
          id: string
          modo: Database["public"]["Enums"]["conversa_modo"]
          motivo_humano: Database["public"]["Enums"]["motivo_humano"] | null
          nao_lidas: number
          responder_apos: string | null
          responsavel_id: string | null
          ultima_da_nina_em: string | null
          ultima_do_lead_em: string | null
          ultima_mensagem_em: string | null
          ultima_mensagem_id: string | null
          ultima_mensagem_preview: string | null
        }
        Insert: {
          aguardando_humano_desde?: string | null
          atualizado_em?: string
          conexao_id?: string | null
          contato_id: string
          criado_em?: string
          devolvida_em?: string | null
          id?: string
          modo?: Database["public"]["Enums"]["conversa_modo"]
          motivo_humano?: Database["public"]["Enums"]["motivo_humano"] | null
          nao_lidas?: number
          responder_apos?: string | null
          responsavel_id?: string | null
          ultima_da_nina_em?: string | null
          ultima_do_lead_em?: string | null
          ultima_mensagem_em?: string | null
          ultima_mensagem_id?: string | null
          ultima_mensagem_preview?: string | null
        }
        Update: {
          aguardando_humano_desde?: string | null
          atualizado_em?: string
          conexao_id?: string | null
          contato_id?: string
          criado_em?: string
          devolvida_em?: string | null
          id?: string
          modo?: Database["public"]["Enums"]["conversa_modo"]
          motivo_humano?: Database["public"]["Enums"]["motivo_humano"] | null
          nao_lidas?: number
          responder_apos?: string | null
          responsavel_id?: string | null
          ultima_da_nina_em?: string | null
          ultima_do_lead_em?: string | null
          ultima_mensagem_em?: string | null
          ultima_mensagem_id?: string | null
          ultima_mensagem_preview?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conversas_conexao_id_fkey"
            columns: ["conexao_id"]
            isOneToOne: false
            referencedRelation: "conexoes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversas_contato_id_fkey"
            columns: ["contato_id"]
            isOneToOne: true
            referencedRelation: "contatos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversas_responsavel_id_fkey"
            columns: ["responsavel_id"]
            isOneToOne: false
            referencedRelation: "membros"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversas_ultima_mensagem_id_fkey"
            columns: ["ultima_mensagem_id"]
            isOneToOne: false
            referencedRelation: "mensagens"
            referencedColumns: ["id"]
          },
        ]
      }
      convites: {
        Row: {
          convidado_por: string | null
          criado_em: string
          email: string
          enviado_em: string
          id: string
          papel: Database["public"]["Enums"]["papel_membro"]
          user_id: string | null
        }
        Insert: {
          convidado_por?: string | null
          criado_em?: string
          email: string
          enviado_em?: string
          id?: string
          papel?: Database["public"]["Enums"]["papel_membro"]
          user_id?: string | null
        }
        Update: {
          convidado_por?: string | null
          criado_em?: string
          email?: string
          enviado_em?: string
          id?: string
          papel?: Database["public"]["Enums"]["papel_membro"]
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "convites_convidado_por_fkey"
            columns: ["convidado_por"]
            isOneToOne: false
            referencedRelation: "membros"
            referencedColumns: ["id"]
          },
        ]
      }
      etapas: {
        Row: {
          arquivada: boolean
          chave: string | null
          cor: string | null
          criado_em: string
          id: string
          nina_pode_mover: boolean
          nome: string
          ordem: number
          tipo: Database["public"]["Enums"]["etapa_tipo"]
        }
        Insert: {
          arquivada?: boolean
          chave?: string | null
          cor?: string | null
          criado_em?: string
          id?: string
          nina_pode_mover?: boolean
          nome: string
          ordem: number
          tipo?: Database["public"]["Enums"]["etapa_tipo"]
        }
        Update: {
          arquivada?: boolean
          chave?: string | null
          cor?: string | null
          criado_em?: string
          id?: string
          nina_pode_mover?: boolean
          nome?: string
          ordem?: number
          tipo?: Database["public"]["Enums"]["etapa_tipo"]
        }
        Relationships: []
      }
      eventos_webhook: {
        Row: {
          conexao_id: string | null
          criado_em: string
          erro: string | null
          gateway: Database["public"]["Enums"]["gateway"]
          id: number
          id_evento: string | null
          payload: Json
          pego_em: string | null
          processado_em: string | null
          recebido_em: string
          tentativas: number
          tipo: string | null
        }
        Insert: {
          conexao_id?: string | null
          criado_em?: string
          erro?: string | null
          gateway: Database["public"]["Enums"]["gateway"]
          id?: never
          id_evento?: string | null
          payload: Json
          pego_em?: string | null
          processado_em?: string | null
          recebido_em?: string
          tentativas?: number
          tipo?: string | null
        }
        Update: {
          conexao_id?: string | null
          criado_em?: string
          erro?: string | null
          gateway?: Database["public"]["Enums"]["gateway"]
          id?: never
          id_evento?: string | null
          payload?: Json
          pego_em?: string | null
          processado_em?: string | null
          recebido_em?: string
          tentativas?: number
          tipo?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "eventos_webhook_conexao_id_fkey"
            columns: ["conexao_id"]
            isOneToOne: false
            referencedRelation: "conexoes"
            referencedColumns: ["id"]
          },
        ]
      }
      ia_chamadas: {
        Row: {
          caracteres: number | null
          conversa_id: string | null
          criado_em: string
          custo_origem: Database["public"]["Enums"]["custo_origem"]
          custo_usd: number | null
          id: number
          modelo: string
          passo: number | null
          preco_id: string | null
          provedor: Database["public"]["Enums"]["ia_provedor"]
          request_id: string | null
          rodada_id: string | null
          segundos_audio: number | null
          tipo: Database["public"]["Enums"]["chamada_tipo"]
          tokens_cache_escrita: number | null
          tokens_cache_leitura: number | null
          tokens_entrada: number | null
          tokens_raciocinio: number | null
          tokens_saida: number | null
          uso_bruto: Json | null
        }
        Insert: {
          caracteres?: number | null
          conversa_id?: string | null
          criado_em?: string
          custo_origem: Database["public"]["Enums"]["custo_origem"]
          custo_usd?: number | null
          id?: never
          modelo: string
          passo?: number | null
          preco_id?: string | null
          provedor: Database["public"]["Enums"]["ia_provedor"]
          request_id?: string | null
          rodada_id?: string | null
          segundos_audio?: number | null
          tipo: Database["public"]["Enums"]["chamada_tipo"]
          tokens_cache_escrita?: number | null
          tokens_cache_leitura?: number | null
          tokens_entrada?: number | null
          tokens_raciocinio?: number | null
          tokens_saida?: number | null
          uso_bruto?: Json | null
        }
        Update: {
          caracteres?: number | null
          conversa_id?: string | null
          criado_em?: string
          custo_origem?: Database["public"]["Enums"]["custo_origem"]
          custo_usd?: number | null
          id?: never
          modelo?: string
          passo?: number | null
          preco_id?: string | null
          provedor?: Database["public"]["Enums"]["ia_provedor"]
          request_id?: string | null
          rodada_id?: string | null
          segundos_audio?: number | null
          tipo?: Database["public"]["Enums"]["chamada_tipo"]
          tokens_cache_escrita?: number | null
          tokens_cache_leitura?: number | null
          tokens_entrada?: number | null
          tokens_raciocinio?: number | null
          tokens_saida?: number | null
          uso_bruto?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "ia_chamadas_conversa_id_fkey"
            columns: ["conversa_id"]
            isOneToOne: false
            referencedRelation: "conversas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ia_chamadas_preco_id_fkey"
            columns: ["preco_id"]
            isOneToOne: false
            referencedRelation: "ia_precos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ia_chamadas_rodada_id_fkey"
            columns: ["rodada_id"]
            isOneToOne: false
            referencedRelation: "rodadas"
            referencedColumns: ["id"]
          },
        ]
      }
      ia_chaves: {
        Row: {
          atualizada_em: string
          atualizada_por: string | null
          chave_cifrada: string | null
          criado_em: string
          finalidade: Database["public"]["Enums"]["ia_finalidade"]
          id: string
          modelo: string
          provedor: Database["public"]["Enums"]["ia_provedor"]
          status: Database["public"]["Enums"]["chave_status"]
          ultimo_erro: string | null
          ultimos4: string | null
          validada_em: string | null
          workspace_id: string | null
        }
        Insert: {
          atualizada_em?: string
          atualizada_por?: string | null
          chave_cifrada?: string | null
          criado_em?: string
          finalidade: Database["public"]["Enums"]["ia_finalidade"]
          id?: string
          modelo: string
          provedor: Database["public"]["Enums"]["ia_provedor"]
          status?: Database["public"]["Enums"]["chave_status"]
          ultimo_erro?: string | null
          ultimos4?: string | null
          validada_em?: string | null
          workspace_id?: string | null
        }
        Update: {
          atualizada_em?: string
          atualizada_por?: string | null
          chave_cifrada?: string | null
          criado_em?: string
          finalidade?: Database["public"]["Enums"]["ia_finalidade"]
          id?: string
          modelo?: string
          provedor?: Database["public"]["Enums"]["ia_provedor"]
          status?: Database["public"]["Enums"]["chave_status"]
          ultimo_erro?: string | null
          ultimos4?: string | null
          validada_em?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ia_chaves_atualizada_por_fkey"
            columns: ["atualizada_por"]
            isOneToOne: false
            referencedRelation: "membros"
            referencedColumns: ["id"]
          },
        ]
      }
      ia_precos: {
        Row: {
          a_partir_de_tokens: number
          audio_por_minuto: number | null
          cache_escrita: number | null
          cache_leitura: number | null
          criado_em: string
          entrada: number | null
          fonte: string
          id: string
          modelo: string
          por_mil_caracteres: number | null
          provedor: Database["public"]["Enums"]["ia_provedor"]
          saida: number | null
          vigente_desde: string
        }
        Insert: {
          a_partir_de_tokens?: number
          audio_por_minuto?: number | null
          cache_escrita?: number | null
          cache_leitura?: number | null
          criado_em?: string
          entrada?: number | null
          fonte: string
          id?: string
          modelo: string
          por_mil_caracteres?: number | null
          provedor: Database["public"]["Enums"]["ia_provedor"]
          saida?: number | null
          vigente_desde: string
        }
        Update: {
          a_partir_de_tokens?: number
          audio_por_minuto?: number | null
          cache_escrita?: number | null
          cache_leitura?: number | null
          criado_em?: string
          entrada?: number | null
          fonte?: string
          id?: string
          modelo?: string
          por_mil_caracteres?: number | null
          provedor?: Database["public"]["Enums"]["ia_provedor"]
          saida?: number | null
          vigente_desde?: string
        }
        Relationships: []
      }
      ligacao_agentes: {
        Row: {
          atende: boolean
          atualizado_em: string
          criado_em: string
          criado_por: string | null
          duracao_max_s: number
          erro_sincronia: string | null
          id: string
          id_externo: string | null
          instrucoes: string
          nome: string
          objetivo: Database["public"]["Enums"]["ligacao_objetivo"]
          perfil: Database["public"]["Enums"]["ligacao_perfil"]
          regras_equipe: string | null
          saudacao: string
          silencio_s: number
          sincronizado_em: string | null
          uso: Database["public"]["Enums"]["ligacao_agente_uso"]
          versao_config: number
          voz_id: string | null
          voz_nome: string | null
        }
        Insert: {
          atende?: boolean
          atualizado_em?: string
          criado_em?: string
          criado_por?: string | null
          duracao_max_s?: number
          erro_sincronia?: string | null
          id?: string
          id_externo?: string | null
          instrucoes?: string
          nome: string
          objetivo?: Database["public"]["Enums"]["ligacao_objetivo"]
          perfil?: Database["public"]["Enums"]["ligacao_perfil"]
          regras_equipe?: string | null
          saudacao?: string
          silencio_s?: number
          sincronizado_em?: string | null
          uso?: Database["public"]["Enums"]["ligacao_agente_uso"]
          versao_config?: number
          voz_id?: string | null
          voz_nome?: string | null
        }
        Update: {
          atende?: boolean
          atualizado_em?: string
          criado_em?: string
          criado_por?: string | null
          duracao_max_s?: number
          erro_sincronia?: string | null
          id?: string
          id_externo?: string | null
          instrucoes?: string
          nome?: string
          objetivo?: Database["public"]["Enums"]["ligacao_objetivo"]
          perfil?: Database["public"]["Enums"]["ligacao_perfil"]
          regras_equipe?: string | null
          saudacao?: string
          silencio_s?: number
          sincronizado_em?: string | null
          uso?: Database["public"]["Enums"]["ligacao_agente_uso"]
          versao_config?: number
          voz_id?: string | null
          voz_nome?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ligacao_agentes_criado_por_fkey"
            columns: ["criado_por"]
            isOneToOne: false
            referencedRelation: "membros"
            referencedColumns: ["id"]
          },
        ]
      }
      ligacao_permissoes: {
        Row: {
          conexao_id: string
          conversa_id: string
          criado_em: string
          expira_em: string | null
          id: string
          id_gateway: string | null
          mensagem_id: string | null
          pedido_em: string
          pedido_por: string | null
          permanente: boolean | null
          respondido_em: string | null
          resposta: string | null
          resposta_mensagem_id: string | null
        }
        Insert: {
          conexao_id: string
          conversa_id: string
          criado_em?: string
          expira_em?: string | null
          id?: string
          id_gateway?: string | null
          mensagem_id?: string | null
          pedido_em?: string
          pedido_por?: string | null
          permanente?: boolean | null
          respondido_em?: string | null
          resposta?: string | null
          resposta_mensagem_id?: string | null
        }
        Update: {
          conexao_id?: string
          conversa_id?: string
          criado_em?: string
          expira_em?: string | null
          id?: string
          id_gateway?: string | null
          mensagem_id?: string | null
          pedido_em?: string
          pedido_por?: string | null
          permanente?: boolean | null
          respondido_em?: string | null
          resposta?: string | null
          resposta_mensagem_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ligacao_permissoes_conexao_id_fkey"
            columns: ["conexao_id"]
            isOneToOne: false
            referencedRelation: "conexoes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ligacao_permissoes_conversa_id_fkey"
            columns: ["conversa_id"]
            isOneToOne: false
            referencedRelation: "conversas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ligacao_permissoes_mensagem_id_fkey"
            columns: ["mensagem_id"]
            isOneToOne: false
            referencedRelation: "mensagens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ligacao_permissoes_pedido_por_fkey"
            columns: ["pedido_por"]
            isOneToOne: false
            referencedRelation: "membros"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ligacao_permissoes_resposta_mensagem_id_fkey"
            columns: ["resposta_mensagem_id"]
            isOneToOne: false
            referencedRelation: "mensagens"
            referencedColumns: ["id"]
          },
        ]
      }
      ligacoes: {
        Row: {
          agente_id: string | null
          atualizado_em: string
          aviso_falha_em: string | null
          conexao_id: string | null
          conversa_id: string
          criado_em: string
          custo_creditos: number | null
          direcao: Database["public"]["Enums"]["ligacao_direcao"]
          duracao_s: number | null
          encerrada_em: string | null
          id: string
          id_externo: string
          iniciada_em: string
          mensagem_id: string | null
          motivo_fim: string | null
          objetivo: string | null
          passou_equipe: boolean
          resumo: string | null
          status: Database["public"]["Enums"]["ligacao_status"]
          transcricao: Json
        }
        Insert: {
          agente_id?: string | null
          atualizado_em?: string
          aviso_falha_em?: string | null
          conexao_id?: string | null
          conversa_id: string
          criado_em?: string
          custo_creditos?: number | null
          direcao: Database["public"]["Enums"]["ligacao_direcao"]
          duracao_s?: number | null
          encerrada_em?: string | null
          id?: string
          id_externo: string
          iniciada_em?: string
          mensagem_id?: string | null
          motivo_fim?: string | null
          objetivo?: string | null
          passou_equipe?: boolean
          resumo?: string | null
          status?: Database["public"]["Enums"]["ligacao_status"]
          transcricao?: Json
        }
        Update: {
          agente_id?: string | null
          atualizado_em?: string
          aviso_falha_em?: string | null
          conexao_id?: string | null
          conversa_id?: string
          criado_em?: string
          custo_creditos?: number | null
          direcao?: Database["public"]["Enums"]["ligacao_direcao"]
          duracao_s?: number | null
          encerrada_em?: string | null
          id?: string
          id_externo?: string
          iniciada_em?: string
          mensagem_id?: string | null
          motivo_fim?: string | null
          objetivo?: string | null
          passou_equipe?: boolean
          resumo?: string | null
          status?: Database["public"]["Enums"]["ligacao_status"]
          transcricao?: Json
        }
        Relationships: [
          {
            foreignKeyName: "ligacoes_agente_id_fkey"
            columns: ["agente_id"]
            isOneToOne: false
            referencedRelation: "ligacao_agentes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ligacoes_conexao_id_fkey"
            columns: ["conexao_id"]
            isOneToOne: false
            referencedRelation: "conexoes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ligacoes_conversa_id_fkey"
            columns: ["conversa_id"]
            isOneToOne: false
            referencedRelation: "conversas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ligacoes_mensagem_id_fkey"
            columns: ["mensagem_id"]
            isOneToOne: true
            referencedRelation: "mensagens"
            referencedColumns: ["id"]
          },
        ]
      }
      membros: {
        Row: {
          ativo: boolean
          convidado_por: string | null
          criado_em: string
          email: string
          id: string
          nome: string
          papel: Database["public"]["Enums"]["papel_membro"]
          user_id: string | null
          vistos: Json
        }
        Insert: {
          ativo?: boolean
          convidado_por?: string | null
          criado_em?: string
          email: string
          id?: string
          nome: string
          papel?: Database["public"]["Enums"]["papel_membro"]
          user_id?: string | null
          vistos?: Json
        }
        Update: {
          ativo?: boolean
          convidado_por?: string | null
          criado_em?: string
          email?: string
          id?: string
          nome?: string
          papel?: Database["public"]["Enums"]["papel_membro"]
          user_id?: string | null
          vistos?: Json
        }
        Relationships: [
          {
            foreignKeyName: "membros_convidado_por_fkey"
            columns: ["convidado_por"]
            isOneToOne: false
            referencedRelation: "membros"
            referencedColumns: ["id"]
          },
        ]
      }
      mensagens: {
        Row: {
          apagada_em: string | null
          autor_membro_id: string | null
          conexao_id: string
          conversa_id: string
          criado_em: string
          direcao: Database["public"]["Enums"]["mensagem_direcao"]
          editada: boolean
          enviar_apos: string | null
          erro: string | null
          evento_id: number | null
          id: string
          id_externo: string | null
          id_gateway: string | null
          midia_caminho: string | null
          midia_duracao_s: number | null
          midia_mime: string | null
          midia_nome: string | null
          midia_pega_em: string | null
          midia_ref_externa: string | null
          midia_status: Database["public"]["Enums"]["midia_status"] | null
          midia_tamanho: number | null
          midia_tentativas: number
          momento: string
          ordem: number | null
          origem: Database["public"]["Enums"]["mensagem_origem"]
          reenvios: number
          responde_a_id: string | null
          rodada_id: string | null
          status: Database["public"]["Enums"]["mensagem_status"]
          status_em: string | null
          tentativas: number
          texto: string | null
          tipo: Database["public"]["Enums"]["mensagem_tipo"]
          transcricao: string | null
        }
        Insert: {
          apagada_em?: string | null
          autor_membro_id?: string | null
          conexao_id: string
          conversa_id: string
          criado_em?: string
          direcao: Database["public"]["Enums"]["mensagem_direcao"]
          editada?: boolean
          enviar_apos?: string | null
          erro?: string | null
          evento_id?: number | null
          id?: string
          id_externo?: string | null
          id_gateway?: string | null
          midia_caminho?: string | null
          midia_duracao_s?: number | null
          midia_mime?: string | null
          midia_nome?: string | null
          midia_pega_em?: string | null
          midia_ref_externa?: string | null
          midia_status?: Database["public"]["Enums"]["midia_status"] | null
          midia_tamanho?: number | null
          midia_tentativas?: number
          momento?: string
          ordem?: number | null
          origem: Database["public"]["Enums"]["mensagem_origem"]
          reenvios?: number
          responde_a_id?: string | null
          rodada_id?: string | null
          status?: Database["public"]["Enums"]["mensagem_status"]
          status_em?: string | null
          tentativas?: number
          texto?: string | null
          tipo?: Database["public"]["Enums"]["mensagem_tipo"]
          transcricao?: string | null
        }
        Update: {
          apagada_em?: string | null
          autor_membro_id?: string | null
          conexao_id?: string
          conversa_id?: string
          criado_em?: string
          direcao?: Database["public"]["Enums"]["mensagem_direcao"]
          editada?: boolean
          enviar_apos?: string | null
          erro?: string | null
          evento_id?: number | null
          id?: string
          id_externo?: string | null
          id_gateway?: string | null
          midia_caminho?: string | null
          midia_duracao_s?: number | null
          midia_mime?: string | null
          midia_nome?: string | null
          midia_pega_em?: string | null
          midia_ref_externa?: string | null
          midia_status?: Database["public"]["Enums"]["midia_status"] | null
          midia_tamanho?: number | null
          midia_tentativas?: number
          momento?: string
          ordem?: number | null
          origem?: Database["public"]["Enums"]["mensagem_origem"]
          reenvios?: number
          responde_a_id?: string | null
          rodada_id?: string | null
          status?: Database["public"]["Enums"]["mensagem_status"]
          status_em?: string | null
          tentativas?: number
          texto?: string | null
          tipo?: Database["public"]["Enums"]["mensagem_tipo"]
          transcricao?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "mensagens_autor_membro_id_fkey"
            columns: ["autor_membro_id"]
            isOneToOne: false
            referencedRelation: "membros"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mensagens_conexao_id_fkey"
            columns: ["conexao_id"]
            isOneToOne: false
            referencedRelation: "conexoes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mensagens_conversa_id_fkey"
            columns: ["conversa_id"]
            isOneToOne: false
            referencedRelation: "conversas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mensagens_evento_id_fkey"
            columns: ["evento_id"]
            isOneToOne: false
            referencedRelation: "eventos_webhook"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mensagens_responde_a_id_fkey"
            columns: ["responde_a_id"]
            isOneToOne: false
            referencedRelation: "mensagens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mensagens_rodada_id_fkey"
            columns: ["rodada_id"]
            isOneToOne: false
            referencedRelation: "rodadas"
            referencedColumns: ["id"]
          },
        ]
      }
      motor: {
        Row: {
          chave: string
          id: boolean
          preparada_em: string | null
          relogio_em: string | null
          relogio_versao: number
          tocado_em: string | null
          url: string | null
          url_em: string | null
        }
        Insert: {
          chave?: string
          id?: boolean
          preparada_em?: string | null
          relogio_em?: string | null
          relogio_versao?: number
          tocado_em?: string | null
          url?: string | null
          url_em?: string | null
        }
        Update: {
          chave?: string
          id?: boolean
          preparada_em?: string | null
          relogio_em?: string | null
          relogio_versao?: number
          tocado_em?: string | null
          url?: string | null
          url_em?: string | null
        }
        Relationships: []
      }
      retornos: {
        Row: {
          atualizado_em: string
          cancelado_por: string | null
          conversa_id: string
          criado_em: string
          enviado_em: string | null
          expira_em: string
          fechado_por_rodada: string | null
          id: string
          lembrete_horas: number | null
          marcado_em: string
          motivo: string | null
          nao_enviado_motivo: string | null
          nota_fim: string | null
          resolvido_em: string | null
          rodada_id: string | null
          rodada_origem_id: string | null
          status: Database["public"]["Enums"]["retorno_status"]
          substitui_id: string | null
          tentar_apos: string | null
          tentativas: number
          tipo: Database["public"]["Enums"]["retorno_tipo"]
          vence_em: string
        }
        Insert: {
          atualizado_em?: string
          cancelado_por?: string | null
          conversa_id: string
          criado_em?: string
          enviado_em?: string | null
          expira_em: string
          fechado_por_rodada?: string | null
          id?: string
          lembrete_horas?: number | null
          marcado_em?: string
          motivo?: string | null
          nao_enviado_motivo?: string | null
          nota_fim?: string | null
          resolvido_em?: string | null
          rodada_id?: string | null
          rodada_origem_id?: string | null
          status?: Database["public"]["Enums"]["retorno_status"]
          substitui_id?: string | null
          tentar_apos?: string | null
          tentativas?: number
          tipo: Database["public"]["Enums"]["retorno_tipo"]
          vence_em: string
        }
        Update: {
          atualizado_em?: string
          cancelado_por?: string | null
          conversa_id?: string
          criado_em?: string
          enviado_em?: string | null
          expira_em?: string
          fechado_por_rodada?: string | null
          id?: string
          lembrete_horas?: number | null
          marcado_em?: string
          motivo?: string | null
          nao_enviado_motivo?: string | null
          nota_fim?: string | null
          resolvido_em?: string | null
          rodada_id?: string | null
          rodada_origem_id?: string | null
          status?: Database["public"]["Enums"]["retorno_status"]
          substitui_id?: string | null
          tentar_apos?: string | null
          tentativas?: number
          tipo?: Database["public"]["Enums"]["retorno_tipo"]
          vence_em?: string
        }
        Relationships: [
          {
            foreignKeyName: "retornos_cancelado_por_fkey"
            columns: ["cancelado_por"]
            isOneToOne: false
            referencedRelation: "membros"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "retornos_conversa_id_fkey"
            columns: ["conversa_id"]
            isOneToOne: false
            referencedRelation: "conversas"
            referencedColumns: ["id"]
          },
        ]
      }
      rodadas: {
        Row: {
          contexto_versao_id: number | null
          conversa_id: string
          criado_em: string
          ferramentas: Json
          foi_para_equipe: boolean
          id: string
          iniciada_em: string
          modelo: string | null
          motivo: Database["public"]["Enums"]["motivo_humano"] | null
          passos: number
          passou_humano: boolean
          provedor: Database["public"]["Enums"]["ia_provedor"] | null
          retorno_id: string | null
          status: Database["public"]["Enums"]["rodada_status"]
          tentativa: number
          terminada_em: string | null
        }
        Insert: {
          contexto_versao_id?: number | null
          conversa_id: string
          criado_em?: string
          ferramentas?: Json
          foi_para_equipe?: boolean
          id?: string
          iniciada_em?: string
          modelo?: string | null
          motivo?: Database["public"]["Enums"]["motivo_humano"] | null
          passos?: number
          passou_humano?: boolean
          provedor?: Database["public"]["Enums"]["ia_provedor"] | null
          retorno_id?: string | null
          status?: Database["public"]["Enums"]["rodada_status"]
          tentativa?: number
          terminada_em?: string | null
        }
        Update: {
          contexto_versao_id?: number | null
          conversa_id?: string
          criado_em?: string
          ferramentas?: Json
          foi_para_equipe?: boolean
          id?: string
          iniciada_em?: string
          modelo?: string | null
          motivo?: Database["public"]["Enums"]["motivo_humano"] | null
          passos?: number
          passou_humano?: boolean
          provedor?: Database["public"]["Enums"]["ia_provedor"] | null
          retorno_id?: string | null
          status?: Database["public"]["Enums"]["rodada_status"]
          tentativa?: number
          terminada_em?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rodadas_contexto_versao_id_fkey"
            columns: ["contexto_versao_id"]
            isOneToOne: false
            referencedRelation: "contexto_versoes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rodadas_conversa_id_fkey"
            columns: ["conversa_id"]
            isOneToOne: false
            referencedRelation: "conversas"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      acordar_motor: { Args: { p_renovar?: boolean }; Returns: string }
      assumir_conversa: { Args: { p_conversa: string }; Returns: undefined }
      atualizar_status: {
        Args: {
          p_conexao: string
          p_id: string
          p_momento: string
          p_status: Database["public"]["Enums"]["mensagem_status"]
        }
        Returns: number
      }
      buscar_quadro: { Args: { p_q: string }; Returns: string[] }
      cancelar_retorno: { Args: { p_retorno: string }; Returns: undefined }
      concluir_envio: {
        Args: { p_id_externo: string; p_id_gateway: string; p_msg: string }
        Returns: undefined
      }
      concluir_midia: {
        Args: {
          p_caminho: string
          p_mime: string
          p_msg: string
          p_ok: boolean
          p_tamanho: number
        }
        Returns: undefined
      }
      concluir_onboarding: { Args: never; Returns: string }
      concluir_rodada: {
        Args: {
          p_ferramentas: Json
          p_passos: number
          p_respostas: Json
          p_rodada: string
        }
        Returns: undefined
      }
      contato_por_ids: {
        Args: { p_conexao: string; p_ids: Json; p_nome_whatsapp: string }
        Returns: string
      }
      contatos_contadores: { Args: never; Returns: Json }
      contatos_lista: {
        Args: {
          p_busca: string
          p_deslocamento: number
          p_direcao: string
          p_entrada_ate: string
          p_entrada_de: string
          p_etapas: string[]
          p_limite: number
          p_ordem: string
          p_recorte: string
        }
        Returns: Json
      }
      contexto_restaurar: { Args: { p_versao: number }; Returns: Json }
      contexto_salvar: {
        Args: {
          p_base: number
          p_mudancas: Json
          p_origem?: Database["public"]["Enums"]["contexto_origem"]
        }
        Returns: Json
      }
      conversa_do_contato: {
        Args: { p_conexao: string; p_contato: string }
        Returns: string
      }
      custo_das_conversas: {
        Args: { p_conversas: string[] }
        Returns: {
          conversa_id: string
          custo_usd: number
        }[]
      }
      dashboard: { Args: { p_fim: string; p_inicio: string }; Returns: Json }
      dashboard_agora: { Args: never; Returns: Json }
      dashboard_custo: { Args: { p_ate: string; p_de: string }; Returns: Json }
      dashboard_custo_por_etapa: {
        Args: { p_ate: string; p_de: string; p_estado_em: string }
        Returns: {
          etapa_id: string
          usd: number
        }[]
      }
      dashboard_etapa_em: {
        Args: { p_contato: string; p_instante: string }
        Returns: string
      }
      dashboard_funil: {
        Args: { p_ate: string; p_de: string; p_estado_em: string }
        Returns: Json
      }
      dashboard_periodo: {
        Args: { p_ate: string; p_de: string; p_estado_em: string }
        Returns: Json
      }
      dashboard_problemas: {
        Args: { p_ate: string; p_de: string }
        Returns: Json
      }
      desativar_membro: { Args: { p_membro: string }; Returns: string[] }
      desistir_midia: {
        Args: { p_erro: string; p_msg: string }
        Returns: undefined
      }
      devolver_para_nina: { Args: { p_conversa: string }; Returns: undefined }
      eh_admin: { Args: never; Returns: boolean }
      eh_membro: { Args: never; Returns: boolean }
      falhar_envio: {
        Args: { p_definitivo: boolean; p_erro: string; p_msg: string }
        Returns: undefined
      }
      falhar_evento: {
        Args: { p_erro: string; p_id: number }
        Returns: undefined
      }
      falhar_rodada: {
        Args: {
          p_motivo: Database["public"]["Enums"]["motivo_humano"]
          p_passageiro: boolean
          p_rodada: string
        }
        Returns: undefined
      }
      ids_normalizados: { Args: { p_ids: Json }; Returns: Json }
      lembrete_ao_concluir: {
        Args: {
          p_bolhas: number
          p_ferramentas: Json
          p_rodada: string
          p_status: Database["public"]["Enums"]["mensagem_status"]
        }
        Returns: undefined
      }
      lembrete_expira_em: { Args: { p_vence: string }; Returns: string }
      lembrete_vence_em: {
        Args: { p_base: string; p_conversa: string; p_horas: number }
        Returns: string
      }
      ligacao_agente_atender: { Args: { p_agente: string }; Returns: undefined }
      ligacao_agente_soltar: {
        Args: { p_agente: string }
        Returns: {
          id_externo: string
          motivo: string
        }[]
      }
      ligacao_avisar_falha: {
        Args: { p_ligacao: string; p_texto: string }
        Returns: string
      }
      ligacao_encerrar: {
        Args: {
          p_custo_creditos: number
          p_duracao_s: number
          p_encerrada_em: string
          p_id_externo: string
          p_motivo_fim: string
          p_resumo: string
          p_status: Database["public"]["Enums"]["ligacao_status"]
          p_transcricao: Json
        }
        Returns: {
          conversa_id: string
          ligacao_id: string
        }[]
      }
      ligacao_iniciar:
        | {
            Args: {
              p_agente: string
              p_conexao: string
              p_direcao: Database["public"]["Enums"]["ligacao_direcao"]
              p_id_externo: string
              p_ids: Json
              p_momento: string
              p_nome_whatsapp: string
            }
            Returns: {
              conversa_id: string
              ligacao_id: string
              motivo: string
              permitida: boolean
            }[]
          }
        | {
            Args: {
              p_agente: string
              p_conexao: string
              p_conferir_conta: boolean
              p_direcao: Database["public"]["Enums"]["ligacao_direcao"]
              p_id_externo: string
              p_ids: Json
              p_momento: string
              p_nome_whatsapp: string
            }
            Returns: {
              conversa_id: string
              ligacao_id: string
              motivo: string
              permitida: boolean
            }[]
          }
      ligacao_iniciar_saida:
        | {
            Args: { p_agente: string; p_conversa: string; p_momento: string }
            Returns: {
              id_externo: string
              ligacao_id: string
              motivo: string
              permitida: boolean
            }[]
          }
        | {
            Args: {
              p_agente: string
              p_conversa: string
              p_momento: string
              p_objetivo: string
            }
            Returns: {
              id_externo: string
              ligacao_id: string
              motivo: string
              permitida: boolean
            }[]
          }
      ligacao_passar_para_equipe: {
        Args: { p_ligacao: string }
        Returns: boolean
      }
      ligacao_permissao_registrar: {
        Args: {
          p_conexao: string
          p_conversa: string
          p_membro: string
          p_momento: string
          p_texto: string
          p_wamid: string
        }
        Returns: string
      }
      ligacao_permissao_responder: {
        Args: {
          p_conexao: string
          p_expira_em: string
          p_momento: string
          p_pedido_wamid: string
          p_permanente: boolean
          p_resposta: string
          p_texto: string
        }
        Returns: number
      }
      ligacao_rearmar_depois: { Args: { p_ligacao: string }; Returns: boolean }
      ligacao_saida_confirmar: {
        Args: { p_id_externo: string; p_ligacao: string }
        Returns: boolean
      }
      ligacao_teto: {
        Args: { p_agente: string; p_iniciada_em: string }
        Returns: string
      }
      manutencao_nina: { Args: never; Returns: undefined }
      marcar_lida: { Args: { p_conversa: string }; Returns: undefined }
      marcar_visto: { Args: { p_onde: string }; Returns: string }
      membro_atual: { Args: never; Returns: string }
      mensagem_da_conversa: {
        Args: { p_conversa: string; p_msg: string }
        Returns: boolean
      }
      motor_confere: { Args: { p_chave: string }; Returns: boolean }
      motor_endereco: { Args: { p_url: string }; Returns: boolean }
      motor_pendencias: {
        Args: never
        Returns: {
          atrasado_desde: string
          proximo_em: string
          vencido_desde: string
        }[]
      }
      motor_pendencias_com_retornos: {
        Args: never
        Returns: {
          atrasado_desde: string
          proximo_em: string
          vencido_desde: string
        }[]
      }
      nina_atualizar_contato: {
        Args: { p_campos: Json; p_rodada: string }
        Returns: undefined
      }
      nina_cancelar_retorno: {
        Args: { p_motivo: string; p_rodada: string }
        Returns: Json
      }
      nina_marcar_retorno: {
        Args: {
          p_data: string
          p_hora: string
          p_motivo: string
          p_rodada: string
        }
        Returns: Json
      }
      nina_mover_etapa: {
        Args: { p_etapa: string; p_rodada: string }
        Returns: undefined
      }
      nina_passar_para_humano: {
        Args: { p_rodada: string }
        Returns: undefined
      }
      nina_retorno_da_rodada: { Args: { p_rodada: string }; Returns: Json }
      pegar_envios: {
        Args: { p_limite: number }
        Returns: {
          apagada_em: string | null
          autor_membro_id: string | null
          conexao_id: string
          conversa_id: string
          criado_em: string
          direcao: Database["public"]["Enums"]["mensagem_direcao"]
          editada: boolean
          enviar_apos: string | null
          erro: string | null
          evento_id: number | null
          id: string
          id_externo: string | null
          id_gateway: string | null
          midia_caminho: string | null
          midia_duracao_s: number | null
          midia_mime: string | null
          midia_nome: string | null
          midia_pega_em: string | null
          midia_ref_externa: string | null
          midia_status: Database["public"]["Enums"]["midia_status"] | null
          midia_tamanho: number | null
          midia_tentativas: number
          momento: string
          ordem: number | null
          origem: Database["public"]["Enums"]["mensagem_origem"]
          reenvios: number
          responde_a_id: string | null
          rodada_id: string | null
          status: Database["public"]["Enums"]["mensagem_status"]
          status_em: string | null
          tentativas: number
          texto: string | null
          tipo: Database["public"]["Enums"]["mensagem_tipo"]
          transcricao: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "mensagens"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      pegar_eventos_pendentes: {
        Args: { p_limite: number }
        Returns: {
          conexao_id: string
          gateway: Database["public"]["Enums"]["gateway"]
          id: number
          payload: Json
          tentativas: number
        }[]
      }
      pegar_midias: {
        Args: { p_limite: number }
        Returns: {
          apagada_em: string | null
          autor_membro_id: string | null
          conexao_id: string
          conversa_id: string
          criado_em: string
          direcao: Database["public"]["Enums"]["mensagem_direcao"]
          editada: boolean
          enviar_apos: string | null
          erro: string | null
          evento_id: number | null
          id: string
          id_externo: string | null
          id_gateway: string | null
          midia_caminho: string | null
          midia_duracao_s: number | null
          midia_mime: string | null
          midia_nome: string | null
          midia_pega_em: string | null
          midia_ref_externa: string | null
          midia_status: Database["public"]["Enums"]["midia_status"] | null
          midia_tamanho: number | null
          midia_tentativas: number
          momento: string
          ordem: number | null
          origem: Database["public"]["Enums"]["mensagem_origem"]
          reenvios: number
          responde_a_id: string | null
          rodada_id: string | null
          status: Database["public"]["Enums"]["mensagem_status"]
          status_em: string | null
          tentativas: number
          texto: string | null
          tipo: Database["public"]["Enums"]["mensagem_tipo"]
          transcricao: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "mensagens"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      pegar_rodadas: {
        Args: { p_limite: number }
        Returns: {
          contexto_versao_id: number | null
          conversa_id: string
          criado_em: string
          ferramentas: Json
          foi_para_equipe: boolean
          id: string
          iniciada_em: string
          modelo: string | null
          motivo: Database["public"]["Enums"]["motivo_humano"] | null
          passos: number
          passou_humano: boolean
          provedor: Database["public"]["Enums"]["ia_provedor"] | null
          retorno_id: string | null
          status: Database["public"]["Enums"]["rodada_status"]
          tentativa: number
          terminada_em: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "rodadas"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      pegar_rodadas_com_retornos: {
        Args: { p_limite: number; p_limite_puras: number }
        Returns: {
          contexto_versao_id: number | null
          conversa_id: string
          criado_em: string
          ferramentas: Json
          foi_para_equipe: boolean
          id: string
          iniciada_em: string
          modelo: string | null
          motivo: Database["public"]["Enums"]["motivo_humano"] | null
          passos: number
          passou_humano: boolean
          provedor: Database["public"]["Enums"]["ia_provedor"] | null
          retorno_id: string | null
          status: Database["public"]["Enums"]["rodada_status"]
          tentativa: number
          terminada_em: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "rodadas"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      preparar_copia: { Args: never; Returns: string }
      reativar_membro: { Args: { p_membro: string }; Returns: undefined }
      reenviar_mensagem: { Args: { p_msg: string }; Returns: undefined }
      registrar_entrada: {
        Args: {
          p_conexao: string
          p_ids: Json
          p_msg: Json
          p_nome_whatsapp: string
        }
        Returns: {
          conversa_id: string
          mensagem_id: string
          nova: boolean
        }[]
      }
      registrar_saida_celular: {
        Args: { p_conexao: string; p_ids: Json; p_msg: Json }
        Returns: string
      }
      relogio_retornos: { Args: never; Returns: undefined }
      reordenar_etapas: { Args: { p_ids: string[] }; Returns: undefined }
      retorno_ao_concluir: {
        Args: {
          p_bolhas: number
          p_descartou: boolean
          p_erro: string
          p_ferramentas: Json
          p_mista: boolean
          p_passos: number
          p_rodada: string
          p_status: Database["public"]["Enums"]["mensagem_status"]
        }
        Returns: undefined
      }
      retorno_ao_falhar: {
        Args: {
          p_modo: Database["public"]["Enums"]["conversa_modo"]
          p_passageiro: boolean
          p_rodada: string
          p_tentativa: number
        }
        Returns: undefined
      }
      retorno_conversa_livre: { Args: { p_conversa: string }; Returns: boolean }
      retorno_instante: {
        Args: { p_data: string; p_hora: string }
        Returns: string
      }
      retorno_pelas_bolhas: { Args: { p_retorno: string }; Returns: undefined }
      retorno_volta: {
        Args: { p_quando: string; p_retorno: string; p_rodada: string }
        Returns: undefined
      }
      retornos_ligados: { Args: never; Returns: boolean }
      retornos_no_ar: { Args: never; Returns: boolean }
      retornos_prontos: {
        Args: never
        Returns: {
          conversa_id: string
          pronto_em: string
          retorno_id: string
          tipo: Database["public"]["Enums"]["retorno_tipo"]
        }[]
      }
      retornos_varrer: { Args: { p_max?: number }; Returns: number }
      rodada_rodando: {
        Args: { p_rodada: string }
        Returns: {
          contexto_versao_id: number | null
          conversa_id: string
          criado_em: string
          ferramentas: Json
          foi_para_equipe: boolean
          id: string
          iniciada_em: string
          modelo: string | null
          motivo: Database["public"]["Enums"]["motivo_humano"] | null
          passos: number
          passou_humano: boolean
          provedor: Database["public"]["Enums"]["ia_provedor"] | null
          retorno_id: string | null
          status: Database["public"]["Enums"]["rodada_status"]
          tentativa: number
          terminada_em: string | null
        }
        SetofOptions: {
          from: "*"
          to: "rodadas"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      rodada_tem_fala_do_lead: { Args: { p_rodada: string }; Returns: boolean }
      rotulo_da_ligacao: {
        Args: {
          p_duracao_s: number
          p_status: Database["public"]["Enums"]["ligacao_status"]
        }
        Returns: string
      }
      texto_busca: { Args: { p_texto: string }; Returns: string }
      texto_normalizado: { Args: { p_texto: string }; Returns: string }
      tipo_de_mensagem: {
        Args: { p_tipo: string }
        Returns: Database["public"]["Enums"]["mensagem_tipo"]
      }
      trocar_papel_membro: {
        Args: {
          p_membro: string
          p_papel: Database["public"]["Enums"]["papel_membro"]
        }
        Returns: undefined
      }
      whatsapp_conectado_desde: { Args: never; Returns: string }
    }
    Enums: {
      auditoria_acao:
        | "chave_cadastrada"
        | "chave_trocada"
        | "chave_removida"
        | "chave_recusada"
        | "conexao_criada"
        | "conexao_ativada"
        | "conexao_desativada"
        | "membro_convidado"
        | "membro_desativado"
        | "membro_papel_trocado"
        | "contato_apagado"
        | "membro_reativado"
        | "convite_reenviado"
        | "convite_cancelado"
        | "membro_entrou"
        | "ritmo_alterado"
        | "voz_alterada"
      chamada_tipo: "resposta" | "transcricao" | "onboarding" | "fala"
      chave_status: "ativa" | "invalida" | "sem_credito" | "removida"
      conexao_status: "conectando" | "conectada" | "desconectada" | "erro"
      contexto_origem: "onboarding" | "edicao" | "restauracao"
      conversa_evento_tipo:
        | "passou"
        | "assumiu"
        | "devolveu"
        | "celular"
        | "voltou_para_fila"
      conversa_modo: "nina" | "humano"
      custo_origem: "provedor" | "tabela" | "sem_preco"
      etapa_tipo: "aberta" | "ganho" | "perdido"
      gateway: "meta" | "zernio" | "lovable" | "zapi" | "evolution"
      historico_ator: "membro" | "nina" | "sistema"
      ia_finalidade: "resposta" | "transcricao" | "voz"
      ia_provedor: "anthropic" | "openai" | "openrouter" | "groq" | "elevenlabs"
      identificador_tipo: "telefone" | "bsuid" | "lid" | "zernio_conversa"
      ligacao_agente_uso: "receber" | "ligar"
      ligacao_direcao: "entrada" | "saida"
      ligacao_objetivo: "vendas" | "suporte" | "outro"
      ligacao_perfil: "recomendado" | "rapido" | "caprichado"
      ligacao_status: "em_andamento" | "concluida" | "nao_completada"
      mensagem_direcao: "entrada" | "saida"
      mensagem_origem: "lead" | "nina" | "humano_tela" | "humano_celular"
      mensagem_status:
        | "recebida"
        | "na_fila"
        | "enviando"
        | "enviada"
        | "entregue"
        | "lida"
        | "falhou"
        | "cancelada"
      mensagem_tipo:
        | "texto"
        | "imagem"
        | "audio"
        | "video"
        | "documento"
        | "figurinha"
        | "outro"
        | "ligacao"
        | "permissao_ligacao"
      midia_status: "pendente" | "copiada" | "falhou" | "expirada"
      motivo_humano:
        | "nina_passou"
        | "humano_tela"
        | "humano_celular"
        | "chave_invalida"
        | "sem_credito"
        | "audio_sem_transcricao"
        | "limite_passos"
        | "erro_provedor"
        | "envio_falhou"
      papel_membro: "admin" | "atendente"
      retorno_status:
        | "pendente"
        | "em_rodada"
        | "saindo"
        | "enviado"
        | "dispensado"
        | "cancelado"
        | "nao_enviado"
      retorno_tipo: "retorno" | "lembrete"
      rodada_status: "rodando" | "concluida" | "falhou" | "cancelada"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      auditoria_acao: [
        "chave_cadastrada",
        "chave_trocada",
        "chave_removida",
        "chave_recusada",
        "conexao_criada",
        "conexao_ativada",
        "conexao_desativada",
        "membro_convidado",
        "membro_desativado",
        "membro_papel_trocado",
        "contato_apagado",
        "membro_reativado",
        "convite_reenviado",
        "convite_cancelado",
        "membro_entrou",
        "ritmo_alterado",
        "voz_alterada",
      ],
      chamada_tipo: ["resposta", "transcricao", "onboarding", "fala"],
      chave_status: ["ativa", "invalida", "sem_credito", "removida"],
      conexao_status: ["conectando", "conectada", "desconectada", "erro"],
      contexto_origem: ["onboarding", "edicao", "restauracao"],
      conversa_evento_tipo: [
        "passou",
        "assumiu",
        "devolveu",
        "celular",
        "voltou_para_fila",
      ],
      conversa_modo: ["nina", "humano"],
      custo_origem: ["provedor", "tabela", "sem_preco"],
      etapa_tipo: ["aberta", "ganho", "perdido"],
      gateway: ["meta", "zernio", "lovable", "zapi", "evolution"],
      historico_ator: ["membro", "nina", "sistema"],
      ia_finalidade: ["resposta", "transcricao", "voz"],
      ia_provedor: ["anthropic", "openai", "openrouter", "groq", "elevenlabs"],
      identificador_tipo: ["telefone", "bsuid", "lid", "zernio_conversa"],
      ligacao_agente_uso: ["receber", "ligar"],
      ligacao_direcao: ["entrada", "saida"],
      ligacao_objetivo: ["vendas", "suporte", "outro"],
      ligacao_perfil: ["recomendado", "rapido", "caprichado"],
      ligacao_status: ["em_andamento", "concluida", "nao_completada"],
      mensagem_direcao: ["entrada", "saida"],
      mensagem_origem: ["lead", "nina", "humano_tela", "humano_celular"],
      mensagem_status: [
        "recebida",
        "na_fila",
        "enviando",
        "enviada",
        "entregue",
        "lida",
        "falhou",
        "cancelada",
      ],
      mensagem_tipo: [
        "texto",
        "imagem",
        "audio",
        "video",
        "documento",
        "figurinha",
        "outro",
        "ligacao",
        "permissao_ligacao",
      ],
      midia_status: ["pendente", "copiada", "falhou", "expirada"],
      motivo_humano: [
        "nina_passou",
        "humano_tela",
        "humano_celular",
        "chave_invalida",
        "sem_credito",
        "audio_sem_transcricao",
        "limite_passos",
        "erro_provedor",
        "envio_falhou",
      ],
      papel_membro: ["admin", "atendente"],
      retorno_status: [
        "pendente",
        "em_rodada",
        "saindo",
        "enviado",
        "dispensado",
        "cancelado",
        "nao_enviado",
      ],
      retorno_tipo: ["retorno", "lembrete"],
      rodada_status: ["rodando", "concluida", "falhou", "cancelada"],
    },
  },
} as const
