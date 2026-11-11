/**
 * Identifies the gateway path served by Durable Object connections.
 *
 * @publicApi
 */
export interface CloudflareWebSocketServer {
  /** The path selected by the gateway's options. */
  readonly path: string;
}
