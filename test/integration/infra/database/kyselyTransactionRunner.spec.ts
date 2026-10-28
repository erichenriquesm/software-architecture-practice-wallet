import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { TestDatabase } from '../../../support/database.js';
import { createTestDatabase } from '../../../support/database.js';
import type { BalanceChanged } from '../../../../src/domain/events/balanceChanged.js';
import type { Database } from '../../../../src/infra/database/database.js';
import { KyselyTransactionRunner } from '../../../../src/infra/database/kyselyTransactionRunner.js';
import { OutboxEventPublisher } from '../../../../src/infra/messaging/outboxEventPublisher.js';

let database: TestDatabase;
let runner: KyselyTransactionRunner<Database>;
let publisher: OutboxEventPublisher;

beforeAll(async () => {
  database = await createTestDatabase();
  runner = new KyselyTransactionRunner(database.db);
  publisher = new OutboxEventPublisher(runner);
});

afterAll(() => database.destroy());

const balanceChanged = (accountId: string): BalanceChanged => ({
  type: 'BalanceChanged',
  accountId,
  assetId: 'USD',
  available: '1',
  reserved: '0',
  version: 1,
  occurredAt: new Date(),
});

const writeAndPublish = (accountId: string, fail: boolean) =>
  runner.run(async () => {
    await runner.executor().insertInto('inbox').values({ consumer: 'repository', message_key: accountId }).execute();
    await publisher.publish([balanceChanged(accountId)]);
    if (fail) throw new Error('use case failed after publish');
  });

const inboxRowsOf = async (accountId: string) =>
  database.db.selectFrom('inbox').select('message_key').where('message_key', '=', accountId).execute();

const outboxRowsOf = async (accountId: string) =>
  (await database.db.selectFrom('outbox').select('envelope').where('routing_key', '=', 'wallet.balanceChanged').execute()).filter(
    (row) => (row.envelope as { payload: { accountId: string } }).payload.accountId === accountId,
  );

describe('KyselyTransactionRunner with the outbox event publisher', () => {
  test('Should roll back the repository write and the outbox write together when the use case fails', async () => {
    // Given
    const accountId = randomUUID();

    // When
    await expect(writeAndPublish(accountId, true)).rejects.toThrowError('use case failed after publish');

    // Then
    expect(await inboxRowsOf(accountId)).toEqual([]);
    expect(await outboxRowsOf(accountId)).toEqual([]);
  });

  test('Should commit both writes in one transaction when the use case succeeds', async () => {
    // Given
    const accountId = randomUUID();

    // When
    await writeAndPublish(accountId, false);

    // Then
    expect(await inboxRowsOf(accountId)).toHaveLength(1);
    expect(await outboxRowsOf(accountId)).toHaveLength(1);
  });

  test('Should refuse a domain event that has no integration event', async () => {
    // When & Then
    await expect(runner.run(() => publisher.publish([{ type: 'Unknown', occurredAt: new Date() }]))).rejects.toThrowError('Unknown');
  });
});
