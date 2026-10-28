import type { EventPublisher } from '../../application/contracts/eventPublisher.js';
import type { BalanceChanged } from '../../domain/events/balanceChanged.js';
import type { DomainEvent } from '../../domain/events/domainEvent.js';
import type { FundsReservationRejected } from '../../domain/events/fundsReservationRejected.js';
import type { FundsReserved } from '../../domain/events/fundsReserved.js';
import type { Database } from '../database/database.js';
import type { KyselyTransactionRunner } from '../database/kyselyTransactionRunner.js';
import { createEnvelope } from '../platform/messaging/envelope.js';
import { appendToOutbox } from '../platform/messaging/outbox.js';
import { loadSchemaValidator } from '../platform/messaging/schemas.js';
import { currentCorrelation } from '../platform/observability/correlation.js';

export const walletEventsExchange = 'wallet.events';

type WalletEvent = FundsReserved | FundsReservationRejected | BalanceChanged;

interface IntegrationEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

const toIntegrationEvent = (event: WalletEvent): IntegrationEvent => {
  switch (event.type) {
    case 'FundsReserved':
      return {
        type: 'wallet.fundsReserved',
        payload: { orderId: event.orderId, accountId: event.accountId, assetId: event.assetId, amount: event.amount },
      };
    case 'FundsReservationRejected':
      return {
        type: 'wallet.fundsReservationRejected',
        payload: { orderId: event.orderId, accountId: event.accountId, reason: event.reason },
      };
    case 'BalanceChanged':
      return {
        type: 'wallet.balanceChanged',
        payload: {
          accountId: event.accountId,
          assetId: event.assetId,
          available: event.available,
          reserved: event.reserved,
          version: event.version,
        },
      };
    default:
      throw new Error(`No integration event for domain event ${(event as DomainEvent).type}`);
  }
};

const publishedTypes = ['wallet.fundsReserved', 'wallet.fundsReservationRejected', 'wallet.balanceChanged'];

/** Maps each domain event to its published contract and writes it to the outbox, in the current transaction. */
export class OutboxEventPublisher implements EventPublisher {
  private readonly validators = new Map(
    publishedTypes.map((type) => [type, loadSchemaValidator<Record<string, unknown>>(`src/infra/schemas/published/events/${type}.v1.schema.json`)]),
  );

  constructor(private readonly runner: KyselyTransactionRunner<Database>) {}

  async publish(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) await this.append(event);
  }

  private async append(event: DomainEvent): Promise<void> {
    const { type, payload } = toIntegrationEvent(event as WalletEvent);
    const validate = this.validators.get(type);
    if (!validate) throw new Error(`No schema for ${type}`);
    const correlation = currentCorrelation();
    const envelope = createEnvelope(
      { type, version: 1, producer: 'wallet', correlationId: correlation.correlationId, causationId: correlation.causationId, payload: validate(payload) },
      () => event.occurredAt,
    );
    await appendToOutbox(this.runner.transaction(), { routingKey: type, envelope });
  }
}
