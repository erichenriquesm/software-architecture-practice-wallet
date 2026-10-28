import { Redis } from 'ioredis';
import { buildWalletApi, serviceName } from './composition.js';
import { createDatabase } from './database/postgres.js';
import { GrpcAccountGateway } from './grpc/account/grpcAccountGateway.js';
import { RedisRateLimiter } from './platform/http/rateLimit/rateLimiter.js';
import { accountGrpcSettings, apiPortSetting, postgresSettings, rateLimitSetting, redisSettings, trustedProxySubnets, userTokenPublicKeySetting } from './settings.js';

const db = createDatabase(postgresSettings());
const redis = new Redis({
  ...redisSettings(),
  enableOfflineQueue: false,
  commandTimeout: 100,
  maxRetriesPerRequest: 1,
}).on('error', () => undefined);

const accountGateway = new GrpcAccountGateway(accountGrpcSettings());

const { app } = buildWalletApi({
  db,
  accountGateway,
  userTokenPublicKey: userTokenPublicKeySetting(),
  rateLimiter: new RedisRateLimiter(redis, serviceName),
  rateLimits: {
    movementPerIp: rateLimitSetting('RATE_LIMITS_MOVEMENT_PER_IP', '30/1m'),
    movementPerAccount: rateLimitSetting('RATE_LIMITS_MOVEMENT_PER_ACCOUNT', '10/1m'),
  },
  trustProxy: trustedProxySubnets(),
  logger: true,
});

const shutdown = async (): Promise<void> => {
  await app.close();
  accountGateway.close();
  redis.disconnect();
  await db.destroy();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

await app.listen({ host: '0.0.0.0', port: apiPortSetting() });
