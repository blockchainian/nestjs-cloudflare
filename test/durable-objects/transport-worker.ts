import 'reflect-metadata';

import { Controller, Injectable, Scope } from '@nestjs/common';
import {
  Ctx,
  EventPattern,
  MessagePattern,
  Payload,
  RpcException,
} from '@nestjs/microservices';
import { Test } from '@nestjs/testing';

import {
  CloudflareDurableObject,
  CloudflareDurableObjectContext,
  CloudflareDurableObjectServer,
} from '../../src/durable-objects/index.js';
import { CloudflareModule, CloudflareRequestContext } from '../../src/index.js';

@Injectable({ scope: Scope.REQUEST, durable: true })
class ObjectService {
  readonly id = crypto.randomUUID();
  readonly starts: number[] = [];
  release: (() => void) | undefined;
}

@Controller()
class ObjectController {
  constructor(
    private readonly object: ObjectService,
    private readonly request: CloudflareRequestContext,
  ) {}

  @MessagePattern('start-order')
  startOrder(@Payload() sequence: number) {
    this.object.starts.push(sequence);
    this.object.release?.();

    return [...this.object.starts];
  }

  @MessagePattern('hold')
  async hold() {
    this.object.starts.push(1);

    await new Promise<void>(resolve => {
      this.object.release = resolve;
    });

    return [...this.object.starts];
  }

  @MessagePattern('increment')
  async increment(
    @Payload() amount: number,
    @Ctx() context: CloudflareDurableObjectContext,
  ) {
    const count = await context
      .getState()
      .storage.transaction(async storage => {
        const next = ((await storage.get<number>('count')) ?? 0) + amount;

        await storage.put('count', next);

        return next;
      });

    return {
      count,
      provider: this.object.id,
      pattern: context.getPattern(),
      owner: context.getState().id.toString(),
    };
  }

  @EventPattern<string>('event-lost')
  eventLost(): never {
    throw new RpcException({ code: 'LEASE_LOST' });
  }

  @MessagePattern('lost')
  lost() {
    throw new RpcException({
      code: 'LEASE_LOST',
      message: 'Job lease was lost',
      details: { owner: 'previous' },
    });
  }

  @MessagePattern('context')
  context(@Ctx() context: CloudflareDurableObjectContext) {
    this.request
      .getExecutionContext()
      .waitUntil(context.getState().storage.put('background', true));

    return {
      sameEnv: this.request.getEnv() === context.getEnv(),
      request: this.request.getRequest() === undefined,
    };
  }

  @EventPattern('alarm')
  async alarm(@Ctx() context: CloudflareDurableObjectContext) {
    this.object.starts.push(0);

    this.request
      .getExecutionContext()
      .waitUntil(context.getState().storage.put('alarm-background', true));

    await context.getState().storage.put('alarm', {
      provider: this.object.id,
      sameEnv: this.request.getEnv() === context.getEnv(),
      pattern: context.getPattern(),
    });
  }
}

const server = new CloudflareDurableObjectServer();
let application: ReturnType<typeof bootstrap> | undefined;

async function bootstrap() {
  const module = await Test.createTestingModule({
    imports: [CloudflareModule.forRoot()],
    controllers: [ObjectController],
    providers: [ObjectService],
  }).compile();

  const app = module.createNestApplication();

  app.connectMicroservice({ strategy: server });
  await app.init();
  await app.startAllMicroservices();

  return app;
}

export class TransportRoom extends CloudflareDurableObject {
  constructor(state: DurableObjectState, env: Cloudflare.Env) {
    super(state, env, {
      server,
      getApplication: () => (application ??= bootstrap()),
      alarmPattern: 'alarm',
    });
  }
}
