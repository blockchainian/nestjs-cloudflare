import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';

import {
  getDurableObjectNamespace,
  getQueueBinding,
} from '../../src/bindings/validate-binding.js';
import {
  CloudflareDurableObjectClient,
  CloudflareDurableObjectRecordBuilder,
} from '../../src/durable-objects/index.js';
import { createWorker } from '../../src/index.js';
import { CloudflareQueueClient } from '../../src/queue/index.js';

const invalidBindings: [string, unknown][] = [
  ['missing', undefined],
  ['null', null],
  ['string', 'wrong binding'],
  ['KV', env.STATE],
  ['D1', env.DATABASE],
];

describe('binding validation in workerd', () => {
  it.each([
    ['native', env.ROOM],
    [
      'plain object',
      {
        idFromName: env.ROOM.idFromName.bind(env.ROOM),
        idFromString: env.ROOM.idFromString.bind(env.ROOM),
        get: env.ROOM.get.bind(env.ROOM),
      },
    ],
  ])('accepts a %s Durable Object namespace', (_label, namespace) => {
    expect(getDurableObjectNamespace(namespace, 'ROOM')).toBe(namespace);
  });

  it.each([
    ['native', env.OUTBOX],
    [
      'plain object',
      {
        send: env.OUTBOX.send.bind(env.OUTBOX),
        sendBatch: env.OUTBOX.sendBatch.bind(env.OUTBOX),
      },
    ],
  ])('accepts a %s Queue binding', (_label, queue) => {
    expect(getQueueBinding(queue)).toBe(queue);
  });

  it.each([
    ['service', env.RPC_SERVICE],
    ['Durable Object stub', env.ROOM.getByName('invalid-namespace')],
  ])('defers interface mismatches for an RPC %s until use', (_label, rpc) => {
    expect(getDurableObjectNamespace(rpc, 'ROOM')).toBe(rpc);
    expect(getQueueBinding(rpc)).toBe(rpc);
  });

  it.each<[string, unknown]>([...invalidBindings, ['Queue', env.OUTBOX]])(
    'rejects a %s WebSocket namespace with a named configuration error',
    async (_label, binding) => {
      const worker = createWorker<{ API_WEBSOCKET?: unknown }>(
        async () => {
          throw new Error('Unexpected Nest bootstrap');
        },
        {
          websockets: [
            { paths: ['/ws'], binding: 'API_WEBSOCKET', object: 'shared' },
          ],
        },
      );

      await expect(
        worker.fetch(
          new Request('https://worker.test/ws') as Request<
            unknown,
            IncomingRequestCfProperties
          >,
          binding === undefined ? {} : { API_WEBSOCKET: binding },
          createExecutionContext(),
        ),
      ).rejects.toEqual(
        new Error(
          'Missing or invalid Durable Object namespace binding: API_WEBSOCKET',
        ),
      );
    },
  );

  it.each<[string, unknown]>([
    ...invalidBindings,
    ['Durable Object', env.ROOM],
  ])(
    'rejects a %s Queue binding through the Nest client API',
    async (_label, binding) => {
      const client = new CloudflareQueueClient({ queue: binding as Queue });
      const error = new Error('Missing or invalid Queue binding: queue');

      await expect(client.connect()).rejects.toEqual(error);
      expect(() => client.unwrap()).toThrow(error);

      await expect(firstValueFrom(client.emit('notice', {}))).rejects.toEqual(
        error,
      );
    },
  );

  it.each<[string, unknown]>([...invalidBindings, ['Queue', env.OUTBOX]])(
    'rejects a %s Durable Object namespace through the Nest client API',
    async (_label, binding) => {
      const client = new CloudflareDurableObjectClient({
        namespace: binding as DurableObjectNamespace,
      });

      const error = new Error(
        'Missing or invalid Durable Object namespace binding: namespace',
      );

      const record = new CloudflareDurableObjectRecordBuilder({})
        .setOptions({ name: 'shared' })
        .build();

      await expect(client.connect()).rejects.toEqual(error);
      expect(() => client.unwrap()).toThrow(error);

      await expect(firstValueFrom(client.send('read', record))).rejects.toEqual(
        error,
      );

      await expect(
        firstValueFrom(client.emit('write', record)),
      ).rejects.toEqual(error);
    },
  );
});
