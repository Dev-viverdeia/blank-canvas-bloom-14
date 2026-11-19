# A base do banco

A história inteira do banco em SQL, aplicada na ordem dos nomes para montar o banco local dos testes (`../montar.ts`).

- Os arquivos `0000` a `0021` são as migrations do projeto original (Fresh Start), sem mudança.
- O remix do Lovable copia a estrutura do banco, mas apaga os arquivos de `drizzle/migrations/`. Esta pasta é código comum e vai junto na cópia.
- Toda migration que o agente do Lovable gravar em `drizzle/migrations/` é copiada para cá, sem mudar o texto, com o próximo número. O teste `../base.test.ts` falha enquanto faltar a cópia.
- Não edite um arquivo que já está aqui: é o registro do que foi aplicado.

As regras completas estão seção "Banco e remix".
