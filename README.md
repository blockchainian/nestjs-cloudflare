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

`createWorker` synchronously returns Worker handlers. The first event runs `bootstrap` once, initializes the application, starts connected microservices by default, and opens its Node HTTP server on an ephemeral port if it is not already listening. Nest skips initialization when the application is already initialized. Later events share the same application. `worker.getApplication()` returns a promise for that application and also starts it when called by a Durable Object.

HTTP responses from the Node bridge have connection-specific headers removed under [RFC 9110 section 7.6.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-7.6.1): `Connection`, `Keep-Alive`, `Transfer-Encoding`, `TE`, `Trailer`, `Upgrade`, `Proxy-Authenticate`, `Proxy-Authorization`, and any headers named by `Connection`. Bodies stream through unchanged. Status codes, status text, and other headers, including repeated `Set-Cookie` values, are preserved. Responses with status `101` or a `webSocket`, forwarded Durable Object responses, and application fallback responses are returned unchanged.

If bootstrap calls `await app.startAllMicroservices()`, pass `{ microservicesStarted: true }` to `createWorker` to skip repeating that step. This lets applications finish startup before switching to their runtime logger. Bootstrap must start all connected microservices when this option is enabled; event dispatch remains unchanged.

```ts
async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
  await app.startAllMicroservices();
  app.useLogger(app.get(AppLogger));
  return app;
}

export default createWorker(bootstrap, { microservicesStarted: true });
```

`AppLogger` is the application's registered logger provider.

Keep Nest creation inside `bootstrap`. Cloudflare's upload validation runs module initialization without all bindings and disallows I/O and random number generation. Deferring Nest startup to an event avoids those restrictions. Choose HTTP adapters, application options, global guards, pipes, filters, and interceptors in your bootstrap function.

For incremental HTTP migration, pass a native fallback. `fetch` checks the initialized Express route table before dispatch and leaves unmatched request bodies untouched:

```ts
import { CloudflareRequestContext } from 'nestjs-cloudflare';

const worker = createWorker(bootstrap, {
  fallback: {
    async fetch(request, env, ctx) {
      const app = await worker.getApplication();
      const error = app.get(CloudflareRequestContext).getRouteError();
      if (error) return new Response('Invalid route encoding', { status: 400 });
      return legacyRouter.fetch(request, env, ctx);
    },
  },
  routing: { headImplicitMatch: false },
});

await worker.matches(request); // true for a configured WebSocket path or Nest route
```

Configure Express before constructing the Nest adapter so its router uses the
same settings during pre-matching and dispatch:

```ts
import express from 'express';
import { ExpressAdapter } from '@nestjs/platform-express';

async function bootstrap() {
  const instance = express();
  instance.set('case sensitive routing', true);
  instance.set('strict routing', true);
  return NestFactory.create(AppModule, new ExpressAdapter(instance));
}
```

The optional `routing.caseSensitive` and `routing.strict` values validate these
Express settings. Their aliases are `caseSensitiveRouting` and `strictRouting`.
A mismatch fails startup with instructions to configure Express before creating
the adapter. They do not change an existing router. Omit them to use the
bootstrap settings. The default Express configuration remains case-insensitive
and accepts trailing slashes.

Set `routing.headImplicitMatch: false` when a `HEAD` request should match only
an explicitly registered `HEAD` route. Unmatched requests go to `fallback.fetch`.
The default preserves Express's implicit `GET` handling.

Use `around.fetch`, `around.scheduled`, or `around.queue` to wrap complete event dispatch. Each hook receives the native event values and a `next` function. `CloudflareRequestContext` is a singleton provider exported by `CloudflareModule.forRoot()`; inject it to read `getRequest()`, `getEnv()`, `getExecutionContext()`, and `getRouteError()` from the current event. When Express cannot decode a route parameter, pre-matching sends the request to `fallback.fetch` and `getRouteError()` returns the `URIError`.

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

