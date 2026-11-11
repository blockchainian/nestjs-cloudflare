import { CloudflareWebSocketDurableObject } from '../../src/websockets/index.js';
import { CHAT_PATH } from './chat.constants.js';
import type { Env } from './env.interface.js';
import { adapter, worker } from './runtime.js';

/**
 * Routes hibernating WebSocket events to the Nest chat gateway.
 */
export class ChatRoom extends CloudflareWebSocketDurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, {
      adapter,
      path: CHAT_PATH,
      getApplication: worker.getApplication,
    });
  }
}
