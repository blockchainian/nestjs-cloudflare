import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, inject, it } from 'vitest';

import { ActiveErrorRoom, HibernatingErrorRoom } from './error-worker.js';

declare module 'vitest' {
  export interface ProvidedContext {
    manualClose: boolean;
  }
}

type ErrorRoom = ActiveErrorRoom | HibernatingErrorRoom;

const bindings = env as unknown as {
  ACTIVE_ERROR: DurableObjectNamespace<ActiveErrorRoom>;
  HIBERNATING_ERROR: DurableObjectNamespace<HibernatingErrorRoom>;
  RAW_WEBSOCKET: Fetcher;
};

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.addEventListener(
      'message',
      event => {
        resolve(JSON.parse(String(event.data)) as unknown);
      },
      { once: true },
    );

    socket.addEventListener(
      'close',
      event => {
        reject(new Error(`Unexpected socket close: ${event.code}`));
      },
      { once: true },
    );

    socket.addEventListener('error', reject, { once: true });
  });
}

async function connect(stub: DurableObjectStub<ErrorRoom>) {
  const response = await stub.fetch('https://worker.test/errors', {
    headers: { Upgrade: 'websocket' },
  });

  if (!response.webSocket) {
    throw new Error('Expected a WebSocket upgrade');
  }

  response.webSocket.accept();

  return response.webSocket;
}

async function failSocket(
  host: 'ACTIVE_ERROR' | 'HIBERNATING_ERROR',
  name: string,
) {
  const url = `http://raw/socket-error/${host}/${name}`;
  const response = await bindings.RAW_WEBSOCKET.fetch(url);

  expect(await response.json()).toMatchObject({ upgraded: true });

  await bindings.RAW_WEBSOCKET.fetch(url, { method: 'POST' });

  return () => bindings.RAW_WEBSOCKET.fetch(url, { method: 'DELETE' });
}

