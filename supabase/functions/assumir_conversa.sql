-- Versão final da função public.assumir_conversa (última definição em 0006_nina_ligacao_conversa.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.assumir_conversa(p_conversa uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membro uuid := public.membro_atual();
  v_antes public.conversas;
  v_de text;
begin
  -- novo: espera o desativar_membro que estiver rodando (for update no membro) e
  -- confere de novo que a pessoa continua ativa. Sem isso, quem é desativado
  -- enquanto clica em Assumir fica com a conversa (decisão 4). Ordem das travas
  -- igual à do desativar_membro: membro, depois conversa.
  perform 1 from public.membros mb where mb.id = v_membro and mb.ativo for share;
  if not found then
    raise exception using message = 'sem_acesso', errcode = 'P0001';
  end if;

  -- novo: o estado de antes (travado), para o evento
  select * into v_antes from public.conversas c where c.id = p_conversa for update;
  if not found then
    raise exception using message = 'conversa_nao_encontrada', errcode = 'P0001';
  end if;

  update public.conversas c
     set modo = 'humano',
         responsavel_id = v_membro,
         aguardando_humano_desde = null,
         motivo_humano = case when c.modo = 'nina' then 'humano_tela'::public.motivo_humano
                              else c.motivo_humano end,
         responder_apos = null
   where c.id = p_conversa;
  if not found then
    raise exception using message = 'conversa_nao_encontrada', errcode = 'P0001';
  end if;

  update public.mensagens m
     set status = 'cancelada', status_em = now()
   where m.conversa_id = p_conversa and m.origem = 'nina' and m.status = 'na_fila';

  with canceladas as (
    update public.rodadas r
       set status = 'cancelada', terminada_em = now()
     where r.conversa_id = p_conversa and r.status = 'rodando' and not r.passou_humano
    returning r.id
  )
  update public.mensagens m
     set rodada_id = null
    from canceladas k
   where m.rodada_id = k.id and m.direcao = 'entrada';

  -- novo
  if v_antes.modo = 'nina' or v_antes.responsavel_id is distinct from v_membro then
    v_de := case when v_antes.modo = 'nina' then 'nina'
                 when v_antes.responsavel_id is not null then 'outro'
                 when v_antes.aguardando_humano_desde is null then 'celular'
                 else 'espera' end;
    insert into public.conversa_eventos (conversa_id, tipo, membro_id, de, de_membro_id, por_envio)
    values (p_conversa, 'assumiu', v_membro, v_de,
            case when v_de = 'outro' then v_antes.responsavel_id end, false);
  end if;
end;
$$;
