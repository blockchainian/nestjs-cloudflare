import { Injectable, type LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  SubscribeMessage,
  WebSocketGateway,
  WsException,
} from '@nestjs/websockets';

import {
  CloudflareWebSocketAdapter,
  type CloudflareWebSocketDisconnectEvent,
  type CloudflareWebSocketDisconnectReason,
  CloudflareWebSocketDurableObject,
  CloudflareWebSocketGatewayDurableObject,
  getCloudflareWebSocketContext,
  getCloudflareWebSocketDisconnectEvent,
  type OnCloudflareWebSocketDisconnect,
} from '../../src/websockets/index.js';

@Injectable()
class SocketEvents implements LoggerService {
  readonly sockets = new Set<WebSocket>();
  readonly errors: string[] = [];
  readonly nativeEvents: string[] = [];
  readonly reasons: CloudflareWebSocketDisconnectReason[] = [];
  readonly disconnectStates: number[] = [];
  readonly disconnectEvents: CloudflareWebSocketDisconnectEvent[] = [];
  disconnects = 0;
  hibernating = false;
  socket?: WebSocket;
  hostSockets?: ReadonlySet<WebSocket>;
  private completeError!: () => void;
  readonly errorReceived = new Promise<void>(resolve => {
    this.completeError = resolve;
  });

  log(_message: unknown): void {}

  warn(_message: unknown): void {}

  error(message: unknown): void {
    this.errors.push(
      String(message instanceof ErrorEvent ? message.message : message),
    );
  }

  recordError(): void {
    this.nativeEvents.push('error');
    this.completeError();
  }

  snapshot() {
    return {
      errors: [...this.errors],
      nativeEvents: [...this.nativeEvents],
      disconnects: this.disconnects,
      reasons: [...this.reasons],
      disconnectEvents: [...this.disconnectEvents],
      disconnectStates: [...this.disconnectStates],
      connections: this.sockets.size,
      readyState: this.socket?.readyState,
      hostConnections: this.hostSockets?.size,
    };
  }
}

@WebSocketGateway({ path: '/errors' })
class ErrorGateway implements OnCloudflareWebSocketDisconnect {
  constructor(private readonly events: SocketEvents) {}

  handleConnection(socket: WebSocket): void {
    this.events.sockets.add(socket);
    this.events.socket = socket;

    if (!this.events.hibernating) {
      this.events.hostSockets = getCloudflareWebSocketContext(socket).sockets;
      socket.addEventListener('error', () => this.events.recordError());

      socket.addEventListener('close', () => {
        this.events.nativeEvents.push('close');
      });
    }
  }

  handleDisconnect(
    socket: WebSocket,
    reason: CloudflareWebSocketDisconnectReason,
  ): void {
    this.events.disconnectEvents.push(
      getCloudflareWebSocketDisconnectEvent(reason),
    );

    this.events.reasons.push(reason);
    this.events.disconnectStates.push(socket.readyState);
    this.events.disconnects++;
    this.events.sockets.delete(socket);
  }

  @SubscribeMessage('echo')
  echo() {
    return { event: 'reply' };
  }

  @SubscribeMessage('failure')
  failure() {
    throw new WsException('Rejected by Nest');
  }

  @SubscribeMessage('unexpected-failure')
  failUnexpectedly(): void {
    throw new Error('Handler failure');
  }
}

function createAdapter() {
  return new CloudflareWebSocketAdapter({
    messageParser(frame) {
      if (frame === 'parser-error') {
        throw new Error('Parser failure');
      }

      return JSON.parse(String(frame)) as { event: string; data: unknown };
    },
  });
}

async function bootstrap(
  adapter: CloudflareWebSocketAdapter,
  events: SocketEvents,
) {
  const module = await Test.createTestingModule({
    providers: [ErrorGateway, { provide: SocketEvents, useValue: events }],
  }).compile();

  const app = module.createNestApplication();

  app.useLogger(events);
  app.useWebSocketAdapter(adapter);
  await app.init();

  return app;
}

export class ActiveErrorRoom extends CloudflareWebSocketGatewayDurableObject {
  readonly events: SocketEvents;
  readonly adapter: CloudflareWebSocketAdapter;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    const adapter = createAdapter();
    const events = new SocketEvents();

    super(ctx, env, {
      adapter,
      paths: ['/errors'],
      getApplication: () => bootstrap(adapter, events),
    });

    this.events = events;
    this.adapter = adapter;
  }

  async waitForError() {
    await this.events.errorReceived;

    return this.events.snapshot();
  }
}

export class HibernatingErrorRoom extends CloudflareWebSocketDurableObject {
  readonly events: SocketEvents;
  readonly adapter: CloudflareWebSocketAdapter;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    const adapter = createAdapter();
    const events = new SocketEvents();

    events.hibernating = true;

    super(ctx, env, {
      adapter,
      path: '/errors',
      getApplication: () => bootstrap(adapter, events),
    });

    this.events = events;
    this.adapter = adapter;
  }

  async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    await super.webSocketError(socket, error);
    this.events.recordError();
  }

  async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    this.events.nativeEvents.push('close');
    await super.webSocketClose(socket, code, reason, wasClean);
  }

  async waitForError() {
    await this.events.errorReceived;

    return this.events.snapshot();
  }
}
