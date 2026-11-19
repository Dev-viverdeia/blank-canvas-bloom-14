-- Voz em uso (a Nina fala e ouve com a ElevenLabs): valores novos dos enums. Só acrescenta.
-- Fica numa migration só dela: o valor novo de um enum só pode ser usado depois do commit.
alter type public.chamada_tipo add value if not exists 'fala';
alter type public.auditoria_acao add value if not exists 'voz_alterada';