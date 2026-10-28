import type { FastifyError, FastifyInstance } from 'fastify';

type ErrorClass = abstract new (...args: never[]) => Error;

export interface ErrorMapping {
  readonly error: ErrorClass;
  readonly statusCode: number;
  readonly code: string;
}

const isClientError = (statusCode: number | undefined): statusCode is number => typeof statusCode === 'number' && statusCode >= 400 && statusCode <= 499;

const invalidJsonCodes: ReadonlySet<string> = new Set(['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_EMPTY_JSON_BODY']);

/** Stable camelCase code for a 4xx raised by Fastify itself (body parsing, content type, size). */
const clientErrorCode = (error: FastifyError): string => {
  if (invalidJsonCodes.has(error.code)) return 'invalidJson';
  if (error.statusCode === 415) return 'unsupportedMediaType';
  if (error.statusCode === 413) return 'payloadTooLarge';
  return 'badRequest';
};

export const registerErrorMapping = (app: FastifyInstance, mappings: readonly ErrorMapping[]): void => {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const mapping = mappings.find((candidate) => error instanceof candidate.error);
    if (mapping) return reply.status(mapping.statusCode).send({ error: mapping.code, message: error.message });
    if (error.validation) return reply.status(422).send({ error: 'invalidRequest', message: error.message });
    if (isClientError(error.statusCode)) {
      request.log.warn({ err: error }, 'client error');
      return reply.status(error.statusCode).send({ error: clientErrorCode(error), message: error.message });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: 'internalError' });
  });
};
