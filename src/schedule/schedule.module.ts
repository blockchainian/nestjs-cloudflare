import { type DynamicModule, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { CRON_EXPLORER } from './constants.js';
import { CronExplorer } from './cron.explorer.js';

/**
 * Discovers Nest cron handlers for Cloudflare scheduled events.
 *
 * @publicApi
 */
@Module({})
export class CloudflareScheduleModule {
  /** Registers scheduled event discovery without starting a timer scheduler. */
  public static forRoot(): DynamicModule {
    return {
      module: CloudflareScheduleModule,
      imports: [DiscoveryModule],
      providers: [
        CronExplorer,
        { provide: CRON_EXPLORER, useExisting: CronExplorer },
      ],
    };
  }
}
