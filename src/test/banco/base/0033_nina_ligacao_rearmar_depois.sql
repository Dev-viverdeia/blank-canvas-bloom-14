-- nina_ligacao_rearmar_depois (17/11/2026): a rodada depois da ligação não se perde quando a
-- ligação fecha tarde.
-- Achado das revisões (Opus 5.5 e Sol 6.1, rodada 2): se a ligação passa do teto da espera
-- (ligacao_teto) sem fechar, a rodada que pega o registro dela roda com a ligação ainda em
-- andamento e termina vazia (D7, sem IA). Quando a ligação depois fecha como concluída (pós-chamada
-- atrasado, ou o worker pelas presas), nada armava a conversa de novo, e o que a voz combinou
-- mandar por escrito se perdia.
-- ligacao_rearmar_depois(p_ligacao): chamada pelo servidor logo depois de fechar uma ligação como
-- concluída. Com a conversa no modo nina e a ligação sem passagem para a equipe:
--   - se o registro da ligação foi consumido por uma rodada concluída vazia (sem passos e sem
--     nenhuma mensagem de saída), solta o registro (rodada_id nulo) e arma a conversa agora;
--   - se o registro ainda está solto, só garante a conversa armada.
-- A rodada seguinte pega o registro e roda como rodada depois da ligação. Devolve true quando
-- armou. Idempotente: o registro já pego por uma rodada com resposta, ou por uma que roda, fica.
-- Depende de: nina_ligacoes_tabelas (0023) e nina_ligacoes_funcoes (0024). Ordem: sozinho.
-- Uma função nova, só para o service_role. Nada é semeado, nenhuma tabela muda: a
-- preparar_copia() não muda. Pode rodar duas vezes. Sem BEGIN/COMMIT.

-- ---------------------------------------------------------------------
-- Trava: sem a tabela de ligações, este envio para aqui.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.ligacoes') is null then
    raise exception using message = 'falta_a_tabela_ligacoes',
      hint = 'Aplique antes o nina_ligacoes_tabelas (base 0023).';
  end if;
end;
$$;

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

revoke execute on function public.ligacao_rearmar_depois(uuid) from public, anon, authenticated;
grant execute on function public.ligacao_rearmar_depois(uuid) to service_role;