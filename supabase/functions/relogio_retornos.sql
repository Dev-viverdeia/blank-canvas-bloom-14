-- Versão final da função public.relogio_retornos (última definição em 0044_nina_retornos_funcoes.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.relogio_retornos()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_algum   boolean;
  v_recente boolean;
  v_preso   boolean;
  v_visto   timestamptz;
  v_andando boolean;
begin
  begin
    perform public.retornos_varrer(500);
  exception when others then
    raise warning 'retornos_varrer_falhou: %', sqlerrm;
  end;

  begin
    select count(*) > 0, coalesce(bool_or(p.pronto_em > now() - interval '10 minutes'), false)
      into v_algum, v_recente
      from public.retornos_prontos() p
     where p.pronto_em <= now();
    -- desligados, a irmã não pega o item pronto: o toque seria à toa (o preso, abaixo, continua)
    v_algum := v_algum and public.retornos_ligados();
    v_preso := exists (
                 select 1 from public.rodadas r
                  where r.status = 'rodando' and r.retorno_id is not null
                    and r.iniciada_em < now() - interval '5 minutes')
            or (public.whatsapp_conectado_desde() is not null
                and exists (
                  select 1 from public.retornos rt
                    join public.mensagens m on m.rodada_id = rt.rodada_id
                   where rt.status = 'saindo' and rt.expira_em > now()
                     and m.direcao = 'saida' and m.origem = 'nina'
                     and ((m.status = 'na_fila'
                           and coalesce(m.enviar_apos, m.criado_em) < now() - interval '1 minute')
                          or (m.status = 'enviando'
                              and coalesce(m.status_em, m.criado_em) < now() - interval '2 minutes'))));
    select cf.worker_visto_em into v_visto from public.configuracao cf where cf.id = 1;
    -- a pilha está andando: uma rodada qualquer (de retorno, de lembrete ou de resposta ao lead)
    -- terminou há menos de 3 min, concluída ou com falha (usa o índice rodadas_terminada)
    v_andando := v_algum and not v_recente and exists (
                   select 1 from public.rodadas r
                    where r.status in ('concluida', 'falhou')
                      and r.terminada_em > now() - interval '3 minutes');
    if v_preso
       or (v_algum and (((v_recente or v_andando) and public.retornos_no_ar())
                        or coalesce(v_visto, '-infinity'::timestamptz) < now() - interval '10 minutes')) then
      perform public.acordar_motor(false);
    end if;
  exception when others then
    raise warning 'relogio_retornos_toque_falhou: %', sqlerrm;
  end;
end;
$$;
