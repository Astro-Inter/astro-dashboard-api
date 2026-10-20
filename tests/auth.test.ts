import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { verifyFirebaseToken } from '../src/auth/firebase';
import { membershipSql, resolveWorkspace, type MembershipConnection } from '../src/auth/workspace';

const project = 'astro-test';
let privateKey: CryptoKey;
let keys: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  keys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'test-key', alg: 'RS256' }] });
});

async function token(extra: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: `https://securetoken.google.com/${project}`, aud: project,
    sub: 'firebase-user', exp: now + 3600, iat: now, auth_time: now - 10, ...extra,
  }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(privateKey);
}

describe('Firebase ID token', () => {
  it('verifica a assinatura e retorna somente a identidade', async () => {
    expect(await verifyFirebaseToken(`Bearer ${await token({ workspace_id: '999' })}`, project, keys))
      .toEqual({ uid: 'firebase-user' });
  });
  it.each([undefined, 'Basic abc', 'Bearer', 'Bearer a b'])('rejeita Authorization inválido: %s', async (header) => {
    await expect(verifyFirebaseToken(header, project, keys)).rejects.toMatchObject({ status: 401 });
  });
  it.each([
    { aud: 'outro-projeto' }, { iss: 'https://example.com' }, { sub: '' },
    { sub: 'x'.repeat(129) }, { exp: 1 }, { iat: 9_999_999_999 },
    { auth_time: 9_999_999_999 }, { auth_time: 'ontem' },
  ])('rejeita claims inválidas: %j', async (claims) => {
    await expect(verifyFirebaseToken(`Bearer ${await token(claims)}`, project, keys))
      .rejects.toMatchObject({ status: 401 });
  });
  it('não aceita token adulterado', async () => {
    const signed = await token();
    const parts = signed.split('.');
    const corrupted = `${parts[0]}.${parts[1]}.AAAA`;
    await expect(verifyFirebaseToken(`Bearer ${corrupted}`, project, keys)).rejects.toMatchObject({ status: 401 });
  });
  it('falha sem configuração em vez de aceitar o usuário', async () => {
    await expect(verifyFirebaseToken(`Bearer ${await token()}`, undefined, keys)).rejects.toMatchObject({ status: 503 });
  });
});

const binding = { connectionString: 'postgres://test-only' } as Hyperdrive;
function database(rows: unknown[]) {
  return { connect: vi.fn().mockResolvedValue(undefined), query: vi.fn().mockResolvedValue({ rows }), end: vi.fn().mockResolvedValue(undefined) };
}

describe('autorização do workspace Astro', () => {
  it('resolve todas as unidades do workspace pelo UID verificado, com parâmetro SQL', async () => {
    const db = database([{ user_id: '10', workspace_id: '20', role: 'GESTOR', unit_ids: ['1', '2', '2'] }]);
    expect(await resolveWorkspace('firebase-user', binding, () => db)).toEqual({
      userId: '10', workspaceId: '20', role: 'GESTOR', unitIds: ['1', '2'],
    });
    expect(db.query).toHaveBeenCalledWith(membershipSql, ['firebase-user']);
    expect(membershipSql).toContain('clock_timestamp()');
    expect(membershipSql).toContain('scope_unit.workspace_id = own_unit.workspace_id');
    expect(db.end).toHaveBeenCalledOnce();
  });
  it.each([{ rows: [] }, { rows: [{}, {}] }])('nega usuário ausente ou identidade ambígua', async ({ rows }) => {
    const db = database(rows);
    await expect(resolveWorkspace('uid', binding, () => db)).rejects.toMatchObject({ status: 403 });
    expect(db.end).toHaveBeenCalledOnce();
  });
  it('nega vínculo inválido ou perfil não autorizado', async () => {
    const db = database([{ user_id: '1', workspace_id: '2', role: 'COLABORADOR', unit_ids: ['3'] }]);
    await expect(resolveWorkspace('uid', binding, () => db)).rejects.toMatchObject({ status: 503 });
  });
  it('encerra a conexão e não expõe erros do banco', async () => {
    const db = database([]);
    db.query.mockRejectedValue(new Error('postgres://private:secret@database'));
    await expect(resolveWorkspace('uid', binding, () => db)).rejects.toMatchObject({ code: 'authorization_unavailable' });
    expect(db.end).toHaveBeenCalledOnce();
  });
  it('nega acesso sem binding e sem chamar a fábrica de conexão', async () => {
    const factory = vi.fn<() => MembershipConnection>();
    await expect(resolveWorkspace('uid', undefined, factory)).rejects.toMatchObject({ status: 503 });
    expect(factory).not.toHaveBeenCalled();
  });
});
