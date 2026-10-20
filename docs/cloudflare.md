# Publicar a API no Cloudflare Workers

## Recursos necessários

1. Conta Cloudflare com Workers e Hyperdrive disponíveis.
2. PostgreSQL Astro acessível pelo Hyperdrive, com TLS e usuário de leitura dedicado.
3. Firebase Project ID do login Astro.
4. Databricks service principal atribuído ao workspace, com OAuth M2M, permissão `CAN USE` no SQL Warehouse, `USE CATALOG`, `USE SCHEMA` e `SELECT` nas tabelas consultadas.

O runtime não depende de Databricks CLI, PAT, sessão pessoal aberta ou login de cada visitante no Databricks. O token OAuth de acesso é renovado automaticamente com a identidade da aplicação; o **segredo do service principal** ainda tem validade e precisa ser rotacionado administrativamente antes de expirar.

## PostgreSQL e Hyperdrive

A conta dedicada precisa de `CONNECT` no banco, `USAGE` no schema `public`, leitura das colunas abaixo e execução da função existente. O administrador deve conceder as permissões no ambiente correto; esta API não cria usuários nem altera o esquema.

| Objeto | Colunas/permissão |
| --- | --- |
| `public.usuario` | `id_usuario`, `firebase_uid`, `status`, `tipo`, `unidade_id` |
| `public.unidade` | `id_unidade`, `workspace_id`, `ativo` |
| `public.workspace` | `id_workspace` |
| `public.admin` | `firebase_uid` (usada pela função de precedência) |
| `public.fn_retornar_nivel_acesso(text)` | `EXECUTE`; confirmar permissões das dependências da função no banco instalado |

Autentique o Wrangler e crie um Hyperdrive **sem query cache** para que alterações de acesso sejam percebidas na próxima chamada:

```powershell
npx wrangler login
npx wrangler hyperdrive create astro-dashboard-db --connection-string="$env:ASTRO_DATABASE_URL" --caching-disabled
```

`ASTRO_DATABASE_URL` deve ser fornecida por um canal seguro local, sem salvar sua senha no Git. Alternativamente, crie o recurso no painel Cloudflare e desabilite o cache de consultas. Substitua o ID de zeros em `wrangler.jsonc` pelo ID retornado, mantendo o binding `ASTRO_DB`. A consulta de autorização também usa `clock_timestamp()` para impedir cache desse resultado.

Se o PostgreSQL só aceitar conexões privadas, será necessário configurar um caminho de rede compatível antes da publicação. Não abra o banco publicamente como atalho.

## Variáveis e secrets

Preencha `vars` em `wrangler.jsonc` com os valores públicos do ambiente:

| Nome | Exemplo/descrição |
| --- | --- |
| `CORS_ALLOWED_ORIGINS` | `https://seu-frontend.example`; várias origens separadas por vírgula, sem caminho ou barra final |
| `FIREBASE_PROJECT_ID` | Identificador do projeto Firebase Astro |
| `DATABRICKS_HOST` | Origem HTTPS do workspace, sem caminho/query |
| `DATABRICKS_WAREHOUSE_ID` | ID hexadecimal de 16 caracteres do SQL Warehouse |
| `DATABRICKS_CATALOG` | `workspace`, se mantido o catálogo atual |
| `DATABRICKS_SCHEMA` | `astro`, se mantido o schema atual |

Cadastre as credenciais como secrets do Worker, preenchendo o valor apenas no prompt seguro do Wrangler:

```powershell
npx wrangler secret put DATABRICKS_CLIENT_ID
npx wrangler secret put DATABRICKS_CLIENT_SECRET
```

Não adicione essas credenciais em `vars`, no frontend ou no corpo de uma PR. Para desenvolvimento, `.dev.vars` fica apenas na máquina. Um ambiente de homologação deve usar outro Worker/Hyperdrive e credenciais próprias.

## Publicar e integrar

```powershell
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
npm run deploy
```

O Wrangler informará a URL real, semelhante a `https://astro-dashboard-api.<subdominio-da-conta>.workers.dev`. Esse exemplo não é um endereço já publicado. Configure essa URL em `VITE_DASHBOARD_API_URL` no frontend e faça o build/publicação do site.

Confirme `/health`, depois `/api/me` com uma sessão Firebase real, depois `/api/dashboard?start=2026-08-17&end=2026-10-16&granularity=mes&view=visao-geral` usando datas que existam no lake. Verifique duas contas de workspaces diferentes e confirme que o retorno acompanha o vínculo do banco principal. Faça essa validação integrada em homologação antes de liberar o serviço.

O workflow de CI executa instalação, tipos, testes e empacotamento. Ele não usa credenciais de produção e **não faz deploy**. Uma automação de publicação pode ser adicionada quando a conta, o domínio e os secrets do Cloudflare estiverem definidos.

## Operação

- Correlacione falhas pelo header `X-Request-Id`; os logs da aplicação contêm código do erro e identificador, sem token ou SQL.
- `/health` é apenas liveness; não confirma dependências.
- Verifique retomada/capacidade do SQL Warehouse se houver `504`; cold start pode exceder o orçamento de consulta. Não aumente o limite do frontend para esconder um warehouse parado.
- Tokens OAuth de curta duração ficam somente em memória; o Worker obtém outro quando necessário. Rotacione o secret da aplicação no Cloudflare quando vencer ou for substituído no Databricks.
- Ajuste rate limiting/WAF conforme tráfego e orçamento antes de exposição ampla, pois cada dashboard dispara consultas no warehouse. Respostas não são cacheadas entre usuários.
- Mudanças na estrutura do lake exigem revisar o SQL e o contrato; mudanças de dados aparecem depois da carga e da próxima consulta.

## Documentação oficial

- [PostgreSQL com Workers e Hyperdrive](https://developers.cloudflare.com/workers/tutorials/postgres/)
- [Comandos Hyperdrive e cache](https://developers.cloudflare.com/workers/wrangler/commands/hyperdrive/)
- [OAuth M2M Databricks](https://docs.databricks.com/aws/en/dev-tools/auth/oauth-m2m)
