import { randomUUID } from 'node:crypto';
import grpc from '@grpc/grpc-js';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import type { FakeAccount } from '../../support/fakeAccount.js';
import { startFakeAccount } from '../../support/fakeAccount.js';
import type { TestDatabase } from '../../support/database.js';
import { createTestDatabase } from '../../support/database.js';
import type { WalletCore } from '../../../src/infra/composition.js';
import { buildWalletApi } from '../../../src/infra/composition.js';
import { AccountServiceUnavailableError, GrpcAccountGateway } from '../../../src/infra/grpc/account/grpcAccountGateway.js';
import type { RateLimitCheck, RateLimiter } from '../../../src/infra/platform/http/rateLimit/rateLimiter.js';
import { loadEnvelopeValidator } from '../../../src/infra/platform/messaging/envelope.js';
import { loadSchemaValidator } from '../../../src/infra/platform/messaging/schemas.js';
import { createUserTokenSigner, nowSeconds } from '../../support/userTokens.js';

const grpcToken = 'internal-grpc-test';
const fastRetries = { baseMs: 1, capMs: 5, maxAttempts: 3 };

const checked: RateLimitCheck[] = [];
const unlimited: RateLimiter = {
  check: async (check) => {
    checked.push(check);
    return { allowed: true, remaining: check.policy.limit, resetSeconds: 0, retryAfterSeconds: 0, policy: check.policy };
  },
};
const users = createUserTokenSigner('wallet');

let database: TestDatabase;
let account: FakeAccount;
let gateway: GrpcAccountGateway;
let app: FastifyInstance;
let core: WalletCore;

const newAccount = (): string => {
  const accountId = randomUUID();
  account.existing.add(accountId);
  return accountId;
};

const post = (url: '/deposit' | '/withdraw', accountId: string, assetId: string, quantity: string) =>
  app.inject({ method: 'POST', url, payload: { assetId, quantity }, headers: users.bearer(accountId) });

const depositWith = (headers: Record<string, string>, payload: Record<string, unknown> = { assetId: 'USD', quantity: '10' }) =>
  app.inject({ method: 'POST', url: '/deposit', payload, headers });

const balanceOf = async (accountId: string, assetId: string) =>
  database.db.selectFrom('balance').select(['available', 'reserved']).where('account_id', '=', accountId).where('asset_id', '=', assetId).executeTakeFirst();

beforeAll(async () => {
  database = await createTestDatabase();
  account = await startFakeAccount(grpcToken);
  gateway = new GrpcAccountGateway({
    address: account.address,
    token: grpcToken,
    retryPolicy: fastRetries,
  });
  ({ app, core } = buildWalletApi({ db: database.db, accountGateway: gateway, userTokenPublicKey: users.publicKey, rateLimiter: unlimited }));
});

afterEach(() => {
  account.unavailable = false;
  account.notFound = false;
  account.calls = 0;
});

afterAll(async () => {
  gateway.close();
  account.stop();
  await app.close();
  await database.destroy();
});

describe('POST /deposit and /withdraw', () => {
  test('Should open the wallet of an existing account, write the ledger and a valid wallet.balanceChanged to the outbox', async () => {
    // Given
    const accountId = newAccount();

    // When
    const response = await post('/deposit', accountId, 'USD', '150.50');

    // Then
    expect(response.statusCode).toBe(204);
    expect(await balanceOf(accountId, 'USD')).toEqual({ available: '150.50000000', reserved: '0.00000000' });
    const ledger = await database.db.selectFrom('ledger_entry').select(['reason', 'available_delta']).where('account_id', '=', accountId).execute();
    expect(ledger).toEqual([{ reason: 'DEPOSIT', available_delta: '150.50000000' }]);
    const outbox = await database.db.selectFrom('outbox').select(['routing_key', 'envelope']).where(sql<string>`envelope->'payload'->>'accountId'`, '=', accountId).execute();
    expect(outbox.map((row) => row.routing_key)).toEqual(['wallet.balanceChanged']);
    const envelope = loadEnvelopeValidator()(outbox[0]?.envelope);
    expect(loadSchemaValidator('src/infra/schemas/published/events/wallet.balanceChanged.v1.schema.json')(envelope.payload)).toMatchObject({
      accountId,
      assetId: 'USD',
      available: '150.50000000',
      version: 1,
    });
  });

  test('Should answer 404 for an unknown account, 503 when the account service is down and 422 for invalid amounts', async () => {
    // Given
    const accountId = newAccount();
    await post('/deposit', accountId, 'USD', '10');

    // When
    const unknown = await post('/deposit', randomUUID(), 'USD', '10');
    account.unavailable = true;
    const accountDown = await post('/deposit', randomUUID(), 'USD', '10');
    account.unavailable = false;
    const tooPrecise = await post('/deposit', accountId, 'USD', '1.001');
    const tooMuch = await post('/withdraw', accountId, 'USD', '10.01');

    // Then
    expect([unknown.statusCode, accountDown.statusCode, tooPrecise.statusCode, tooMuch.statusCode]).toEqual([404, 503, 422, 422]);
    expect(tooMuch.json()).toMatchObject({ error: 'insufficientFunds' });
  });

  test('Should keep every concurrent deposit through optimistic locking (reload and retry)', async () => {
    // Given
    const accountId = newAccount();
    await post('/deposit', accountId, 'USD', '1');

    // When
    const responses = await Promise.all([post('/deposit', accountId, 'USD', '10'), post('/deposit', accountId, 'USD', '10'), post('/deposit', accountId, 'USD', '10')]);

    // Then
    expect(responses.map((response) => response.statusCode)).toEqual([204, 204, 204]);
    expect(await balanceOf(accountId, 'USD')).toMatchObject({ available: '31.00000000' });
  });

  test('Should keep the database check as the last defense against a negative balance', async () => {
    // Given
    const accountId = newAccount();
    await post('/deposit', accountId, 'USD', '1');

    // When & Then
    await expect(sql`update balance set available = -1 where account_id = ${accountId}`.execute(database.db)).rejects.toThrowError(/balance_available_not_negative/);
  });
});

