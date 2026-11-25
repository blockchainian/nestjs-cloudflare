import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable } from '@nestjs/common';

type WorkerExecutionContext = ExecutionContext;
type IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

export interface CloudflareRequestContextValue<Env = unknown> {
  readonly request?: IncomingRequest;
  readonly env: Env;
  readonly ctx: WorkerExecutionContext;
}

/** Provides the native event values for the current Nest invocation. */
@Injectable()
export class CloudflareRequestContext<Env = unknown> {
  private readonly storage = new AsyncLocalStorage<
    CloudflareRequestContextValue<Env>
  >();

  public run<T>(
    value: CloudflareRequestContextValue<Env>,
    callback: () => T,
  ): T {
    return this.storage.run(value, callback);
  }

  public get(): CloudflareRequestContextValue<Env> {
    const value = this.storage.getStore();

    if (!value) {
      throw new Error(
        'Cloudflare request context is unavailable outside an event',
      );
    }

    return value;
  }

  public getRequest(): IncomingRequest | undefined {
    return this.get().request;
  }

  public getEnv(): Env {
    return this.get().env;
  }

  public getExecutionContext(): WorkerExecutionContext {
    return this.get().ctx;
  }
}
