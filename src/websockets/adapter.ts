import { Logger, type WsMessageHandler } from '@nestjs/common';
import { AbstractWsAdapter } from '@nestjs/websockets';
import { lastValueFrom, type Observable, tap } from 'rxjs';

import {
  attachCloudflareWebSocketContext,
  type CloudflareWebSocketContext,
  detachCloudflareWebSocketContext,
} from './context.js';
import type { CloudflareWebSocketAdapterOptions } from './interfaces/adapter-options.interface.js';
import type { CloudflareWebSocketDisconnectReason } from './interfaces/disconnect-event.interface.js';
import type { CloudflareWebSocketServer } from './interfaces/server.interface.js';
import { InvalidWebSocketMessageException } from './invalid-message.exception.js';
import { WebSocketMessageDispatcher } from './message-dispatcher.js';

type ConnectHandler = (client: WebSocket, request?: Request) => void;
type DisconnectHandler = (reason: CloudflareWebSocketDisconnectReason) => void;
type Transform = (data: unknown) => Observable<unknown>;

interface ClientHandlers {
  dispatcher: WebSocketMessageDispatcher;
  messages: Array<{ handlers: WsMessageHandler[]; transform: Transform }>;
  disconnect: DisconnectHandler[];
}

interface ServerHandlers {
  server: CloudflareWebSocketServer;
  connect: ConnectHandler[];
}

/**
 * Connects Nest gateways to the Durable Object WebSocket Hibernation API.
 *
 * @publicApi
 */
