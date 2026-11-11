import type { Deserializer, Serializer } from '@nestjs/microservices';

/**
 * Configures queue acknowledgement and batch processing.
 *
 * @publicApi
 */
export interface CloudflareQueueServerOptions {
  /** Acknowledges successful messages automatically unless false. */
  noAck?: boolean;

  /** Processes messages sequentially unless parallel is selected. */
  concurrency?: 'sequential' | 'parallel';

  /** Configures the Nest server serialization extension point. */
  serializer?: Serializer;

  /** Converts Queue message bodies into Nest event packets. */
  deserializer?: Deserializer;
}
