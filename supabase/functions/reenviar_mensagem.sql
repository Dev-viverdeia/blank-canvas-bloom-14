-- Versão final da função public.reenviar_mensagem (última definição em 0017_nina_lacunas_funcoes.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.reenviar_mensagem(p_msg uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membro uuid := public.membro_atual();
  v_m public.mensagens;
  v_ativa uuid;
  v_oficial boolean;
  v_ultima_lead timestamptz;
begin
  select * into v_m from public.mensagens m where m.id = p_msg for update;
  if not found then
    raise exception using message = 'nao_encontrado', errcode = 'P0001';
  end if;

  if v_m.direcao <> 'saida' or v_m.origem <> 'humano_tela' or v_m.status <> 'falhou' then
    raise exception using message = 'nao_reenviavel', errcode = 'P0001';
  end if;
  -- falha_no_gateway: o gateway aceitou e depois avisou que a entrega falhou, então a
  -- mensagem não chegou e pode sair de novo (decisão 8). Os outros casos podem ter chegado.
  if coalesce(v_m.erro, '') <> 'falha_no_gateway'
     and (v_m.id_externo is not null
          or v_m.id_gateway is not null
          or coalesce(v_m.erro, '') in ('sem_resposta_do_envio', 'tempo_esgotado', 'falha_de_rede')
          or coalesce(v_m.erro, '') ~ '^(http_|http:|meta_|zernio_http_)5[0-9][0-9]') then
    raise exception using message = 'nao_reenviavel', errcode = 'P0001';
  end if;

  select c.id, c.oficial into v_ativa, v_oficial from public.conexoes c where c.ativa;
  if v_ativa is null then
    raise exception using message = 'sem_conexao_ativa', errcode = 'P0001';
  end if;
  if v_oficial then
    select cv.ultima_do_lead_em into v_ultima_lead
    from public.conversas cv where cv.id = v_m.conversa_id;
    if v_ultima_lead is null or v_ultima_lead + interval '24 hours' <= now() then
      raise exception using message = 'janela_fechada', errcode = 'P0001';
    end if;
  end if;

  update public.mensagens m
     set status = 'na_fila',
         erro = null,
         tentativas = 0,
         enviar_apos = now(),
         status_em = now(),
         conexao_id = v_ativa,
         id_externo = null,
         id_gateway = null,
         -- novo: conta o reenvio (a chave da Zernio muda a cada um)
         reenvios = m.reenvios + 1
   where m.id = p_msg;
end;
$$;
