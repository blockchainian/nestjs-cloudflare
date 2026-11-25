type WorkerExecutionContext = ExecutionContext;
type IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

/**
 * Configures native event fallbacks when no Nest transport handles an event.
 *
 * @publicApi
 */
export interface CloudflareWorkerOptions<Env = Cloudflare.Env> {
  /** Wraps complete native event dispatch. */
  around?: {
    fetch?: CloudflareWorkerAroundFetch<Env>;
    scheduled?: CloudflareWorkerAroundScheduled<Env>;
    queue?: CloudflareWorkerAroundQueue<Env>;
  };

  /** Validates Express settings and controls implicit HEAD pre-matching. */
  routing?: {
    caseSensitive?: boolean;
    strict?: boolean;

    /** Allows HEAD to pre-match GET routes. Defaults to true. */
    headImplicitMatch?: boolean;
    caseSensitiveRouting?: boolean;
    strictRouting?: boolean;
  };

  /** Native handlers for events not handled by a connected Nest transport. */
  fallback?: {
    fetch?: (
      request: IncomingRequest,
      env: Env,
      ctx: WorkerExecutionContext,
    ) => Response | Promise<Response>;
    scheduled?: (
      controller: ScheduledController,
      env: Env,
      ctx: WorkerExecutionContext,
    ) => void | Promise<void>;
    queue?: (
      batch: MessageBatch,
      env: Env,
      ctx: WorkerExecutionContext,
    ) => void | Promise<void>;
  };
}

export type CloudflareWorkerAroundFetch<Env> = (
  request: Request<unknown, IncomingRequestCfProperties>,
  env: Env,
  ctx: ExecutionContext,
  next: () => Promise<Response>,
) => Response | Promise<Response>;

export type CloudflareWorkerAroundScheduled<Env> = (
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
  next: () => Promise<void>,
) => void | Promise<void>;

export type CloudflareWorkerAroundQueue<Env> = (
  batch: MessageBatch,
  env: Env,
  ctx: ExecutionContext,
  next: () => Promise<void>,
) => void | Promise<void>;
