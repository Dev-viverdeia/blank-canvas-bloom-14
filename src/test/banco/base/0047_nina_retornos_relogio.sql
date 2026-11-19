-- lovable-cron-fallback-reviewed: job nina-retornos a cada minuto, comando SQL puro (select public.relogio_retornos()), revisado pelo dono do projeto
-- nina_retornos_relogio (envio 6 de 6 dos retornos, 18/11/2026).
-- O relógio dos retornos: um 2º job do pg_cron, nina-retornos, a cada minuto, cujo comando é um
-- select de uma função do public: a relogio_retornos() (nina_retornos_funcoes). Ela fecha os
-- retornos que não podem sair (com a equipe na hora marcada, fora das 24 h da oficial, mais de 3 h
-- depois da hora), acompanha os que estão saindo e, quando há retorno ou lembrete pronto, acorda o
-- worker do app: a relogio_retornos (nina_retornos_funcoes) chama a acordar_motor (base 0020), o
-- mesmo caminho que o nina-relogio já usa pela manutencao_nina para a ligação presa (base 0030).
-- Este envio, ele mesmo, não faz pedido HTTP nem lê a lista de jobs do cron. O job nina-relogio,
-- de hora em hora, não muda.
-- Quando o job começa: na próxima chamada da preparar_copia() pelo servidor, que acontece na
-- próxima passada do worker numa instância que ainda não a chamou na última 1 h (cada instância
-- lembra o resultado por 1 h) ou na primeira página aberta numa instância nova. Isso vale mesmo
-- com o código antigo ainda publicado. Sem retorno gravado o job só varre uma tabela vazia e não
-- acorda o worker. Os dois jobs aparecem na tela de Jobs depois dessa chamada: com o app em uso,
-- em até 1 h (cada instância chama a preparar_copia() de novo 1 h depois da última). Antes disso,
-- ver um job só não quer dizer que o envio falhou. Para conferir sem esperar a tela, por SELECT
-- puro: select relogio_versao, relogio_em from public.motor (só essas duas colunas; nunca select *
-- nem a coluna chave, que é o segredo do worker). Versão 1 com relogio_em depois da hora em que
-- este envio foi aplicado: os dois jobs entraram. Versão 0 com relogio_em depois dessa hora: o
-- nina-relogio entrou e o nina-retornos foi recusado pelo cron (parar e levar ao Davi). relogio_em
-- de antes dessa hora: a preparar_copia() nova ainda não rodou (esperar ou abrir uma página). Se
-- a leitura da tabela motor não estiver disponível, este é um passo manual na tela de Jobs.
-- Recria a preparar_copia() (texto da base 0026, mesma assinatura, os mesmos 'pronta' e
-- 'preparada', os mesmos grants), com as mudanças marcadas "novo (retornos)":
--   1. a versão do relógio (motor.relogio_versao, do nina_retornos_tabelas): a função só devolve
--      'pronta' com o relógio da versão 1 (os dois jobs). Com 0 (o original e as cópias antes
--      deste envio), a próxima chamada refaz o gatilho da 1ª conta, o tempo real e os jobs, sem
--      semear de novo (a semeadura continua presa a preparada_em nulo);
--   2. os dois jobs em blocos separados: o nina-relogio, como na 0026 (se o cron o recusar,
--      relogio_em fica nulo), e depois o nina-retornos. Se só o nina-retornos for recusado, o
--      nina-relogio de hoje fica instalado;
--   3. a versão 1 gravada só quando os dois entraram; senão ela fica como estava, e a chamada
--      seguinte tenta os dois de novo.
-- A lista do tempo real NÃO muda: continuam 9 tabelas. A tabela retornos fica fora do tempo real
-- de propósito (a tela a relê quando rodadas ou mensagens mudam).
-- Depende de: nina_retornos_tabelas (motor.relogio_versao), nina_retornos_regras (a varredura e o
-- "pode sair" que a relogio_retornos usa), nina_retornos_funcoes (relogio_retornos) e
-- nina_retornos_rodada (o fim da rodada e o gatilho das bolhas). Não depende tecnicamente do
-- nina_retornos_dashboard, mas ele é obrigatório e vai antes deste: a trava o confere. Ordem: 6º e
-- último envio dos retornos, depois do nina_retornos_rodada e do nina_retornos_dashboard. Assim, os
-- dois jobs na tela de Jobs provam que o nina_retornos_tabelas, o nina_retornos_regras, o
-- nina_retornos_funcoes, o nina_retornos_rodada e o nina_retornos_dashboard estão no banco. Só com
-- este envio, e depois da primeira chamada da preparar_copia() nova (a versão 1 do relógio), a
-- pegar_rodadas_com_retornos, a nina_marcar_retorno e a lembrete_ao_concluir (nina_retornos_funcoes,
-- pela retornos_ligados) ligam os retornos.
-- Quando vai ao agente do Lovable:
-- por último, logo antes de publicar o código novo,
-- só quando o PR do código estiver verde e pronto para publicar, porque o job de minuto começa a
-- rodar na próxima chamada da preparar_copia(), mesmo com o código antigo no ar. Logo antes do
-- Publicar, conferir os dois jobs. Nenhuma tabela nem coluna muda e nada é semeado de novo. Só
-- acrescenta (a recriada mantém a assinatura). Pode rodar duas vezes. Sem BEGIN/COMMIT.
-- Parte do texto da base 0026 (preparar_copia): se outra migration recriar a função antes deste
-- envio, a trava recusa (funcao_mudou_antes_dos_retornos). Antes de mandar: conferir na base se uma
-- migration posterior a recriou (dado inicial novo, por exemplo) e ler em produção, por SELECT
-- puro, o md5(prosrc) dela (select md5(p.prosrc) from pg_catalog.pg_proc p join
-- pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname =
-- 'preparar_copia'). Se o agente do Lovable tiver reformatado o corpo, a trava também recusa
-- (recusa segura): conferir o texto em produção e só trocar o hash da lista se a diferença for só
-- de forma. Se outra entrega mudou a função, refazer este envio a partir do texto dela (-- item 12) e trocar os dois hashes.

