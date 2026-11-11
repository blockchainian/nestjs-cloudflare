import type { Deserializer, Serializer } from '@nestjs/microservices';

/**
 * Configures a Queue client registered through Nest ClientsModule.
 *
 * @publicApi
 */
export interface CloudflareQueueClientOptions {
  /** Queue binding used to publish Nest event packets. */
  queue: Queue;

  /** Converts outgoing packets into Queue message bodies. */
  serializer?: Serializer;

  /** Configures the Nest client deserialization extension point. */
  deserializer?: Deserializer;
}
