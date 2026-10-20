import { describe, expect, it, vi } from 'vitest';
import { exports } from 'cloudflare:workers';
import { createApp } from '../src/index';
import { ApiError } from '../src/errors';
import type { Bindings } from '../src/env';
import type { WorkspaceContext } from '../src/auth/workspace';
import type { QueryExecutor } from '../src/databricks';
import { settingsFor } from '../src/databricks';
import { buildQueries } from '../src/dashboard/queries';
import { parseFilters } from '../src/dashboard/filters';
import { loadDashboard, parametersFor } from '../src/dashboard/service';

const env = {
  ASTRO_DB: { connectionString: 'postgres://test-only' } as Hyperdrive,
  FIREBASE_PROJECT_ID: 'astro-test', CORS_ALLOWED_ORIGINS: 'https://astro-inter.github.io',
  DATABRICKS_HOST: 'https://test.cloud.databricks.com', DATABRICKS_WAREHOUSE_ID: '0000000000000001',
  DATABRICKS_CLIENT_ID: 'test-client', DATABRICKS_CLIENT_SECRET: 'test-secret',
  DATABRICKS_CATALOG: 'workspace', DATABRICKS_SCHEMA: 'astro',
} satisfies Bindings;
const workspace: WorkspaceContext = { userId: '1', workspaceId: '20', role: 'GESTOR_WORKSPACE', unitIds: ['10', '11'] };
const filters = parseFilters(new URLSearchParams('start=2026-08-17&end=2026-10-16'));

function fixture(context: WorkspaceContext = workspace) {
  const execute = vi.fn<QueryExecutor['execute']>().mockImplementation(async (sql) => {
    if (sql.includes('AS colaboradores')) return [{ colaboradores: '8', nrs: '3', unidades: '2', gestores: '1' }];
    if (sql.includes('AS participantes')) return [{ turmas: '4', participantes: '7', participacoes_concluidas: '5' }];
    return [];
  });
  const createExecutor = vi.fn(() => ({ execute }));
  const app = createApp({ verifyIdentity: async () => ({ uid: 'verified-uid' }), resolveAccess: async () => context, createExecutor });
  return { app, execute, createExecutor };
}
const url = '/api/dashboard?start=2026-08-17&end=2026-10-16';

