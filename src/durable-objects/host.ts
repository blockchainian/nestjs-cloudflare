import type { INestApplicationContext } from '@nestjs/common';
import type { ReadPacket, WritePacket } from '@nestjs/microservices';
import { DurableObject } from 'cloudflare:workers';

import { CloudflareRequestContext } from '../worker/request-context.js';
import type { CloudflareDurableObjectOptions } from './interfaces/server-options.interface.js';
import {
  createTransportControllerInitializer,
  type TransportControllerInitializer,
} from './transport-initialization.js';

interface HostOptions {
  getApplication: () => Promise<INestApplicationContext>;
  transport?: Omit<CloudflareDurableObjectOptions, 'getApplication'>;
}

/** Shares native RPC and alarm dispatch across Durable Object hosts. */
export abstract class CloudflareDurableObjectHost<
  Env = Cloudflare.Env,
> extends DurableObject<Env> {
  private transportApplication: Promise<INestApplicationContext> | undefined;
  private initializeController: TransportControllerInitializer | undefined;

  constructor(
    state: DurableObjectState,
    env: Env,
    private readonly hostOptions: HostOptions,
  ) {
    super(state, env);
  }

  public async dispatch(packet: ReadPacket): Promise<WritePacket[]> {
    const transport = this.hostOptions.transport;

    if (!transport) {
      throw new Error('Durable Object transport is not configured');
    }

    return this.run(() =>
      transport.server.dispatch(
        packet,
        this.ctx,
        this.env,
        this.initializeController,
      ),
    );
  }

  public async alarm(): Promise<void> {
    const transport = this.hostOptions.transport;

    if (!transport) {
      return;
    }

    await this.run(() =>
      transport.server.dispatchAlarm(
        transport.alarmPattern ?? 'alarm',
        this.ctx,
        this.env,
        this.initializeController,
      ),
    );
  }

  private async initialize(): Promise<INestApplicationContext> {
    const app = await this.hostOptions.getApplication();
    const transport = this.hostOptions.transport;

    if (transport) {
      this.initializeController = createTransportControllerInitializer(
        app,
        transport.server,
        this.ctx,
      );
    }

    return app;
  }

  private async run<T>(callback: () => Promise<T>): Promise<T> {
    const app = await (this.transportApplication ??= this.initialize());
    const context = app.get(CloudflareRequestContext);

    return context.run({ env: this.env, ctx: this.ctx }, callback);
  }
}
