import { Injectable, Logger, type OnModuleInit, Scope } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import type { CronOptions } from '@nestjs/schedule';

import { CRON_METADATA } from './constants.js';

type WorkerExecutionContext = ExecutionContext;

type CronHandler = (
  controller: ScheduledController,
  ctx: WorkerExecutionContext,
) => unknown;

interface ScheduledHandler {
  expression: string;
  options: CronOptions;
  running: boolean;
  invoke: CronHandler;
}

/** Discovers singleton cron methods and dispatches matching scheduled events. */
@Injectable()
export class CronExplorer implements OnModuleInit {
  private readonly logger = new Logger(CronExplorer.name);
  private handlers: ScheduledHandler[] = [];

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  /** Collects cron methods from providers and controllers. */
  public onModuleInit(): void {
    this.handlers = [];

    for (const provider of [
      ...this.discovery.getProviders(),
      ...this.discovery.getControllers(),
    ]) {
      const instance: object | undefined = provider.instance;

      if (
        !instance ||
        (typeof instance !== 'object' && typeof instance !== 'function')
      ) {
        continue;
      }

      const prototype: object | null = Object.getPrototypeOf(instance);

      if (!prototype) {
        continue;
      }

      for (const name of this.scanner.getAllMethodNames(prototype)) {
        const method: unknown = Reflect.get(instance, name);

        if (typeof method !== 'function') {
          continue;
        }

        const metadata = this.reflector.get<
          (CronOptions & { cronTime: unknown }) | undefined
        >(CRON_METADATA, method);

        if (metadata === undefined) {
          continue;
        }

        if (
          provider.scope === Scope.TRANSIENT ||
          !provider.isDependencyTreeStatic()
        ) {
          this.logger.warn(
            `Cannot register cron job "${provider.name}@${name}" because it is defined in a non static provider.`,
          );

          continue;
        }

        if (
          typeof metadata.cronTime !== 'string' ||
          metadata.cronTime.trim().split(/\s+/).length !== 5
        ) {
          this.logger.warn(
            `Cannot register cron job "${provider.name}@${name}" because Workers requires a five-field cron expression.`,
          );

          continue;
        }

        this.handlers.push({
          expression: metadata.cronTime,
          options: metadata,
          running: false,
          invoke: (controller, ctx) => method.call(instance, controller, ctx),
        });
      }
    }
  }

  /** Reports matched handler failures through the event execution context. */
  public dispatch(
    controller: ScheduledController,
    ctx: WorkerExecutionContext,
  ): boolean {
    const matches = this.handlers.filter(
      ({ expression, options }) =>
        !options.disabled && expression === controller.cron,
    );

    if (matches.length === 0) {
      return false;
    }

    ctx.waitUntil(
      Promise.allSettled(
        matches
          .filter(
            handler => !handler.options.waitForCompletion || !handler.running,
          )
          .map(handler => {
            handler.running = true;

            return Promise.resolve()
              .then(() => handler.invoke(controller, ctx))
              .finally(() => {
                handler.running = false;
              });
          }),
      ).then(results => {
        const errors = results
          .filter(result => result.status === 'rejected')
          .map(result => result.reason as unknown);

        if (errors.length > 0) {
          for (const error of errors) {
            this.logger.error(error);
          }

          throw new AggregateError(errors, 'Cron handlers failed');
        }
      }),
    );

    return true;
  }
}
