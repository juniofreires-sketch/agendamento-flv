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
- O cadastro aceita um fornecedor da lista ou um nome digitado. Um nome novo entra na base quando o administrador aprova a conta.
- A senha exige pelo menos 6 caracteres e pode ser exibida durante a digitação.
- Fornecedores veem apenas a aba de agendamento, com suas entregas confirmadas e canceladas. Administradores veem todas as abas e podem aprovar ou excluir contas de fornecedores sem apagar o histórico das entregas.
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

A senha do administrador está em `data/admin-initial-password.txt` somente neste computador e não foi enviada ao Git. Use esse conteúdo no portal publicado; a senha da conta Gmail não é a senha do portal.

## Entrada com Google

O botão Google aparece automaticamente quando o provedor Google estiver ativo no Supabase. Ele permite entrar usando o mesmo email de uma conta já aprovada; uma conta nova precisa primeiro ser cadastrada e aprovada pelo fluxo normal. O login pelo Google não concede papel de administrador nem acesso a outros fornecedores.

Para ativar no projeto Supabase deste portal, crie no [Google Auth Platform](https://console.cloud.google.com/auth/clients) um cliente OAuth do tipo **Aplicativo da Web**. Configure a origem `https://agendamento-flv-nu.vercel.app` e o URI de redirecionamento `https://vtnpnosxahubqfsinlko.supabase.co/auth/v1/callback`. Configure a tela de consentimento para público externo. Em seguida, informe o ID e o segredo do cliente na página **Authentication → Providers → Google** do projeto `vtnpnosxahubqfsinlko`. Mantenha o segredo fora do Git e do navegador.

No modo **Testing**, o Google limita o acesso aos usuários de teste autorizados; para todos os fornecedores, publique a tela de consentimento em **In production**. O portal consulta a configuração do Supabase a cada carregamento, então o botão passa a aparecer sem novo deploy depois da ativação.

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
