-- =====================================================================
-- Ligar as telas ao banco, envio 3: leituras das telas (31-leituras.sql).
-- texto_busca, contatos_lista, contatos_contadores, buscar_quadro,
-- custo_das_conversas, marcar_visto e reordenar_etapas.
-- Contrato: seção 2.3 ("Novas, em 31-leituras.sql").
-- Depende do envio 2 (20-tabelas.sql: membros.vistos, ia_chamadas.conversa_id,
-- conversas.ultima_da_nina_em). Só cria funções novas. Sem BEGIN/COMMIT.
--
-- Regras de todas:
-- - security definer, search_path vazio e nomes qualificados;
-- - dia sempre em America/Sao_Paulo;
-- - anon não executa nenhuma; as de tela conferem membro (membro_atual, erro
--   sem_acesso) ou admin (eh_admin, erro sem_acesso) logo no começo;
-- - parâmetro fora da lista (recorte, ordem, direção, onde, mais de 200 ids) dá
--   erro 22023 com a mensagem 'parametro_invalido' e o nome do parâmetro no detail.
--
-- As regras calculadas (ativa agora, esfriando) ficam no front (exemplo/regras.ts):
-- o banco só filtra, conta e pagina, e devolve as colunas cruas.
-- =====================================================================

-- ---------------------------------------------------------------------
-- texto_busca: minúsculo, sem acento (translate) e com os espaços juntos
-- e sem espaço nas pontas, como o normalizarBusca da tela de Contatos.
-- "  Clínica   VALE " vira "clinica vale". Nulo continua nulo.
-- O translate vem antes do lower: o lower de alguns bancos (locale C) só
-- troca as letras ASCII, então as maiúsculas com acento já saem sem acento.
-- ---------------------------------------------------------------------
create or replace function public.texto_busca(p_texto text)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select btrim(regexp_replace(
    lower(translate(
      p_texto,
      'ÁÀÂÃÄÅáàâãäåÇçÉÈÊËéèêëÍÌÎÏíìîïÑñÓÒÔÕÖóòôõöÚÙÛÜúùûüÝýÿ',
      'AAAAAAaaaaaaCcEEEEeeeeIIIIiiiiNnOOOOOoooooUUUUuuuuYyy'
    )),
    '\s+', ' ', 'g'
  ))
$$;

