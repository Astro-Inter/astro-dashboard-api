import postgres from 'postgres';
import { z } from 'zod';
import { ApiError } from '../errors';

const numericId = z.string().regex(/^[1-9]\d{0,18}$/);
const membership = z.object({
  user_id: numericId,
  workspace_id: numericId,
  role: z.enum(['GESTOR', 'GESTOR_WORKSPACE']),
  unit_ids: z.array(numericId).max(10_000),
});

export interface WorkspaceContext {
  userId: string;
  workspaceId: string;
  role: 'GESTOR' | 'GESTOR_WORKSPACE';
  unitIds: string[];
}

// A identidade é verificada no Firebase; o vínculo e o estado atual vêm do Astro.
// clock_timestamp() torna a consulta não cacheável no Hyperdrive.
export const membershipSql = `
SELECT usr.id_usuario::text AS user_id, own_unit.workspace_id::text AS workspace_id,
       usr.tipo AS role, clock_timestamp() AS authorization_checked_at,
       COALESCE((
         SELECT array_agg(scope_unit.id_unidade::text ORDER BY scope_unit.id_unidade)
         FROM public.unidade scope_unit
         WHERE scope_unit.workspace_id = own_unit.workspace_id AND scope_unit.ativo IS TRUE
       ), ARRAY[]::text[]) AS unit_ids
FROM public.usuario usr
JOIN public.unidade own_unit ON own_unit.id_unidade = usr.unidade_id
JOIN public.workspace workspace ON workspace.id_workspace = own_unit.workspace_id
WHERE usr.firebase_uid = $1 AND usr.status = 'ATIVO'
  AND usr.tipo IN ('GESTOR', 'GESTOR_WORKSPACE')
  AND public.fn_retornar_nivel_acesso($1) = usr.tipo
  AND (own_unit.ativo IS TRUE OR usr.tipo = 'GESTOR_WORKSPACE')
LIMIT 2`;

export interface MembershipConnection {
  query(sql: string, parameters: string[]): Promise<{ rows: unknown[] }>;
  end(): Promise<unknown>;
}

type ConnectionFactory = (connectionString: string) => MembershipConnection;
const connect: ConnectionFactory = (connectionString) => {
  const client = postgres(connectionString, { max: 1, fetch_types: false, prepare: false, connect_timeout: 5 });
  return {
    async query(sql, parameters) {
      const pending = client.unsafe(sql, parameters);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const rows = await Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              try { pending.cancel(); } catch { /* A conexão será fechada no finally. */ }
              reject(new Error('Authorization query timeout'));
            }, 5_000);
          }),
        ]);
        return { rows };
      } finally { if (timer !== undefined) clearTimeout(timer); }
    },
    end: () => client.end({ timeout: 1 }),
  };
};

export async function resolveWorkspace(
  uid: string, binding: Hyperdrive | undefined, factory: ConnectionFactory = connect,
): Promise<WorkspaceContext> {
  if (!binding?.connectionString) {
    throw new ApiError(503, 'authorization_not_configured', 'Autorização indisponível.');
  }
  const client = factory(binding.connectionString);
  try {
    const result = await client.query(membershipSql, [uid]);
    if (result.rows.length !== 1) {
      throw new ApiError(403, 'workspace_access_denied', 'Conta sem acesso a um workspace ativo.');
    }
    const parsed = membership.safeParse(result.rows[0]);
    if (!parsed.success) {
      throw new ApiError(503, 'authorization_invalid_response', 'Não foi possível confirmar o workspace.');
    }
    const row = parsed.data;
    return {
      userId: row.user_id, workspaceId: row.workspace_id, role: row.role,
      unitIds: [...new Set(row.unit_ids)],
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'authorization_unavailable', 'Não foi possível consultar o acesso ao workspace.');
  } finally {
    await client.end().catch(() => undefined);
  }
}
