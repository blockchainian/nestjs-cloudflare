type WorkerExecutionContext = ExecutionContext;
type IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

/**
 * Configures native event dispatch, routing, and fallbacks.
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

  /** Forwards matching paths directly to Durable Objects, including non-upgrade requests. */
  websockets?: readonly CloudflareWorkerWebSocketRoute<Env>[];

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

/** Configures native WebSocket forwarding to one Durable Object. */
export interface CloudflareWorkerWebSocketRoute<Env = Cloudflare.Env> {
  /** Exact URL pathnames, independent of Express routing settings. */
  paths: readonly string[];

  /** Durable Object namespace binding in the event environment. */
  binding: Extract<keyof Env, string>;

  /** A name for idFromName(), or a request resolver returning a name or native ID. */
  object: string | ((request: IncomingRequest) => string | DurableObjectId);
}
