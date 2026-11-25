import 'reflect-metadata';

import {
  type CanActivate,
  type ExecutionContext as NestExecutionContext,
  type INestApplication,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WsException,
} from '@nestjs/websockets';
import { of } from 'rxjs';

import {
  CloudflareWebSocketAdapter,
  CloudflareWebSocketDurableObject,
  CloudflareWebSocketGatewayDurableObject,
  getCloudflareWebSocketContext,
  InvalidWebSocketMessageException,
} from '../src/websockets/index.js';

@Injectable()
class AuthenticationState {
  private readonly authenticated = new WeakSet<WebSocket>();
  private releaseAuthentication?: () => void;

  public async authenticate(socket: WebSocket): Promise<void> {
    const completion = new Promise<void>(resolve => {
      this.releaseAuthentication = resolve;
    });

    socket.send(JSON.stringify({ event: 'authentication-started' }));
    await completion;
    this.authenticated.add(socket);
  }

  public isAuthenticated(socket: WebSocket): boolean {
    return this.authenticated.has(socket);
  }

  public release(): void {
    this.releaseAuthentication?.();
  }
}

export { TransportRoom } from './durable-objects/transport-worker.js';
export { MultiGatewayRoom } from './websockets/multi-path-worker.js';
export { ActiveTransportRoom } from './websockets/transport-worker.js';
export { HibernatingTransportRoom } from './websockets/transport-worker.js';

@Injectable()
class EchoService extends AuthenticationState {
  public disconnects = 0;

  public reply(value: string): string {
    return `Nest:${value}`;
  }
}

@Injectable()
class MessageGuard implements CanActivate {
  public canActivate(context: NestExecutionContext): boolean {
    return context.switchToWs().getData() !== 'denied';
  }
}

@WebSocketGateway({ path: '/chat' })
class EchoGateway {
  constructor(private readonly echo: EchoService) {}

  @SubscribeMessage('authenticate')
  public async authenticate(@ConnectedSocket() socket: WebSocket) {
    await this.echo.authenticate(socket);

    return { event: 'authenticated' };
  }

  @SubscribeMessage('subscribe')
  public subscribe(@ConnectedSocket() socket: WebSocket) {
    return {
      event: 'subscribed',
      authenticated: this.echo.isAuthenticated(socket),
    };
  }

  @UseGuards(MessageGuard)
  @SubscribeMessage('echo')
  public echoMessage(@MessageBody() value: string) {
    return { event: 'reply', data: this.echo.reply(value) };
  }

  @SubscribeMessage('stream')
  public stream() {
    return of({ event: 'item', data: 1 }, { event: 'item', data: 2 });
  }

  @SubscribeMessage('state')
  public state(@ConnectedSocket() socket: WebSocket) {
    return { event: 'state', data: socket.deserializeAttachment() as unknown };
  }

  @SubscribeMessage('failure')
  public failure() {
    throw new WsException('Rejected by Nest');
  }

  public handleDisconnect() {
    this.echo.disconnects++;
  }
}

async function bootstrap(adapter: CloudflareWebSocketAdapter) {
  const module = await Test.createTestingModule({
    providers: [EchoGateway, EchoService, MessageGuard],
  }).compile();

  const app = module.createNestApplication();

  app.useLogger(false);
  app.useWebSocketAdapter(adapter);
  await app.init();

  return app;
}

export class SocketRoom extends CloudflareWebSocketDurableObject {
  private readonly application: Promise<INestApplication>;

  constructor(ctx: DurableObjectState, bindings: Cloudflare.Env) {
    const adapter = new CloudflareWebSocketAdapter({
      maxConcurrentMessages: ctx.id.name?.startsWith('serial-') ? 1 : undefined,
    });

    let application: Promise<INestApplication> | undefined;

    const getApplication = () =>
      (application ??= (async () => {
        const activation =
          ((await ctx.storage.get<number>('activations')) ?? 0) + 1;

        await ctx.storage.put('activations', activation);

        for (const socket of ctx.getWebSockets()) {
          socket.serializeAttachment({ activation });
        }

        return bootstrap(adapter);
      })());

    super(ctx, bindings, { adapter, path: '/chat', getApplication });
    this.application = getApplication();
  }

