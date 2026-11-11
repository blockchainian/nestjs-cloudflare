/**
 * A message mapped to a Nest gateway event.
 *
 * @publicApi
 */
export interface CloudflareWebSocketMessage {
  /** Name matched against SubscribeMessage metadata. */
  event: string;

  /** Payload passed to the gateway's message handler. */
  data: unknown;
}