-- ---------------------------------------------------------------------
-- Trava: sem a base do relógio, o nina_retornos_tabelas, o nina_retornos_regras, o
-- nina_retornos_funcoes, o nina_retornos_rodada ou o nina_retornos_dashboard, este envio para aqui
-- (a mensagem diz o primeiro que falta). Depois, com a preparar_copia recriada por outra entrega depois do texto de
-- que este envio parte, também para.
-- ---------------------------------------------------------------------
do $$
declare
  v_mudou text;
begin
  if to_regprocedure('public.manutencao_nina()') is null then
    raise exception using message = 'falta_a_base_0037',
      hint = 'Este banco precisa do relógio da Nina (manutencao_nina, base 0030).';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'motor'
                    and column_name = 'relogio_versao') then
    raise exception using message = 'falta_nina_retornos_tabelas',
      hint = 'Aplique antes o nina_retornos_tabelas, o nina_retornos_regras, o nina_retornos_funcoes e o nina_retornos_rodada, nessa ordem, e o nina_retornos_dashboard.';
  end if;
  if to_regprocedure('public.retornos_varrer(integer)') is null
     or to_regprocedure('public.retornos_prontos()') is null then
    raise exception using message = 'falta_nina_retornos_regras',
      hint = 'Aplique antes o nina_retornos_regras, o nina_retornos_funcoes e o nina_retornos_rodada, nessa ordem, e o nina_retornos_dashboard.';
  end if;
  if to_regprocedure('public.relogio_retornos()') is null
     or to_regprocedure('public.retornos_ligados()') is null then
    raise exception using message = 'falta_nina_retornos_funcoes',
      hint = 'Aplique antes o nina_retornos_funcoes e o nina_retornos_rodada, nessa ordem, e o nina_retornos_dashboard.';
  end if;
  if to_regprocedure('public.tg_mensagens_saida_do_retorno()') is null
     or not exists (select 1 from pg_catalog.pg_trigger tg
                     where tg.tgrelid = to_regclass('public.mensagens')
                       and tg.tgname = 'mensagens_saida_do_retorno')
     or not exists (select 1 from pg_catalog.pg_proc p
                     where p.oid = to_regprocedure('public.concluir_rodada(uuid, jsonb, jsonb, integer)')
                       and p.prosrc like '%retorno_ao_concluir%') then
    raise exception using message = 'falta_nina_retornos_rodada',
      hint = 'Aplique antes o nina_retornos_rodada e o nina_retornos_dashboard.';
  end if;
  -- o nina_retornos_dashboard: não é dependência técnica, mas é obrigatório e vai antes deste (pelo
  -- texto, e não pelo md5: o agente do Lovable pode reformatar o corpo)
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = to_regprocedure('public.dashboard_periodo(timestamptz, timestamptz, timestamptz)')
                    and p.prosrc like '%retorno_id%') then
    raise exception using message = 'falta_nina_retornos_dashboard',
      hint = 'Aplique antes o nina_retornos_dashboard (obrigatório, vai antes deste).';
  end if;
  -- o texto em vigor: o da base de que este envio parte ou o deste envio (aplicado de novo)
  select string_agg(e.nome, ', ' order by e.nome) into v_mudou
    from (values
      ('preparar_copia', '1259ea4fb62d68c5cd2d5ba0b0a9094f', '9343fe5c3d1d95e3e96c89b1628c611b')
    ) e(nome, h_partida, h_envio)
    join pg_catalog.pg_proc p on p.proname = e.nome
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
   where md5(p.prosrc) not in (e.h_partida, e.h_envio);
  if v_mudou is not null then
    raise exception using message = 'funcao_mudou_antes_dos_retornos',
      hint = 'Recriadas por outra entrega depois do texto de partida deste envio: ' || v_mudou
             || '. Refaça este envio a partir do texto mais recente de cada uma na base (item 12) e troque os hashes da lista.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- A preparar_copia(): o texto da 0026, com as mudanças marcadas "novo (retornos)".
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
  v_versao    smallint;  -- novo (retornos)
  v_retornos_ok boolean := false;  -- novo (retornos)
