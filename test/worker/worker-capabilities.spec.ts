import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Controller, Get, Injectable } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { env, withEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import {
  CloudflareModule,
  CloudflareRequestContext,
  createWorker,
} from '../../src/index.js';

async function application(
  metadata: Record<string, unknown> = {},
): Promise<INestApplication> {
  return withEnv(
    { DATABASE: env.DATABASE, STATE: env.STATE, OUTBOX: env.OUTBOX },
    async () => {
      const module = await Test.createTestingModule({
        imports: [CloudflareModule.forRoot()],
        ...metadata,
      }).compile();

      return module.createNestApplication(new ExpressAdapter(), {
        logger: false,
      });
    },
  ) as Promise<INestApplication>;
}

function incoming(
  request: Request,
): Request<unknown, IncomingRequestCfProperties> {
  return request as Request<unknown, IncomingRequestCfProperties>;
}

describe('worker capabilities', () => {
  it('routes unmatched requests to fallback without reading the body', async () => {
    @Controller()
    class Routes {
      @Get('migrated')
      migrated() {
        return 'nest';
      }
    }

    let fallbackBody: string | undefined;

    const worker = createWorker(() => application({ controllers: [Routes] }), {
      fallback: {
        async fetch(request) {
          fallbackBody = await request.text();

          return new Response('legacy');
        },
      },
    });

    const ctx = createExecutionContext();

    const response = await worker.fetch(
      new Request('https://worker.test/legacy', {
        method: 'POST',
        body: 'raw-body',
      }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      ctx,
    );

    expect(await response.text()).toBe('legacy');
    expect(fallbackBody).toBe('raw-body');

    expect(
      await worker.matches(
        new Request('https://worker.test/migrated') as Request<
          unknown,
          IncomingRequestCfProperties
        >,
      ),
    ).toBe(true);

    await (await worker.getApplication()).close();
  });

  it('runs around hooks and exposes event context to providers', async () => {
    @Injectable()
    class Service {
      constructor(private readonly context: CloudflareRequestContext) {}

      value() {
        return this.context.getRequest()?.url;
      }
    }

    @Controller()
    class Routes {
      constructor(private readonly service: Service) {}

      @Get()
      read() {
        return this.service.value();
      }
    }

    const events: string[] = [];

    const worker = createWorker(
      () => application({ controllers: [Routes], providers: [Service] }),
      {
        around: {
          async fetch(_request, _env, _ctx, next) {
            events.push('before');
            const response = await next();

            events.push('after');

            return response;
          },
        },
      },
    );

    const ctx = createExecutionContext();

    const response = await worker.fetch(
      incoming(new Request('https://worker.test/')),
      env,
      ctx,
    );

    expect(await response.text()).toContain('worker.test');
    expect(events).toEqual(['before', 'after']);

    await waitOnExecutionContext(ctx);
    await (await worker.getApplication()).close();
  });

  it('retries bootstrap after a failed start', async () => {
    let attempts = 0;

    @Controller()
    class RetryController {
      @Get()
      read() {
        return 'ready';
      }
    }

    const worker = createWorker(async () => {
      attempts++;

      if (attempts === 1) {
        throw new Error('transient');
      }

      return application({
        controllers: [RetryController],
      });
    });

    await expect(
      worker.fetch(
        incoming(new Request('https://worker.test/')),
        env,
        createExecutionContext(),
      ),
    ).rejects.toThrow('transient');

    const response = await worker.fetch(
      incoming(new Request('https://worker.test/')),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(attempts).toBe(2);

    await (await worker.getApplication()).close();
  });

  it('wraps scheduled and queue fallback dispatch until completion', async () => {
    const events: string[] = [];

    const worker = createWorker(() => application(), {
      around: {
        async scheduled(controller, _env, _ctx, next) {
          events.push(`scheduled-before:${controller.cron}`);
          await next();
          events.push('scheduled-after');
        },
        async queue(batch, _env, _ctx, next) {
          events.push(`queue-before:${batch.queue}`);
          await next();
          events.push('queue-after');
        },
      },
      fallback: {
        async scheduled() {
          await new Promise(resolve => setTimeout(resolve, 1));
          events.push('scheduled-fallback');
        },
        async queue(batch) {
          batch.ackAll();
          events.push('queue-fallback');
        },
      },
    });

    const scheduledContext = createExecutionContext();

    await worker.scheduled(
      createScheduledController({ cron: '0 0 * * *' }),
      env,
      scheduledContext,
    );

    const batch = createMessageBatch('events', [
      { id: 'event', timestamp: new Date(), attempts: 1, body: {} },
    ]);

    const queueContext = createExecutionContext();

    await worker.queue(batch, env, queueContext);

    expect(events).toEqual([
      'scheduled-before:0 0 * * *',
      'scheduled-fallback',
      'scheduled-after',
      'queue-before:events',
      'queue-fallback',
      'queue-after',
    ]);

    expect((await getQueueResult(batch, queueContext)).ackAll).toBe(true);

    await (await worker.getApplication()).close();
  });
});
