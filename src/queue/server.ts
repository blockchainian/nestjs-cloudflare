import {
  type CustomTransportStrategy,
  type ReadPacket,
  Server,
} from '@nestjs/microservices';
import { finalize, isObservable, lastValueFrom } from 'rxjs';

import { CLOUDFLARE_QUEUE_TRANSPORT } from './constants.js';
import { CloudflareQueueContext } from './context.js';
import type { CloudflareQueueServerOptions } from './interfaces/server-options.interface.js';

type WorkerExecutionContext = ExecutionContext;

/**
 * Delivers Cloudflare Queue packets through Nest event handlers.
 *
 * @publicApi
 */
export class CloudflareQueueServer
  extends Server
  implements CustomTransportStrategy
{
  public override readonly propagatesEventHandlerErrors = true;
  public override transportId = CLOUDFLARE_QUEUE_TRANSPORT;

  constructor(private readonly options: CloudflareQueueServerOptions = {}) {
    super();
    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  /** Signals that the event transport is ready. */
  public listen(callback: () => void): void {
    callback();
  }

  /** Releases no resources because Workers owns the queue connection. */
  public close(): void {}

  /** Rejects subscriptions to connection events, which Queues does not expose. */
  public on(): never {
    throw new Error('Queue transport has no connection events');
  }

  /** Returns this event transport for Worker dispatch. */
  public unwrap<T>(): T {
    return this as unknown as T;
  }

  /** Awaits handler streams so failures can trigger Queue retries. */
  public override async handleEvent(
    pattern: string,
    packet: ReadPacket,
    context: CloudflareQueueContext,
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

  /** Deserializes a batch and acknowledges successes or retries failed messages. */
  public async consume(
    batch: MessageBatch,
    ctx: WorkerExecutionContext,
    fallback?: () => void | Promise<void>,
  ): Promise<void> {
    const packets = await Promise.all(
      batch.messages.map(async message => {
        try {
          const packet = await this.deserializer.deserialize(message.body, {
            channel: batch.queue,
          });

          const pattern = this.normalizePattern(packet.pattern);

          return { message, packet, pattern };
        } catch (error) {
          return { message, error };
        }
      }),
    );

    if (
      fallback &&
      packets.every(
        item =>
          !('error' in item) &&
          !this.getHandlerByPattern(item.pattern)?.isEventHandler,
      )
    ) {
      await fallback();

      return;
    }

    const consumeMessage = async (
      item: (typeof packets)[number],
    ): Promise<void> => {
      try {
        if ('error' in item) {
          throw item.error;
        }

        const context = new CloudflareQueueContext([
          item.message,
          batch,
          ctx,
          item.pattern,
        ]);

        await this.handleEvent(item.pattern, item.packet, context);

        if (this.options.noAck !== false) {
          item.message.ack();
        }
      } catch (error) {
        this.logger.error(error);
        item.message.retry();
      }
    };

    if (this.options.concurrency === 'parallel') {
      await Promise.all(packets.map(consumeMessage));
    } else {
      for (const item of packets) {
        await consumeMessage(item);
      }
    }
  }
}
