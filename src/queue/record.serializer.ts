import type { ReadPacket, Serializer } from '@nestjs/microservices';

import { CloudflareQueueRecord } from './record-builder.js';

/** Unwraps transport records while preserving Nest packet metadata. */
export class CloudflareQueueRecordSerializer implements Serializer {
  public serialize(packet: ReadPacket) {
    if (packet.data instanceof CloudflareQueueRecord) {
      return {
        ...packet,
        data: packet.data.data,
        options: packet.data.options,
      };
    }

    return packet;
  }
}
