import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { type GatewayRoom } from '../ws-worker.js';

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('message', event => resolve(event.data), {
      once: true,
    });

    socket.addEventListener('error', reject, { once: true });
  });
}

async function connect(
  namespace: DurableObjectNamespace<GatewayRoom>,
  name: string,
  path: string,
) {
  const stub = namespace.getByName(name);

  const response = await stub.fetch(`https://worker.test${path}`, {
    headers: { Upgrade: 'websocket' },
  });

  expect(response.status).toBe(101);

  if (!response.webSocket) {
    throw new Error('Expected a WebSocket upgrade');
  }

  response.webSocket.accept();

  return { socket: response.webSocket, stub };
}

describe('CloudflareWebSocketGatewayDurableObject', () => {
  const namespaces = env as unknown as {
    GATEWAY_ROOM: DurableObjectNamespace<GatewayRoom>;
    SECOND_GATEWAY_ROOM: DurableObjectNamespace<GatewayRoom>;
  };

  it('supports multiple gateway paths and preserves non-JSON frames', async () => {
    const first = await connect(namespaces.GATEWAY_ROOM, 'shared', '/ws');
    const second = await connect(namespaces.GATEWAY_ROOM, 'shared', '/mobula');
    const firstFrame = nextMessage(first.socket);
    const secondFrame = nextMessage(second.socket);

    first.socket.send(JSON.stringify({ event: 'broadcast', data: 'hello' }));

    const firstValue = await firstFrame;

    expect(await secondFrame).toBe(firstValue);

    first.socket.close();
    second.socket.close();
  });

  it('keeps two object instances isolated and exposes object state', async () => {
    const first = await connect(namespaces.GATEWAY_ROOM, 'one', '/ws');
    const second = await connect(namespaces.SECOND_GATEWAY_ROOM, 'two', '/ws');
    const firstState = nextMessage(first.socket);
    const secondState = nextMessage(second.socket);

    first.socket.send(JSON.stringify({ event: 'state' }));
    second.socket.send(JSON.stringify({ event: 'state' }));

    expect(await firstState).toBeInstanceOf(Blob);
    expect(await secondState).toBeInstanceOf(Blob);

    first.socket.close();
    second.socket.close();
  });

  it('delegates non-upgrade requests to the subclass', async () => {
    const stub = namespaces.GATEWAY_ROOM.getByName('http');
    const response = await stub.fetch('https://worker.test/health');

    expect(await response.text()).toBe('custom:/health');
  });
});
