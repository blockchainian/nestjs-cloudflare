import type { OnGatewayDisconnect } from '@nestjs/websockets';

/** A peer close reason, possibly empty; undefined identifies a terminal socket error. */
export type CloudflareWebSocketDisconnectReason = string | undefined;

/** Distinguishes a received close notification from a terminal socket error. */
export type CloudflareWebSocketDisconnectEvent =
  { type: 'close'; reason: string } | { type: 'error' };

/**
 * Receives a single disconnection notification after the host handles the handshake.
 *
 * @publicApi
 */
export interface OnCloudflareWebSocketDisconnect<
  T = WebSocket,
> extends OnGatewayDisconnect<T> {
  handleDisconnect(
    client: T,
    reason: CloudflareWebSocketDisconnectReason,
  ): void;
}
