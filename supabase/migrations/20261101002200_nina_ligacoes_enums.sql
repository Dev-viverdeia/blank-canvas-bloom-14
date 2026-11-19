-- nina_ligacoes_enums (envio 1 de 4 da tela de Ligações, 12/11/2026).
-- A ligação passa a ser um tipo próprio de mensagem na conversa ('ligacao'), no lugar do 'outro'
-- com o texto "[ligação]" da primeira versão. Vai sozinho, antes do envio 2: um valor novo de enum
-- só pode ser usado depois que a transação que o criou termina.
alter type public.mensagem_tipo add value if not exists 'ligacao';