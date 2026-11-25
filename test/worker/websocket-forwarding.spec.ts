import 'reflect-metadata';

import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { CloudflareModule, createWorker } from '../../src/index.js';
import type { CloudflareWorkerOptions } from '../../src/interfaces/worker-options.interface.js';
import type { GatewayRoom } from '../ws-worker.js';

const bindings = env as Cloudflare.Env & {
  GATEWAY_ROOM: DurableObjectNamespace<GatewayRoom>;
};

@Controller()
class Routes {
  @Get('health')
  health() {
    return 'nest';
  }

  @Get('ws')
  websocket() {
    return 'express';
  }
}

async function bootstrap(): Promise<INestApplication> {
  const module = await Test.createTestingModule({
    imports: [CloudflareModule.forRoot()],
    controllers: [Routes],
  }).compile();

  return module.createNestApplication({ logger: false });
}

function request(path: string, upgrade = true) {
  return new Request(`https://worker.test${path}`, {
    headers: upgrade ? { Upgrade: 'WebSocket' } : {},
  }) as Request<unknown, IncomingRequestCfProperties>;
}

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('message', event => resolve(event.data), {
      once: true,
    });

    socket.addEventListener('error', reject, { once: true });
  });
}

function accept(response: Response): WebSocket {
  expect(response.status).toBe(101);
  expect(response.webSocket).not.toBeNull();

  const socket = response.webSocket!;

  socket.accept();

  return socket;
}

function createForwarder(
  object: NonNullable<CloudflareWorkerOptions['websockets']>[number]['object'],
) {
  return createWorker(bootstrap, {
    websockets: [
      { paths: ['/ws', '/mobula'], binding: 'GATEWAY_ROOM', object },
    ],
    fallback: { fetch: () => new Response('fallback', { status: 404 }) },
  });
}

describe('worker WebSocket forwarding', () => {
  it.each(['fixed', 'name resolver', 'id resolver'])(
    'forwards two paths to the same object using a %s',
    async mode => {
      const name = `forward-${mode}`;
      const id = bindings.GATEWAY_ROOM.idFromName(name);
      const seen: Request[] = [];

      const object =
        mode === 'fixed'
          ? name
          : (value: Request) => {
              seen.push(value);

              return mode === 'name resolver'
                ? new URL(value.url).searchParams.get('room')!
                : id;
            };

      const worker = createForwarder(object);
      const firstRequest = request(`/ws?room=${name}`);
      const secondRequest = request(`/mobula?room=${name}`);

      const first = accept(
        await worker.fetch(firstRequest, bindings, createExecutionContext()),
      );

      const second = accept(
        await worker.fetch(secondRequest, bindings, createExecutionContext()),
      );

      try {
        const firstFrame = nextMessage(first);
        const secondFrame = nextMessage(second);

        first.send(JSON.stringify({ event: 'broadcast', data: 'hello' }));

        expect(await firstFrame).toBe(`frame:hello:${id.toString()}`);
        expect(await secondFrame).toBe(`frame:hello:${id.toString()}`);

        if (mode !== 'fixed') {
          expect(seen).toEqual([firstRequest, secondRequest]);
          expect(seen[0]).toBe(firstRequest);
          expect(seen[1]).toBe(secondRequest);
        }
      } finally {
        first.close();
        second.close();
      }
    },
  );

  it('delegates non-upgrade requests to the object including its custom handler', async () => {
    const worker = createForwarder('custom-http');

    const response = await worker.fetch(
      request('/ws', false),
      bindings,
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('custom:/ws');
  });

  it('preserves the default gateway rejection for non-upgrade requests', async () => {
    const worker = createWorker(bootstrap, {
      websockets: [
        { paths: ['/chat'], binding: 'ROOM', object: 'default-http' },
      ],
    });

    const response = await worker.fetch(
      request('/chat', false),
      bindings,
      createExecutionContext(),
    );

    expect(response.status).toBe(426);
    expect(await response.text()).toBe('WebSocket upgrade required');
  });

  it('leaves unmatched paths to Nest or fallback with exact pathname matching', async () => {
    const worker = createForwarder('unmatched');

    try {
      const health = await worker.fetch(
        request('/health', false),
        bindings,
        createExecutionContext(),
      );

      expect(await health.text()).toBe('nest');
      expect(await worker.matches(request('/health', false))).toBe(true);

      for (const path of ['/WS', '/ws/']) {
        const value = request(path, false);

        expect(await worker.matches(value)).toBe(true);

        const response = await worker.fetch(
          value,
          bindings,
          createExecutionContext(),
        );

        expect(await response.text()).toBe('express');
      }

      for (const path of ['/missing', '/ws/nested']) {
        const value = request(path);

        expect(await worker.matches(value)).toBe(false);

        const response = await worker.fetch(
          value,
          bindings,
          createExecutionContext(),
        );

        expect(response.status).toBe(404);
        expect(await response.text()).toBe('fallback');
      }
    } finally {
      await (await worker.getApplication()).close();
    }
  });

  it('matches configured paths without bootstrapping Nest or resolving an object', async () => {
    const worker = createWorker(
      async () => {
        throw new Error('Unexpected Nest bootstrap');
      },
      {
        websockets: [
          {
            paths: ['/ws'],
            binding: 'GATEWAY_ROOM',
            object: () => {
              throw new Error('Unexpected object resolution');
            },
          },
        ],
      },
    );

    expect(await worker.matches(request('/ws?room=one'))).toBe(true);
    expect(await worker.matches(request('/ws', false))).toBe(true);
  });

  it('wraps forwarding in around.fetch and preserves the upgrade response identity', async () => {
    const events: string[] = [];
    let dispatched: Response | undefined;
    const value = request('/ws');
    const ctx = createExecutionContext();

    const worker = createWorker(bootstrap, {
      websockets: [
        {
          paths: ['/ws'],
          binding: 'GATEWAY_ROOM',
          object: received => {
            expect(received).toBe(value);

            events.push('resolve');

            return 'around';
          },
        },
      ],
      around: {
        async fetch(received, receivedEnv, receivedContext, next) {
          expect(received).toBe(value);
          expect(receivedEnv).toBe(bindings);
          expect(receivedContext).toBe(ctx);

          events.push('before');
          dispatched = await next();
          events.push('after');

          return dispatched;
        },
      },
    });

    const response = await worker.fetch(value, bindings, ctx);
    const socket = accept(response);

    try {
      expect(response).toBe(dispatched);
      expect(events).toEqual(['before', 'resolve', 'after']);
    } finally {
      socket.close();
    }
  });
});
