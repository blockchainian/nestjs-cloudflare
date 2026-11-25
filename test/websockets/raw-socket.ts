import { connect, type Socket } from 'node:net';

import { type Miniflare, type Request, Response } from 'miniflare';

interface RawConnection {
  socket: Socket;
  closeSent: boolean;
  closed: Promise<{ code: number; reason: string }>;
}

const connections = new Map<string, RawConnection>();

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

function receiveClose(
  socket: Socket,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);

    socket.on('error', reject);

    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);

      if (received.length < 2) {
        return;
      }

      const length = received[1] & 0x7f;

      if (received.length < length + 2) {
        return;
      }

      if (received[0] !== 0x88) {
        reject(new Error('Expected an unmasked WebSocket Close frame'));

        return;
      }

      resolve({
        code: length === 0 ? 1005 : received.readUInt16BE(2),
        reason: length === 0 ? '' : received.subarray(4, length + 2).toString(),
      });
    });
  });
}

function sendClose(
  socket: Socket,
  code: number | undefined,
  reason: string,
): void {
  const payload =
    code === undefined
      ? Buffer.alloc(0)
      : Buffer.alloc(2 + Buffer.byteLength(reason));

  if (code !== undefined) {
    payload.writeUInt16BE(code);
    payload.write(reason, 2);
  }

  // Use an all-zero masking key so the payload bytes remain unchanged.
  socket.write(
    Buffer.concat([
      Buffer.from([0x88, 0x80 | payload.length, 0, 0, 0, 0]),
      payload,
    ]),
  );
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
    connections.get(path)?.socket.destroy();
    connections.delete(path);

    return new Response(null, { status: 204 });
  }

  if (request.method === 'PATCH' || request.method === 'PUT') {
    const connection = connections.get(path);

    if (!connection) {
      throw new Error('Expected an established WebSocket connection');
    }

    if (request.method === 'PUT') {
      const { code, reason } = (await request.json()) as {
        code?: number;
        reason: string;
      };

      connection.closeSent = true;
      sendClose(connection.socket, code, reason);
    }

    const frame = await connection.closed;

    return new Response(
      JSON.stringify({ ...frame, handshakeComplete: connection.closeSent }),
    );
  }

  if (request.method === 'POST') {
    const socket = connections.get(path)?.socket;

    if (!socket) {
      throw new Error('Expected an established WebSocket connection');
    }

    await sendProtocolError(socket);

    return new Response(null, { status: 204 });
  }

  const address = await miniflare.unsafeGetDirectURL();

  const socket = await openWebSocket(address, path);

  connections.set(path, {
    socket,
    closeSent: false,
    closed: receiveClose(socket),
  });

  return new Response(JSON.stringify({ upgraded: true }));
}
