import { Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { env, withEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { CloudflareModule } from '../src/cloudflare.module.js';
import { CLOUDFLARE_ENV } from '../src/constants.js';
import { InjectBinding } from '../src/decorators/inject-binding.decorator.js';

type Environment = Record<string, unknown>;
type State = KVNamespace;
type RpcEnvironment = { SERVICE: { ping(): Promise<string> } };

@Injectable()
class Reader {
  constructor(@Inject(CLOUDFLARE_ENV) public readonly bindings: Environment) {}
}

describe('CloudflareModule', () => {
  describe('forRoot', () => {
    it('should preserve the native environment object and optional variables', async () => {
      await withEnv({ STATE: env.STATE, DATABASE: env.DATABASE }, async () => {
        const module = await Test.createTestingModule({
          imports: [CloudflareModule.forRoot()],
          providers: [Reader],
        }).compile();

        try {
          const injected = module.get(Reader).bindings;

          expect(injected).toBe(env);
          expect('STATE' in injected).toBe(true);
          expect(Object.keys(injected)).toEqual(Object.keys(env));
          expect({ ...injected }).toEqual({ ...env });
          expect(injected.OPTIONAL_FLAG).toBeUndefined();
          expect(() => JSON.stringify(injected)).not.toThrow();

          const scoped = await withEnv({ SCOPED_FLAG: 'scoped' }, async () => {
            await Promise.resolve();

            return injected.SCOPED_FLAG;
          });

          expect(scoped).toBe('scoped');
          expect(injected.SCOPED_FLAG).toBeUndefined();
        } finally {
          await module.close();
        }
      });
    });

    it.each(['service', 'durable object'])(
      'should start with a native %s RPC binding accessible through the environment',
      async kind => {
        const stub =
          kind === 'service' ? env.RPC_SERVICE : await env.RPC_SERVICE.object();

        await withEnv({ SERVICE: stub, STATE: env.STATE }, async () => {
          @Injectable()
          class RpcConsumer {
            constructor(
              @Inject(CLOUDFLARE_ENV) public readonly bindings: RpcEnvironment,
              @InjectBinding('STATE') public readonly state: State,
            ) {}
          }

          const module = await Test.createTestingModule({
            imports: [CloudflareModule.forRoot()],
            providers: [RpcConsumer],
          }).compile();

          try {
            await module.init();
            const consumer = module.get(RpcConsumer);

            expect(await consumer.bindings.SERVICE.ping()).toBe('pong');
            expect(consumer.state).toBe(env.STATE);

            await consumer.state.put('rpc-startup', kind);

            expect(await consumer.state.get('rpc-startup')).toBe(kind);
          } finally {
            await module.close();
          }
        });
      },
    );

    it('should share the native environment across feature root imports', async () => {
      await withEnv({ STATE: env.STATE, DATABASE: env.DATABASE }, async () => {
        @Module({ imports: [CloudflareModule.forRoot()] })
        class FirstFeature {}
        @Module({ imports: [CloudflareModule.forRoot()] })
        class SecondFeature {}

        const module = await Test.createTestingModule({
          imports: [FirstFeature, SecondFeature],
        }).compile();

        try {
          expect(
            module
              .get<Environment>(CLOUDFLARE_ENV, { each: true })
              .every(value => value === env),
          ).toBe(true);
        } finally {
          await module.close();
        }
      });
    });
  });
});

describe('InjectBinding', () => {
  it('should inject a native DurableObjectNamespace and use its stub', async () => {
    await withEnv({ ROOM: env.ROOM }, async () => {
      @Injectable()
      class RoomConsumer {
        constructor(
          @InjectBinding('ROOM') public readonly rooms: typeof env.ROOM,
        ) {}
      }

      const module = await Test.createTestingModule({
        imports: [CloudflareModule.forRoot()],
        providers: [RoomConsumer],
      }).compile();

      try {
        await module.init();
        const rooms = module.get(RoomConsumer).rooms;

        expect(rooms).toBe(env.ROOM);

        const response = await rooms
          .getByName('injected')
          .fetch('https://worker.test/chat');

        expect(response.status).toBe(426);
      } finally {
        await module.close();
      }
    });
  });

  it('should leave RPC bindings to Nest dependency resolution', async () => {
    await withEnv({ SERVICE: env.RPC_SERVICE }, async () => {
      @Injectable()
      class RpcConsumer {
        constructor(
          @InjectBinding('SERVICE') public readonly service: unknown,
        ) {}
      }

      await expect(
        Test.createTestingModule({
          imports: [CloudflareModule.forRoot()],
          providers: [RpcConsumer],
        }).compile(),
      ).rejects.toThrow('cloudflare:binding:SERVICE');
    });
  });

  it('should leave an absent binding to Nest dependency resolution', async () => {
    await withEnv({ STATE: env.STATE }, async () => {
      @Injectable()
      class MissingBindingConsumer {
        constructor(
          @InjectBinding('MISSING_BINDING') public readonly missing: unknown,
        ) {}
      }

      await expect(
        Test.createTestingModule({
          imports: [CloudflareModule.forRoot()],
          providers: [MissingBindingConsumer],
        }).compile(),
      ).rejects.toThrow('cloudflare:binding:MISSING_BINDING');
    });
  });
});
