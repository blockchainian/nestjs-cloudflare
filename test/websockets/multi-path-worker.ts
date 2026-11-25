import { Test } from '@nestjs/testing';
import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';

import {
  CloudflareWebSocketAdapter,
  CloudflareWebSocketGatewayDurableObject,
} from '../../src/websockets/index.js';

@WebSocketGateway({ path: '/ws' })
class FirstGateway {
  @SubscribeMessage('echo')
  echo(@MessageBody() data: string) {
    return { protocol: 'ws', data };
  }
}

@WebSocketGateway({ path: '/mobula' })
class SecondGateway {
  @SubscribeMessage('echo')
  echo(@MessageBody() data: string) {
    return { protocol: 'mobula', data };
  }
}

async function bootstrap(adapter: CloudflareWebSocketAdapter) {
  const module = await Test.createTestingModule({
    providers: [FirstGateway, SecondGateway],
  }).compile();

  const app = module.createNestApplication();

  app.useLogger(false);
  app.useWebSocketAdapter(adapter);
  await app.init();

  return app;
}

export class MultiGatewayRoom extends CloudflareWebSocketGatewayDurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    const adapter = new CloudflareWebSocketAdapter();
    const application = bootstrap(adapter);

    super(ctx, env, {
      adapter,
      paths: ['/ws', '/mobula', '/alias'],
      getApplication: () => application,
    });
  }
}
