import { z } from 'zod';
import { viewSchema } from './dashboard/views';
import { explorerDatasets, operations } from './dashboard/explorer';
const explorerFields = [...new Set(explorerDatasets.flatMap(dataset => dataset.fields.map(field => field.id)))];
const aggregateSchema = { type: 'object', additionalProperties: false, required: ['field', 'operation'], properties: { field: { enum: explorerFields }, operation: { enum: operations } } };
const explorerQuery = { type: 'object', additionalProperties: false, required: ['dataset', 'groupBy', 'metric'], description: 'Campos, operações e combinações são validados para a base selecionada. Não aceita SQL, nomes arbitrários de tabela, joins ou IDs de workspace.', properties: {
  dataset: { enum: explorerDatasets.map(dataset => dataset.id) }, groupBy: { enum: ['none', ...explorerFields] }, series: { enum: explorerFields }, metric: aggregateSchema,
  formula: { type: 'object', additionalProperties: false, required: ['operator', 'operand'], properties: { operator: { enum: ['add', 'subtract', 'multiply', 'divide', 'percentage'] }, operand: aggregateSchema } },
  where: { type: 'array', maxItems: 3, default: [], items: { type: 'object', additionalProperties: false, required: ['field', 'operator', 'value'], properties: { field: { enum: explorerFields }, operator: { enum: ['equals', 'not_equals'] }, value: { type: 'string', minLength: 1, maxLength: 120 } } } },
} };
const refreshHeader = { name: 'X-Dashboard-Refresh', in: 'header', required: false, description: '1 consulta a fonte novamente e substitui o resultado em cache.', schema: { enum: ['0', '1'], default: '0' } };
const cacheSchema = { type: 'object', required: ['hit', 'ttlSeconds', 'expiresAt'], properties: { hit: { type: 'boolean' }, ttlSeconds: { const: 90 }, expiresAt: { type: 'string', format: 'date-time' } } };
const errorResponse = {
  description: 'Falha de autenticação, autorização, filtros ou dependência.',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
};
const json = (schema: Record<string, unknown>) => ({ description: 'Sucesso', content: { 'application/json': { schema } } });
const errors = Object.fromEntries(['401', '403', '422', '502', '503', '504'].map((code) => [code, errorResponse]));

