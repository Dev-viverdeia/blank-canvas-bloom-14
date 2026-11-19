-- Versão final da função public.devolver_para_nina (última definição em 0006_nina_ligacao_conversa.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.devolver_para_nina(p_conversa uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membro uuid := public.membro_atual();
  v_ult_entrada timestamptz;
  v_ult_saida   timestamptz;
  v_janela      boolean;
  v_modo        public.conversa_modo;
begin
  select (not exists (select 1 from public.conexoes cx where cx.ativa and cx.oficial))
         or (c.ultima_do_lead_em is not null and c.ultima_do_lead_em + interval '24 hours' > now()),
         c.modo
    into v_janela, v_modo
  from public.conversas c where c.id = p_conversa for update;
  if not found then
    raise exception using message = 'conversa_nao_encontrada', errcode = 'P0001';
  end if;

  select max(m.criado_em) filter (where m.direcao = 'entrada'),
         max(m.criado_em) filter (where m.direcao = 'saida' and m.status not in ('cancelada', 'falhou'))
    into v_ult_entrada, v_ult_saida
  from public.mensagens m
  where m.conversa_id = p_conversa;

  update public.conversas c
     set modo = 'nina',
         motivo_humano = null,
         aguardando_humano_desde = null,
         responsavel_id = null,
         devolvida_em = now(),
         responder_apos = case when v_ult_entrada is not null
                                    and (v_ult_saida is null or v_ult_entrada > v_ult_saida)
                                    and v_janela
                               then now() else null end
   where c.id = p_conversa;

  -- novo
  if v_modo = 'humano' then
    insert into public.conversa_eventos (conversa_id, tipo, membro_id)
    values (p_conversa, 'devolveu', v_membro);
  end if;
end;
$$;