begin
  -- novo (retornos): 'pronta' só com o relógio da versão 1 (os dois jobs)
  select mo.preparada_em, mo.relogio_em, mo.relogio_versao into v_preparada, v_relogio, v_versao
    from public.motor mo where mo.id;
  if v_preparada is not null and v_relogio > now() - interval '1 day'
     and coalesce(v_versao, 0) >= 1 then
    return 'pronta';
  end if;

  insert into public.motor (id) values (true)
  on conflict (id) do nothing;
  select mo.preparada_em, mo.relogio_em, mo.relogio_versao into v_preparada, v_relogio, v_versao
    from public.motor mo where mo.id
     for update;
  if v_preparada is not null and v_relogio > now() - interval '1 day'
     and coalesce(v_versao, 0) >= 1 then
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
  -- ligações). A tabela retornos fica de fora de propósito (nina_retornos_relogio).
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

  -- novo (retornos): o 2º job, nina-retornos, a cada minuto, num bloco só dele (se o cron o
  -- recusar, o nina-relogio acima fica); o comando também é um select de uma função do public.
  begin
    perform cron.schedule('nina-retornos', '* * * * *', 'select public.relogio_retornos()');
    v_retornos_ok := true;
  exception when others then
    raise warning 'relogio_retornos_nao_instalado: %', sqlerrm;
    v_retornos_ok := false;
  end;

  update public.motor mo
     set preparada_em = coalesce(mo.preparada_em, now()),
         relogio_em = v_relogio,
         -- novo (retornos): a versão 1 (os dois jobs) só quando os dois entraram; senão fica, e a
         -- chamada seguinte tenta de novo
         relogio_versao = case when v_relogio is not null and v_retornos_ok then 1
                               else mo.relogio_versao end
   where mo.id;
  return 'preparada';
end;
$$;

revoke execute on function public.preparar_copia() from public, anon, authenticated;
grant execute on function public.preparar_copia() to service_role;
