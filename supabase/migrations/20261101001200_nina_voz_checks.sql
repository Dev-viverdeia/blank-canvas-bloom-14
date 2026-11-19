-- A chave da ElevenLabs só fica na linha da voz, e a linha da voz só aceita a ElevenLabs (como ia_chaves_groq_so_transcricao).
-- Compara como texto para não usar o valor novo do enum: roda na mesma transação da migration 1, ou antes dela.
alter table public.ia_chaves
  add constraint ia_chaves_elevenlabs_so_voz check (provedor::text <> 'elevenlabs' or finalidade::text = 'voz'),
  add constraint ia_chaves_voz_so_elevenlabs check (finalidade::text <> 'voz' or provedor::text = 'elevenlabs');