describe.each(['ACTIVE_ERROR', 'HIBERNATING_ERROR'] as const)(
  '%s socket errors',
  host => {
    it.each([
      { code: undefined, reason: '', replyCode: 1000 },
      { code: 1000, reason: '', replyCode: 1000 },
      { code: 4001, reason: 'Client finished', replyCode: 4001 },
    ])(
      'completes peer close $code with reason "$reason" without gateway close',
      async ({ code, reason, replyCode }) => {
        const stub = bindings[host].getByName(`close-${code}`);
        const url = `http://raw/socket-error/${host}/close-${code}`;

        await bindings.RAW_WEBSOCKET.fetch(url);

        const response = await bindings.RAW_WEBSOCKET.fetch(url, {
          method: 'PUT',
          body: JSON.stringify({ code, reason }),
        });

        const event = await response.json<{
          code: number;
          reason: string;
          handshakeComplete: boolean;
        }>();

        expect(event.handshakeComplete).toBe(true);

        if (
          code === undefined &&
          host === 'ACTIVE_ERROR' &&
          !inject('manualClose')
        ) {
          expect(event.code).toBe(1005);
        } else {
          expect(event.code).toBe(replyCode);
        }

        expect(event.reason).toBe(reason);

        await bindings.RAW_WEBSOCKET.fetch(url, { method: 'DELETE' });

        const snapshot = await runInDurableObject(stub, instance =>
          instance.events.snapshot(),
        );

        expect(snapshot.disconnects).toBe(1);
        expect(snapshot.reasons).toEqual([reason]);
        expect(snapshot.disconnectEvents).toEqual([{ type: 'close', reason }]);
        expect(snapshot.disconnectStates).toEqual([WebSocket.CLOSED]);
        expect(snapshot.connections).toBe(0);
        expect(snapshot.readyState).toBe(WebSocket.CLOSED);
        expect(snapshot.errors).toEqual([]);
      },
    );

    it('logs a real protocol error and disconnects the gateway exactly once without a close event', async () => {
      const stub = bindings[host].getByName('native-error');
      const release = await failSocket(host, 'native-error');

      try {
        const snapshot = await stub.waitForError();

        expect(snapshot.errors).toHaveLength(1);
        expect(snapshot.nativeEvents).toEqual(['error']);

        const wire = await bindings.RAW_WEBSOCKET.fetch(
          `http://raw/socket-error/${host}/native-error`,
          { method: 'PATCH' },
        );

        expect(await wire.json()).toMatchObject({
          code: 1002,
          handshakeComplete: false,
        });

        expect(snapshot.disconnects).toBe(1);
        expect(snapshot.reasons).toEqual([undefined]);
        expect(snapshot.disconnectEvents).toEqual([{ type: 'error' }]);
        expect(snapshot.connections).toBe(0);

        if (host === 'ACTIVE_ERROR') {
          expect(snapshot.hostConnections).toBe(0);
        }
      } finally {
        await release();
      }
    });

    it('ignores repeated close notifications after a terminal socket error', async () => {
      const stub = bindings[host].getByName('late-close');
      const release = await failSocket(host, 'late-close');

      try {
        await stub.waitForError();

        const snapshot = await runInDurableObject<
          ErrorRoom,
          ReturnType<ErrorRoom['events']['snapshot']>
        >(stub, async instance => {
          const socket = instance.events.socket;

          if (!socket) {
            throw new Error('Expected a connected server socket');
          }

          for (let index = 0; index < 2; index++) {
            if (instance instanceof HibernatingErrorRoom) {
              await instance.webSocketClose(socket, 1006, 'Late close', false);
            } else {
              socket.dispatchEvent(
                new CloseEvent('close', { code: 1006, reason: 'Late close' }),
              );
            }
          }

          return instance.events.snapshot();
        });

        expect(snapshot.disconnects).toBe(1);
        expect(snapshot.reasons).toEqual([undefined]);
        expect(snapshot.disconnectEvents).toEqual([{ type: 'error' }]);
        expect(snapshot.connections).toBe(0);
        expect(snapshot.errors).toHaveLength(1);
      } finally {
        await release();
      }
    });

    it('logs an adapter error without initiating a close on an open socket', async () => {
      const stub = bindings[host].getByName('adapter-error');
      const socket = await connect(stub);

      try {
        const snapshot = await runInDurableObject<
          ErrorRoom,
          ReturnType<ErrorRoom['events']['snapshot']>
        >(stub, instance => {
          const server = instance.events.socket;

          if (!server) {
            throw new Error('Expected a connected server socket');
          }

          instance.adapter.error(server, new Error('Adapter error'));

          return instance.events.snapshot();
        });

        expect(snapshot.errors).toEqual(['Error: Adapter error']);
        expect(snapshot.readyState).toBe(WebSocket.OPEN);
        expect(snapshot.disconnects).toBe(0);

        const reply = nextMessage(socket);

        socket.send(JSON.stringify({ event: 'echo' }));

        expect(await reply).toEqual({ event: 'reply' });
      } finally {
        socket.close();
      }
    });

    it.each([
      { event: 'failure', message: 'Rejected by Nest', errors: [] },
      {
        event: 'unexpected-failure',
        message: 'Internal server error',
        errors: ['Error: Handler failure'],
      },
    ])(
      'handles $event through Nest exception filters without disconnecting',
      async ({ event, message, errors }) => {
        const stub = bindings[host].getByName(event);
        const socket = await connect(stub);

        try {
          let reply = nextMessage(socket);

          socket.send(JSON.stringify({ event }));

          expect(await reply).toMatchObject({
            event: 'exception',
            data: { message },
          });

          reply = nextMessage(socket);
          socket.send(JSON.stringify({ event: 'echo' }));

          expect(await reply).toEqual({ event: 'reply' });

          const snapshot = await runInDurableObject(stub, instance =>
            instance.events.snapshot(),
          );

          expect(snapshot.errors).toEqual(errors);
          expect(snapshot.nativeEvents).toEqual([]);
          expect(snapshot.disconnects).toBe(0);
          expect(snapshot.connections).toBe(1);
        } finally {
          socket.close();
        }
      },
    );

    it('logs parser failures without treating them as terminal socket errors', async () => {
      const stub = bindings[host].getByName('parser-error');
      const socket = await connect(stub);

      try {
        const reply = nextMessage(socket);

        socket.send('parser-error');
        socket.send(JSON.stringify({ event: 'echo' }));

        expect(await reply).toEqual({ event: 'reply' });

        const snapshot = await runInDurableObject(stub, instance =>
          instance.events.snapshot(),
        );

        expect(snapshot.errors).toEqual(['Error: Parser failure']);
        expect(snapshot.nativeEvents).toEqual([]);
        expect(snapshot.disconnects).toBe(0);
        expect(snapshot.connections).toBe(1);
      } finally {
        socket.close();
      }
    });
  },
);

it('disconnects a terminal socket error after waking from hibernation', async () => {
  const stub = bindings.HIBERNATING_ERROR.getByName('hibernated-error');
  const url = 'http://raw/socket-error/HIBERNATING_ERROR/hibernated-error';

  await bindings.RAW_WEBSOCKET.fetch(url);

  try {
    await evictDurableObject(stub, { webSockets: 'hibernate' });
    await bindings.RAW_WEBSOCKET.fetch(url, { method: 'POST' });

    const snapshot = await stub.waitForError();

    expect(snapshot.errors).toHaveLength(1);
    expect(snapshot.nativeEvents).toEqual(['error']);
    expect(snapshot.disconnects).toBe(1);
    expect(snapshot.connections).toBe(0);
  } finally {
    await bindings.RAW_WEBSOCKET.fetch(url, { method: 'DELETE' });
  }
});
