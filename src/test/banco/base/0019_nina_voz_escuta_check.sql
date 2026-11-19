-- A chave da ElevenLabs também na escuta (B1): troca o check da
-- 0012, que prendia a ElevenLabs à linha da voz, por um que aceita a voz e a escuta. Um ALTER só,
-- atômico, que pode rodar duas vezes. A linha da voz continua só com a ElevenLabs
-- (ia_chaves_voz_so_elevenlabs, da 0012, fica como está).
alter table public.ia_chaves
  drop constraint if exists ia_chaves_elevenlabs_so_voz,
  drop constraint if exists ia_chaves_elevenlabs_voz_ou_escuta,
  add constraint ia_chaves_elevenlabs_voz_ou_escuta
    check (provedor::text <> 'elevenlabs' or finalidade::text in ('voz', 'transcricao'));