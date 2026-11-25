import type { CloudflareWebSocketMessage } from './message.interface.js';

/**
 * Configures parsing of native WebSocket frames before Nest dispatch.
 *
 * @publicApi
 */
export interface CloudflareWebSocketAdapterOptions {
  /** Maximum active messages per connection. Defaults to 1000; use 1 for serial handling. */
  maxConcurrentMessages?: number;

  /** Maps a frame to an event and payload, or returns void to ignore it. */
  messageParser?: (
    data: string | ArrayBuffer,
  ) => CloudflareWebSocketMessage | void;

  /** Serializes values returned by gateway handlers before sending them. */
  messageSerializer?: (data: unknown) => string | ArrayBuffer;
}
