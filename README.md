# Astro Dashboard API

API de leitura em TypeScript e Hono, preparada para **Cloudflare Workers**, que entrega indicadores e séries do Databricks para o frontend Astro desenhar os gráficos.

## Como funciona

```mermaid
sequenceDiagram
    participant Front as Frontend Astro
    participant API as Cloudflare Worker
    participant Auth as Firebase
    participant DB as PostgreSQL via Hyperdrive
    participant Lake as Databricks SQL
    Front->>Auth: Login existente
    Auth-->>Front: ID token
    Front->>API: Bearer ID token + datas e granularidade
    API->>API: Validar assinatura, emissor, público e validade
    API->>DB: Consultar usuário, papel, workspace e unidades ativas
    DB-->>API: Escopo autorizado atual
    API->>Lake: OAuth de aplicação + SQL parametrizado
    Lake-->>API: Agregações do workspace
    API-->>Front: JSON com KPIs e séries
    Front->>Front: Renderizar gráficos
```

O usuário externo entra no Astro com Firebase. Ele não precisa de conta ou sessão no Databricks. A API identifica o workspace pelo vínculo no banco principal; o navegador não pode escolher um workspace, uma unidade ou uma consulta SQL.

As consultas usam as tabelas reais de `workspace.astro`. A tabela `unidade` do lake atualmente não contém `workspace_id`: a API resolve no PostgreSQL as unidades ativas do workspace e passa seus IDs como parâmetro JSON ao SQL. Esse vínculo deve ser mantido com os mesmos IDs nos dois sistemas. O workspace aqui é o do **Astro**, não o ID do ambiente Databricks.

## Requisitos e configuração local

- Node.js 24 e npm.
- Projeto Firebase usado pelo Astro.
- PostgreSQL do Astro acessível, com o esquema e a função de autorização existentes.
- SQL Warehouse Databricks e service principal com OAuth M2M.

```powershell
npm ci --ignore-scripts
Copy-Item .dev.vars.example .dev.vars
```

Preencha `.dev.vars` com os valores do seu ambiente. Esse arquivo é ignorado pelo Git. Para o PostgreSQL local, defina a conexão antes de iniciar:

```powershell
$env:CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_ASTRO_DB = "postgres://usuario:senha@host:5432/banco?sslmode=require"
npm run dev
```

Use uma conexão de desenvolvimento com acesso somente de leitura. A senha deve ser codificada para URL quando tiver caracteres especiais. O exemplo em `wrangler.jsonc` é um endereço fictício local e precisa ser substituído ou sobrescrito pela variável acima.

- API local: `http://localhost:8787`
- Saúde do processo: `http://localhost:8787/health`
- Contrato: `http://localhost:8787/openapi.json`

O `health` não consulta dependências. Um `200` nele não confirma acesso ao PostgreSQL ou Databricks. As rotas protegidas precisam de um ID token Firebase válido; não há autenticação por usuário de demonstração.

## Endpoints

| Método | Rota | Autenticação | Resultado |
| --- | --- | --- | --- |
| GET | `/health` | Pública | Estado do processo |
| GET | `/openapi.json` | Pública | Contrato OpenAPI 3.1 |
| GET | `/api/me` | Bearer Firebase | `userId`, `workspaceId`, `role` |
| GET | `/api/dashboard` | Bearer Firebase | KPIs e séries agregados |

Parâmetros de `/api/dashboard`:

| Nome | Valores | Regra |
| --- | --- | --- |
| `start` | `YYYY-MM-DD` | Obrigatório |
| `end` | `YYYY-MM-DD` | Obrigatório; intervalo inclusivo até 366 dias |
| `view` | `visao-geral`, `eventos` | Padrão `visao-geral` |
| `granularity` | `dia`, `semana`, `mes`, `ano` | Padrão `mes` |

Datas inexistentes, parâmetros desconhecidos ou repetidos retornam `422`. Workspace e IDs usam strings para preservar a precisão de BIGINT. Erros seguem `{ "error": { "code": "...", "message": "...", "requestId": "..." } }`.

| Status | Como o frontend deve agir |
| --- | --- |
| 401 | Renovar o ID token uma vez ou pedir login |
| 403 | Informar que a conta não tem acesso ao workspace |
| 422 | Corrigir os filtros ou reduzir o período se o resultado excedeu o limite |
| 502 | Informar falha ou resposta inválida da fonte |
| 503 | Informar indisponibilidade ou configuração pendente |
| 504 | Informar que a consulta excedeu o tempo; permitir tentar novamente |

## Integração com o frontend

Use o usuário Firebase que já está autenticado no site. O ID token Firebase é diferente da credencial do Databricks.

