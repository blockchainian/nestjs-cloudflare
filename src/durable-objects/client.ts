import {
  ClientProxy,
  type ReadPacket,
  type WritePacket,
} from '@nestjs/microservices';

import { getDurableObjectNamespace } from '../bindings/validate-binding.js';
import type { CloudflareDurableObjectClientOptions } from './interfaces/client-options.interface.js';
import { CloudflareDurableObjectRecordSerializer } from './record.serializer.js';

/** Publishes Nest packets through native Durable Object RPC. */
export class CloudflareDurableObjectClient extends ClientProxy {
  constructor(private readonly options: CloudflareDurableObjectClientOptions) {
    super();

    this.initializeSerializer({
      ...options,
      serializer:
        options.serializer ?? new CloudflareDurableObjectRecordSerializer(),
    });

    this.initializeDeserializer(options);
  }

  public async connect(): Promise<DurableObjectNamespace> {
    return this.unwrap<DurableObjectNamespace>();
  }

  public close(): void {}

  public unwrap<T>(): T {
    return getDurableObjectNamespace(this.options.namespace, 'namespace') as T;
  }

  protected publish(
    packet: ReadPacket,
    callback: (packet: WritePacket) => void,
  ): () => void {
    let active = true;

    void this.request(this.assignPacketId(packet))
      .then(async replies => {
        for (const reply of replies) {
          const response = await this.deserializer.deserialize(reply);

          if (active) {
            callback(response);
          }
        }
      })
      .catch((err: unknown) => {
        if (active) {
          callback({ err });
        }
      });

    return () => {
      active = false;
    };
  }

  protected async dispatchEvent<T>(packet: ReadPacket): Promise<T> {
    const replies = await this.request(packet);

    const packets = await Promise.all(
      replies.map(reply => this.deserializer.deserialize(reply)),
    );

    const failure = packets.find(reply => reply.err !== undefined);

    if (failure) {
      throw failure.err;
    }

    return undefined as T;
  }

  private async request(packet: ReadPacket): Promise<WritePacket[]> {
    const { options, ...message } = await this.serializer.serialize({
      ...packet,
      pattern: this.normalizePattern(packet.pattern),
    });

    if (
      !options ||
      (typeof options.name !== 'string' && typeof options.id !== 'string')
    ) {
      throw new Error(
        'Durable Object messages require a record with a name or ID',
      );
    }

    const namespace = this.options.namespace;

    const id =
      options.id === undefined
        ? namespace.idFromName(options.name)
        : namespace.idFromString(options.id);

    const stub = namespace.get(id) as unknown as {
      dispatch(packet: ReadPacket): Promise<WritePacket[]>;
    };

    return stub.dispatch(message);
  }
}
