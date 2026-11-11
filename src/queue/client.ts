import {
  ClientProxy,
  type ReadPacket,
  type WritePacket,
} from '@nestjs/microservices';

import type { CloudflareQueueClientOptions } from './interfaces/client-options.interface.js';

/**
 * Publishes Nest event packets through a Cloudflare Queue binding.
 *
 * @publicApi
 */
export class CloudflareQueueClient extends ClientProxy {
  constructor(private readonly options: CloudflareQueueClientOptions) {
    super();
    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  /** Returns the Queue binding without opening a broker connection. */
  public async connect(): Promise<Queue> {
    return this.options.queue;
  }

  /** Releases no resources because Workers owns the Queue binding. */
  public close(): void {}

  /** Returns the underlying Queue binding. */
  public unwrap<T>(): T {
    return this.options.queue as T;
  }

  protected publish(
    _packet: ReadPacket,
    callback: (packet: WritePacket) => void,
  ): () => void {
    callback({
      err: new Error(
        'Cloudflare Queues supports emit(), not request-response send()',
      ),
    });

    return () => {};
  }

  protected async dispatchEvent<T>(packet: ReadPacket): Promise<T> {
    const pattern = this.normalizePattern(packet.pattern);

    await this.options.queue.send(
      await this.serializer.serialize({ ...packet, pattern }),
    );

    return undefined as T;
  }
}