revoke execute on function public.texto_busca(text) from public, anon;
grant execute on function public.texto_busca(text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- contatos_lista: a tabela da tela de Contatos, paginada no banco.
--   p_busca: o texto contra nome, nome no WhatsApp, empresa e e-mail (sem
--     acento). Com 4 dígitos ou mais, também os dígitos contra o telefone
--     (guardado como 55 + DDD + número): "(11) 90000-0007", "11900000007" e
--     "90000-0007" acham 5511900000007.
--   p_recorte: todos | precisam | novos_hoje | com_nina | comigo (nulo = todos).
--     O contato sem mensagem do lead (primeira_mensagem_em nula) entra só em todos.
--       precisam   = conversa humano, sem responsável e esperando a equipe
--                    (o estaAguardando do front: aguardando ou falha);
--       novos_hoje = primeira_mensagem_em no dia de hoje em São Paulo;
--       com_nina   = conversa no modo nina;
--       comigo     = conversa humano com o membro da sessão como responsável.
--   p_etapas: nulo ou vazio = todas.
--   p_entrada_de / p_entrada_ate: "Entrou em", pela data de São Paulo da
--     primeira_mensagem_em, inclusivo dos dois lados; nulo = sem limite daquele
--     lado. Com um dos dois preenchido, o contato sem mensagem do lead sai.
--   p_ordem: contato | etapa | ultima | entrada (nulo = ultima);
--   p_direcao: asc | desc (nulo = desc). Data nula vai para o fim nos dois
--     sentidos. Desempate sempre pelo nome (sem acento, A a Z) e depois pelo id:
--     a página seguinte nunca repete nem pula linha.
--   p_limite: 1 a 200 (nulo = 50); p_deslocamento: a partir de 0 (nulo = 0).
-- Devolve {total, linhas}: total = todas as linhas do filtro (sem a paginação).
-- Cada linha: contato_id, nome, nome_whatsapp, telefone, email, empresa,
-- etapa_id, etapa_ordem, primeira_mensagem_em, criado_em, entrou_em
-- (= primeira_mensagem_em ou, sem ela, criado_em), ultima_mensagem_em e
-- conversa (nula sem conversa, ou {id, modo, responsavel_id, motivo_humano,
-- aguardando_humano_desde, ultima_mensagem_em, ultima_do_lead_em,
-- ultima_da_nina_em, nao_lidas}).
-- ---------------------------------------------------------------------
create or replace function public.contatos_lista(
  p_busca text,
  p_recorte text,
  p_etapas uuid[],
  p_entrada_de date,
  p_entrada_ate date,
  p_ordem text,
  p_direcao text,
  p_limite int,
  p_deslocamento int
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_membro  uuid := public.membro_atual();
  v_recorte text := coalesce(nullif(btrim(p_recorte), ''), 'todos');
  v_ordem   text := coalesce(nullif(btrim(p_ordem), ''), 'ultima');
  v_direcao text := coalesce(nullif(btrim(p_direcao), ''), 'desc');
  v_asc     boolean;
  v_limite  int := coalesce(p_limite, 50);
  v_desloc  int := greatest(coalesce(p_deslocamento, 0), 0);
  v_q       text := nullif(public.texto_busca(p_busca), '');
  v_digitos text := regexp_replace(coalesce(p_busca, ''), '[^0-9]', '', 'g');
  v_hoje    date := (now() at time zone 'America/Sao_Paulo')::date;
  v_de      timestamptz;
  v_ate     timestamptz;
  v_total   bigint;
  v_linhas  jsonb;
begin
  if v_recorte not in ('todos', 'precisam', 'novos_hoje', 'com_nina', 'comigo') then
    raise exception using message = 'parametro_invalido', errcode = '22023', detail = 'p_recorte';
  end if;
  if v_ordem not in ('contato', 'etapa', 'ultima', 'entrada') then
    raise exception using message = 'parametro_invalido', errcode = '22023', detail = 'p_ordem';
  end if;
  if v_direcao not in ('asc', 'desc') then
    raise exception using message = 'parametro_invalido', errcode = '22023', detail = 'p_direcao';
  end if;
  if v_limite < 1 or v_limite > 200 then
    raise exception using message = 'parametro_invalido', errcode = '22023', detail = 'p_limite';
  end if;
  v_asc := v_direcao = 'asc';
  if length(v_digitos) < 4 then
    v_digitos := null;
  end if;
  -- [de 00:00 SP, ate + 1 dia 00:00 SP): o mesmo que comparar a data de SP, usando o índice.
  if p_entrada_de is not null then
    v_de := p_entrada_de::timestamp at time zone 'America/Sao_Paulo';
  end if;
  if p_entrada_ate is not null then
    v_ate := (p_entrada_ate + 1)::timestamp at time zone 'America/Sao_Paulo';
  end if;

  with base as (
    select c.id, c.nome, c.nome_whatsapp, c.telefone, c.email, c.empresa, c.etapa_id,
           c.primeira_mensagem_em, c.criado_em,
           coalesce(c.primeira_mensagem_em, c.criado_em) as entrou_em,
           e.ordem as etapa_ordem,
           public.texto_busca(coalesce(nullif(btrim(c.nome), ''), nullif(btrim(c.nome_whatsapp), ''),
                                       nullif(btrim(c.telefone), ''), 'Sem nome')) as nome_ordem,
           cv.id as conversa_id, cv.modo, cv.responsavel_id, cv.motivo_humano,
           cv.aguardando_humano_desde, cv.ultima_mensagem_em, cv.ultima_do_lead_em,
           cv.ultima_da_nina_em, cv.nao_lidas
      from public.contatos c
      join public.etapas e on e.id = c.etapa_id
      left join public.conversas cv on cv.contato_id = c.id
     where coalesce(case v_recorte
             when 'todos' then true
             when 'precisam' then c.primeira_mensagem_em is not null and cv.modo = 'humano'
                                  and cv.responsavel_id is null and cv.aguardando_humano_desde is not null
             when 'novos_hoje' then c.primeira_mensagem_em is not null
                                  and (c.primeira_mensagem_em at time zone 'America/Sao_Paulo')::date = v_hoje
             when 'com_nina' then c.primeira_mensagem_em is not null and cv.modo = 'nina'
             when 'comigo' then c.primeira_mensagem_em is not null and cv.modo = 'humano'
                                  and cv.responsavel_id = v_membro
           end, false)
       and (p_etapas is null or cardinality(p_etapas) = 0 or c.etapa_id = any (p_etapas))
       and (v_de is null or c.primeira_mensagem_em >= v_de)
       and (v_ate is null or c.primeira_mensagem_em < v_ate)
       and (v_q is null and v_digitos is null
            or (v_q is not null and (
                  strpos(public.texto_busca(c.nome), v_q) > 0
                  or strpos(public.texto_busca(c.nome_whatsapp), v_q) > 0
                  or strpos(public.texto_busca(c.empresa), v_q) > 0
                  or strpos(public.texto_busca(c.email), v_q) > 0))
            or (v_digitos is not null and strpos(c.telefone, v_digitos) > 0))
  ),
  numeradas as (
    select b.*,
           row_number() over (order by
             case when v_ordem = 'contato' and v_asc then b.nome_ordem end asc,
             case when v_ordem = 'contato' and not v_asc then b.nome_ordem end desc,
             case when v_ordem = 'etapa' and v_asc then b.etapa_ordem end asc,
             case when v_ordem = 'etapa' and not v_asc then b.etapa_ordem end desc,
             case when v_ordem = 'ultima' and v_asc then b.ultima_mensagem_em end asc nulls last,
             case when v_ordem = 'ultima' and not v_asc then b.ultima_mensagem_em end desc nulls last,
             case when v_ordem = 'entrada' and v_asc then b.entrou_em end asc,
             case when v_ordem = 'entrada' and not v_asc then b.entrou_em end desc,
             b.nome_ordem asc,
             b.id asc
           ) as pos
      from base b
  )
  select (select count(*) from numeradas),
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'contato_id', n.id,
                    'nome', n.nome,
                    'nome_whatsapp', n.nome_whatsapp,
                    'telefone', n.telefone,
                    'email', n.email,
                    'empresa', n.empresa,
                    'etapa_id', n.etapa_id,
                    'etapa_ordem', n.etapa_ordem,
                    'primeira_mensagem_em', n.primeira_mensagem_em,
                    'criado_em', n.criado_em,
                    'entrou_em', n.entrou_em,
                    'ultima_mensagem_em', n.ultima_mensagem_em,
                    'conversa', case when n.conversa_id is null then null else jsonb_build_object(
                      'id', n.conversa_id,
                      'modo', n.modo,
                      'responsavel_id', n.responsavel_id,
                      'motivo_humano', n.motivo_humano,
                      'aguardando_humano_desde', n.aguardando_humano_desde,
                      'ultima_mensagem_em', n.ultima_mensagem_em,
                      'ultima_do_lead_em', n.ultima_do_lead_em,
                      'ultima_da_nina_em', n.ultima_da_nina_em,
                      'nao_lidas', n.nao_lidas) end
                  ) order by n.pos)
             from numeradas n
            where n.pos > v_desloc and n.pos <= v_desloc + v_limite
         ), '[]'::jsonb)
    into v_total, v_linhas;

  return jsonb_build_object('total', v_total, 'linhas', v_linhas);
