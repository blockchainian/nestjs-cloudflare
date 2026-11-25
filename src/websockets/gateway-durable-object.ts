import type { InjectionToken } from '@nestjs/common';

import {
  attachDurableObjectContext,
  resolveForDurableObject,
} from '../durable-objects/context.js';
import { CloudflareDurableObjectHost } from '../durable-objects/host.js';
import type { CloudflareWebSocketContext } from './context.js';
import type { CloudflareWebSocketGatewayOptions } from './interfaces/gateway-options.interface.js';
import { InvalidWebSocketMessageException } from './invalid-message.exception.js';

/** Hosts Nest gateways with the non-hibernating WebSocket API. */
export abstract class CloudflareWebSocketGatewayDurableObject<
  Env = Cloudflare.Env,
> extends CloudflareDurableObjectHost<Env> {
  private readonly ready: Promise<void>;
  private readonly sockets = new Set<WebSocket>();
  private readonly options: CloudflareWebSocketGatewayOptions;

  protected constructor(
    ctx: DurableObjectState,
    env: Env,
    options: CloudflareWebSocketGatewayOptions,
  ) {
    super(ctx, env, options);
    this.options = options;

    for (const path of options.paths) {
      if (!path.startsWith('/')) {
        throw new Error(`WebSocket gateway path must start with /: ${path}`);
      }
    }

    this.ready = options.getApplication().then(() => {
      const firstPath = options.paths[0];

      if (firstPath) {
        for (const path of options.paths.slice(1)) {
          options.adapter.registerPathAlias(path, firstPath);
        }
      }
    });
  }

  /** Resolves object-owned providers from fetch, alarm, and RPC handlers. */
  protected async resolve<T>(token: InjectionToken<T>): Promise<T> {
    return resolveForDurableObject(
      await this.options.getApplication(),
      this.ctx,
      token,
    );
  }

  /** Accepts a matching upgrade with server.accept(). */
  public async fetch(request: Request): Promise<Response> {
    await this.ready;

    const path = new URL(request.url).pathname;

    const isUpgrade =
      request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

    if (!isUpgrade) {
      return this.nonWebSocketFetch(request);
    }

    if (request.method !== 'GET' || !this.options.paths.includes(path)) {
      return new Response('Not found', { status: 404 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    server.accept();

    const context: CloudflareWebSocketContext<Env, this> = {
      ctx: this.ctx,
      env: this.env,
      object: this,
      storage: this.ctx.storage,
      sockets: this.sockets,
    };

    this.sockets.add(server);

    attachDurableObjectContext(server, this.ctx);
    this.options.adapter.connect(path, server, request, context);

    server.addEventListener('message', event => {
      void this.handleMessage(server, event.data);
    });

    server.addEventListener('close', event => {
      this.sockets.delete(server);
      this.options.adapter.disconnect(server, event.reason);
    });

    server.addEventListener('error', event => {
      this.sockets.delete(server);
      this.options.adapter.error(server, event);
      this.options.adapter.disconnect(server);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Handles requests that are not WebSocket upgrades. */
  protected nonWebSocketFetch(_request: Request): Response | Promise<Response> {
    return new Response('WebSocket upgrade required', { status: 426 });
  }

  private async handleMessage(
    socket: WebSocket,
    data: string | ArrayBuffer,
  ): Promise<void> {
    try {
      await this.options.adapter.message(socket, data);
    } catch (error) {
      if (error instanceof InvalidWebSocketMessageException) {
        socket.close(1007, error.message);

        return;
      }

      this.options.adapter.error(socket, error);
    }
  }
}
