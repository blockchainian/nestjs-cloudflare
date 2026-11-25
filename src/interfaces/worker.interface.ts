import type { INestApplication } from '@nestjs/common';

type WorkerExecutionContext = ExecutionContext;
type IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

/**
 * Worker event handlers backed by one lazily initialized Nest application.
 *
 * @publicApi
 */
export interface CloudflareWorker<Env = Cloudflare.Env> {
  /** Starts the application once and returns it to native Worker or Durable Object code. */
  getApplication(): Promise<INestApplication>;

  /** Serves an HTTP request through the application's HTTP adapter. */
  fetch(
    request: IncomingRequest,
    env: Env,
    ctx: WorkerExecutionContext,
  ): Promise<Response>;

  /** Reports whether Express has a route for a request without consuming its body. */
  matches(request: IncomingRequest): Promise<boolean>;

  /** Dispatches an event to registered Nest cron methods or the native fallback. */
  scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: WorkerExecutionContext,
  ): Promise<void>;

  /** Dispatches a batch to the application's Cloudflare Queue transport. */
  queue(
    batch: MessageBatch,
    env: Env,
    ctx: WorkerExecutionContext,
  ): Promise<void>;
}
