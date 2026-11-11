import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './test/wrangler.jsonc' },
      miniflare: {
        serviceBindings: { RPC_SERVICE: 'rpc-service' },
        workers: [
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
