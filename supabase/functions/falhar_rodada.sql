-- Versão final da função public.falhar_rodada (última definição em 0045_nina_retornos_rodada.sql).
-- Referência: quem aplica é a pasta migrations.

create or replace function public.falhar_rodada(
  p_rodada uuid, p_motivo public.motivo_humano, p_passageiro boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.rodadas;
  v_modo public.conversa_modo;
  -- novo (retornos)
  v_entradas integer := 0;
  v_lembrete boolean := false;
begin
  if exists (select 1 from public.rodadas r where r.id = p_rodada and r.status = 'cancelada') then
    return;
  end if;
  v_r := public.rodada_rodando(p_rodada);

  update public.rodadas r
     set status = 'falhou', motivo = p_motivo, terminada_em = now()
   where r.id = p_rodada;

  update public.mensagens m
     set rodada_id = null
   where m.rodada_id = p_rodada and m.direcao = 'entrada';
  -- novo (retornos): quantas entradas do lead a rodada lia (0 = rodada pura de retorno ou lembrete)
  get diagnostics v_entradas = row_count;

  select c.modo into v_modo from public.conversas c where c.id = v_r.conversa_id for update;

  -- novo (retornos): o retorno ou o lembrete que a rodada levava
  if v_r.retorno_id is not null then
    v_lembrete := exists (select 1 from public.retornos rt
                           where rt.id = v_r.retorno_id and rt.tipo = 'lembrete');
    begin
      perform public.retorno_ao_falhar(
        p_rodada => p_rodada, p_passageiro => coalesce(p_passageiro, false),
        p_tentativa => v_r.tentativa, p_modo => v_modo);
    exception when others then
      raise warning 'retorno_ao_falhar_falhou: %', sqlerrm;
    end;
  end if;

  -- se a conversa ja saiu do modo nina (humano assumiu), nao mexe nela
  if v_modo is distinct from 'nina' then
    return;
  end if;

  -- novo (retornos): a rodada de lembrete nunca leva a conversa à equipe nem a arma
  if v_lembrete then
    return;
  end if;

  if coalesce(p_passageiro, false) and coalesce(v_r.tentativa, 1) < 3 then
    -- novo (retornos): a rodada pura de retorno não arma a conversa (a faixa 1 tenta de novo)
    if v_r.retorno_id is null or v_entradas > 0 then
      update public.conversas c
         set responder_apos = now() + interval '30 seconds'
       where c.id = v_r.conversa_id;
    end if;
  else
    update public.conversas c
       set modo = 'humano',
           aguardando_humano_desde = now(),
           motivo_humano = p_motivo,
           responder_apos = null
     where c.id = v_r.conversa_id;
    -- novo
    update public.rodadas r set foi_para_equipe = true where r.id = p_rodada;
    insert into public.conversa_eventos (conversa_id, tipo, motivo)
    values (v_r.conversa_id, 'passou', p_motivo);
  end if;
end;
$$;
