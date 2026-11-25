import type { ReadPacket, Serializer } from '@nestjs/microservices';

import { CloudflareDurableObjectRecord } from './record-builder.js';

/** Removes native addressing options from the Nest message body. */
export class CloudflareDurableObjectRecordSerializer implements Serializer {
  public serialize(packet: ReadPacket) {
    const record = packet.data as unknown;

    return record instanceof CloudflareDurableObjectRecord
      ? { ...packet, data: record.data, options: record.options }
      : packet;
  }
}
