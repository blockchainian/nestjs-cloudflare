import type { INestApplicationContext } from '@nestjs/common';
import type {
  Deserializer,
  MsPattern,
  Serializer,
} from '@nestjs/microservices';

import type { CloudflareDurableObjectServer } from '../server.js';

/** Configures Nest packet serialization. */
export interface CloudflareDurableObjectServerOptions {
  serializer?: Serializer;
  deserializer?: Deserializer;
}

/** Selects the application's transport and native alarm event pattern. */
export interface CloudflareDurableObjectOptions {
  server: CloudflareDurableObjectServer;
  getApplication: () => Promise<INestApplicationContext>;
  alarmPattern?: MsPattern;
}
