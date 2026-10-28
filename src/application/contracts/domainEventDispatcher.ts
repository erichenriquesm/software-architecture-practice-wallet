import type { DomainEvent } from '../../domain/events/domainEvent.js';

export interface DomainEventDispatcher {
  dispatch(events: readonly DomainEvent[]): Promise<void>;
}
