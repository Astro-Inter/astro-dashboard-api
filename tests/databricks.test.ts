import { describe, expect, it, vi } from 'vitest';
import { DatabricksClient, OAuthProvider, settingsFor, type Transport } from '../src/databricks';
import type { Bindings, DatabricksSettings } from '../src/env';

const settings: DatabricksSettings = {
  DATABRICKS_HOST: 'https://test.cloud.databricks.com', DATABRICKS_WAREHOUSE_ID: '0000000000000001',
  DATABRICKS_CLIENT_ID: 'test-client', DATABRICKS_CLIENT_SECRET: 'test-secret',
  DATABRICKS_CATALOG: 'workspace', DATABRICKS_SCHEMA: 'astro',
};
const success = (extra: object = {}) => ({
  statement_id: 'statement-1', status: { state: 'SUCCEEDED' },
  manifest: { schema: { columns: [{ name: 'total' }] }, total_row_count: 1 },
  result: { data_array: [['12']] }, ...extra,
});
function setup(handler: Transport) {
  const transport = vi.fn<Transport>(async (url, init) => {
    if (url.endsWith('/oidc/v1/token')) return Response.json({ access_token: 'oauth-test-only', expires_in: 3600 });
    return handler(url, init);
  });
  const provider = new OAuthProvider(settings, transport, new Map());
  return { transport, provider, client: new DatabricksClient(settings, transport, provider, 1000, 0) };
}

describe('OAuth M2M', () => {
  it('obtém e reutiliza o token sem PAT', async () => {
    const { provider, transport } = setup(async () => Response.json({}));
    expect(await provider.token()).toBe('oauth-test-only');
    expect(await provider.token()).toBe('oauth-test-only');
    expect(transport).toHaveBeenCalledOnce();
    const init = transport.mock.calls[0]?.[1];
    expect(String(init?.body)).toContain('grant_type=client_credentials');
    expect(new Headers(init?.headers).get('Authorization')).toMatch(/^Basic /);
    expect(init?.redirect).toBe('manual');
  });
  it.each([301, 302, 303, 307, 308])('rejeita redirecionamento OAuth %s sem reenviar credenciais', async (status) => {
    const transport = vi.fn<Transport>(async () => new Response(null, {
      status, headers: { Location: 'https://untrusted.test/capture' },
    }));
    const provider = new OAuthProvider(settings, transport, new Map());
    await expect(provider.token()).rejects.toMatchObject({ status: 503, code: 'databricks_authentication_failed' });
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]?.[0]).toBe(`${settings.DATABRICKS_HOST}/oidc/v1/token`);
    expect(transport.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });
  it('não expõe a resposta de autenticação em caso de falha', async () => {
    const provider = new OAuthProvider(settings, async () => new Response('private secret', { status: 401 }), new Map());
    await expect(provider.token()).rejects.toMatchObject({ status: 503, code: 'databricks_authentication_failed' });
  });
  it('rejeita host inseguro ou identificadores de tabela manipulados', () => {
    for (const change of [{ DATABRICKS_HOST: 'http://example.com' }, { DATABRICKS_SCHEMA: 'astro; DROP TABLE usuario' }]) {
      expect(() => settingsFor({ ...settings, ...change } as Bindings)).toThrow('Fonte de dados não configurada.');
    }
  });
});

describe('Statement Execution API', () => {
  it.each([301, 302, 303, 307, 308])('rejeita redirecionamento SQL %s sem reenviar o token', async (status) => {
    const { client, transport } = setup(async () => new Response(null, {
      status, headers: { Location: 'https://untrusted.test/capture' },
    }));
    await expect(client.execute('SELECT 12', [])).rejects.toMatchObject({ status: 503, code: 'databricks_unavailable' });
    expect(transport.mock.calls.map(([url]) => url)).toEqual([
      `${settings.DATABRICKS_HOST}/oidc/v1/token`, `${settings.DATABRICKS_HOST}/api/2.0/sql/statements`,
    ]);
    expect(transport.mock.calls[1]?.[1]?.redirect).toBe('manual');
  });
  it('envia parâmetros preparados e devolve apenas registros do resultado', async () => {
    const { client, transport } = setup(async () => Response.json(success()));
    expect(await client.execute('SELECT :value AS total', [{ name: 'value', value: '12', type: 'STRING' }]))
      .toEqual([{ total: '12' }]);
    const submit = transport.mock.calls.find(([url]) => url.endsWith('/sql/statements'));
    const body = JSON.parse(String(submit?.[1]?.body));
    expect(body.parameters).toEqual([{ name: 'value', value: '12', type: 'STRING' }]);
    expect(body).toMatchObject({ disposition: 'INLINE', row_limit: 5000, wait_timeout: '0s' });
  });
  it('acompanha consultas pendentes até a conclusão', async () => {
    const { client, transport } = setup(async (_url, init) => Response.json(
      init?.method === 'POST' ? { statement_id: 'statement-1', status: { state: 'PENDING' } } : success(),
    ));
    expect(await client.execute('SELECT 12', [])).toEqual([{ total: '12' }]);
    expect(transport.mock.calls.some(([url, init]) => url.endsWith('/statement-1') && init?.method === 'GET')).toBe(true);
  });
  it.each([
    { result: { data_array: [['12']], next_chunk_index: 1 } },
    { manifest: { schema: { columns: [{ name: 'total' }] }, truncated: true } },
    { manifest: { schema: { columns: [{ name: 'total' }] }, total_row_count: 100 } },
  ])('rejeita resultados parciais em vez de mostrar gráficos incompletos', async (extra) => {
    const { client } = setup(async () => Response.json(success(extra)));
    await expect(client.execute('SELECT 12', [])).rejects.toMatchObject({ status: 422, code: 'result_too_large' });
  });
  it('não expõe mensagens internas de SQL', async () => {
    const { client } = setup(async () => Response.json({ status: { state: 'FAILED', error: { message: 'private SQL schema' } } }));
    await expect(client.execute('SELECT 12', [])).rejects.toMatchObject({ status: 502, message: 'Não foi possível executar a consulta do dashboard.' });
  });
  it('cancela uma consulta que ultrapassa o limite', async () => {
    const { transport, provider } = setup(async () => Response.json({ statement_id: 'statement-1', status: { state: 'RUNNING' } }));
    const client = new DatabricksClient(settings, transport, provider, 1000, 2000);
    await expect(client.execute('SELECT 12', [])).rejects.toMatchObject({ status: 504 });
    expect(transport.mock.calls.some(([url, init]) => url.endsWith('/statement-1/cancel') && init?.method === 'POST')).toBe(true);
  });
  it('rejeita uma resposta fora do contrato', async () => {
    const { client } = setup(async () => Response.json(success({ result: { data_array: [['12', '13']] } })));
    await expect(client.execute('SELECT 12', [])).rejects.toMatchObject({ status: 502 });
  });
  it('converte indisponibilidade upstream em erro seguro', async () => {
    const { client } = setup(async () => new Response('private upstream', { status: 429 }));
    await expect(client.execute('SELECT 12', [])).rejects.toMatchObject({ status: 503 });
  });
});