export const openapi = {
  openapi: '3.1.0',
  info: { title: 'Astro Dashboard API', version: '0.1.0', description: 'Dados agregados do Databricks com autorização pelo workspace Astro da sessão Firebase.' },
  paths: {
    '/api/views': { get: { summary: 'Listar configurações pessoais de painéis no workspace atual', security: [{ firebase: [] }], responses: { '200': json({ type: 'object', properties: { items: { type: 'array', items: { type: 'object' } } } }), ...errors } } },
    '/api/views/{id}': {
      put: { summary: 'Criar (version zero) ou editar configuração com controle de versão', security: [{ firebase: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(viewSchema) } } }, responses: { '200': json({ type: 'object' }), '409': errorResponse, ...errors } },
      delete: { summary: 'Excluir configuração pessoal na versão atual', security: [{ firebase: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'version', in: 'query', required: true, schema: { type: 'integer', minimum: 1 } }], responses: { '204': { description: 'Excluído' }, '409': errorResponse, ...errors } },
    },
    '/api/explorer/catalog': { get: { summary: 'Bases e campos autorizados, com nomes e descrições de negócio', security: [{ firebase: [] }], responses: { '200': json({ type: 'object', required: ['version', 'datasets'], properties: { version: { type: 'string' }, datasets: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, description: { type: 'string' }, source: { type: 'string' }, dateDescription: { type: 'string' }, fields: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, description: { type: 'string' }, value: { type: 'string' }, kind: { enum: ['identifier', 'text', 'date', 'number'] }, operations: { type: 'array', items: { enum: operations } }, groupable: { type: 'boolean' } } } } } } } } }), ...errors } } },
    '/api/explorer/query': { post: { summary: 'Calcular um gráfico por campos do catálogo', security: [{ firebase: [] }], parameters: [refreshHeader], description: 'Autoriza o usuário em cada chamada, inclusive em hits de cache. Calcula agregações no Databricks. Divisões por zero e agregações sem valores são omitidas e contabilizadas em undefinedGroups.', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['query', 'filters'], properties: { query: { $ref: '#/components/schemas/ExplorerQuery' }, filters: { type: 'object', additionalProperties: false, required: ['start', 'end', 'granularity'], properties: { start: { type: 'string', format: 'date' }, end: { type: 'string', format: 'date' }, granularity: { enum: ['dia', 'semana', 'mes', 'ano'] } } } } } } } }, responses: { '200': json({ type: 'object', required: ['workspaceId', 'dataSource', 'generatedAt', 'filters', 'chart', 'cache'], properties: { workspaceId: { type: 'string' }, dataSource: { const: 'databricks' }, generatedAt: { type: 'string', format: 'date-time' }, filters: { type: 'object' }, cache: cacheSchema, chart: { type: 'object', required: ['title', 'dimensions', 'measure', 'rows'], properties: { title: { type: 'string' }, metricLabel: { type: 'string' }, dimensions: { type: 'array', items: { type: 'string' } }, measure: { const: 'valor' }, format: { enum: ['number', 'percent'] }, undefinedGroups: { type: 'integer', minimum: 0 }, rows: { type: 'array', items: { type: 'object', additionalProperties: { type: ['string', 'number'] } } } } } } }), ...errors } } },
    '/api/dashboard-catalog': { get: { summary: 'Indicadores e apresentações permitidos no editor', security: [{ firebase: [] }], responses: { '200': json({ type: 'object', properties: { items: { type: 'array', items: { type: 'object' } } } }), ...errors } } },
    '/health': { get: { summary: 'Estado do processo; não verifica dependências', responses: { '200': json({ type: 'object', properties: { status: { const: 'ok' }, service: { const: 'astro-dashboard-api' }, version: { type: 'string' } } }) } } },
    '/openapi.json': { get: { summary: 'Contrato OpenAPI', responses: { '200': json({ type: 'object' }) } } },
    '/api/me': { get: {
      summary: 'Identidade e workspace autorizados', security: [{ firebase: [] }],
      responses: { '200': json({ type: 'object', required: ['userId', 'workspaceId', 'role'], properties: {
        userId: { type: 'string' }, workspaceId: { type: 'string' }, role: { enum: ['GESTOR', 'GESTOR_WORKSPACE'] },
      } }), ...errors },
    } },
    '/api/dashboard': { get: {
      summary: 'KPIs e séries do workspace do usuário', security: [{ firebase: [] }],
      description: 'Não aceita workspace, unidade ou SQL do cliente. Intervalo inclusivo de no máximo 366 dias. Rejeita parâmetros desconhecidos ou repetidos.',
      parameters: [
        refreshHeader,
        { name: 'start', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
        { name: 'end', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
        { name: 'view', in: 'query', schema: { type: 'string', enum: ['visao-geral', 'eventos'], default: 'visao-geral' } },
        { name: 'granularity', in: 'query', schema: { type: 'string', enum: ['dia', 'semana', 'mes', 'ano'], default: 'mes' } },
      ],
      responses: { '200': json({ $ref: '#/components/schemas/Dashboard' }), ...errors },
    } },
  },
  components: {
    securitySchemes: { firebase: { type: 'http', scheme: 'bearer', bearerFormat: 'Firebase ID token' } },
    schemas: {
      ExplorerQuery: explorerQuery,
      Error: { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['code', 'message', 'requestId'], properties: { code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' } } } } },
      Dashboard: {
        type: 'object', required: ['view', 'workspaceId', 'filters', 'dataSource', 'generatedAt', 'title', 'kpis', 'charts'],
        properties: {
          view: { enum: ['visao-geral', 'eventos'] }, workspaceId: { type: 'string' }, title: { type: 'string' },
          filters: { type: 'object', required: ['start', 'end', 'view', 'granularity'], properties: { start: { type: 'string', format: 'date' }, end: { type: 'string', format: 'date' }, view: { enum: ['visao-geral', 'eventos'] }, granularity: { enum: ['dia', 'semana', 'mes', 'ano'] } } },
          dataSource: { const: 'databricks' }, generatedAt: { type: 'string', format: 'date-time' }, cache: cacheSchema,
          kpis: { type: 'array', items: { type: 'object', required: ['key', 'label', 'value', 'format', 'dateSensitive'], properties: { key: { type: 'string' }, label: { type: 'string' }, value: { type: 'integer', minimum: 0 }, format: { const: 'number' }, dateSensitive: { type: 'boolean' } } } },
          charts: { type: 'array', items: { type: 'object', required: ['title', 'kind', 'dimensions', 'measure', 'rows', 'dateSensitive'], properties: {
            title: { type: 'string' }, kind: { enum: ['line', 'bar'] }, dimensions: { type: 'array', items: { type: 'string' } }, measure: { type: 'string' }, dateSensitive: { type: 'boolean' },
            rows: { type: 'array', items: { type: 'object', additionalProperties: { type: ['string', 'number'] } } },
          } } },
        },
      },
    },
  },
};
