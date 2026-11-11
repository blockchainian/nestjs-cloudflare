type WorkerExecutionContext = ExecutionContext;

/**
 * Configures native event fallbacks when no Nest transport handles an event.
 *
 * @publicApi
 */
export interface CloudflareWorkerOptions<Env = Cloudflare.Env> {
  /** Native handlers for events not handled by a connected Nest transport. */
  fallback?: {
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
