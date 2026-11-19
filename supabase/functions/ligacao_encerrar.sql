-- Versão final da função public.ligacao_encerrar (última definição em 0035_nina_ligacao_saida_funcoes.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.ligacao_encerrar(
  p_id_externo text,
  p_status public.ligacao_status,
  p_encerrada_em timestamptz,
  p_duracao_s integer,
  p_motivo_fim text,
  p_resumo text,
  p_transcricao jsonb,
  p_custo_creditos integer)
returns table (ligacao_id uuid, conversa_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_lig    public.ligacoes%rowtype;
  v_rotulo text;
begin
  if p_status is null or p_status = 'em_andamento' then
    raise exception using message = 'status_invalido', errcode = 'P0001';
  end if;

  select l.* into v_lig from public.ligacoes l
   where l.id_externo = nullif(btrim(coalesce(p_id_externo, '')), '')
   for update;
  if not found then
    return;
  end if;

  if not (v_lig.status = 'concluida' and p_status <> 'concluida') then
    update public.ligacoes l
       set status = p_status,
           encerrada_em = coalesce(p_encerrada_em, l.encerrada_em, now()),
           duracao_s = coalesce(p_duracao_s, l.duracao_s),
           motivo_fim = coalesce(left(nullif(btrim(coalesce(p_motivo_fim, '')), ''), 300), l.motivo_fim),
           resumo = coalesce(left(nullif(btrim(coalesce(p_resumo, '')), ''), 4000), l.resumo),
           transcricao = case
             when jsonb_typeof(p_transcricao) = 'array' and jsonb_array_length(p_transcricao) > 0 then p_transcricao
             else l.transcricao end,
           custo_creditos = coalesce(p_custo_creditos, l.custo_creditos)
     where l.id = v_lig.id
     returning * into v_lig;

    -- a ligação feita pela empresa e atendida abre a janela de 24 h da Meta, como uma fala do
    -- lead; a não atendida não abre (o ligacao_iniciar_saida desfez a marca da entrada)
    if v_lig.direcao = 'saida' and v_lig.status = 'concluida' then
      update public.conversas c
         set ultima_do_lead_em = greatest(c.ultima_do_lead_em, v_lig.iniciada_em)
       where c.id = v_lig.conversa_id;
    end if;

    v_rotulo := public.rotulo_da_ligacao(v_lig.status, v_lig.duracao_s);
    if v_lig.mensagem_id is not null then
      update public.mensagens m set texto = v_rotulo
       where m.id = v_lig.mensagem_id and m.texto is distinct from v_rotulo;
      update public.conversas c set ultima_mensagem_preview = v_rotulo
       where c.id = v_lig.conversa_id and c.ultima_mensagem_id = v_lig.mensagem_id
         and c.ultima_mensagem_preview is distinct from v_rotulo;
    end if;
  end if;

  return query select v_lig.id, v_lig.conversa_id;
end;
$$;
