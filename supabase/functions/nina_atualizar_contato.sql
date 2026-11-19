-- Versão final da função public.nina_atualizar_contato (última definição em 0006_nina_ligacao_conversa.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.nina_atualizar_contato(p_rodada uuid, p_campos jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.rodadas := public.rodada_rodando(p_rodada);
  v_contato uuid;
  v_fatos jsonb;
  v_passo jsonb;
  v_anot jsonb := '{}'::jsonb;
begin
  if jsonb_typeof(p_campos) is distinct from 'object'
     or exists (select 1 from jsonb_object_keys(p_campos) k
                where k not in ('nome', 'email', 'empresa', 'resumo_nina', 'fatos', 'proximo_passo')) then
    raise exception using message = 'campo_nao_permitido', errcode = 'P0001';
  end if;
  if p_campos = '{}'::jsonb then
    return;
  end if;

  -- novo: formato das anotações
  if p_campos ? 'fatos' then
    v_fatos := p_campos -> 'fatos';
    if jsonb_typeof(v_fatos) <> 'array'
       or exists (select 1 from jsonb_array_elements(v_fatos) f
                  where jsonb_typeof(f) <> 'object'
                     or jsonb_typeof(f -> 'rotulo') is distinct from 'string'
                     or jsonb_typeof(f -> 'valor') is distinct from 'string'
                     or (f ? 'mensagem_id' and jsonb_typeof(f -> 'mensagem_id') not in ('string', 'null'))) then
      raise exception using message = 'campo_nao_permitido', errcode = 'P0001';
    end if;
    v_anot := v_anot || jsonb_build_object('fatos', v_fatos);
  end if;
  if p_campos ? 'proximo_passo' then
    v_passo := p_campos -> 'proximo_passo';
    if jsonb_typeof(v_passo) <> 'null'
       and (jsonb_typeof(v_passo) <> 'object'
            or jsonb_typeof(v_passo -> 'titulo') is distinct from 'string'
            or jsonb_typeof(v_passo -> 'texto') is distinct from 'string') then
      raise exception using message = 'campo_nao_permitido', errcode = 'P0001';
    end if;
    v_anot := v_anot || jsonb_build_object('proximo_passo', v_passo);
  end if;

  select c.contato_id into v_contato from public.conversas c where c.id = v_r.conversa_id;

  update public.contatos c
     set nome        = case when p_campos ? 'nome'
                                 and nullif(btrim(coalesce(c.nome, '')), '') is null
                                 and nullif(btrim(coalesce(p_campos ->> 'nome', '')), '') is not null
                            then p_campos ->> 'nome' else c.nome end,
         email       = case when p_campos ? 'email'
                                 and nullif(btrim(coalesce(c.email, '')), '') is null
                                 and nullif(btrim(coalesce(p_campos ->> 'email', '')), '') is not null
                            then p_campos ->> 'email' else c.email end,
         empresa     = case when p_campos ? 'empresa'
                                 and nullif(btrim(coalesce(c.empresa, '')), '') is null
                                 and nullif(btrim(coalesce(p_campos ->> 'empresa', '')), '') is not null
                            then p_campos ->> 'empresa' else c.empresa end,
         resumo_nina = case when p_campos ? 'resumo_nina' then p_campos ->> 'resumo_nina' else c.resumo_nina end,
         resumo_nina_em = case when p_campos ? 'resumo_nina' then now() else c.resumo_nina_em end,
         anotacoes_nina = case when v_anot <> '{}'::jsonb
                               then coalesce(c.anotacoes_nina, '{}'::jsonb) || v_anot
                               else c.anotacoes_nina end,
         atualizado_em = now()
   where c.id = v_contato;
end;
$$;