`disabled` suppresses a handler. `waitForCompletion` skips overlapping invocations within one isolate. Timer-specific options such as `timeZone` do not configure Cloudflare triggers. `scheduled()` waits for all matching handlers to finish and rejects with an `AggregateError` if any handler fails. Unmatched events use `fallback.scheduled` when provided and otherwise produce a warning.

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

Use `CloudflareQueueRecordBuilder` to attach native `QueueSendOptions`, following Nest's transport record builder convention:

```ts
import { CloudflareQueueRecordBuilder } from 'nestjs-cloudflare/queue';

const record = new CloudflareQueueRecordBuilder({ id: 'activity' })
  .setOptions({ delaySeconds: 60, contentType: 'json' })
  .build();

await firstValueFrom(client.emit('notifications', record));
```

The default serializer unwraps the record and passes its options to `queue.send`. Options are not included in the message body. A custom serializer replaces the default and must return `{ ...packet, data, options }` to use send options.

For dependency injection into the client factory, use `ClientsModule.registerAsync` with `inject: [getBindingToken<Env>('NOTIFICATIONS')]` and return `{ customClass: CloudflareQueueClient, options: { queue } }`. Client and server options accept Nest serializers and deserializers. `emit` sends the Nest event packet, preserving its pattern and metadata. One Queue can carry multiple patterns. `send` rejects because Cloudflare Queues do not support request-response messaging.

`connect()`, `unwrap()`, and `emit()` report a missing or invalid Queue binding with a plain `Error`: `Missing or invalid Queue binding: queue`. Here `queue` names the client option; clients receive the binding value rather than its environment key.

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

The context exposes the original message, batch, execution context, and pattern. For messages sent by other producers without a Nest packet, the Queue name is the event pattern. Successful messages are acknowledged automatically by default. Set `noAck: false` for manual acknowledgement. A handler can discard an invalid message with `context.getMessage().ack()` or retry a locked message with `context.getMessage().retry({ delaySeconds: 30 })`. Return normally after either call so the handler controls that message's outcome. Failed handlers request retries in either mode.

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