end;
$$;

revoke execute on function public.contatos_lista(text, text, uuid[], date, date, text, text, int, int) from public, anon;
grant execute on function public.contatos_lista(text, text, uuid[], date, date, text, text, int, int) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- contatos_contadores: o número de cada aba, com as mesmas regras de recorte
-- de contatos_lista (sem busca nem filtro): {todos, precisam, novos_hoje,
-- com_nina, comigo}.
-- ---------------------------------------------------------------------
create or replace function public.contatos_contadores()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_membro uuid := public.membro_atual();
  v_hoje   date := (now() at time zone 'America/Sao_Paulo')::date;
  v_r      jsonb;
begin
  select jsonb_build_object(
           'todos', count(*),
           'precisam', count(*) filter (
             where c.primeira_mensagem_em is not null and cv.modo = 'humano'
               and cv.responsavel_id is null and cv.aguardando_humano_desde is not null),
           'novos_hoje', count(*) filter (
             where c.primeira_mensagem_em is not null
               and (c.primeira_mensagem_em at time zone 'America/Sao_Paulo')::date = v_hoje),
           'com_nina', count(*) filter (
             where c.primeira_mensagem_em is not null and cv.modo = 'nina'),
           'comigo', count(*) filter (
             where c.primeira_mensagem_em is not null and cv.modo = 'humano'
               and cv.responsavel_id = v_membro))
    into v_r
    from public.contatos c
    left join public.conversas cv on cv.contato_id = c.id;
  return v_r;
