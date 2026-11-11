import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { DurableObject } from 'cloudflare:workers';

import { createWorker } from '../src/index.js';
import { CloudflareQueueServer } from '../src/queue/index.js';
import { AppModule } from './app.module.js';
import type { Env } from './env.interface.js';
import { GreetingService } from './greeting.service.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.connectMicroservice(
    { strategy: new CloudflareQueueServer() },
    { inheritAppConfig: true },
  );

  return app;
}

const worker = createWorker(bootstrap);

/**
 * Exposes a Nest service through a native Durable Object.
 */
export class Greeter extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    const app = await worker.getApplication();

    return new Response(app.get(GreetingService).greet());
  }
}

export default worker;
