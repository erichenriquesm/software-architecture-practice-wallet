import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, test } from 'vitest';
import type { UserTokenClaims } from '../../../../../src/infra/platform/security/userToken.js';
import {
  InvalidUserTokenError,
  registerUserTokenGuard,
  userAccountIdOf,
  verifyUserToken,
} from '../../../../../src/infra/platform/security/userToken.js';
import { createUserTokenSigner, signToken } from '../../../../support/userTokens.js';

const now = 1_800_000_000;
const signer = createUserTokenSigner('wallet');
const claims = (overrides: Partial<UserTokenClaims> = {}): Partial<UserTokenClaims> => ({ iat: now, exp: now + 60, ...overrides });
const verifyAtNow = (token: string) => verifyUserToken(token, signer.publicKey, 'wallet', now);

describe('verifyUserToken', () => {
  test('Should return the claims of a token signed by the account service for this audience', () => {
    // Given
    const accountId = randomUUID();

    // When
    const verified = verifyAtNow(signer.token(accountId, claims()));

    // Then
    expect(verified).toMatchObject({ iss: 'account', sub: accountId, aud: 'wallet', iat: now, exp: now + 60 });
  });

  test('Should tolerate 5 seconds of clock skew after exp, and no more', () => {
    // Given
    const token = signer.token(randomUUID(), claims({ exp: now - 5 }));
    const expired = signer.token(randomUUID(), claims({ exp: now - 6 }));

    // When & Then
    expect(verifyAtNow(token).exp).toBe(now - 5);
    expect(() => verifyAtNow(expired)).toThrowError('expired');
  });

  test.each([
    ['another audience', () => signer.token(randomUUID(), claims({ aud: 'order' })), 'unexpected audience'],
    ['another issuer', () => signer.token(randomUUID(), claims({ iss: 'order' })), 'unexpected issuer'],
    ['a signature from another key', () => createUserTokenSigner('wallet').token(randomUUID(), claims()), 'bad signature'],
    ['alg none', () => signer.token(randomUUID(), claims(), { alg: 'none', typ: 'JWT' }), 'unexpected alg'],
    ['alg HS256', () => signer.token(randomUUID(), claims(), { alg: 'HS256', typ: 'JWT' }), 'unexpected alg'],
    ['a claim missing', () => signToken({ iss: 'account', aud: 'wallet', iat: now, exp: now + 60, jti: randomUUID() } as UserTokenClaims, signer.privateKey), 'missing claims'],
    ['two segments', () => signer.token(randomUUID(), claims()).split('.').slice(0, 2).join('.'), 'malformed'],
    ['four segments', () => `${signer.token(randomUUID(), claims())}.extra`, 'malformed'],
    ['segments that are not JSON', () => 'abc.def.ghi', 'malformed'],
    ['an empty string', () => '', 'malformed'],
  ])('Should refuse %s', (_case, tokenOf, reason) => {
    // When & Then
    expect(() => verifyAtNow(tokenOf())).toThrowError(new InvalidUserTokenError(reason));
  });

  test('Should refuse a token whose claims were changed after signing', () => {
    // Given
    const [header, , signature] = signer.token(randomUUID(), claims()).split('.');
    const forgedClaims = Buffer.from(JSON.stringify({ iss: 'account', sub: randomUUID(), aud: 'wallet', iat: now, exp: now + 60, jti: randomUUID() })).toString('base64url');

    // When & Then
    expect(() => verifyAtNow(`${header}.${forgedClaims}.${signature}`)).toThrowError('bad signature');
  });
});

describe('registerUserTokenGuard', () => {
  const buildApp = () => {
    const app = Fastify({ logger: false });
    registerUserTokenGuard(app, { publicKey: signer.publicKey, audience: 'wallet', publicRoutes: new Set(['/health']), nowSeconds: () => now });
    app.get('/health', async () => ({ status: 'up' }));
    app.get('/me', async (request) => ({ accountId: userAccountIdOf(request) }));
    return app;
  };

  test('Should hand the token subject to the handler', async () => {
    // Given
    const accountId = randomUUID();

    // When
    const response = await buildApp().inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${signer.token(accountId, claims())}` } });

    // Then
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accountId });
  });

  test('Should answer 401 unauthenticated without a token or with an invalid one, and let public routes through', async () => {
    // Given
    const app = buildApp();

    // When
    const missing = await app.inject({ method: 'GET', url: '/me' });
    const invalid = await app.inject({ method: 'GET', url: '/me', headers: { authorization: 'Bearer abc.def.ghi' } });
    const health = await app.inject({ method: 'GET', url: '/health' });

    // Then
    expect([missing.statusCode, invalid.statusCode, health.statusCode]).toEqual([401, 401, 200]);
    expect(missing.json()).toEqual({ error: 'unauthenticated', message: 'missing user token' });
    expect(invalid.json()).toEqual({ error: 'unauthenticated', message: 'invalid user token' });
  });
});

describe('userAccountIdOf', () => {
  test('Should throw when the route is not guarded', async () => {
    // Given
    const app = Fastify({ logger: false });
    app.get('/open', async (request) => ({ accountId: userAccountIdOf(request) }));

    // When
    const response = await app.inject({ method: 'GET', url: '/open' });

    // Then
    expect(response.statusCode).toBe(500);
  });
});
