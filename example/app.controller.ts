import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import { CLOUDFLARE_ENV } from '../src/index.js';
import type { Env } from './env.interface.js';
import { GreetingService } from './greeting.service.js';

@Controller()
export class AppController {
  constructor(
    private readonly greetings: GreetingService,
    @Inject('NOTIFICATIONS') private readonly notifications: ClientProxy,
    @Inject(CLOUDFLARE_ENV) private readonly env: Env,
  ) {}

  @Get()
  greet(): string {
    return this.greetings.greet();
  }

  @Get('durable')
  async durable(): Promise<string> {
    const id = this.env.GREETER.idFromName('example');
    const response = await this.env.GREETER.get(id).fetch('https://greeter/');

    return response.text();
  }

  @Get('state/:key')
  async read(@Param('key') key: string): Promise<{ value: string | null }> {
    return { value: await this.env.STATE.get(key) };
  }

  @Post('notifications')
  async send(@Body() body: { text: string }): Promise<{ queued: true }> {
    await firstValueFrom(this.notifications.emit('notifications', body.text));

    return { queued: true };
  }
}
