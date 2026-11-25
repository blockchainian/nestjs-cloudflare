import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import {
  createExecutionContext,
  createScheduledController,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { CloudflareModule, createWorker } from '../../src/index.js';
import { CloudflareScheduleModule } from '../../src/schedule/index.js';

function completion() {
  let resolve!: () => void;

  const promise = new Promise<void>(done => {
    resolve = done;
  });

  return { promise, resolve };
}

@Injectable()
class ScheduledTasks {
  started = completion();
  completion = completion();
  completed = false;

  @Cron('0 0 * * *')
  async run() {
    this.started.resolve();
    await this.completion.promise;
    this.completed = true;
  }

  @Cron('1 0 * * *')
  async fail() {
    throw new Error('Scheduled handler failed');
  }
}

async function scheduledWorker() {
  return createWorker(async () => {
    const module = await Test.createTestingModule({
      imports: [CloudflareModule.forRoot(), CloudflareScheduleModule.forRoot()],
      providers: [ScheduledTasks],
    }).compile();

    return module.createNestApplication({ logger: false });
  });
}

describe('Scheduled worker', () => {
  it('should await matching handlers before resolving scheduled', async () => {
    const worker = await scheduledWorker();
    const app = await worker.getApplication();
    const tasks = app.get(ScheduledTasks);
    let settled = false;

    const invocation = worker
      .scheduled(
        createScheduledController({ cron: '0 0 * * *' }),
        env,
        createExecutionContext(),
      )
      .then(() => {
        settled = true;
      });

    try {
      await tasks.started.promise;

      expect(settled).toBe(false);
      expect(tasks.completed).toBe(false);

      tasks.completion.resolve();
      await invocation;

      expect(settled).toBe(true);
      expect(tasks.completed).toBe(true);
    } finally {
      tasks.completion.resolve();
      await invocation;
      await app.close();
    }
  });

  it('should reject scheduled with matching handler failures', async () => {
    const worker = await scheduledWorker();
    const app = await worker.getApplication();

    try {
      const invocation = worker.scheduled(
        createScheduledController({ cron: '1 0 * * *' }),
        env,
        createExecutionContext(),
      );

      await expect(invocation).rejects.toBeInstanceOf(AggregateError);

      await expect(invocation).rejects.toMatchObject({
        errors: [new Error('Scheduled handler failed')],
      });
    } finally {
      await app.close();
    }
  });
});
