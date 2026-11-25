import { Controller, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
  Ctx,
  EventPattern,
  MessagePattern,
  Payload,
} from '@nestjs/microservices';
import { Test } from '@nestjs/testing';

import {
  CloudflareDurableObject,
  CloudflareDurableObjectContext,
  CloudflareDurableObjectServer,
} from '../../src/durable-objects/index.js';
import { CloudflareModule } from '../../src/index.js';
import {
  CloudflareWebSocketAdapter,
  CloudflareWebSocketDurableObject,
  CloudflareWebSocketGatewayDurableObject,
} from '../../src/websockets/index.js';

@Injectable({ scope: Scope.REQUEST, durable: true })
class HealthyState {
  readonly starts: number[] = [];
}

@Controller()
class HealthyController {
  constructor(private readonly state: HealthyState) {}

  @MessagePattern(['healthy', { action: 'healthy', version: 1 }])
  start(@Payload() sequence: number) {
    this.state.starts.push(sequence);

    return [...this.state.starts];
  }

  @EventPattern('healthy-alarm')
  async alarm(@Ctx() context: CloudflareDurableObjectContext) {
    this.state.starts.push(0);
    await context.getState().storage.put('healthy-alarm', true);
  }
}

class FragileState {
  readonly starts: number[] = [];
}

@Controller()
class FragileController {
  constructor(private readonly state: FragileState) {}

  @MessagePattern(['fragile', 'fragile-alias'])
  start(@Payload() sequence: number) {
    this.state.starts.push(sequence);

    return [...this.state.starts];
  }

  @EventPattern('fragile-alarm')
  alarm(@Ctx() _context: CloudflareDurableObjectContext) {
    this.state.starts.push(0);
  }
}

async function createFragileState({ ctx }: { ctx: DurableObjectState }) {
  const attempts = ((await ctx.storage.get<number>('attempts')) ?? 0) + 1;

  await ctx.storage.put('attempts', attempts);

  if (!(await ctx.storage.get<boolean>('ready'))) {
    throw new Error('Missing DB');
  }

  return new FragileState();
}

const server = new CloudflareDurableObjectServer();
const adapter = new CloudflareWebSocketAdapter();
let application: ReturnType<typeof bootstrap> | undefined;

async function bootstrap() {
  const module = await Test.createTestingModule({
    imports: [CloudflareModule.forRoot()],
    controllers: [HealthyController, FragileController],
    providers: [
      HealthyState,
      {
        provide: FragileState,
        scope: Scope.REQUEST,
        durable: true,
        inject: [REQUEST],
        useFactory: createFragileState,
      },
    ],
  }).compile();

  const app = module.createNestApplication({ logger: false });

  app.useWebSocketAdapter(adapter);
  app.connectMicroservice({ strategy: server });
  await app.init();
  await app.startAllMicroservices();

  return app;
}

function options(alarmPattern: string) {
  return {
    adapter,
    getApplication: () => (application ??= bootstrap()),
    transport: { server, alarmPattern },
  };
}

export class HealthyNativeRoom extends CloudflareDurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    const configuration = options('healthy-alarm');

    super(ctx, env, { ...configuration.transport, ...configuration });
  }
}

export class FragileNativeRoom extends CloudflareDurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    const configuration = options('fragile-alarm');

    super(ctx, env, { ...configuration.transport, ...configuration });
  }
}

export class HealthyActiveRoom extends CloudflareWebSocketGatewayDurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env, { ...options('healthy-alarm'), paths: ['/events'] });
  }
}

export class FragileActiveRoom extends CloudflareWebSocketGatewayDurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env, { ...options('fragile-alarm'), paths: ['/events'] });
  }
}

export class HealthyHibernatingRoom extends CloudflareWebSocketDurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env, { ...options('healthy-alarm'), path: '/events' });
  }
}

export class FragileHibernatingRoom extends CloudflareWebSocketDurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env, { ...options('fragile-alarm'), path: '/events' });
  }
}
