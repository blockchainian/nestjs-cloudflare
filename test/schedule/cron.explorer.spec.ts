import 'reflect-metadata';

import { Injectable, type Provider, Scope } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { CRON_METADATA } from '../../src/schedule/constants.js';
import { CronExplorer } from '../../src/schedule/cron.explorer.js';
import { CloudflareScheduleModule } from '../../src/schedule/index.js';

async function createApplication(providers: Provider[]) {
  const app = await Test.createTestingModule({
    imports: [CloudflareScheduleModule.forRoot()],
    providers,
  }).compile();

  await app.init();

  return app;
}

function dispatch(explorer: CronExplorer, expression: string) {
  const ctx = createExecutionContext();

  const matched = explorer.dispatch(
    createScheduledController({ cron: expression }),
    ctx,
  );

  return { matched, settled: waitOnExecutionContext(ctx) };
}

describe('CronExplorer', () => {
  describe('onModuleInit', () => {
    it('should keep valid jobs when another expression is undefined', async () => {
      @Injectable()
      class Tasks {
        calls = 0;

        @Cron('0 0 * * *')
        run() {
          this.calls++;
        }

        @Cron(undefined as unknown as string)
        invalid() {}
      }
      const app = await createApplication([Tasks]);

      try {
        const result = dispatch(app.get(CronExplorer), '0 0 * * *');

        expect(result.matched).toBe(true);

        await result.settled;

        expect(app.get(Tasks).calls).toBe(1);
      } finally {
        await app.close();
      }
    });

    it('should discover methods on a factory-provided instance', async () => {
      class Tasks {
        calls = 0;

        @Cron('1 * * * *')
        run() {
          this.calls++;
        }
      }

      const app = await createApplication([
        { provide: Tasks, useFactory: () => new Tasks() },
      ]);

      try {
        const result = dispatch(app.get(CronExplorer), '1 * * * *');

        expect(result.matched).toBe(true);

        await result.settled;

        expect(app.get(Tasks).calls).toBe(1);
      } finally {
        await app.close();
      }
    });

    it('should discover methods on a value-provided instance', async () => {
      class Tasks {
        calls = 0;

        @Cron('2 * * * *')
        run() {
          this.calls++;
        }
      }

      const tasks = new Tasks();

      const app = await createApplication([
        { provide: Tasks, useValue: tasks },
      ]);

      try {
        const result = dispatch(app.get(CronExplorer), '2 * * * *');

        expect(result.matched).toBe(true);

        await result.settled;

        expect(tasks.calls).toBe(1);
      } finally {
        await app.close();
      }
    });

    it('should skip empty and six-field expressions without stopping discovery', async () => {
      class Tasks {
        @Cron('')
        empty() {
          throw new Error('Empty expression was dispatched');
        }

        @Cron('0 * * * * *')
        seconds() {
          throw new Error('Six-field expression was dispatched');
        }
      }

      const app = await createApplication([Tasks]);

      try {
        for (const expression of ['', '0 * * * * *']) {
          const result = dispatch(app.get(CronExplorer), expression);

          expect(result.matched).toBe(false);

          await result.settled;
        }
      } finally {
        await app.close();
      }
    });

    it('should skip request and transient providers without preventing startup', async () => {
      @Injectable({ scope: Scope.REQUEST })
      class RequestTasks {
        @Cron('3 * * * *')
        run() {
          throw new Error('Request-scoped job was dispatched');
        }
      }
      @Injectable({ scope: Scope.TRANSIENT })
      class TransientTasks {
        @Cron('3 * * * *')
        run() {
          throw new Error('Transient job was dispatched');
        }
      }
      const app = await createApplication([RequestTasks, TransientTasks]);

      try {
        const result = dispatch(app.get(CronExplorer), '3 * * * *');

        expect(result.matched).toBe(false);

        await result.settled;
      } finally {
        await app.close();
      }
    });

    it('should use the metadata key written by the official Cron decorator', () => {
      class Tasks {
        @Cron('5 * * * *', { name: 'hourly' })
        run() {}
      }

      expect(Reflect.getMetadata(CRON_METADATA, Tasks.prototype.run)).toEqual({
        name: 'hourly',
        cronTime: '5 * * * *',
      });
    });
  });

  describe('dispatch', () => {
    it('should run every matching method and preserve all handler failures', async () => {
      class Tasks {
        completed = 0;

        @Cron('4 * * * *')
        async fails() {
          throw new Error('First failure');
        }

        @Cron('4 * * * *')
        failsAgain() {
          throw new Error('Second failure');
        }

        @Cron('4 * * * *')
        succeeds() {
          this.completed++;
        }
      }

      const app = await createApplication([Tasks]);

      try {
        const result = dispatch(app.get(CronExplorer), '4 * * * *');

        expect(result.matched).toBe(true);

        const failure: unknown = await result.settled.catch(
          (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(AggregateError);

        expect((failure as AggregateError).errors).toEqual([
          new Error('First failure'),
          new Error('Second failure'),
        ]);

        expect(app.get(Tasks).completed).toBe(1);
      } finally {
        await app.close();
      }
    });

    it('should require exact expression matching and honor disabled jobs', async () => {
      class Tasks {
        @Cron('5 * * * *', { disabled: true })
        disabled() {
          throw new Error('Disabled job was dispatched');
        }

        @Cron('6 * * * *')
        run() {
          throw new Error('Unmatched job was dispatched');
        }
      }

      const app = await createApplication([Tasks]);

      try {
        for (const expression of ['5 * * * *', '6  * * * *', '7 * * * *']) {
          const result = dispatch(app.get(CronExplorer), expression);

          expect(result.matched).toBe(false);

          await result.settled;
        }
      } finally {
        await app.close();
      }
    });

    it('should skip overlapping calls while a waitForCompletion job is running', async () => {
      let release: (() => void) | undefined;

      const completion = new Promise<void>(resolve => {
        release = resolve;
      });

      class Tasks {
        calls = 0;

        @Cron('7 * * * *', { waitForCompletion: true })
        async run() {
          this.calls++;
          await completion;
        }
      }

      const app = await createApplication([Tasks]);

      try {
        const explorer = app.get(CronExplorer);
        const first = dispatch(explorer, '7 * * * *');
        const second = dispatch(explorer, '7 * * * *');

        expect(first.matched).toBe(true);
        expect(second.matched).toBe(true);

        await second.settled;

        expect(app.get(Tasks).calls).toBe(1);

        release?.();
        await first.settled;
        const third = dispatch(explorer, '7 * * * *');

        await third.settled;

        expect(app.get(Tasks).calls).toBe(2);
      } finally {
        release?.();
        await app.close();
      }
    });
  });
});
