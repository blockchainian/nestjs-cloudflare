import type { InjectionToken } from '@nestjs/common';
import { DurableObject } from 'cloudflare:workers';

import {
  attachDurableObjectContext,
  resolveForDurableObject,
} from '../durable-objects/context.js';
import type { CloudflareWebSocketDurableObjectOptions } from './interfaces/durable-object-options.interface.js';
import { InvalidWebSocketMessageException } from './invalid-message.exception.js';

/**
 * Hosts a Nest gateway using the Durable Object WebSocket Hibernation API.
 *
 * @publicApi
 */
export abstract class CloudflareWebSocketDurableObject<
  Env = Cloudflare.Env,
> extends DurableObject<Env> {
  private readonly ready: Promise<void>;
  private readonly tag: string;

  constructor(
    ctx: DurableObjectState,
    env: Env,
    private readonly options: CloudflareWebSocketDurableObjectOptions,
  ) {
    super(ctx, env);
    const tag = `nestjs:${options.path}`;

    this.tag = tag;

    this.ready = (async () => {
      await options.getApplication();

      for (const socket of ctx.getWebSockets(tag)) {
        attachDurableObjectContext(socket, ctx);
        options.adapter.connect(options.path, socket);
      }
    })();
  }

  /** Resolves object-owned providers from fetch, alarm, and RPC handlers. */
  protected async resolve<T>(token: InjectionToken<T>): Promise<T> {
    return resolveForDurableObject(
      await this.options.getApplication(),
      this.ctx,
      token,
    );
  }

  /** Accepts upgrades and registers connections for hibernation. */
  public async fetch(request: Request): Promise<Response> {
    await this.ready;

    if (new URL(request.url).pathname !== this.options.path) {
      return new Response('Not found', { status: 404 });
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 });
    }

    const pair = new WebSocketPair();

    this.ctx.acceptWebSocket(pair[1], [this.tag]);
    attachDurableObjectContext(pair[1], this.ctx);
    this.options.adapter.connect(this.options.path, pair[1], request);

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Waits for Nest startup and gateway message handling. */
  public async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    await this.ready;

    try {
      await this.options.adapter.message(socket, message);
    } catch (error) {
      if (error instanceof InvalidWebSocketMessageException) {
        socket.close(1007, error.message);

        return;
      }

      this.options.adapter.error(socket, error);
    }
  }

  /** Completes the close handshake and dispatches disconnection hooks. */
  public async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    await this.ready;

    try {
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CLOSING
      ) {
        socket.close(code === 1005 || code === 1006 ? 1000 : code, reason);
      }
    } finally {
      this.options.adapter.disconnect(socket, reason);
    }
  }

  /** Reports native socket errors through the Nest adapter. */
  public async webSocketError(
    socket: WebSocket,
    error: unknown,
  ): Promise<void> {
    await this.ready;
    this.options.adapter.error(socket, error);
  }
}
