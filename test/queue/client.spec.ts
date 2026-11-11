import { ClientsModule } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { env } from 'cloudflare:workers';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { CloudflareQueueClient } from '../../src/queue/client.js';

/** Records the serialized packet while retaining the real Queue write. */
class PacketSerializer {
  public packet: unknown;

  public serialize(packet: unknown) {
    this.packet = packet;

    return packet;
  }
}

describe('CloudflareQueueClient', () => {
  describe('emit', () => {
    it('should register through ClientsModule and serialize normalized patterns with dispatch metadata', async () => {
      const serializer = new PacketSerializer();

      const module = await Test.createTestingModule({
        imports: [
          ClientsModule.register([
            {
              name: 'EVENTS',
              customClass: CloudflareQueueClient,
              options: { queue: env.OUTBOX, serializer },
            },
          ]),
        ],
      }).compile();

      const client = module.get<CloudflareQueueClient>('EVENTS');

      client.setOnDispatchHook(packet => {
        packet.metadata = { trace: 'queue-trace' };
      });

      await firstValueFrom(
        client.emit({ version: 1, task: 'notice' }, { id: 'published' }),
      );

      expect(serializer.packet).toEqual({
        pattern: '{"task":"notice","version":1}',
        data: { id: 'published' },
        metadata: { trace: 'queue-trace' },
      });

      await vi.waitFor(async () => {
        expect(await env.STATE.get('queue:published', 'json')).toEqual(
          serializer.packet,
        );
      });

      expect(await client.connect()).toBe(env.OUTBOX);
      expect(client.unwrap()).toBe(env.OUTBOX);

      await module.close();
    });
  });

  describe('send', () => {
    it('should reject request-response messaging', async () => {
      const module = await Test.createTestingModule({
        providers: [
          {
            provide: CloudflareQueueClient,
            useFactory: () => new CloudflareQueueClient({ queue: env.OUTBOX }),
          },
        ],
      }).compile();

      const client = module.get(CloudflareQueueClient);

      await expect(
        firstValueFrom(client.send('notice', 'body')),
      ).rejects.toThrow('supports emit()');

      await module.close();
    });
  });
});
