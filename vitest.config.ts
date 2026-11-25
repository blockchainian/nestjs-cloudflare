import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { buildSync } from 'esbuild';
import { builtinModules } from 'node:module';
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

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

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './test/wrangler.jsonc' },
      miniflare: {
        serviceBindings: { RPC_SERVICE: 'rpc-service' },
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
    include: ['test/**/*.spec.ts'],
    setupFiles: ['reflect-metadata'],
  },
});
