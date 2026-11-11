import type { CloudflareWebSocketMessage } from './message.interface.js';

/**
 * Configures parsing of native WebSocket frames before Nest dispatch.
 *
 * @publicApi
 */
export interface CloudflareWebSocketAdapterOptions {
  /** Maps a frame to an event and payload, or returns void to ignore it. */
  messageParser?: (
    data: string | ArrayBuffer,
  ) => CloudflareWebSocketMessage | void;
}
