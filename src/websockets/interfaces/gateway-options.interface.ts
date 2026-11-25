import type { INestApplicationContext } from '@nestjs/common';

import type { CloudflareDurableObjectOptions } from '../../durable-objects/interfaces/server-options.interface.js';
import type { CloudflareWebSocketAdapter } from '../adapter.js';

/** Options for a non-hibernating Durable Object gateway host. */
export interface CloudflareWebSocketGatewayOptions {
  /** Adapter installed on the Nest application. */
  adapter: CloudflareWebSocketAdapter;

  /** Gateway paths served by this Durable Object. */
  paths: readonly string[];

  /** Enables native RPC messages and alarm events on this gateway host. */
  transport?: Omit<CloudflareDurableObjectOptions, 'getApplication'>;

  /** Starts or retrieves the initialized Nest application. */
  getApplication: () => Promise<INestApplicationContext>;
}
