declare namespace Cloudflare {
  interface Env {
    [key: string]: unknown;
    RPC_SERVICE: Fetcher & {
      ping(): Promise<string>;
      object(): Promise<{ ping(): Promise<string> }>;
    };
    STATE: KVNamespace;
    PARSER_ROOM: DurableObjectNamespace<import('./ws-worker.js').ParserRoom>;
    ROOM: DurableObjectNamespace<import('./ws-worker.js').SocketRoom>;
    DATABASE: D1Database;
    OUTBOX: Queue;
  }
}
