import type { MongoClient, Document, MongoClientOptions } from 'mongodb';
import { z } from 'zod';
import type { Bindings } from '../env';
import type { WorkspaceContext } from '../auth/workspace';
import { ApiError } from '../errors';
import { chartCatalog } from './catalog';
import { explorerQuerySchema, explorerChartTypes } from './explorer';
import { parseFilters } from './filters';

const artwork = z.enum(['overview', 'trends', 'bars', 'donut', 'area', 'progress', 'comparison', 'scatter', 'activity', 'metrics']);
const widget = z.strictObject({ id: z.uuid(), datasetId: z.string(), title: z.string().trim().min(1).max(120), type: z.enum(['line', 'bar', 'pie']), width: z.enum(['half', 'full']), query: explorerQuerySchema.optional() }).refine(value => value.datasetId === 'custom'
  ? !!value.query && explorerChartTypes(value.query).includes(value.type)
  : chartCatalog.some(item => item.id === value.datasetId && (item.types as readonly string[]).includes(value.type)) && !value.query);
export const viewSchema = z.strictObject({ name: z.string().trim().min(1).max(120).refine(name => !/\[ac\d+:/.test(name)), config: z.strictObject({ filters: z.strictObject({ start: z.string(), end: z.string(), granularity: z.enum(['dia','semana','mes','ano']) }), widgets: z.array(widget).max(12).refine(rows => new Set(rows.map(row => row.id)).size === rows.length), artwork: artwork.optional() }), version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1) }).refine(value => {
  try { parseFilters(new URLSearchParams(value.config.filters)); return true; } catch { return false; }
});
export type ViewInput = z.infer<typeof viewSchema>;
const names: Record<string, string> = { filters:'filtros', start:'inicio', end:'fim', granularity:'granularidade', widgets:'graficos', id:'grafico_id', datasetId:'base_id', title:'titulo', type:'tipo', width:'largura', query:'consulta', dataset:'base', groupBy:'agrupamento', series:'serie', metric:'metrica', field:'campo', operation:'operacao', formula:'formula', operator:'operador', operand:'operando', where:'condicoes', value:'valor' };
export function translate(value: unknown, reverse = false): unknown {
  if (Array.isArray(value)) return value.map(item => translate(item, reverse));
  if (!value || typeof value !== 'object') return value;
  const mapping = reverse ? Object.fromEntries(Object.entries(names).map(([a,b]) => [b,a])) : names;
  return Object.fromEntries(Object.entries(value).map(([key,item]) => [mapping[key] ?? key, translate(item, reverse)]));
}
export function toStored(input: ViewInput) {
  const { artwork, ...config } = input.config;
  parseFilters(new URLSearchParams(config.filters));
  return { nome: input.name, estilo: artwork ?? 'overview', configuracao: translate(config) };
}
export function toResponse(row: Document) {
  return { id: row.painel_id, name: row.nome, config: { ...translate(row.configuracao, true) as object, artwork: row.estilo }, version: row.versao, createdAt: row.criado_em.toISOString(), updatedAt: row.atualizado_em.toISOString() };
}
export interface ViewStore {
  list(scope: WorkspaceContext): Promise<unknown[]>;
  save(scope: WorkspaceContext, id: string, input: ViewInput): Promise<unknown>;
  remove(scope: WorkspaceContext, id: string, version: number): Promise<void>;
}
export function createViewStore(env: Bindings): ViewStore {
  async function use<T>(action: (collection: ReturnType<ReturnType<MongoClient['db']>['collection']>) => Promise<T>) {
    if (!env.MONGODB_URI || !env.MONGODB_DATABASE) throw new ApiError(503, 'storage_not_configured', 'Armazenamento de dashboards indisponível.');
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(env.MONGODB_URI, { maxPoolSize: 2, serverSelectionTimeoutMS: 5000, socketTimeoutMS: 10000 } as MongoClientOptions);
    try { await client.connect(); return await action(client.db(env.MONGODB_DATABASE).collection('configuracoes_paineis')); }
    finally { await client.close(); }
  }
  const scopeFilter = (scope: WorkspaceContext) => ({ usuario_id: scope.userId, workspace_id: scope.workspaceId });
  const key = (scope: WorkspaceContext, id: string) => `${scope.workspaceId}:${scope.userId}:${id}`;
  const conflict = () => new ApiError(409, 'view_conflict', 'Esta visão mudou em outra sessão. Recarregue antes de salvar.');
  return {
    list: scope => use(async collection => (await collection.find(scopeFilter(scope)).sort({ atualizado_em: -1, _id: 1 }).toArray()).map(toResponse)),
    save: (scope, id, input) => use(async collection => {
      const now = new Date(), content = toStored(input);
      if (input.version === 0) {
        const row = { _id: key(scope,id), painel_id: id, ...scopeFilter(scope), ...content, versao: 1, criado_em: now, atualizado_em: now };
        try { await collection.insertOne(row as Document); } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 11000) throw conflict(); throw error; }
        return toResponse(row);
      }
      const row = await collection.findOneAndUpdate({ _id: key(scope,id), ...scopeFilter(scope), versao: input.version } as Document,
        { $set: { ...content, atualizado_em: now }, $inc: { versao: 1 } }, { returnDocument: 'after' });
      if (!row) throw conflict();
      return toResponse(row);
    }),
    remove: (scope,id,version) => use(async collection => {
      const result = await collection.deleteOne({ _id: key(scope,id), ...scopeFilter(scope), versao: version } as Document);
      if (!result.deletedCount) throw conflict();
    }),
  };
}
