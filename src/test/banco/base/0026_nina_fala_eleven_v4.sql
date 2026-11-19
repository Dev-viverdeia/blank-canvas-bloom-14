-- nina_fala_eleven_v4 (envio único, 13/11/2026, D4).
-- A fala da Nina (o áudio que ela manda no chat) passa do Multilingual v2 para o Eleven v4, o
-- modelo mais emotivo da ElevenLabs e da mesma família da voz das ligações. Este envio só traz o
-- preço do modelo novo, para o Dashboard mostrar o custo da fala: US$ 0,08 por 1.000 caracteres,
-- igual ao do v2 (https://elevenlabs.io/pricing/api, conferida em 13/11/2026). O preço do v2 fica,
-- para as falas antigas.
-- Depende da 0025 (nina_ligacoes_tempo_real): a preparar_copia parte do texto dela, com uma mudança
-- só, o preço novo junto dos outros da ElevenLabs, para a cópia de quem remixar ganhar o mesmo
-- (a regra do registro do projeto: dado inicial novo também entra na preparar_copia).
-- Dado inicial e função: pode rodar duas vezes sem duplicar.

-- ---------------------------------------------------------------------
-- Trava: sem a 0025 (a tabela de ligações no tempo real), este envio para aqui.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.ligacoes') is null then
    raise exception using message = 'falta_a_0025_ligacoes',
      hint = 'Aplique antes os envios da tela de Ligações (nina_ligacoes_tabelas e nina_ligacoes_tempo_real).';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 1. O preço do Eleven v4
-- ---------------------------------------------------------------------
insert into public.ia_precos
  (provedor, modelo, vigente_desde, a_partir_de_tokens,
   entrada, cache_leitura, cache_escrita, saida, audio_por_minuto, por_mil_caracteres, fonte)
values
  ('elevenlabs', 'eleven_v4', '2026-11-13', 0,
   null, null, null, null, null, 0.08,
   'https://elevenlabs.io/pricing/api')
on conflict (provedor, modelo, vigente_desde, a_partir_de_tokens) do nothing;

-- ---------------------------------------------------------------------
-- 2. A preparar_copia() com o preço novo (o resto igual à 0025)
-- ---------------------------------------------------------------------
create or replace function public.preparar_copia()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_preparada timestamptz;
  v_relogio   timestamptz;
  v_tabela    text;
begin
  select mo.preparada_em, mo.relogio_em into v_preparada, v_relogio
    from public.motor mo where mo.id;
  if v_preparada is not null and v_relogio > now() - interval '1 day' then
    return 'pronta';
  end if;

  insert into public.motor (id) values (true)
  on conflict (id) do nothing;
  select mo.preparada_em, mo.relogio_em into v_preparada, v_relogio
    from public.motor mo where mo.id
     for update;
  if v_preparada is not null and v_relogio > now() - interval '1 day' then
    return 'pronta';
  end if;

  if v_preparada is null then
    -- 0001_nina_dados_iniciais, 1. Etapas do funil
    insert into public.etapas (chave, nome, ordem, tipo, nina_pode_mover) values
      ('novo',           'Novo',            10, 'aberta', false),
      ('em_qualificacao','Em qualificação', 20, 'aberta', true),
      ('qualificado',    'Qualificado',     30, 'aberta', true),
      ('em_negociacao',  'Em negociação',   40, 'aberta', false),
      ('ganho',          'Ganho',           50, 'ganho',  false),
      ('perdido',        'Perdido',         60, 'perdido', true)
    on conflict (chave) do nothing;

    -- 0001_nina_dados_iniciais, 2. Configuracao
    insert into public.configuracao (id) values (1)
    on conflict (id) do nothing;

    -- 0001_nina_dados_iniciais, 3. Precos da IA
    insert into public.ia_precos
      (provedor, modelo, vigente_desde, a_partir_de_tokens,
       entrada, cache_leitura, cache_escrita, saida, audio_por_minuto, fonte)
    values
      ('anthropic', 'claude-haiku-5-5', '2026-10-28', 0,
       0.10, 0.01, 0.125, 0.50, null,
       'https://platform.claude.com/docs/en/models/haiku-5-5/overview'),
      ('anthropic', 'claude-haiku-5-5', '2026-10-28', 100001,
       0.50, null, null, 2.50, null,
       'https://platform.claude.com/docs/en/models/haiku-5-5/overview'),
      ('anthropic', 'claude-sonnet-5-5', '2026-10-28', 0,
       2, 0.10, 2.50, 10, null,
       'https://platform.claude.com/docs/en/about-claude/pricing'),
      ('anthropic', 'claude-opus-5-5', '2026-10-28', 0,
       4, 0.20, 5, 20, null,
       'https://platform.claude.com/docs/en/about-claude/pricing'),
      ('anthropic', 'claude-fable-5-1', '2026-10-28', 0,
       10, 0.25, null, 50, null,
       'https://platform.claude.com/docs/en/about-claude/pricing'),
      ('anthropic', 'claude-haiku-4-5-20251001', '2026-10-28', 0,
       1, 0.10, null, 5, null,
       'https://platform.claude.com/docs/en/about-claude/pricing'),
      ('anthropic', 'claude-haiku-4-5', '2026-10-28', 0,
       1, 0.10, null, 5, null,
       'https://platform.claude.com/docs/en/about-claude/pricing'),
      ('openai', 'gpt-6-luna', '2026-10-28', 0,
       0.10, 0.01, 0.125, 0.50, null,
       'https://developers.openai.com/api/docs/models/gpt-6-luna'),
      ('openai', 'gpt-6.1-terra', '2026-10-28', 0,
       1, 0.05, 1.25, 5, null,
       'https://developers.openai.com/api/docs/models/gpt-6.1-terra'),
      ('openai', 'gpt-6.1-sol', '2026-10-28', 0,
       2, 0.10, 2.50, 10, null,
       'https://developers.openai.com/api/docs/models/gpt-6.1-sol'),
      ('openai', 'gpt-6-astra', '2026-10-28', 0,
       10, 1, null, 50, null,
       'https://developers.openai.com/api/docs/pricing'),
      ('openai', 'gpt-5.4-mini', '2026-10-28', 0,
       0.75, 0.075, null, 4.50, null,
       'https://developers.openai.com/api/docs/models/gpt-5.4-mini'),
      ('openai', 'gpt-5.6-luna', '2026-10-28', 0,
       0.20, null, null, 1.20, null,
       'https://developers.openai.com/api/docs/pricing'),
      ('openai', 'gpt-5.6-terra', '2026-10-28', 0,
       2, null, null, 12, null,
       'https://developers.openai.com/api/docs/pricing'),
      ('openai', 'gpt-6-sol', '2026-10-28', 0,
       2, 0.20, null, 10, null,
       'https://developers.openai.com/api/docs/pricing'),
      ('openai', 'gpt-6-luna', '2026-10-28', 272001,
       null, null, null, null, null,
       'https://developers.openai.com/api/docs/pricing'),
      ('openai', 'gpt-6.1-terra', '2026-10-28', 272001,
       null, null, null, null, null,
       'https://developers.openai.com/api/docs/pricing'),
      ('openai', 'gpt-6.1-sol', '2026-10-28', 272001,
       null, null, null, null, null,
       'https://developers.openai.com/api/docs/pricing'),
      ('openai', 'gpt-6-astra', '2026-10-28', 272001,
       null, null, null, null, null,
       'https://developers.openai.com/api/docs/pricing'),
      ('openai', 'gpt-5.6-luna', '2026-10-28', 272001,
       null, null, null, null, null,
       'https://developers.openai.com/api/docs/pricing'),
      ('openai', 'gpt-5.6-terra', '2026-10-28', 272001,
       null, null, null, null, null,
       'https://developers.openai.com/api/docs/pricing'),
      ('openai', 'gpt-6-sol', '2026-10-28', 272001,
       null, null, null, null, null,
       'https://developers.openai.com/api/docs/pricing'),
      ('openai', 'gpt-transcribe', '2026-10-28', 0,
       null, null, null, null, 0.0045,
       'https://developers.openai.com/api/docs/pricing'),
      ('openai', 'gpt-4o-transcribe', '2026-10-28', 0,
       null, null, null, null, 0.006,
       'https://developers.openai.com/api/docs/pricing'),
      ('openai', 'gpt-4o-mini-transcribe', '2026-10-28', 0,
       null, null, null, null, 0.003,
       'https://developers.openai.com/api/docs/pricing'),
      ('openai', 'whisper-1', '2026-10-28', 0,
       null, null, null, null, 0.006,
       'https://developers.openai.com/api/docs/pricing'),
      ('groq', 'whisper-large-v3-turbo', '2026-10-28', 0,
       null, null, null, null, 0.04::numeric / 60,
       'https://console.groq.com/docs/speech-to-text'),
      ('groq', 'whisper-large-v3', '2026-10-28', 0,
       null, null, null, null, 0.111::numeric / 60,
       'https://console.groq.com/docs/speech-to-text')
    on conflict (provedor, modelo, vigente_desde, a_partir_de_tokens) do nothing;

    -- 0015_nina_voz_uso_precos e nina_fala_eleven_v4, com a mesma proteção do valor de enum (55P04)
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
         'https://elevenlabs.io/pricing/api'),
        -- nina_fala_eleven_v4: o modelo da fala desde 13/11/2026
        ('elevenlabs', 'eleven_v4', '2026-11-13', 0,
         null, null, null, null, null, 0.08,
         'https://elevenlabs.io/pricing/api')
      on conflict (provedor, modelo, vigente_desde, a_partir_de_tokens) do nothing;
    exception when sqlstate '55P04' then
      raise warning 'precos_elevenlabs_nao_gravados';
    end;
  end if;

  -- O gatilho da 1ª conta (o mesmo da 0000): a 1ª conta criada vira admin.
  create or replace trigger membros_primeira_conta
    after insert on auth.users
    for each row execute function public.tg_auth_primeira_conta();

  -- As 9 tabelas do tempo real (as mesmas da 0000 e da 0010, mais ligacoes, do envio 4 das
  -- ligações).
  foreach v_tabela in array array['contato_etapa_historico', 'contatos', 'conversa_eventos', 'conversas',
                                  'etapas', 'ligacoes', 'membros', 'mensagens', 'rodadas'] loop
    if not exists (select 1 from pg_catalog.pg_publication_tables pt
                    where pt.pubname = 'supabase_realtime' and pt.schemaname = 'public'
                      and pt.tablename = v_tabela) then
      execute format('alter publication supabase_realtime add table public.%I', v_tabela);
    end if;
  end loop;

  -- O relógio: com o mesmo nome, o pg_cron troca o job que já existe em vez de criar outro. É a
  -- peça menos essencial: se o cron recusar, o resto fica gravado, relogio_em fica nulo e a
  -- chamada seguinte tenta só o relógio de novo (os dados iniciais não voltam).
  begin
    perform cron.schedule('nina-relogio', '17 * * * *', 'select public.manutencao_nina()');
    v_relogio := now();
  exception when others then
    raise warning 'relogio_nao_instalado: %', sqlerrm;
    v_relogio := null;
  end;

  update public.motor mo
     set preparada_em = coalesce(mo.preparada_em, now()),
         relogio_em = v_relogio
   where mo.id;
  return 'preparada';
end;
$$;

revoke execute on function public.preparar_copia() from public, anon, authenticated;
grant execute on function public.preparar_copia() to service_role;