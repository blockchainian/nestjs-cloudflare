import 'reflect-metadata';

import { type INestApplication, Logger } from '@nestjs/common';
import { httpServerHandler } from 'cloudflare:node';

import { CLOUDFLARE_ENV } from '../constants.js';
import type { CloudflareWorker } from '../interfaces/worker.interface.js';
import type { CloudflareWorkerOptions } from '../interfaces/worker-options.interface.js';
import { CLOUDFLARE_QUEUE_TRANSPORT } from '../queue/constants.js';
import { CRON_EXPLORER } from '../schedule/constants.js';
import { CloudflareRequestContext } from './request-context.js';

export {
  CloudflareRequestContext,
  type CloudflareRequestContextValue,
} from './request-context.js';

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
  dispatchAndWait?(
    controller: ScheduledController,
    ctx: WorkerExecutionContext,
  ): Promise<boolean>;
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
  let routeMatcher: ((request: Request) => boolean) | undefined;

  const getApplication = (): Promise<INestApplication> => {
    if (application) {
      return application;
    }

    const startup = (async () => {
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
        configureRouting(app, options);
        await app.init();
        await app.startAllMicroservices();

        if (!app.getHttpServer().listening) {
          await app.listen(0);
        }

        http = httpServerHandler(app.getHttpServer());
        routeMatcher = createRouteMatcher(app);

        return app;
      } catch (error) {
        await app.close();
        throw error;
      }
    })();

    application = startup;

    startup.catch(() => {
      if (application === startup) {
        application = undefined;
      }
    });

    return application;
  };

  const runWithContext = <T>(
    app: INestApplication,
    value: Parameters<CloudflareRequestContext['run']>[0],
    callback: () => T,
  ): T => app.get(CloudflareRequestContext).run(value, callback);

  const matches = async (request: Request): Promise<boolean> => {
    await getApplication();

    return routeMatcher?.(request) ?? false;
  };

  return {
    getApplication,
    matches,
    async fetch(request, env, ctx) {
      const dispatch = async () => {
        const app = await getApplication();
        const matched = routeMatcher?.(request) ?? false;

        if (!matched && options.fallback?.fetch) {
          return options.fallback.fetch(request, env, ctx);
        }

        return runWithContext(app, { request, env, ctx }, () =>
          http.fetch!(request, env, ctx),
        );
      };

      const around = options.around?.fetch;

      return around ? around(request, env, ctx, dispatch) : dispatch();
    },
    async scheduled(controller, env, ctx) {
      const dispatch = async () => {
        const app = await getApplication();
        let scheduled: ScheduledDispatcher | undefined;

        try {
          scheduled = app.get<ScheduledDispatcher>(CRON_EXPLORER);
        } catch {
          // The schedule integration is optional for applications without cron handlers.
        }

        if (scheduled?.dispatchAndWait) {
          if (await scheduled.dispatchAndWait(controller, ctx)) {
            return;
          }
        } else if (scheduled?.dispatch(controller, ctx)) {
          return;
        }

        if (options.fallback?.scheduled) {
          await options.fallback.scheduled(controller, env, ctx);
        } else {
          logger.warn(
            `No Cloudflare cron handler for expression: ${controller.cron}. Import CloudflareScheduleModule.forRoot() and declare a matching @Cron method`,
          );
        }
      };

      const invoke = async () => {
        const app = await getApplication();

        await runWithContext(app, { env, ctx }, () => dispatch());
      };

      const around = options.around?.scheduled;

      return around ? around(controller, env, ctx, invoke) : invoke();
    },
    async queue(batch, env, ctx) {
      const dispatch = async () => {
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
      };

      const invoke = async () => {
        const app = await getApplication();

        await runWithContext(app, { env, ctx }, () => dispatch());
      };

      const around = options.around?.queue;

      return around ? around(batch, env, ctx, invoke) : invoke();
    },
  };
}

function configureRouting<Env>(
  app: INestApplication,
  options: CloudflareWorkerOptions<Env>,
): void {
  const adapter = app.getHttpAdapter();

  const instance = adapter.getInstance() as {
    set?: (name: string, value: boolean) => void;
  };

  const caseSensitive =
    options.routing?.caseSensitive ?? options.routing?.caseSensitiveRouting;

  const strict = options.routing?.strict ?? options.routing?.strictRouting;

  if (caseSensitive !== undefined) {
    instance.set?.('case sensitive routing', caseSensitive);
  }

  if (strict !== undefined) {
    instance.set?.('strict routing', strict);
  }
}

function createRouteMatcher(
  app: INestApplication,
): (request: Request) => boolean {
  const instance = app.getHttpAdapter().getInstance() as {
    _router?: { stack?: ExpressLayer[] };
    router?: { stack?: ExpressLayer[] };
  };

  const stack = instance._router?.stack ?? instance.router?.stack ?? [];

  return request => {
    const url = new URL(request.url);

    return stack.some(layer => {
      if (!layer.route || !layer.match(url.pathname)) {
        return false;
      }

      if (layer.route._handles_method) {
        return layer.route._handles_method(request.method);
      }

      const method = request.method.toLowerCase();

      return Boolean(
        layer.route.methods?.[method] ||
        (method === 'head' && layer.route.methods?.get),
      );
    });
  };
}

interface ExpressLayer {
  route?: {
    _handles_method?: (method: string) => boolean;
    methods?: Record<string, boolean>;
  };
  match(path: string): boolean;
}