For Nest `@MessagePattern` calls through `ClientProxy.send()` and native alarms through `@EventPattern`, use `CloudflareDurableObject` as described in [Durable Object microservices](#durable-object-microservices). Both WebSocket hosts can enable the same transport through their optional `transport` configuration, so one object can serve sockets, RPC messages, and alarms.

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

Register the gateway as an application provider. Configure the Durable Object binding and migration, then declare native forwarding in `createWorker`:

```ts
const worker = createWorker<Env>(bootstrap, {
  websockets: [{ paths: ['/chat'], binding: 'CHAT', object: 'shared-chat' }],
});
```

Each entry selects exact URL pathnames, a Durable Object namespace binding from the event's `env`, and an object name. For a shared API object, use `{ paths: ['/ws', '/mobula'], binding: 'API_WEBSOCKET', object: 'api-websocket' }`. These paths must also be configured on the object's gateway host and declared with `@WebSocketGateway({ path })`. Entries are checked in order; the first matching entry wins. Matching is case-sensitive, distinguishes trailing slashes, ignores query strings, and is independent of Express routing settings.

A missing or invalid namespace binding throws a plain `Error` naming the configured binding, such as `Missing or invalid Durable Object namespace binding: API_WEBSOCKET`. Treat this as a deployment configuration error.

Use `object: request => new URL(request.url).searchParams.get('room') ?? 'default'` to select a name per request. Strings are resolved with the namespace's `idFromName()`. A resolver may instead return a native `DurableObjectId`, such as `object: request => env.CHAT.idFromString(new URL(request.url).searchParams.get('id')!)`.

Forwarding runs inside `around.fetch`, before Express and `fallback.fetch`. The original request, including its URL, headers, and body, goes directly to `namespace.get(id).fetch(request)`. The object's response is returned unchanged, including the WebSocket on a `101` response. Matching non-upgrade requests also go to the object: both gateway hosts return `426` by default, and `CloudflareWebSocketGatewayDurableObject` subclasses can override `nonWebSocketFetch`. `worker.matches(request)` returns `true` for configured paths regardless of method or upgrade headers, without starting Nest or calling the object resolver. Unmatched paths retain the usual Nest and fallback behavior.

`CloudflareWebSocketAdapter` accepts `maxConcurrentMessages`, matching Nest's `@nestjs/platform-ws` option. The default is `1000`, so asynchronous messages on one connection can overlap. Use `new CloudflareWebSocketAdapter({ maxConcurrentMessages: 1 })` when authentication must finish before a later subscription is handled. The limit applies per connection to both Durable Object hosts, including messages delivered through `webSocketMessage` after hibernation. Other connections can keep processing independently. An in-progress handler must finish before the next queued message starts when the limit is `1`.

Gateways use port `0`, the default. Separate listening ports and Socket.IO namespaces are unsupported.

The base class implements `fetch`, `webSocketMessage`, `webSocketClose`, and `webSocketError`. It accepts connections through `ctx.acceptWebSocket` and waits for Nest startup before dispatching events after hibernation. Restored connections are registered with Nest again, so `handleConnection` can run more than once for a socket. Singleton gateways are shared by the application. Inject durable providers for object-owned I/O and keep persistent room state in Durable Object storage or socket attachments.

For Durable Objects that must keep in-memory sessions, timers, and upstream sockets, use the non-hibernating gateway host. It calls `server.accept()` and keeps each object's sockets isolated:

```ts
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import {
  CloudflareWebSocketAdapter,
  CloudflareWebSocketGatewayDurableObject,
  getCloudflareWebSocketContext,
} from 'nestjs-cloudflare/websockets';

@WebSocketGateway({ path: '/ws' })
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

@WebSocketGateway({ path: '/mobula' })
class MobulaGateway {
  @SubscribeMessage('subscribe')
  subscribe(@MessageBody() value: unknown): unknown {
    return { protocol: 'mobula', data: value };
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

`getCloudflareWebSocketContext(socket)` exposes the owning object's `ctx`, `storage`, `env`, object instance, and in-memory `sockets` set. `messageSerializer` may return a string or `ArrayBuffer`, so binary or protocol-specific frames are supported. Register both gateways as application providers. Each path with its own `@WebSocketGateway({ path })` uses that gateway and its message handlers. A path without its own gateway falls back to the first path in `paths`, preserving the single-gateway alias use case. Do not stack `@WebSocketGateway` decorators on one class; declare one class per protocol. The context's `sockets` set contains all connections on the object, so a broadcast through that set reaches every path. Override `nonWebSocketFetch` for the object's other requests.

Both WebSocket hosts also support the optional `transport: { server, alarmPattern? }` configuration shown below. This enables `ClientProxy.send()` and alarm handlers on the same object without internal HTTP endpoints.

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

A parser can return `undefined` to ignore a frame. The default parser closes malformed JSON messages with code `1007`. A custom parser can throw `InvalidWebSocketMessageException` for that close code. Unexpected parser failures are logged at error level and discard the frame without closing the connection.

Both hosts own the closing handshake. On a peer-initiated close, the host completes the handshake before dispatching `handleDisconnect`; gateway hooks should clean up application state and must not call `socket.close()` to reply. This matches the gateway's responsibility with `@nestjs/platform-ws`, where `ws` replies automatically. When the Workers runtime has not already replied, the host replies with the received close code and reason, mapping the unsendable codes `1005` and `1006` to `1000`.

For sockets accepted with `accept()`, Workers automatically replies with `web_socket_auto_reply_to_close`, enabled by default for compatibility dates from `2026-04-07`. Earlier dates, `web_socket_manual_reply_to_close`, and half-open sockets require an explicit reply. Hibernating sockets accepted with `acceptWebSocket()` require an explicit reply in `webSocketClose()` even when automatic replies are enabled. Both hosts handle these differences; gateways need no compatibility-date checks. See [Workers close behavior](https://developers.cloudflare.com/workers/runtime-apis/websockets/#close-behavior) and [hibernating socket behavior](https://developers.cloudflare.com/workers/runtime-apis/websockets/#state-and-error-behavior).

The public `CloudflareWebSocketDisconnectReason` type is `string | undefined`. A close notification supplies the peer's reason string, including `''` when no reason was provided. A terminal socket error supplies `undefined`. Existing callbacks written as `(reason?: string)` and standard Nest gateways with `handleDisconnect(client)` remain supported. `OnCloudflareWebSocketDisconnect<T = WebSocket>` extends Nest's `OnGatewayDisconnect<T>` with this reason parameter. The helper `getCloudflareWebSocketDisconnectEvent(reason)` returns the discriminated union `CloudflareWebSocketDisconnectEvent`: `{ type: 'close', reason: string }` or `{ type: 'error' }`.

```ts
import { WebSocketGateway } from '@nestjs/websockets';
import {
  type CloudflareWebSocketDisconnectReason,
  getCloudflareWebSocketDisconnectEvent,
  type OnCloudflareWebSocketDisconnect,
} from 'nestjs-cloudflare/websockets';

@WebSocketGateway({ path: '/chat' })
class ChatGateway implements OnCloudflareWebSocketDisconnect {
  handleDisconnect(
    _client: WebSocket,
    reason: CloudflareWebSocketDisconnectReason,
  ): void {
    const event = getCloudflareWebSocketDisconnectEvent(reason);

    console.log(event.type === 'error' ? 'client_error' : event.reason);
  }
}
```

Both hosts follow `@nestjs/platform-ws` for native socket errors: log the error once at error level without initiating a close or choosing a close code. Workers can report a terminal failure through an `error` event or `webSocketError` instead of a close notification. Both hosts therefore invoke the gateway's `handleDisconnect` once on either terminal error or close and release the socket's callbacks and context. A later close notification does not invoke the hook again. Message handler exceptions follow Nest's exception filters instead of this socket error path and do not disconnect the client.

## Durable Object microservices

Install `@nestjs/microservices`. Connect a `CloudflareDurableObjectServer` during bootstrap, just like the Queue transport. Import `CloudflareModule.forRoot()` in `AppModule` to provide `CloudflareRequestContext`.

```ts
import { NestFactory } from '@nestjs/core';
import {
  CloudflareDurableObject,
  CloudflareDurableObjectServer,
} from 'nestjs-cloudflare/durable-objects';

const transport = new CloudflareDurableObjectServer();
let application: ReturnType<typeof bootstrap> | undefined;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.connectMicroservice({ strategy: transport }, { inheritAppConfig: true });
  await app.init();
  await app.startAllMicroservices();
  return app;
}

