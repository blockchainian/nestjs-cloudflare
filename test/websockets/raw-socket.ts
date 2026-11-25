import { connect, type Socket } from 'node:net';

import { type Miniflare, type Request, Response } from 'miniflare';

const connections = new Map<string, Socket>();

async function openWebSocket(address: URL, path: string): Promise<Socket> {
  const socket = connect(Number(address.port), address.hostname);

  try {
    await new Promise<void>((resolve, reject) => {
      let headers = '';

      socket.once('error', reject);

      socket.once('close', () => {
        reject(new Error('WebSocket connection closed before the upgrade'));
      });

      socket.once('connect', () => {
        socket.write(
          `GET ${path} HTTP/1.1\r\nHost: ${address.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });

      socket.on('data', function receiveHeaders(chunk: Buffer) {
        headers += chunk.toString('latin1');

        if (headers.includes('\r\n\r\n')) {
          socket.off('data', receiveHeaders);

          if (!headers.startsWith('HTTP/1.1 101 ')) {
            reject(new Error('Expected a WebSocket upgrade'));
          } else {
            resolve();
          }
        }
      });
    });

    return socket;
  } catch (error) {
    socket.destroy();

    throw error;
  }
}

function sendProtocolError(socket: Socket): Promise<void> {
  // RFC 6455 reserves opcode 0x3. Send a masked frame with that opcode.
  return new Promise(resolve => {
    socket.write(Buffer.from([0x83, 0x80, 0, 0, 0, 0]), () => resolve());
  });
}

export async function handleRawWebSocket(
  request: Request,
  miniflare: Miniflare,
) {
  const path = new URL(request.url).pathname;

  if (request.method === 'DELETE') {
    connections.get(path)?.destroy();
    connections.delete(path);

    return new Response(null, { status: 204 });
  }

  if (request.method === 'POST') {
    const socket = connections.get(path);

    if (!socket) {
      throw new Error('Expected an established WebSocket connection');
    }

    await sendProtocolError(socket);

    return new Response(null, { status: 204 });
  }

  const address = await miniflare.unsafeGetDirectURL();

  connections.set(path, await openWebSocket(address, path));

  return new Response(JSON.stringify({ upgraded: true }));
}
