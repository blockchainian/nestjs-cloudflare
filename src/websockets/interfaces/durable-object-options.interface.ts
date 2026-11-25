import type { INestApplication } from '@nestjs/common';

import type { CloudflareDurableObjectOptions } from '../../durable-objects/interfaces/server-options.interface.js';
import type { CloudflareWebSocketAdapter } from '../adapter.js';

/**
 * Selects the gateway and application used by a Durable Object.
 *
 * @publicApi
 */
export interface CloudflareWebSocketDurableObjectOptions {
  /** Adapter installed on the Nest application. */
  adapter: CloudflareWebSocketAdapter;

  /** Path declared by the gateway's WebSocketGateway options. */
  path: string;

  /** Enables native RPC messages and alarm events on this gateway host. */
  transport?: Omit<CloudflareDurableObjectOptions, 'getApplication'>;

  /** Starts or retrieves the initialized Nest application. */
  getApplication: () => Promise<INestApplication>;
}
