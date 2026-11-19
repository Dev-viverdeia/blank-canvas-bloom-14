-- nina_ligacoes_limite_simultaneas (17/11/2026): o limite de ligações simultâneas da conta passa
-- de 1..20 para 1..200. Quem atende lançamentos tem picos de dezenas de ligações ao mesmo tempo
-- (na Nina vitrine, com o teto em 2, a ElevenLabs recusou 27 ligações em 13 e 14/11/2026). O
-- padrão (2) não muda: só o teto do que o admin pode escolher na tela.
-- Depende de: nina_ligacoes_tabelas (base 0023), que criou a coluna e a constraint.
-- Ordem: sozinho. Só afrouxa a regra; pode rodar duas vezes. Sem BEGIN/COMMIT.
-- O código confere a mesma faixa (FAIXAS_LIMITES.simultaneas em ligacoes/tipos.ts).

-- ---------------------------------------------------------------------
-- Trava: sem a coluna, este envio para aqui.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'configuracao'
                    and column_name = 'ligacoes_simultaneas') then
    raise exception using message = 'falta_configuracao_ligacoes_simultaneas',
      hint = 'Aplique antes o nina_ligacoes_tabelas (base 0023).';
  end if;
end;
$$;

alter table public.configuracao
  drop constraint if exists configuracao_ligacoes_simultaneas;

alter table public.configuracao
  add constraint configuracao_ligacoes_simultaneas
  check (ligacoes_simultaneas between 1 and 200);