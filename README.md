# nestjs-cloudflare

Run a Nest application on Cloudflare Workers with binding injection, scheduled events, Queues, and hibernating Durable Object WebSockets.

## Installation

```sh
npm install nestjs-cloudflare
npm install @nestjs/common @nestjs/core reflect-metadata rxjs
```

Install your chosen Nest HTTP platform, such as `@nestjs/platform-express`. Queues require `@nestjs/microservices`, scheduled handlers require `@nestjs/schedule`, and gateways require `@nestjs/websockets`. These integrations are optional peers exposed through separate package entry points. Use versions compatible with this package's peer dependency ranges.

The npm package includes compiled JavaScript and type declarations. Applications also need Cloudflare's runtime type declarations, supplied by `wrangler types` or a compatible `@cloudflare/workers-types` package.

## Application

```ts
import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CloudflareModule, createWorker } from 'nestjs-cloudflare';

@Controller()
class AppController {
  @Get()
  hello(): string {
    return 'Hello from Nest';
  }
}

@Module({
  imports: [CloudflareModule.forRoot()],
  controllers: [AppController],
})
class AppModule {}

async function bootstrap() {
  return NestFactory.create(AppModule, { rawBody: true });
}

export default createWorker(bootstrap);
```

`createWorker` synchronously returns Worker handlers. The first event runs `bootstrap` once, initializes the application, starts connected microservices, and opens its Node HTTP server on an ephemeral port. Later events share the same application. `worker.getApplication()` returns a promise for that application and also starts it when called by a Durable Object.

Keep Nest creation inside `bootstrap`. Cloudflare's upload validation runs module initialization without all bindings and disallows I/O and random number generation. Deferring Nest startup to an event avoids those restrictions. Choose HTTP adapters, application options, global guards, pipes, filters, and interceptors in your bootstrap function.

For incremental HTTP migration, pass a native fallback. `fetch` checks the initialized Express route table before dispatch and leaves unmatched request bodies untouched:

```ts
const worker = createWorker(bootstrap, {
  fallback: {
    fetch(request, env, ctx) {
      return legacyRouter.fetch(request, env, ctx);
    },
  },
  routing: { caseSensitive: true, strict: true },
});

await worker.matches(request); // true when Nest owns the method and path
```

Use `around.fetch`, `around.scheduled`, or `around.queue` to wrap complete event dispatch. Each hook receives the native event values and a `next` function. `CloudflareRequestContext` is a singleton provider exported by `CloudflareModule.forRoot()`; inject it to read `getRequest()`, `getEnv()`, and `getExecutionContext()` from the current event.

## Bindings

`CloudflareModule.forRoot()` registers global providers for the bindings in `cloudflare:workers`' imported `env`. Import it once in the root module. Bindings are injected directly, including primitive variables.

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  CLOUDFLARE_ENV,
  InjectBinding,
  getBindingToken,
} from 'nestjs-cloudflare';

interface Env {
  STATE: KVNamespace;
  LABEL: string;
}

@Injectable()
class StateService {
  constructor(
    @InjectBinding<Env>('STATE') private readonly state: KVNamespace,
    @Inject(CLOUDFLARE_ENV) private readonly env: Env,
  ) {}

  read(): Promise<string | null> {
    return this.state.get(this.env.LABEL);
  }
}

const stateToken = getBindingToken<Env>('STATE');
```

RPC bindings expose callable lifecycle properties, so they are excluded from individual providers to prevent Nest from invoking remote lifecycle methods. Inject `CLOUDFLARE_ENV` and call the binding through `env.MY_SERVICE` instead. Using `@InjectBinding` for an RPC binding produces Nest's unresolved-dependency error.

The optional generic restricts binding names to keys of the application's environment. Injecting a binding absent from the runtime environment produces Nest's unresolved-dependency error. Tests can configure bindings in Miniflare or scope imported `env` with `withEnv` from `cloudflare:workers` before creating the application.

## Scheduled events

Install `@nestjs/schedule`, import `CloudflareScheduleModule.forRoot()` from `nestjs-cloudflare/schedule`, and use the official decorator:

```ts
import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { env } from 'cloudflare:workers';

