import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { UserTokenClaims } from '../../src/infra/platform/security/userToken.js';
import { userTokenIssuer } from '../../src/infra/platform/security/userToken.js';

/** Plays the account service: owns an Ed25519 pair and signs user tokens the way the edge forwards them. */
export interface UserTokenSigner {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
  token(accountId: string, overrides?: Partial<UserTokenClaims>, header?: Record<string, unknown>): string;
  bearer(accountId: string, overrides?: Partial<UserTokenClaims>): { authorization: string };
}

const base64Url = (value: Buffer | string): string => Buffer.from(value).toString('base64url');

export const signToken = (claims: UserTokenClaims, privateKey: KeyObject, header: Record<string, unknown> = { alg: 'EdDSA', typ: 'JWT' }): string => {
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  return `${signingInput}.${base64Url(sign(null, Buffer.from(signingInput), privateKey))}`;
};

export const nowSeconds = (): number => Math.floor(Date.now() / 1_000);

export const createUserTokenSigner = (audience = 'wallet'): UserTokenSigner => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const token = (accountId: string, overrides: Partial<UserTokenClaims> = {}, header?: Record<string, unknown>): string => {
    const iat = nowSeconds();
    const claims: UserTokenClaims = { iss: userTokenIssuer, sub: accountId, aud: audience, iat, exp: iat + 60, jti: randomUUID(), ...overrides };
    return signToken(claims, privateKey, header);
  };
  return {
    publicKey,
    privateKey,
    token,
    bearer: (accountId, overrides) => ({ authorization: `Bearer ${token(accountId, overrides)}` }),
  };
};
