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
      Error: { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['code', 'message', 'requestId'], properties: { code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' } } } } },
      Dashboard: {
        type: 'object', required: ['view', 'workspaceId', 'filters', 'dataSource', 'generatedAt', 'title', 'kpis', 'charts'],
        properties: {
          view: { enum: ['visao-geral', 'eventos'] }, workspaceId: { type: 'string' }, title: { type: 'string' },
          filters: { type: 'object', required: ['start', 'end', 'view', 'granularity'], properties: { start: { type: 'string', format: 'date' }, end: { type: 'string', format: 'date' }, view: { enum: ['visao-geral', 'eventos'] }, granularity: { enum: ['dia', 'semana', 'mes', 'ano'] } } },
          dataSource: { const: 'databricks' }, generatedAt: { type: 'string', format: 'date-time' },
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
