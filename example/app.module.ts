import { Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';

import { CloudflareModule, getBindingToken } from '../src/index.js';
import { CloudflareQueueClient } from '../src/queue/index.js';
import { CloudflareScheduleModule } from '../src/schedule/index.js';
import { AppController } from './app.controller.js';
import type { Env } from './env.interface.js';
import { GreetingService } from './greeting.service.js';
import { JobsController } from './jobs.controller.js';

@Module({
  imports: [
    CloudflareModule.forRoot(),
    CloudflareScheduleModule.forRoot(),
    ClientsModule.registerAsync([
      {
        name: 'NOTIFICATIONS',
        inject: [getBindingToken<Env>('NOTIFICATIONS')],
        useFactory: (queue: Queue<string>) => ({
          customClass: CloudflareQueueClient,
          options: { queue },
        }),
      },
    ]),
  ],
  controllers: [AppController, JobsController],
  providers: [GreetingService],
})
export class AppModule {}
