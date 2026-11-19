-- nina_permissao_no_chat_tipo (18/11/2026): o pedido de permissão para ligar e a resposta do lead
-- aparecem no chat (seção 3; pedido do Alexandre em 18/11/2026: "preciso
-- ver tudo que aparece no WhatsApp").
-- O valor novo do enum vai sozinho: ele só pode ser usado depois que esta transação termina.
-- Depende de: nina_ligacoes_enums (0022). Ordem: 1º envio (o 2º são as funções). Pode rodar duas
-- vezes. Sem BEGIN/COMMIT.
alter type public.mensagem_tipo add value if not exists 'permissao_ligacao';