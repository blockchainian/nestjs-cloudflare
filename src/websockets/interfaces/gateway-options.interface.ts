import type { CloudflareWebSocketAdapter } from '../adapter.js';

/** Options for a non-hibernating Durable Object gateway host. */
export interface CloudflareWebSocketGatewayOptions {
  /** Adapter installed on the Nest application. */
  adapter: CloudflareWebSocketAdapter;

  /** Gateway paths served by this Durable Object. */
  paths: readonly string[];

  /** Starts or retrieves the initialized Nest application. */
  getApplication: () => Promise<unknown>;
}
