import {
  type DynamicModule,
  forwardRef,
  Module,
  type Type,
} from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  createDataSourceOptions,
  initializeDataSource,
  type ScopedPostgresOptions,
} from './data-source.js';
import type { ConnectionPool } from './scoped-pool.js';

/** Configures an application-wide TypeORM data source backed by event pools. */
export interface CloudflareTypeOrmOptions extends ScopedPostgresOptions {
  pool: () => ConnectionPool;
  autoLoadEntities?: boolean;

  /** PostgreSQL version used for driver capability checks. Defaults to 12.0. */
  serverVersion?: string;

  /** Default schema in the pool's search path. Defaults to public. */
  searchSchema?: string;
}

/** Registers the default PostgreSQL DataSource and EntityManager in Nest. */
@Module({})
export class CloudflareTypeOrmModule {
  /** Register once in the application root, including from a module decorator. */
  public static forRoot({
    pool,
    autoLoadEntities,
    serverVersion,
    searchSchema,
    ...options
  }: CloudflareTypeOrmOptions): DynamicModule {
    const dataSourceOptions = createDataSourceOptions(pool, options);
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
                dataSourceFactory: (resolvedOptions = dataSourceOptions) =>
                  initializeDataSource(
                    new DataSource(resolvedOptions),
                    serverVersion,
                    searchSchema,
                  ),
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
