-- nina_ligacao_saida_tabela (17/11/2026): a Nina liga para o lead pelo WhatsApp
-- (seção 3).
-- ligacao_permissoes: cada pedido de permissão para ligar que a equipe manda ao lead (a mensagem
-- interativa call_permission_request da Meta) e a resposta dele (call_permission_reply, pelo
-- webhook). Não é mensagem da conversa: o pedido e a resposta não tiram a conversa da Nina nem
-- armam a Nina de texto (decisão do Alexandre em 17/11/2026). Só o servidor grava; o membro lê.
-- Depende de: nina_ligacoes_tabelas (0023). Ordem: 1º envio da ligação de saída (o 2º são as
-- funções). Sem dado semeado, sem tempo real: a preparar_copia() não muda. Pode rodar duas vezes.
-- Sem BEGIN/COMMIT.

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

create table if not exists public.ligacao_permissoes (
  id uuid primary key default gen_random_uuid(),
  conversa_id uuid not null references public.conversas (id) on delete cascade,
  conexao_id uuid not null references public.conexoes (id) on delete cascade,
  -- o wamid da mensagem interativa (a resposta do lead cita esse id)
  id_gateway text constraint ligacao_permissoes_id_gateway check (id_gateway is null or id_gateway <> ''),
  pedido_por uuid references public.membros (id) on delete set null,
  pedido_em timestamptz not null default now(),
  resposta text constraint ligacao_permissoes_resposta check (resposta is null or resposta in ('aceitou', 'recusou')),
  permanente boolean,
  expira_em timestamptz,
  respondido_em timestamptz,
  criado_em timestamptz not null default now(),
  constraint ligacao_permissoes_respondida check ((resposta is null) = (respondido_em is null))
);

revoke all on table public.ligacao_permissoes from anon, authenticated;
grant all on table public.ligacao_permissoes to service_role;
grant select on table public.ligacao_permissoes to authenticated;
alter table public.ligacao_permissoes enable row level security;
drop policy if exists ligacao_permissoes_membro_le on public.ligacao_permissoes;
create policy ligacao_permissoes_membro_le on public.ligacao_permissoes
  for select to authenticated using ((select public.eh_membro()));

create index if not exists ligacao_permissoes_conversa
  on public.ligacao_permissoes (conversa_id, pedido_em desc);
create unique index if not exists ligacao_permissoes_id_gateway
  on public.ligacao_permissoes (conexao_id, id_gateway) where id_gateway is not null;