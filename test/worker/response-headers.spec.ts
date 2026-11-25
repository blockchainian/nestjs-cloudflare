import type { ServerResponse } from 'node:http';

import { Controller, Get, Res } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { httpServerHandler } from 'cloudflare:node';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { CloudflareModule, createWorker } from '../../src/index.js';
import { stripHopByHopHeaders } from '../../src/worker/response-headers.js';

@Controller()
class ResponseController {
  ended = false;

  @Get('headers')
  headers(@Res() response: ServerResponse): void {
    response.sendDate = false;

    response.writeHead(202, 'Bridge accepted', {
      Connection: 'keep-alive, X-Internal, x-SECOND',
      'Keep-Alive': 'timeout=5',
      'Transfer-Encoding': 'chunked',
      TE: 'trailers',
      Trailer: 'X-Trailer',
      Upgrade: 'example',
      'Proxy-Authenticate': 'Basic realm="proxy"',
      'Proxy-Authorization': 'Basic example',
      'X-Internal': 'private',
      'X-Second': 'private too',
      'X-Preserved': 'MixedCase; value="A, B"',
      'Set-Cookie': [
        'first=one; Path=/; HttpOnly',
        'second=two; Path=/; Secure',
      ],
    });

    response.end('header body');
  }

  @Get('stream')
  stream(@Res() response: ServerResponse): void {
    response.write(new Uint8Array([0, 255, 1]));
    response.flushHeaders();

    setTimeout(() => {
      this.ended = true;
      response.end(new Uint8Array([128, 2, 0]));
    }, 100);
  }

  @Get()
  read(): string {
    return 'bridged';
  }
}

async function bootstrap() {
  const module = await Test.createTestingModule({
    imports: [CloudflareModule.forRoot()],
    controllers: [ResponseController],
  }).compile();

  return module.createNestApplication({ logger: false });
}

describe('bridged response headers in workerd', () => {
  it('reproduces the implicit Connection header from the Node HTTP bridge', async () => {
    const worker = createWorker(bootstrap);

    try {
      const app = await worker.getApplication();

      const response = await httpServerHandler(app.getHttpServer()).fetch!(
        new Request('https://worker.test/') as Request<
          unknown,
          IncomingRequestCfProperties
        >,
        env,
        createExecutionContext(),
      );

      expect(response.headers.get('connection')).toBe('keep-alive');
      expect(new Response('native').headers.has('connection')).toBe(false);
      expect(await response.text()).toBe('bridged');
    } finally {
      await (await worker.getApplication()).close();
    }
  });

  it('removes implicit connection headers from createWorker responses', async () => {
    const worker = createWorker(bootstrap);

    try {
      const response = await worker.fetch(
        incoming('/'),
        env,
        createExecutionContext(),
      );

      expect(response.headers.has('connection')).toBe(false);
      expect(await response.text()).toBe('bridged');
    } finally {
      await (await worker.getApplication()).close();
    }
  });

  it('removes fixed and Connection-nominated hop headers while preserving the response', async () => {
    const worker = createWorker(bootstrap);

    try {
      const app = await worker.getApplication();

      const original = await httpServerHandler(app.getHttpServer()).fetch!(
        incoming('/headers'),
        env,
        createExecutionContext(),
      );

      const response = await worker.fetch(
        incoming('/headers'),
        env,
        createExecutionContext(),
      );

      const removed = [
        'connection',
        'keep-alive',
        'transfer-encoding',
        'te',
        'trailer',
        'upgrade',
        'proxy-authenticate',
        'proxy-authorization',
        'x-internal',
        'x-second',
      ];

      for (const name of removed) {
        expect(original.headers.has(name), `Bridge must expose ${name}`).toBe(
          true,
        );

        expect(response.headers.has(name), `Worker must remove ${name}`).toBe(
          false,
        );
      }

      const expected = new Headers(original.headers);

      for (const name of removed) {
        expected.delete(name);
      }

      expect(response.status).toBe(original.status);
      expect(response.statusText).toBe(original.statusText);
      expect([...response.headers]).toEqual([...expected]);

      expect(response.headers.getSetCookie()).toEqual([
        'first=one; Path=/; HttpOnly',
        'second=two; Path=/; Secure',
      ]);

      expect(await response.text()).toBe(await original.text());
    } finally {
      await (await worker.getApplication()).close();
    }
  });

  it('delivers the first binary chunk before the delayed source ends', async () => {
    const worker = createWorker(bootstrap);

    try {
      const app = await worker.getApplication();

      const response = await worker.fetch(
        incoming('/stream'),
        env,
        createExecutionContext(),
      );

      const reader = response.body!.getReader();
      const first = await reader.read();

      expect(app.get(ResponseController).ended).toBe(false);
      expect(first.done).toBe(false);
      expect([...first.value!]).toEqual([0, 255, 1]);
      expect(response.headers.has('connection')).toBe(false);
      expect(response.headers.has('transfer-encoding')).toBe(false);

      const remaining: number[] = [];

      for (;;) {
        const chunk = await reader.read();

        if (chunk.done) {
          break;
        }

        remaining.push(...chunk.value);
      }

      expect(remaining).toEqual([128, 2, 0]);
      expect(app.get(ResponseController).ended).toBe(true);
    } finally {
      await (await worker.getApplication()).close();
    }
  });

  it('returns the application fallback response unchanged', async () => {
    const fallback = new Response('fallback', {
      headers: { Connection: 'close', 'X-Own': 'value' },
    });

    const worker = createWorker(bootstrap, {
      fallback: { fetch: () => fallback },
    });

    try {
      const response = await worker.fetch(
        incoming('/missing'),
        env,
        createExecutionContext(),
      );

      expect(response).toBe(fallback);
      expect(response.headers.get('connection')).toBe('close');
      expect(await response.text()).toBe('fallback');
    } finally {
      await (await worker.getApplication()).close();
    }
  });
});

