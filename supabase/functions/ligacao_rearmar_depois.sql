-- Versão final da função public.ligacao_rearmar_depois (última definição em 0033_nina_ligacao_rearmar_depois.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.ligacao_rearmar_depois(p_ligacao uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_l   public.ligacoes;
  v_c   public.conversas;
  v_rod uuid;
begin
  select * into v_l from public.ligacoes l where l.id = p_ligacao;
  if not found or v_l.status <> 'concluida' or v_l.passou_equipe
     or v_l.conversa_id is null or v_l.mensagem_id is null then
    return false;
  end if;

  -- trava a conversa: o pegar_rodadas e esta função não se cruzam
  select * into v_c from public.conversas c where c.id = v_l.conversa_id for update;
  if not found or v_c.modo <> 'nina' then
    return false;
  end if;

  select m.rodada_id into v_rod from public.mensagens m where m.id = v_l.mensagem_id;
  if v_rod is not null then
    -- só a rodada concluída vazia (a D7 da ligação ainda em andamento) solta o registro
    if not exists (select 1 from public.rodadas r
                    where r.id = v_rod and r.status = 'concluida' and r.passos = 0)
       or exists (select 1 from public.mensagens s
                   where s.rodada_id = v_rod and s.direcao = 'saida') then
      return false;
    end if;
    update public.mensagens m set rodada_id = null where m.id = v_l.mensagem_id;
  end if;

  update public.conversas c
     set responder_apos = least(coalesce(c.responder_apos, now()), now())
   where c.id = v_c.id;
  return true;
end;
$$;
