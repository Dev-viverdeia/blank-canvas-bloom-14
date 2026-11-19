-- 02-dados-iniciais.sql
-- Dados iniciais da Nina nova: etapas do funil, linha unica de configuracao e
-- tabela de precos da IA. Depende so do 01-estrutura.sql.
--
-- Pode rodar duas vezes sem duplicar: todo insert usa "on conflict (colunas)
-- do nothing". Por isso uma etapa editada pelo admin (nome, cor, ordem) ou um
-- valor de configuracao trocado nao volta ao padrao ao reaplicar.
--
-- Nao grava usuario, id de auth.users nem e-mail de pessoa.

-- ---------------------------------------------------------------------------
-- 1. Etapas do funil (spec, decisao 4)
-- cor fica nula: a tela escolhe. Todo lead novo entra na etapa aberta de menor
-- ordem (Novo). A Nina so pode mover para Em qualificacao, Qualificado e Perdido.
-- ---------------------------------------------------------------------------
insert into public.etapas (chave, nome, ordem, tipo, nina_pode_mover) values
  ('novo',           'Novo',            10, 'aberta', false),
  ('em_qualificacao','Em qualificação', 20, 'aberta', true),
  ('qualificado',    'Qualificado',     30, 'aberta', true),
  ('em_negociacao',  'Em negociação',   40, 'aberta', false),
  ('ganho',          'Ganho',           50, 'ganho',  false),
  ('perdido',        'Perdido',         60, 'perdido', true)
on conflict (chave) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Configuracao (linha unica, id 1, valores padrao da tabela)
-- ---------------------------------------------------------------------------
insert into public.configuracao (id) values (1)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Precos da IA (US$ por 1 milhao de tokens; audio em US$ por minuto)
--
-- Fonte unica: a spec (secoes "Modelos sugeridos" de 1 e 2,
-- "Custo e uso", secao 4, subsecao 4 "Audio do WhatsApp", e as conferencias, que
-- valem sobre a pesquisa). So entra preco escrito la. O que a pesquisa nao da
-- fica nulo. Nada foi estimado nem arredondado; a unica conta e a do Groq (preco
-- oficial por hora dividido por 60). Nenhum preco foi derivado de outro por
-- multiplicador (ex.: escrita de cache = 1,25 x entrada): onde a pesquisa da so a
-- regra, e nao o valor, a coluna fica nula.
-- OpenRouter nao entra: ela devolve o custo na resposta (custo_origem = provedor).
--
-- Colunas: provedor, modelo, vigente_desde, a_partir_de_tokens, entrada,
-- cache_leitura, cache_escrita, saida, audio_por_minuto, fonte.
--
-- a_partir_de_tokens: faixa por tamanho do prompt (entrada + cache). 0 = tabela
-- normal. O Haiku 5.5 cobra a tabela cara "acima de 100.000 tokens"; como token
-- e inteiro, "acima de 100.000" = "a partir de 100.001".
--
-- OpenAI: os precos listados valem para prompt de ate 272.000 tokens (conferencia,
-- lacuna "Preco por faixa"); acima disso a pesquisa da so a regra (entrada x2,
-- saida x1,5), sem o valor. Por isso cada modelo de chat da OpenAI que aceita mais
-- que isso (ou cujo limite a pesquisa nao da) tem uma faixa a partir de 272.001
-- tokens com todos os precos nulos: a chamada grande vira sem_preco em vez de ser
-- cobrada pelo preco normal. O gpt-5.4-mini aceita no maximo 272k de entrada.
--
-- cache_escrita: Anthropic = escrita de 5 min. OpenAI GPT-5.6 em diante = valor
-- da pesquisa; antes do GPT-5.6 (gpt-5.4-mini) a escrita nao e cobrada e a API
-- nem devolve cache_write_tokens: fica nula.
--
-- Limites desta tabela (pendencia para a feature de processamento, que calcula o
-- custo): nao ha coluna para escrita de cache de 1 h (Anthropic: Haiku 5.5 US$
-- 0,20, Sonnet 5.5 US$ 4, Opus 5.5 US$ 8), modo rapido do Opus 5.5 (US$ 8 / 40),
-- inference_geo "us" (x1,1) nem para a cobranca minima de 10 s do Groq. O calculo
-- deve dar sem_preco quando houver tokens de cache de 1 h, speed = fast ou
-- inference_geo = us, e aplicar o minimo de 10 s do Groq.
-- ---------------------------------------------------------------------------
insert into public.ia_precos
  (provedor, modelo, vigente_desde, a_partir_de_tokens,
   entrada, cache_leitura, cache_escrita, saida, audio_por_minuto, fonte)
