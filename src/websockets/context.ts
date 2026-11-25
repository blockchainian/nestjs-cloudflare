/** State belonging to the Durable Object that accepted a WebSocket. */
export interface CloudflareWebSocketContext<
  Env = unknown,
  ObjectType = unknown,
> {
  readonly ctx: DurableObjectState;
  readonly env: Env;
  readonly object: ObjectType;
  readonly storage: DurableObjectStorage;
  readonly sockets: ReadonlySet<WebSocket>;
}

const contexts = new WeakMap<WebSocket, CloudflareWebSocketContext>();

export function attachCloudflareWebSocketContext(
  socket: WebSocket,
  context: CloudflareWebSocketContext,
): void {
  contexts.set(socket, context);
}

export function detachCloudflareWebSocketContext(socket: WebSocket): void {
  contexts.delete(socket);
}

/** Returns the owning Durable Object state for a gateway socket. */
export function getCloudflareWebSocketContext<
  Env = Cloudflare.Env,
  ObjectType = DurableObject,
>(socket: WebSocket): CloudflareWebSocketContext<Env, ObjectType> {
  const context = contexts.get(socket);

  if (!context) {
    throw new Error('WebSocket is not attached to a Cloudflare Durable Object');
  }

  return context as CloudflareWebSocketContext<Env, ObjectType>;
}
