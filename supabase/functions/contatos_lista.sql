-- Versão final da função public.contatos_lista (última definição em 0007_nina_ligacao_leituras.sql).
-- Referência: quem aplica é a pasta migrations.

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
