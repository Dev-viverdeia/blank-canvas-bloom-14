-- Voz da Nina (ElevenLabs): valores novos dos enums. Só acrescenta.
alter type public.ia_provedor add value if not exists 'elevenlabs';
alter type public.ia_finalidade add value if not exists 'voz';