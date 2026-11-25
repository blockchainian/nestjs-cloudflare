import {
  ClientProxy,
  type ReadPacket,
  type WritePacket,
} from '@nestjs/microservices';

import { getQueueBinding } from '../bindings/validate-binding.js';
import type { CloudflareQueueClientOptions } from './interfaces/client-options.interface.js';
import { CloudflareQueueRecordSerializer } from './record.serializer.js';

/**
 * Publishes Nest event packets through a Cloudflare Queue binding.
 *
 * @publicApi
 */
export class CloudflareQueueClient extends ClientProxy {
  constructor(private readonly options: CloudflareQueueClientOptions) {
    super();

    this.initializeSerializer({
      ...options,
      serializer: options.serializer ?? new CloudflareQueueRecordSerializer(),
    });

    this.initializeDeserializer(options);
  }

  /** Returns the Queue binding without opening a broker connection. */
  public async connect(): Promise<Queue> {
    return this.unwrap<Queue>();
  }

  /** Releases no resources because Workers owns the Queue binding. */
  public close(): void {}

  /** Returns the underlying Queue binding. */
  public unwrap<T>(): T {
    return getQueueBinding(this.options.queue) as T;
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

    const { options, ...body } = await this.serializer.serialize({
      ...packet,
      pattern,
    });

    await this.options.queue.send(body, options);

    return undefined as T;
  }
}
