-- nina_lacunas_enums (envio L1 das lacunas da mensageria, 02/11/2026).
-- Motivo novo para a conversa que vai para a equipe porque uma bolha da Nina
-- falhou de vez no envio ("Mensagem da Nina não entregue").
-- Vai sozinho, antes do L2: um valor novo de enum só pode ser usado depois que
-- a transação que o criou termina.
alter type public.motivo_humano add value if not exists 'envio_falhou';