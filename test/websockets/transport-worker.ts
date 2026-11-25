import { Controller, Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
  Ctx,
  EventPattern,
  MessagePattern,
  Payload,
} from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import {
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';

import {
  CloudflareDurableObjectContext,
  CloudflareDurableObjectServer,
} from '../../src/durable-objects/index.js';
import { CloudflareModule, CloudflareRequestContext } from '../../src/index.js';
import {
  CloudflareWebSocketAdapter,
  CloudflareWebSocketDurableObject,
  CloudflareWebSocketGatewayDurableObject,
} from '../../src/websockets/index.js';

@Injectable({ scope: Scope.REQUEST, durable: true })
class RoomSockets {
  readonly id = crypto.randomUUID();
  readonly sockets = new Set<WebSocket>();

  constructor(
    @Inject(REQUEST) private readonly owner: { ctx: DurableObjectState },
  ) {}

  push(data: string) {
    const sockets = new Set([
      ...this.sockets,
      ...this.owner.ctx.getWebSockets(),
    ]);

    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ data, provider: this.id }));
      }
    }

    return { count: sockets.size, provider: this.id };
  }
}

@WebSocketGateway({ path: '/events' })
class EventsGateway {
  constructor(private readonly room: RoomSockets) {}

  @SubscribeMessage('join')
  join(@ConnectedSocket() socket: WebSocket) {
    this.room.sockets.add(socket);

    return { provider: this.room.id };
  }
}

@Controller()
class RoomController {
  constructor(
    private readonly room: RoomSockets,
    private readonly request: CloudflareRequestContext,
  ) {}

  @MessagePattern('push')
  push(@Payload() data: string) {
    return this.room.push(data);
  }

  @EventPattern('room-alarm')
  async alarm(@Ctx() context: CloudflareDurableObjectContext) {
    this.request
      .getExecutionContext()
      .waitUntil(context.getState().storage.put('background', true));

    await context.getState().storage.put('alarm', {
      provider: this.room.id,
      pattern: context.getPattern(),
      sameEnv: this.request.getEnv() === context.getEnv(),
      sameState: this.request.getExecutionContext() === context.getState(),
      noRequest: this.request.getRequest() === undefined,
    });
  }
}

const adapter = new CloudflareWebSocketAdapter();
const server = new CloudflareDurableObjectServer();
let application: ReturnType<typeof bootstrap> | undefined;

async function bootstrap() {
  const module = await Test.createTestingModule({
    imports: [CloudflareModule.forRoot()],
    providers: [RoomSockets, EventsGateway],
    controllers: [RoomController],
  }).compile();

  const app = module.createNestApplication({ logger: false });

  app.useWebSocketAdapter(adapter);
  app.connectMicroservice({ strategy: server });
  await app.init();
  await app.startAllMicroservices();

  return app;
}

function options() {
  return {
    adapter,
    getApplication: () => (application ??= bootstrap()),
    transport: { server, alarmPattern: 'room-alarm' },
  };
}

export class ActiveTransportRoom extends CloudflareWebSocketGatewayDurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env, { ...options(), paths: ['/events'] });
  }
}

export class HibernatingTransportRoom extends CloudflareWebSocketDurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env, { ...options(), path: '/events' });
  }
}
