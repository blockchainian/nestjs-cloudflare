import { Module } from '@nestjs/common';

import { CloudflareModule } from '../../src/index.js';
import { ChatGateway } from './chat.gateway.js';

@Module({
  imports: [CloudflareModule.forRoot()],
  providers: [ChatGateway],
})
export class AppModule {}
