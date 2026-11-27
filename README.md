# nestjs-cloudflare

Run NestJS on Cloudflare Workers with binding injection, scheduled events, Queues, Durable Objects, and TypeORM for Postgres.

## Installation

```sh
npm install nestjs-cloudflare @nestjs/common@12 @nestjs/core@12 @nestjs/platform-express@12 reflect-metadata rxjs
```

Generate Workers types with `wrangler types` or install a compatible `@cloudflare/workers-types` version. See the [peer dependency ranges](package.json). The examples omit some imports and application types.

## Worker application

Enable `nodejs_compat` and `enable_nodejs_http_server_modules` in Wrangler. Compile TypeScript with `experimentalDecorators` and `emitDecoratorMetadata`, then point Wrangler at the emitted JavaScript.

```ts
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CloudflareModule, createWorker } from 'nestjs-cloudflare';

@Module({ imports: [CloudflareModule.forRoot()] })
class AppModule {}

const bootstrap = () => NestFactory.create(AppModule);

export default createWorker(bootstrap);
```

### Event dispatch and routing

`createWorker` defers Nest startup until an event and reuses the application. Set `microservicesStarted: true` if bootstrap starts the connected microservices itself.

| API                                                      | Use                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `worker.matches(request)`                                | Check for a Nest route or a configured WebSocket path.                               |
| `around.fetch`, `around.scheduled`, `around.queue`       | Wrap event dispatch with a hook that receives the native event arguments and `next`. |
| `fallback.fetch`, `fallback.scheduled`, `fallback.queue` | Handle events without a matching Nest route or handler.                              |
| `routing`                                                | Validate Express path settings and control implicit `HEAD` matching.                 |

## Bindings

### Binding injection

```ts
import { CLOUDFLARE_ENV, InjectBinding } from 'nestjs-cloudflare';

@Injectable()
class StateService {
  constructor(
    @InjectBinding<Env>('STATE') private readonly state: KVNamespace,
    @Inject(CLOUDFLARE_ENV) private readonly env: Env,
  ) {}

  read() {
    return this.state.get(this.env.LABEL);
  }
}
```

`CloudflareModule.forRoot()` registers bindings and variables. Use `getBindingToken<Env>('STATE')` in a factory provider's `inject` list. Access Workers RPC service bindings through `CLOUDFLARE_ENV`.

### Event context

Inject `CloudflareRequestContext` to read the current request, environment, and execution context.

## Scheduled events

Install `@nestjs/schedule` and import `CloudflareScheduleModule.forRoot()` from `nestjs-cloudflare/schedule` in the root module. Cloudflare supplies the events, so omit Nest's `ScheduleModule`.

### Cron handlers

Register the handler as a singleton provider. Match its five-field expression in Wrangler's `triggers.crons`. Workers cron triggers use UTC.

```ts
@Injectable()
class DigestJob {
  @Cron('0 8 * * *')
  run(event: ScheduledController) {
    console.log('Running digest', event.cron);
  }
}
```

## Queues

Install `@nestjs/microservices` and configure the Wrangler queue producer and consumer. Use `nestjs-cloudflare/queue` to publish with `ClientProxy.emit()` and receive with `@EventPattern`.

### Producers and consumers

Connect the server in bootstrap. Add the client registration to a module's imports, inject its token, and register the handler as a controller.

```ts
// In bootstrap:
app.connectMicroservice({ strategy: new CloudflareQueueServer() });

const notifications = ClientsModule.register([
  {
    name: 'NOTIFICATIONS',
    customClass: CloudflareQueueClient,
    options: { queue: env.NOTIFICATIONS },
  },
]);

// Use the ClientProxy injected with @Inject('NOTIFICATIONS').
async function publish(client: ClientProxy, text: string) {
  const record = new CloudflareQueueRecordBuilder(text)
    .setOptions({ delaySeconds: 60 })
    .build();
  await firstValueFrom(client.emit('notify', record));
}

@Controller()
class Notifications {
  @EventPattern('notify', CLOUDFLARE_QUEUE_TRANSPORT)
  receive(@Payload() text: string) {
    console.log(text);
  }
}
```

### Acknowledgement and concurrency

By default, the server acknowledges successful messages and retries failures. For manual acknowledgement, set `noAck: false` and inject `CloudflareQueueContext` with `@Ctx()` to access the native message. Set `concurrency: 'parallel'` to process a batch concurrently. Messages from producers outside Nest use the queue name as their pattern.

## Durable Objects

Export each object class from the Worker entry point. Add its binding and migration in Wrangler. See the [example configuration](example/wrangler.jsonc).

For a native Durable Object, call `await worker.getApplication()` inside an event and use `app.get(Service)` to retrieve a Nest singleton.

### WebSockets and hibernation

Install `@nestjs/websockets` and import the adapter and host from `nestjs-cloudflare/websockets`. Register the gateway as a provider.

```ts
@WebSocketGateway({ path: '/chat' })
class ChatGateway {
  @SubscribeMessage('echo')
  echo(@MessageBody() data: unknown) {
    return data;
  }
}

const adapter = new CloudflareWebSocketAdapter();
const worker = createWorker<Env>(
  async () => {
    const app = await bootstrap();
    app.useWebSocketAdapter(adapter);
    return app;
  },
  { websockets: [{ paths: ['/chat'], binding: 'CHAT', object: 'lobby' }] },
);

export class ChatRoom extends CloudflareWebSocketDurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, {
      adapter,
      path: '/chat',
      getApplication: worker.getApplication,
    });
  }
}

export default worker;
```

