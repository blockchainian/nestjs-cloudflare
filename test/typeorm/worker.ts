import 'reflect-metadata';

import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  InjectEntityManager,
  InjectRepository,
  TypeOrmModule,
} from '@nestjs/typeorm';
import { CloudflareTypeOrmModule } from 'nestjs-cloudflare/typeorm';
import { Pool } from 'pg';
import {
  Entity,
  type EntityManager,
  PrimaryColumn,
  type Repository,
} from 'typeorm';

interface Env {
  DATABASE: Hyperdrive;
}

const pools = new AsyncLocalStorage<Pool>();
const rollbackError = new Error('Roll back the insert');

@Entity('entries')
class Entry {
  @PrimaryColumn('text')
  id!: string;
}

@Injectable()
class Entries {
  constructor(
    @InjectRepository(Entry) private readonly entries: Repository<Entry>,
    @InjectEntityManager() manager: EntityManager,
  ) {
    if (manager !== entries.manager) {
      throw new Error(
        'The feature repository and EntityManager use different data sources',
      );
    }
  }

  async execute(action: string, id: string) {
    if (action === 'insert') {
      await this.entries.insert({ id });
    }

    if (action === 'commit' || action === 'rollback') {
      try {
        await this.entries.manager.transaction(async manager => {
          const entries = manager.getRepository(Entry);

          await entries.insert({ id });

          if (action === 'rollback') {
            await entries.findOneByOrFail({ id });
            throw rollbackError;
          }
        });
      } catch (error) {
        if (error !== rollbackError) {
          throw error;
        }
      }
    }

    return this.entries.findOneBy({ id });
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([Entry])],
  providers: [Entries],
})
class EntriesModule {}

@Module({
  imports: [
    CloudflareTypeOrmModule.forRoot({
      autoLoadEntities: true,
      connectionPool: () => {
        const pool = pools.getStore();

        if (!pool) {
          throw new Error('No database pool is active');
        }

        return pool;
      },
    }),
    EntriesModule,
  ],
})
class AppModule {}

let application: ReturnType<typeof NestFactory.createApplicationContext>;

export default {
  async fetch(request, env) {
    application ??= NestFactory.createApplicationContext(AppModule, {
      abortOnError: false,
      logger: false,
    });

    const app = await application;
    const [, action, id] = new URL(request.url).pathname.split('/');

    if (action === 'ready') {
      return new Response('ready');
    }

    const pool = new Pool({ connectionString: env.DATABASE.connectionString });
    let openedConnections = 0;
    let checkedOutConnections = 0;

    pool.on('connect', () => {
      openedConnections++;
    });

    const data = await pools.run(pool, async () => {
      try {
        return await app.get(Entries).execute(action, id);
      } finally {
        checkedOutConnections = pool.totalCount - pool.idleCount;
        await pool.end();
      }
    });

    return Response.json(data, {
      headers: {
        'x-checked-out-connections': String(checkedOutConnections),
        'x-open-connections': String(pool.totalCount),
        'x-opened-connections': String(openedConnections),
      },
    });
  },
} satisfies ExportedHandler<Env>;
