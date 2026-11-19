-- nina_ligacao_aviso_falha (17/11/2026): a ligação que o lead fez e não completou vira mensagem no
-- chat. Sem isto, a pessoa ligava, a ligação não completava e nada mais acontecia (na Nina
-- vitrine, nos picos de 13 e 14/11/2026, cerca de 40 pessoas nunca foram atendidas). Quando a
-- ElevenLabs avisa a falha (o pós-chamada com status failed, o call_initiation_failure ou o
-- fechamento das presas), o servidor chama a ligacao_avisar_falha com o texto pronto, e ela põe a
-- mensagem na fila como da Nina, com uma rodada já concluída.
-- Só ligação de entrada: numa ligação que a Nina fizer (direção 'saida'), "vi que você me ligou"
-- seria falso. A ligação do lead abre a janela de 24 h da Meta mesmo sem ser atendida, e a
-- mensagem de entrada da ligação já atualiza conversas.ultima_do_lead_em.
-- Trazido da Nina vitrine (base 0040 de lá), com a condição da direção.
-- Depende de: nina_ligacoes_tabelas (base 0023), que criou public.ligacoes. Ordem: sozinho.
-- Uma coluna nova, que aceita nulo, e uma função nova; só o servidor chama (service_role).
-- Nenhuma tabela entra no tempo real e nada é semeado: a preparar_copia() não muda.
-- Só acrescenta. Pode rodar duas vezes. Sem BEGIN/COMMIT.

-- ---------------------------------------------------------------------
-- Trava: sem a tabela de ligações, este envio para aqui.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from information_schema.tables
                  where table_schema = 'public' and table_name = 'ligacoes') then
    raise exception using message = 'falta_a_tabela_ligacoes',
      hint = 'Aplique antes o nina_ligacoes_tabelas (base 0023).';
  end if;
end;
$$;

-- Quando a Nina avisou no chat que esta ligação não completou (nulo = não avisou).
alter table public.ligacoes add column if not exists aviso_falha_em timestamptz;

-- ---------------------------------------------------------------------
-- ligacao_avisar_falha: avisa no chat que a ligação não completou. Devolve o id da mensagem
-- posta na fila, ou nulo quando não avisa:
--   - a ligação não existe, não é de entrada, não está 'nao_completada' ou já foi avisada;
--   - a conversa está com a equipe;
--   - a ligação começou há mais de 2 h (a presa fechada tarde: o aviso já não serve);
--   - há ligação mais nova na conversa (atendida, ou que fará o próprio aviso);
--   - outra ligação da conversa foi avisada há menos de 10 min (quem tenta várias vezes recebe
--     um aviso só);
--   - o lead escreveu depois do começo da ligação (a rodada normal responde);
--   - sem conexão ativa ou com a janela de 24 h fechada (o gatilho do insert recusa; nada fica).
-- p_texto: de 1 a 500 letras (senão, texto_invalido).
-- ---------------------------------------------------------------------
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

revoke execute on function public.ligacao_avisar_falha(uuid, text) from public, anon, authenticated;
grant execute on function public.ligacao_avisar_falha(uuid, text) to service_role;