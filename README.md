# Portal de Agendamento FLV

Portal para fornecedores consultarem e agendarem entregas. O desenvolvimento local usa SQLite; a publicação usa um novo projeto Supabase com Auth e políticas RLS. O projeto Supabase existente permanecerá intacto.

## Acesso local

Abra [http://localhost:3100](http://localhost:3100). A porta 3000 já estava ocupada neste computador.

Para iniciar com Node.js 22 ou mais recente:

```powershell
pnpm dev
```

Na primeira abertura local, crie o acesso do administrador. O banco SQLite fica em `data/flv.db`, fora do Git.

## Regras do portal

- De segunda a sábado, das 05:00 às 10:00, com 5 reservas por faixa de meia hora.
- Os fornecedores cadastram uma conta, aguardam aprovação e visualizam somente seus próprios dados.
- O horário é atribuído pelo sistema; pedidos e notas fiscais são opcionais. Peso, itens, caixas, veículo e tipo de carga são obrigatórios.
- A senha pode ser impressa. Agendamentos cancelados ficam disponíveis no histórico.
- A planilha tinha 429 linhas e 409 razões sociais distintas; `suppliers.json` contém os nomes deduplicados.

## Build de produção

Configure `SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY` e execute:

```powershell
pnpm build
```

O build cria `dist/`, publicado segundo `vercel.json`. Antes de publicar, crie um projeto Supabase novo, aplique `supabase/schema.sql` e `supabase/seed.sql`, habilite confirmação de email e ajuste as URLs de autenticação. Configure na hospedagem as mesmas duas variáveis de build. Nunca coloque uma chave `service_role` no navegador.

O esquema cria o primeiro perfil administrativo ativo para o email autorizado nele, depois que esse endereço confirma o cadastro. Contas de fornecedores ficam pendentes até aprovação administrativa.

## Planos gratuitos

O plano Supabase Free comporta 430 fornecedores quanto ao número de contas, dentro da cota atual de usuários ativos. Ele tem cotas de armazenamento e tráfego e pode pausar projetos com pouca atividade.

Este projeto foi definido pelo proprietário como estudo. A implantação de estudo pode usar o Vercel Hobby gratuito; antes de usar o portal em uma operação comercial real, revise o plano de hospedagem.
