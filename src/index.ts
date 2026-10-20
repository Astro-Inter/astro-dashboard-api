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
  app.use('*', async (c, next) => {
    c.set('requestId', crypto.randomUUID());
    c.header('X-Request-Id', c.get('requestId'));
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.use('*', secureHeaders());
  app.use('/api/*', cors({
    origin: (origin, c) => allowedOrigins(c.env).includes(origin) ? origin : null,
    allowMethods: ['GET', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    exposeHeaders: ['X-Request-Id'],
    maxAge: 600,
    credentials: false,
  }));
  app.get('/health', (c) => c.json({ status: 'ok', service: 'astro-dashboard-api', version: '0.1.0' }));
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
    return c.json(await loadDashboard(filters, c.get('workspace'), config, dependencies.createExecutor(c.env)));
  });
  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Rota não encontrada.', requestId: c.get('requestId') } }, 404));
  app.onError((error, c) => {
    const safe = error instanceof ApiError ? error : new ApiError(503, 'service_unavailable', 'Serviço indisponível.');
    console.error(JSON.stringify({ code: safe.code, requestId: c.get('requestId') }));
    return c.json({ error: { code: safe.code, message: safe.message, requestId: c.get('requestId') } }, safe.status);
  });
  return app;
}

export default createApp();
