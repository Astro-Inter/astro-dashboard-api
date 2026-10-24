import type { WorkspaceContext } from '../auth/workspace';
import type { DatabricksSettings } from '../env';

const TTL = 90_000;
const MAX_BYTES = 8_000_000;
type Entry = { payload: string; bytes: number; expires: number };
// Apenas resultados resolvidos. Nenhuma Promise ou I/O atravessa requisições Workers.
export class DashboardCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  private remove(key: string) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
  async load<T extends object>(scope: WorkspaceContext, config: DatabricksSettings, query: unknown, refresh: boolean, compute: () => Promise<T>) {
    const keyBytes = new TextEncoder().encode(JSON.stringify(['catalog-2026-10-23-v1', config.DATABRICKS_HOST, config.DATABRICKS_CATALOG, config.DATABRICKS_SCHEMA, config.DATABRICKS_WAREHOUSE_ID, config.DATABRICKS_CLIENT_ID, scope.workspaceId, scope.userId, scope.role, [...scope.unitIds].sort(), query]));
    const key = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', keyBytes)), byte => byte.toString(16).padStart(2, '0')).join('');
    for (const [oldKey, entry] of this.entries) if (entry.expires <= Date.now()) this.remove(oldKey);
    const cached = this.entries.get(key);
    if (!refresh && cached) return { ...JSON.parse(cached.payload) as T, cache: { hit: true, ttlSeconds: TTL / 1000, expiresAt: new Date(cached.expires).toISOString() } };
    this.remove(key);
    const result = await compute();
    const payload = JSON.stringify(result), bytes = new TextEncoder().encode(payload).byteLength;
    const expires = Date.now() + TTL;
    if (bytes <= 1_000_000) {
      while ((this.entries.size >= 32 || this.bytes + bytes > MAX_BYTES) && this.entries.size) this.remove(this.entries.keys().next().value!);
      this.entries.set(key, { payload, bytes, expires }); this.bytes += bytes;
    }
    return { ...result, cache: { hit: false, ttlSeconds: TTL / 1000, expiresAt: new Date(expires).toISOString() } };
  }
}
