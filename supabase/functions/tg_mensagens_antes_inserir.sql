-- Versão final da função public.tg_mensagens_antes_inserir (última definição em 0000_nina_estrutura_inicial.sql).
-- Referência: quem aplica é a pasta migrations.

create function public.tg_mensagens_antes_inserir()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ativa uuid;
  v_oficial boolean;
  v_a_enviar boolean;
  v_ultima_lead timestamptz;
begin
  if new.origem = 'humano_tela' and new.autor_membro_id is null and auth.uid() is not null then
    select m.id into new.autor_membro_id
    from public.membros m where m.user_id = auth.uid() and m.ativo;
  end if;

  if new.midia_status is null then
    if new.midia_ref_externa is not null then
      new.midia_status := 'pendente';
    elsif new.midia_caminho is not null then
      new.midia_status := 'copiada';
    end if;
  end if;

  if new.direcao = 'saida' then
    v_a_enviar := new.status in ('na_fila', 'enviando');
    select c.id, c.oficial into v_ativa, v_oficial from public.conexoes c where c.ativa;

    if v_a_enviar then
      -- Sai sempre pelo número ativo.
      if v_ativa is null then
        raise exception using message = 'sem_conexao_ativa', errcode = 'P0001';
      end if;
      new.conexao_id := v_ativa;

      if v_oficial and new.origem <> 'humano_celular' then
        select cv.ultima_do_lead_em into v_ultima_lead
        from public.conversas cv where cv.id = new.conversa_id;
        if v_ultima_lead is null or v_ultima_lead + interval '24 hours' <= now() then
          raise exception using message = 'janela_fechada', errcode = 'P0001';
        end if;
      end if;

      if new.status = 'na_fila' and new.enviar_apos is null then
        new.enviar_apos := now();
      end if;
    elsif new.conexao_id is null then
      new.conexao_id := coalesce(
        v_ativa,
        (select cv.conexao_id from public.conversas cv where cv.id = new.conversa_id)
      );
      if new.conexao_id is null then
        raise exception using message = 'sem_conexao_ativa', errcode = 'P0001';
      end if;
    end if;
  end if;
  return new;
end;
$$;