end;
$$;

revoke execute on function public.contatos_contadores() from public, anon;
grant execute on function public.contatos_contadores() to authenticated, service_role;

-- ---------------------------------------------------------------------
-- buscar_quadro: a busca do Kanban, no servidor. Até 50 contato_id cujo nome,
-- empresa ou nome no WhatsApp, ou o texto ou a transcrição de alguma mensagem
-- (não apagada) da conversa, contém o texto (sem acento). Busca vazia = nada.
-- Ordem: a conversa mais recente primeiro (sem mensagem no fim), depois o id.
-- ---------------------------------------------------------------------
create or replace function public.buscar_quadro(p_q text)
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_membro uuid := public.membro_atual();
  v_q      text := nullif(public.texto_busca(p_q), '');
begin
  if v_q is null then
    return;
  end if;
  return query
  select c.id
    from public.contatos c
    left join public.conversas cv on cv.contato_id = c.id
   where strpos(public.texto_busca(c.nome), v_q) > 0
      or strpos(public.texto_busca(c.empresa), v_q) > 0
      or strpos(public.texto_busca(c.nome_whatsapp), v_q) > 0
      or (cv.id is not null and exists (
            select 1
              from public.mensagens m
             where m.conversa_id = cv.id
               and m.apagada_em is null
               and (strpos(public.texto_busca(m.texto), v_q) > 0
                    or strpos(public.texto_busca(m.transcricao), v_q) > 0)))
   order by cv.ultima_mensagem_em desc nulls last, c.id
   limit 50;
end;
$$;

