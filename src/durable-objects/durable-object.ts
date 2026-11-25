import { CloudflareDurableObjectHost } from './host.js';
import type { CloudflareDurableObjectOptions } from './interfaces/server-options.interface.js';

/** Hosts a Nest microservice transport inside a native Durable Object. */
export abstract class CloudflareDurableObject<
  Env = Cloudflare.Env,
> extends CloudflareDurableObjectHost<Env> {
  constructor(
    state: DurableObjectState,
    env: Env,
    options: CloudflareDurableObjectOptions,
  ) {
    super(state, env, {
      getApplication: options.getApplication,
      transport: options,
    });
  }
}
