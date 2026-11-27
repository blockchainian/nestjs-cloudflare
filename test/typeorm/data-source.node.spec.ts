import { DataSource } from 'typeorm';
import { describe, expect, it } from 'vitest';

import {
  createDataSourceOptions,
  initializeDataSource,
} from '../../src/typeorm/data-source.js';
import { SnakeNamingStrategy } from '../../src/typeorm/snake-naming.strategy.js';

describe('event-scoped PostgreSQL data source', () => {
  it('initializes and can open and release an idle runner outside an event', async () => {
    const dataSource = new DataSource(
      createDataSourceOptions(() => {
        throw new Error('There is no active event');
      }),
    );

    await initializeDataSource(dataSource);

    try {
      expect(dataSource.isInitialized).toBe(true);

      expect(dataSource.options).toMatchObject({
        installExtensions: false,
        synchronize: false,
        migrationsRun: false,
      });

      expect(dataSource.driver).toEqual(
        expect.objectContaining({
          version: expect.any(String),
          database: expect.any(String),
          searchSchema: expect.any(String),
        }),
      );

      const runner = dataSource.createQueryRunner();

      await runner.connect();
      await runner.release();
    } finally {
      await dataSource.destroy();
    }
  });

  it('takes a connection at the first query and releases it with the runner', async () => {
    let active = false;
    let acquisitions = 0;
    let releases = 0;

    const dataSource = new DataSource(
      createDataSourceOptions(() => {
        if (!active) {
          throw new Error('There is no active event');
        }

        return {
          connect(callback) {
            acquisitions++;

            callback(
              undefined,
              {
                async query(_text, parameters) {
                  return {
                    command: 'SELECT',
                    rows: [{ value: parameters?.[0] }],
                    rowCount: 1,
                  };
                },
              },
              () => {
                releases++;
              },
            );
          },
        };
      }),
    );

    await initializeDataSource(dataSource);

    const runner = dataSource.createQueryRunner();

    try {
      await runner.connect();

      expect(acquisitions).toBe(0);

      active = true;

      await expect(runner.query('SELECT $1 AS value', [1])).resolves.toEqual([
        { value: 1 },
      ]);

      await expect(runner.query('SELECT $1 AS value', [2])).resolves.toEqual([
        { value: 2 },
      ]);

      expect(acquisitions).toBe(1);
      expect(releases).toBe(0);

      await runner.release();
      await runner.release();

      expect(releases).toBe(1);
    } finally {
      await runner.release();
      await dataSource.destroy();
    }
  });
});

describe('SnakeNamingStrategy', () => {
  const strategy = new SnakeNamingStrategy();

  it('converts implicit columns, including embedded prefixes', () => {
    expect(strategy.columnName('firstName', undefined, [])).toBe('first_name');

    expect(
      strategy.columnName('postalCode', undefined, ['shippingAddress', 'home']),
    ).toBe('shipping_address_home_postal_code');
  });

  it('keeps explicit column names and converts join columns', () => {
    expect(strategy.columnName('firstName', 'LegacyName', [])).toBe(
      'LegacyName',
    );

    expect(strategy.joinColumnName('accountOwner', 'userId')).toBe(
      'account_owner_user_id',
    );
  });
});