revoke execute on function public.buscar_quadro(text) from public, anon;
grant execute on function public.buscar_quadro(text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- custo_das_conversas (só admin): o custo da IA de cada conversa pedida (até
-- 200 ids). Soma ia_chamadas.custo_usd pela conversa da chamada
-- (ia_chamadas.conversa_id, que a transcrição grava) ou, sem ela, pela conversa
-- da rodada. Chamada sem preço (custo nulo) não soma. Devolve uma linha por
-- conversa pedida que existe, com 0 quando não há custo; id repetido sai uma vez.
-- ---------------------------------------------------------------------
create or replace function public.custo_das_conversas(p_conversas uuid[])
returns table (conversa_id uuid, custo_usd numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not coalesce(public.eh_admin(), false) then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;
  if p_conversas is null or cardinality(p_conversas) = 0 then
    return;
  end if;
  if cardinality(p_conversas) > 200 then
    raise exception using message = 'parametro_invalido', errcode = '22023', detail = 'p_conversas';
  end if;
  return query
  select cv.id, coalesce(sum(k.custo_usd), 0)::numeric
    from public.conversas cv
    left join (
      select coalesce(ch.conversa_id, r.conversa_id) as conversa_id, ch.custo_usd
        from public.ia_chamadas ch
        left join public.rodadas r on r.id = ch.rodada_id
       where coalesce(ch.conversa_id, r.conversa_id) = any (p_conversas)
    ) k on k.conversa_id = cv.id
   where cv.id = any (p_conversas)
   group by cv.id;
end;
$$;

revoke execute on function public.custo_das_conversas(uuid[]) from public, anon;
grant execute on function public.custo_das_conversas(uuid[]) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- marcar_visto: grava agora em membros.vistos[p_onde] da pessoa da sessão
-- ('kanban' ou 'tour') e devolve o instante gravado. As outras chaves de
-- vistos ficam como estavam.
-- ---------------------------------------------------------------------
create or replace function public.marcar_visto(p_onde text)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membro uuid := public.membro_atual();
  v_agora  timestamptz := now();
begin
  if p_onde is null or p_onde not in ('kanban', 'tour') then
    raise exception using message = 'parametro_invalido', errcode = '22023', detail = 'p_onde';
  end if;
  update public.membros m
     set vistos = coalesce(m.vistos, '{}'::jsonb) || jsonb_build_object(p_onde, v_agora)
   where m.id = v_membro;
  if not found then
    raise exception using message = 'nao_encontrado', errcode = 'P0001';
  end if;
  return v_agora;
end;
$$;

revoke execute on function public.marcar_visto(text) from public, anon;
grant execute on function public.marcar_visto(text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- reordenar_etapas (só admin): a nova ordem de um grupo de etapas, tudo de
-- uma vez. O grupo é um só: as abertas, ou Ganho e Perdido (misturar dá
-- sem_permissao). Os ids trocam entre si as posições que já ocupavam (a menor
-- ordem vai para o 1º id da lista, e assim por diante), como no exemplo: as
-- etapas fora da lista não mudam e Ganho e Perdido continuam no fim.
-- Id que não existe, nulo ou repetido dá nao_encontrado. Lista vazia ou nula
-- não faz nada.
-- ---------------------------------------------------------------------
create or replace function public.reordenar_etapas(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_qtd      int;
  v_achadas  int;
  v_abertas  int;
  v_posicoes int[];
begin
  if not coalesce(public.eh_admin(), false) then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;
  v_qtd := coalesce(cardinality(p_ids), 0);
  if v_qtd = 0 then
    return;
  end if;
  if array_position(p_ids, null) is not null
     or (select count(distinct x) from unnest(p_ids) as x) <> v_qtd then
    raise exception using message = 'nao_encontrado', errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('nina.etapas'));
  perform 1 from public.etapas e where e.id = any (p_ids) for update;

  select count(*), count(*) filter (where e.tipo = 'aberta'), array_agg(e.ordem order by e.ordem, e.id)
    into v_achadas, v_abertas, v_posicoes
    from public.etapas e
   where e.id = any (p_ids);
  if v_achadas <> v_qtd then
    raise exception using message = 'nao_encontrado', errcode = 'P0001';
  end if;
  if v_abertas <> 0 and v_abertas <> v_achadas then
    raise exception using message = 'sem_permissao', errcode = 'P0001';
  end if;

  update public.etapas e
     set ordem = v_posicoes[k.pos]
    from unnest(p_ids) with ordinality as k (id, pos)
   where e.id = k.id
     and e.ordem is distinct from v_posicoes[k.pos];
end;
$$;

revoke execute on function public.reordenar_etapas(uuid[]) from public, anon;
grant execute on function public.reordenar_etapas(uuid[]) to authenticated, service_role;