describe('User token on the REST routes', () => {
  test('Should answer 401 unauthenticated without an Authorization header, and leave the health route public', async () => {
    // When
    const deposit = await depositWith({});
    const withdraw = await app.inject({ method: 'POST', url: '/withdraw', payload: { assetId: 'USD', quantity: '1' } });
    const health = await app.inject({ method: 'GET', url: '/health' });

    // Then
    expect([deposit.statusCode, withdraw.statusCode]).toEqual([401, 401]);
    expect(deposit.json()).toMatchObject({ error: 'unauthenticated' });
    expect(health.statusCode).toBe(200);
  });

  test.each([
    ['another audience', () => users.bearer(randomUUID(), { aud: 'order' })],
    ['an expired token', () => users.bearer(randomUUID(), { exp: nowSeconds() - 10 })],
    ['a token signed with another key', () => createUserTokenSigner('wallet').bearer(randomUUID())],
    ['a token that is not a JWT', () => ({ authorization: 'Bearer not-a-jwt' })],
    ['a scheme other than Bearer', () => ({ authorization: `Basic ${users.token(randomUUID())}` })],
  ])('Should answer 401 unauthenticated for %s', async (_case, headersOf) => {
    // Given
    const accountId = newAccount();

    // When
    const response = await depositWith(headersOf());

    // Then
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'unauthenticated' });
    expect(await balanceOf(accountId, 'USD')).toBeUndefined();
  });

  test("Should land the deposit on the token's account and limit the rate by that account", async () => {
    // Given
    const accountId = newAccount();
    checked.length = 0;

    // When
    const response = await depositWith(users.bearer(accountId));

    // Then
    expect(response.statusCode).toBe(204);
    expect(await balanceOf(accountId, 'USD')).toMatchObject({ available: '10.00000000' });
    expect(checked.map((check) => check.subject)).toContain(`account:${accountId}`);
  });

  test('Should refuse an accountId in the body with 422 invalidRequest', async () => {
    // Given
    const accountId = newAccount();
    const otherAccountId = newAccount();

    // When
    const response = await depositWith(users.bearer(accountId), { accountId: otherAccountId, assetId: 'USD', quantity: '10' });

    // Then
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'invalidRequest' });
    expect(await balanceOf(accountId, 'USD')).toBeUndefined();
    expect(await balanceOf(otherAccountId, 'USD')).toBeUndefined();
  });

  test('Should keep the Idempotency-Key of one user from replaying for another user', async () => {
    // Given
    const firstAccountId = newAccount();
    const secondAccountId = newAccount();
    const idempotencyKey = randomUUID();

    // When
    const first = await depositWith({ ...users.bearer(firstAccountId), 'idempotency-key': idempotencyKey });
    const second = await depositWith({ ...users.bearer(secondAccountId), 'idempotency-key': idempotencyKey });

    // Then
    expect([first.statusCode, second.statusCode]).toEqual([204, 204]);
    expect(second.headers['idempotent-replayed']).toBeUndefined();
    expect(await balanceOf(secondAccountId, 'USD')).toMatchObject({ available: '10.00000000' });
  });
});

describe('Reservation and its compensation (saga S2) on Postgres', () => {
  test('Should never leave funds reserved when order.placed and order.voided race each other', async () => {
    // Given
    const accountId = newAccount();
    await post('/deposit', accountId, 'USD', '1000');
    const orders = Array.from({ length: 5 }, () => randomUUID());

    // When
    await Promise.all(
      orders.flatMap((orderId) => [
        core.reserveFunds.execute({ orderId, accountId, marketId: 'BTC-USD', side: 'buy', quantity: '1', price: '100' }),
        core.compensateReservation.execute(orderId, accountId),
      ]),
    );

    // Then
    expect(await balanceOf(accountId, 'USD')).toEqual({ available: '1000.00000000', reserved: '0.00000000' });
    const voided = await database.db.selectFrom('voided_order').select('order_id').where('order_id', 'in', orders).execute();
    expect(voided).toHaveLength(5);
  });
});

describe('AccountService.Exists through the gateway', () => {
  test('Should send the shared token, read NOT_FOUND as "does not exist" and retry transient failures', async () => {
    // Given
    const accountId = newAccount();
    const unknownAccountId = randomUUID();

    // When & Then
    await expect(gateway.exists(accountId)).resolves.toBe(true);
    await expect(gateway.exists(unknownAccountId)).resolves.toBe(false);
    account.notFound = true;
    await expect(gateway.exists(unknownAccountId)).resolves.toBe(false);
    account.unavailable = true;
    account.calls = 0;
    await expect(gateway.exists(accountId)).rejects.toBeInstanceOf(AccountServiceUnavailableError);
    expect(account.calls).toBe(3);
  });

  test('Should fail without retrying when the token is wrong (UNAUTHENTICATED is permanent)', async () => {
    // Given
    const wrongToken = new GrpcAccountGateway({ address: account.address, token: 'wrong', retryPolicy: fastRetries });

    // When & Then
    await expect(wrongToken.exists(newAccount())).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
    expect(account.calls).toBe(0);
    wrongToken.close();
  });
});
