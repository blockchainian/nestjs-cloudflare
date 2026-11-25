import type { Deserializer, Serializer } from '@nestjs/microservices';

/** Configures a Durable Object client registered through ClientsModule. */
export interface CloudflareDurableObjectClientOptions {
  namespace: DurableObjectNamespace;
  serializer?: Serializer;
  deserializer?: Deserializer;
}

/** Selects one object for an outgoing message. IDs use their string representation. */
export type CloudflareDurableObjectRecordOptions =
  { name: string; id?: never } | { id: string; name?: never };
