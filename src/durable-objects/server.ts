import {
  type CustomTransportStrategy,
  type MsPattern,
  type ReadPacket,
  Server,
  type WritePacket,
} from '@nestjs/microservices';
import { finalize, isObservable, lastValueFrom } from 'rxjs';

import { CLOUDFLARE_DURABLE_OBJECT_TRANSPORT } from './constants.js';
import { attachDurableObjectContext } from './context.js';
import { CloudflareDurableObjectContext } from './context.transport.js';
import type { CloudflareDurableObjectServerOptions } from './interfaces/server-options.interface.js';

/** Dispatches native object messages through Nest microservice handlers. */
export class CloudflareDurableObjectServer
  extends Server
  implements CustomTransportStrategy
{
  public override readonly propagatesEventHandlerErrors = true;
  public override transportId = CLOUDFLARE_DURABLE_OBJECT_TRANSPORT;

  constructor(options: CloudflareDurableObjectServerOptions = {}) {
    super();
    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  public listen(callback: () => void): void {
    callback();
  }

  public close(): void {}

  public on(): never {
    throw new Error('Durable Object transport has no connection events');
  }

  public unwrap<T>(): T {
    return this as unknown as T;
  }

  public async dispatch(
    raw: ReadPacket,
    state: DurableObjectState,
    env: unknown,
  ): Promise<WritePacket[]> {
    const packet = await this.deserializer.deserialize(raw);
    const pattern = this.normalizePattern(packet.pattern);
    const context = new CloudflareDurableObjectContext([state, env, pattern]);

    attachDurableObjectContext(context, state);
    const handler = this.getHandlerByPattern(pattern);

    if (!handler) {
      return [{ err: `No handler for pattern: ${pattern}`, isDisposed: true }];
    }

    if (!('id' in packet) || packet.id === undefined) {
      try {
        await this.handleEvent(pattern, packet, context);

        return [];
      } catch (err) {
        return [
          await this.serializer.serialize({
            err,
            isDisposed: true,
            id: '',
          }),
        ];
      }
    }

    this.warnIfEventHandlerReplies(handler, pattern);

    return new Promise<WritePacket[]>((resolve, reject) => {
      const replies: WritePacket[] = [];

      this.runWithProcessingHooks(context, async end => {
        try {
          const result = await handler(packet.data, context);

          this.send(
            this.transformToObservable(result).pipe(finalize(end)),
            async reply => {
              try {
                replies.push(
                  await this.serializer.serialize({ ...reply, id: packet.id }),
                );

                if (reply.isDisposed) {
                  resolve(replies);
                }
              } catch (error) {
                reject(error);
              }
            },
          );
        } catch (error) {
          end();
          reject(error);
        }
      });
    });
  }

  public override async handleEvent(
    pattern: string,
    packet: ReadPacket,
    context: CloudflareDurableObjectContext<unknown>,
  ): Promise<void> {
    const handler = this.getHandlerByPattern(pattern);

    if (!handler?.isEventHandler) {
      throw new Error(`No EventPattern handler for pattern: ${pattern}`);
    }

    await this.runWithProcessingHooks(context, async end => {
      const result = await handler(packet.data, context);

      if (isObservable(result)) {
        await lastValueFrom(result.pipe(finalize(end)), {
          defaultValue: undefined,
        });
      } else {
        end();
      }
    });
  }

  public async dispatchAlarm(
    pattern: MsPattern,
    state: DurableObjectState,
    env: unknown,
  ): Promise<void> {
    const normalized = this.normalizePattern(pattern);

    const context = new CloudflareDurableObjectContext([
      state,
      env,
      normalized,
    ]);

    attachDurableObjectContext(context, state);
    await this.handleEvent(normalized, { pattern, data: undefined }, context);
  }
}
