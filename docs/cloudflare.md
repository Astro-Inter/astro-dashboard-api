# Publicar a API no Cloudflare Workers

## Recursos necessÃ¡rios

1. Conta Cloudflare com Workers e Hyperdrive disponÃ­veis.
2. PostgreSQL Astro acessÃ­vel pelo Hyperdrive, com TLS e usuÃ¡rio de leitura dedicado.
3. Firebase Project ID do login Astro.
4. Databricks service principal atribuÃ­do ao workspace, com OAuth M2M, permissÃ£o `CAN USE` no SQL Warehouse, `USE CATALOG`, `USE SCHEMA` e `SELECT` nas tabelas consultadas.

O runtime nÃ£o depende de Databricks CLI, PAT, sessÃ£o pessoal aberta ou login de cada visitante no Databricks. O token OAuth de acesso Ã© renovado automaticamente com a identidade da aplicaÃ§Ã£o; o **segredo do service principal** ainda tem validade e precisa ser rotacionado administrativamente antes de expirar.

## PostgreSQL e Hyperdrive

A conta dedicada precisa de `CONNECT` no banco, `USAGE` no schema `public`, leitura das colunas abaixo e execuÃ§Ã£o da funÃ§Ã£o existente. O administrador deve conceder as permissÃµes no ambiente correto; esta API nÃ£o cria usuÃ¡rios nem altera o esquema.

| Objeto | Colunas/permissÃ£o |
| --- | --- |
| `public.usuario` | `id_usuario`, `firebase_uid`, `status`, `tipo`, `unidade_id` |
| `public.unidade` | `id_unidade`, `workspace_id`, `ativo` |
| `public.workspace` | `id_workspace` |
| `public.admin` | `firebase_uid` (usada pela funÃ§Ã£o de precedÃªncia) |
| `public.fn_retornar_nivel_acesso(text)` | `EXECUTE`; confirmar permissÃµes das dependÃªncias da funÃ§Ã£o no banco instalado |

Autentique o Wrangler e crie um Hyperdrive **sem query cache** para que alteraÃ§Ãµes de acesso sejam percebidas na prÃ³xima chamada:

```powershell
npx wrangler login
npx wrangler hyperdrive create astro-dashboard-db --connection-string="$env:ASTRO_DATABASE_URL" --caching-disabled
```

`ASTRO_DATABASE_URL` deve ser fornecida por um canal seguro local, sem salvar sua senha no Git. Alternativamente, crie o recurso no painel Cloudflare e desabilite o cache de consultas. Substitua o ID de zeros em `wrangler.jsonc` pelo ID retornado, mantendo o binding `ASTRO_DB`. A consulta de autorizaÃ§Ã£o tambÃ©m usa `clock_timestamp()` para impedir cache desse resultado.

Se o PostgreSQL sÃ³ aceitar conexÃµes privadas, serÃ¡ necessÃ¡rio configurar um caminho de rede compatÃ­vel antes da publicaÃ§Ã£o. NÃ£o abra o banco publicamente como atalho.

## VariÃ¡veis e secrets

Preencha `vars` em `wrangler.jsonc` com os valores pÃºblicos do ambiente:

| Nome | Exemplo/descriÃ§Ã£o |
| --- | --- |
| `CORS_ALLOWED_ORIGINS` | `https://seu-frontend.example`; vÃ¡rias origens separadas por vÃ­rgula, sem caminho ou barra final |
| `FIREBASE_PROJECT_ID` | Identificador do projeto Firebase Astro |
| `DATABRICKS_HOST` | Origem HTTPS do workspace, sem caminho/query |
| `DATABRICKS_WAREHOUSE_ID` | ID hexadecimal de 16 caracteres do SQL Warehouse |
| `DATABRICKS_CATALOG` | `workspace`, se mantido o catÃ¡logo atual |
| `DATABRICKS_SCHEMA` | `astro`, se mantido o schema atual |