@Injectable()
class DigestService {
  @Cron(env.DIGEST_CRON as string)
  async digest(controller: ScheduledController): Promise<void> {
    await env.STATE.put('last-cron', controller.cron);
  }
}
```

Register the service as a provider. Do not import Nest's `ScheduleModule`: Cloudflare supplies scheduled events, so no in-process timer is needed. Configure the variable and trigger together in Wrangler:

```jsonc
{
  "vars": { "DIGEST_CRON": "0 8 * * *" },
  "triggers": { "crons": ["0 8 * * *"] },
}
```

Expressions must have five fields and match `ScheduledController.cron` exactly. Workers schedules use UTC. Empty and six-field expressions produce startup warnings; six-field values from Nest's `CronExpression` enum cannot match Workers triggers. Every matching method runs. Non-static providers are skipped with a warning.

`disabled` suppresses a handler. `waitForCompletion` skips overlapping invocations within one isolate. Timer-specific options such as `timeZone` do not configure Cloudflare triggers. Scheduled processing is registered with `ctx.waitUntil`; handler failures are reported after `scheduled()` returns. Unmatched events use `fallback.scheduled` when provided and otherwise produce a warning.

## Queues

Install `@nestjs/microservices`. Connect the queue transport during bootstrap so Nest can register handlers and inherit application configuration:

```ts
import { CloudflareQueueServer } from 'nestjs-cloudflare/queue';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.connectMicroservice(
    { strategy: new CloudflareQueueServer({ noAck: true }) },
    { inheritAppConfig: true },
  );
  return app;
}
```

Register a producer through Nest's `ClientsModule` and inject its client:

```ts
import { Inject, Injectable, Module } from '@nestjs/common';
import { ClientProxy, ClientsModule } from '@nestjs/microservices';
import { env } from 'cloudflare:workers';
import { firstValueFrom } from 'rxjs';
import { CloudflareQueueClient } from 'nestjs-cloudflare/queue';

@Injectable()
class NotificationsService {
  constructor(@Inject('NOTIFICATIONS') private readonly client: ClientProxy) {}

  async notify(text: string): Promise<void> {
    await firstValueFrom(this.client.emit('notifications', text));
  }
}

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'NOTIFICATIONS',
        customClass: CloudflareQueueClient,
        options: { queue: env.NOTIFICATIONS },
      },
    ]),
  ],
  providers: [NotificationsService],
})
class NotificationsModule {}
```

For dependency injection into the client factory, use `ClientsModule.registerAsync` with `inject: [getBindingToken<Env>('NOTIFICATIONS')]` and return `{ customClass: CloudflareQueueClient, options: { queue } }`. Client and server options accept Nest serializers and deserializers. `emit` sends the Nest event packet, preserving its pattern and metadata. One Queue can carry multiple patterns. `send` rejects because Cloudflare Queues do not support request-response messaging.

```ts
import { Controller } from '@nestjs/common';
import { InjectBinding } from 'nestjs-cloudflare';
import { Ctx, EventPattern, Payload } from '@nestjs/microservices';
import {
  CLOUDFLARE_QUEUE_TRANSPORT,
  CloudflareQueueContext,
} from 'nestjs-cloudflare/queue';

@Controller()
class NotificationsController {
  constructor(@InjectBinding('STATE') private readonly state: KVNamespace) {}

  @EventPattern('notifications', CLOUDFLARE_QUEUE_TRANSPORT)
  async receive(
    @Payload() text: string,
    @Ctx() context: CloudflareQueueContext,
  ): Promise<void> {
    await this.state.put('last-notification', text);
  }
}
```

The context exposes the original message, batch, execution context, and pattern. For messages sent by other producers without a Nest packet, the Queue name is the event pattern. Successful messages are acknowledged automatically by default. Set `noAck: false` and call `context.getMessage().ack()` for manual acknowledgement. Failed handlers request retries in either mode.

Batches are sequential by default. Set `concurrency: 'parallel'` on the server to process messages concurrently. Unhandled messages use `fallback.queue` when supplied. Missing transports and unhandled events are reported explicitly. Fallbacks are passed as the second argument to `createWorker`:

```ts
const worker = createWorker(bootstrap, {
  fallback: {
    async queue(batch, env, ctx) {
      batch.ackAll();
    },
    async scheduled(controller, env, ctx) {
      await env.STATE.put('unmatched-cron', controller.cron);
    },
  },
});
```

## Durable Objects

A native Durable Object can resolve Nest services through the application's asynchronous accessor:

```ts
import { DurableObject } from 'cloudflare:workers';

const worker = createWorker(bootstrap);

export class Greeter extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    const app = await worker.getApplication();
    return new Response(app.get(GreetingService).greet());
  }
}

export default worker;
```

Register the service as an application provider. Register `Greeter` in Wrangler's `durable_objects.bindings` and add a SQLite migration, as shown in `example/wrangler.jsonc`. Durable Object storage remains available through the object's own context.

## WebSockets and hibernation

Install `@nestjs/websockets` and import the adapter and Durable Object base class from `nestjs-cloudflare/websockets`. Socket.IO and `@nestjs/platform-ws` are not needed.

```ts
import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import {
  CloudflareWebSocketAdapter,
  CloudflareWebSocketDurableObject,
} from 'nestjs-cloudflare/websockets';

@WebSocketGateway({ path: '/chat' })
class ChatGateway {
  @SubscribeMessage('echo')
  echo(@MessageBody() data: unknown): unknown {
    return data;
  }
}

