-- Voz em uso (a Nina fala e ouve com a ElevenLabs): colunas novas e duas funções recriadas com a
-- mesma assinatura. Só acrescenta. Depende da migration dos enums (chamada_tipo 'fala').

-- configuracao: quando a Nina responde em áudio e com qual voz.
--   voz_resposta: 'quando_audio' (padrão: quando há um áudio do lead na rodada), 'sempre' ou 'nunca'.
--   voz_id / voz_nome: a voz da ElevenLabs escolhida (os dois juntos, ou nenhum). Sem voz, a
--   resposta vai em texto.
--   voz_erro: 'voz_nao_encontrada' quando a fala falhou porque a voz sumiu da conta; o servidor
--   limpa ao escolher uma voz ou quando uma fala com a mesma voz dá certo.
alter table public.configuracao
  add column voz_resposta text not null default 'quando_audio',
  add column voz_id text,
  add column voz_nome text,
  add column voz_erro text,
  add constraint configuracao_voz_resposta check (voz_resposta in ('quando_audio', 'sempre', 'nunca')),
  add constraint configuracao_voz_id check (voz_id is null or voz_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  add constraint configuracao_voz_nome check (
    (voz_id is null and voz_nome is null)
    or (voz_id is not null and voz_nome is not null
        and char_length(voz_nome) between 1 and 120 and btrim(voz_nome) <> '')
  ),
  add constraint configuracao_voz_erro check (voz_erro is null or voz_erro = 'voz_nao_encontrada');

-- ia_precos: preço por 1.000 caracteres (a fala da ElevenLabs cobra por caractere).
alter table public.ia_precos
  add column por_mil_caracteres numeric,
  add constraint ia_precos_por_mil_caracteres check (por_mil_caracteres is null or por_mil_caracteres >= 0);

-- ia_chamadas: caracteres cobrados numa fala.
alter table public.ia_chamadas
  add column caracteres integer,
  add constraint ia_chamadas_caracteres check (caracteres is null or caracteres >= 0);

-- ---------------------------------------------------------------------------
-- concluir_rodada (recriada, mesma assinatura). Cada item de p_respostas é um objeto:
--   {"texto": "..."}: mensagem de texto, como antes (um "tipo" que não seja 'audio' também conta
--   como texto);
--   {"tipo": "audio", "id": "<uuid>", "transcricao": "<o que a Nina falou>",
--    "midia_caminho": "<conversa_id>/<id>", "midia_mime": "audio/...", "midia_tamanho": <bytes>,
--    "midia_duracao_s": <segundos>}: áudio da Nina. O servidor já gravou o arquivo no bucket
--   midias com esse caminho; a mensagem nasce com esse id, texto nulo, o texto falado em
--   transcricao e midia_status = 'copiada'. Áudio fora do formato (id que não é uuid, caminho de
--   outra conversa, sem transcrição, mime que não é de áudio) é ignorado, como o texto vazio.
-- O resto não muda: ordem 1..n, enviar_apos = now() + (ordem-1) * 2 s, e as respostas entram como
-- 'cancelada' quando a conversa saiu do modo nina durante a rodada (exceção: a própria Nina passou
-- para humano e nenhum humano escreveu desde o início da rodada). Para o worker: 'sem_conexao_ativa'
-- ou 'janela_fechada' vindos daqui (gatilho do insert) não são passageiros.
-- ---------------------------------------------------------------------------
create or replace function public.concluir_rodada(
  p_rodada uuid, p_respostas jsonb, p_ferramentas jsonb, p_passos int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r       public.rodadas;
  v_c       public.conversas;
  v_status  public.mensagem_status;
  v_conexao uuid;
begin
  select * into v_r from public.rodadas r where r.id = p_rodada for update;
  if not found or v_r.status not in ('rodando', 'cancelada') then
    raise exception using message = 'rodada_nao_rodando', errcode = 'P0001';
  end if;

  select * into v_c from public.conversas c where c.id = v_r.conversa_id for update;

  if v_r.status = 'rodando'
     and (v_c.modo = 'nina' or coalesce(v_r.passou_humano, false))
     and not exists (select 1 from public.mensagens h
                     where h.conversa_id = v_c.id
                       and h.origem in ('humano_tela', 'humano_celular')
                       and h.criado_em >= v_r.iniciada_em) then
    v_status := 'na_fila';
  else
    v_status := 'cancelada';
  end if;

  select cx.id into v_conexao from public.conexoes cx where cx.ativa limit 1;
  v_conexao := coalesce(v_conexao, v_c.conexao_id);

  with itens as (
    select e.ord,
           case when e.val ->> 'tipo' = 'audio' then 'audio' else 'texto' end as tipo,
           e.val ->> 'texto' as texto,
           btrim(coalesce(e.val ->> 'transcricao', '')) as transcricao,
           case when (e.val ->> 'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then (e.val ->> 'id')::uuid end as id,
           e.val ->> 'midia_caminho' as caminho,
           e.val ->> 'midia_mime' as mime,
           -- CASE aninhado: só converte depois de saber que é número (a ordem de um AND não é garantida)
           case when jsonb_typeof(e.val -> 'midia_tamanho') = 'number' then
             case when (e.val ->> 'midia_tamanho')::numeric between 1 and 104857600
                  then round((e.val ->> 'midia_tamanho')::numeric)::bigint end
           end as tamanho,
           case when jsonb_typeof(e.val -> 'midia_duracao_s') = 'number' then
             case when (e.val ->> 'midia_duracao_s')::numeric between 0 and 86400
                  then round((e.val ->> 'midia_duracao_s')::numeric)::integer end
           end as duracao
    from jsonb_array_elements(case when jsonb_typeof(p_respostas) = 'array' then p_respostas else '[]'::jsonb end)
         with ordinality as e(val, ord)
    where jsonb_typeof(e.val) = 'object'
  ), validos as (
    select i.*, row_number() over (order by i.ord) as n
    from itens i
    where (i.tipo = 'texto' and btrim(coalesce(i.texto, '')) <> '')
       or (i.tipo = 'audio'
           and i.id is not null
           and i.caminho = v_c.id::text || '/' || i.id::text
           and i.transcricao <> ''
           and coalesce(i.mime, '') ~* '^audio/[a-z0-9.+-]+(;.*)?$')
  )
  insert into public.mensagens (id, conversa_id, conexao_id, direcao, origem, tipo, texto,
                                transcricao, midia_caminho, midia_mime, midia_tamanho,
                                midia_duracao_s, midia_status, status, ordem, enviar_apos,
                                rodada_id, momento)
  select case when x.tipo = 'audio' then x.id else gen_random_uuid() end,
         v_c.id, v_conexao, 'saida', 'nina', x.tipo::public.mensagem_tipo,
         case when x.tipo = 'texto' then x.texto end,
         case when x.tipo = 'audio' then x.transcricao end,
         case when x.tipo = 'audio' then x.caminho end,
         case when x.tipo = 'audio' then x.mime end,
         case when x.tipo = 'audio' then x.tamanho end,
         case when x.tipo = 'audio' then x.duracao end,
         case when x.tipo = 'audio' then 'copiada'::public.midia_status end,
         v_status, x.n, now() + (x.n - 1)::int * interval '2 seconds', p_rodada, now()
  from validos x
  order by x.n;

  update public.rodadas r
     set status = case when r.status = 'cancelada' then r.status
                       else 'concluida'::public.rodada_status end,
         ferramentas = coalesce(p_ferramentas, r.ferramentas),
         passos = coalesce(p_passos, r.passos),
         terminada_em = coalesce(r.terminada_em, now())
   where r.id = p_rodada;
end;
$$;

revoke execute on function public.concluir_rodada(uuid, jsonb, jsonb, int) from public, anon, authenticated;
grant execute on function public.concluir_rodada(uuid, jsonb, jsonb, int) to service_role;

-- ---------------------------------------------------------------------------
-- dashboard_custo (recriada, mesma assinatura): porTipo ganha 'fala' (a voz da Nina, uma linha
-- própria). total e porModelo já somavam todas as chamadas; porConversaUsd e foraDaCoorteUsd
-- continuam só com a resposta (o custo por conversa e o custo por etapa não contam a fala).
-- total = todas as chamadas com preço, inclusive o onboarding (9d), que vem
-- numa linha própria em porTipo. porConversaUsd = custo de resposta ÷ conversas
-- em que uma mensagem da Nina saiu na janela (null sem nenhuma).
-- foraDaCoorteUsd = o custo de resposta que não entra no custo por etapa do
-- funil (leads de fora da coorte, contatos apagados, tempo em Perdido ou em
-- etapa arquivada): Σ custoUsd das etapas + foraDaCoorteUsd = porTipo.resposta.
-- Erros: sem_acesso (atendente ou quem não é membro), periodo_invalido.
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_custo(p_de timestamptz, p_ate timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_res jsonb;
  v_resposta numeric;
  v_no_funil numeric;
  v_conv bigint;
begin
  if not coalesce(public.eh_admin(), false) then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;
  if p_de is null or p_ate is null or p_ate <= p_de or p_ate - p_de > interval '367 days' then
    raise exception using message = 'periodo_invalido', errcode = 'P0001';
  end if;

  with ch as (
    select x.tipo, x.provedor, x.modelo, x.custo_usd, x.custo_origem
      from public.ia_chamadas x
     where x.criado_em >= p_de and x.criado_em < p_ate
  )
  select jsonb_build_object(
           'total', coalesce((select sum(ch.custo_usd) from ch), 0),
           'porTipo', jsonb_build_object(
             'resposta', coalesce((select sum(ch.custo_usd) from ch where ch.tipo = 'resposta'), 0),
             'transcricao', coalesce((select sum(ch.custo_usd) from ch where ch.tipo = 'transcricao'), 0),
             'onboarding', coalesce((select sum(ch.custo_usd) from ch where ch.tipo = 'onboarding'), 0),
             'fala', coalesce((select sum(ch.custo_usd) from ch where ch.tipo::text = 'fala'), 0)),
           'semPreco', (select count(*) from ch where ch.custo_origem = 'sem_preco'),
           'porModelo', coalesce((
             select jsonb_agg(jsonb_build_object('provedor', pm.provedor, 'modelo', pm.modelo, 'usd', pm.usd)
                              order by pm.usd desc, pm.provedor, pm.modelo)
               from (select ch.provedor::text as provedor, ch.modelo, sum(ch.custo_usd) as usd
                       from ch
                      group by ch.provedor, ch.modelo
                     having coalesce(sum(ch.custo_usd), 0) > 0) pm), '[]'::jsonb))
    into v_res;

  v_resposta := (v_res -> 'porTipo' ->> 'resposta')::numeric;

  select count(distinct m.conversa_id) into v_conv
    from public.mensagens m
   where m.origem = 'nina' and m.status in ('enviada', 'entregue', 'lida')
     and m.momento >= p_de and m.momento < p_ate;

  select coalesce(sum(ce.usd), 0) into v_no_funil
    from public.dashboard_custo_por_etapa(p_de, p_ate, now()) ce
    join public.etapas e on e.id = ce.etapa_id
   where not e.arquivada and e.tipo in ('aberta', 'ganho');

  return v_res || jsonb_build_object(
    'conversasComNina', v_conv,
    'porConversaUsd', case when v_conv > 0 then round(v_resposta / v_conv, 6) end,
    'foraDaCoorteUsd', v_resposta - v_no_funil
  );
end;
$$;

revoke execute on function public.dashboard_custo(timestamptz, timestamptz) from public, anon;
grant execute on function public.dashboard_custo(timestamptz, timestamptz) to authenticated, service_role;