import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../src/index';
import { viewSchema, toStored, toResponse, translate } from '../src/dashboard/views';
import { ApiError } from '../src/errors';
const id = '00000000-0000-4000-8000-000000000001';
const scope = { userId: '1', workspaceId: '2', role: 'GESTOR' as const, unitIds: ['3'] };
const input = { name: 'Meu painel', version: 0, config: { filters: { start: '2026-10-01', end: '2026-10-31', granularity: 'mes' }, widgets: [], artwork: 'trends' } };
function fixture() {
  const store = { list: vi.fn().mockResolvedValue([]), save: vi.fn().mockResolvedValue({ id }), remove: vi.fn().mockResolvedValue(undefined) };
  const app = createApp({ verifyIdentity: async () => ({ uid: 'verified' }), resolveAccess: async () => scope, viewStore: () => store });
  return { store, app: { request: (path: string, init?: RequestInit) => app.request(path, init, { CORS_ALLOWED_ORIGINS: '' }) } };
}
describe('configurações de painéis', () => {
  it('persiste estilo separado do nome e campos físicos em português', () => {
    const parsed = viewSchema.parse(input), stored = toStored(parsed);
    expect(stored).toEqual({ nome: 'Meu painel', estilo: 'trends', configuracao: { filtros: { inicio: '2026-10-01', fim: '2026-10-31', granularidade: 'mes' }, graficos: [] } });
    const now = new Date();
    expect(toResponse({ ...stored, painel_id: id, versao: 1, criado_em: now, atualizado_em: now })).toEqual({ id, name: input.name, config: input.config, version: 1, createdAt: now.toISOString(), updatedAt: now.toISOString() });
  });
  it('traduz receitas sem alterar os identificadores e valores do catálogo', () => {
    const query = { dataset: 'usuario', groupBy: 'cargo', metric: { field: 'registros', operation: 'count' }, where: [{ field: 'cargo', operator: 'equals', value: 'Gestor' }] };
    expect(translate(translate(query), true)).toEqual(query);
    expect(translate(query)).toHaveProperty('metrica.campo', 'registros');
  });
  it.each([
    { ...input, usuario_id: '99' }, { ...input, name: 'Painel [ac1:d:0]' },
    { ...input, config: { ...input.config, artwork: 'script' } },
    { ...input, config: { ...input.config, filters: { ...input.config.filters, start: '2026-02-31' } } },
    { ...input, config: { ...input.config, widgets: [{ id, datasetId: 'arbitrary', title: 'Teste', type: 'bar', width: 'half' }] } },
  ])('rejeita configuração inválida antes da persistência', async body => {
    const { app, store } = fixture();
    const result = await app.request(`/api/views/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(result.status).toBe(422); expect(store.save).not.toHaveBeenCalled();
  });
  it('usa o escopo autenticado para listar, salvar e excluir', async () => {
    const { app, store } = fixture();
    expect((await app.request('/api/views')).status).toBe(200);
    expect(store.list).toHaveBeenCalledWith(scope);
    expect((await app.request(`/api/views/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).status).toBe(200);
    expect(store.save).toHaveBeenCalledWith(scope, id, viewSchema.parse(input));
    expect((await app.request(`/api/views/${id}?version=2`, { method: 'DELETE' })).status).toBe(204);
    expect(store.remove).toHaveBeenCalledWith(scope,id,2);
  });
  it('mantém conflito de versão como 409', async () => {
    const { app, store } = fixture(); store.save.mockRejectedValue(new ApiError(409, 'view_conflict', 'Recarregue.'));
    expect((await app.request(`/api/views/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).status).toBe(409);
  });
});
