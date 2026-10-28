import { lookup } from 'node:dns/promises';

export type ResolveHost = (hostname: string) => Promise<string>;

export interface TrustedProxyOptions {
  readonly hostname: string;
  readonly resolve?: ResolveHost;
  readonly refreshMs?: number;
  readonly onError?: (error: unknown) => void;
}

/** Trusts X-Forwarded-For only when the socket peer is the edge, resolved by name and refreshed in the background. */
export interface TrustedProxy {
  readonly trust: (address: string, hop: number) => boolean;
  readonly start: () => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly stop: () => void;
}

const ipv4MappedPrefix = '::ffff:';

const normalized = (address: string): string => (address.startsWith(ipv4MappedPrefix) ? address.slice(ipv4MappedPrefix.length) : address);

const resolveWithDns: ResolveHost = async (hostname) => (await lookup(hostname)).address;

export const createTrustedProxy = (options: TrustedProxyOptions): TrustedProxy => {
  const resolve = options.resolve ?? resolveWithDns;
  const refreshMs = options.refreshMs ?? 30_000;
  let edgeAddress: string | undefined;
  let timer: NodeJS.Timeout | undefined;

  const refresh = async (): Promise<void> => {
    try {
      edgeAddress = normalized(await resolve(options.hostname));
    } catch (error) {
      options.onError?.(error);
    }
  };

  const start = async (): Promise<void> => {
    await refresh();
    if (timer) return;
    timer = setInterval(() => void refresh(), refreshMs);
    timer.unref();
  };

  const stop = (): void => {
    clearInterval(timer);
    timer = undefined;
  };

  const trust = (address: string, hop: number): boolean => hop === 0 && edgeAddress !== undefined && normalized(address) === edgeAddress;

  return { trust, start, refresh, stop };
};
