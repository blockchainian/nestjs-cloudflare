import { ClientProxy, ClientsModule } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';

import {
  CloudflareDurableObjectClient,
  CloudflareDurableObjectRecordBuilder,
} from '../../src/durable-objects/index.js';
import { dispatch } from '../fixtures/transport-request.js';
import type {
  ActiveTransportRoom,
  HibernatingTransportRoom,
} from './transport-worker.js';

type Room = ActiveTransportRoom | HibernatingTransportRoom;

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.addEventListener(
      'message',
      event => resolve(JSON.parse(String(event.data)) as unknown),
      { once: true },
    );

    socket.addEventListener('error', reject, { once: true });
  });
}

async function client(namespace: DurableObjectNamespace<Room>) {
  const module = await Test.createTestingModule({
    imports: [
      ClientsModule.register([
        {
          name: 'ROOMS',
          customClass: CloudflareDurableObjectClient,
          options: { namespace },
        },
      ]),
    ],
  }).compile();

  return module.get<ClientProxy>('ROOMS');
}

async function connect(namespace: DurableObjectNamespace<Room>, name: string) {
  const stub = namespace.getByName(name);

  const response = await stub.fetch('https://worker.test/events', {
    headers: { Upgrade: 'websocket' },
  });

  expect(response.status).toBe(101);

  const socket = response.webSocket;

  if (!socket) {
    throw new Error('Expected a WebSocket upgrade');
  }

  socket.accept();

  const joined = nextMessage(socket);

  socket.send(JSON.stringify({ event: 'join' }));

  return { socket, stub, joined: await joined };
}

const hosts = [
  { name: 'active', binding: 'ACTIVE_TRANSPORT', hibernate: false },
  { name: 'hibernating', binding: 'HIBERNATING_TRANSPORT', hibernate: true },
];

describe.each(hosts)(
  '$name gateway transport in workerd',
  ({ binding, hibernate }) => {
    const namespace = env[binding] as DurableObjectNamespace<Room>;

    it.each(['cold', 'warm'])(
      'starts %s transport handlers in arrival order',
      async temperature => {
        const stub = namespace.getByName(crypto.randomUUID());

        if (temperature === 'warm') {
          await dispatch(stub, 'warmup', 'push', 'warmup');
        }

        const replies = await Promise.all([
          dispatch(stub, 'first', 'start-order', 1),
          dispatch(stub, 'second', 'start-order', 2),
        ]);

        expect(replies[0][0].response).toEqual([1]);
        expect(replies[1][0].response).toEqual([1, 2]);
      },
    );

    it('allows the next transport handler to start while the first awaits', async () => {
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
              await dispatch(object, 'warmup', 'push', 'warmup');
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

    it('preserves transport start order with connected sockets after wakeup', async () => {
      const name = crypto.randomUUID();
      const { socket, stub } = await connect(namespace, name);

      try {
        if (hibernate) {
          await evictDurableObject(stub, { webSockets: 'hibernate' });
        }

        const replies = await Promise.all([
          dispatch(stub, 'first', 'start-order', 1),
          dispatch(stub, 'second', 'start-order', 2),
        ]);

        expect(replies[0][0].response).toEqual([1]);
        expect(replies[1][0].response).toEqual([1, 2]);
      } finally {
        socket.close();
      }
    });

    it('pushes ClientProxy.send data to the owning gateway sockets', async () => {
      const first = await connect(namespace, 'push');
      const other = await connect(namespace, 'other');
      const otherFrames: unknown[] = [];

      other.socket.addEventListener('message', event =>
        otherFrames.push(event.data),
      );

      try {
        if (hibernate) {
          await evictDurableObject(first.stub, { webSockets: 'hibernate' });
        }

        const pushed = nextMessage(first.socket);

        const record = new CloudflareDurableObjectRecordBuilder('update')
          .setOptions({ name: 'push' })
          .build();

        const result = await firstValueFrom(
          (await client(namespace)).send<{ count: number; provider: string }>(
            'push',
            record,
          ),
        );

        expect(result.count).toBe(1);

        expect(await pushed).toEqual({
          data: 'update',
          provider: result.provider,
        });

        if (!hibernate) {
          expect(first.joined).toEqual({ provider: result.provider });
        }

        expect(otherFrames).toEqual([]);
      } finally {
        first.socket.close();
        other.socket.close();
      }
    });

    it('dispatches native alarms to EventPattern with object context', async () => {
      const { socket, stub, joined } = await connect(namespace, 'alarm');

      try {
        await runInDurableObject(stub, async (_object, state) => {
          await state.storage.setAlarm(Date.now() + 60_000);
        });

        if (hibernate) {
          await evictDurableObject(stub, { webSockets: 'hibernate' });
        }

        expect(await runDurableObjectAlarm(stub)).toBe(true);

        await runInDurableObject(stub, async (_object, state) => {
          expect(await state.storage.get('alarm')).toEqual({
            provider: expect.any(String),
            pattern: 'room-alarm',
            sameEnv: true,
            sameState: true,
            noRequest: true,
          });

          if (!hibernate) {
            expect(await state.storage.get('alarm')).toMatchObject(
              joined as object,
            );
          }

          expect(await state.storage.get('background')).toBe(true);
        });
      } finally {
        socket.close();
      }
    });
  },
);
