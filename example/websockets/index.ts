import { CHAT_PATH } from './chat.constants.js';
import type { Env } from './env.interface.js';
import { worker } from './runtime.js';

export { ChatRoom } from './chat-room.durable-object.js';

export default {
  ...worker,
  async fetch(
    request: Request<unknown, IncomingRequestCfProperties>,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (new URL(request.url).pathname === CHAT_PATH) {
      const id = env.CHAT.idFromName('lobby');

      return env.CHAT.get(id).fetch(request);
    }

    return worker.fetch(request, env, ctx);
  },
};
