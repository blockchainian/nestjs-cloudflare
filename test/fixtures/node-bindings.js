import { DurableObject } from 'cloudflare:workers';

export class Room extends DurableObject {
  fetch() {
    return new globalThis.Response('forwarded');
  }

  dispatch(packet) {
    return [{ response: packet.data, isDisposed: true }];
  }
}

export default {
  async queue(batch, env) {
    for (const message of batch.messages) {
      await env.STATE.put(message.body.data.id, JSON.stringify(message.body));
      message.ack();
    }
  },
};
