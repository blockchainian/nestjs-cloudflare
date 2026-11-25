import {
  type CustomTransportStrategy,
  type MsPattern,
  type PacketId,
  type ReadPacket,
  Server,
  type WritePacket,
} from '@nestjs/microservices';
import { finalize, isObservable, lastValueFrom } from 'rxjs';

import { CLOUDFLARE_DURABLE_OBJECT_TRANSPORT } from './constants.js';
import { attachDurableObjectContext } from './context.js';
import { CloudflareDurableObjectContext } from './context.transport.js';
import type { CloudflareDurableObjectServerOptions } from './interfaces/server-options.interface.js';
import type { TransportControllerInitializer } from './transport-initialization.js';

type IncomingPacket = ReadPacket & Partial<PacketId>;

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
    initializeController?: TransportControllerInitializer,
  ): Promise<WritePacket[]> {
    const { packet, pattern, context } = await this.prepare(
      this.deserializer.deserialize(raw),
      state,
      env,
      initializeController,
    );

    const handler = this.getHandlerByPattern(pattern);

    if (!handler) {
      return [{ err: `No handler for pattern: ${pattern}`, isDisposed: true }];
    }

    const id = packet.id;

    if (id === undefined) {
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
                replies.push(await this.serializer.serialize({ ...reply, id }));

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
    initializeController?: TransportControllerInitializer,
  ): Promise<void> {
    const { pattern: normalized, context } = await this.prepare(
      { pattern, data: undefined },
      state,
      env,
      initializeController,
    );

    await this.handleEvent(normalized, { pattern, data: undefined }, context);
  }

  private async prepare(
    incoming: IncomingPacket | Promise<IncomingPacket>,
    state: DurableObjectState,
    env: unknown,
    initializeController?: TransportControllerInitializer,
  ) {
    const packet = await incoming;
    const pattern = this.normalizePattern(packet.pattern);
    const context = new CloudflareDurableObjectContext([state, env, pattern]);

    attachDurableObjectContext(context, state);
    await initializeController?.(pattern);

    return { packet, pattern, context };
  }
}
