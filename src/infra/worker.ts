import Fastify from 'fastify';
import { buildWalletCore, serviceName } from './composition.js';
import { createDatabase, PostgresProbe } from './database/postgres.js';
import { GrpcAccountGateway } from './grpc/account/grpcAccountGateway.js';
import { registerHealthRoutes } from './http/health.js';
import { accountCreatedHandler, accountCreatedQueue } from './messaging/consumers/accountCreatedConsumer.js';
import { classifyWalletFailure } from './messaging/consumers/consumedEvent.js';
import { orderPlacedHandler, orderPlacedQueue } from './messaging/consumers/orderPlacedConsumer.js';
import { orderRemovedHandler, orderRemovedQueue } from './messaging/consumers/orderRemovedConsumer.js';
import { orderVoidedHandler, orderVoidedQueue } from './messaging/consumers/orderVoidedConsumer.js';
import { tradeExecutedHandler, tradeExecutedQueue, tradeExecutedUnits } from './messaging/consumers/tradeExecutedConsumer.js';
import { walletEventsExchange } from './messaging/outboxEventPublisher.js';
import { KyselyIdempotencyStore } from './platform/http/idempotency/idempotencyStore.js';
import { connectRabbitMq, rabbitMqUrlFromEnv } from './platform/messaging/connection.js';
import type { AmqpConnection } from './platform/messaging/connection.js';
import type { ConsumerOptions } from './platform/messaging/consumer.js';
import { Consumer } from './platform/messaging/consumer.js';
import { loadEnvelopeValidator } from './platform/messaging/envelope.js';
import { OutboxRelay } from './platform/messaging/outbox.js';
import { declareConsumerQueue } from './platform/messaging/topology.js';
import { accountGrpcSettings, healthPortSetting, postgresSettings } from './settings.js';

const outboxLockKey = 7_002;
const purgeIntervalMs = 60 * 60 * 1_000;

const db = createDatabase(postgresSettings());
const accountGateway = new GrpcAccountGateway(accountGrpcSettings());
const core = buildWalletCore({ db, accountGateway });
const validate = loadEnvelopeValidator();
const log = Fastify({ logger: true }).log;

const consumerOptions: readonly Omit<ConsumerOptions, 'validate' | 'classify'>[] = [
  { definition: accountCreatedQueue, handler: accountCreatedHandler(core.openWallet) },
  { definition: orderPlacedQueue, handler: orderPlacedHandler(core.reserveFunds) },
  { definition: tradeExecutedQueue, handler: tradeExecutedHandler(core.settleTradeSide), units: tradeExecutedUnits },
  { definition: orderRemovedQueue, handler: orderRemovedHandler(core.releaseReservation) },
  { definition: orderVoidedQueue, handler: orderVoidedHandler(core.compensateReservation) },
];

const startConsumer = async (connection: AmqpConnection, options: Omit<ConsumerOptions, 'validate' | 'classify'>): Promise<Consumer> => {
  const channel = await connection.createChannel();
  for (const binding of options.definition.bindings) await channel.checkExchange(binding.exchange);
  await declareConsumerQueue(channel, options.definition);
  const consumer = new Consumer(core.runner, channel, { ...options, validate, classify: classifyWalletFailure });
  await consumer.start();
  return consumer;
};

const idempotencyStore = new KyselyIdempotencyStore(db);
const purge = setInterval(() => void idempotencyStore.purgeExpired(new Date()).catch(() => undefined), purgeIntervalMs);

let connected = false;
const healthServer = Fastify({ logger: false });
registerHealthRoutes(healthServer, serviceName, [new PostgresProbe(db), { dependency: 'rabbitmq', isHealthy: async () => connected }]);
await healthServer.listen({ host: '0.0.0.0', port: healthPortSetting() });

// One connection, no in-process reconnect: when it drops the worker exits and Docker restarts it.
// Outbox and inbox make the restart lossless.
const connection = await connectRabbitMq(rabbitMqUrlFromEnv());
const relay = new OutboxRelay(db, await connection.createConfirmChannel(), { exchange: walletEventsExchange, lockKey: outboxLockKey });
relay.start();
const consumers = await Promise.all(consumerOptions.map((options) => startConsumer(connection, options)));
connected = true;

const stop = async (): Promise<void> => {
  connected = false;
  clearInterval(purge);
  relay.stop();
  await Promise.all(consumers.map((consumer) => consumer.stop().catch(() => undefined)));
  await connection.close().catch(() => undefined);
  await healthServer.close();
  accountGateway.close();
  await db.destroy();
};

const exitOnLostConnection = (reason: unknown): void => {
  if (!connected) return;
  log.error({ reason: reason instanceof Error ? reason.message : reason }, 'rabbitmq connection lost, exiting');
  // Exit at once: closing channels on a dead connection can hang, and the outbox + inbox make a hard exit safe.
  process.exit(1);
};
connection.on('error', exitOnLostConnection);
connection.on('close', exitOnLostConnection);

process.once('SIGTERM', stop);
process.once('SIGINT', stop);
