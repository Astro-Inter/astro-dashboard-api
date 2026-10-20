import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { ApiError } from '../errors';

const googleKeys = createRemoteJWKSet(new URL(
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
), { timeoutDuration: 5_000, cacheMaxAge: 3_600_000 });

export interface Identity { uid: string }

export async function verifyFirebaseToken(
  authorization: string | undefined, projectId: string | undefined, keys: JWTVerifyGetKey = googleKeys,
): Promise<Identity> {
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  if (!match?.[1] || match[1].length > 8192) {
    throw new ApiError(401, 'authentication_required', 'Informe um Firebase ID token válido.');
  }
  if (!projectId?.trim()) {
    throw new ApiError(503, 'firebase_not_configured', 'Autenticação indisponível.');
  }
  try {
    const { payload } = await jwtVerify(match[1], keys, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'exp', 'iat', 'auth_time'],
      clockTolerance: 5,
    });
    const now = Math.floor(Date.now() / 1000);
    if (!payload.sub || payload.sub.length > 128 || !payload.sub.trim()
      || typeof payload.auth_time !== 'number' || payload.auth_time <= 0 || payload.auth_time > now
      || typeof payload.iat !== 'number' || payload.iat > now) {
      throw new ApiError(401, 'invalid_token', 'Sessão inválida ou expirada.');
    }
    return { uid: payload.sub };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof errors.JOSEError && !(error instanceof errors.JWKSTimeout)) {
      throw new ApiError(401, 'invalid_token', 'Sessão inválida ou expirada.');
    }
    throw new ApiError(503, 'identity_provider_unavailable', 'Não foi possível verificar a sessão.');
  }
}
