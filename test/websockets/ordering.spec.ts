import { evictDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import type { GatewayRoom, SocketRoom } from '../ws-worker.js';

function frames(socket: WebSocket, count: number): Promise<string[]> {
  return new Promise(resolve => {
    const received: Array<string | Blob> = [];

    const listener = (event: MessageEvent) => {
      received.push(event.data as string | Blob);

      if (received.length === count) {
        socket.removeEventListener('message', listener);

        resolve(
          Promise.all(
            received.map(frame =>
              typeof frame === 'string' ? frame : frame.text(),
            ),
          ),
        );
      }
    };

    socket.addEventListener('message', listener);
  });
}

async function connect(binding: string, name: string, path: string) {
  const namespace = env[binding] as DurableObjectNamespace<
    GatewayRoom | SocketRoom
  >;

  const stub = namespace.getByName(name);

  const response = await stub.fetch(`https://worker.test${path}`, {
    headers: { Upgrade: 'websocket' },
  });

  const socket = response.webSocket;

  if (!socket) {
    throw new Error('Expected a WebSocket upgrade');
  }

  socket.accept();

  return { socket, stub };
}

function send(socket: WebSocket, event: string) {
  socket.send(JSON.stringify({ event }));
}

describe.each([
  ['active', 'GATEWAY_ROOM', '/ws'],
  ['hibernating', 'ROOM', '/chat'],
])('%s WebSocket message concurrency', (_host, binding, path) => {
  it('should preserve concurrent handling by default', async () => {
    const { socket, stub } = await connect(binding, 'concurrent', path);
    const started = frames(socket, 1);

    try {
      send(socket, 'authenticate');
      await started;
      const response = frames(socket, 1);

      send(socket, 'subscribe');

      expect(JSON.parse((await response)[0])).toEqual({
        event: 'subscribed',
        authenticated: false,
      });
    } finally {
      await stub.release();
      socket.close();
    }
  });

  it('should serialize one connection with a limit of one without blocking another connection', async () => {
    const first = await connect(binding, 'serial-room', path);
    const second = await connect(binding, 'serial-room', path);

    if (binding === 'ROOM') {
      await evictDurableObject(first.stub);
    }

    const started = frames(first.socket, 1);

    try {
      send(first.socket, 'authenticate');
      await started;
      const responses = frames(first.socket, 2);
      const independent = frames(second.socket, 1);

      send(first.socket, 'subscribe');
      send(second.socket, 'subscribe');

      expect(JSON.parse((await independent)[0])).toEqual({
        event: 'subscribed',
        authenticated: false,
      });

      await first.stub.release();

      expect((await responses).map(frame => JSON.parse(frame))).toEqual([
        { event: 'authenticated' },
        { event: 'subscribed', authenticated: true },
      ]);
    } finally {
      await first.stub.release();
      first.socket.close();
      second.socket.close();
    }
  });
});
