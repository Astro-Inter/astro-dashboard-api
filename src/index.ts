import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { allowedOrigins, type Bindings } from './env';
import { ApiError } from './errors';

type WorkerEnv = { Bindings: Bindings; Variables: { requestId: string } };

export function createApp() {
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
  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Rota não encontrada.', requestId: c.get('requestId') } }, 404));
  app.onError((error, c) => {
    const safe = error instanceof ApiError ? error : new ApiError(503, 'service_unavailable', 'Serviço indisponível.');
    console.error(JSON.stringify({ code: safe.code, requestId: c.get('requestId') }));
    return c.json({ error: { code: safe.code, message: safe.message, requestId: c.get('requestId') } }, safe.status);
  });
  return app;
}

export default createApp();
