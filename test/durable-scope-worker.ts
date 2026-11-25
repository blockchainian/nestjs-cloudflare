import 'reflect-metadata';

import {
  type INestApplication,
  Inject,
  Injectable,
  Scope,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { DurableObject, env } from 'cloudflare:workers';

import { resolveForDurableObject } from '../src/index.js';
import {
  CloudflareWebSocketAdapter,
  CloudflareWebSocketDurableObject,
  CloudflareWebSocketGatewayDurableObject,
} from '../src/websockets/index.js';

@Injectable()
class SharedService {
  readonly id = crypto.randomUUID();
}

class UpstreamClient {
  readonly id = crypto.randomUUID();
  private socket?: WebSocket;

  async echo(value: string) {
    if (!this.socket) {
      const namespace = env.UPSTREAM as DurableObjectNamespace<UpstreamRoom>;

      const response = await namespace
        .getByName(this.id)
        .fetch('https://upstream.test', {
          headers: { Upgrade: 'websocket' },
        });

      if (!response.webSocket) {
        throw new Error('Upstream did not upgrade');
      }

      this.socket = response.webSocket;
      this.socket.accept();
    }

    const socket = this.socket;

    const reply = new Promise<string>(resolve => {
      socket.addEventListener('message', event => resolve(String(event.data)), {
        once: true,
      });
    });

    socket.send(value);

    return reply;
  }
}

@Injectable({ scope: Scope.REQUEST, durable: true })
class DurableClient extends UpstreamClient {
  constructor(
    readonly shared: SharedService,
    @Inject(REQUEST) private readonly owner: { durableObjectId: string },
  ) {
    super();
  }

  async read(value: string) {
    return {
      provider: this.id,
      owner: this.owner.durableObjectId,
      singleton: this.shared.id,
      echo: await this.echo(value),
    };
  }
}

@Injectable({ scope: Scope.REQUEST })
class EventService {
  readonly id = crypto.randomUUID();
}

@Injectable()
class UnsafeClient extends UpstreamClient {}

@WebSocketGateway({ path: '/scope' })
class ScopedGateway {
  constructor(private readonly client: DurableClient) {}

  @SubscribeMessage('read')
  read(@MessageBody() value: string) {
    return this.client.read(value);
  }
}

const adapter = new CloudflareWebSocketAdapter();
let application: Promise<INestApplication> | undefined;

function getApplication() {
  return (application ??= (async () => {
    const module = await Test.createTestingModule({
      providers: [
        SharedService,
        DurableClient,
        UnsafeClient,
        ScopedGateway,
        EventService,
      ],
    }).compile();

    const app = module.createNestApplication({ logger: false });

    app.useWebSocketAdapter(adapter);
    await app.init();

    return app;
  })());
}

export class NativeScopeRoom extends DurableObject {
  async read(value: string) {
    const app = await getApplication();
    const client = await resolveForDurableObject(app, this.ctx, DurableClient);

    return client.read(value);
  }

  async eventId() {
    return (
      await resolveForDurableObject(
        await getApplication(),
        this.ctx,
        EventService,
      )
    ).id;
  }

  async unsafe(value: string) {
    try {
      return await (await getApplication()).get(UnsafeClient).echo(value);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async fetch() {
    return Response.json(await this.read('fetch'));
  }

  async alarm() {
    await this.ctx.storage.put('alarm', await this.read('alarm'));
  }
}

export class HibernatingScopeRoom extends CloudflareWebSocketDurableObject {
  constructor(ctx: DurableObjectState, bindings: Cloudflare.Env) {
    super(ctx, bindings, { adapter, path: '/scope', getApplication });
  }

  async read(value: string) {
    return (await this.resolve(DurableClient)).read(value);
  }

  async alarm() {
    await this.ctx.storage.put('alarm', await this.read('alarm'));
  }

  async fetch(request: Request): Promise<Response> {
    if (!request.headers.has('Upgrade')) {
      return Response.json(await this.read('fetch'));
    }

    return super.fetch(request);
  }
}

export class ActiveScopeRoom extends CloudflareWebSocketGatewayDurableObject {
  constructor(ctx: DurableObjectState, bindings: Cloudflare.Env) {
    super(ctx, bindings, { adapter, paths: ['/scope'], getApplication });
  }

  async read(value: string) {
    return (await this.resolve(DurableClient)).read(value);
  }

  async alarm() {
    await this.ctx.storage.put('alarm', await this.read('alarm'));
  }

  protected async nonWebSocketFetch(): Promise<Response> {
    return Response.json(await this.read('fetch'));
  }
}

export class UpstreamRoom extends DurableObject {
  fetch() {
    const pair = new WebSocketPair();

    pair[1].accept();
    pair[1].addEventListener('message', event => pair[1].send(event.data));

    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}
