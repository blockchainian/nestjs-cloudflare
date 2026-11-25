import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { buildSync } from 'esbuild';
import { builtinModules } from 'node:module';
import { defineConfig, defineProject } from 'vitest/config';
import { resolve } from 'node:path';

import { handleRawWebSocket } from './test/websockets/raw-socket.js';

const manualQueueConsumer = buildSync({
  entryPoints: ['test/fixtures/manual-queue-consumer.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  external: [
    ...builtinModules,
    'node:*',
    'cloudflare:*',
    'class-validator',
    'class-transformer',
    '@nestjs/platform-socket.io',
    'kafkajs',
    'mqtt',
    '@nats-io/transport-node',
    'ioredis',
    'amqplib',
    'amqp-connection-manager',
    '@grpc/grpc-js',
  ],
}).outputFiles[0].text;

const workerd = defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './test/wrangler.jsonc' },
      miniflare: {
        ...(process.env.NCF_MANUAL_CLOSE === '1'
          ? {
              compatibilityFlags: [
                'nodejs_compat',
                'web_socket_manual_reply_to_close',
              ],
            }
          : {}),
        unsafeDirectSockets: [{ host: '127.0.0.1', port: 0 }],
        serviceBindings: {
          RPC_SERVICE: 'rpc-service',
          RAW_WEBSOCKET: handleRawWebSocket,
        },
        queueProducers: { MANUAL_OUTBOX: { queueName: 'manual-retry' } },
        workers: [
          {
            name: 'manual-queue-consumer',
            modules: true,
            script: manualQueueConsumer,
            kvNamespaces: { STATE: 'test-state' },
            queueConsumers: {
              'manual-retry': { maxBatchTimeout: 0, retryDelay: 0 },
            },
            compatibilityDate: '2026-08-22',
            compatibilityFlags: ['nodejs_compat'],
          },
          {
            name: 'rpc-service',
            modules: true,
            scriptPath: resolve('test/fixtures/rpc-service.js'),
            durableObjects: { OBJECTS: 'NativeRpcRoom' },
            compatibilityDate: '2026-08-22',
            compatibilityFlags: ['nodejs_compat'],
          },
          {
            name: 'queue-sink',
            modules: true,
            scriptPath: resolve('test/fixtures/queue-sink.js'),
            kvNamespaces: { STATE: 'test-state' },
            queueConsumers: { outbox: { maxBatchTimeout: 0 } },
          },
        ],
      },
    }),
  ],
  oxc: {
    decorator: {
      legacy: true,
      emitDecoratorMetadata: true,
    },
    assumptions: {
      setPublicClassFields: true,
    },
    typescript: {
      removeClassFieldsWithoutInitializer: true,
    },
  },
  test: {
    name: 'workerd',
    include: ['test/**/*.spec.ts'],
    exclude: ['test/**/*.node.spec.ts'],
    provide: { manualClose: process.env.NCF_MANUAL_CLOSE === '1' },
    setupFiles: ['reflect-metadata'],
  },
});

export default defineConfig({
  test: {
    projects: [
      workerd,
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/**/*.node.spec.ts'],
        },
      },
    ],
  },
});
