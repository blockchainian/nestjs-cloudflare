import type { ReadPacket, WritePacket } from '@nestjs/microservices';
import { DurableObject } from 'cloudflare:workers';

import { CloudflareRequestContext } from '../worker/request-context.js';
import type { CloudflareDurableObjectOptions } from './interfaces/server-options.interface.js';

/** Hosts a Nest microservice transport inside a native Durable Object. */
export abstract class CloudflareDurableObject<
  Env = Cloudflare.Env,
> extends DurableObject<Env> {
  constructor(
    state: DurableObjectState,
    env: Env,
    private readonly options: CloudflareDurableObjectOptions,
  ) {
    super(state, env);
  }

  public async dispatch(packet: ReadPacket): Promise<WritePacket[]> {
    return this.run(() =>
      this.options.server.dispatch(packet, this.ctx, this.env),
    );
  }

  public async alarm(): Promise<void> {
    await this.run(() =>
      this.options.server.dispatchAlarm(
        this.options.alarmPattern ?? 'alarm',
        this.ctx,
        this.env,
      ),
    );
  }

  private async run<T>(callback: () => Promise<T>): Promise<T> {
    const app = await this.options.getApplication();
    const context = app.get(CloudflareRequestContext);

    return context.run({ env: this.env, ctx: this.ctx }, callback);
  }
}
