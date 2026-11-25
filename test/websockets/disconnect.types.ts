import type { OnGatewayDisconnect } from '@nestjs/websockets';
import { expectTypeOf } from 'vitest';

import type {
  CloudflareWebSocketAdapter,
  OnCloudflareWebSocketDisconnect,
} from '../../src/websockets/index.js';

expectTypeOf<{
  handleDisconnect(client: WebSocket): void;
}>().toExtend<OnCloudflareWebSocketDisconnect>();

expectTypeOf<{
  handleDisconnect(client: WebSocket, reason?: string): void;
}>().toExtend<OnCloudflareWebSocketDisconnect>();

expectTypeOf<OnCloudflareWebSocketDisconnect>().toExtend<
  OnGatewayDisconnect<WebSocket>
>();

expectTypeOf<(reason?: string) => void>().toExtend<
  Parameters<CloudflareWebSocketAdapter['bindClientDisconnect']>[1]
>();
