import { EventEmitter } from 'node:events';

/** A checked-out PostgreSQL client. */
export interface Connection {
  query(text: string, parameters?: unknown[]): Promise<unknown>;
  on?(event: 'error', listener: (error: Error) => void): unknown;
  removeListener?(event: 'error', listener: (error: Error) => void): unknown;
}

type Release = (error?: Error) => void;

/** The callback-based portion of pg.Pool used by the adapter. */
export interface ConnectionPool {
  connect(
    callback: (
      error: Error | undefined,
      client: Connection | undefined,
      release: Release,
    ) => void,
  ): void;
}

/** A TypeORM pool whose clients bind to the active event on the first query. */
export class ScopedPool extends EventEmitter {
  constructor(private readonly currentPool: () => ConnectionPool) {
    super();
  }

  connect(
    callback: (error: undefined, client: Connection, release: Release) => void,
  ): void {
    let acquired: Promise<{ client: Connection; release: Release }> | undefined;
    let released = false;
    const events = new EventEmitter();
    const onError = (error: Error) => events.emit('error', error);

    const release: Release = error => {
      if (released) {
        return;
      }

      released = true;

      void acquired?.then(
        ({ release }) => release(error),
        () => undefined,
      );
    };

    events.on('error', release);

    callback(
      undefined,
      Object.assign(events, {
        query: async (text: string, parameters?: unknown[]) => {
          if (released) {
            throw new Error('PostgreSQL connection has been released');
          }

          acquired ??= new Promise((resolve, reject) => {
            this.currentPool().connect((error, client, done) => {
              if (error || !client) {
                reject(
                  error ?? new Error('PostgreSQL pool returned no client'),
                );

                return;
              }

              client.on?.('error', onError);

              resolve({
                client,
                release: error => {
                  client.removeListener?.('error', onError);
                  done(error);
                },
              });
            });
          });

          const { client } = await acquired;

          if (released) {
            throw new Error('PostgreSQL connection has been released');
          }

          return client.query(text, parameters);
        },
      }),
      release,
    );
  }

  /** The event owns its pool and closes it separately. */
  end(callback: () => void): void {
    callback();
  }
}
