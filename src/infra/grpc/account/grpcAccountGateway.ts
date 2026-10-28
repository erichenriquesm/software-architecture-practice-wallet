import grpc from '@grpc/grpc-js';
import type { AccountGateway } from '../../../application/contracts/accountGateway.js';
import type { ExistsResponse } from '../../generated/account.js';
import { AccountServiceClient } from '../../generated/account.js';
import { currentCorrelation } from '../../platform/observability/correlation.js';
import type { RetryPolicy } from '../../platform/resilience/retry.js';
import { grpcRetryPolicy, retry } from '../../platform/resilience/retry.js';
import { translateExists } from './accountAcl.js';

export const serviceTokenHeader = 'x-service-token';

const transientCodes = new Set([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED, grpc.status.RESOURCE_EXHAUSTED]);

const isServiceError = (error: unknown): error is grpc.ServiceError =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number';

export const isTransientGrpcError = (error: unknown): boolean => isServiceError(error) && transientCodes.has(error.code);

/** The account service could not answer after the retries: HTTP answers 503, a consumer retries later. */
export class AccountServiceUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super('account service unavailable');
    this.name = 'AccountServiceUnavailableError';
  }
}

export interface AccountGatewayOptions {
  readonly address: string;
  readonly token: string;
  readonly deadlineMs?: number;
  readonly retryPolicy?: RetryPolicy;
}

/** AccountService.Exists with a 500 ms deadline, retried with jitter on transient codes; NOT_FOUND means "does not exist". */
export class GrpcAccountGateway implements AccountGateway {
  private readonly client: AccountServiceClient;

  constructor(private readonly options: AccountGatewayOptions) {
    this.client = new AccountServiceClient(options.address, grpc.credentials.createInsecure());
  }

  async exists(accountId: string): Promise<boolean> {
    try {
      const response = await retry(() => this.call(accountId), this.options.retryPolicy ?? grpcRetryPolicy, { isTransient: isTransientGrpcError });
      return translateExists(response);
    } catch (error) {
      if (isServiceError(error) && error.code === grpc.status.NOT_FOUND) return false;
      if (isTransientGrpcError(error)) throw new AccountServiceUnavailableError(error);
      throw error;
    }
  }

  close(): void {
    this.client.close();
  }

  private call(accountId: string): Promise<ExistsResponse> {
    const metadata = new grpc.Metadata();
    metadata.set(serviceTokenHeader, this.options.token);
    metadata.set('x-correlation-id', currentCorrelation().correlationId);
    const deadline = Date.now() + (this.options.deadlineMs ?? 500);
    return new Promise((resolve, reject) => {
      this.client.exists({ accountId }, metadata, { deadline }, (error, response) => (error ? reject(error) : resolve(response)));
    });
  }
}
