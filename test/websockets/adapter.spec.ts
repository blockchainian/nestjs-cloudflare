import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { SocketRoom } from '../ws-worker.js';

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.addEventListener(
      'message',
      event => {
        try {
          resolve(JSON.parse(String(event.data)) as unknown);
        } catch (error) {
          reject(error);
        }
      },
      { once: true },
    );

    socket.addEventListener('error', reject, { once: true });
  });
}

function closed(socket: WebSocket): Promise<CloseEvent> {
  return new Promise(resolve =>
    socket.addEventListener('close', resolve, { once: true }),
  );
}

async function connect(name: string) {
  return connectTo(name, env.ROOM);
}

async function connectTo<T extends import('cloudflare:workers').DurableObject>(
  name: string,
  namespace: DurableObjectNamespace<T>,
) {
  const stub = namespace.getByName(name);

  const response = await stub.fetch('https://worker.test/chat', {
    headers: { Upgrade: 'websocket' },
  });

  expect(response.status).toBe(101);

  const socket = response.webSocket;

  if (!socket) {
    throw new Error('Expected a WebSocket upgrade');
  }

  socket.accept();

  return { socket, stub };
}

async function disconnect(socket: WebSocket) {
  const done = closed(socket);

  socket.close(1000, 'finished');
  await done;
}

describe('CloudflareWebSocketAdapter', () => {
  it('should dispatch an actual WebSocket message through a Nest gateway and injected service', async () => {
    const { socket } = await connect('echo');
    const reply = nextMessage(socket);

    socket.send(JSON.stringify({ event: 'echo', data: 'hello' }));

    expect(await reply).toEqual({ event: 'reply', data: 'Nest:hello' });

    await disconnect(socket);
  });

  it('should send each value of an Observable returned by a handler', async () => {
    const { socket } = await connect('stream');
    const replies: unknown[] = [];

    const done = new Promise<void>(resolve =>
      socket.addEventListener('message', event => {
        replies.push(JSON.parse(String(event.data)) as unknown);

        if (replies.length === 2) {
          resolve();
        }
      }),
    );

    socket.send(JSON.stringify({ event: 'stream' }));
    await done;

    expect(replies).toEqual([
      { event: 'item', data: 1 },
      { event: 'item', data: 2 },
    ]);

    await disconnect(socket);
  });

  it('should retain Nest guards and exception filters', async () => {
    const { socket } = await connect('pipeline');
    let reply = nextMessage(socket);

    socket.send(JSON.stringify({ event: 'echo', data: 'denied' }));

    expect(await reply).toMatchObject({
      event: 'exception',
      data: { message: 'Forbidden resource' },
    });

    reply = nextMessage(socket);
    socket.send(JSON.stringify({ event: 'failure' }));

    expect(await reply).toMatchObject({
      event: 'exception',
      data: { message: 'Rejected by Nest' },
    });

    reply = nextMessage(socket);
    socket.send(JSON.stringify({ event: 'echo', data: 'after' }));

    expect(await reply).toEqual({ event: 'reply', data: 'Nest:after' });

    await disconnect(socket);
  });

  it('should complete the close handshake and run the Nest disconnection hook', async () => {
    const { socket, stub } = await connect('close');
    const before = await stub.disconnections();

    await disconnect(socket);
    await runInDurableObject(stub, () => undefined);

    expect(await stub.disconnections()).toBe(before + 1);
  });

  it('should dispatch through Nest after the Durable Object hibernates and wakes', async () => {
    const { socket, stub } = await connect('hibernate');
    let reply = nextMessage(socket);

    socket.send(JSON.stringify({ event: 'state' }));

    expect(await reply).toEqual({ event: 'state', data: { activation: 1 } });

    await evictDurableObject(stub, { webSockets: 'hibernate' });
    reply = nextMessage(socket);
    socket.send(JSON.stringify({ event: 'state' }));

    expect(await reply).toEqual({ event: 'state', data: { activation: 2 } });

    reply = nextMessage(socket);
    socket.send(JSON.stringify({ event: 'echo', data: 'awake' }));

    expect(await reply).toEqual({ event: 'reply', data: 'Nest:awake' });

    await disconnect(socket);
  });

  it('should close malformed frames explicitly', async () => {
    const { socket } = await connect('invalid');
    const done = closed(socket);

    socket.send('invalid JSON');

    expect((await done).code).toBe(1007);
  });

  it('should disconnect native error callbacks without initiating a close', async () => {
    const { socket, stub } = await connect('error');
    const before = await stub.disconnections();

    const readyState = await runInDurableObject<SocketRoom, number>(
      stub,
      async (instance, state) => {
        const server = state.getWebSockets()[0];

        if (!server) {
          throw new Error('Expected an accepted socket');
        }

        await instance.webSocketError(server, new Error('Native error'));

        return server.readyState;
      },
    );

    expect(readyState).toBe(WebSocket.OPEN);
    expect(await stub.disconnections()).toBe(before + 1);

    await disconnect(socket);
  });

  it('should map a client protocol through messageParser on a thin Durable Object subclass', async () => {
    const { socket } = await connectTo('custom', env.PARSER_ROOM);
    const reply = nextMessage(socket);

    socket.send('echo:custom');

    expect(await reply).toEqual({ event: 'reply', data: 'Nest:custom' });

    await disconnect(socket);
  });

  it('should map binary frames and restore the custom parser after hibernation', async () => {
    const { socket, stub } = await connectTo(
      'custom-hibernate',
      env.PARSER_ROOM,
    );

    let reply = nextMessage(socket);

    socket.send(new TextEncoder().encode('echo:binary').buffer);

    expect(await reply).toEqual({ event: 'reply', data: 'Nest:binary' });

    await evictDurableObject(stub, { webSockets: 'hibernate' });
    reply = nextMessage(socket);
    socket.send('echo:awake');

    expect(await reply).toEqual({ event: 'reply', data: 'Nest:awake' });

    await disconnect(socket);
  });

  it('should ignore frames when messageParser returns void', async () => {
    const { socket } = await connectTo('custom-ignore', env.PARSER_ROOM);
    const reply = nextMessage(socket);

    socket.send('skip');
    socket.send('echo:after');

    expect(await reply).toEqual({ event: 'reply', data: 'Nest:after' });

    await disconnect(socket);
  });

  it('should distinguish application parser failures from malformed client messages', async () => {
    const { socket } = await connectTo('custom-error', env.PARSER_ROOM);
    const reply = Promise.race([nextMessage(socket), closed(socket)]);

    socket.send('explode');
    socket.send('echo:after-error');

    expect(await reply).toEqual({ event: 'reply', data: 'Nest:after-error' });

    await disconnect(socket);
  });

  it('should let a custom parser identify malformed frames with the named error', async () => {
    const { socket } = await connectTo('custom-invalid', env.PARSER_ROOM);
    const done = closed(socket);

    socket.send('invalid');

    expect((await done).code).toBe(1007);
  });
});
