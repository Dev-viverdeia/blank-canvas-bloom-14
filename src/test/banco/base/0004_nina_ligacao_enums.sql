-- =====================================================================
-- Ligar as telas ao banco, envio 1: enums.
-- Contrato: seção 2.3 (envio 1).
-- Vai num envio separado: valor novo de enum só pode ser usado depois que a
-- transação que o criou terminou. Os envios 2 a 4 usam estes valores.
-- Sem BEGIN/COMMIT.
-- =====================================================================

-- Auditoria: ações novas da Equipe e da Configuração.
alter type public.auditoria_acao add value if not exists 'membro_reativado';
alter type public.auditoria_acao add value if not exists 'convite_reenviado';
alter type public.auditoria_acao add value if not exists 'convite_cancelado';
alter type public.auditoria_acao add value if not exists 'membro_entrou';
alter type public.auditoria_acao add value if not exists 'ritmo_alterado';

-- Eventos da conversa (passagens entre a Nina, a fila e as pessoas).
create type public.conversa_evento_tipo as enum ('passou', 'assumiu', 'devolveu', 'celular', 'voltou_para_fila');