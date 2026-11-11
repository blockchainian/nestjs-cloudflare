import type { INestApplication } from '@nestjs/common';

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

  /** Starts or retrieves the initialized Nest application. */
  getApplication: () => Promise<INestApplication>;
}
