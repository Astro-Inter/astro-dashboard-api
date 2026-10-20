import { z } from 'zod';
import { databricksSettings, type Bindings, type DatabricksSettings } from './env';
import { ApiError } from './errors';

export type Transport = (url: string, init?: RequestInit) => Promise<Response>;
export type SqlParameter = { name: string; value: string; type: 'STRING' | 'DATE' };
export type Row = Record<string, string | number | boolean | null>;
export interface QueryExecutor { execute(sql: string, parameters: SqlParameter[]): Promise<Row[]> }

type Token = { value: string; expiresAt: number };
// Só valores resolvidos são compartilhados. Promises/I/O ficam na requisição atual.
const tokenCache = new Map<string, Token>();
const http: Transport = (url, init) => fetch(url, init);

export class OAuthProvider {
  private pending: Promise<string> | undefined;
  constructor(private readonly settings: DatabricksSettings,
    private readonly transport: Transport = http,
    private readonly cache: Map<string, Token> = tokenCache) {}

  async token(): Promise<string> {
    const key = `${this.settings.DATABRICKS_HOST}|${this.settings.DATABRICKS_CLIENT_ID}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
    if (this.pending) return this.pending;
    this.pending = this.acquire(key);
    try { return await this.pending; } finally { this.pending = undefined; }
  }

  private async acquire(key: string): Promise<string> {
    try {
      const credentials = new TextEncoder().encode(
        `${this.settings.DATABRICKS_CLIENT_ID}:${this.settings.DATABRICKS_CLIENT_SECRET}`,
      );
      const response = await this.transport(`${this.settings.DATABRICKS_HOST.replace(/\/$/, '')}/oidc/v1/token`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8_000),
        headers: {
          Authorization: `Basic ${btoa(String.fromCharCode(...credentials))}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'all-apis' }),
      });
      if (!response.ok) throw new Error('OAuth refused');
      const payload = z.object({
        access_token: z.string().min(1), token_type: z.string().optional(),
        expires_in: z.number().positive().max(86_400),
      }).parse(await response.json());
      if (this.cache.size >= 4 && !this.cache.has(key)) {
        const oldest = this.cache.keys().next().value;
        if (oldest) this.cache.delete(oldest);
      }
      this.cache.set(key, { value: payload.access_token, expiresAt: Date.now() + payload.expires_in * 1000 });
      return payload.access_token;
    } catch {
      throw new ApiError(503, 'databricks_authentication_failed', 'Autenticação da fonte de dados indisponível.');
    }
  }
}

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const execution = z.object({
  statement_id: z.string().regex(/^[a-zA-Z0-9-]+$/).optional(),
  status: z.object({ state: z.string() }),
  manifest: z.object({
    schema: z.object({ columns: z.array(z.object({ name: z.string().min(1) })) }),
    truncated: z.boolean().optional(), total_row_count: z.number().optional(),
  }).optional(),
  result: z.object({
    data_array: z.array(z.array(cell)).optional(),
    next_chunk_index: z.number().nullish(), truncated: z.boolean().optional(),
  }).optional(),
});

export function settingsFor(env: Bindings): DatabricksSettings {
  const settings = databricksSettings.safeParse(env);
  if (!settings.success) {
    throw new ApiError(503, 'databricks_not_configured', 'Fonte de dados não configurada.');
  }
  return settings.data;
}

export class DatabricksClient implements QueryExecutor {
  private readonly oauth: OAuthProvider;
  constructor(private readonly settings: DatabricksSettings,
    private readonly transport: Transport = http,
    oauth?: OAuthProvider,
    private readonly timeoutMs = 30_000,
    private readonly pollMs = 500) {
    this.oauth = oauth ?? new OAuthProvider(settings, transport);
  }

  private async request(path: string, init: RequestInit, deadline: number): Promise<unknown> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ApiError(504, 'query_timeout', 'A consulta excedeu o tempo permitido.');
    try {
      const token = await this.oauth.token();
      const response = await this.transport(`${this.settings.DATABRICKS_HOST.replace(/\/$/, '')}${path}`, {
        ...init, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(8_000, deadline - Date.now()))),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      if (!response.ok) {
        throw new ApiError(503, 'databricks_unavailable', 'Fonte de dados indisponível.');
      }
      return await response.json();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (Date.now() >= deadline) throw new ApiError(504, 'query_timeout', 'A consulta excedeu o tempo permitido.');
      throw new ApiError(503, 'databricks_unavailable', 'Não foi possível consultar a fonte de dados.');
    }
  }

  async execute(sql: string, parameters: SqlParameter[]): Promise<Row[]> {
    const deadline = Date.now() + this.timeoutMs;
    let statementId: string | undefined;
    let finished = false;
    try {
      let payload = await this.request('/api/2.0/sql/statements', {
        method: 'POST',
        body: JSON.stringify({
          warehouse_id: this.settings.DATABRICKS_WAREHOUSE_ID,
          statement: sql, parameters, format: 'JSON_ARRAY', disposition: 'INLINE',
          wait_timeout: '0s', on_wait_timeout: 'CONTINUE', row_limit: 5_000, byte_limit: 2_000_000,
        }),
      }, deadline);
      for (;;) {
        const parsed = execution.safeParse(payload);
        if (!parsed.success) throw new ApiError(502, 'invalid_query_response', 'Resposta inválida da fonte de dados.');
        const result = parsed.data;
        statementId = result.statement_id ?? statementId;
        const state = result.status.state;
        if (state === 'SUCCEEDED') {
          finished = true;
          const columns = result.manifest?.schema.columns.map((column) => column.name);
          const rows = result.result?.data_array ?? [];
          if (result.manifest?.truncated || result.result?.truncated
            || result.result?.next_chunk_index != null
            || (result.manifest?.total_row_count ?? rows.length) > rows.length) {
            throw new ApiError(422, 'result_too_large', 'Reduza o período ou use uma granularidade maior.');
          }
          if (!columns || new Set(columns).size !== columns.length || rows.some((row) => row.length !== columns.length)) {
            throw new ApiError(502, 'invalid_query_response', 'Resposta inválida da fonte de dados.');
          }
          return rows.map((row) => Object.fromEntries(columns.map((name, index) => [name, row[index] ?? null])));
        }
        if (!['PENDING', 'RUNNING'].includes(state) || !statementId) {
          finished = true;
          throw new ApiError(502, 'query_failed', 'Não foi possível executar a consulta do dashboard.');
        }
        if (Date.now() + this.pollMs >= deadline) throw new ApiError(504, 'query_timeout', 'A consulta excedeu o tempo permitido.');
        await new Promise((resolve) => setTimeout(resolve, this.pollMs));
        payload = await this.request(`/api/2.0/sql/statements/${encodeURIComponent(statementId)}`, { method: 'GET' }, deadline);
      }
    } finally {
      if (statementId && !finished) {
        await this.request(`/api/2.0/sql/statements/${encodeURIComponent(statementId)}/cancel`,
          { method: 'POST' }, Date.now() + 2_000).catch(() => undefined);
      }
    }
  }
}
