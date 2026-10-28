import Fastify from 'fastify';
import { describe, expect, test } from 'vitest';
import { createTrustedProxy } from '../../../../../src/infra/platform/http/trustedProxy.js';

const edgeAddress = '172.18.0.10';

const fakeResolver = (answers: (string | Error)[]) => {
  const calls: string[] = [];
  const resolve = async (hostname: string): Promise<string> => {
    calls.push(hostname);
    const answer = answers.shift();
    if (answer === undefined || answer instanceof Error) throw answer ?? new Error('no answer');
    return answer;
  };
  return { resolve, calls };
};

describe('Trusted proxy', () => {
  test('Should trust only the resolved edge address at the socket hop', async () => {
    const { resolve, calls } = fakeResolver([edgeAddress]);
    const proxy = createTrustedProxy({ hostname: 'edge', resolve });

    await proxy.start();
    proxy.stop();

    expect(calls).toEqual(['edge']);
    expect(proxy.trust(edgeAddress, 0)).toBe(true);
    expect(proxy.trust(`::ffff:${edgeAddress}`, 0)).toBe(true);
    expect(proxy.trust('172.18.0.1', 0)).toBe(false);
    expect(proxy.trust(edgeAddress, 1)).toBe(false);
  });

  test('Should trust nobody while the edge was never resolved', async () => {
    const errors: unknown[] = [];
    const proxy = createTrustedProxy({ hostname: 'edge', resolve: fakeResolver([new Error('ENOTFOUND')]).resolve, onError: (error) => errors.push(error) });

    await proxy.start();
    proxy.stop();

    expect(errors).toHaveLength(1);
    expect(proxy.trust(edgeAddress, 0)).toBe(false);
  });

  test('Should keep the last known address when a refresh fails', async () => {
    const proxy = createTrustedProxy({ hostname: 'edge', resolve: fakeResolver([edgeAddress, new Error('EAI_AGAIN')]).resolve, onError: () => undefined });

    await proxy.start();
    await proxy.refresh();
    proxy.stop();

    expect(proxy.trust(edgeAddress, 0)).toBe(true);
  });

  test('Should follow the edge to its new address on refresh', async () => {
    const proxy = createTrustedProxy({ hostname: 'edge', resolve: fakeResolver([edgeAddress, '172.18.0.20']).resolve });

    await proxy.start();
    await proxy.refresh();
    proxy.stop();

    expect(proxy.trust(edgeAddress, 0)).toBe(false);
    expect(proxy.trust('172.18.0.20', 0)).toBe(true);
  });

  describe('Behind Fastify', () => {
    const buildApp = async () => {
      const proxy = createTrustedProxy({ hostname: 'edge', resolve: fakeResolver([edgeAddress]).resolve });
      await proxy.start();
      proxy.stop();
      const app = Fastify({ logger: false, trustProxy: proxy.trust });
      app.get('/ip', async (request) => ({ ip: request.ip }));
      return app;
    };

    test('Should take the client address from X-Forwarded-For set by the edge', async () => {
      const app = await buildApp();

      const response = await app.inject({ method: 'GET', url: '/ip', remoteAddress: edgeAddress, headers: { 'x-forwarded-for': '203.0.113.7' } });

      expect(response.json()).toEqual({ ip: '203.0.113.7' });
    });

    test('Should ignore X-Forwarded-For spoofed by any other peer', async () => {
      const app = await buildApp();

      const response = await app.inject({ method: 'GET', url: '/ip', remoteAddress: '172.18.0.1', headers: { 'x-forwarded-for': '1.2.3.4' } });

      expect(response.json()).toEqual({ ip: '172.18.0.1' });
    });

    test('Should take only the entry the edge appended, not one the client prepended', async () => {
      const app = await buildApp();

      const response = await app.inject({ method: 'GET', url: '/ip', remoteAddress: edgeAddress, headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.7' } });

      expect(response.json()).toEqual({ ip: '203.0.113.7' });
    });
  });
});
