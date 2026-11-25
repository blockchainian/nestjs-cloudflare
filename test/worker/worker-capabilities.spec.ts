import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import {
  ConsoleLogger,
  Controller,
  Get,
  Head,
  Injectable,
  Logger,
  Module,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
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
import express from 'express';
import { describe, expect, it } from 'vitest';

import {
  CloudflareModule,
  CloudflareRequestContext,
  createWorker,
} from '../../src/index.js';
import { CloudflareQueueServer } from '../../src/queue/index.js';

async function application(
  metadata: Record<string, unknown> = {},
  settings: Record<string, boolean> = {},
): Promise<INestApplication> {
  return withEnv(
    { DATABASE: env.DATABASE, STATE: env.STATE, OUTBOX: env.OUTBOX },
    async () => {
      const module = await Test.createTestingModule({
        imports: [CloudflareModule.forRoot()],
        ...metadata,
      }).compile();

      const instance = express();

      for (const [name, value] of Object.entries(settings)) {
        instance.set(name, value);
      }

      return module.createNestApplication(new ExpressAdapter(instance), {
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

class ErrorLog extends ConsoleLogger {
  readonly errors: unknown[] = [];

  constructor() {
    super({ logLevels: ['error'] });
  }

  override error(message: unknown, ...optionalParams: unknown[]) {
    this.errors.push(message);
    super.error(message, ...optionalParams);
  }
}

@Module({ imports: [CloudflareModule.forRoot()] })
class FallbackModule {}

async function fallbackApplication(
  logger: ErrorLog,
): Promise<INestApplication> {
  return withEnv(
    { DATABASE: env.DATABASE, STATE: env.STATE, OUTBOX: env.OUTBOX },
    () =>
      NestFactory.create(FallbackModule, new ExpressAdapter(), {
        logger,
        abortOnError: false,
      }),
  ) as Promise<INestApplication>;
}

describe('worker capabilities', () => {
  it('calls scheduled fallback without error logs when the schedule module is absent', async () => {
    const logger = new ErrorLog();
    const seen: string[] = [];

    const worker = createWorker(() => fallbackApplication(logger), {
      fallback: {
        scheduled(controller) {
          seen.push(controller.cron);
        },
      },
    });

    try {
      const ctx = createExecutionContext();

      await worker.scheduled(
        createScheduledController({ cron: '0 0 * * *' }),
        env,
        ctx,
      );

      await waitOnExecutionContext(ctx);

      expect(seen).toEqual(['0 0 * * *']);
      expect(logger.errors).toEqual([]);
    } finally {
      await (await worker.getApplication()).close();
      Logger.overrideLogger(false);
    }
  });

  it('calls queue fallback without error logs when no queue transport is connected', async () => {
    const logger = new ErrorLog();
    const seen: string[] = [];

    const worker = createWorker(() => fallbackApplication(logger), {
      fallback: {
        queue(batch) {
          seen.push(batch.queue);
          batch.ackAll();
        },
      },
    });

    try {
      const ctx = createExecutionContext();

      const batch = createMessageBatch('events', [
        { id: 'event', timestamp: new Date(), attempts: 1, body: {} },
      ]);

      await worker.queue(batch, env, ctx);

      expect((await getQueueResult(batch, ctx)).ackAll).toBe(true);
      expect(seen).toEqual(['events']);
      expect(logger.errors).toEqual([]);
    } finally {
      await (await worker.getApplication()).close();
      Logger.overrideLogger(false);
    }
  });

  it.each([true, false])(
    'respects case sensitive routing with fallback %s',
    async useFallback => {
      @Controller()
      class Routes {
        @Get('health')
        health() {
          return 'nest';
        }
      }

      const worker = createWorker(
        () =>
          application(
            { controllers: [Routes] },
            { 'case sensitive routing': true },
          ),
        {
          routing: { caseSensitive: true },
          fallback: useFallback
            ? { fetch: () => new Response('fallback', { status: 404 }) }
            : undefined,
        },
      );

      const response = await worker.fetch(
        incoming(new Request('https://worker.test/HEALTH')),
        env,
        createExecutionContext(),
      );

      expect(response.status).toBe(404);

      if (useFallback) {
        expect(await response.text()).toBe('fallback');
      } else {
        expect(await response.json()).toMatchObject({ statusCode: 404 });
      }

      await (await worker.getApplication()).close();
    },
  );

  it.each([true, false])(
    'respects strict routing with fallback %s',
    async useFallback => {
      @Controller()
      class Routes {
        @Get('health')
        health() {
          return 'nest';
        }
      }

      const worker = createWorker(
        () =>
          application({ controllers: [Routes] }, { 'strict routing': true }),
        {
          routing: { strict: true },
          fallback: useFallback
            ? { fetch: () => new Response('fallback', { status: 404 }) }
            : undefined,
        },
      );

      const response = await worker.fetch(
        incoming(new Request('https://worker.test/health/')),
        env,
        createExecutionContext(),
      );

      expect(response.status).toBe(404);

      if (useFallback) {
        expect(await response.text()).toBe('fallback');
      } else {
        expect(await response.json()).toMatchObject({ statusCode: 404 });
      }

      await (await worker.getApplication()).close();
    },
  );

  it('can require an explicit HEAD route during pre-matching', async () => {
    @Controller()
    class Routes {
      @Head('explicit')
      explicit() {
        return 'explicit';
      }

      @Get('explicit')
      explicitGet() {
        return 'get';
      }

      @Get('health')
      health() {
        return 'nest';
      }
    }

    const worker = createWorker(() => application({ controllers: [Routes] }), {
      routing: { headImplicitMatch: false },
      fallback: { fetch: () => new Response('fallback', { status: 404 }) },
    });

    const response = await worker.fetch(
      incoming(new Request('https://worker.test/health', { method: 'HEAD' })),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('fallback');

    expect(
      await worker.matches(
        incoming(new Request('https://worker.test/health', { method: 'HEAD' })),
      ),
    ).toBe(false);

    const explicitRequest = incoming(
      new Request('https://worker.test/explicit', { method: 'HEAD' }),
    );

    expect(await worker.matches(explicitRequest)).toBe(true);

    const explicitResponse = await worker.fetch(
      explicitRequest,
      env,
      createExecutionContext(),
    );

    expect(explicitResponse.status).toBe(200);
    expect(await explicitResponse.text()).toBe('');

    await (await worker.getApplication()).close();
  });

  it('preserves permissive path matching and implicit HEAD by default', async () => {
    @Controller()
    class Routes {
      @Get('health')
      health() {
        return 'nest';
      }
    }

    const worker = createWorker(() => application({ controllers: [Routes] }), {
      fallback: { fetch: () => new Response('fallback', { status: 404 }) },
    });

    for (const request of [
      new Request('https://worker.test/HEALTH'),
      new Request('https://worker.test/health/'),
      new Request('https://worker.test/health', { method: 'HEAD' }),
    ]) {
      expect(await worker.matches(incoming(request))).toBe(true);

      const response = await worker.fetch(
        incoming(request),
        env,
        createExecutionContext(),
      );

      expect(response.status).toBe(200);

      expect(await response.text()).toBe(
        request.method === 'HEAD' ? '' : 'nest',
      );
    }

    await (await worker.getApplication()).close();
  });

  it.each([
    { caseSensitive: true },
    { strict: true },
    { caseSensitiveRouting: true },
    { strictRouting: true },
  ])(
    'rejects routing expectations missing from Express settings: %j',
    async routing => {
      const worker = createWorker(() => application(), { routing });

      await expect(worker.getApplication()).rejects.toThrow(
        'before passing it to new ExpressAdapter(instance) in bootstrap',
      );
    },
  );

  it('passes malformed route encoding to fallback through request context', async () => {
    @Controller()
    class Routes {
      @Get('admin/users/:id/stats')
      stats() {
        return 'nest';
      }
    }

    let app: INestApplication | undefined;
    let routeError: URIError | undefined;

    const worker = createWorker(
      async () => {
        app = await application({ controllers: [Routes] });

        return app;
      },
      {
        fallback: {
          fetch: () => {
            routeError = app?.get(CloudflareRequestContext).getRouteError();

            return new Response('fallback');
          },
        },
      },
    );

    const response = await worker.fetch(
      incoming(new Request('https://worker.test/admin/users/%E0%A4%A/stats')),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('fallback');
    expect(routeError).toBeInstanceOf(URIError);
    expect(routeError?.message).toContain('Failed to decode param');

    await (await worker.getApplication()).close();
  });

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

class StartupLog extends ConsoleLogger {
  readonly messages: unknown[] = [];

  override log(message: unknown): void {
    this.messages.push(message);
  }
}

class CountingQueueServer extends CloudflareQueueServer {
  starts = 0;

  override listen(callback: () => void): void {
    this.starts++;
    super.listen(callback);
  }
}

@Controller()
class EventsController {
  readonly received: unknown[] = [];

  @EventPattern('outbox')
  consume(data: unknown): void {
    this.received.push(data);
  }
}

@Module({
  imports: [CloudflareModule.forRoot()],
  controllers: [EventsController],
})
class StartupModule {}

function startupApplication(logger: StartupLog): Promise<INestApplication> {
  return withEnv(
    { DATABASE: env.DATABASE, STATE: env.STATE, OUTBOX: env.OUTBOX },
    async () => {
      const app = await NestFactory.create(
        StartupModule,
        new ExpressAdapter(),
        {
          logger,
          abortOnError: false,
        },
      );

      await app.init();

      return app;
    },
  ) as Promise<INestApplication>;
}

function startupMessages(logger: StartupLog): unknown[] {
  return logger.messages.filter(
    message => message === 'Nest microservice successfully started',
  );
}

describe('worker startup', () => {
  it('starts every connected microservice by default', async () => {
    const logger = new StartupLog();
    const transports = [new CountingQueueServer(), new CountingQueueServer()];

    const worker = createWorker(async () => {
      const app = await startupApplication(logger);

      for (const strategy of transports) {
        app.connectMicroservice({ strategy });
      }

      return app;
    });

    try {
      await worker.getApplication();

      expect(transports.map(transport => transport.starts)).toEqual([1, 1]);
      expect(startupMessages(logger)).toHaveLength(2);
    } finally {
      await (await worker.getApplication()).close();
      Logger.overrideLogger(false);
    }
  });

  it('preserves bootstrap startup without duplicate microservice logs', async () => {
    const logger = new StartupLog();
    const runtimeLogger = new StartupLog();
    const transports = [new CountingQueueServer(), new CountingQueueServer()];

    const worker = createWorker(
      async () => {
        const app = await startupApplication(logger);

        for (const strategy of transports) {
          app.connectMicroservice({ strategy });
        }

        await app.init();
        await app.startAllMicroservices();
        await app.listen(0);
        app.useLogger(runtimeLogger);

        return app;
      },
      { microservicesStarted: true },
    );

    try {
      await worker.getApplication();
      await worker.getApplication();

      expect(transports.map(transport => transport.starts)).toEqual([1, 1]);
      expect(startupMessages(logger)).toHaveLength(2);
      expect(runtimeLogger.messages).toEqual([]);
    } finally {
      await (await worker.getApplication()).close();
      Logger.overrideLogger(false);
    }
  });

  it('dispatches queue events to microservices started by bootstrap', async () => {
    const logger = new StartupLog();
    const transport = new CountingQueueServer();

    const worker = createWorker(
      async () => {
        const app = await startupApplication(logger);

        app.connectMicroservice({ strategy: transport });
        await app.startAllMicroservices();

        return app;
      },
      { microservicesStarted: true },
    );

    try {
      const ctx = createExecutionContext();

      const batch = createMessageBatch('outbox', [
        {
          id: 'event',
          timestamp: new Date(),
          attempts: 1,
          body: { value: 42 },
        },
      ]);

      await worker.queue(batch, env, ctx);

      const app = await worker.getApplication();

      expect(app.get(EventsController).received).toEqual([{ value: 42 }]);

      expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual([
        'event',
      ]);

      expect(transport.starts).toBe(1);
    } finally {
      await (await worker.getApplication()).close();
      Logger.overrideLogger(false);
    }
  });
});