  public async fetch(request: Request): Promise<Response> {
    const response = await super.fetch(request);
    const activation = await this.ctx.storage.get<number>('activations');

    for (const socket of this.ctx.getWebSockets()) {
      socket.serializeAttachment({ activation });
    }

    return response;
  }

  public async release(): Promise<void> {
    (await this.application).get(EchoService).release();
  }

  public async disconnections(): Promise<number> {
    return (await this.application).get(EchoService).disconnects;
  }
}

export class ParserRoom extends CloudflareWebSocketDurableObject {
  constructor(ctx: DurableObjectState, bindings: Cloudflare.Env) {
    const adapter = new CloudflareWebSocketAdapter({
      messageParser(frame) {
        const text =
          typeof frame === 'string' ? frame : new TextDecoder().decode(frame);

        if (text === 'skip') {
          return;
        }

        if (text === 'explode') {
          throw new Error('Application parser failed');
        }

        const separator = text.indexOf(':');

        if (separator < 0) {
          throw new InvalidWebSocketMessageException('Expected event:payload');
        }

        return {
          event: text.slice(0, separator),
          data: text.slice(separator + 1),
        };
      },
    });

    super(ctx, bindings, {
      adapter,
      path: '/chat',
      getApplication: () => bootstrap(adapter),
    });
  }
}

@WebSocketGateway({ path: '/ws' })
class MultiPathGateway {
  constructor(private readonly authentication: AuthenticationState) {}

  @SubscribeMessage('authenticate')
  public async authenticate(@ConnectedSocket() socket: WebSocket) {
    await this.authentication.authenticate(socket);

    return { event: 'authenticated' };
  }

  @SubscribeMessage('subscribe')
  public subscribe(@ConnectedSocket() socket: WebSocket) {
    return {
      event: 'subscribed',
      authenticated: this.authentication.isAuthenticated(socket),
    };
  }

  @SubscribeMessage('broadcast')
  public broadcast(
    @ConnectedSocket() socket: WebSocket,
    @MessageBody() value: string,
  ) {
    const context = getCloudflareWebSocketContext(socket);

    for (const peer of context.sockets) {
      peer.send(`frame:${value}:${context.ctx.id.toString()}`);
    }

    return null;
  }

  @SubscribeMessage('state')
  public state(@ConnectedSocket() socket: WebSocket) {
    const context = getCloudflareWebSocketContext(socket);

    return { event: 'state', data: context.storage === context.ctx.storage };
  }
}

async function bootstrapMultiPath(adapter: CloudflareWebSocketAdapter) {
  const module = await Test.createTestingModule({
    providers: [MultiPathGateway, AuthenticationState],
  }).compile();

  const app = module.createNestApplication();

  app.useLogger(false);
  app.useWebSocketAdapter(adapter);
  await app.init();

  return app;
}

export class GatewayRoom extends CloudflareWebSocketGatewayDurableObject {
  private readonly application: Promise<INestApplication>;

  public async release(): Promise<void> {
    (await this.application).get(AuthenticationState).release();
  }

  constructor(ctx: DurableObjectState, bindings: Cloudflare.Env) {
    const adapter = new CloudflareWebSocketAdapter({
      maxConcurrentMessages: ctx.id.name?.startsWith('serial-') ? 1 : undefined,
      messageSerializer: value =>
        new TextEncoder().encode(JSON.stringify(value)).buffer,
    });

    const application = bootstrapMultiPath(adapter);

    super(ctx, bindings, {
      adapter,
      paths: ['/ws', '/mobula'],
      getApplication: () => application,
    });

    this.application = application;
  }

  protected nonWebSocketFetch(request: Request): Response {
    return new Response(`custom:${new URL(request.url).pathname}`);
  }
}

export default {
  fetch() {
    return new Response('WebSocket test worker');
  },
};

export {
  ActiveScopeRoom,
  HibernatingScopeRoom,
  NativeScopeRoom,
  UpstreamRoom,
} from './durable-scope-worker.js';
