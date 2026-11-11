import type { IncomingMessage } from 'node:http';

import {
  type CallHandler,
  Controller,
  type ExecutionContext as NestExecutionContext,
  Get,
  HttpCode,
  type INestApplication,
  Injectable,
  type ModuleMetadata,
  type NestInterceptor,
  Post,
  type RawBodyRequest,
  Req,
} from '@nestjs/common';
import { EventPattern } from '@nestjs/microservices';
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
  createWorker,
  InjectBinding,
} from '../../src/index.js';
import { CloudflareQueueServer } from '../../src/queue/index.js';

function incomingRequest(
  input: string,
  init?: RequestInit,
): Request<unknown, IncomingRequestCfProperties> {
  return new Request(input, init) as Request<
    unknown,
    IncomingRequestCfProperties
  >;
}

async function createApplication(
  metadata: ModuleMetadata = {},
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
        rawBody: true,
      });
    },
  ) as Promise<INestApplication>;
}

@Controller()
class HttpController {
  @Get()
  public read(): { ok: boolean } {
    return { ok: true };
  }

  @Post('raw')
  @HttpCode(200)
  public raw(@Req() request: RawBodyRequest<IncomingMessage>): {
    raw: string | undefined;
  } {
    return { raw: request.rawBody?.toString() };
  }
}

describe('createWorker', () => {
  it('should defer bootstrap and share one application across concurrent events', async () => {
    let starts = 0;

    const worker = createWorker(async () => {
      starts++;

      return createApplication({ controllers: [HttpController] });
    });

    expect(starts).toBe(0);

    try {
      const responses = await Promise.all(
        [1, 2].map(async () => {
          const ctx = createExecutionContext();

          const response = await worker.fetch(
            incomingRequest('https://worker.test/'),
            env,
            ctx,
          );

          await waitOnExecutionContext(ctx);

          return response.json();
        }),
      );

      expect(responses).toEqual([{ ok: true }, { ok: true }]);
      expect(starts).toBe(1);
      expect(await worker.getApplication()).toBe(await worker.getApplication());
    } finally {
      await (await worker.getApplication()).close();
    }
  });

  it('should preserve rawBody configured by bootstrap', async () => {
    const worker = createWorker(() =>
      createApplication({ controllers: [HttpController] }),
    );

    try {
      const ctx = createExecutionContext();
      const raw = '{"value": 42}';

      const response = await worker.fetch(
        incomingRequest('https://worker.test/raw', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(new TextEncoder().encode(raw).length),
          },
          body: raw,
        }),
        env,
        ctx,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ raw });

      await waitOnExecutionContext(ctx);
    } finally {
      await (await worker.getApplication()).close();
    }
  });

  it('should inherit global interceptors through Nest hybrid application options', async () => {
    const seen: string[] = [];

    class Interceptor implements NestInterceptor {
      public intercept(context: NestExecutionContext, next: CallHandler) {
        seen.push(context.getType());

        return next.handle();
      }
    }

    @Controller()
    class EventsController {
      @Get()
      public read(): string {
        return 'ready';
      }

      @EventPattern('outbox')
      public consume(_data: unknown, ..._args: unknown[]): void {}
    }

    const worker = createWorker(async () => {
      const app = await createApplication({ controllers: [EventsController] });

      app.useGlobalInterceptors(new Interceptor());

      app.connectMicroservice(
        { strategy: new CloudflareQueueServer() },
        { inheritAppConfig: true },
      );

      return app;
    });

    try {
      const httpContext = createExecutionContext();

      const response = await worker.fetch(
        incomingRequest('https://worker.test/'),
        env,
        httpContext,
      );

      expect(await response.text()).toBe('ready');

      await waitOnExecutionContext(httpContext);

      const batch = createMessageBatch('outbox', [
        {
          id: 'event',
          timestamp: new Date(),
          attempts: 1,
          body: { value: 42 },
        },
      ]);

      const queueContext = createExecutionContext();

      await worker.queue(batch, env, queueContext);

      expect((await getQueueResult(batch, queueContext)).explicitAcks).toEqual([
        'event',
      ]);

      expect(seen).toEqual(['http', 'rpc']);
    } finally {
      await (await worker.getApplication()).close();
    }
  });

  it('should host two applications without selecting ports', async () => {
    const workers = [1, 2].map(() =>
      createWorker(() => createApplication({ controllers: [HttpController] })),
    );

    try {
      const responses = await Promise.all(
        workers.map(async worker => {
          const ctx = createExecutionContext();

          const response = await worker.fetch(
            incomingRequest('https://worker.test/'),
            env,
            ctx,
          );

          await waitOnExecutionContext(ctx);

          return response.json();
        }),
      );

      expect(responses).toEqual([{ ok: true }, { ok: true }]);
    } finally {
      await Promise.all(
        workers.map(async worker => (await worker.getApplication()).close()),
      );
    }
  });

  it('should expose an initialized application with bindings before any HTTP event', async () => {
    @Injectable()
    class DatabaseService {
      constructor(
        @InjectBinding('DATABASE') public readonly database: D1Database,
      ) {}
    }

    const worker = createWorker(() =>
      createApplication({ providers: [DatabaseService] }),
    );

    try {
      const app = await worker.getApplication();
      const database = app.get(DatabaseService).database;

      expect(database).toBe(env.DATABASE);

      expect(
        await database.prepare('SELECT 42 AS value').first<number>('value'),
      ).toBe(42);
    } finally {
      await (await worker.getApplication()).close();
    }
  });

  it('should reject queue events when no Queue transport was connected', async () => {
    const worker = createWorker(() => createApplication());

    try {
      const batch = createMessageBatch('outbox', [
        { id: 'event', timestamp: new Date(), attempts: 1, body: {} },
      ]);

      await expect(
        worker.queue(batch, env, createExecutionContext()),
      ).rejects.toThrow(/queue/i);
    } finally {
      await (await worker.getApplication()).close();
    }
  });

  it('should call fallbacks without connecting queue or cron modules', async () => {
    const seen: string[] = [];

    const worker = createWorker(() => createApplication(), {
      fallback: {
        scheduled(controller) {
          seen.push(controller.cron);
        },
        queue(batch) {
          seen.push(batch.queue);
          batch.ackAll();
        },
      },
    });

    try {
      const scheduledContext = createExecutionContext();

      await worker.scheduled(
        createScheduledController({ cron: '0 0 * * *' }),
        env,
        scheduledContext,
      );

      await waitOnExecutionContext(scheduledContext);

      const batch = createMessageBatch('outbox', [
        { id: 'event', timestamp: new Date(), attempts: 1, body: {} },
      ]);

      const queueContext = createExecutionContext();

      await worker.queue(batch, env, queueContext);

      expect((await getQueueResult(batch, queueContext)).ackAll).toBe(true);
      expect(seen).toEqual(['0 0 * * *', 'outbox']);
    } finally {
      await (await worker.getApplication()).close();
    }
  });

  it('should explain when CloudflareModule was not imported', async () => {
    let app: INestApplication | undefined;

    const worker = createWorker(async () => {
      const module = await Test.createTestingModule({
        controllers: [HttpController],
      }).compile();

      app = module.createNestApplication(new ExpressAdapter(), {
        logger: false,
      });

      return app;
    });

    try {
      await expect(
        worker.fetch(
          incomingRequest('https://worker.test/'),
          env,
          createExecutionContext(),
        ),
      ).rejects.toThrow('CloudflareModule');
    } finally {
      await app?.close();
    }
  });
});
