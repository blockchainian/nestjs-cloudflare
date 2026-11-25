import { Test } from '@nestjs/testing';
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { from } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { CloudflareQueueContext } from '../../src/queue/context.js';
import { CloudflareQueueServer } from '../../src/queue/server.js';

function batch(queue: string, bodies: unknown[]) {
  return createMessageBatch(
    queue,
    bodies.map((body, index) => ({
      id: `${index}`,
      timestamp: new Date(),
      attempts: 1,
      body,
    })),
  );
}

async function server(
  options: ConstructorParameters<typeof CloudflareQueueServer>[0] = {},
) {
  const module = await Test.createTestingModule({
    providers: [
      {
        provide: CloudflareQueueServer,
        useFactory: () => new CloudflareQueueServer(options),
      },
    ],
  }).compile();

  return { module, strategy: module.get(CloudflareQueueServer) };
}

describe('CloudflareQueueServer', () => {
  describe('consume', () => {
    it('should route packet patterns and preserve native producer payloads', async () => {
      const { module, strategy } = await server();
      const received: unknown[] = [];

      strategy.addHandler(
        { task: 'notice', version: 1 },
        async (data: unknown, context: CloudflareQueueContext) => {
          received.push([data, context.getPattern()]);
        },
        true,
      );

      strategy.addHandler(
        'inbox',
        async (data: unknown) => {
          received.push(data);
        },
        true,
      );

      const messages = batch('inbox', [
        { pattern: { version: 1, task: 'notice' }, data: 'packet' },
        { native: true },
      ]);

      const ctx = createExecutionContext();

      await strategy.consume(messages, ctx);

      expect(received).toEqual([
        ['packet', '{"task":"notice","version":1}'],
        { native: true },
      ]);

      expect((await getQueueResult(messages, ctx)).explicitAcks).toEqual([
        '0',
        '1',
      ]);

      await module.close();
    });

    it('should deserialize once and leave fallback acknowledgement to its handler', async () => {
      let deserialized = 0;

      const { module, strategy } = await server({
        deserializer: {
          deserialize(value: unknown, options?: Record<string, unknown>) {
            deserialized++;

            return { pattern: options?.channel, data: value };
          },
        },
      });

      const messages = batch('unknown', ['first', 'second']);
      const ctx = createExecutionContext();
      let fallback = 0;

      await strategy.consume(messages, ctx, () => {
        fallback++;
        messages.ackAll();
      });

      expect(deserialized).toBe(2);
      expect(fallback).toBe(1);
      expect((await getQueueResult(messages, ctx)).ackAll).toBe(true);

      await module.close();
    });

    it('should await streams and processing hooks before acknowledging sequential messages', async () => {
      const { module, strategy } = await server();
      const steps: string[] = [];

      strategy.setOnProcessingStartHook((_transport, _context, done) => {
        steps.push('hook:start');

        return done();
      });

      strategy.setOnProcessingEndHook(() => {
        steps.push('hook:end');
      });

      strategy.addHandler(
        'inbox',
        async (data: string) =>
          from(
            (async () => {
              steps.push(`start:${data}`);
              await env.STATE.put(data, data);
              steps.push(`end:${data}`);
            })(),
          ),
        true,
      );

      const messages = batch('inbox', ['a', 'b']);
      const ctx = createExecutionContext();

      await strategy.consume(messages, ctx);

      expect(steps).toEqual([
        'hook:start',
        'start:a',
        'end:a',
        'hook:end',
        'hook:start',
        'start:b',
        'end:b',
        'hook:end',
      ]);

      expect((await getQueueResult(messages, ctx)).explicitAcks).toEqual([
        '0',
        '1',
      ]);

      await module.close();
    });

    it('should deliver native messages again after their explicit retry delay and discard acknowledged messages', async () => {
      const queue = env.MANUAL_OUTBOX as Queue;

      await queue.sendBatch([
        { body: { id: 'locked', action: 'locked' } },
        { body: { id: 'invalid', action: 'invalid' } },
        { body: { id: 'valid', action: 'valid' } },
      ]);

      await vi.waitFor(
        async () => {
          const deliveries = await env.STATE.get<number[]>(
            'manual:locked',
            'json',
          );

          expect(deliveries).toHaveLength(2);
          expect(deliveries![1] - deliveries![0]).toBeGreaterThanOrEqual(1000);
          expect(await env.STATE.get('manual:invalid', 'json')).toHaveLength(1);
          expect(await env.STATE.get('manual:valid', 'json')).toHaveLength(1);
        },
        { timeout: 5000 },
      );
    });

    it('should expose native acknowledgement and retry methods in manual mode', async () => {
      const { module, strategy } = await server({ noAck: false });

      strategy.addHandler(
        'inbox',
        async (data: string, context: CloudflareQueueContext) => {
          if (data === 'locked') {
            context.getMessage().retry({ delaySeconds: 30 });
          } else if (data === 'invalid') {
            context.getMessage().ack();
          }
        },
        true,
      );

      const messages = batch('inbox', ['locked', 'invalid', 'pending']);
      const ctx = createExecutionContext();

      await strategy.consume(messages, ctx);
      const result = await getQueueResult(messages, ctx);

      expect(result.explicitAcks).toEqual(['1']);
      expect(result.retryMessages).toEqual([{ msgId: '0' }]);
      expect(result.ackAll).toBe(false);
      expect(result.retryBatch).toEqual({ retry: false });

      await module.close();
    });

    it('should leave manual acknowledgement to handlers and retry failures', async () => {
      const { module, strategy } = await server({ noAck: false });

      strategy.addHandler(
        'inbox',
        async (data: string, context: CloudflareQueueContext) => {
          await env.STATE.put(data, data);

          if (data === 'fail') {
            throw new Error('Queue handler failed');
          }

          if (data === 'ack') {
            context.getMessage().ack();
          }
        },
        true,
      );

      const messages = batch('inbox', ['ack', 'pending', 'fail']);
      const ctx = createExecutionContext();

      await strategy.consume(messages, ctx);
      const result = await getQueueResult(messages, ctx);

      expect(result.explicitAcks).toEqual(['0']);
      expect(result.retryMessages).toEqual([{ msgId: '2' }]);

      await module.close();
    });

    it('should retry malformed packets without handing them to fallback', async () => {
      const { module, strategy } = await server({
        deserializer: {
          deserialize() {
            throw new Error('Invalid Queue packet');
          },
        },
      });

      const messages = batch('inbox', ['invalid']);
      const ctx = createExecutionContext();
      let fallback = false;

      await strategy.consume(messages, ctx, () => {
        fallback = true;
      });

      expect(fallback).toBe(false);

      expect((await getQueueResult(messages, ctx)).retryMessages).toEqual([
        { msgId: '0' },
      ]);

      await module.close();
    });

    it('should support parallel processing and retry unmatched messages', async () => {
      const { module, strategy } = await server({ concurrency: 'parallel' });
      const steps: string[] = [];

      strategy.addHandler(
        'inbox',
        async (data: string) => {
          steps.push(`start:${data}`);
          await env.STATE.put(data, data);
          steps.push(`end:${data}`);
        },
        true,
      );

      const messages = batch('inbox', [
        'a',
        'b',
        { pattern: 'missing', data: 'c' },
      ]);

      const ctx = createExecutionContext();

      await strategy.consume(messages, ctx);

      expect(steps.slice(0, 2)).toEqual(['start:a', 'start:b']);

      expect((await getQueueResult(messages, ctx)).retryMessages).toEqual([
        { msgId: '2' },
      ]);

      await module.close();
    });
  });
});
