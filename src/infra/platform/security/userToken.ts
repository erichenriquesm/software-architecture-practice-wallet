import { createPublicKey, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** The user's identity as the edge hands it to a service: an EdDSA (Ed25519) JWT that lives 60 seconds. */
export interface UserTokenClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

export class InvalidUserTokenError extends Error {
  constructor(reason: string) {
    super(`invalid user token: ${reason}`);
    this.name = 'InvalidUserTokenError';
  }
}

export const userTokenIssuer = 'account';
const clockSkewSeconds = 5;
const algorithm = 'EdDSA';

const json = (segment: string): unknown => JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));

/** PEM keys travel in .env on one line, with literal "\n" for the line breaks. */
const pem = (value: string): string => value.replaceAll('\\n', '\n');

export const userTokenPublicKey = (value: string): KeyObject => createPublicKey(pem(value));

const isClaims = (value: unknown): value is UserTokenClaims => {
  if (typeof value !== 'object' || value === null) return false;
  const claims = value as Record<string, unknown>;
  const strings = ['iss', 'sub', 'aud', 'jti'].every((key) => typeof claims[key] === 'string');
  return strings && typeof claims.iat === 'number' && typeof claims.exp === 'number';
};

const decode = (token: string): { signingInput: string; signature: Buffer; claims: UserTokenClaims } => {
  const [encodedHeader, encodedClaims, encodedSignature, ...rest] = token.split('.');
  if (!encodedHeader || !encodedClaims || !encodedSignature || rest.length > 0) throw new InvalidUserTokenError('malformed');
  const tokenHeader = json(encodedHeader) as { alg?: unknown };
  if (tokenHeader.alg !== algorithm) throw new InvalidUserTokenError('unexpected alg');
  const claims = json(encodedClaims);
  if (!isClaims(claims)) throw new InvalidUserTokenError('missing claims');
  return { signingInput: `${encodedHeader}.${encodedClaims}`, signature: Buffer.from(encodedSignature, 'base64url'), claims };
};

/** Checks signature, alg, iss, aud and exp; returns the claims of a token this service may accept. */
export const verifyUserToken = (token: string, publicKey: KeyObject, audience: string, nowSeconds: number): UserTokenClaims => {
  let decoded: ReturnType<typeof decode>;
  try {
    decoded = decode(token);
  } catch (error) {
    if (error instanceof InvalidUserTokenError) throw error;
    throw new InvalidUserTokenError('malformed');
  }
  const { signingInput, signature, claims } = decoded;
  if (!verify(null, Buffer.from(signingInput), publicKey, signature)) throw new InvalidUserTokenError('bad signature');
  if (claims.iss !== userTokenIssuer) throw new InvalidUserTokenError('unexpected issuer');
  if (claims.aud !== audience) throw new InvalidUserTokenError('unexpected audience');
  if (claims.exp + clockSkewSeconds < nowSeconds) throw new InvalidUserTokenError('expired');
  return claims;
};

declare module 'fastify' {
  interface FastifyRequest {
    userAccountId?: string;
  }
}

export interface UserTokenGuardOptions {
  readonly publicKey: KeyObject;
  readonly audience: string;
  /** Routes that do not need a user, by their route url (e.g. "/login"). */
  readonly publicRoutes: ReadonlySet<string>;
  readonly nowSeconds?: () => number;
}

const bearerOf = (request: FastifyRequest): string | undefined => {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return undefined;
  return authorization.slice('Bearer '.length).trim() || undefined;
};

/** Runs before every non-public route: no valid user token ends with 401, and the handler reads request.userAccountId. */
export const registerUserTokenGuard = (app: FastifyInstance, options: UserTokenGuardOptions): void => {
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1_000));
  app.addHook('onRequest', async (request, reply) => {
    const route = request.routeOptions.url;
    if (route === undefined || options.publicRoutes.has(route)) return;
    const token = bearerOf(request);
    if (!token) return reply.status(401).send({ error: 'unauthenticated', message: 'missing user token' });
    try {
      request.userAccountId = verifyUserToken(token, options.publicKey, options.audience, nowSeconds()).sub;
    } catch (error) {
      if (!(error instanceof InvalidUserTokenError)) throw error;
      request.log.warn({ reason: error.message }, 'user token refused');
      return reply.status(401).send({ error: 'unauthenticated', message: 'invalid user token' });
    }
  });
};

/** The user the guard let through; only call it from a route the guard protects. */
export const userAccountIdOf = (request: FastifyRequest): string => {
  if (request.userAccountId === undefined) throw new InvalidUserTokenError('route is not guarded');
  return request.userAccountId;
};
