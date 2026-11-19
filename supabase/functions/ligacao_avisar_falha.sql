-- Versão final da função public.ligacao_avisar_falha (última definição em 0028_nina_ligacao_aviso_falha.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.ligacao_avisar_falha(p_ligacao uuid, p_texto text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_l       public.ligacoes;
  v_c       public.conversas;
  v_texto   text := btrim(coalesce(p_texto, ''));
  v_conexao uuid;
  v_rod     uuid;
  v_id      uuid;
begin
  if v_texto = '' or char_length(v_texto) > 500 then
    raise exception using message = 'texto_invalido', errcode = 'P0001';
  end if;

  select * into v_l from public.ligacoes l where l.id = p_ligacao;
  if not found or v_l.direcao <> 'entrada' or v_l.status <> 'nao_completada'
     or v_l.aviso_falha_em is not null
     or v_l.conversa_id is null then
    return null;
  end if;

  -- trava a conversa: duas falhas ao mesmo tempo não avisam duas vezes
  select * into v_c from public.conversas c where c.id = v_l.conversa_id for update;
  if not found or v_c.modo <> 'nina' then
    return null;
  end if;

  if v_l.iniciada_em < now() - interval '2 hours' then
    return null;
  end if;
  if exists (select 1 from public.ligacoes l2
              where l2.conversa_id = v_c.id and l2.id <> v_l.id
                and l2.iniciada_em > v_l.iniciada_em) then
    return null;
  end if;
  if exists (select 1 from public.ligacoes l2
              where l2.conversa_id = v_c.id
                and l2.aviso_falha_em > now() - interval '10 minutes') then
    return null;
  end if;
  if exists (select 1 from public.mensagens m
              where m.conversa_id = v_c.id and m.direcao = 'entrada' and m.tipo <> 'ligacao'
                and m.momento > v_l.iniciada_em) then
    return null;
  end if;

  select cx.id into v_conexao from public.conexoes cx where cx.ativa limit 1;
  v_conexao := coalesce(v_conexao, v_c.conexao_id);

  begin
    -- a rodada só dá a rodada que a mensagem da Nina exige; nada a rodar
    insert into public.rodadas (conversa_id, status, contexto_versao_id, provedor, modelo,
                                passos, tentativa, passou_humano, iniciada_em, terminada_em)
    values (v_c.id, 'concluida', (select max(cv.id) from public.contexto_versoes cv), null, null,
            0, 1, false, now(), now())
    returning id into v_rod;

    insert into public.mensagens (conversa_id, conexao_id, direcao, origem, tipo, texto,
                                  status, ordem, enviar_apos, rodada_id, momento)
    values (v_c.id, v_conexao, 'saida', 'nina', 'texto', v_texto,
            'na_fila', 1, now(), v_rod, now())
    returning id into v_id;
  exception when sqlstate 'P0001' then
    -- sem conexão ativa ou janela fechada: a rodada e a mensagem saem juntas, nada fica
    return null;
  end;

  update public.ligacoes set aviso_falha_em = now() where id = v_l.id;
  return v_id;
end;
$$;