```typescript
import { getAuth } from 'firebase/auth';

const API_URL = import.meta.env.VITE_DASHBOARD_API_URL;

export async function carregarDashboard(
  filtros: { start: string; end: string; view: 'visao-geral' | 'eventos'; granularity: 'dia' | 'semana' | 'mes' | 'ano' },
  signal?: AbortSignal,
) {
  const user = getAuth().currentUser;
  if (!user) throw new Error('Entre na sua conta.');
  const url = new URL('/api/dashboard', API_URL);
  url.search = new URLSearchParams(filtros).toString();
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const token = await user.getIdToken(tentativa === 1);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }, signal,
    });
    if (response.status === 401 && tentativa === 0) continue;
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message ?? 'Não foi possível carregar o dashboard.');
    return payload;
  }
  throw new Error('Entre novamente na sua conta.');
}
```

`VITE_DASHBOARD_API_URL` contém somente a URL pública da API. Ao mudar datas ou granularidade, faça nova chamada. Ao trocar o usuário, descarte os dados anteriores e cancele a requisição anterior com `AbortController`, evitando exibir uma resposta antiga na nova sessão.

O frontend usa `kpis[]` para cartões e `charts[]` para os gráficos. Cada gráfico informa `kind` (`line` ou `bar`), `dimensions`, `measure`, `rows` e `dateSensitive`. Uma série com duas dimensões, por exemplo `data` e `cargo`, deve ser separada por cargo. Mostre “Sem dados no período” para séries vazias. Não esconda a informação de que um indicador com `dateSensitive: false` não acompanha o filtro de datas.

## Significado dos indicadores e atualização

- **Visão Geral:** colaboradores no snapshot da data final, catálogo de NRs, unidades, gestores, evolução por data/cargo e colaboradores associados ao catálogo NR da unidade.
- **Eventos:** turmas no período pela data inicial, participantes distintos, participações concluídas, evolução por NR e distribuição de eventos.
- “Participações concluídas” conta inscrições concluídas; não representa turmas inteiramente concluídas.
- A associação entre colaborador e NR do catálogo da unidade não comprova capacitação individual.
- Colaboradores na data final exigem um snapshot nessa data. A API não substitui uma data ausente por dados fictícios.
- Catálogo, unidades, gestores e distribuição de eventos usam o estado disponível no lake e sinalizam `dateSensitive: false` quando não há filtro temporal adequado. As tabelas atuais de eventos não fornecem uma data de criação para essa distribuição.

Mudanças no banco principal afetam o vínculo de acesso na próxima chamada. Os gráficos usam o **lake Databricks**: mudanças operacionais aparecem depois da carga/ETL correspondente e de uma nova chamada do frontend. Esta implementação não oferece atualização em tempo real nem espelha um dashboard publicado. O JSON `.lvdash` não executa consultas no navegador; as consultas e o contrato desta API são versionados aqui.

## Segurança e limites

- Firebase RS256, emissor e público do projeto são validados com as chaves públicas do Google.
- O vínculo e o papel são consultados em cada chamada. Somente `GESTOR` e `GESTOR_WORKSPACE` ativos têm acesso; ambos recebem as unidades ativas do seu workspace, conforme o escopo solicitado para este serviço.
- A função `fn_retornar_nivel_acesso` mantém a precedência de papéis do Astro. Uma identidade também reconhecida como `ADMIN` não ganha uma visão global neste serviço.
- A validação local do JWT não consulta revogação no Firebase. Bloquear o usuário no Astro nega a próxima chamada; uma revogação apenas no Firebase pode esperar a validade do ID token terminar.
- SQL fixo no servidor, parâmetros tipados, nenhuma credencial no frontend, respostas `no-store`, erros sem SQL/segredos.
- Limites: 10 mil unidades no escopo, 366 dias inclusivos, 5 mil linhas/2 MB por consulta e até 30 segundos de execução SQL. Respostas truncadas são rejeitadas; não viram gráficos incompletos silenciosamente.
- CORS deve conter as origens exatas do site. CORS não substitui autenticação.

## Publicação no Cloudflare

Veja o [guia de publicação](docs/cloudflare.md). O repositório contém configuração e CI; a criação dos recursos e o deploy não são executados automaticamente. O Hyperdrive e as variáveis do ambiente estão com placeholders explícitos.

## Qualidade e organização

```powershell
npm run typecheck
npm test
npm run build
```

Os testes executam em workerd e usam respostas controladas para autenticação, PostgreSQL e Databricks. Validam isolamento, assinaturas JWT, parâmetros, erros e polling; não são uma conexão completa de produção. `build` é um dry run e não publica nada. O CI repete essas verificações nas PRs.

| Diretório | Responsabilidade |
| --- | --- |
| `src/auth` | Firebase e resolução de workspace |
| `src/dashboard` | Filtros, SQL e agregações |
| `src/databricks.ts` | OAuth M2M e Statement Execution API |
| `src/openapi.ts` | Contrato do frontend |
| `tests` | Testes no runtime Workers |

Trabalho relacionado: [SCRUM-593](https://luizacursino.atlassian.net/browse/SCRUM-593), subtarefas SCRUM-594 a SCRUM-599. A `main` exige PR e pelo menos uma aprovação.
