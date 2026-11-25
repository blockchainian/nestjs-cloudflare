import 'reflect-metadata';

import type { CloudflareQueueContext } from '../../src/queue/context.js';
import { CloudflareQueueServer } from '../../src/queue/server.js';

interface Payload {
  id: string;
  action: 'locked' | 'invalid' | 'valid';
}

export default {
  async queue(
    batch: MessageBatch<Payload>,
    env: { STATE: KVNamespace },
    ctx: ExecutionContext,
  ) {
    const server = new CloudflareQueueServer({ noAck: false });

    server.addHandler(
      'manual-retry',
      async (data: Payload, context: CloudflareQueueContext) => {
        const message = context.getMessage();
        const key = `manual:${data.id}`;
        const deliveries = (await env.STATE.get<number[]>(key, 'json')) ?? [];

        deliveries.push(Date.now());
        await env.STATE.put(key, JSON.stringify(deliveries));

        if (data.action === 'locked' && message.attempts === 1) {
          message.retry({ delaySeconds: 1 });
        } else {
          message.ack();
        }
      },
      true,
    );

    await server.consume(batch, ctx);
  },
};
