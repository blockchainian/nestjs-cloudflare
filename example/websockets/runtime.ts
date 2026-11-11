import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { createWorker } from '../../src/index.js';
import { CloudflareWebSocketAdapter } from '../../src/websockets/index.js';
import { AppModule } from './app.module.js';

export const adapter = new CloudflareWebSocketAdapter();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useWebSocketAdapter(adapter);

  return app;
}

export const worker = createWorker(bootstrap);
