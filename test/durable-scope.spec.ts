import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import type {
  ActiveScopeRoom,
  HibernatingScopeRoom,
  NativeScopeRoom,
} from './durable-scope-worker.js';

interface Snapshot {
  provider: string;
  owner: string;
  singleton: string;
  echo: string;
}

const namespaces = env as unknown as {
  NATIVE_SCOPE: DurableObjectNamespace<NativeScopeRoom>;
  HIBERNATING_SCOPE: DurableObjectNamespace<HibernatingScopeRoom>;
  ACTIVE_SCOPE: DurableObjectNamespace<ActiveScopeRoom>;
};

async function connect(namespace: DurableObjectNamespace, name: string) {
  const response = await namespace
    .getByName(name)
    .fetch('https://worker.test/scope', {
      headers: { Upgrade: 'websocket' },
    });

  if (!response.webSocket) {
    throw new Error('Expected a WebSocket upgrade');
  }

  response.webSocket.accept();

  return response.webSocket;
}

function read(socket: WebSocket, value: string): Promise<Snapshot> {
  return new Promise((resolve, reject) => {
    socket.addEventListener(
      'message',
      event => resolve(JSON.parse(String(event.data)) as Snapshot),
      { once: true },
    );

    socket.addEventListener(
      'close',
      event => reject(new Error(`Socket closed: ${event.code}`)),
      { once: true },
    );

    socket.send(JSON.stringify({ event: 'read', data: value }));
  });
}

describe('Durable Object dependency scopes in workerd', () => {
  it('reproduces the ownership error when two objects share a singleton upstream socket', async () => {
    const first = namespaces.NATIVE_SCOPE.getByName('unsafe-one');
    const second = namespaces.NATIVE_SCOPE.getByName('unsafe-two');

    expect(await first.unsafe('first')).toBe('first');

    expect(await second.unsafe('second')).toContain(
      'Cannot perform I/O on behalf of a different Durable Object',
    );
  });

  it('isolates native objects and reuses durable instances across fetch, RPC and alarm', async () => {
    const first = namespaces.NATIVE_SCOPE.getByName('native-one');
    const second = namespaces.NATIVE_SCOPE.getByName('native-two');
    const initial = await first.read('rpc');
    const other = await second.read('other');

    expect(initial.owner).toBe(first.id.toString());
    expect(other.owner).toBe(second.id.toString());
    expect(initial.echo).toBe('rpc');
    expect(other.echo).toBe('other');
    expect(other.provider).not.toBe(initial.provider);
    expect(other.singleton).toBe(initial.singleton);

    expect(await (await first.fetch('https://worker.test')).json()).toEqual({
      ...initial,
      echo: 'fetch',
    });

    await runInDurableObject(first, async (instance, state) => {
      await instance.alarm();

      expect(await state.storage.get('alarm')).toEqual({
        ...initial,
        echo: 'alarm',
      });
    });

    expect(await first.read('again')).toEqual({ ...initial, echo: 'again' });
    expect(await first.eventId()).not.toBe(await first.eventId());
  });

  it.each(['HIBERNATING_SCOPE', 'ACTIVE_SCOPE'] as const)(
    'isolates %s gateways in one application across connections and messages',
    async binding => {
      const first = await connect(namespaces[binding], `${binding}-one`);
      const second = await connect(namespaces[binding], `${binding}-two`);
      const initial = await read(first, 'first');
      const other = await read(second, 'second');

      expect(initial.echo).toBe('first');
      expect(other.echo).toBe('second');
      expect(other.provider).not.toBe(initial.provider);
      expect(other.singleton).toBe(initial.singleton);
      expect(await read(first, 'again')).toEqual({ ...initial, echo: 'again' });

      const reconnect = await connect(namespaces[binding], `${binding}-one`);

      expect(await read(reconnect, 'reconnect')).toEqual({
        ...initial,
        echo: 'reconnect',
      });

      const stub = namespaces[binding].getByName(`${binding}-one`);

      expect(initial.owner).toBe(stub.id.toString());
      expect(await stub.read('rpc')).toEqual({ ...initial, echo: 'rpc' });

      expect(
        await (await stub.fetch('https://worker.test/scope')).json(),
      ).toEqual({ ...initial, echo: 'fetch' });

      await runInDurableObject(stub, async (instance, state) => {
        await instance.alarm();

        expect(await state.storage.get('alarm')).toEqual({
          ...initial,
          echo: 'alarm',
        });
      });

      first.close();
      second.close();
      reconnect.close();
    },
  );
});
