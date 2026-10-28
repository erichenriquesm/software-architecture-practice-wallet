import Fastify from 'fastify';
import { describe, expect, test } from 'vitest';
import { registerRateLimit } from '../../../../../../src/infra/platform/http/rateLimit/rateLimitPlugin.js';
import type { RateLimiter } from '../../../../../../src/infra/platform/http/rateLimit/rateLimiter.js';
import { decide } from '../../../../../../src/infra/platform/http/rateLimit/slidingWindow.js';

const policy = { name: 'orders', limit: 10, windowMs: 10_000 };

/** Same sliding-window decision as Redis, counts kept in a Map (single window, enough for the plugin). */
const countingLimiter = (): RateLimiter => {
  const counts = new Map<string, number>();
  return {
    check: async (check) => {
      const key = `${check.policy.name}:${check.subject}`;
      const currentCount = counts.get(key) ?? 0;
      const decision = decide({ previousCount: 0, currentCount, elapsedMs: check.nowMs % check.policy.windowMs, cost: check.cost, policy: check.policy });
      if (decision.allowed) counts.set(key, currentCount + check.cost);
      return decision;
    },
  };
};

describe('Sliding window counter', () => {
  test('Should weight the previous window by the time left in the current one', () => {
    // previous=10 at 50% elapsed counts as 5; with current=4 the estimate is 9
    expect(decide({ previousCount: 10, currentCount: 4, elapsedMs: 5_000, cost: 1, policy })).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    expect(decide({ previousCount: 10, currentCount: 5, elapsedMs: 5_000, cost: 1, policy })).toMatchObject({
      allowed: false,
      retryAfterSeconds: 5,
    });
  });

  test('Should forget the previous window entirely at the end of the current one', () => {
    expect(decide({ previousCount: 100, currentCount: 0, elapsedMs: 10_000, cost: 1, policy }).allowed).toBe(true);
  });

  test('Should count a heavier request with its weight', () => {
    expect(decide({ previousCount: 0, currentCount: 8, elapsedMs: 0, cost: 3, policy }).allowed).toBe(false);
  });
});

describe('Rate limit plugin', () => {
  const buildApp = (limiter: RateLimiter = countingLimiter()) => {
    const app = Fastify();
    registerRateLimit(app, {
      limiter,
      now: () => 1_000,
      groups: [
        {
          name: 'orders',
          matches: (request) => request.url === '/place_order',
          perIp: { limit: 100, windowMs: 10_000 },
          perSubject: {
            label: 'account',
            limit: 2,
            windowMs: 10_000,
            subjectOf: (request) => (request.body as { accountId?: string } | undefined)?.accountId,
          },
        },
      ],
    });
    app.post('/place_order', async () => ({ ok: true }));
    app.post('/other', async () => ({ ok: true }));
    return app;
  };

  test('Should limit per account and answer 429 with Retry-After and RateLimit headers', async () => {
    // Given
    const app = buildApp();
    const placeOrder = () => app.inject({ method: 'POST', url: '/place_order', payload: { accountId: 'a-1' } });

    // When
    const responses = [await placeOrder(), await placeOrder(), await placeOrder()];

    // Then
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 429]);
    expect(responses[2]?.headers['retry-after']).toBe('9');
    expect(responses[0]?.headers['ratelimit-policy']).toBe('"ordersIp";q=100;w=10, "ordersAccount";q=2;w=10');
    expect(responses[0]?.headers['ratelimit']).toBe('"ordersAccount";r=1;t=9');
  });

  test('Should not limit a route outside every group', async () => {
    // Given
    const app = buildApp();

    // When
    const response = await app.inject({ method: 'POST', url: '/other' });

    // Then
    expect(response.statusCode).toBe(200);
    expect(response.headers['ratelimit']).toBeUndefined();
  });

  test('Should fail open when the limiter is down: the request goes through without RateLimit headers', async () => {
    // Given
    const app = buildApp({ check: async () => Promise.reject(new Error('redis down')) });

    // When
    const response = await app.inject({ method: 'POST', url: '/place_order', payload: { accountId: 'a-1' } });

    // Then
    expect(response.statusCode).toBe(200);
    expect(response.headers['ratelimit']).toBeUndefined();
  });
});