export class JobLease extends CloudflareDurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env, {
      server: transport,
      getApplication: () => (application ??= bootstrap()),
      alarmPattern: 'alarm',
    });
  }
}
```

Export the class from the Worker entry point and register it in Wrangler's Durable Object bindings and migrations. This transport uses native Workers RPC and requires a compatibility date of `2024-04-03` or later. It does not expose an HTTP URL. Each message carries Nest's pattern and data to the object's `dispatch` RPC method.

Each object resolves only the controller matching the RPC or alarm pattern, sharing initialization across concurrent calls to that controller and retrying initialization after a failure. Cold and warm objects start handlers on the same controller in arrival order when deserialization, guards, pipes, and interceptors take the same time for each call. Calls to different controllers on a cold object have no start-order guarantee. Handler awaits can still interleave; custom asynchronous deserializers, guards, pipes, or interceptors with unequal delays can change the start order.

To combine this transport with gateways, use either WebSocket base class with the same initialized application and transport server:

```ts
export class ApiWebSocket extends CloudflareWebSocketGatewayDurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, {
      adapter,
      paths: ['/ws', '/mobula'],
      getApplication: () => (application ??= bootstrap()),
      transport: { server: transport, alarmPattern: 'alarm' },
    });
  }
}
```

For hibernation, extend `CloudflareWebSocketDurableObject` and replace `paths` with `path: '/chat'`. Install the WebSocket adapter with `app.useWebSocketAdapter(adapter)` and connect the transport with `app.connectMicroservice({ strategy: transport })` during the same bootstrap. Initialize the application and start its microservices before returning it. Existing WebSocket configurations without `transport` keep their current behavior.

Both hosts expose the same `dispatch` RPC method as `CloudflareDurableObject` and await `@EventPattern` alarm handlers. `alarmPattern` defaults to `'alarm'`. Address `ClientProxy.send()` to the same object name or ID used by the WebSocket connection. A message handler can inject an object-owned durable provider shared with the gateway to push data to connected clients. For hibernating sockets, use `context.getState().getWebSockets()` and socket attachments to restore subscriptions after wakeup. For non-hibernating sockets, keep connections in that provider and remove them when they close. An `alarm()` override takes precedence; call `await super.alarm()` to retain transport dispatch.

Register handlers as Nest controllers. `@Ctx()` receives the native state, environment, and normalized pattern. Durable providers use the same object isolation described below; ordinary request providers are recreated for each invocation.

```ts
import { Controller, Injectable, Scope } from '@nestjs/common';
import {
  Ctx,
  EventPattern,
  MessagePattern,
  Payload,
} from '@nestjs/microservices';
import { CloudflareDurableObjectContext } from 'nestjs-cloudflare/durable-objects';

