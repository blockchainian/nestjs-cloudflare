import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { describe, expect, it } from 'vitest';

import {
  CloudflareTypeOrmModule,
  type ConnectionPool,
  SnakeNamingStrategy,
} from '../../src/typeorm/index.js';

function createApplication(connectionPool: () => ConnectionPool) {
  return NestFactory.createApplicationContext(
    CloudflareTypeOrmModule.forRoot({ connectionPool }),
    { abortOnError: false, logger: false },
  );
}

describe('event-scoped database data source', () => {
  it('initializes and can open and release an idle runner outside an event', async () => {
    const app = await createApplication(() => {
      throw new Error('There is no active event');
    });

    const dataSource = app.get(DataSource);

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
      await app.close();
    }
  });

  it('takes a connection at the first query and releases it with the runner', async () => {
    let active = false;
    let acquisitions = 0;
    let releases = 0;

    const app = await createApplication(() => {
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
    });

    const dataSource = app.get(DataSource);

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
      await app.close();
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
