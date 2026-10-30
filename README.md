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

O build cria `dist/`, publicado segundo `vercel.json`. Antes de publicar em outro ambiente, crie um projeto Supabase novo, aplique `supabase/schema.sql` e `supabase/seed.sql` e ajuste as URLs de autenticação. Configure na hospedagem as mesmas duas variáveis de build. Nunca coloque uma chave `service_role` no navegador.

O administrador inicial foi criado por um processo administrativo controlado para `junior.matheus64@gmail.com`. O cadastro público sempre exige um fornecedor e cria uma conta pendente. Somente o administrador pode aprová-la; até então, o fornecedor não acessa o portal.

## Ambiente de estudo publicado

- Portal: https://agendamento-flv-nu.vercel.app
- Supabase: projeto `Agendamento FLV` (`vtnpnosxahubqfsinlko`) na organização `juniofreires-sketch's Org`, região `sa-east-1`.
- Vercel: projeto `agendamento-flv` na equipe Hobby `Indicadores CD`.
- Repositório: https://github.com/juniofreires-sketch/agendamento-flv (`main`).
- `supabase/config.toml` define a URL de retorno da autenticação. Os arquivos locais de credenciais e o banco SQLite ficam fora do Git.

Neste ambiente de estudo, a confirmação de email do Supabase está desativada para permitir o cadastro de fornecedores externos sem serviço SMTP. A aprovação manual deve incluir a conferência do vínculo do solicitante com o fornecedor. Para uso real, configure SMTP e reative a confirmação de email.

## Planos gratuitos

O plano Supabase Free comporta 430 fornecedores quanto ao número de contas, dentro da cota atual de usuários ativos. Ele tem cotas de armazenamento e tráfego e pode pausar projetos com pouca atividade.

Este projeto foi definido pelo proprietário como estudo. A implantação de estudo pode usar o Vercel Hobby gratuito; antes de usar o portal em uma operação comercial real, revise o plano de hospedagem.