@Injectable({ scope: Scope.REQUEST, durable: true })
class LeaseService {
  async acquire(state: DurableObjectState, owner: string) {
    return state.storage.transaction(async storage => {
      if (await storage.get('owner')) {
        return { acquired: false };
      }
      await storage.put('owner', owner);
      return { acquired: true };
    });
  }
}

@Controller()
class LeaseController {
  constructor(private readonly leases: LeaseService) {}

  @MessagePattern('acquire')
  acquire(
    @Payload() owner: string,
    @Ctx() context: CloudflareDurableObjectContext,
  ) {
    return this.leases.acquire(context.getState(), owner);
  }

  @EventPattern('alarm')
  async alarm(@Ctx() context: CloudflareDurableObjectContext) {
    await context.getState().storage.delete('owner');
  }
}
```

Register `LeaseController` in `controllers` and `LeaseService` in `providers`. Schedule alarms with `context.getState().storage.setAlarm(timestamp)`. The base class dispatches native alarms to `@EventPattern('alarm')`, or to the configured `alarmPattern`, and awaits completion so failures can trigger Cloudflare's alarm retries. Alarm data is `undefined`.

Register the client through `ClientsModule` and select the target separately for each message using Nest's record builder convention:

```ts
import { ClientsModule } from '@nestjs/microservices';
import { env } from 'cloudflare:workers';
import { firstValueFrom } from 'rxjs';
import {
  CloudflareDurableObjectClient,
  CloudflareDurableObjectRecordBuilder,
} from 'nestjs-cloudflare/durable-objects';

const clients = ClientsModule.register([
  {
    name: 'JOB_LEASES',
    customClass: CloudflareDurableObjectClient,
    options: { namespace: env.JOB_LEASES },
  },
]);

// Import clients in a Nest module and inject its ClientProxy with @Inject('JOB_LEASES').
const record = new CloudflareDurableObjectRecordBuilder('worker-owner')
  .setOptions({ name: 'job:sync-feed' })
  .build();