// AbstractWsAdapter constrains clients and servers to Node event emitters.
// Durable Objects own native WebSockets and their hibernation callbacks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class CloudflareWebSocketAdapter extends AbstractWsAdapter<any, any> {
  private readonly maxConcurrentMessages: number;
  private readonly logger = new Logger(CloudflareWebSocketAdapter.name);
  private readonly servers = new Map<string, ServerHandlers>();
  private readonly aliases = new Map<string, string>();
  private readonly clients = new WeakMap<WebSocket, ClientHandlers>();

  private readonly messageParser: NonNullable<
    CloudflareWebSocketAdapterOptions['messageParser']
  >;
  private readonly messageSerializer: NonNullable<
    CloudflareWebSocketAdapterOptions['messageSerializer']
  >;

  /**
   * Configures how native frames map to Nest gateway messages.
   */
  constructor(options: CloudflareWebSocketAdapterOptions = {}) {
    super();
    this.maxConcurrentMessages = options.maxConcurrentMessages ?? 1000;
    this.messageParser = options.messageParser ?? parseMessage;
    this.messageSerializer = options.messageSerializer ?? JSON.stringify;
  }

  /**
   * Creates a logical gateway server without opening a TCP listener.
   */
  public create(
    port: number,
    options: { path?: string; namespace?: string } = {},
  ): CloudflareWebSocketServer {
    if (port !== 0 || options.namespace !== undefined) {
      throw new Error(
        'Durable Object gateways require port 0 and do not support Socket.IO namespaces',
      );
    }

    const path = options.path ?? '/';

    if (!path.startsWith('/')) {
      throw new Error('WebSocket gateway path must start with /');
    }

    const entry = this.servers.get(path);

    if (entry) {
      return entry.server;
    }

    const server = { path };

    this.servers.set(path, { server, connect: [] });

    return server;
  }

  /**
   * Registers Nest's connection callback for a gateway server.
   */
  public bindClientConnect(
    server: CloudflareWebSocketServer,
    callback: ConnectHandler,
  ): void {
    this.server(server.path).connect.push(callback);
  }

  /** Registers a fallback path without replacing a discovered gateway. */
  public registerPathAlias(path: string, targetPath: string): void {
    this.server(targetPath);

    if (!this.servers.has(path)) {
      this.aliases.set(path, targetPath);
    }
  }

  /**
   * Registers Nest's disconnection callback for a native socket.
   */
  public bindClientDisconnect(
    client: WebSocket,
    callback: DisconnectHandler,
  ): void {
    this.client(client).disconnect.push(callback);
  }

  /**
   * Retains the message callbacks and result transform provided by Nest.
   */
  public bindMessageHandlers(
    client: WebSocket,
    handlers: WsMessageHandler[],
    transform: Transform,
  ): void {
    this.client(client).messages.push({ handlers, transform });
  }

  /**
   * Binds a connection or a restored socket through Nest's gateway pipeline.
   */
  public connect(
    path: string,
    socket: WebSocket,
    request?: Request,
    context?: CloudflareWebSocketContext<unknown, unknown>,
  ): void {
    if (this.clients.has(socket)) {
      return;
    }

    const { connect } = this.server(path);

    this.clients.set(socket, {
      messages: [],
      disconnect: [],
      dispatcher: new WebSocketMessageDispatcher(
        frame => this.dispatchMessage(socket, frame),
        this.maxConcurrentMessages,
      ),
    });

    if (context) {
      attachCloudflareWebSocketContext(socket, context);
    }

    for (const callback of connect) {
      callback(socket, request);
    }
  }

  /**
   * Dispatches a JSON event through Nest and sends every returned value.
   */
  public message(
    socket: WebSocket,
    frame: string | ArrayBuffer,
  ): Promise<void> {
    return this.client(socket).dispatcher.dispatch(frame);
  }

  private async dispatchMessage(
    socket: WebSocket,
    frame: string | ArrayBuffer,
  ): Promise<void> {
    const packet = this.messageParser(frame);

    if (!packet) {
      return;
    }

    const { event, data } = packet;

    await Promise.all(
      this.client(socket).messages.flatMap(({ handlers, transform }) =>
        handlers
          .filter(handler => handler.message === event)
          .map(async handler => {
            await lastValueFrom(
              transform(handler.callback(data, event)).pipe(
                tap(result => {
                  if (
                    result !== undefined &&
                    result !== null &&
                    socket.readyState === WebSocket.OPEN
                  ) {
                    socket.send(this.messageSerializer(result));
                  }
                }),
              ),
              { defaultValue: undefined },
            );
          }),
      ),
    );
  }

  /**
   * Dispatches disconnection hooks and releases this socket's callbacks.
   */
  public disconnect(
    socket: WebSocket,
    reason: CloudflareWebSocketDisconnectReason = undefined,
  ): void {
    const handlers = this.clients.get(socket);

    if (!handlers) {
      return;
    }

    handlers.dispatcher.close();
    this.clients.delete(socket);
    detachCloudflareWebSocketContext(socket);

    for (const callback of handlers.disconnect) {
      callback(reason);
    }
  }

  /**
   * Logs an error through Nest without closing the connection.
   */
  public error(_socket: WebSocket, error: unknown): void {
    this.logger.error(error);
  }

  /**
   * Removes gateway registration while Durable Objects retain socket ownership.
   */
  public async close(server: CloudflareWebSocketServer): Promise<void> {
    this.servers.delete(server.path);
  }

  /**
   * Releases gateway registrations when the Nest application shuts down.
   */
  public async dispose(): Promise<void> {
    this.servers.clear();
    this.aliases.clear();
  }

  private server(path: string): ServerHandlers {
    const server =
      this.servers.get(path) ??
      this.servers.get(this.aliases.get(path) ?? path);

    if (!server) {
      throw new Error(`No Nest WebSocket gateway registered for path: ${path}`);
    }

    return server;
  }

  private client(socket: WebSocket): ClientHandlers {
    const client = this.clients.get(socket);

    if (!client) {
      throw new Error('WebSocket has not been attached to a Nest gateway');
    }

    return client;
  }
}

function parseMessage(frame: string | ArrayBuffer) {
  const text =
    typeof frame === 'string' ? frame : new TextDecoder().decode(frame);

  let packet: unknown;

  try {
    packet = JSON.parse(text);
  } catch (cause) {
    throw new InvalidWebSocketMessageException(
      'WebSocket message must be valid JSON',
      { cause },
    );
  }

  if (
    typeof packet !== 'object' ||
    packet === null ||
    !('event' in packet) ||
    typeof packet.event !== 'string'
  ) {
    throw new InvalidWebSocketMessageException(
      'WebSocket message requires a string event',
    );
  }

  return {
    event: packet.event,
    data: 'data' in packet ? (packet.data as unknown) : undefined,
  };
}
