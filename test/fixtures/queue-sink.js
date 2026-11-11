export default {
  async queue(batch, env) {
    for (const message of batch.messages) {
      const packet = message.body;
      await env.STATE.put(`queue:${packet.data.id}`, JSON.stringify(packet));
      message.ack();
    }
  },
};
