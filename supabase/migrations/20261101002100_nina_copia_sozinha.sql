-- nina_copia_sozinha (seção 2, envio M2): a cópia do remix se
-- prepara sozinha, e o relógio de manutenção só de banco. Depende do envio M1
-- (nina_motor_acordado), que cria public.motor.
--
-- O remix copia só a estrutura do banco (remix de teste de 03/11/2026). Na cópia faltam: os dados
-- iniciais da 0001 e da 0015, o gatilho da 1ª conta em auth.users, as 8 tabelas do tempo real e os
-- agendamentos. preparar_copia() refaz tudo isso no primeiro acesso, chamada pelo servidor:
--   - os dados iniciais, só uma vez (preparada_em nulo). No original a linha do motor nasce
--     preparada (M1): uma etapa apagada pelo admin não volta;
--   - o gatilho, o tempo real e o relógio, sempre que a cópia não está 'pronta' (o relógio
--     instalado há mais de 1 dia é instalado de novo, sem mexer nos dados).
-- O relógio (nina-relogio, de hora em hora) só roda SQL: select public.manutencao_nina(), que
-- apaga os eventos do webhook com mais de 30 dias. Este envio não chama a internet.
-- Não grava endereço do app, segredo, id de usuário nem e-mail. Sem BEGIN/COMMIT.

-- O pg_cron já existe no original e na cópia (remix de teste de 03/11/2026): esta linha não muda
-- nada lá, e só garante a extensão num banco refeito do zero.
create extension if not exists pg_cron with schema pg_catalog;

-- ---------------------------------------------------------------------------
-- 1. A manutenção do relógio (só o dono, pelo cron)
-- ---------------------------------------------------------------------------
-- Apaga os eventos do webhook recebidos há mais de 30 dias (a limpeza saiu do motor). As mensagens
-- que apontam para eles ficam com evento_id nulo (on delete set null, 0000).
create or replace function public.manutencao_nina()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.eventos_webhook e
   where e.recebido_em < now() - interval '30 days';
end;
$$;

revoke execute on function public.manutencao_nina() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. A cópia se prepara sozinha (servidor)
-- ---------------------------------------------------------------------------
-- 'pronta': já preparada e com o relógio instalado há menos de 1 dia (nada a fazer).
-- 'preparada': fez o que faltava (também quando só o relógio falhou: aí relogio_em fica nulo). A
-- linha do motor fica travada até o fim: duas chamadas ao mesmo tempo preparam uma vez só (a 2ª
-- espera e devolve 'pronta').
-- Os dados iniciais são o mesmo SQL da 0001_nina_dados_iniciais e da 0015_nina_voz_uso_precos,
-- sem mudar valores (os comentários das duas estão lá). O gatilho é o da 0000 e o tempo real é o
-- da 0000 e da 0010.
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

    -- 0015_nina_voz_uso_precos, com a mesma proteção do valor de enum (55P04)
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
  end if;

  -- O gatilho da 1ª conta (o mesmo da 0000): a 1ª conta criada vira admin.
  create or replace trigger membros_primeira_conta
    after insert on auth.users
    for each row execute function public.tg_auth_primeira_conta();

  -- As 8 tabelas do tempo real (as mesmas da 0000 e da 0010).
  foreach v_tabela in array array['contato_etapa_historico', 'contatos', 'conversa_eventos', 'conversas',
                                  'etapas', 'membros', 'mensagens', 'rodadas'] loop
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
