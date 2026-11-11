import 'reflect-metadata';

import { type INestApplication, Logger } from '@nestjs/common';
import { httpServerHandler } from 'cloudflare:node';

import { CLOUDFLARE_ENV } from '../constants.js';
import type { CloudflareWorker } from '../interfaces/worker.interface.js';
import type { CloudflareWorkerOptions } from '../interfaces/worker-options.interface.js';
import { CLOUDFLARE_QUEUE_TRANSPORT } from '../queue/constants.js';
import { CRON_EXPLORER } from '../schedule/constants.js';

type WorkerExecutionContext = ExecutionContext;

interface QueueTransport {
  transportId: symbol;
  consume(
    batch: MessageBatch,
    ctx: WorkerExecutionContext,
    fallback?: () => void | Promise<void>,
  ): Promise<void>;
}

interface ScheduledDispatcher {
  dispatch(
    controller: ScheduledController,
    ctx: WorkerExecutionContext,
  ): boolean;
}

/**
 * Defers Nest bootstrap until the first event and caches the initialized application.
 *
 * @publicApi
 */
export function createWorker<Env = Cloudflare.Env>(
  bootstrap: () => Promise<INestApplication>,
  options: CloudflareWorkerOptions<Env> = {},
): CloudflareWorker<Env> {
  const logger = new Logger('CloudflareWorker');
  let application: Promise<INestApplication> | undefined;
  let http: ReturnType<typeof httpServerHandler>;

  const getApplication = (): Promise<INestApplication> => {
    application ??= (async () => {
      const app = await bootstrap();

      try {
        app.get(CLOUDFLARE_ENV);
      } catch (cause) {
        await app.close();
        throw new Error(
          'Import CloudflareModule.forRoot() in the application root module',
          { cause },
        );
      }

      try {
        await app.init();
        await app.startAllMicroservices();

        if (!app.getHttpServer().listening) {
          await app.listen(0);
        }

        http = httpServerHandler(app.getHttpServer());

        return app;
      } catch (error) {
        await app.close();
        throw error;
      }
    })();

    return application;
  };

  return {
    getApplication,
    async fetch(request, env, ctx) {
      await getApplication();

      return http.fetch!(request, env, ctx);
    },
    async scheduled(controller, env, ctx) {
      const app = await getApplication();
      let scheduled: ScheduledDispatcher | undefined;

      try {
        scheduled = app.get<ScheduledDispatcher>(CRON_EXPLORER);
      } catch {
        // The schedule integration is optional for applications without cron handlers.
      }

      if (scheduled?.dispatch(controller, ctx)) {
        return;
      }

      if (options.fallback?.scheduled) {
        await options.fallback.scheduled(controller, env, ctx);
      } else {
        logger.warn(
          `No Cloudflare cron handler for expression: ${controller.cron}. Import CloudflareScheduleModule.forRoot() and declare a matching @Cron method`,
        );
      }
    },
    async queue(batch, env, ctx) {
      const app = await getApplication();
      const transports: QueueTransport[] = [];

      for (const microservice of app.getMicroservices()) {
        let transport: unknown;

        try {
          transport = microservice.unwrap<unknown>();
        } catch {
          continue;
        }

        if (
          typeof transport === 'object' &&
          transport !== null &&
          'transportId' in transport &&
          transport.transportId === CLOUDFLARE_QUEUE_TRANSPORT
        ) {
          transports.push(transport as QueueTransport);
        }
      }

      if (transports.length > 1) {
        throw new Error(
          'Connect exactly one CloudflareQueueServer to dispatch Worker queue events',
        );
      }

      const fallback = options.fallback?.queue;

      if (!transports[0]) {
        if (fallback) {
          await fallback(batch, env, ctx);

          return;
        }

        throw new Error(
          'Connect a CloudflareQueueServer with app.connectMicroservice() before handling queue events',
        );
      }

      await transports[0].consume(
        batch,
        ctx,
        fallback ? () => fallback(batch, env, ctx) : undefined,
      );
    },
  };
}