function incoming(path: string): Request<unknown, IncomingRequestCfProperties> {
  return new Request(`https://worker.test${path}`) as Request<
    unknown,
    IncomingRequestCfProperties
  >;
}

describe('bridge response handling in workerd', () => {
  it('keeps the original body stream and handles empty Connection list members', async () => {
    const original = new Response('unchanged', {
      status: 203,
      statusText: 'Custom status',
      headers: {
        Connection: 'X-Private, , KEEP-ALIVE, x-other',
        'X-Private': 'one',
        'X-Other': 'two',
        'X-Public': 'three',
      },
    });

    const response = stripHopByHopHeaders(original);

    expect(response.body).toBe(original.body);
    expect(original.bodyUsed).toBe(false);
    expect(original.headers.has('connection')).toBe(true);

    expect([...response.headers]).toEqual([
      ['content-type', 'text/plain;charset=UTF-8'],
      ['x-public', 'three'],
    ]);

    expect(response.status).toBe(203);
    expect(response.statusText).toBe('Custom status');
    expect(await response.text()).toBe('unchanged');
  });

  it('preserves null bodies', () => {
    const response = stripHopByHopHeaders(
      new Response(null, {
        status: 204,
        headers: { Connection: 'keep-alive' },
      }),
    );

    expect(response.body).toBeNull();
    expect(response.status).toBe(204);
    expect(response.headers.has('connection')).toBe(false);
  });

  it('returns an upgrade response and its live WebSocket unchanged', async () => {
    const pair = new WebSocketPair();
    const server = pair[1];

    server.accept();

    const original = new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
    });

    const response = stripHopByHopHeaders(original);
    const socket = response.webSocket!;

    socket.accept();

    try {
      expect(response).toBe(original);
      expect(response.webSocket).toBe(original.webSocket);
      expect(response.headers.get('connection')).toBe('Upgrade');
      expect(response.headers.get('upgrade')).toBe('websocket');

      const message = new Promise(resolve =>
        socket.addEventListener('message', event => resolve(event.data), {
          once: true,
        }),
      );

      server.send('connected');

      expect(await message).toBe('connected');
    } finally {
      socket.close();
      server.close();
    }
  });
});
