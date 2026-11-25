import { ClientProxy, ClientsModule } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';

import {
  CloudflareDurableObjectClient,
  CloudflareDurableObjectRecordBuilder,
} from '../../src/durable-objects/index.js';
import { dispatch } from '../fixtures/transport-request.js';
import type { TransportRoom } from './transport-worker.js';

const namespace = env.TRANSPORT as DurableObjectNamespace<TransportRoom>;

async function client() {
  const module = await Test.createTestingModule({
    imports: [
      ClientsModule.register([
        {
          name: 'OBJECTS',
          customClass: CloudflareDurableObjectClient,
          options: { namespace },
        },
      ]),
    ],
  }).compile();

  return module.get<ClientProxy>('OBJECTS');
}

function record(data: unknown, name: string) {
  return new CloudflareDurableObjectRecordBuilder(data)
    .setOptions({ name })
    .build();
}

interface Snapshot {
  count: number;
  provider: string;
  pattern: string;
  owner: string;
}

async function increment(proxy: ClientProxy, name: string, amount = 1) {
  return firstValueFrom(
    proxy.send<Snapshot>('increment', record(amount, name)),
  );
}

describe('Durable Object transport in workerd', () => {
  it.each(['cold', 'warm'])(
    'starts %s object handlers in arrival order',
    async temperature => {
      const stub = namespace.getByName(crypto.randomUUID());

      if (temperature === 'warm') {
        await dispatch(stub, 'warmup', 'context', null);
      }

      const replies = await Promise.all([
        dispatch(stub, 'first', 'start-order', 1),
        dispatch(stub, 'second', 'start-order', 2),
      ]);

      expect(replies[0][0].response).toEqual([1]);
      expect(replies[1][0].response).toEqual([1, 2]);
    },
  );

  it('allows the next handler to start while the first awaits', async () => {
    const stub = namespace.getByName(crypto.randomUUID());

    const replies = await Promise.all([
      dispatch(stub, 'first', 'hold', null),
      dispatch(stub, 'second', 'start-order', 2),
    ]);

    expect(replies[0][0].response).toEqual([1, 2]);
    expect(replies[1][0].response).toEqual([1, 2]);
  });

  it('initializes cold alarm and RPC handlers together in arrival order', async () => {
    await runInDurableObject(
      namespace.getByName(crypto.randomUUID()),
      async object => {
        const [, replies] = await Promise.all([
          object.alarm(),
          dispatch(object, 'next', 'start-order', 1),
        ]);

        expect(replies[0].response).toEqual([0, 1]);
      },
    );
  });

  it.each(['cold', 'warm'])(
    'starts an earlier RPC handler before a %s alarm handler',
    async temperature => {
      await runInDurableObject(
        namespace.getByName(crypto.randomUUID()),
        async object => {
          if (temperature === 'warm') {
            await dispatch(object, 'warmup', 'context', null);
          }

          const [replies] = await Promise.all([
            dispatch(object, 'first', 'start-order', 1),
            object.alarm(),
          ]);

          expect(replies[0].response).toEqual([1]);
        },
      );
    },
  );

  it('returns MessagePattern results through ClientsModule', async () => {
    const result = await increment(await client(), 'response', 3);

    expect(result.count).toBe(3);
    expect(result.pattern).toBe('increment');
  });

  it('addresses each message by object name or ID', async () => {
    const proxy = await client();
    const named = await increment(proxy, 'address');

    const data = new CloudflareDurableObjectRecordBuilder(2)
      .setOptions({ id: namespace.idFromName('address').toString() })
      .build();

    const byId = await firstValueFrom(proxy.send<Snapshot>('increment', data));

    expect(byId).toEqual({ ...named, count: 3 });
  });

  it('isolates durable providers and stored state between objects', async () => {
    const proxy = await client();
    const first = await increment(proxy, 'one', 4);
    const second = await increment(proxy, 'two', 8);

    expect(second.provider).not.toBe(first.provider);
    expect(first.owner).toBe(namespace.idFromName('one').toString());
    expect(second.owner).toBe(namespace.idFromName('two').toString());
    expect(await increment(proxy, 'one')).toEqual({ ...first, count: 5 });
  });

  it('persists handler transaction writes in real storage', async () => {
    await increment(await client(), 'transaction', 9);

    await runInDurableObject(
      namespace.getByName('transaction'),
      async (_object, state) => {
        expect(await state.storage.get('count')).toBe(9);
      },
    );
  });

  it('preserves RpcException payloads at the caller', async () => {
    await expect(
      firstValueFrom((await client()).send('lost', record({}, 'error'))),
    ).rejects.toEqual({
      code: 'LEASE_LOST',
      message: 'Job lease was lost',
      details: { owner: 'previous' },
    });
  });

  it('preserves EventPattern errors through emit', async () => {
    await expect(
      firstValueFrom(
        (await client()).emit('event-lost', record({}, 'event-error')),
      ),
    ).rejects.toEqual({ code: 'LEASE_LOST' });
  });

  it('provides environment and waitUntil in object requests', async () => {
    expect(
      await firstValueFrom(
        (await client()).send('context', record({}, 'context')),
      ),
    ).toEqual({ sameEnv: true, request: true });

    await runInDurableObject(
      namespace.getByName('context'),
      async (_object, state) => {
        expect(await state.storage.get('background')).toBe(true);
      },
    );
  });

  it('dispatches native alarms to EventPattern with object context', async () => {
    const snapshot = await increment(await client(), 'alarm');
    const stub = namespace.getByName('alarm');

    await runInDurableObject(stub, async (_object, state) => {
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, async (_object, state) => {
      expect(await state.storage.get('alarm')).toEqual({
        provider: snapshot.provider,
        sameEnv: true,
        pattern: 'alarm',
      });

      expect(await state.storage.get('alarm-background')).toBe(true);
    });
  });
});
