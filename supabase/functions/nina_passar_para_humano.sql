-- Versão final da função public.nina_passar_para_humano (última definição em 0006_nina_ligacao_conversa.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.nina_passar_para_humano(p_rodada uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.rodadas := public.rodada_rodando(p_rodada);
begin
  update public.rodadas r set passou_humano = true where r.id = p_rodada;

  update public.conversas c
     set modo = 'humano',
         motivo_humano = 'nina_passou',
         aguardando_humano_desde = coalesce(c.aguardando_humano_desde, now()),
         responder_apos = null
   where c.id = v_r.conversa_id and c.modo = 'nina';

  -- novo
  if found then
    update public.rodadas r set foi_para_equipe = true where r.id = p_rodada;
    insert into public.conversa_eventos (conversa_id, tipo, motivo)
    values (v_r.conversa_id, 'passou', 'nina_passou');
  end if;
end;
$$;
