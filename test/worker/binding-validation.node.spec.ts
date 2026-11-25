import 'reflect-metadata';

import { resolve } from 'node:path';

import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { firstValueFrom } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CloudflareDurableObjectClient } from '../../src/durable-objects/client.js';
import { CloudflareDurableObjectRecordBuilder } from '../../src/durable-objects/record-builder.js';
import { CloudflareQueueClient } from '../../src/queue/client.js';
import { forwardWebSocketRequest } from '../../src/worker/websocket-routing.js';

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    scriptPath: resolve('test/fixtures/node-bindings.js'),
    compatibilityDate: '2026-08-22',
    durableObjects: { ROOM: 'Room' },
    kvNamespaces: ['STATE'],
    queueProducers: { OUTBOX: 'outbox' },
    queueConsumers: { outbox: { maxBatchTimeout: 0 } },
  }),
);

interface Bindings {
  ROOM: DurableObjectNamespace;
  OUTBOX: Queue;
}

let bindings: Bindings;

beforeAll(async () => {
  bindings = await mf.getBindings<Bindings>();
});

afterAll(async () => {
  await mf.dispose();
});

async function namespaceFor(source: string): Promise<DurableObjectNamespace> {
  return source === 'getBindings'
    ? bindings.ROOM
    : ((await mf.getDurableObjectNamespace(
        'ROOM',
      )) as unknown as DurableObjectNamespace);
}

async function queueFor(source: string): Promise<Queue> {
  return source === 'getBindings'
    ? bindings.OUTBOX
    : ((await mf.getQueueProducer('OUTBOX')) as unknown as Queue);
}

describe('binding validation with Miniflare Node proxies', () => {
  it.each(['getBindings', 'getDurableObjectNamespace'])(
    'uses a Durable Object namespace from %s through the Nest client',
    async source => {
      const namespace = await namespaceFor(source);
      const client = new CloudflareDurableObjectClient({ namespace });
      const id = namespace.idFromName(source);

      const record = new CloudflareDurableObjectRecordBuilder('payload')
        .setOptions({ id: id.toString() })
        .build();

      expect(namespace.idFromString(id.toString()).toString()).toBe(
        id.toString(),
      );

      expect(await client.connect()).toBe(namespace);
      expect(client.unwrap()).toBe(namespace);

      await expect(firstValueFrom(client.send('echo', record))).resolves.toBe(
        'payload',
      );
    },
  );

  it.each(['getBindings', 'getDurableObjectNamespace'])(
    'forwards a request through a namespace from %s',
    async source => {
      const namespace = await namespaceFor(source);

      const response = await forwardWebSocketRequest(
        new Request('https://worker.test/ws') as Request<
          unknown,
          IncomingRequestCfProperties
        >,
        { ROOM: namespace },
        { paths: ['/ws'], binding: 'ROOM', object: source },
      );

      expect(await response.text()).toBe('forwarded');
    },
  );

  it.each(['getBindings', 'getQueueProducer'])(
    'publishes through a Queue from %s using the Nest client',
    async source => {
      const queue = await queueFor(source);
      const client = new CloudflareQueueClient({ queue });
      const state = await mf.getKVNamespace('STATE');

      expect(await client.connect()).toBe(queue);
      expect(client.unwrap()).toBe(queue);

      await firstValueFrom(client.emit('notice', { id: source }));

      await vi.waitFor(async () => {
        expect(await state.get(source, 'json')).toEqual({
          pattern: 'notice',
          data: { id: source },
        });
      });
    },
  );
});
