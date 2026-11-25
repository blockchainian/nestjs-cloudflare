import type {
  CloudflareWebSocketDisconnectEvent,
  CloudflareWebSocketDisconnectReason,
} from './interfaces/disconnect-event.interface.js';

/** Converts the legacy reason argument into a discriminated disconnection event. */
export function getCloudflareWebSocketDisconnectEvent(
  reason: CloudflareWebSocketDisconnectReason,
): CloudflareWebSocketDisconnectEvent {
  return reason === undefined ? { type: 'error' } : { type: 'close', reason };
}