Send `{"event":"echo","data":"hello"}` to receive the JSON value `"hello"`. The forwarding rule can also resolve an object name or ID from the request. Store state that must survive hibernation in Durable Object storage or socket attachments.

Use `CloudflareWebSocketGatewayDurableObject` with `paths` for a non-hibernating host that keeps sessions in memory. Use `getCloudflareWebSocketContext(socket)` to access the owning object and its sockets.

Customize frames with `messageParser` and `messageSerializer`. Set `maxConcurrentMessages: 1` to serialize handlers per connection. Implement `OnCloudflareWebSocketDisconnect` and call `getCloudflareWebSocketDisconnectEvent(reason)` to distinguish a close from a terminal socket error. See the [WebSocket exports](src/websockets/index.ts).

### Durable Object microservices

Install `@nestjs/microservices`. Use `nestjs-cloudflare/durable-objects` for native RPC and alarms. This transport requires a Workers compatibility date of `2024-04-03` or later.

Connect the server in bootstrap, register the client module in imports, and register the handlers as a controller.

```ts
const server = new CloudflareDurableObjectServer();
// In bootstrap: app.connectMicroservice({ strategy: server });

export class JobLease extends CloudflareDurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, { server, getApplication: worker.getApplication });
  }
}

@Controller()
class Leases {
  @MessagePattern('owner')
  async owner(@Ctx() context: CloudflareDurableObjectContext) {
    return (await context.getState().storage.get<string>('owner')) ?? null;
  }

  @EventPattern('alarm')
  async expire(@Ctx() context: CloudflareDurableObjectContext) {
    await context.getState().storage.delete('owner');
  }
}

const leases = ClientsModule.register([
  {
    name: 'LEASES',
    customClass: CloudflareDurableObjectClient,
    options: { namespace: env.LEASES },
  },
]);

// Use the ClientProxy injected with @Inject('LEASES').
function readOwner(client: ClientProxy) {
  const record = new CloudflareDurableObjectRecordBuilder(null)
    .setOptions({ name: 'daily-job' })
    .build();
  return firstValueFrom(client.send('owner', record));
}
```

Address an existing object with `{ id: id.toString() }`. Use `emit()` for event handlers. Schedule a native alarm with `context.getState().storage.setAlarm(timestamp)` and select its event pattern with `alarmPattern`. Either WebSocket host can serve RPC and alarms by setting `transport: { server, alarmPattern }`.

### Dependency scopes

Register providers with `Scope.REQUEST` and `durable: true` to reuse them across events in one active object. Ordinary request-scoped providers stay event- or connection-scoped. Singletons are shared by the application.

Inject durable providers into gateways and RPC controllers. In WebSocket host methods, use `this.resolve(token)`.

```ts
@Injectable({ scope: Scope.REQUEST, durable: true })
class ObjectCounter {
  count = 0;
}

// Inside a native Durable Object event:
const counter = await resolveForDurableObject(
  await worker.getApplication(),
  this.ctx,
  ObjectCounter,
);
counter.count++;
```

Use `getDurableObjectContextId(ctx)` for direct Nest context resolution. See the [scope helpers](src/durable-objects/context.ts).

## TypeORM

Install `@nestjs/typeorm@12`, `typeorm@1`, and `pg@8`. Use `nestjs-cloudflare/typeorm` to share a Postgres DataSource across the application while each event supplies its own connection pool. Create the pool in the event and close it after the event's database work finishes.

### Wrangler configuration

Enable `nodejs_compat` and add these entries to `wrangler.toml`.

```toml
[alias]
"typeorm" = "./node_modules/typeorm/index.js"

[define]
"import.meta.url" = "\"file:///index.js\""
```

- The `typeorm` alias selects the Node entry with the Postgres driver.
- The `import.meta.url` define gives Nest TypeORM's `createRequire` a file URL. Repeat it in `[env.<name>.define]` for each named environment.

### Module registration and event pools

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { CloudflareTypeOrmModule } from 'nestjs-cloudflare/typeorm';
import { Pool } from 'pg';

const pools = new AsyncLocalStorage<Pool>();

@Injectable()
class Accounts {
  constructor(@InjectRepository(Account) readonly rows: Repository<Account>) {}
}

@Module({
  imports: [TypeOrmModule.forFeature([Account])],
  providers: [Accounts],
})
class AccountsModule {}

@Module({
  imports: [
    CloudflareModule.forRoot(),
    CloudflareTypeOrmModule.forRoot({
      connectionPool: () => {
        const pool = pools.getStore();
        if (!pool) throw new Error('No database pool is active');
        return pool;
      },
      autoLoadEntities: true,
    }),
    AccountsModule,
  ],
})
class AppModule {}

export default createWorker<Env>(() => NestFactory.create(AppModule), {
  around: {
    async fetch(_request, env, _ctx, next) {
      const pool = new Pool({
        connectionString: env.DATABASE.connectionString,
      });
      try {
        return await pools.run(pool, next);
      } finally {
        await pool.end();
      }
    },
  },
});
```

Here `Account` is a TypeORM entity and `Env.DATABASE` is a Hyperdrive binding. Use the same pool scope for scheduled and queue handlers that use the database. Apply migrations before starting the Worker. Set `namingStrategy: new SnakeNamingStrategy()` to use snake case for inferred column names. See [TypeORM options](src/typeorm/typeorm.module.ts).

## Local development

Start the [Worker example](example/wrangler.jsonc) with `yarn wrangler dev --config example/wrangler.jsonc --test-scheduled` or the [WebSocket example](example/websockets/wrangler.jsonc) with `yarn wrangler dev --config example/websockets/wrangler.jsonc`.
