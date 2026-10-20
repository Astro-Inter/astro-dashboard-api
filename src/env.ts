import { z } from 'zod';

export interface Bindings {
  ASTRO_DB: Hyperdrive;
  CORS_ALLOWED_ORIGINS?: string;
  FIREBASE_PROJECT_ID?: string;
  DATABRICKS_HOST?: string;
  DATABRICKS_WAREHOUSE_ID?: string;
  DATABRICKS_CLIENT_ID?: string;
  DATABRICKS_CLIENT_SECRET?: string;
  DATABRICKS_CATALOG?: string;
  DATABRICKS_SCHEMA?: string;
}

const identifier = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
export const databricksSettings = z.object({
  DATABRICKS_HOST: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && !url.search && !url.hash && url.pathname === '/';
  }),
  DATABRICKS_WAREHOUSE_ID: z.string().regex(/^[a-fA-F0-9]{16}$/),
  DATABRICKS_CLIENT_ID: z.string().min(1),
  DATABRICKS_CLIENT_SECRET: z.string().min(1),
  DATABRICKS_CATALOG: identifier.default('workspace'),
  DATABRICKS_SCHEMA: identifier.default('astro'),
});

export type DatabricksSettings = z.infer<typeof databricksSettings>;

export function allowedOrigins(env: Bindings): string[] {
  return (env.CORS_ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
}
