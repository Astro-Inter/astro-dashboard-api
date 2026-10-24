# Visões editáveis no Astro Web

## Configurações no navegador

O Astro Web usa `localStorage` para salvar nome, filtros, ordem, tipo dos gráficos e receitas de cálculo. O armazenamento é separado por UID Firebase, usuário Astro e workspace. As configurações não sincronizam entre dispositivos, navegadores ou origens e são removidas quando os dados do site são apagados.

A API não oferece CRUD de visões, não acessa uma tabela de configurações e não exige migração para esse recurso. A implementação anterior de persistência foi retirada do código. Essa retirada não executa DROP ou DELETE em uma tabela que já exista no banco.

## Dados e autorização

Os dados analíticos continuam no Databricks. A API valida o token Firebase e consulta o vínculo atual no PostgreSQL Astro antes de consultar ou devolver resultados em cache. Configurações alteradas no navegador não concedem acesso a outro workspace; o servidor valida campos, operações e filtros e aplica o recorte autorizado.

- `GET /api/me`: confirmar identidade e workspace.
- `GET /api/dashboard`: indicadores prontos e filtros de período.
- `GET /api/dashboard-catalog`: catálogo dos indicadores prontos.
- `GET /api/explorer/catalog`: bases e campos autorizados com descrições acessíveis.
- `POST /api/explorer/query`: calcular um gráfico com uma receita permitida.

O editor não aceita SQL livre nem joins arbitrários. A API monta as consultas e executa as agregações no Databricks. Cálculos, agrupamentos e cache estão descritos em [Catálogo de cálculos e cache](catalogo-e-cache.md).

## Desenvolvimento e publicação

No Astro Web:

```dotenv
VITE_DASHBOARD_API_URL=https://astro-dashboard-api.app-4str0.workers.dev
VITE_DASHBOARD_API_PROXY_URL=http://127.0.0.1:8787
```

A segunda variável configura apenas o proxy Vite para a API local. Em produção, o frontend usa `VITE_DASHBOARD_API_URL` diretamente. Publique a versão da API com os catálogos e cálculos e configure `CORS_ALLOWED_ORIGINS` com a origem exata do web. São permitidos GET, POST e OPTIONS, com `Authorization`, `Content-Type` e `X-Dashboard-Refresh`.

Credenciais Databricks e a conexão PostgreSQL permanecem no servidor. O serviço de dashboards não grava tokens ou resultados analíticos no `localStorage`; somente configurações são persistidas pelo frontend.
