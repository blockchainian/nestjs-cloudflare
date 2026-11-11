import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';

export class NativeRpcRoom extends DurableObject {
  ping() {
    return 'pong';
  }
}

export default class RpcService extends WorkerEntrypoint {
  ping() {
    return 'pong';
  }

  object() {
    return this.env.OBJECTS.getByName('injected-rpc');
  }
}
