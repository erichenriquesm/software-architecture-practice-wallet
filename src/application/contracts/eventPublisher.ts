import type { DomainEvent } from '../../domain/events/domainEvent.js';

/** Hands the domain events to the outbox, inside the caller's transaction. */
export interface EventPublisher {
  publish(events: readonly DomainEvent[]): Promise<void>;
}