describe('rotas do Worker', () => {
  it('responde ao health no runtime real de Workers', async () => {
    const response = await exports.default.fetch('https://worker.test/health');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('não aceita X-Demo-User como autenticação', async () => {
    const response = await exports.default.fetch('https://worker.test/api/dashboard', { headers: { 'X-Demo-User': 'ana' } });
    expect(response.status).toBe(401);
  });
  it('retorna a identidade autorizada sem divulgar unidades internas', async () => {
    const { app } = fixture();
    const response = await app.request('/api/me', {}, env);
    expect(await response.json()).toEqual({ userId: '1', workspaceId: '20', role: 'GESTOR_WORKSPACE' });
  });
  it('exige autenticação antes de criar consultas', async () => {
    const createExecutor = vi.fn();
    const app = createApp({ verifyIdentity: async () => { throw new ApiError(401, 'invalid_token', 'Sessão expirada.'); }, createExecutor });
    expect((await app.request(url, {}, env)).status).toBe(401);
    expect(createExecutor).not.toHaveBeenCalled();
  });
  it('nega contas sem vínculo autorizado antes de consultar o lake', async () => {
    const createExecutor = vi.fn();
    const app = createApp({ verifyIdentity: async () => ({ uid: 'uid' }), resolveAccess: async () => { throw new ApiError(403, 'denied', 'Sem acesso.'); }, createExecutor });
    expect((await app.request(url, {}, env)).status).toBe(403);
    expect(createExecutor).not.toHaveBeenCalled();
  });
  it.each([
    '&workspace_id=999', '&workspaceId=999', '&unitId=999', '&sql=SELECT+1',
    '&start=2026-01-01', '&granularity=hora', '&view=administracao',
  ])('rejeita parâmetros não autorizados ou duplicados: %s', async (query) => {
    const { app, createExecutor } = fixture();
    expect((await app.request(`${url}${query}`, {}, env)).status).toBe(422);
    expect(createExecutor).not.toHaveBeenCalled();
  });
  it('aplica a lista de unidades do workspace verificado em todas as consultas', async () => {
    const { app, execute } = fixture();
    const response = await app.request(url, {}, env);
    const payload = await response.json() as { workspaceId: string; dataSource: string; charts: unknown[] };
    expect(response.status).toBe(200);
    expect(payload.workspaceId).toBe('20');
    expect(payload.dataSource).toBe('databricks');
    expect(payload.charts).toHaveLength(3);
    expect(execute).toHaveBeenCalledTimes(4);
    for (const [sql, parameters] of execute.mock.calls) {
      expect(sql).toContain('authorized_units');
      expect(parameters.find((p) => p.name === 'authorized_unit_ids')?.value).toBe('["10","11"]');
      expect(sql).not.toContain('10,11');
    }
  });
  it('troca as unidades autorizadas quando muda o workspace da sessão', async () => {
    const first = fixture(workspace);
    const second = fixture({ ...workspace, userId: '2', workspaceId: '21', unitIds: ['99'] });
    await first.app.request(url, {}, env);
    await second.app.request(url, {}, env);
    expect(first.execute.mock.calls[0]?.[1].find((p) => p.name === 'authorized_unit_ids')?.value).toBe('["10","11"]');
    expect(second.execute.mock.calls[0]?.[1].find((p) => p.name === 'authorized_unit_ids')?.value).toBe('["99"]');
  });
  it('retorna zeros e séries vazias para um workspace sem unidades ativas, sem consultar o lake', async () => {
    const { app, execute } = fixture({ ...workspace, unitIds: [] });
    const response = await app.request(url, {}, env);
    const payload = await response.json() as { kpis: { value: number }[]; charts: { rows: unknown[] }[] };
    expect(response.status).toBe(200);
    expect(payload.kpis.every((item) => item.value === 0)).toBe(true);
    expect(payload.charts.every((item) => item.rows.length === 0)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
  it('não retorna uma mensagem interna de exceção', async () => {
    const { app, execute } = fixture();
    execute.mockRejectedValue(new Error('secret credential / database url'));
    const response = await app.request(url, {}, env);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('secret credential');
  });
  it('responde ao preflight sem exigir sessão e limita CORS ao frontend permitido', async () => {
    const app = createApp();
    const preflight = await app.request('/api/dashboard', {
      method: 'OPTIONS', headers: { Origin: 'https://astro-inter.github.io', 'Access-Control-Request-Method': 'GET' },
    }, env);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('https://astro-inter.github.io');
    const denied = await app.request('/api/me', { headers: { Origin: 'https://untrusted.test' } }, env);
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('contrato de consultas e indicadores', () => {
  it.each([
    'start=2026-02-31&end=2026-03-01', 'start=2026-10-16&end=2026-08-17',
    'start=2025-01-01&end=2026-01-02', 'start=invalid&end=2026-10-16',
  ])('rejeita datas inexistentes e intervalos inválidos: %s', (query) => {
    expect(() => parseFilters(new URLSearchParams(query))).toThrow();
  });
  it('aceita ano bissexto de 366 dias e granularidades da interface', () => {
    expect(parseFilters(new URLSearchParams('start=2024-01-01&end=2024-12-31&granularity=semana')).granularity).toBe('semana');
  });
  it('todas as consultas carregam o escopo autorizado como parâmetro', () => {
    for (const sql of Object.values(buildQueries(settingsFor(env)))) {
      const parameters = parametersFor(sql, filters, workspace);
      expect(sql).toContain('from_json(:authorized_unit_ids');
      expect(parameters.find((p) => p.name === 'authorized_unit_ids')).toBeDefined();
      expect(sql).not.toMatch(/id_unidade\s*=\s*1\b/);
      expect(parameters.every((p) => sql.includes(`:${p.name}`))).toBe(true);
    }
  });
  it('agrega Eventos preservando a indicação de consultas sem filtro temporal', async () => {
    const { app, execute } = fixture();
    const response = await app.request(`${url}&view=eventos`, {}, env);
    const payload = await response.json() as { kpis: { value: number }[]; charts: { dateSensitive: boolean }[] };
    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(payload.kpis.map((item) => item.value)).toEqual([4, 7, 5]);
    expect(payload.charts.filter((item) => !item.dateSensitive)).toHaveLength(3);
  });
  it('rejeita totais inválidos em vez de criar indicadores fictícios', async () => {
    const executor = { execute: async () => [{ colaboradores: 'not-a-number' }] };
    await expect(loadDashboard(filters, workspace, settingsFor(env), executor)).rejects.toMatchObject({ code: 'invalid_metric' });
  });
});
