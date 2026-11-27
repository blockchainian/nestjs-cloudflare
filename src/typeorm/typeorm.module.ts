import { EventEmitter } from 'node:events';

import {
  type DynamicModule,
  forwardRef,
  Module,
  type Type,
} from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { PostgresDataSourceOptions } from 'typeorm/driver/postgres/PostgresDataSourceOptions.js';

/** Configures an application-wide TypeORM data source backed by event pools. */
export interface ScopedDataSourceOptions extends Omit<
  PostgresDataSourceOptions,
  | 'type'
  | 'driver'
  | 'nativeDriver'
  | 'replication'
  | 'installExtensions'
  | 'dropSchema'
  | 'synchronize'
  | 'migrationsRun'
> {
  connectionPool: () => ConnectionPool;
  autoLoadEntities?: boolean;

  /** Database version used for driver capability checks. Defaults to 12.0. */
  serverVersion?: string;

  /** Default schema in the pool's search path. Defaults to public. */
  searchSchema?: string;
}

/** Registers the default database DataSource and EntityManager in Nest. */
@Module({})
export class CloudflareTypeOrmModule {
  /** Register once in the application root, including from a module decorator. */
  public static forRoot({
    connectionPool,
    autoLoadEntities,
    serverVersion = '12.0',
    searchSchema = 'public',
    ...options
  }: ScopedDataSourceOptions): DynamicModule {
    const dataSourceOptions: PostgresDataSourceOptions = {
      ...options,
      type: 'postgres',
      driver: {
        Pool: class extends ScopedConnectionPool {
          constructor() {
            super(connectionPool);
          }
        },
      },
      replication: undefined,
      installExtensions: false,
      dropSchema: false,
      synchronize: false,
      migrationsRun: false,
    };

    let bootstrapModule: Type | undefined;

    return {
      module: CloudflareTypeOrmModule,
      imports: [
        // Nest resolves this during scanning, when forRootAsync may generate its
        // module ID. The forward reference resolves to a stable module class.
        forwardRef(() => {
          if (bootstrapModule) {
            return bootstrapModule;
          }

          @Module({
            imports: [
              TypeOrmModule.forRootAsync({
                useFactory: () => ({ ...dataSourceOptions, autoLoadEntities }),
                dataSourceFactory: (resolvedOptions = dataSourceOptions) => {
                  const dataSource = new DataSource(resolvedOptions);

                  // Seed the metadata the driver would otherwise query at startup.
                  Object.assign(dataSource.driver, {
                    version: serverVersion,
                    database: dataSource.driver.database || 'postgres',
                    searchSchema,
                  });

                  return dataSource.initialize();
                },
              }),
            ],
          })
          class TypeOrmBootstrapModule {}

          bootstrapModule = TypeOrmBootstrapModule;

          return bootstrapModule;
        }),
      ],
    };
  }
}

/** A checked-out database connection. */
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
      connection: Connection | undefined,
      release: Release,
    ) => void,
  ): void;
}

/** A TypeORM pool whose connections bind to the active event on the first query. */
class ScopedConnectionPool extends EventEmitter {
  constructor(private readonly pool: () => ConnectionPool) {
    super();
  }

  connect(
    callback: (
      error: undefined,
      connection: Connection,
      release: Release,
    ) => void,
  ): void {
    let acquired:
      Promise<{ connection: Connection; close: Release }> | undefined;

    let released = false;
    const events = new EventEmitter();
    const onError = (error: Error) => events.emit('error', error);

    const release: Release = error => {
      if (released) {
        return;
      }

      released = true;

      void acquired?.then(
        ({ close }) => close(error),
        () => undefined,
      );
    };

    events.on('error', release);

    callback(
      undefined,
      Object.assign(events, {
        query: async (text: string, parameters?: unknown[]) => {
          if (released) {
            throw new Error('Database connection has been released');
          }

          acquired ??= new Promise((resolve, reject) => {
            this.pool().connect((error, connection, done) => {
              if (error || !connection) {
                reject(
                  error ?? new Error('Database pool returned no connection'),
                );

                return;
              }

              connection.on?.('error', onError);

              resolve({
                connection,
                close: error => {
                  connection.removeListener?.('error', onError);
                  done(error);
                },
              });
            });
          });

          const { connection } = await acquired;

          if (released) {
            throw new Error('Database connection has been released');
          }

          return connection.query(text, parameters);
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
