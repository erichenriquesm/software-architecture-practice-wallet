import Fastify from 'fastify';
import { describe, expect, test } from 'vitest';
import { registerErrorMapping } from '../../../../../../src/infra/platform/http/errors/errorMapping.js';

class InsufficientFundsError extends Error {}

describe('Error mapping', () => {
  const buildApp = () => {
    const app = Fastify({ logger: false });
    registerErrorMapping(app, [{ error: InsufficientFundsError, statusCode: 422, code: 'insufficientFunds' }]);
    app.get('/mapped', async () => Promise.reject(new InsufficientFundsError('not enough USD')));
    app.get('/unmapped', async () => Promise.reject(new Error('boom')));
    app.get('/teapot', async () => Promise.reject(Object.assign(new Error('short and stout'), { statusCode: 418 })));
    app.post('/echo', async (request) => request.body);
    return app;
  };

  test('Should translate a mapped domain error into its status and code', async () => {
    const response = await buildApp().inject({ method: 'GET', url: '/mapped' });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: 'insufficientFunds', message: 'not enough USD' });
  });

  test('Should hide an unmapped error behind a generic 500', async () => {
    const response = await buildApp().inject({ method: 'GET', url: '/unmapped' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'internalError' });
  });

  test('Should answer a malformed JSON body with 400 instead of 500', async () => {
    const response = await buildApp().inject({ method: 'POST', url: '/echo', headers: { 'content-type': 'application/json' }, payload: '{bad' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalidJson' });
  });

  test('Should answer an empty JSON body with 400', async () => {
    const response = await buildApp().inject({ method: 'POST', url: '/echo', headers: { 'content-type': 'application/json' }, payload: '' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalidJson' });
  });

  test('Should answer an unsupported content type with 415', async () => {
    const response = await buildApp().inject({ method: 'POST', url: '/echo', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'a=b' });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({ error: 'unsupportedMediaType', message: 'Unsupported Media Type' });
  });

  test('Should keep any other 4xx status with a generic code', async () => {
    const response = await buildApp().inject({ method: 'GET', url: '/teapot' });

    expect(response.statusCode).toBe(418);
    expect(response.json()).toEqual({ error: 'badRequest', message: 'short and stout' });
  });
});