const adapter = new CloudflareWebSocketAdapter();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useWebSocketAdapter(adapter);
  return app;
}

const worker = createWorker(bootstrap);

export class ChatRoom extends CloudflareWebSocketDurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, {
      adapter,
      path: '/chat',
      getApplication: worker.getApplication,
    });
  }
}
```

Register the gateway as an application provider. Route upgrade requests to `env.CHAT.get(id).fetch(request)` and configure the Durable Object binding and migration. Gateways use port `0`, the default. Separate listening ports and Socket.IO namespaces are unsupported.

The base class implements `fetch`, `webSocketMessage`, `webSocketClose`, and `webSocketError`. It accepts connections through `ctx.acceptWebSocket` and waits for Nest startup before dispatching events after hibernation. Restored connections are registered with Nest again, so `handleConnection` can run more than once for a socket. Gateways are application singletons; keep persistent room state in Durable Object storage or socket attachments.

For Durable Objects that must keep in-memory sessions, timers, and upstream sockets, use the non-hibernating gateway host. It calls `server.accept()` and keeps each object's sockets isolated:

```ts
import {
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import {
  CloudflareWebSocketAdapter,
  CloudflareWebSocketGatewayDurableObject,
  getCloudflareWebSocketContext,
} from 'nestjs-cloudflare/websockets';

@WebSocketGateway({ path: '/ws' })
@WebSocketGateway({ path: '/mobula' })
class ApiGateway {
  @SubscribeMessage('publish')
  publish(@ConnectedSocket() socket: WebSocket, value: unknown): null {
    const { sockets } = getCloudflareWebSocketContext(socket);
    for (const peer of sockets) {
      peer.send(JSON.stringify(value));
    }
    return null;
  }
}

const adapter = new CloudflareWebSocketAdapter({
  messageSerializer: value => JSON.stringify(value),
});

export class ApiWebSocket extends CloudflareWebSocketGatewayDurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, {
      adapter,
      paths: ['/ws', '/mobula'],
      getApplication: worker.getApplication,
    });
  }

  protected nonWebSocketFetch(request: Request): Response {
    return new Response(`internal:${new URL(request.url).pathname}`);
  }
}
```

`getCloudflareWebSocketContext(socket)` exposes the owning object's `ctx`, `storage`, `env`, object instance, and in-memory `sockets` set. `messageSerializer` may return a string or `ArrayBuffer`, so binary or protocol-specific frames are supported. The `paths` list lets one Durable Object serve multiple gateway paths; in the example the same gateway handles `/ws` and `/mobula`. Override `nonWebSocketFetch` for the object's other requests.

Clients send `{"event":"echo","data":"hello"}`. The handler receives `data` and its return value is JSON-serialized directly to the client. Promise and observable results are supported. Configure `messageParser` for another wire protocol:

```ts
const adapter = new CloudflareWebSocketAdapter({
  messageParser: frame => {
    if (typeof frame !== 'string') {
      return;
    }
    return { event: 'echo', data: frame };
  },
});
```

A parser can return `undefined` to ignore a frame. The default parser closes malformed JSON messages with code `1007`. A custom parser can throw `InvalidWebSocketMessageException` for that close code; unexpected failures close with `1011`.

## Build and local development

Compile application TypeScript with `experimentalDecorators` and `emitDecoratorMetadata` before Wrangler bundles the emitted JavaScript. Wrangler's esbuild compilation does not emit the metadata Nest needs for dependency injection. Enable `nodejs_compat` and `enable_nodejs_http_server_modules` for Node HTTP support.

```sh
yarn install
yarn build
yarn lint
yarn test
yarn wrangler dev --config example/wrangler.jsonc --test-scheduled
```

Wrangler runs `yarn build:example` and loads `dist-example/example/index.js`. Local KV, Queues, and Durable Objects need no remote resources. The placeholder KV namespace ID is for local use.

```sh
curl http://localhost:8787/
curl http://localhost:8787/durable
curl -X POST http://localhost:8787/notifications \
  -H 'content-type: application/json' -d '{"text":"Hello"}'
curl 'http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/15%20*%20*%20*%20*'
curl http://localhost:8787/state/last-cron
curl http://localhost:8787/state/last-notification
```

Run the gateway example with `yarn wrangler dev --config example/websockets/wrangler.jsonc`, then connect to `ws://localhost:8787/chat` and send the JSON echo message above.

Wrangler aliases resolve unused optional Nest integrations to `unsupported-dependency.ts`. Nest references optional transport and validation packages while bundling even when an application does not enable them. The alias target throws if evaluated. Remove an integration's alias and install its actual dependencies before enabling it. The gateway example keeps Nest's real WebSocket module; copying the basic example's WebSocket-module alias would disable gateway registration.