Cadastre as credenciais como secrets do Worker, preenchendo o valor apenas no prompt seguro do Wrangler:

```powershell
npx wrangler secret put DATABRICKS_CLIENT_ID
npx wrangler secret put DATABRICKS_CLIENT_SECRET
```

NÃ£o adicione essas credenciais em `vars`, no frontend ou no corpo de uma PR. Para desenvolvimento, `.dev.vars` fica apenas na mÃ¡quina. Um ambiente de homologaÃ§Ã£o deve usar outro Worker/Hyperdrive e credenciais prÃ³prias.

## Publicar e integrar

```powershell
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
npm run deploy
```

O Wrangler informarÃ¡ a URL real, semelhante a `https://astro-dashboard-api.<subdominio-da-conta>.workers.dev`. Esse exemplo nÃ£o Ã© um endereÃ§o jÃ¡ publicado. Configure essa URL em `VITE_DASHBOARD_API_URL` no frontend e faÃ§a o build/publicaÃ§Ã£o do site.

Confirme `/health`, depois `/api/me` com uma sessÃ£o Firebase real, depois `/api/dashboard?start=2026-08-17&end=2026-10-16&granularity=mes&view=visao-geral` usando datas que existam no lake. Verifique duas contas de workspaces diferentes e confirme que o retorno acompanha o vÃ­nculo do banco principal. FaÃ§a essa validaÃ§Ã£o integrada em homologaÃ§Ã£o antes de liberar o serviÃ§o.

O workflow de CI executa instalaÃ§Ã£o, tipos, testes e empacotamento. Ele nÃ£o usa credenciais de produÃ§Ã£o e **nÃ£o faz deploy**. Uma automaÃ§Ã£o de publicaÃ§Ã£o pode ser adicionada quando a conta, o domÃ­nio e os secrets do Cloudflare estiverem definidos.

## OperaÃ§Ã£o

- Correlacione falhas pelo header `X-Request-Id`; os logs da aplicaÃ§Ã£o contÃªm cÃ³digo do erro e identificador, sem token ou SQL.
- `/health` Ã© apenas liveness; nÃ£o confirma dependÃªncias.
- Verifique retomada/capacidade do SQL Warehouse se houver `504`; cold start pode exceder o orÃ§amento de consulta. NÃ£o aumente o limite do frontend para esconder um warehouse parado.
- Tokens OAuth de curta duraÃ§Ã£o ficam somente em memÃ³ria; o Worker obtÃ©m outro quando necessÃ¡rio. Rotacione o secret da aplicaÃ§Ã£o no Cloudflare quando vencer ou for substituÃ­do no Databricks.
- Ajuste rate limiting/WAF conforme trÃ¡fego e orÃ§amento antes de exposiÃ§Ã£o ampla, pois cada dashboard dispara consultas no warehouse. Respostas nÃ£o sÃ£o cacheadas entre usuÃ¡rios.
- MudanÃ§as na estrutura do lake exigem revisar o SQL e o contrato; mudanÃ§as de dados aparecem depois da carga e da prÃ³xima consulta.

## DocumentaÃ§Ã£o oficial

- [PostgreSQL com Workers e Hyperdrive](https://developers.cloudflare.com/workers/tutorials/postgres/)
- [Comandos Hyperdrive e cache](https://developers.cloudflare.com/workers/wrangler/commands/hyperdrive/)
- [OAuth M2M Databricks](https://docs.databricks.com/aws/en/dev-tools/auth/oauth-m2m)

## Atualização do modelo de participações

As consultas usam `turma_colaborador`, `id_turma_colaborador` e
`conclusao_evento.turma_colaborador_id`. Publique a API Medallion atualizada e
execute a ingestão no Databricks para materializar esses nomes no schema
configurado antes de publicar esta versão do dashboard. As tabelas antigas
não são removidas por esta alteração.
