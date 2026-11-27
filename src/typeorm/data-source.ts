import type { DataSource } from 'typeorm';
import type { PostgresDataSourceOptions } from 'typeorm/driver/postgres/PostgresDataSourceOptions.js';

import { type ConnectionPool, ScopedPool } from './scoped-pool.js';

export type ScopedPostgresOptions = Omit<
  PostgresDataSourceOptions,
  | 'type'
  | 'driver'
  | 'nativeDriver'
  | 'replication'
  | 'installExtensions'
  | 'dropSchema'
  | 'synchronize'
  | 'migrationsRun'
>;

export function createDataSourceOptions(
  currentPool: () => ConnectionPool,
  options: ScopedPostgresOptions = {},
): PostgresDataSourceOptions {
  return {
    ...options,
    type: 'postgres',
    driver: {
      Pool: class extends ScopedPool {
        constructor() {
          super(currentPool);
        }
      },
    },
    replication: undefined,
    installExtensions: false,
    dropSchema: false,
    synchronize: false,
    migrationsRun: false,
  };
}

/** Seeds the metadata that the Postgres driver would otherwise query at startup. */
export function initializeDataSource(
  dataSource: DataSource,
  serverVersion = '12.0',
  searchSchema = 'public',
): Promise<DataSource> {
  Object.assign(dataSource.driver, {
    version: serverVersion,
    database: dataSource.driver.database || 'postgres',
    searchSchema,
  });

  return dataSource.initialize();
}
