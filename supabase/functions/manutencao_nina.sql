-- Versão final da função public.manutencao_nina (última definição em 0030_nina_ligacoes_presas_relogio.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.manutencao_nina()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.eventos_webhook e
   where e.recebido_em < now() - interval '30 days';

  -- ligação presa: o worker confere na ElevenLabs e fecha o que ela confirmar
  if exists (select 1 from public.ligacoes l
              where l.status = 'em_andamento'
                and l.iniciada_em < now() - interval '2 minutes'
                and l.iniciada_em > now() - interval '2 days') then
    begin
      perform public.acordar_motor(false);
    exception when others then
      raise warning 'manutencao_toque_falhou: %', sqlerrm;
    end;
  end if;
end;
$$;
