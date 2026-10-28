import grpc from '@grpc/grpc-js';
import type { AccountServiceServer } from '../../src/infra/generated/account.js';
import { AccountServiceService } from '../../src/infra/generated/account.js';

export interface FakeAccount {
  readonly address: string;
  existing: Set<string>;
  unavailable: boolean;
  notFound: boolean;
  calls: number;
  stop(): void;
}

/** Refuses any call without the shared x-service-token, like the real account service. */
const tokenInterceptor =
  (token: string): grpc.ServerInterceptor =>
  (_methodDescriptor, call) =>
    new grpc.ServerInterceptingCall(call, {
      start: (next) =>
        next({
          onReceiveMetadata: (metadata, metadataNext) => {
            if (String(metadata.get('x-service-token')[0] ?? '') === token) return metadataNext(metadata);
            return call.sendStatus({ code: grpc.status.UNAUTHENTICATED, details: 'wrong token', metadata: new grpc.Metadata() });
          },
        }),
    });

/** In-process AccountService. `notFound` answers NOT_FOUND instead of exists=false for unknown accounts. */
export const startFakeAccount = async (token: string): Promise<FakeAccount> => {
  const fake: FakeAccount = { address: '', existing: new Set(), unavailable: false, notFound: false, calls: 0, stop: () => undefined };
  const implementation: AccountServiceServer = {
    exists: (call, callback) => {
      fake.calls += 1;
      if (fake.unavailable) return callback({ code: grpc.status.UNAVAILABLE, details: 'fake account down' });
      const exists = fake.existing.has(call.request.accountId);
      if (!exists && fake.notFound) return callback({ code: grpc.status.NOT_FOUND, details: 'no such account' });
      return callback(null, { exists });
    },
  };
  const server = new grpc.Server({ interceptors: [tokenInterceptor(token)] });
  server.addService(AccountServiceService, implementation);
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, boundPort) => (error ? reject(error) : resolve(boundPort))),
  );
  return Object.assign(fake, { address: `127.0.0.1:${port}`, stop: () => server.forceShutdown() });
};
