import type { EventPublisher } from '../../src/application/contracts/eventPublisher.js';
import type { DomainEvent } from '../../src/domain/events/domainEvent.js';

export class RecordingEventPublisher implements EventPublisher {
  readonly published: DomainEvent[] = [];

  async publish(events: readonly DomainEvent[]): Promise<void> {
    this.published.push(...events);
  }
}