const result = await firstValueFrom(client.send('acquire', record));
```

Use `{ id: durableObjectId.toString() }` instead of `{ name }` to address an existing ID. Address options stay outside handler data. `ClientsModule.registerAsync` can inject a namespace using `getBindingToken`, as with Queues. `emit` invokes `@EventPattern` handlers and awaits their completion.

`connect()`, `unwrap()`, `send()`, and `emit()` report a missing or invalid namespace with a plain `Error`: `Missing or invalid Durable Object namespace binding: namespace`. Here `namespace` names the client option.

Both client and server accept Nest serializers and deserializers. The default client serializer unwraps records into `{ ...packet, data, options }`; a replacement serializer must preserve that shape to select an object. `send` preserves the payload from `RpcException`, including structured error codes, as the Observable error. Handler Observable replies are collected until completion and returned in order by the RPC call; use finite streams.

`CloudflareRequestContext` is available inside request and alarm handlers. `getEnv()` returns the object's environment, `getRequest()` returns `undefined`, and `getExecutionContext()` returns its native `DurableObjectState`, including `waitUntil`. The execution-context type also permits Worker `ExecutionContext` for Worker events; narrow the union before using event-specific methods.

## Durable Object dependency scopes

Mark providers that own upstream sockets, fetch streams, or timers with Nest's `@Injectable({ scope: Scope.REQUEST, durable: true })`. Both gateway hosts bind each accepted or restored socket to its owning Durable Object before Nest resolves the gateway. Nest's durable dependency tree is reused across connections and events in that object. Default singleton providers remain shared across the application, and ordinary request-scoped providers retain their event or connection scope.

```ts
import { Injectable, Scope } from '@nestjs/common';
import { resolveForDurableObject } from 'nestjs-cloudflare';

@Injectable({ scope: Scope.REQUEST, durable: true })
class UpstreamClient {
  // Create and retain upstream I/O here, in the owning object's event.
}

// Inside a native Durable Object's fetch, alarm, or RPC method:
const client = await resolveForDurableObject(
  await worker.getApplication(),
  this.ctx,
  UpstreamClient,
);
```

Register the provider in a Nest module. A gateway can inject it through its constructor; durability propagates through the dependency tree according to [Nest's durable provider rules](https://docs.nestjs.com/fundamentals/injection-scopes#durable-providers). In subclasses of either gateway host, use `await this.resolve(UpstreamClient)` from `fetch`, `nonWebSocketFetch`, `alarm`, or RPC handlers. Native Durable Objects use `resolveForDurableObject(app, ctx, token)` in each event. Resolve within the owning object's event so workerd also assigns any new I/O to that object.

The package installs `DurableObjectContextIdStrategy` globally through `ContextIdFactory.apply` on first use. It associates Nest event contexts with the object's state and ID, and selects their shared parent only for durable dependency trees. This occupies Nest's single global strategy slot; applications with another custom strategy must compose the strategies. `getDurableObjectContextId(ctx)` exposes the event context for direct Nest integration. The helper also registers the context payload, so `@Inject(REQUEST)` can receive `{ durableObjectId, ctx }`.

Context ownership is weakly keyed by the native `DurableObjectState`, so an evicted activation does not leave an isolate-wide ID cache behind. Hibernation, eviction, or isolate restart creates a new in-memory provider tree; durable providers do not persist sockets, timers, or JavaScript state across those boundaries. Use non-hibernating hosts when upstream sessions must stay in memory, and use Durable Object storage for persistent state. Nest does not run application lifecycle hooks for request-scoped providers; manage object-owned resources explicitly.

## Publishing

Change the version in `package.json` and merge the change into `main` to publish automatically. The `publish.yml` workflow skips versions already on npm. For an unpublished version, it installs dependencies with `yarn.lock`, runs `yarn lint`, `yarn test:types`, and `yarn test`, then runs `npm publish --access public`. The `prepublishOnly` script builds the package.

Configure npm Trusted Publishing for `blockchainian/nestjs-cloudflare` with workflow filename `publish.yml`. Publishing uses GitHub Actions OIDC without npm tokens or secrets. After configuring npm, you can manually run the workflow on `main` to publish the current version.

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
