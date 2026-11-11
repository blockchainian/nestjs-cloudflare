import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { Cron } from '@nestjs/schedule';
import { env } from 'cloudflare:workers';

import { InjectBinding } from '../src/index.js';
import type { Env } from './env.interface.js';

@Controller()
export class JobsController {
  constructor(@InjectBinding('STATE') private readonly state: KVNamespace) {}

  @Cron((env as Env).CRON_SCHEDULE)
  async recordSchedule(controller: ScheduledController): Promise<void> {
    await this.state.put('last-cron', controller.cron);
  }

  @EventPattern('notifications')
  async recordNotification(@Payload() text: string): Promise<void> {
    await this.state.put('last-notification', text);
  }
}