values
  -- Anthropic: secao 1, tabela "Modelos sugeridos" + conferencia
  -- Haiku 5.5, prompt de ate 100.000 tokens
  ('anthropic', 'claude-haiku-5-5', '2026-10-28', 0,
   0.10, 0.01, 0.125, 0.50, null,
   'https://platform.claude.com/docs/en/models/haiku-5-5/overview'),
  -- Haiku 5.5, prompt acima de 100.000 tokens: so entrada e saida estao
  -- escritas (US$ 0,50 / 2,50). Os de cache dessa faixa a pesquisa so descreve
  -- como "tudo 5 vezes mais caro", sem o valor: ficam nulos.
  ('anthropic', 'claude-haiku-5-5', '2026-10-28', 100001,
   0.50, null, null, 2.50, null,
   'https://platform.claude.com/docs/en/models/haiku-5-5/overview'),
  ('anthropic', 'claude-sonnet-5-5', '2026-10-28', 0,
   2, 0.10, 2.50, 10, null,
   'https://platform.claude.com/docs/en/about-claude/pricing'),
  ('anthropic', 'claude-opus-5-5', '2026-10-28', 0,
   4, 0.20, 5, 20, null,
   'https://platform.claude.com/docs/en/about-claude/pricing'),
  -- Fable 5.1: a pesquisa nao da o preco da escrita de cache
  ('anthropic', 'claude-fable-5-1', '2026-10-28', 0,
   10, 0.25, null, 50, null,
   'https://platform.claude.com/docs/en/about-claude/pricing'),
  -- Haiku 4.5 (legado): a pesquisa nao da o preco da escrita de cache. Id fixo
  -- da pesquisa (claude-haiku-4-5-20251001) e o apelido, com os mesmos precos,
  -- para o custo achar o preco pelos dois nomes.
  ('anthropic', 'claude-haiku-4-5-20251001', '2026-10-28', 0,
   1, 0.10, null, 5, null,
   'https://platform.claude.com/docs/en/about-claude/pricing'),
  ('anthropic', 'claude-haiku-4-5', '2026-10-28', 0,
   1, 0.10, null, 5, null,
   'https://platform.claude.com/docs/en/about-claude/pricing'),

  -- OpenAI: secao 2, tabela "Modelos sugeridos" + conferencia
  ('openai', 'gpt-6-luna', '2026-10-28', 0,
   0.10, 0.01, 0.125, 0.50, null,
   'https://developers.openai.com/api/docs/models/gpt-6-luna'),
  ('openai', 'gpt-6.1-terra', '2026-10-28', 0,
   1, 0.05, 1.25, 5, null,
   'https://developers.openai.com/api/docs/models/gpt-6.1-terra'),
  ('openai', 'gpt-6.1-sol', '2026-10-28', 0,
   2, 0.10, 2.50, 10, null,
   'https://developers.openai.com/api/docs/models/gpt-6.1-sol'),
  -- Astra: a pesquisa nao da o preco da escrita de cache
  ('openai', 'gpt-6-astra', '2026-10-28', 0,
   10, 1, null, 50, null,
   'https://developers.openai.com/api/docs/pricing'),
  -- gpt-5.4-mini e anterior ao GPT-5.6: nao cobra escrita de cache; a API nao
  -- devolve cache_write_tokens antes do GPT-5.6
  ('openai', 'gpt-5.4-mini', '2026-10-28', 0,
   0.75, 0.075, null, 4.50, null,
   'https://developers.openai.com/api/docs/models/gpt-5.4-mini'),
  -- Secao 2, "Incertezas" e "Lacunas" da conferencia: so entrada e saida
  ('openai', 'gpt-5.6-luna', '2026-10-28', 0,
   0.20, null, null, 1.20, null,
   'https://developers.openai.com/api/docs/pricing'),
  ('openai', 'gpt-5.6-terra', '2026-10-28', 0,
   2, null, null, 12, null,
   'https://developers.openai.com/api/docs/pricing'),
  -- gpt-6-sol aparece so na pagina de precos (conferencia, secao 2): entrada 2,
  -- cache lido 0,20, saida 10
  ('openai', 'gpt-6-sol', '2026-10-28', 0,
   2, 0.20, null, 10, null,
   'https://developers.openai.com/api/docs/pricing'),

  -- OpenAI, prompt acima de 272.000 tokens: sem preco (ver o comentario acima)
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

  -- Transcricao OpenAI: secao 4, subsecao 4 + conferencia da secao 4 (pagina de precos)
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

  -- Transcricao Groq: secao 4, subsecao 4 + conferencia da secao 4. O preco oficial e por
  -- hora (US$ 0,04 e US$ 0,111); por minuto e so a divisao por 60.
  ('groq', 'whisper-large-v3-turbo', '2026-10-28', 0,
   null, null, null, null, 0.04::numeric / 60,
   'https://console.groq.com/docs/speech-to-text'),
  ('groq', 'whisper-large-v3', '2026-10-28', 0,
   null, null, null, null, 0.111::numeric / 60,
   'https://console.groq.com/docs/speech-to-text')
on conflict (provedor, modelo, vigente_desde, a_partir_de_tokens) do nothing;