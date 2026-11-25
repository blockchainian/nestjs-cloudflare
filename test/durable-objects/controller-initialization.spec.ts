import type { WritePacket } from '@nestjs/microservices';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { dispatch } from '../fixtures/transport-request.js';
import type { HealthyNativeRoom } from './controller-initialization-worker.js';

function namespace(name: string) {
  return env[name] as DurableObjectNamespace<HealthyNativeRoom>;
}

const hosts = [
  { name: 'native', healthy: 'HEALTHY_NATIVE', fragile: 'FRAGILE_NATIVE' },
  { name: 'active', healthy: 'HEALTHY_ACTIVE', fragile: 'FRAGILE_ACTIVE' },
  {
    name: 'hibernating',
    healthy: 'HEALTHY_HIBERNATING',
    fragile: 'FRAGILE_HIBERNATING',
  },
];

async function configure(stub: DurableObjectStub<HealthyNativeRoom>) {
  await runInDurableObject(stub, async (_object, state) => {
    await state.storage.put('ready', true);
  });
}

async function attempts(stub: DurableObjectStub<HealthyNativeRoom>) {
  return runInDurableObject(stub, (_object, state) =>
    state.storage.get<number>('attempts'),
  );
}

describe.each(hosts)('$name controller initialization in workerd', host => {
  it('isolates calls and cold alarms between object classes sharing a server', async () => {
    const fragile = namespace(host.fragile).getByName(crypto.randomUUID());
    const healthy = namespace(host.healthy).getByName(crypto.randomUUID());
    const alarmOnly = namespace(host.healthy).getByName(crypto.randomUUID());

    await runInDurableObject(fragile, async object => {
      await expect(dispatch(object, 'failure', 'fragile', 1)).rejects.toThrow(
        'Missing DB',
      );
    });

    await expect(
      dispatch(healthy, 'success', 'healthy', 1),
    ).resolves.toMatchObject([{ response: [1] }]);

    await runInDurableObject(alarmOnly, async (_object, state) => {
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(alarmOnly)).toBe(true);
    expect(await attempts(healthy)).toBeUndefined();
    expect(await attempts(alarmOnly)).toBeUndefined();

    await runInDurableObject(alarmOnly, async (_object, state) => {
      expect(await state.storage.get('healthy-alarm')).toBe(true);
    });
  });

  it('matches normalized object patterns without resolving unrelated controllers', async () => {
    const stub = namespace(host.healthy).getByName(crypto.randomUUID());

    const packet = {
      id: 'object-pattern',
      pattern: { version: 1, action: 'healthy' },
      data: 1,
    };

    const replies: WritePacket<unknown>[] = await stub.dispatch(packet);

    expect(replies[0].response).toEqual([1]);
    expect(await attempts(stub)).toBeUndefined();
  });

  it.each(['cold', 'warm'])(
    'shares resolution and starts %s calls in arrival order',
    async temperature => {
      const stub = namespace(host.fragile).getByName(crypto.randomUUID());

      await configure(stub);

      if (temperature === 'warm') {
        await dispatch(stub, 'warmup', 'fragile', 0);
      }

      const replies = await Promise.all([
        dispatch(stub, 'first', 'fragile', 1),
        dispatch(stub, 'second', 'fragile-alias', 2),
      ]);

      const prefix = temperature === 'warm' ? [0] : [];

      expect(replies[0][0].response).toEqual([...prefix, 1]);
      expect(replies[1][0].response).toEqual([...prefix, 1, 2]);
      expect(await attempts(stub)).toBe(1);
    },
  );

  it('shares a failed resolution, retries it, and leaves other controllers usable', async () => {
    const stub = namespace(host.fragile).getByName(crypto.randomUUID());

    const results = await runInDurableObject(stub, object =>
      Promise.allSettled([
        dispatch(object, 'first', 'fragile', 1),
        dispatch(object, 'second', 'fragile-alias', 2),
        dispatch(object, 'healthy', 'healthy', 3),
      ]),
    );

    expect(results.slice(0, 2)).toEqual([
      {
        status: 'rejected',
        reason: expect.objectContaining({ message: 'Missing DB' }),
      },
      {
        status: 'rejected',
        reason: expect.objectContaining({ message: 'Missing DB' }),
      },
    ]);

    expect(results[2]).toMatchObject({
      status: 'fulfilled',
      value: [{ response: [3] }],
    });

    expect(await attempts(stub)).toBe(1);

    await runInDurableObject(stub, async object => {
      await expect(dispatch(object, 'retry', 'fragile', 4)).rejects.toThrow(
        'Missing DB',
      );
    });

    expect(await attempts(stub)).toBe(2);

    await configure(stub);

    await expect(
      dispatch(stub, 'recovered', 'fragile', 5),
    ).resolves.toMatchObject([{ response: [5] }]);

    expect(await attempts(stub)).toBe(3);

    await expect(
      dispatch(stub, 'healthy-again', 'healthy', 6),
    ).resolves.toMatchObject([{ response: [3, 6] }]);
  });

  it('shares cold alarm and RPC resolution for the same controller', async () => {
    const stub = namespace(host.fragile).getByName(crypto.randomUUID());

    await configure(stub);

    await runInDurableObject(stub, async object => {
      const [, replies] = await Promise.all([
        object.alarm(),
        dispatch(object, 'next', 'fragile', 1),
      ]);

      expect(replies[0].response).toEqual([0, 1]);
    });

    expect(await attempts(stub)).toBe(1);
  });

  it('retries failed alarms without poisoning another controller', async () => {
    const stub = namespace(host.fragile).getByName(crypto.randomUUID());

    await runInDurableObject(stub, async object => {
      await expect(object.alarm()).rejects.toThrow('Missing DB');

      await expect(
        dispatch(object, 'healthy', 'healthy', 1),
      ).resolves.toMatchObject([{ response: [1] }]);
    });

    await configure(stub);
    await runInDurableObject(stub, object => object.alarm());

    expect(await attempts(stub)).toBe(2);

    await expect(
      dispatch(stub, 'after-alarm', 'fragile', 2),
    ).resolves.toMatchObject([{ response: [0, 2] }]);
  });
});
