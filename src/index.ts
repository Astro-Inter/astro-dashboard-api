import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { allowedOrigins, type Bindings } from './env';
import { ApiError } from './errors';
import { verifyFirebaseToken } from './auth/firebase';
import { resolveWorkspace, type WorkspaceContext } from './auth/workspace';
import { DatabricksClient, settingsFor, type QueryExecutor } from './databricks';
import { parseFilters } from './dashboard/filters';
import { loadDashboard } from './dashboard/service';
import { openapi } from './openapi';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { chartCatalog } from './dashboard/catalog';
import { DashboardCache } from './dashboard/cache';
import { explorerQuerySchema, loadExplorer, publicExplorerCatalog } from './dashboard/explorer';

type WorkerEnv = { Bindings: Bindings; Variables: { requestId: string; workspace: WorkspaceContext } };

export interface Dependencies {
  verifyIdentity: typeof verifyFirebaseToken;
  resolveAccess: typeof resolveWorkspace;
  createExecutor: (env: Bindings) => QueryExecutor;
}

export function createApp(overrides: Partial<Dependencies> = {}) {
  const dependencies: Dependencies = {
    verifyIdentity: verifyFirebaseToken, resolveAccess: resolveWorkspace,
    createExecutor: (env) => new DatabricksClient(settingsFor(env)), ...overrides,
  };
  const app = new Hono<WorkerEnv>();
  const dashboardCache = new DashboardCache();
  app.use('*', async (c, next) => {
    c.set('requestId', crypto.randomUUID());
    c.header('X-Request-Id', c.get('requestId'));
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.use('*', secureHeaders());
  app.use('/api/*', cors({
    origin: (origin, c) => allowedOrigins(c.env).includes(origin) ? origin : null,
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'X-Dashboard-Refresh'],
    exposeHeaders: ['X-Request-Id'],
    maxAge: 600,
    credentials: false,
  }));
  app.use('/api/explorer/query', bodyLimit({ maxSize: 16_384, onError: () => { throw new ApiError(422, 'query_too_large', 'Reduza a configuração do cálculo.'); } }));
  app.get('/health', (c) => c.json({ status: 'ok', service: 'astro-dashboard-api', version: '0.1.0' }));
  app.get('/openapi.json', (c) => c.json(openapi));
  app.use('/api/*', async (c, next) => {
    const identity = await dependencies.verifyIdentity(c.req.header('Authorization'), c.env.FIREBASE_PROJECT_ID);
    const workspace = await dependencies.resolveAccess(identity.uid, c.env.ASTRO_DB);
    c.set('workspace', workspace);
    await next();
  });
  app.get('/api/me', (c) => {
    const { userId, workspaceId, role } = c.get('workspace');
    return c.json({ userId, workspaceId, role });
  });
  app.get('/api/dashboard', async (c) => {
    const filters = parseFilters(new URL(c.req.url).searchParams);
    const config = settingsFor(c.env);
    const workspace = c.get('workspace');
    return c.json(await dashboardCache.load(workspace, config, { mode: 'dashboard', filters }, c.req.header('X-Dashboard-Refresh') === '1', () => loadDashboard(filters, workspace, config, dependencies.createExecutor(c.env))));
  });
  app.get('/api/dashboard-catalog', (c) => c.json({ items: chartCatalog }));
  app.get('/api/explorer/catalog', (c) => c.json(publicExplorerCatalog(settingsFor(c.env))));
  app.post('/api/explorer/query', async (c) => {
    const parsed = z.strictObject({ query: explorerQuerySchema, filters: z.strictObject({ start: z.string(), end: z.string(), granularity: z.enum(['dia', 'semana', 'mes', 'ano']) }) }).safeParse(await jsonBody(c.req));
    if (!parsed.success) throw new ApiError(422, 'invalid_explorer_query', 'Confira a base, os campos, os agrupamentos e os cálculos permitidos.');
    const filters = parseFilters(new URLSearchParams(parsed.data.filters));
    const config = settingsFor(c.env), workspace = c.get('workspace');
    return c.json(await dashboardCache.load(workspace, config, { mode: 'explorer', query: parsed.data.query, filters }, c.req.header('X-Dashboard-Refresh') === '1', () => loadExplorer(parsed.data.query, filters, workspace, config, dependencies.createExecutor(c.env))));
  });
  async function jsonBody(request: { json: () => Promise<unknown> }) {
    try { return await request.json(); } catch { throw new ApiError(422, 'invalid_explorer_query', 'Informe uma configuração de cálculo válida.'); }
  }
  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Rota não encontrada.', requestId: c.get('requestId') } }, 404));
  app.onError((error, c) => {
    const safe = error instanceof ApiError ? error : new ApiError(503, 'service_unavailable', 'Serviço indisponível.');
    console.error(JSON.stringify({ code: safe.code, requestId: c.get('requestId') }));
    return c.json({ error: { code: safe.code, message: safe.message, requestId: c.get('requestId') } }, safe.status);
  });
  return app;
}

export default createApp();
