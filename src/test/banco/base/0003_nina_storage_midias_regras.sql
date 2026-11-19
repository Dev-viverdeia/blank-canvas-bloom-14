-- 05-storage.sql: regras de acesso do bucket privado de mídia ('midias').
-- Depende do 01 (public.eh_membro, public.conversas).
-- O servidor do app cria o bucket 'midias' privado na primeira vez que precisar
-- (decisão do Davi em 29/10/2026). As regras valem pelo nome do bucket e não
-- dependem de ele já existir.

-- ---------------------------------------------------------------------
-- Storage: bucket privado 'midias' ({conversa_id}/{mensagem_id})
-- ---------------------------------------------------------------------
create policy midias_membro_le on storage.objects
  for select to authenticated
  using (bucket_id = 'midias' and (select public.eh_membro()));

create policy midias_membro_grava on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'midias'
    and (select public.eh_membro())
    -- exatamente {conversa_id}/{mensagem_id}: 1 pasta (a conversa) e um uuid
    and coalesce(array_length(storage.foldername(name), 1), 0) = 1
    and storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and exists (
      select 1 from public.conversas c
      where c.id::text = (storage.foldername(name))[1]
    )
  );