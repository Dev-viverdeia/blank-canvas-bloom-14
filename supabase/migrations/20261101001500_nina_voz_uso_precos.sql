-- Preços da ElevenLabs (voz da Nina), da página de preços da API conferida em 02/11/2026
-- (https://elevenlabs.io/pricing/api): iguais em todos os planos e cobrados em dólar. Os planos
-- pagos incluem caracteres e horas por mês, então o gasto real pode ficar abaixo deste preço de
-- lista. Dado inicial: pode rodar duas vezes sem duplicar.
-- Fala: US$ 0,08 por 1.000 caracteres (Multilingual v2), em por_mil_caracteres.
-- Transcrição: US$ 0,22 por hora (Scribe v2); por minuto é a divisão por 60.
-- O bloco protege o remix: se todas as migrations rodarem numa transação só, num Postgres antes do
-- 17, o valor 'elevenlabs' (acrescentado ao enum na 0011) ainda não pode ser usado e o insert daria
-- o erro 55P04. Aí os preços ficam de fora com um aviso, sem derrubar as outras migrations, e esta
-- migration é mandada de novo ("Depois do remix", dados iniciais).
do $$
begin
  insert into public.ia_precos
    (provedor, modelo, vigente_desde, a_partir_de_tokens,
     entrada, cache_leitura, cache_escrita, saida, audio_por_minuto, por_mil_caracteres, fonte)
  values
    ('elevenlabs', 'eleven_multilingual_v2', '2026-11-02', 0,
     null, null, null, null, null, 0.08,
     'https://elevenlabs.io/pricing/api'),
    ('elevenlabs', 'scribe_v2', '2026-11-02', 0,
     null, null, null, null, 0.22::numeric / 60, null,
     'https://elevenlabs.io/pricing/api')
  on conflict (provedor, modelo, vigente_desde, a_partir_de_tokens) do nothing;
exception when sqlstate '55P04' then
  raise warning 'precos_elevenlabs_nao_gravados';
end;
$$;